/**
 * LINKS-WEB (docs/design/box-links-v2.md § 3 "Display", § 5 "Page flow"; F148, F149): a v2 box's Website, X and Telegram
 * are a record its on-chain creator signs (EIP-712) and our indexer keeps; nothing on chain knows them. This file holds
 * the page's side apart from React: the feed's `links` value read without ever throwing, the row's text and targets,
 * the draft's and the editor's links in the one canonical form (the shared module's canonicalizers: the text signed is
 * the text the server keeps and the page shows), `issuedAt` in chain time, and the POST with its waits.
 *
 * Links are shown as the creator's own, plainly: no label or badge says anything about them (F149), the full host is
 * shown, and only the creator can change or remove them (signing empty links removes them).
 */
import type { Address } from '@squarehole/domain';
import { BOX_LINKS_LIMITS, canonicalTelegram, canonicalWebsite, canonicalX, displayHost, type BoxLinks } from '../../../../../../packages/chain/src/core/v2';
import type { V2Source } from './indexer-v2';

export type LinkKey = keyof BoxLinks;
export const LINK_KEYS: readonly LinkKey[] = Object.freeze(['website', 'x', 'telegram']);

/** A box's links as the indexer serves them: canonical, at least one set, and the record's signing time. */
export interface ShownLinks extends BoxLinks {
  readonly issuedAt: bigint;
}

export const NO_LINKS: BoxLinks = Object.freeze({ website: '', x: '', telegram: '' });
export const hasLinks = (links: BoxLinks): boolean => links.website !== '' || links.x !== '' || links.telegram !== '';

const ISSUED_AT = /^(0|[1-9][0-9]{0,19})$/;
/** A record's `issuedAt` (a decimal string, at most 2^64 − 1), or null. */
export function issuedAtOf(value: unknown): bigint | null {
  if (typeof value !== 'string' || !ISSUED_AT.test(value)) return null;
  const time = BigInt(value);
  return time <= BOX_LINKS_LIMITS.issuedAtMax ? time : null;
}

const CANONICAL: Readonly<Record<LinkKey, (input: string) => string | null>> = Object.freeze({ website: canonicalWebsite, x: canonicalX, telegram: canonicalTelegram });
/** The value is exactly its canonical form (what the server stores; anything else is not shown). */
const canonical = (key: LinkKey, value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try {
    return CANONICAL[key](value) === value;
  } catch {
    return false;
  }
};

/**
 * A feed card's (or a box's) `links`: `{website, x, telegram, issuedAt} | null`. Anything else (another type, a missing
 * key, text not in canonical form, a malformed time, all three empty) is null, and this never throws, so one bad value
 * never stops the feed or the page (box-links-v2.md § 5 "Bad data never breaks the page").
 */
export function parseLinksV2(input: unknown): ShownLinks | null {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
    const value = input as Record<string, unknown>;
    const { website, x, telegram } = value;
    if (!canonical('website', website) || !canonical('x', x) || !canonical('telegram', telegram)) return null;
    const issuedAt = issuedAtOf(value.issuedAt);
    if (issuedAt === null || !hasLinks({ website, x, telegram })) return null;
    return Object.freeze({ website, x, telegram, issuedAt });
  } catch {
    return null;
  }
}

/** One link of the row: the text shown, and where it goes (also its `title`). */
export interface LinkItem {
  readonly key: LinkKey;
  readonly text: string;
  readonly href: string;
}

/**
 * The row's links (§ 3 "Display"): the website's whole hostname (it wraps, never cut: an ellipsis would make
 * `junkyard.fun.other.example` read as `junkyard.fun`), linking to the stored URL; `@handle` to x.com; `t.me/name`
 * to t.me. A value not in canonical form is left out.
 */
export function linkItems(links: BoxLinks): LinkItem[] {
  const items: LinkItem[] = [];
  if (links.website !== '' && canonical('website', links.website)) items.push({ key: 'website', text: displayHost(links.website), href: links.website });
  if (links.x !== '' && canonical('x', links.x)) items.push({ key: 'x', text: `@${links.x}`, href: `https://x.com/${links.x}` });
  if (links.telegram !== '' && canonical('telegram', links.telegram)) items.push({ key: 'telegram', text: `t.me/${links.telegram}`, href: `https://t.me/${links.telegram}` });
  return items;
}

/** Typed links in their canonical form, and which fields the canonicalizer refuses (empty is no link, never refused). */
export function canonicalLinks(typed: BoxLinks): { readonly links: BoxLinks; readonly refused: readonly LinkKey[] } {
  const refused: LinkKey[] = [];
  const pick = (key: LinkKey): string => {
    const out = CANONICAL[key](typed[key]);
    if (out === null) refused.push(key);
    return out ?? '';
  };
  const links = Object.freeze({ website: pick('website'), x: pick('x'), telegram: pick('telegram') });
  return { links, refused };
}

/** The editor's fields for links already saved: the stored URL, `@handle`, `t.me/name` (each canonicalizes back). */
export function fieldsOf(links: BoxLinks | null): BoxLinks {
  if (!links) return NO_LINKS;
  return { website: links.website, x: links.x === '' ? '' : `@${links.x}`, telegram: links.telegram === '' ? '' : `t.me/${links.telegram}` };
}

