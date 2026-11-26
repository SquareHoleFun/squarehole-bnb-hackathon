/**
 * SH-WITHHELD-SITE (founder decision F157 (3), a narrow exception to F149: a picture that is illegal or under a legal
 * notice, never taste): the site's one reader of our withheld-picture list, and the check every picture passes before
 * it is fetched or shown. The server half (SH-WITHHELD-PICTURES) serves the list; its runbook is
 * docs/runbooks/withheld-pictures.md.
 *
 * - The list: `GET <API origin>/v2/withheld`, `{ "version": 1, "hashes": [...] }`, each the lowercase SHA-256 hex of the
 *   UTF-8 string "sh-withheld-v1:" + a picture id: `ipfs:<canonical raw CIDv1>` or `ar:<Arweave transaction id>`
 *   (packages/indexer/API.md). The API origin is the one the current data source already reads (its core indexer,
 *   AppProviders sets it); without one (the Demo, a build that names none) the list is empty.
 * - Read on first need (the first picture checked), then about every REFRESH_MS while the page is visible; a hidden page
 *   reads again as it becomes visible once its list is that old. No credentials, no referrer, no redirect followed.
 * - A read that fails, or answers anything but a version 1 list, keeps the last good list; before any good read the
 *   list is empty (a missing list is an empty list, as on the server).
 * - Every picture waits for the first read (it ends within READ_TIMEOUT_MS): a listed picture is never fetched, not
 *   even once on a cold page.
 * - Hashing: SubtleCrypto, once per id. Where it is missing (an insecure context, never our https site or a loopback
 *   page) an id cannot be checked: with a non-empty list it counts as listed.
 * - Subscribers hear every change: pictures already shown or kept are checked again and turn into the neutral tile
 *   without a reload (WithheldTile.tsx); a picture taken off the list is asked for again.
 * Pictures only: no box, link or wallet is touched, nothing says why, and nothing here asks a wallet for anything.
 */
import { rawCidV1 } from '@squarehole/artwork';
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';

/** The tile's words (minimal text, the founder's rule). */
export const WITHHELD_TEXT = 'Picture withheld';
/** The domain prefix of every hashed id (packages/indexer/src/withheld/list.mjs). */
export const WITHHELD_PREFIX = 'sh-withheld-v1:';
export const WITHHELD_PATH = '/v2/withheld';
/** About how often a visible page reads the list again (the answer's own `max-age=60`). */
export const REFRESH_MS = 60_000;
/** The longest a read may take; pictures wait for the first one at most this long. */
export const READ_TIMEOUT_MS = 5_000;
/** The largest answer read (a hash is about 67 bytes of JSON: some 30,000 entries); a larger one is no answer. */
export const MAX_LIST_BYTES = 2 * 1024 * 1024;
/** A key that matches no list: an id that could not be hashed (no SubtleCrypto). */
export const UNHASHABLE = '!';

const HEX = /^[0-9a-f]{64}$/;
const CID = /^bafkrei[a-h][a-z2-7]{50}[aeimquy4]$/;
const ARWEAVE_ID = /^[A-Za-z0-9_-]{43}$/;
const HASH = /^0x[0-9a-f]{64}$/i;
const ZERO = /^0x0{64}$/i;
const MAX_MEMO = 20_000;

/** A picture by our IPFS gateway's id: its canonical raw CIDv1 (sha2-256), nothing else (no path, no other encoding). */
export const ipfsPictureId = (cid: string): string | null => (CID.test(cid) ? `ipfs:${cid}` : null);
/** A picture's Arweave copy by its transaction id (case-sensitive, never changed). */
export const arweavePictureId = (id: string): string | null => (ARWEAVE_ID.test(id) ? `ar:${id}` : null);
/** The id of the exact bytes a SHA-256 names: its raw CIDv1, as our gateway serves them (a content address). */
export const committedPictureId = (sha256: string): string | null => (HASH.test(sha256) && !ZERO.test(sha256) ? `ipfs:${rawCidV1(sha256.toLowerCase() as `0x${string}`)}` : null);
/** The ids of a picture, without the ones that are not ids. */
export const pictureIds = (...ids: readonly (string | null | undefined)[]): string[] => [...new Set(ids.filter((id): id is string => typeof id === 'string'))];

/** The hashes in a /v2/withheld answer, or null when it is not a version 1 list of lowercase SHA-256 hex. */
export function parseWithheldList(body: unknown): ReadonlySet<string> | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const { version, hashes } = body as { version?: unknown; hashes?: unknown };
  if (version !== 1 || !Array.isArray(hashes) || !hashes.every((hash) => typeof hash === 'string' && HEX.test(hash))) return null;
  return new Set(hashes as string[]);
}

