/**
 * SH-ARWEAVE-PICTURES-WEB (from the SH-ARWEAVE-PICTURES-SPIKE prototype): a v2 box's committed logo or cover, found on
 * Arweave and checked by its bytes. Nothing is ever shown unless its sha256, computed here, equals the commitment.
 *
 * 1. The indexer's copy first, when it names one (`pictureCopies.{logo,cover}.arweaveId`, SH-ARWEAVE-PICTURES-SRV;
 *    optional): its bytes from turbo-gateway.com, then arweave.net.
 * 2. Otherwise Arweave GraphQL on turbo-gateway.com, arweave.net and goldsky.arweave.net at once, for items tagged
 *    App-Name "Square Hole" and SHA-256 = the committed hash, PAGE_SIZE a page, oldest first. Their candidates are
 *    merged, oldest first (mined by block height, then the ones not mined yet), and read a few at a time until one's
 *    bytes match. As the unread candidates run low, each gateway that has a next page is asked for it (its `after`
 *    cursor), for as long as the budget lasts (fix round 1: the search no longer stops at the first 100).
 *    Every copy gets its turn before the budget ends (fix round 2): each is given its share of what is left among the
 *    copies still to read (at most COPY_TIMEOUT_MS a gateway), so copies that never load cannot hold every reader until
 *    the end; a copy no gateway answered is asked once more after every copy had its first try, oldest first, with the
 *    time then left (so a flood cannot cut short the oldest copy, usually the real one). The shares fit what is left
 *    after the searches, however long they took (fix round 3): the last RESERVE_MS are kept for reading the last
 *    copies, and the MIN_COPY_MS floor stays below the share of any of the first 100 copies.
 *    Anyone can copy the tags, so a copy with the right tags and other bytes (a decoy) is skipped. Create publishes a
 *    box's pictures before its createBox makes their hashes public (create/v2/usePicturePublish.tsx), so the real copy
 *    is older than any decoy made from the chain; a flood of decoys costs reads, never a wrong picture, and the
 *    indexer's copy (step 1) is not affected by it.
 * 3. Each picture stops after BUDGET_MS in all: the caller then shows its neutral placeholder.
 * SH-WITHHELD-SITE (F157 (3)): our withheld-picture list (withheld.ts) is checked before every read. The picture's own
 * id (`ipfs:` + the raw CID of its hash: its exact bytes) listed: nothing is read, and the answer is Withheld. The
 * indexer's copy listed (`ar:` + its id): Withheld, nothing read or searched. A listed copy the search names is never
 * read; as on our share cards (packages/cards, oldest first), a listed copy older than the copy that matches, or a
 * listed copy and no match, makes the answer Withheld, while a listed decoy newer than the real copy changes nothing.
 * Fix round af1: the list as it is now is checked right before every request (each gateway of each copy, queued copies
 * and retries included), so a refresh during the lookup stops it there, never at another gateway. The copy found is
 * checked again once read, and so are a picture kept for the page (with the copy its caller names), one this page just
 * published and one a lookup in flight brings back. Withheld is never cached.
 * Fix round af2: every copy a search answer names is recorded with its age the moment the answer arrives, before its key
 * is hashed. A match goes with every older copy named so far (`older`: read, queued, waiting for a retry or still being
 * hashed alike) and is accepted only once the list as it is then names none of them; they stay its keys, kept or shown,
 * so a later listing of one withholds it too. Newer copies (decoys) are never among them.
 * Every request: no credentials, no referrer, no redirect followed, its own timeout (the indexer's copy HINT_TIMEOUT_MS
 * a gateway; a copy the search named its share, see above). A raw gateway that cannot be reached at all (a connection
 * error) is left out for the rest of that picture's lookup; a copy that does not load in time, or that redirects (fix
 * round 2: raw reads ask `redirect: 'manual'`, so a redirect is an answer for that copy, not a failed connection),
 * costs only itself. Bytes are read up to PICTURE_BUDGET.bytes and only as a raster picture, a search answer up to 256 KiB.
 * A picture found is kept for the page load (by hash: content addressed); one not found is looked up again next time.
 */
