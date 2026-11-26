/**
 * A chain box's committed pictures (SH-V2-LOCAL-ART, SH-V2-FE11): the token's logo (BoxSpec `coverSha256`, field 23)
 * and the box picture (the collection's own cover, `collectionCoverSha256`, field 28, when the spec commits one;
 * otherwise the logo). The spec commits each by SHA-256, so the bytes are asked from the source's gateways by their raw
 * CIDv1 and shown only when they are at most one raw block (1 MiB) and hash to exactly that commitment, as a raster
 * picture admitted by the shared artwork/box-picture judge, never by the gateway's header.
 * Anything else, a mismatch included, shows the placeholder: never the gateway's bytes. The Sepolia test site asks our
 * own node (https://api.squarehole.fun/ipfs/<cid>, SH-TA-26); no gateway (every other build's Sepolia boxes): the
 * placeholder, and nothing is fetched. Box 0's two public pictures (the FIT icon, an SVG our node never serves, and the
 * Misfits collection picture) come from the app's own bundle first, drawn only when the bundled bytes hash to the
 * commitment (bundled-pictures.ts, SH-BOX0-ART-TEST-SITE); no gateway is asked for them.
 *
 * One fetch per picture per page load: the answers are kept by hash (content addressed, so any gateway's verified
 * bytes are the same picture). A picture that could not be verified is asked again only after a minute.
 *
 * SH-ARWEAVE-PICTURES-WEB (founder 2026-10-24: box pictures on Arweave): a v2 box whose source has Arweave on is also
 * looked up there (pictures/arweave-read.ts, the same hash check in WebCrypto): first this page's own copy or the
 * indexer's (`pictureCopies`), then the gateways above, then the tag search on the three Arweave gateways. Box 0's
 * bundled pictures keep their path exactly: Arweave is never asked for a hash the bundle may carry.
 *
 * SH-WITHHELD-SITE (F157 (3)): before anything is asked or drawn, the picture's id (`ipfs:` + the raw CID of its hash,
 * which names exactly its bytes) is checked against our withheld list (pictures/withheld.ts, which waits for the list's
 * first read); a listed picture is never fetched, from any gateway, the browser's cache or the bundle, and never shown:
 * its state says `withheld` and the page shows the neutral tile. Arweave copies are checked there by their own ids too.
 * A picture found is checked again just before it shows, and every picture kept for the page (its blob URL) again
 * whenever the list changes: a listed one is dropped and turns into the tile without a reload; one taken off the list
 * is asked for again. A withheld picture is never `missing` (no Add picture for it).
 * Fix round af2: a picture found on Arweave through a newer copy keeps every older copy the search named among its keys
 * (arweave-read.ts `older`). And the indexer copy a caller names is checked before anything kept for the page is handed
 * to that caller: nothing while it is checked, the tile when it is listed (usePictureState).
 */
import { rawCidV1 } from '@squarehole/artwork';
import { inspectBoxPicture, pictureStructure, PICTURE_BUDGET, verifiedBoxPicture } from '@squarehole/artwork/box-picture';
import { useEffect, useSyncExternalStore } from 'react';
import { bundledPicture, mayBeBundled } from './bundled-pictures';
import { arweaveIdsOf, arweavePicture, rememberArweavePicture, resetArweaveForTests } from '../pictures/arweave-read';
import { pictureType } from '../pictures/picture-type';
import {
  arweavePictureId, checkWithheld, committedPictureId, isWithheldResult, listedKeys, pictureIds, subscribeWithheld, useWithheld, withheldKeys,
  withheldState, withheldVerdict, type Withheld,
} from '../pictures/withheld';

export { pictureType };

type Hash = `0x${string}`;