/**
 * `issuedAt` for the next signature (§ 1 "Time"): max(the feed's asOf.timestamp, the newest saved record's + 1). Chain
 * time, never the browser clock; `saved` is the newest time this page knows a record was saved at (null: none known).
 */
export function nextIssuedAt(asOf: bigint, saved: bigint | null): bigint {
  return saved !== null && saved + 1n > asOf ? saved + 1n : asOf;
}

/** What one signature covers: the links, their time, and the signature (kept in memory only, § 5). */
export interface SignedLinks {
  readonly links: BoxLinks;
  readonly issuedAt: bigint;
  readonly signature: `0x${string}`;
}

/** A signature the server takes: hex bytes, at most 1,024 of them (`0x` alone is a Safe's on-chain approval). */
export const sendableSignature = (signature: string): signature is `0x${string}` =>
  /^0x(?:[0-9a-fA-F]{2})*$/.test(signature) && signature.length <= 2 + BOX_LINKS_LIMITS.signatureBytes * 2;

/** `POST /v2/boxes/<chain>/<token>/links` on the source's indexer (§ 4). */
export const linksUrl = (source: Pick<V2Source, 'origin' | 'manifest'>, token: Address): string =>
  `${source.origin}/v2/boxes/${source.manifest.chainId}/${token.toLowerCase()}/links`;

/** Exactly the five string keys the server reads. */
export const linksBody = (signed: SignedLinks): string =>
  JSON.stringify({ website: signed.links.website, x: signed.links.x, telegram: signed.links.telegram, issuedAt: signed.issuedAt.toString(), signature: signed.signature });

/**
 * A 200 answer (the `sh.box-links.v1` body) as a saved outcome: the record now kept for this box (null when it has no
 * links, the one null rule); undefined when the body is not that. Its `verifiedBlock` is not read: the server takes
 * that head before it checks and writes, so it cannot order the save (fix round 2, F4).
 */
export function savedLinksOf(body: unknown, chainId: number, token: Address): Extract<SendOutcome, { kind: 'saved' }> | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const value = body as Record<string, unknown>;
  if (value.schema !== 'sh.box-links.v1' || value.chainId !== chainId || typeof value.token !== 'string' || value.token.toLowerCase() !== token.toLowerCase()) return undefined;
  if (value.record === null) return { kind: 'saved', links: null };
  const record = parseLinksV2(value.record);
  return record ? { kind: 'saved', links: record } : undefined;
}

/** `Retry-After` in whole seconds (the form our server and Caddy send) as milliseconds; null when absent or unreadable. */
export function retryAfterMs(header: string | null): number | null {
  const text = header?.trim() ?? '';
  return /^[0-9]{1,6}$/.test(text) ? Number(text) * 1000 : null;
}

/** The page's own limits on sending (§ 5 "Sending", R1-4). */
export const LINKS_SEND = Object.freeze({
  /** A send stops after 2 minutes (then Try again re-sends the same signature). */
  windowMs: 120_000,
  /** On 503 the first wait is at least 10 s, then each wait doubles. */
  firstWaitMs: 10_000,
  /** How often the send looks whether the box is in the feed yet. */
  feedCheckMs: 1_000,
  /** A 429 without a readable Retry-After waits one whole rate window. */
  rateWindowMs: 60_000,
  /** Never more than 10 POSTs a minute from this tab (the server's own per-client limit). */
  postsPerWindow: BOX_LINKS_LIMITS.postPerMinute,
});

/** The tab's links POSTs in the last minute: a POST waits while ten have gone out in it. */
export class PostLimiter {
  private readonly sent: number[] = [];
  constructor(private readonly max = LINKS_SEND.postsPerWindow, private readonly windowMs = LINKS_SEND.rateWindowMs) {}
  /** How long the next POST must wait (0: it may go now). */
  wait(now: number): number {
    while (this.sent.length > 0 && now - (this.sent[0] ?? 0) >= this.windowMs) this.sent.shift();
    return this.sent.length < this.max ? 0 : (this.sent[0] ?? now) + this.windowMs - now;
  }
  record(now: number): void {
    this.sent.push(now);
  }
}
/** One per tab: every links POST this tab sends counts against it. */
export const TAB_POSTS = new PostLimiter();

export type LinksFetch = (url: string, init: RequestInit) => Promise<Pick<Response, 'status' | 'headers' | 'json'>>;

export interface SendLinksOptions {
  readonly source: Pick<V2Source, 'origin' | 'manifest'>;
  readonly token: Address;
  readonly signed: SignedLinks;
  /** Whether the box is in the feed the page polls; the POST waits for it (R1-4: the indexer knows the box then). */
  readonly inFeed: () => boolean;
  readonly signal: AbortSignal;
  /** Test seams. */
  readonly fetch?: LinksFetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly limiter?: PostLimiter;
}

