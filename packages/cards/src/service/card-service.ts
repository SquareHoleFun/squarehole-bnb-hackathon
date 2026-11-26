/**
 * The card service (F81 CF1): a box's 1200 x 630 link-preview card, drawn on the droplet instead of in a Cloudflare
 * Pages function (a card takes far more CPU than the Workers Free plan's 10 ms). Caddy sends `/card/*` of
 * api.squarehole.fun here; Cloudflare caches what it answers.
 *
 * - The box: its facts from the indexer gateway inside the compose network, else its registry row through a keyless RPC
 *   (share-read.ts, the same code the Pages function reads the page's tags with), only for a box the core manifest
 *   shows. Kept in memory five minutes (a graduated box's a week, an unknown box's a minute).
 * - The card: drawn once per box and version (`v`: design and state), at most one at a time, kept in memory and, once
 *   finished, on disk. The current version's URL is cached for 30 days (`immutable`): that picture never changes. A
 *   fallback while a preferred picture is unavailable is kept an hour only. A request naming another `v` (an old page, a
 *   made-up one) gets the current card with `no-store`, and nothing new is drawn for it.
 * - The square picture: logo then collection cover, by raw CID from configured IPFS gateways, then Arweave by tags;
 *   at most 1 MiB each, two bounded searches in one 12 s budget,
 *   bytes checked against the spec's sha256 (share-art.ts).
 * - Item cards read canonical reveal state afresh, hash-check the operator-mapped PNG copy, and recheck the reveal
 *   after rendering. They never enter the immutable box-card cache. Missing or unrevealed items use the generic card.
 * - Never an error page for a card URL: a link that names no box, a box not shown, a read that fails or takes too long,
 *   a queue that is full, a renderer that throws: the generic card (the landing page's), answered 200.
 */
import { createHash } from 'node:crypto';
import { rawCidV1 } from '@squarehole/artwork';
import { chooseCardPicture, type CardSource } from '../picture-choice';
import { createWithheldPictures, type WithheldPictures } from '../../../indexer/src/withheld/list.mjs';
import { loadBoxLogo, loadLogo, renderCardPng, type CardAssets, type CardEngine, type Logo } from '../render';
import { cacheSeconds, cardVersion, type ShareBox } from '../share-model';
import { loadCoreItem, loadCoreBox, type ShareConfig, type ShareLookup, type ShareReaders } from '../share-read';
import { DiskCards, Lru } from './cache';
import { routeOf } from './route';

/** The current card: unchanging, so long. */
export const CARD_SECONDS = 30 * 24 * 60 * 60;
/** A card awaiting a committed picture (including a cover standing in): an hour, then asked again. */
export const NO_LOGO_SECONDS = 60 * 60;
const UNKNOWN_SECONDS = 60;
const FAILED_SECONDS = 15;
const INVALID_SECONDS = 24 * 60 * 60;
const LOOKUP_BUDGET_MS = 6000;
const CARD_BUDGET_MS = 15_000;
const ART_TIMEOUT_MS = 3000;
/** Shared by both candidates, including response bodies. The second picture never adds another 12 s. */
const ART_BUDGET_MS = 12_000;
/** Box reads at once (distinct boxes), and draws waiting or running: beyond them, the generic card, not stored. */
const MAX_READS = 64;
const MAX_DRAWS = 16;

export type LogoOutcome = 'none' | 'yes' | 'missing';

interface Card {
  readonly png: Uint8Array;
  readonly logo: LogoOutcome;
  readonly retry?: boolean;
  readonly withheld?: boolean;
}

interface Choice {
  readonly name: string;
  readonly logo: LogoOutcome;
  readonly retry: boolean;
  readonly withheld: boolean;
}

type Picture = { readonly hash: `0x${string}`; readonly art: Logo } | { readonly hash: `0x${string}`; readonly png: Uint8Array; readonly from: 'memory' | 'disk' };

export interface CardAnswer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** Null for HEAD and for answers without a body. */
  readonly body: Uint8Array | null;
}