import { hexOf, sha256Of } from './ans104-eth';
import { APP_NAME, ARWEAVE_RAW_GATEWAYS, ARWEAVE_SEARCH_GATEWAYS } from './arweave-hosts';
import { PICTURE_BUDGET } from '@squarehole/artwork/box-picture';
import { pictureType } from './picture-type';
import {
  arweavePictureId, checkWithheld, committedPictureId, isWithheldResult, listedKeys, pictureIds, subscribeWithheld, withheldKeys,
  withheldListEmpty, withheldReady, withheldResult, withheldVerdict, type Withheld,
} from './withheld';

export type { Withheld };

export { ARWEAVE_RAW_GATEWAYS, ARWEAVE_SEARCH_GATEWAYS };
/** Candidates one search page asks for (Arweave GraphQL `first`), oldest first; the page's last cursor asks for the next. */
export const PAGE_SIZE = 100;
/** One picture's whole lookup (the indexer's copy and every search page together). */
export const BUDGET_MS = 15_000;
/** A copy the search named, per gateway, at most: one that does not load in its time is given up, its gateway is not. */
export const COPY_TIMEOUT_MS = 3_000;
/**
 * The least a copy is given per gateway while many copies share what is left of the budget. Fix round 3: 50 ms, below
 * the share of any of the first 100 copies even when the searches answer at their 10 s limit (5 s left, less the
 * reserve: 4,500 ms x 4 readers / 100 copies / 2 gateways = 90 ms), so the floor never pushes the first 100 past the end.
 */