// --- hashing ---------------------------------------------------------------------------------------------------------

const hexOf = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const memo = new Map<string, Promise<string>>();

async function digest(id: string): Promise<string> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return UNHASHABLE;
    return hexOf(new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(`${WITHHELD_PREFIX}${id}`))));
  } catch {
    return UNHASHABLE;
  }
}

/** SHA-256 hex (SubtleCrypto) of "sh-withheld-v1:" + id, as the list holds it; UNHASHABLE without SubtleCrypto. */
export function withheldHash(id: string): Promise<string> {
  // An id that could not be made (no SubtleCrypto for the bytes) is unhashable too: listed while the list is not empty.
  if (id === UNHASHABLE) return Promise.resolve(UNHASHABLE);
  let hash = memo.get(id);
  if (hash === undefined) {
    if (memo.size >= MAX_MEMO) memo.clear();
    hash = digest(id);
    memo.set(id, hash);
  }
  return hash;
}

/** The keys (hashes) of `ids`, in order. */
export const withheldKeys = (ids: readonly string[]): Promise<readonly string[]> => Promise.all(ids.map(withheldHash));

// --- the list --------------------------------------------------------------------------------------------------------

/** What a subscriber reads: whether the first read has ended, how many times the list changed, and whether it is empty. */
export interface WithheldState {
  readonly ready: boolean;
  readonly version: number;
  readonly empty: boolean;
}

interface Reader {
  readonly origin: string | null;
  hashes: ReadonlySet<string>;
  started: boolean;
  done: boolean;
  first: Promise<void>;
  settle: () => void;
  reading: Promise<void> | null;
  lastRead: number;
  due: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const NONE: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
let fetcher: typeof fetch | null = null;
let now: () => number = () => Date.now();
let version = 0;
let state: WithheldState = Object.freeze({ ready: true, version, empty: true });
let reader = makeReader(null);
let watching = false;
/** A test fixed the origin (resetWithheldForTests): the app's setting leaves it. */
let fixed = false;

function makeReader(origin: string | null): Reader {
  let settle: () => void = () => undefined;
  const first = new Promise<void>((resolve) => { settle = resolve; });
  if (origin === null) settle();
  return { origin, hashes: NONE, started: false, done: origin === null, first, settle, reading: null, lastRead: -Infinity, due: false, timer: null };
}

function publish(): void {
  const next = Object.freeze({ ready: reader.done, version, empty: reader.hashes.size === 0 });
  if (next.ready === state.ready && next.version === state.version && next.empty === state.empty) return;
  state = next;
  for (const listener of [...listeners]) listener();
}

const hidden = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden';

function same(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const hash of a) if (!b.has(hash)) return false;
  return true;
}

/** The answer's bytes, or null past MAX_LIST_BYTES (the rest is not read). */
async function readCapped(response: Response): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_LIST_BYTES) { await response.body?.cancel().catch(() => undefined); return null; }
  if (response.body === null) return null;
  const stream = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await stream.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_LIST_BYTES) { await stream.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return bytes;
}

/** One read of `origin`'s list: the hashes, or null when it gave no valid list in time. */
async function fetchList(origin: string): Promise<ReadonlySet<string> | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(null); }, READ_TIMEOUT_MS); });
  const read = (async () => {
    try {
      const response = await (fetcher ?? fetch.bind(globalThis))(`${origin}${WITHHELD_PATH}`, {
        credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-cache', signal: controller.signal,
      });
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); return null; }
      const bytes = await readCapped(response);
      return bytes === null ? null : parseWithheldList(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
    } catch {
      return null;
    }
  })();
  try {
    return await Promise.race([read, expired]);
  } finally {
    clearTimeout(timer);
  }
}

function schedule(target: Reader): void {
  if (target.timer !== null) clearTimeout(target.timer);
  target.timer = setTimeout(() => {
    target.timer = null;
    if (target !== reader) return;
    if (hidden()) { target.due = true; return; }
    void read(target);
  }, REFRESH_MS);
}

function read(target: Reader): Promise<void> {
  if (target.reading !== null) return target.reading;
  const origin = target.origin;
  if (origin === null) return Promise.resolve();
  target.due = false;
  target.reading = fetchList(origin).then((list) => {
    target.reading = null;
    if (target !== reader) return;
    target.lastRead = now();
    // A failed read keeps the last good list (empty before the first good one).
    if (list !== null && !same(list, target.hashes)) {
      target.hashes = list;
      version += 1;
    }
    if (!target.done) { target.done = true; target.settle(); }
    publish();
    schedule(target);
  });
  return target.reading;
}