export interface CardServiceDeps {
  /** The box read's configuration, asked for on each read (the manifest file may change). */
  readonly config: () => ShareConfig;
  readonly readers: ShareReaders;
  readonly engine: CardEngine;
  readonly assets: CardAssets;
  /** The generic card's JPEG bytes. */
  readonly generic: Uint8Array;
  readonly gateways: readonly string[];
  readonly fetchArt: (url: string, init?: RequestInit) => Promise<Response>;
  readonly disk: DiskCards | null;
  /** Private runtime map: committed image sha256 -> uncommitted PNG copy sha256. Never sent to the client. */
  readonly itemPngs?: Readonly<Record<string, `0x${string}`>>;
  /** What the health answer says about the renderer. */
  readonly engineKind: string;
  readonly now?: () => number;
  readonly withheld?: WithheldPictures;
  readonly onError?: (what: string, error: unknown) => void;
}

/** A read or a draw that did not finish in time, or was refused because too many were running. */
const TIMED_OUT = Object.freeze({ status: 'unknown', reason: 'not read in time', failed: true }) satisfies ShareLookup;
const BUSY = Object.freeze({ status: 'unknown', reason: 'busy', failed: true }) satisfies ShareLookup;

function lookupSeconds(lookup: ShareLookup): number {
  if (lookup.status === 'box') return cacheSeconds(lookup.box.state);
  if (lookup.status === 'invalid') return INVALID_SECONDS;
  return lookup.failed ? FAILED_SECONDS : UNKNOWN_SECONDS;
}

/** Resolves to `fallback` once `ms` pass (the work goes on, and its result is kept where the work keeps it). */
function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** One card at a time: drawing is CPU work on a 2-CPU server the indexer shares. */
class OneAtATime {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/** Only the chosen commitment enters PNG identity, along with the design/state and current withholding policy. */
export const cardName = (box: ShareBox, chosen: `0x${string}` | null, hashes: readonly string[] = []): string => {
  const key = createHash('sha256').update(JSON.stringify(['sh-picture-211', cardVersion(box.state), chosen?.toLowerCase() ?? null, hashes])).digest('hex');
  return `${box.chainId}-${box.token}-${key}.png`;
};
class WithheldPicture extends Error {}

export class CardService {
  private itemRequests = 0;
  private readonly facts = new Lru<ShareLookup>(10_000);
  private readonly reading = new Map<string, Promise<ShareLookup>>();
  private readonly cards = new Lru<Uint8Array>(1000, 48 * 1024 * 1024, (png) => png.byteLength);
  /** A short-lived selection index; PNG identity itself includes only the selected commitment. */
  private readonly choices = new Lru<Choice>(1000);
  private readonly drawing = new Map<string, Promise<{ readonly card: Card; readonly from: 'drawn' | 'disk' }>>();
  private readonly queue = new OneAtATime();
  private readonly now: () => number;
  private readonly withheld: WithheldPictures;

  constructor(private readonly deps: CardServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.withheld = deps.withheld ?? createWithheldPictures();
  }

  /** Stop decoder children before the HTTP process exits. Later decodes fail to brand. */
  async close(): Promise<void> { await this.deps.engine.close?.(); }