export const MIN_COPY_MS = 50;
/** The end of the budget kept for reading and checking the last copies asked (the shares are planned to end before it). */
export const RESERVE_MS = 500;
/** The indexer's copy, per gateway. */
const HINT_TIMEOUT_MS = 8_000;
const SEARCH_TIMEOUT_MS = 10_000;
/** A search answer is read up to this size (100 candidates are about 12 KB); a larger one counts as no answer. */
const MAX_SEARCH_BYTES = 256 * 1024;
const CONCURRENCY = 4;
const ARWEAVE_ID = /^[A-Za-z0-9_-]{43}$/;
/** A page cursor as a gateway names it (opaque; printable, bounded), sent back as the next page's `after`. */
const CURSOR = /^[\x21-\x7e]{1,512}$/;
const HASH = /^0x[0-9a-f]{64}$/i;
const ZERO = /^0x0{64}$/i;
const NO_LEAKS = { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' } as const;
/** A raw read: a redirect is never followed, and comes back as this copy's answer (opaque), not as a failed connection. */
const RAW_READ = { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'manual' } as const;

type Hash = `0x${string}`;
export interface ArweavePicture {
  readonly bytes: Uint8Array;
  readonly type: string;
  /** The Arweave item whose bytes matched, and the gateway that served them (empty: this page published them). */
  readonly id: string;
  readonly gateway: string;
  /**
   * SH-WITHHELD-SITE fix round af2: the copies the search named older than this one (Arweave ids; none for the indexer's
   * copy or a picture this page published). As on the share cards, which read oldest first and stop at a listed copy,
   * one of them listed withholds this picture: they are its withheld keys with its own (`arweaveIdsOf`).
   */
  readonly older: readonly string[];
}

/** The withheld ids an Arweave picture was found under: its copy's, and every older copy's the search named. */
export const arweaveIdsOf = (picture: ArweavePicture): string[] => pictureIds(arweavePictureId(picture.id), ...picture.older.map(arweavePictureId));
export type ReadEvent =
  | { readonly kind: 'search'; readonly gateway: string; readonly ok: boolean; readonly ids: readonly string[]; readonly ms: number }
  | { readonly kind: 'bytes'; readonly gateway: string; readonly id: string; readonly status: number | null; readonly match: boolean; readonly ms: number };
export interface ReadOptions {
  /** The indexer's copy of this picture (an Arweave id), tried first; its bytes are checked like any other. */
  readonly hint?: string | null;
  /** False: only the hint (and this page's own copies); no search. */
  readonly search?: boolean;
  readonly searchGateways?: readonly string[];
  readonly rawGateways?: readonly string[];
  readonly fetcher?: typeof fetch;
  readonly maxBytes?: number;
  /** Candidates a search page asks for (tests: small pages). */
  readonly pageSize?: number;
  readonly concurrency?: number;
  readonly budgetMs?: number;
  readonly searchTimeoutMs?: number;
  /** A copy the search named, per gateway, at most (COPY_TIMEOUT_MS); with many copies to read, less (its share). */
  readonly rawTimeoutMs?: number;
  /** The indexer's copy, per gateway (HINT_TIMEOUT_MS). */
  readonly hintTimeoutMs?: number;
  /** Measurements (tests); the page passes none. */
  readonly trace?: (event: ReadEvent) => void;
}
/**
 * `ids`: the picture's own withheld ids (its bytes' raw CID and the indexer's copy), checked with each copy's own id
 * right before every request (F157 (3)).
 */
type Settings = Required<Omit<ReadOptions, 'trace' | 'hint'>> & Pick<ReadOptions, 'trace'> & { readonly hint: string | null; readonly down: Set<string>; readonly ids: readonly string[] };

const TAGS = '[{name:"App-Name",values:$app},{name:"SHA-256",values:$sha}]';
const FIELDS = 'pageInfo{hasNextPage}edges{cursor node{id data{size} block{height}}}';
/** The first page asks no cursor; each later page asks the one after the last edge it was given. */
const queryOf = (pageSize: number, after: boolean) => (after
  ? `query($app:[String!]!,$sha:[String!]!,$after:String!){transactions(tags:${TAGS},sort:HEIGHT_ASC,first:${pageSize},after:$after){${FIELDS}}}`
  : `query($app:[String!]!,$sha:[String!]!){transactions(tags:${TAGS},sort:HEIGHT_ASC,first:${pageSize}){${FIELDS}}}`);

export interface Candidate { readonly id: string; readonly height: number | null }

/** The candidates one search answer names, oldest first, without repeats, bad ids or items over `maxBytes`; null when it is no answer. */
export function candidatesOf(body: unknown, maxBytes: number = PICTURE_BUDGET.bytes): Candidate[] | null {
  const edges = edgesOf(body);
  if (edges === null) return null;
  const seen = new Set<string>();
  const list: (Candidate & { readonly order: number })[] = [];
  edges.forEach((edge: unknown, order) => {
    const node = (edge as { node?: { id?: unknown; data?: { size?: unknown } | null; block?: { height?: unknown } | null } } | null)?.node;
    const id = node?.id;
    if (typeof id !== 'string' || !ARWEAVE_ID.test(id) || seen.has(id)) return;
    const size = Number(node?.data?.size ?? Number.NaN);
    if (Number.isFinite(size) && (size <= 0 || size > maxBytes)) return;
    const height = node?.block?.height;
    seen.add(id);
    list.push({ id, height: typeof height === 'number' && Number.isSafeInteger(height) && height >= 0 ? height : null, order });
  });
  list.sort(byAge);
  return list.map(({ id, height }) => ({ id, height }));
}
const edgesOf = (body: unknown): unknown[] | null => {
  const edges = (body as { data?: { transactions?: { edges?: unknown } } } | null)?.data?.transactions?.edges;
  return Array.isArray(edges) ? edges : null;
};

/** One search page: its candidates (`candidatesOf`) and the cursor its next page starts after (null: the last page). */
export interface SearchPage { readonly candidates: readonly Candidate[]; readonly next: string | null }
/**
 * The page one search answer is, or null when it is no answer. A next page is named only by `hasNextPage` and a cursor
 * on the answer's last edge (an answer without them, as before paging, is the last page).
 */
export function pageOf(body: unknown, maxBytes: number = PICTURE_BUDGET.bytes): SearchPage | null {
  const candidates = candidatesOf(body, maxBytes);
  const edges = edgesOf(body);
  if (candidates === null || edges === null) return null;
  const more = (body as { data?: { transactions?: { pageInfo?: { hasNextPage?: unknown } | null } } }).data?.transactions?.pageInfo?.hasNextPage === true;
  const cursor = (edges[edges.length - 1] as { cursor?: unknown } | null | undefined)?.cursor;
  return { candidates, next: more && typeof cursor === 'string' && CURSOR.test(cursor) ? cursor : null };
}
/** Mined first, by height; then the ones not mined yet; arrival order breaks ties. */
const byAge = (a: Candidate & { readonly order: number }, b: Candidate & { readonly order: number }) =>
  (a.height ?? Number.MAX_SAFE_INTEGER) - (b.height ?? Number.MAX_SAFE_INTEGER) || a.order - b.order;

/** A signal that fires when `parent` does or after `ms`; `clear` drops the timer. */
function timed(parent: AbortSignal, ms: number): { readonly signal: AbortSignal; readonly clear: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parent.aborted) controller.abort();
  else parent.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, ms);
  return { signal: controller.signal, clear: () => { clearTimeout(timer); parent.removeEventListener('abort', abort); } };
}