function onVisibility(): void {
  const target = reader;
  if (target.origin === null || !target.started || hidden()) return;
  if (target.due || now() - target.lastRead >= REFRESH_MS) void read(target);
}

function start(target: Reader): void {
  if (target.started || target.origin === null) return;
  target.started = true;
  if (!watching && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
    watching = true;
  }
  void read(target);
}

/**
 * The API origin the list is read from (null: none, the list is empty). Nothing is read until a picture needs the list.
 * A new origin starts a new, empty list: the pictures checked from then on wait for its first read.
 */
export function setWithheldOrigin(origin: string | null): void {
  if (fixed || origin === reader.origin) return;
  const old = reader;
  if (old.timer !== null) clearTimeout(old.timer);
  reader = makeReader(origin);
  // Whoever waited for the old list waits for the new one instead (withheldReady follows the current reader).
  old.settle();
  if (old.hashes.size > 0) version += 1;
  publish();
}

/**
 * The API origin a data source reads (its core indexer gateway), or null for the sample data and a source without one.
 * Named by the chain sources only, so the production bundle carries no word of the sample data (check:production).
 */
export function withheldOriginFor(source: 'demo' | 'local' | 'sepolia', indexers: { readonly local: string | null; readonly sepolia: string | null }): string | null {
  return source === 'local' ? indexers.local : source === 'sepolia' ? indexers.sepolia : null;
}

/** AppProviders: the current data source's API origin, set before any picture below it asks (a layout effect). */
export function useWithheldSource(origin: string | null): void {
  useLayoutEffect(() => { setWithheldOrigin(origin); }, [origin]);
}

/** After the first read of the current list has ended (at once without an origin); starts reading on first need. */
export async function withheldReady(): Promise<void> {
  for (;;) {
    const target = reader;
    start(target);
    await target.first;
    if (target === reader) return;
  }
}

export const withheldState = (): WithheldState => state;