export interface BoxPictures {
  /** The token's logo (field 23), or null when the spec commits none. */
  readonly logo: Hash | null;
  /** The box picture: the collection's own cover (field 28) when nonzero, otherwise the logo. */
  readonly cover: Hash | null;
  /** The source's gateways (bare origins); none: the placeholder shows and nothing is fetched. */
  readonly gateways: readonly string[];
  /**
   * SH-ARWEAVE-PICTURES-WEB: present on a v2 box whose source has Arweave on (absent: Arweave is never asked), with the
   * indexer's copy of each picture by its hash (an Arweave id, tried first and checked like any other).
   */
  readonly arweave?: { readonly copies: Readonly<Record<string, string>> };
}

/** The indexer's Arweave copies of a v2 box's pictures (`pictureCopies`, SH-ARWEAVE-PICTURES-SRV): an id each, optional. */
export interface PictureCopies { readonly logo?: string; readonly cover?: string }
/** Where one picture is looked for: the source's gateways, and Arweave (with the indexer's copy) or not. */
export interface PictureLookup { readonly gateways: readonly string[]; readonly arweave: { readonly hint: string | null } | null }

const HASH = /^0x[0-9a-f]{64}$/i;
const ZERO = /^0x0{64}$/i;
const committed = (value: unknown): Hash | null => (typeof value === 'string' && HASH.test(value) && !ZERO.test(value) ? (value.toLowerCase() as Hash) : null);

const ARWEAVE_ID = /^[A-Za-z0-9_-]{43}$/;

/**
 * The pictures a spec commits: its logo and its collection cover (the logo stands in when there is none). `arweave`
 * (a v2 box whose source has Arweave on): the indexer's copies, when it names any. The copy named for the logo or the
 * cover is the hint for that hash; where the cover is the logo, either copy is.
 */
export function picturesOf(logo: unknown, collectionCover: unknown, gateways: readonly string[] = [], arweave: { readonly copies?: PictureCopies | null } | null = null): BoxPictures | null {
  const mark = committed(logo);
  const cover = committed(collectionCover) ?? mark;
  if (mark === null && cover === null) return null;
  const base = { logo: mark, cover, gateways: Object.freeze([...gateways]) };
  if (arweave === null) return Object.freeze(base);
  const id = (value: unknown): string | null => (typeof value === 'string' && ARWEAVE_ID.test(value) ? value : null);
  const copies: Record<string, string> = {};
  const logoId = id(arweave.copies?.logo) ?? (mark === cover ? id(arweave.copies?.cover) : null);
  const coverId = id(arweave.copies?.cover) ?? (mark === cover ? id(arweave.copies?.logo) : null);
  if (mark !== null && logoId !== null) copies[mark] = logoId;
  if (cover !== null && coverId !== null) copies[cover] = coverId;
  return Object.freeze({ ...base, arweave: Object.freeze({ copies: Object.freeze(copies) }) });
}

/** Where a box's logo or box picture is looked for (TokenMark, BoxCover, the box page's Add picture). */
export function lookupOf(pictures: BoxPictures | null | undefined, which: 'logo' | 'cover'): { readonly sha256: Hash | null } & PictureLookup {
  const sha256 = pictures?.[which] ?? null;
  return { sha256, gateways: pictures?.gateways ?? [], arweave: pictures?.arweave ? { hint: sha256 === null ? null : pictures.arweave.copies[sha256] ?? null } : null };
}