/** The body, or null as soon as it passes `limit` bytes (the rest is not read). */
async function readCapped(response: Response, limit: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > limit) { await response.body?.cancel().catch(() => undefined); return null; }
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return bytes;
}

/** One page of one gateway's search (after `after`, or its first), or null when it gave no usable answer in time. */
async function search(gateway: string, hex: string, after: string | null, s: Settings, stop: AbortSignal): Promise<SearchPage | null> {
  const started = Date.now();
  const time = timed(stop, s.searchTimeoutMs);
  let found: SearchPage | null = null;
  try {
    const variables = after === null ? { app: [APP_NAME], sha: [hex] } : { app: [APP_NAME], sha: [hex], after };
    const response = await s.fetcher(`${gateway}/graphql`, {
      ...NO_LEAKS, method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: queryOf(s.pageSize, after !== null), variables }), signal: time.signal,
    });
    const body = response.ok ? await readCapped(response, MAX_SEARCH_BYTES) : null;
    if (!response.ok) await response.body?.cancel().catch(() => undefined);
    if (body !== null) found = pageOf(JSON.parse(new TextDecoder().decode(body)) as unknown, s.maxBytes);
  } catch {
    found = null;
  } finally {
    time.clear();
  }
  s.trace?.({ kind: 'search', gateway, ok: found !== null, ids: found?.candidates.map((c) => c.id) ?? [], ms: Date.now() - started });
  return found;
}

/**
 * One copy's reading: the picture when it matched, and whether a gateway served its bytes at all (`answered`); or
 * `withheld` when the list, checked right before a request, names the picture (`whole`) or this copy: nothing more of it
 * is asked, of any gateway.
 */
interface Read { readonly picture: ArweavePicture | null; readonly answered: boolean; readonly withheld: Withheld | null; readonly whole: boolean }
const UNREAD: Read = Object.freeze({ picture: null, answered: false, withheld: null, whole: false });

/**
 * One item's bytes from the raw gateways in turn, each given `timeoutMs`: the picture when they hash to `hex` and are a
 * raster picture. An item's id is the hash of its signature over its bytes, so the first gateway that serves it settles
 * it: other bytes (a decoy) or too many are not asked of the next gateway; only no answer, an error status, a redirect
 * or a timeout are. Only a gateway that could not be reached at all (fetch's TypeError before any answer) is left out of
 * the rest of the lookup; a timeout or a redirect is this copy's alone (a redirect is never followed: `redirect:
 * 'manual'` gives it back as an opaque answer, where `'error'` made it a TypeError like a dead connection).
 * SH-WITHHELD-SITE fix round af1: the list as it is now is checked right before each request, so a refresh that names
 * the picture or this copy while the copy waited its turn (queued, or a fallback gateway after another) stops it there.
 */