  /** One request. Never throws. */
  async handle(method: string, target: string): Promise<CardAnswer> {
    const head = method === 'HEAD';
    if (method !== 'GET' && !head) return { status: 405, headers: { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, body: new TextEncoder().encode('read-only\n') };
    const route = routeOf(target);
    if (route.kind === 'none') return this.plain(404, 'not found\n', head);
    if (route.kind === 'health') return this.plain(200, `${JSON.stringify({ ok: true, engine: this.deps.engineKind, webp: this.deps.engine.webpDrawing ? 'on' : 'off' })}\n`, head, 'application/json');
    if (route.kind === 'invalid') return this.generic(INVALID_SECONDS, 'invalid', head);
    try {
      if (route.kind === 'item') {
        if (this.itemRequests >= MAX_READS) return this.generic(0, 'busy', head);
        this.itemRequests++;
        try { return await this.itemCard(route.chainId, route.token, route.id, head); }
        finally { this.itemRequests--; }
      }
      const lookup = await this.box(route.chainId, route.token);
      if (lookup.status !== 'box') {
        // A read that failed may work at the next request: not stored anywhere.
        const failed = lookup.status === 'unknown' && lookup.failed === true;
        return this.generic(failed ? 0 : lookupSeconds(lookup), lookup === BUSY ? 'busy' : failed ? 'failed' : lookup.status, head);
      }
      const policy = this.withheld.snapshot().hashes;
      const drawn = await within(
        this.card(lookup.box).catch((error: unknown) => {
          if (error instanceof WithheldPicture) return 'withheld' as const;
          this.deps.onError?.('draw', error);
          return 'failed' as const;
        }),
        CARD_BUDGET_MS,
        null,
      );
      if (drawn === 'withheld' || this.withheld.snapshot().hashes !== policy) return this.generic(0, 'picture unavailable', head);
      if (drawn === 'failed') return this.generic(0, 'error', head);
      if (drawn === null) return this.generic(0, 'busy', head);
      const current = route.v === cardVersion(lookup.box.state);
      const cacheControl = !current || drawn.card.withheld ? 'no-store' : drawn.card.retry ? `public, max-age=${NO_LOGO_SECONDS}` : `public, max-age=${CARD_SECONDS}, immutable`;
      return {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'content-length': String(drawn.card.png.byteLength),
          'cache-control': cacheControl,
          'x-content-type-options': 'nosniff',
          'x-sh-card': `box; via=${lookup.via}; logo=${drawn.card.logo}; card=${drawn.from}${current ? '' : '; v=other'}`,
          // The current version, so a page (or a person checking) can name the cacheable URL.
          'x-sh-card-version': cardVersion(lookup.box.state),
        },
        body: head ? null : drawn.card.png,
      };
    } catch (error) {
      this.deps.onError?.('card', error);
      return this.generic(0, 'error', head);
    }
  }