/** The body, or null as soon as it passes `limit` bytes (the rest is not read). */
async function readCapped(body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/**
 * One gateway's time for one picture, the answer's body included (SH-BOX-PICTURE-FIT fix round af1): a gateway that
 * stalls is given up and the next one asked, so a lookup always ends. The time the Arweave read gives the indexer's
 * copy per gateway (arweave-read.ts HINT_TIMEOUT_MS).
 */
export const GATEWAY_TIMEOUT_MS = 8_000;

export interface VerifiedPicture {
  readonly bytes: Uint8Array;
  readonly type: string;
}

/**
 * The committed picture from the first gateway whose answer verifies: raw CID path, at most PICTURE_BUDGET.bytes, the
 * exact SHA-256, a raster type. Null when none does (the placeholder then stays). No credentials or referrer are sent,
 * and a redirect counts as no answer. SH-WITHHELD-SITE: our withheld list as it is now is checked right before each
 * gateway's request (`ipfs:<cid>`, and `also`: the indexer's copies of the box): listed, the answer is Withheld and no
 * gateway more is asked, not even the browser's cache (fix round af1: a refresh between two gateways stops it there).
 * SH-BOX-PICTURE-FIT fix round af1: each gateway's request, its body included, ends after `timeoutMs`
 * (GATEWAY_TIMEOUT_MS); a stalled gateway counts as no answer.
 */
export async function fetchVerifiedPicture(
  sha256: Hash, gateways: readonly string[], fetcher: typeof fetch = fetch, also: readonly string[] = [], timeoutMs: number = GATEWAY_TIMEOUT_MS,
): Promise<VerifiedPicture | Withheld | null> {
  const expected = committed(sha256);
  if (expected === null) return null;
  const cid = rawCidV1(expected);
  const ids = pictureIds(`ipfs:${cid}`, ...also);
  for (const gateway of gateways) {
    const listed = await withheldVerdict(ids);
    if (listed !== null) return listed;
    try {
      const response = await fetcher(`${gateway}/ipfs/${cid}`, { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'force-cache', signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok || response.body === null) continue;
      const declared = Number(response.headers.get('content-length') ?? Number.NaN);
      if (Number.isFinite(declared) && declared > PICTURE_BUDGET.bytes) continue;
      const bytes = await readCapped(response.body, PICTURE_BUDGET.bytes);
      const picture = bytes === null ? null : verifiedBoxPicture(bytes, expected);
      if (picture) return picture;
    } catch {
      // This gateway gave no usable answer: the next one, or the placeholder.
    }
  }
  return null;
}

/** A URL the page can draw the verified bytes from: a blob URL, or a data URL where the browser has none (tests). */
function urlOf(picture: VerifiedPicture): string {
  try {
    // Copied into a fresh buffer: the Blob never shares memory with anything else.
    if (typeof URL.createObjectURL === 'function' && typeof Blob === 'function') return URL.createObjectURL(new Blob([picture.bytes.slice()], { type: picture.type }));
  } catch {
    // No blob URLs here (a test DOM): the data URL below draws the same verified bytes.
  }
  let binary = '';
  for (let i = 0; i < picture.bytes.length; i += 0x8000) binary += String.fromCharCode(...picture.bytes.subarray(i, i + 0x8000));
  return `data:${picture.type};base64,${btoa(binary)}`;
}

/**
 * SH-BOX-PICTURE-FIT fix round af2 (review M1): whether the browser can draw a verified picture. Bytes can hash to the
 * commitment, start like a PNG and still not decode (a truncated or broken file); such a picture counts as missing, so a
 * slot shows the verified other picture or its placeholder, never a broken image.
 */
export type PictureDecoder = (url: string, picture: VerifiedPicture) => Promise<boolean>;

/** The time one decode may take before the picture counts as missing (a decoder that never answers ends too). */
export const DECODE_TIMEOUT_MS = 8_000;

/**
 * Decode only bounded, structurally complete bytes. Detaching src abandons the image request and allows the browser
 * to release its decoder; HTMLImageElement.decode has no AbortSignal or guaranteed immediate CPU cancellation.
 * The owning shownEntry revokes the blob on failure. A late resolution cannot publish it.
 */
export const browserDecodes: PictureDecoder = async (url, { bytes, type }) => {
  if (inspectBoxPicture(bytes)?.type !== type) return false;
  const img = new Image();
  img.decoding = 'async';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), DECODE_TIMEOUT_MS); });
  try {
    // load/error also works in browsers without decode(). Test DOMs inject a decoder explicitly.
    const loaded = new Promise<boolean>((resolve) => {
      img.onload = () => resolve(img.naturalWidth > 0 && img.naturalHeight > 0);
      img.onerror = () => resolve(false);
    });
    img.src = url;
    const decoded = typeof img.decode === 'function'
      ? img.decode().then(() => img.naturalWidth > 0 && img.naturalHeight > 0, () => false) : loaded;
    return await Promise.race([decoded, late]);
  } finally {
    clearTimeout(timer);
    img.onload = null;
    img.onerror = null;
    img.removeAttribute('src');
  }
};
let decoder: PictureDecoder = browserDecodes;