async function fetchItem(id: string, hex: string, s: Settings, stop: AbortSignal, timeoutMs: number): Promise<Read> {
  for (const gateway of s.rawGateways) {
    if (s.down.has(gateway) || stop.aborted) continue;
    const whole = await withheldVerdict(s.ids);
    if (whole !== null) return { picture: null, answered: false, withheld: whole, whole: true };
    const copy = await withheldVerdict([`ar:${id}`]);
    if (copy !== null) return { picture: null, answered: false, withheld: copy, whole: false };
    if (stop.aborted) break;
    const started = Date.now();
    const time = timed(stop, timeoutMs);
    let status: number | null = null;
    let served = false;
    let picture: ArweavePicture | null = null;
    try {
      const response = await s.fetcher(`${gateway}/raw/${id}`, { ...RAW_READ, signal: time.signal });
      status = response.status;
      // An opaque redirect (status 0) or a 3xx is not ok: refused here, never followed.
      if (!response.ok) await response.body?.cancel().catch(() => undefined);
      const bytes = response.ok ? await readCapped(response, s.maxBytes) : null;
      // Read to the end (or past the cap): this gateway has settled this id.
      served = response.ok;
      if (bytes !== null && bytes.byteLength > 0 && hexOf(await sha256Of(bytes)) === hex) {
        const type = pictureType(bytes);
        if (type !== null) picture = { bytes, type, id, gateway, older: [] };
      }
    } catch (error) {
      // The next gateway. A copy that did not load in time (an abort) leaves this gateway in the lookup.
      if (status === null && error instanceof TypeError && !stop.aborted) s.down.add(gateway);
    } finally {
      time.clear();
    }
    s.trace?.({ kind: 'bytes', gateway, id, status, match: picture !== null, ms: Date.now() - started });
    if (picture !== null || served) return { picture, answered: true, withheld: null, whole: false };
  }
  return UNREAD;
}

/** One gateway's search pages: the cursor its next page starts after, whether it has one, and a page in flight. */
interface Pager { readonly gateway: string; after: string | null; more: boolean; busy: boolean }
/** A copy a search answer named, with its age: its height, then the order in which the answers named it. */
type Aged = Candidate & { readonly order: number };
/**
 * A copy in the queue: its age, and its withheld key when the list had entries as it was queued (checked against the
 * list as it is when the copy is taken; F157 (3): a listed copy is never read).
 */
type Queued = Aged & { readonly key: string | null };
/** The oldest listed copy a search took (never read), and the keys that list it. */
interface Listed { readonly candidate: Queued; readonly keys: readonly string[] }

/**
 * All searches at once; candidates read oldest first, a few at a time, until one matches, none is left or the lookup
 * stops at `ends`. When the unread candidates drop below half a page (or below the number of readers, if that is more),
 * each gateway with a next page is asked for it; a gateway that names no next page, or the same cursor again, is done.
 * Each copy is given its share of the time left (see `share`), so every copy gets a first try before the end; a copy no
 * gateway answered gets one more, oldest first, once no copy is waiting for its first.
 * F157 (3): with a withheld list, each new copy's key is known before it is queued and checked against the list as it
 * is when the copy is taken, and again right before each request (fetchItem); a listed copy is never read. The picture
 * itself listed meanwhile stops the search at once: Withheld. A listed copy taken and no match at all: Withheld.
 * Fix round af2: every copy an answer names is recorded with its age as the answer arrives, before its key is hashed;
 * a match carries every older one (`older`), whatever became of it, and findArweavePicture accepts it only once the list
 * names none of them, as the share cards' oldest-first reader would have stopped at a listed one. Newer ones are left out.
 */