  private async itemCard(chainId: number, token: `0x${string}`, id: string, head: boolean): Promise<CardAnswer> {
    if (this.drawing.size >= MAX_DRAWS) return this.generic(0, 'busy', head);
    const read = () => within(loadCoreItem(chainId, token, id, this.deps.config(), this.deps.readers), LOOKUP_BUDGET_MS, null);
    const found = await read();
    const imageHash = found?.item.art?.image?.sha256;
    const pngHash = imageHash ? this.deps.itemPngs?.[imageHash] : undefined;
    if (!found || !pngHash) return this.generic(0, 'item unavailable', head);
    if (this.hashWithheld(imageHash) || this.hashWithheld(pngHash)) return this.generic(0, 'item unavailable', head);
    const policy = this.withheld.snapshot().hashes;
    const key = `item-${chainId}-${token}-${id}-${imageHash}-${pngHash}`;
    let drawing = this.drawing.get(key);
    if (!drawing) {
      if (this.drawing.size >= MAX_DRAWS) return this.generic(0, 'busy', head);
      drawing = (async () => {
        const logo = await loadLogo(pngHash, this.deps.gateways, this.deps.fetchArt, ART_TIMEOUT_MS);
        if (logo?.type !== 'image/png') throw new Error('item PNG unavailable');
        const png = await this.queue.run(() => renderCardPng({ ...found.box, name: `${found.box.name} #${id}`, logoSha256: pngHash }, logo, this.deps.assets, this.deps.engine));
        return { card: { png, logo: 'yes' as const }, from: 'drawn' as const };
      })().finally(() => this.drawing.delete(key));
      this.drawing.set(key, drawing);
    }
    const result = await within(drawing, CARD_BUDGET_MS, null);
    if (!result || this.withheld.snapshot().hashes !== policy) return this.generic(0, 'item unavailable', head);
    const current = await read();
    if (this.hashWithheld(imageHash) || this.hashWithheld(pngHash) || !current?.item.revealed || current.item.art?.image?.sha256 !== imageHash) return this.generic(0, 'item unavailable', head);
    return { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(result.card.png.length), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-sh-card': 'item; png=yes' }, body: head ? null : result.card.png };
  }

  /** The box's facts: from memory, else read (one read per box at a time; the caller waits up to 6 s). */
  private async box(chainId: number, token: `0x${string}`): Promise<ShareLookup> {
    const key = `${chainId}/${token}`;
    const known = this.facts.get(key, this.now());
    if (known !== undefined) return known;
    let read = this.reading.get(key);
    if (read === undefined) {
      if (this.reading.size >= MAX_READS) return BUSY;
      read = loadCoreBox(chainId, token, this.deps.config(), this.deps.readers)
        .catch((error: unknown): ShareLookup => {
          this.deps.onError?.('read', error);
          return { status: 'unknown', reason: 'the box could not be read', failed: true };
        })
        .then((lookup) => {
          this.facts.set(key, lookup, this.now() + lookupSeconds(lookup) * 1000);
          return lookup;
        })
        .finally(() => this.reading.delete(key));
      this.reading.set(key, read);
    }
    return within(read, LOOKUP_BUDGET_MS, TIMED_OUT);
  }

  /**
   * The box's current card: from memory, from disk, or drawn (one draw per card at a time); null when too many cards
   * wait to be drawn. Throws when the card cannot be drawn.
   */
  private async card(box: ShareBox): Promise<{ readonly card: Card; readonly from: 'memory' | 'disk' | 'drawn' } | null> {
    const policy = this.withheld.snapshot().hashes;
    // This index records which candidate won; it is not the PNG's memory/disk cache identity.
    const request = JSON.stringify([box.chainId, box.token, cardVersion(box.state), box.logoSha256, box.collectionCoverSha256 ?? null, policy]);
    const choice = this.choices.get(request, this.now());
    const kept = choice === undefined ? undefined : this.cards.get(choice.name, this.now());
    if (choice !== undefined && kept !== undefined) return { card: { ...choice, png: kept }, from: 'memory' };
    let pending = this.drawing.get(request);
    if (pending === undefined) {
      if (this.drawing.size >= MAX_DRAWS) return null;
      pending = this.make(box, request, policy).finally(() => this.drawing.delete(request));
      this.drawing.set(request, pending);
    }
    return pending;
  }

  private async make(box: ShareBox, request: string, policy: readonly string[]): Promise<{ readonly card: Card; readonly from: 'drawn' | 'disk' }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ART_BUDGET_MS);
    const hashes = [...new Set([box.logoSha256, box.collectionCoverSha256 ?? null].filter((hash): hash is `0x${string}` => hash !== null))];
    let withheld = false;
    let retry = false;
    const checkPolicy = () => {
      if (this.withheld.snapshot().hashes !== policy) throw new WithheldPicture();
    };
    // Preserve withholding as a choice, rather than treating it as a missing picture.
    const picture = async (hash: `0x${string}`): Promise<Picture | 'withheld' | null> => {
      if (this.hashWithheld(hash)) return 'withheld';
      const name = cardName(box, hash, policy);
      const kept = this.cards.get(name, this.now());
      if (kept !== undefined) return { hash, png: kept, from: 'memory' };
      const stored = this.deps.disk ? await this.deps.disk.get(name) : null;
      checkPolicy();
      if (stored !== null) return { hash, png: stored, from: 'disk' };
      let blocked = false;
      const fetchArt = (url: string, init?: RequestInit): Promise<Response> => {
        const path = new URL(url).pathname;
        const id = path.startsWith('/ipfs/') ? `ipfs:${path.slice(6)}` : /^\/[A-Za-z0-9_-]{43}$/.test(path) ? `ar:${path.slice(1)}` : null;
        if (blocked || this.hashWithheld(hash) || (id !== null && this.withheld.has(id))) {
          blocked = true;
          return Promise.reject(new WithheldPicture());
        }
        if (controller.signal.aborted) return Promise.reject(new Error('picture deadline'));
        return this.deps.fetchArt(url, init);
      };
      const art = await loadBoxLogo(hash, this.deps.gateways, fetchArt, ART_TIMEOUT_MS, controller.signal);
      if (blocked || this.hashWithheld(hash)) return 'withheld';
      return art === null ? null : { hash, art };
    };
    try {
      // Start both as on the page; the first usable picture in square-slot order wins. All rejection paths are
      // observed at once, even when the logo succeeds before the cover finishes. Aborting stops unused fetches.
      const candidates = new Map(hashes.map((hash) => [hash, picture(hash).catch((error: unknown) => {
        if (error instanceof WithheldPicture) return 'withheld' as const;
        this.deps.onError?.('picture', error);
        return null;
      })]));
      let chosen: `0x${string}` | null = null;
      let png: Uint8Array | null = null;
      let from: 'drawn' | 'disk' = 'drawn';
      const roles = [box.logoSha256, box.collectionCoverSha256 ?? null] as const;
      const sources: [CardSource, CardSource] = roles.map((hash) => ({ state: hash ? 'pending' : 'none', url: null })) as [CardSource, CardSource];
      for (const [index, hash] of roles.entries()) {
        if (!hash) continue;
        const found = await candidates.get(hash);
        checkPolicy();
        sources[index as 0 | 1] = found === 'withheld' ? { state: 'withheld', url: null }
          : found ? { state: 'shown', url: hash } : { state: 'missing', url: null };
        const choice = chooseCardPicture(...sources);
        if (choice.kind === 'withheld') { withheld = true; break; }
        if (choice.kind !== 'picture' || !found || found === 'withheld') { retry = true; continue; }
        try {
          png = 'png' in found ? found.png : await this.queue.run(() => renderCardPng(box, found.art, this.deps.assets, this.deps.engine, false));
          chosen = found.hash;
          from = 'from' in found && found.from === 'disk' ? 'disk' : 'drawn';
          break;
        } catch {
          // Rendering cannot change the selected role. Retry brand without disk caching so a later
          // renderer can recover this commitment; chooseCardPicture defines the shared rule.
          retry = true;
          break;
        }
      }
      controller.abort();
      checkPolicy();
      const name = cardName(box, chosen, policy);
      if (png === null) {
        const kept = this.cards.get(name, this.now());
        const stored = kept ?? (this.deps.disk ? await this.deps.disk.get(name) : null);
        png = stored ?? await this.queue.run(() => renderCardPng(box, null, this.deps.assets, this.deps.engine));
        if (stored !== null && kept === undefined) from = 'disk';
      }
      checkPolicy();
      const choice: Choice = { name, logo: chosen !== null ? 'yes' : hashes.length === 0 ? 'none' : 'missing', retry, withheld };
      this.cards.set(name, png, Number.POSITIVE_INFINITY);
      this.choices.set(request, choice, retry || withheld ? this.now() + NO_LOGO_SECONDS * 1000 : Number.POSITIVE_INFINITY);
      // Store only finished cards. A fallback while the logo is unavailable must be retried, including after restart.
      if (!retry && !withheld && from !== 'disk') void this.deps.disk?.put(name, png);
      return { card: { ...choice, png }, from };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  private hashWithheld(hash: `0x${string}` | null | undefined): boolean {
    return hash ? this.withheld.has(`ipfs:${rawCidV1(hash)}`) : false;
  }

  private generic(seconds: number, reason: string, head: boolean): CardAnswer {
    const body = this.deps.generic;
    return {
      status: 200,
      headers: {
        'content-type': 'image/jpeg',
        'content-length': String(body.byteLength),
        'cache-control': seconds > 0 ? `public, max-age=${seconds}` : 'no-store',
        'x-content-type-options': 'nosniff',
        'x-sh-card': `generic; ${reason}`,
      },
      body: head ? null : body,
    };
  }

  private plain(status: number, text: string, head: boolean, type = 'text/plain; charset=utf-8'): CardAnswer {
    const body = new TextEncoder().encode(text);
    return { status, headers: { 'content-type': type, 'content-length': String(body.byteLength), 'cache-control': 'no-store' }, body: head ? null : body };
  }
}