export type SendOutcome =
  /** 200: saved, or identical to the saved record; the record now kept (null: no links). */
  | { readonly kind: 'saved'; readonly links: ShownLinks | null }
  /** 409: not newer than the saved record; Sign again signs with `savedIssuedAt + 1`. */
  | { readonly kind: 'conflict'; readonly savedIssuedAt: bigint | null }
  /** 400 or 403: final. */
  | { readonly kind: 'refused'; readonly status: 400 | 403 }
  /** Two minutes passed, or another answer: Try again re-sends the same signature. */
  | { readonly kind: 'stopped' }
  | { readonly kind: 'aborted' };

/** Waits `ms`, or less if the signal aborts first. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Sends one signature (§ 5 "Sending"): once the box is in the feed, one POST as `text/plain` (a simple request: no
 * preflight, no cookies). On 503 it waits max(Retry-After, 10 s), then doubles the wait; on 429 it follows Retry-After
 * (a whole minute when unreadable); a network failure waits like a 503. It never sends more than 10 POSTs a minute from
 * this tab. 200, 409, 400 and 403 end it.
 *
 * Fix round 1 (F1): the whole send has one deadline, 2 minutes from its start, across the wait for the feed, every
 * fetch and the reading of an answer's body. With 503s every 10 s that is at most 4 POSTs (0, 10, 30 and 70 s). At the
 * deadline the send's own transport is aborted and the send settles as stopped (Try again re-sends the signature),
 * even when the transport ignores its abort; anything the transport answers later is dropped. The deadline is one
 * timer (`setTimeout`); `now` and `sleep` pace the waits inside it. The wallet's signature comes before and is not timed.
 */
export async function sendLinks(options: SendLinksOptions): Promise<SendOutcome> {
  const { source, token, signed, inFeed, signal } = options;
  const fetcher: LinksFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const limiter = options.limiter ?? TAB_POSTS;
  if (signal.aborted) return { kind: 'aborted' };
  const deadline = now() + LINKS_SEND.windowMs;
  // The send's own transport: the caller's cancel or the deadline aborts it, and with it every fetch and wait.
  const transport = new AbortController();
  let ended: 'stopped' | 'aborted' | null = null;
  let settle: (outcome: SendOutcome) => void = () => undefined;
  const ending = new Promise<SendOutcome>((resolve) => { settle = resolve; });
  const end = (why: 'stopped' | 'aborted'): void => {
    if (ended !== null) return;
    ended = why;
    // Settled before the abort: a transport that rejects on its abort cannot overtake the ending.
    settle({ kind: why });
    transport.abort();
  };
  const cancel = () => end('aborted');
  signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => end('stopped'), LINKS_SEND.windowMs);
  /** Waits `ms` if the send has that long left ('go'), else ends it as stopped ('stop'). */
  const pause = async (ms: number): Promise<'go' | 'stop'> => {
    if (ended !== null) return 'stop';
    if (now() + ms > deadline) { end('stopped'); return 'stop'; }
    if (ms > 0) await sleep(ms, transport.signal);
    return ended === null ? 'go' : 'stop';
  };
  /** An answer's JSON body, or undefined when it cannot be read. */
  const json = (response: Pick<Response, 'json'>): Promise<unknown> => Promise.resolve().then(() => response.json()).catch(() => undefined);
  const url = linksUrl(source, token);
  const body = linksBody(signed);
  const run = async (): Promise<SendOutcome> => {
    const over = (): SendOutcome => ({ kind: ended ?? 'stopped' });
    while (!inFeed()) if (await pause(LINKS_SEND.feedCheckMs) === 'stop') return over();
    let backoff = LINKS_SEND.firstWaitMs;
    for (;;) {
      if (await pause(limiter.wait(now())) === 'stop') return over();
      limiter.record(now());
      let wait: number;
      try {
        const response = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: transport.signal });
        if (ended !== null) return over();
        if (response.status === 200) {
          const answer = await json(response);
          if (ended !== null) return over();
          const saved = savedLinksOf(answer, source.manifest.chainId, token);
          // A 200 this page cannot read still means the server kept these links (it checked every rule itself).
          return saved ?? { kind: 'saved', links: hasLinks(signed.links) ? { ...signed.links, issuedAt: signed.issuedAt } : null };
        }
        if (response.status === 409) {
          const answer = await json(response);
          if (ended !== null) return over();
          return { kind: 'conflict', savedIssuedAt: issuedAtOf((answer as { savedIssuedAt?: unknown } | null | undefined)?.savedIssuedAt) };
        }
        if (response.status === 400 || response.status === 403) return { kind: 'refused', status: response.status };
        const after = retryAfterMs(response.headers.get('Retry-After'));
        if (response.status === 429) wait = after ?? LINKS_SEND.rateWindowMs;
        else if (response.status === 503) { wait = Math.max(after ?? 0, backoff); backoff = wait * 2; }
        else return { kind: 'stopped' };
      } catch {
        if (ended !== null) return over();
        wait = backoff;
        backoff *= 2;
      }
      if (await pause(wait) === 'stop') return over();
    }
  };
  try {
    // Whatever the transport does after the ending (answer late, or never), the send has settled.
    return await Promise.race([run(), ending]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}