function searchAll(hex: string, s: Settings, stop: AbortSignal, tried: Set<string>, ends: number, seen: { listed: Listed | null }): Promise<ArweavePicture | Withheld | null> {
  return new Promise((resolve) => {
    const queue: Queued[] = [];
    const again: Queued[] = [];
    const queued = new Set<string>();
    /** Every copy an answer named, by id, with the oldest age an answer gave it (fix round af2). */
    const named = new Map<string, Aged>();
    const waiting: (() => void)[] = [];
    const wake = () => { for (const go of waiting.splice(0)) go(); };
    const low = Math.max(s.concurrency, Math.ceil(s.pageSize / 2));
    const workers = Math.max(1, s.concurrency);
    let order = 0;
    /** A copy named by an answer, recorded at once: kept with the oldest age any answer gave it. */
    const receive = (candidate: Candidate): Aged => {
      const known = named.get(candidate.id);
      if (known !== undefined && (known.height ?? Number.MAX_SAFE_INTEGER) <= (candidate.height ?? Number.MAX_SAFE_INTEGER)) return known;
      const aged: Aged = { ...candidate, order: known?.order ?? order++ };
      named.set(candidate.id, aged);
      return aged;
    };
    let reading = 0;
    let match: ArweavePicture | null = null;
    /** The picture itself was listed during the search (right before a request): the answer, and no more requests. */
    let stopped: Withheld | null = null;
    /** The oldest listed copy taken (never read); the caller reads it too when the budget ends the search. */
    let listed: Listed | null = null;
    const note = (candidate: Queued, keys: readonly string[]) => {
      if (listed === null || byAge(candidate, listed.candidate) < 0) { listed = { candidate, keys }; seen.listed = listed; }
    };
    const pagers: Pager[] = s.searchGateways.map((gateway) => ({ gateway, after: null, more: true, busy: false }));
    const ask = (pager: Pager) => {
      pager.busy = true;
      void search(pager.gateway, hex, pager.after, s, stop).then(async (page) => {
        // Fix round af2: recorded with their age as the answer arrives, before their keys are hashed, so a match found
        // meanwhile goes with every older one.
        const aged = page === null ? [] : page.candidates.map(receive);
        const fresh = aged.filter((candidate) => !tried.has(candidate.id) && !queued.has(candidate.id));
        // An empty list (the usual case) needs no hashing: the copies are queued at once, as before.
        const keys = fresh.length === 0 || withheldListEmpty() ? null : await withheldKeys(fresh.map((candidate) => `ar:${candidate.id}`));
        pager.busy = false;
        pager.more = page !== null && page.next !== null && page.next !== pager.after;
        if (page !== null) {
          pager.after = page.next;
          fresh.forEach((candidate, i) => {
            if (tried.has(candidate.id) || queued.has(candidate.id)) return;
            queued.add(candidate.id);
            queue.push({ ...candidate, key: keys?.[i] ?? null });
          });
          queue.sort(byAge);
        }
        wake();
      });
    };
    /** The next pages, while the lookup goes on and the unread candidates run low. */
    const refill = () => {
      if (match !== null || stopped !== null || stop.aborted || queue.length >= low) return;
      for (const pager of pagers) if (pager.more && !pager.busy) ask(pager);
    };
    for (const pager of pagers) ask(pager);
    /**
     * A copy's time per gateway: what is left until RESERVE_MS before `ends`, shared among the readers' copies (this one
     * and those being read) and the copies still waiting for the same kind of try, split across the gateways still in
     * the lookup; never more than rawTimeoutMs, never less than MIN_COPY_MS. Few copies: the full time. Many that never
     * load: each ends soon enough for the copies behind it to be asked, and read, before the end.
     */
    const share = (retry: boolean): number => {
      const left = Math.max(0, ends - RESERVE_MS - Date.now());
      const waitingCopies = retry ? again.length : queue.length;
      const up = Math.max(1, s.rawGateways.filter((gateway) => !s.down.has(gateway)).length);
      return Math.min(s.rawTimeoutMs, Math.max(MIN_COPY_MS, Math.floor((left * workers) / Math.max(1, waitingCopies + reading) / up)));
    };
    /** The next copy: a first try, oldest first; else one more try for a copy no gateway answered (oldest first). */
    const next = async (): Promise<{ readonly candidate: Queued; readonly retry: boolean } | null> => {
      for (;;) {
        if (match !== null || stopped !== null || stop.aborted) return null;
        refill();
        const candidate = queue.shift();
        if (candidate) {
          tried.add(candidate.id);
          // A listed copy (by the list as it is now) is never read; the oldest one taken is kept to decide the answer.
          if (candidate.key !== null && listedKeys([candidate.key])) { note(candidate, [candidate.key]); continue; }
          return { candidate, retry: false };
        }
        const retried = again.shift();
        if (retried) return { candidate: retried, retry: true };
        // Done when no page and no copy being read can bring another (a copy being read may still come back for a retry).
        if (!pagers.some((pager) => pager.busy || pager.more) && reading === 0) return null;
        await new Promise<void>((go) => waiting.push(go));
      }
    };
    const worker = async () => {
      for (let taken = await next(); taken !== null; taken = await next()) {
        reading += 1;
        try {
          const read = await fetchItem(taken.candidate.id, hex, s, stop, share(taken.retry));
          if (read.withheld !== null) {
            // Listed right before its request: the picture itself (stop, Withheld), or this copy (never read, noted).
            if (read.whole) { if (stopped === null && match === null) { stopped = read.withheld; resolve(read.withheld); } }
            else note(taken.candidate, read.withheld.keys);
          } else if (read.picture !== null && match === null && stopped === null) {
            // Fix round af2: the share cards read oldest first and stop at a listed copy, so every copy named so far that
            // is older than this one goes with it (read, queued, waiting for a retry or still being hashed alike), to be
            // checked against the list as it is then (findArweavePicture). Newer ones (decoys) are left out.
            const self = named.get(taken.candidate.id) ?? taken.candidate;
            const older = [...named.values()].filter((candidate) => byAge(candidate, self) < 0).map((candidate) => candidate.id);
            match = { ...read.picture, older };
            resolve(match);
          } else if (!read.answered && !taken.retry && !stop.aborted) { again.push(taken.candidate); again.sort(byAge); }
        } finally {
          reading -= 1;
          wake();
        }
      }
    };
    stop.addEventListener('abort', wake, { once: true });
    void Promise.all(Array.from({ length: Math.max(1, s.concurrency) }, worker)).then(() => {
      const oldest: Listed | null = listed;
      resolve(stopped ?? match ?? (oldest === null ? null : withheldResult(oldest.keys)));
    });
  });
}