export function subscribeWithheld(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Whether one of these keys is on the current list (an UNHASHABLE key counts as listed while the list is not empty). */
export function listedKeys(keys: readonly string[]): boolean {
  const hashes = reader.hashes;
  if (hashes.size === 0) return false;
  return keys.some((key) => key === UNHASHABLE || hashes.has(key));
}

/** A picture's check: whether it is withheld now, and its keys, to check it again whenever the list changes. */
export interface WithheldCheck {
  readonly withheld: boolean;
  readonly keys: readonly string[];
}

/** Before a fetch or a display: waits for the first read, hashes the ids, and tells whether one is listed now. */
export async function checkWithheld(ids: readonly string[]): Promise<WithheldCheck> {
  await withheldReady();
  const keys = await withheldKeys(ids);
  return { withheld: listedKeys(keys), keys };
}

/** A lookup's answer for a withheld picture: never fetched further, never shown; `keys` are the ones that were checked. */
export interface Withheld {
  readonly withheld: true;
  readonly keys: readonly string[];
}
export const withheldResult = (keys: readonly string[]): Withheld => Object.freeze({ withheld: true as const, keys: Object.freeze([...keys]) });
export const isWithheldResult = (value: unknown): value is Withheld => typeof value === 'object' && value !== null && (value as { withheld?: unknown }).withheld === true;

/**
 * Inside a lookup, before each read: waits for the first read; null when none of the ids is listed now (an empty list
 * needs no hashing at all, so a page without a list costs no more than before), else the Withheld answer.
 */
export async function withheldVerdict(ids: readonly string[]): Promise<Withheld | null> {
  await withheldReady();
  if (reader.hashes.size === 0 || ids.length === 0) return null;
  const keys = await withheldKeys(ids);
  return listedKeys(keys) ? withheldResult(keys) : null;
}

/** Whether the list is empty now (nothing can be listed: a lookup need not hash its candidates). */
export const withheldListEmpty = (): boolean => reader.hashes.size === 0;

export async function isWithheld(ids: readonly string[]): Promise<boolean> {
  return (await withheldVerdict(ids)) !== null;
}

/**
 * Founder decision R77-TAKEDOWN-CREATE ("refuse"; fix rounds af2 and af3): the one line where Create, or a box page's
 * Add picture, refuses to upload a picture on the list. No reason.
 */
export const REFUSED_PICTURE_TEXT = 'This picture can’t be used.';

/**
 * Before an upload (R77-TAKEDOWN-CREATE): whether the list names one of these committed pictures (sha256s), by each
 * one's own id (`ipfs:` + the raw CID of its hash: exactly its bytes). It waits for the list's first read; an id it
 * cannot hash (no SubtleCrypto) counts as listed while the list has entries. No picture: nothing is asked.
 */
export async function refusedPicture(hashes: readonly string[]): Promise<boolean> {
  const ids = pictureIds(...hashes.map(committedPictureId));
  return ids.length > 0 && (await withheldVerdict(ids)) !== null;
}

/** A guard's state: still checking (the first read, or the hashes), withheld, or clear to fetch and show. */
export type WithheldVerdict = 'checking' | 'withheld' | 'clear';

/**
 * For a picture the page shows by URL (the indexer's item art): 'checking' until the list's first read and the ids'
 * hashes are known, then 'withheld' or 'clear', following every change of the list. Null ids: clear (nothing to check);
 * 'pending': the ids are not known yet (checking).
 */
export function useWithheld(ids: readonly string[] | null | 'pending'): WithheldVerdict {
  const key = ids === null || ids === 'pending' ? null : ids.join(' ');
  const waits = ids !== null;
  const current = useSyncExternalStore(subscribeWithheld, withheldState, withheldState);
  const [hashed, setHashed] = useState<{ readonly key: string; readonly keys: readonly string[] } | null>(null);
  useEffect(() => {
    if (!waits) return;
    // Reading starts as soon as a picture waits for the list, even before its ids are known.
    void withheldReady();
    if (key === null) return;
    let live = true;
    void withheldKeys(key === '' ? [] : key.split(' ')).then((keys) => { if (live) setHashed({ key, keys }); });
    return () => { live = false; };
  }, [key, waits]);
  if (ids === 'pending') return 'checking';
  if (key === null || key === '') return 'clear';
  if (!current.ready) return 'checking';
  if (current.empty) return 'clear';
  if (hashed?.key !== key) return 'checking';
  return listedKeys(hashed.keys) ? 'withheld' : 'clear';
}

/** The bytes a `data:` URL carries (base64 or percent-encoded), or null when it is not one. */
export function dataUrlBytes(url: string): Uint8Array<ArrayBuffer> | null {
  const head = /^data:[^,]*?(;base64)?,/i.exec(url);
  if (!head) return null;
  const payload = url.slice(head[0].length);
  try {
    if (head[1]) {
      const binary = atob(payload);
      return Uint8Array.from(binary, (char) => char.charCodeAt(0));
    }
    return new TextEncoder().encode(decodeURIComponent(payload));
  } catch {
    return null;
  }
}

/**
 * The withheld id of a picture a page carries inline (a data URL decoded from a chain record): `ipfs:` + the raw CID of
 * its bytes' SHA-256, as our gateway would name exactly these bytes. Unhashable without SubtleCrypto (listed while the
 * list is not empty); none for a URL that carries no bytes (nothing can be drawn from it either).
 */
export async function inlinePictureIds(url: string): Promise<readonly string[]> {
  const bytes = dataUrlBytes(url);
  if (bytes === null) return [];
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return [UNHASHABLE];
    // A copy: the digest never reads a shared or resizable buffer.
    return pictureIds(committedPictureId(`0x${hexOf(new Uint8Array(await subtle.digest('SHA-256', new Uint8Array(bytes))))}`));
  } catch {
    return [UNHASHABLE];
  }
}

/** As useWithheld, for a picture a page carries inline (`inlinePictureIds`): checking until its bytes are hashed. */
export function useWithheldInline(url: string | null): WithheldVerdict {
  const [found, setFound] = useState<{ readonly url: string; readonly ids: readonly string[] } | null>(null);
  useEffect(() => {
    if (url === null) return;
    let live = true;
    void inlinePictureIds(url).then((ids) => { if (live) setFound({ url, ids }); });
    return () => { live = false; };
  }, [url]);
  return useWithheld(url === null ? null : found?.url === url ? found.ids : 'pending');
}

/**
 * Test seam: no origin, no list, no reads; `options` sets the fetch and the clock, and `origin` fixes the origin for the
 * test (AppProviders' setting is then ignored until the next reset).
 */
export function resetWithheldForTests(options: { readonly origin?: string | null; readonly fetcher?: typeof fetch | null; readonly now?: () => number } = {}): void {
  const old = reader;
  if (old.timer !== null) clearTimeout(old.timer);
  fetcher = options.fetcher ?? null;
  now = options.now ?? (() => Date.now());
  fixed = options.origin !== undefined;
  memo.clear();
  reader = makeReader(options.origin ?? null);
  old.settle();
  version += 1;
  publish();
}