/** Compatibility seam: termination is parsed in the shared module, never searched in a byte tail. */
export function endsWhole(bytes: Uint8Array, type: string): boolean {
  return pictureStructure(bytes)?.type === type;
}

/** Whether `url` (the verified picture's) decodes here; a decoder that throws counts as no. */
async function decodes(url: string, picture: VerifiedPicture): Promise<boolean> {
  try {
    return (await decoder(url, picture)) === true;
  } catch {
    return false;
  }
}

/** A blob URL is let go once its picture is withheld (the bytes leave the page's memory with it). */
function revoke(url: string): void {
  try {
    if (url.startsWith('blob:') && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
  } catch {
    // Nothing to let go.
  }
}

const RETRY_MS = 60_000;
/**
 * One hash's answer on this page: its verified URL, or the keys that withhold it (`withheld`), or neither once the
 * lookup ended without a picture (missing); `pending` while it runs. `keys`: the withheld keys it is checked by at every
 * change of the list, a missing picture's too (fix round af1): its bytes' id, the copy that supplied it, and every
 * indexer copy this page named for the hash (not for box 0's bundled hashes, which never ask Arweave).
 */
type Entry = { readonly url: string | null; readonly pending: boolean; readonly at: number; readonly keys: readonly string[]; readonly withheld: readonly string[] | null };
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
/** The indexer's Arweave copies the page named for each hash (BoxPictures `arweave.copies`), kept with its answer. */
const copiesByHash = new Map<string, Set<string>>();
let fetcher: typeof fetch | null = null;
let watching = false;

const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const withheldEntry = (keys: readonly string[]): Entry => ({ url: null, pending: false, at: Date.now(), keys, withheld: keys });
const missingEntry = (keys: readonly string[]): Entry => ({ url: null, pending: false, at: Date.now(), keys, withheld: null });
/** A settled answer (shown or missing) the list names now, by its keys. */
const listedNow = (entry: Entry): boolean => !entry.pending && entry.withheld === null && listedKeys(entry.keys);

/**
 * SH-WITHHELD-SITE: every change of the withheld list checks each picture kept here again, whatever the retry wait. A
 * listed one is let go and turns into the tile without a reload, a missing one (fix round af1) too, so the box page
 * offers no Add picture for it; one taken off the list is forgotten, so the page asks for it again.
 */
function recheck(): void {
  let changed = false;
  for (const [hash, entry] of entries) {
    if (listedNow(entry)) {
      if (entry.url !== null) revoke(entry.url);
      entries.set(hash, withheldEntry(entry.keys));
      changed = true;
    } else if (entry.withheld !== null && !listedKeys(entry.withheld)) {
      entries.delete(hash);
      changed = true;
    }
  }
  if (changed) notify();
}

/** The indexer's copies the page named for `sha256`, as withheld ids (none for a hash the bundle may carry). */
function copyIds(sha256: Hash): string[] {
  if (mayBeBundled(sha256)) return [];
  return pictureIds(...[...(copiesByHash.get(sha256) ?? [])].map(arweavePictureId));
}

/**
 * Fix round af1: a page that names another indexer copy for a hash it already answered (another box, a later read) adds
 * that copy's key to the answer, checked against the list as it is now: listed, the answer turns into the tile.
 */
async function adopt(sha256: Hash, hint: string): Promise<void> {
  const id = arweavePictureId(hint);
  if (id === null) return;
  const [key] = await withheldKeys([id]);
  const current = entries.get(sha256);
  if (key === undefined || current === undefined || current.pending || current.keys.includes(key)) return;
  const keys = [...current.keys, key];
  if (current.withheld !== null) entries.set(sha256, { ...current, keys, withheld: [...current.withheld, key] });
  else if (listedKeys([key])) {
    if (current.url !== null) revoke(current.url);
    entries.set(sha256, withheldEntry(keys));
  } else entries.set(sha256, { ...current, keys });
  notify();
}

/**
 * A verified picture and the withheld ids it was found under (its bytes' raw CID; from Arweave, its copy's id and every
 * older copy's the search named, fix round af2).
 */
interface Found { readonly picture: VerifiedPicture; readonly ids: readonly string[] }

/** Local copies of committed pictures get the same hash, structure and budget checks as gateway bytes. */
function localPicture(hash: Hash, url: string | null): VerifiedPicture | null {
  if (!url || url.length > Math.ceil(PICTURE_BUDGET.bytes / 3) * 4 + 64) return null;
  const match = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,([A-Za-z0-9+/=]+)$/.exec(url);
  if (!match?.[1]) return null;
  try { return verifiedBoxPicture(Uint8Array.from(atob(match[1]), (ch) => ch.charCodeAt(0)), hash); }
  catch { return null; }
}

/** From Arweave (pictures/arweave-read.ts), checked there against the same hash: by the hint only, or by the search. */
async function fromArweave(sha256: Hash, hint: string | null, search: boolean): Promise<Found | Withheld | null> {
  const found = await arweavePicture(sha256, { hint, search, ...(fetcher ? { fetcher } : {}) });
  if (found === null || isWithheldResult(found)) return found;
  return { picture: { bytes: found.bytes, type: found.type }, ids: pictureIds(committedPictureId(sha256), ...arweaveIdsOf(found)) };
}

/**
 * The order for one hash: our withheld list first (the picture's own id or an indexer copy of it listed: nothing is
 * asked); the bundle (box 0); then, with Arweave on and a hash the bundle cannot carry, this page's own copy or the
 * indexer's; the source's gateways; and last the Arweave tag search. The first verified answer wins.
 */
async function find(sha256: Hash, gateways: readonly string[], arweave: { readonly hint: string | null } | null, local: string | null): Promise<Found | Withheld | null> {
  const content = pictureIds(committedPictureId(sha256));
  const copies = copyIds(sha256);
  const listed = await withheldVerdict([...content, ...copies]);
  if (listed !== null) return listed;
  const own = localPicture(sha256, local);
  if (own) return { picture: own, ids: content };
  const bundled = await bundledPicture(sha256).catch(() => null);
  if (bundled) return { picture: bundled, ids: content };
  const onArweave = arweave !== null && !mayBeBundled(sha256);
  const hinted = onArweave ? await fromArweave(sha256, arweave.hint, false) : null;
  if (hinted !== null) return hinted;
  const fetched = gateways.length > 0 ? await fetchVerifiedPicture(sha256, gateways, fetcher ?? fetch.bind(globalThis), copies) : null;
  if (fetched !== null) return isWithheldResult(fetched) ? fetched : { picture: fetched, ids: content };
  return onArweave ? fromArweave(sha256, null, true) : null;
}

/**
 * What a lookup's answer leaves for the page: a URL once checked against the list as it is now, or the tile, or nothing
 * (missing). Every settled answer keeps the picture's keys (its bytes' id, the copy that supplied it, and the indexer
 * copies named for it), so a later change of the list can withhold it, a missing one included.
 */
async function settle(sha256: Hash, answer: Found | Withheld | null): Promise<Entry> {
  if (answer !== null && isWithheldResult(answer)) return withheldEntry(answer.keys);
  const ids = pictureIds(...(answer?.ids ?? pictureIds(committedPictureId(sha256))), ...copyIds(sha256));
  const check = await checkWithheld(ids);
  // A list that changed during the lookup can name it by now: withheld then, never missing (no Add picture for it).
  if (check.withheld) return withheldEntry(check.keys);
  if (answer === null) return missingEntry(check.keys);
  return shownEntry(answer.picture, check.keys);
}

/**
 * A verified picture kept for the page, once it decodes (fix round af2, M1): bytes that match the commitment but cannot
 * be drawn are missing like no answer (the URL let go), so the slot shows the other picture or its placeholder.
 */
async function shownEntry(picture: VerifiedPicture, keys: readonly string[]): Promise<Entry> {
  if (inspectBoxPicture(picture.bytes)?.type !== picture.type) return missingEntry(keys);
  const url = urlOf(picture);
  if (await decodes(url, picture)) return { url, pending: false, at: Date.now(), keys, withheld: null };
  revoke(url);
  return missingEntry(keys);
}

function watch(): void {
  if (watching) return;
  watching = true;
  subscribeWithheld(recheck);
}

function load(sha256: Hash, gateways: readonly string[], arweave: { readonly hint: string | null } | null, local: string | null): void {
  watch();
  const hint = arweave?.hint ?? null;
  const named = hint !== null && !mayBeBundled(sha256) && !(copiesByHash.get(sha256)?.has(hint) ?? false);
  if (named) copiesByHash.set(sha256, new Set([...(copiesByHash.get(sha256) ?? []), hint]));
  const known = entries.get(sha256);
  if (known && (known.pending || known.url !== null || known.withheld !== null || Date.now() - known.at < RETRY_MS)) {
    // An answer this page already has: the newly named copy joins its keys (a lookup under way reads them at its end).
    if (named && !known.pending) void adopt(sha256, hint);
    return;
  }
  entries.set(sha256, { url: null, pending: true, at: Date.now(), keys: [], withheld: null });
  void find(sha256, gateways, arweave, local)
    .then((answer) => settle(sha256, answer))
    // A lookup that failed is missing; its keys are the picture's own, so a later list can still withhold it.
    .catch(() => checkWithheld(pictureIds(committedPictureId(sha256), ...copyIds(sha256))).then((check) => (check.withheld ? withheldEntry(check.keys) : missingEntry(check.keys))))
    .then((entry) => {
      entries.set(sha256, entry);
      recheck();
      notify();
    });
}

/**
 * A picture's state on this page: its verified URL, whether the lookup has ended without one (`missing`), or whether
 * our withheld list names it (`withheld`: never fetched, never shown; the page shows the neutral tile instead).
 */
export interface PictureState { readonly url: string | null; readonly missing: boolean; readonly withheld: boolean }
const NOTHING: PictureState = Object.freeze({ url: null, missing: false, withheld: false });
/** The caller's own indexer copy is listed (fix round af2): the tile, whatever the page keeps for the hash. */
const WITHHELD: PictureState = Object.freeze({ url: null, missing: false, withheld: true });
const states = new Map<string, PictureState>();
/** One frozen state per hash and answer, so the store's snapshot is stable between changes. */
function stateOf(key: string | null): PictureState {
  if (key === null) return NOTHING;
  const entry = entries.get(key);
  // A kept or missing picture the list names now is withheld at once, even before the list's listeners have run.
  const named = entry !== undefined && listedNow(entry);
  const url = named ? null : entry?.url ?? null;
  const withheld = named || (entry !== undefined && entry.withheld !== null);
  const missing = entry !== undefined && !entry.pending && url === null && !withheld;
  const cached = states.get(key);
  if (cached && cached.url === url && cached.missing === missing && cached.withheld === withheld) return cached;
  const next = Object.freeze({ url, missing, withheld });
  states.set(key, next);
  return next;
}

/**
 * Whether a committed hash can be looked up on this page at all (a gateway, Arweave, or box 0's bundle): when not, its
 * state stays empty for good (usePictureState asks nothing), and a slot treats it as missing (picture-slot.ts).
 */
export function canLoad(sha256: Hash | null, gateways: readonly string[], arweave: { readonly hint: string | null } | null = null): boolean {
  const hash = sha256 === null ? null : committed(sha256);
  return hash !== null && (gateways.length > 0 || arweave !== null || mayBeBundled(hash));
}

/**
 * The verified picture's state for a committed hash (box 0's bundled hashes need no gateway). It follows our withheld
 * list: a change asks again for what it took off the list. Nothing touches a wallet.
 * Fix round af2: the indexer copy this caller names (its box's own, `arweave.hint`; none for box 0's bundled hashes) is
 * checked here, in render, before a picture the page already keeps for the hash is handed out: while it is checked,
 * nothing (no URL, so no <img> is made, and not missing); listed, withheld. The page's answer adopts it as well (load).
 */
export function usePictureState(sha256: Hash | null, gateways: readonly string[], arweave: { readonly hint: string | null } | null = null, local: string | null = null): PictureState {
  const hash = sha256 === null ? null : committed(sha256);
  const key = canLoad(hash, gateways, arweave) || (hash !== null && local !== null) ? hash : null;
  const gatewayKey = gateways.join(' ');
  const arweaveKey = arweave === null ? null : arweave.hint ?? '';
  const hintId = key !== null && arweave?.hint && !mayBeBundled(key) ? arweavePictureId(arweave.hint) : null;
  const hint = useWithheld(hintId === null ? null : [hintId]);
  const list = useSyncExternalStore(subscribeWithheld, withheldState, withheldState).version;
  useEffect(() => {
    if (key !== null) load(key, gatewayKey === '' ? [] : gatewayKey.split(' '), arweaveKey === null ? null : { hint: arweaveKey === '' ? null : arweaveKey }, local);
  }, [key, gatewayKey, arweaveKey, list, local]);
  const state = useSyncExternalStore(subscribe, () => stateOf(key), () => NOTHING);
  if (hint === 'clear' || state.withheld) return state;
  return hint === 'withheld' ? WITHHELD : NOTHING;
}

/**
 * The verified picture's URL for a committed hash, or null while it loads, without gateways (unless the bundle carries
 * the file), when it does not verify, or when it is withheld (the caller shows its placeholder, or reads
 * usePictureState for the withheld tile). Nothing touches a wallet.
 */
export function useVerifiedPicture(sha256: Hash | null, gateways: readonly string[], arweave: { readonly hint: string | null } | null = null): string | null {
  return usePictureState(sha256, gateways, arweave).url;
}

/**
 * SH-ARWEAVE-PICTURES-WEB: a picture this page has just published to Arweave (Create, or the box page's Add picture):
 * kept as found on Arweave and shown at once wherever its hash is, once its bytes hash to it. False when they do not,
 * and when our withheld list names its bytes or its new copy (SH-WITHHELD-SITE: the tile shows instead).
 */
export async function showPublishedPicture(sha256: Hash, bytes: Uint8Array, id: string): Promise<boolean> {
  const hash = committed(sha256);
  const picture = hash === null ? null : await rememberArweavePicture(hash, bytes, id);
  if (hash === null || picture === null) return false;
  let entry: Entry;
  if (isWithheldResult(picture)) entry = withheldEntry(picture.keys);
  else {
    const check = await checkWithheld(pictureIds(committedPictureId(hash), arweavePictureId(id), ...copyIds(hash)));
    entry = check.withheld ? withheldEntry(check.keys) : await shownEntry(picture, check.keys);
  }
  watch();
  entries.set(hash, entry);
  notify();
  return entry.url !== null;
}

/**
 * Test seam: forget every answer and fetch through `next` (default: the global fetch); decode with `decode` (default:
 * the page's own decoder; a test DOM without decode uses a success double after the shared admission gate).
 */
export function resetPicturesForTests(next: typeof fetch | null = null, decode: PictureDecoder | null = null): void {
  entries.clear();
  states.clear();
  copiesByHash.clear();
  resetArweaveForTests();
  fetcher = next;
  decoder = decode ?? (typeof HTMLImageElement.prototype.decode === 'function' ? browserDecodes : async () => true);
  notify();
}