/**
 * The committed picture from Arweave (uncached), or null when nothing matched within the budget (the placeholder), or
 * Withheld (F157 (3): the picture or the copy that decides it is on our withheld list; nothing of it was read).
 */
export async function findArweavePicture(sha256: Hash, given: ReadOptions = {}): Promise<ArweavePicture | Withheld | null> {
  if (!HASH.test(sha256) || ZERO.test(sha256)) return null;
  const s: Settings = {
    hint: typeof given.hint === 'string' && ARWEAVE_ID.test(given.hint) ? given.hint : null,
    search: given.search ?? true,
    searchGateways: given.searchGateways ?? ARWEAVE_SEARCH_GATEWAYS,
    rawGateways: given.rawGateways ?? ARWEAVE_RAW_GATEWAYS,
    fetcher: given.fetcher ?? fetch.bind(globalThis),
    maxBytes: given.maxBytes ?? PICTURE_BUDGET.bytes,
    pageSize: given.pageSize ?? PAGE_SIZE,
    concurrency: given.concurrency ?? CONCURRENCY,
    budgetMs: given.budgetMs ?? BUDGET_MS,
    searchTimeoutMs: given.searchTimeoutMs ?? SEARCH_TIMEOUT_MS,
    rawTimeoutMs: given.rawTimeoutMs ?? COPY_TIMEOUT_MS,
    hintTimeoutMs: given.hintTimeoutMs ?? HINT_TIMEOUT_MS,
    trace: given.trace,
    down: new Set(),
    ids: pictureIds(committedPictureId(sha256), typeof given.hint === 'string' ? arweavePictureId(given.hint) : null),
  };
  if (s.hint === null && !s.search) return null;
  const hex = sha256.slice(2).toLowerCase();
  // F157 (3): the picture itself listed (the raw CID of its hash names exactly these bytes), or the indexer's copy
  // (the box's own): nothing is asked or searched.
  const listedPicture = await withheldVerdict(s.ids);
  if (listedPicture !== null) return listedPicture;
  const stop = new AbortController();
  const ends = Date.now() + s.budgetMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), s.budgetMs); });
  const seen: { listed: Listed | null } = { listed: null };
  const lookup = async (): Promise<ArweavePicture | Withheld | null> => {
    const tried = new Set<string>();
    if (s.hint !== null) {
      tried.add(s.hint);
      // The indexer's copy, checked again right before each request (fetchItem): listed, it is not read and nothing is
      // searched.
      const { picture, withheld } = await fetchItem(s.hint, hex, s, stop.signal, s.hintTimeoutMs);
      if (withheld !== null) return withheld;
      if (picture !== null) return picture;
    }
    return s.search ? searchAll(hex, s, stop.signal, tried, ends, seen) : null;
  };
  let answer: ArweavePicture | Withheld | null;
  try {
    answer = await Promise.race([lookup(), deadline]);
  } finally {
    clearTimeout(timer);
    // Whatever is still asked (other candidates, a silent gateway) is dropped.
    stop.abort();
  }
  // The budget ended the search after a listed copy was taken: Withheld, as with no match at all.
  const noted: Listed | null = seen.listed;
  if (answer === null && noted !== null) return withheldResult(noted.keys);
  if (answer === null || isWithheldResult(answer)) return answer;
  // The list may have changed while the bytes were read: the copy found is checked again, with the picture's own ids
  // and (fix round af2) every older copy the search named; this verdict accepts the match.
  return (await withheldVerdict(pictureIds(...s.ids, ...arweaveIdsOf(answer)))) ?? answer;
}

/**
 * Found pictures for the page load, by hash, each with its withheld keys (its bytes' id, its copy's and every older
 * copy's the search named), and lookups in flight. A picture whose key the list names is dropped as the list changes,
 * and never handed out again.
 */
const found = new Map<string, { readonly picture: ArweavePicture; readonly keys: readonly string[] }>();
const running = new Map<string, Promise<ArweavePicture | Withheld | null>>();
let watching = false;

/** F157 (3): kept only while not listed; checked against the list as it is now, whatever was checked before. */
async function keep(key: string, picture: ArweavePicture): Promise<ArweavePicture | Withheld> {
  const check = await checkWithheld(pictureIds(committedPictureId(key), ...arweaveIdsOf(picture)));
  if (check.withheld) { found.delete(key); return withheldResult(check.keys); }
  found.set(key, { picture, keys: check.keys });
  if (!watching) {
    watching = true;
    subscribeWithheld(() => { for (const [hash, entry] of found) if (listedKeys(entry.keys)) found.delete(hash); });
  }
  return picture;
}

/** This page's verified copy of a picture, if it found or published one (never one the withheld list names). */
export function knownArweavePicture(sha256: string): ArweavePicture | null {
  const known = found.get(sha256.toLowerCase());
  return known && !listedKeys(known.keys) ? known.picture : null;
}

/**
 * Keeps a picture this page just published (its bytes checked against the hash first), so it shows without a lookup;
 * Withheld (and not kept) when the list names its bytes or its new copy.
 */
export async function rememberArweavePicture(sha256: Hash, bytes: Uint8Array, id: string): Promise<ArweavePicture | Withheld | null> {
  const key = sha256.toLowerCase();
  const type = pictureType(bytes);
  if (!HASH.test(key) || type === null || `0x${hexOf(await sha256Of(bytes))}` !== key) return null;
  return keep(key, { bytes: bytes.slice(), type, id, gateway: '', older: [] });
}

/**
 * The lookup above, once per page load per hash: a picture found is kept; one not found is asked again next time; a
 * withheld one is never kept. A kept picture and a lookup in flight are checked against the list before they are handed
 * out.
 */
export async function arweavePicture(sha256: Hash, options: ReadOptions = {}): Promise<ArweavePicture | Withheld | null> {
  const key = sha256.toLowerCase();
  const hint = typeof options.hint === 'string' && ARWEAVE_ID.test(options.hint) ? options.hint : '';
  const known = found.get(key);
  if (known) {
    await withheldReady();
    if (listedKeys(known.keys)) {
      found.delete(key);
      return withheldResult(known.keys);
    }
    // Fix round af1: kept under another copy, but the copy this caller names (the indexer's, the box's own) is listed.
    const listedHint = hint === '' ? null : await withheldVerdict([`ar:${hint}`]);
    return listedHint ?? known.picture;
  }
  if (hint === '' && options.search === false) return null;
  const flight = `${key}:${hint}:${options.search === false ? 'hint' : 'search'}`;
  const busy = running.get(flight);
  if (busy) return busy;
  const lookup = findArweavePicture(key as Hash, options).catch(() => null).then(async (picture) => {
    try {
      return picture === null || isWithheldResult(picture) ? picture : await keep(key, picture);
    } finally {
      running.delete(flight);
    }
  });
  running.set(flight, lookup);
  return lookup;
}

/** Test seam: forget every picture and lookup. */
export function resetArweaveForTests(): void { found.clear(); running.clear(); }
