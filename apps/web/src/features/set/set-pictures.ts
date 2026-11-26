/**
 * SH-EXISTING-NFTS-E08C: an outside item's picture, read defensively (founder default, existing-nfts-e08-plan.md
 * "Defaults applied" 2; design § 5 "Metadata changes").
 *
 * Items are shown by id and collection address; a picture is a bonus, read lazily per item (only rows on screen ask)
 * and never part of a financial path. `tokenURI(id)` is read over the source's RPC; the metadata it names is read only
 * from `ipfs://` (through our own gateways, the source's CORE_ART_GATEWAYS), `ar://` (through the Arweave gateways the
 * site uses) or an inline `data:application/json`; its `image` the same way, or an inline `data:image/…` of at most
 * MAX_DATA_PICTURE_BYTES. Any other location (an https host, javascript:, a blob or file URL) is never fetched: the item
 * shows its id only. Every answer is size-capped and time-boxed, no credentials, referrer or redirect is followed, and
 * only bytes whose first bytes are a raster picture (PNG, JPEG, GIF or WebP: never SVG, whatever the label says) are
 * drawn, through an <img> from a blob made with the sniffed type. Missing, reverting, huge, changing or hostile metadata
 * costs only its picture: nothing here gates an action, and the outside collection's metadata can change at any time.
 *
 * SH-WITHHELD-SITE (F157 (3)): our withheld list (pictures/withheld.ts) is checked before every read of a location that
 * has an id on it (`ipfs:<raw CID>` for a bare raw CID on our gateway, `ar:<transaction id>` for an Arweave location,
 * also the transaction a manifest path starts from): a listed location is never asked and the item shows the neutral
 * tile. Bytes read are checked again by their own id (the raw CID of their SHA-256: these exact bytes wherever they
 * came from, an inline data: picture included) before they show, and every picture kept for the page again whenever
 * the list changes: a listed one turns into the tile without a reload. Only the item's picture: never its id or row.
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { Address } from 'viem';
import { pictureType, type VerifiedPicture } from '../boxes/box-pictures';
import { hexOf, sha256Of } from '../pictures/ans104-eth';
import { ARWEAVE_RAW_GATEWAYS } from '../pictures/arweave-hosts';
import {
  arweavePictureId, checkWithheld, committedPictureId, ipfsPictureId, isWithheldResult, listedKeys, pictureIds, subscribeWithheld, withheldState,
  withheldVerdict, type Withheld,
} from '../pictures/withheld';
import { ERC721_ABI } from './set-calls';
import type { SetReads } from './set-reads';

/** The longest tokenURI looked at (an inline JSON included); a longer one shows the id only. */
export const MAX_TOKEN_URI_CHARS = 64 * 1024;
/** The most metadata bytes read from a gateway or decoded inline. */
export const MAX_METADATA_BYTES = 64 * 1024;
/** The most picture bytes read from a gateway (one raw IPFS block). */
export const MAX_PICTURE_BYTES = 1_048_576;
/** The most picture bytes decoded from an inline data:image. */
export const MAX_DATA_PICTURE_BYTES = 256 * 1024;
/** Each gateway answer must start within this long. */
export const PICTURE_TIMEOUT_MS = 8_000;

export type ItemLocation =
  | { readonly kind: 'ipfs'; readonly path: string }
  | { readonly kind: 'ar'; readonly path: string }
  | { readonly kind: 'data'; readonly mime: string; readonly bytes: Uint8Array };

const IPFS_PATH = /^[A-Za-z0-9]{10,100}(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%-]+)*\/?$/;
const AR_PATH = /^[A-Za-z0-9_-]{43}(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%-]+)*\/?$/;
const DATA = /^data:([a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+)?((?:;[a-z0-9!#$&^_.+-]+=[^;,]*)*)(;base64)?,/i;

function decodeBase64(text: string, cap: number): Uint8Array | null {
  const clean = text.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length > Math.ceil(cap / 3) * 4 + 4) return null;
  try {
    const binary = atob(clean);
    if (binary.length > cap) return null;
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function decodePercent(text: string, cap: number): Uint8Array | null {
  if (text.length > cap * 3) return null;
  try {
    const bytes = new TextEncoder().encode(decodeURIComponent(text));
    return bytes.length > cap ? null : bytes;
  } catch {
    return null;
  }
}

/**
 * Where an item's URI points, when it is one this page may read: ipfs://, ar:// or an inline data: URI of at most `cap`
 * bytes. Null for anything else (https and http hosts, javascript:, blob:, file:, malformed or oversized).
 */
export function locate(uri: unknown, cap: number): ItemLocation | null {
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > MAX_TOKEN_URI_CHARS) return null;
  const text = uri.trim();
  const lower = text.slice(0, 7).toLowerCase();
  if (lower.startsWith('ipfs://')) {
    const path = text.slice(7).replace(/^ipfs\//i, '');
    return IPFS_PATH.test(path) && !path.split('/').some((part) => part === '..' || part === '.') ? { kind: 'ipfs', path } : null;
  }
  if (lower.startsWith('ar://')) {
    const path = text.slice(5);
    return AR_PATH.test(path) && !path.split('/').some((part) => part === '..' || part === '.') ? { kind: 'ar', path } : null;
  }
  const data = DATA.exec(text);
  if (!data) return null;
  const payload = text.slice(data[0].length);
  const bytes = data[3] ? decodeBase64(payload, cap) : decodePercent(payload, cap);
  return bytes ? { kind: 'data', mime: (data[1] ?? 'text/plain').toLowerCase(), bytes } : null;
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

export interface PictureContext {
  /** Our own IPFS gateways (bare origins): none, and an ipfs:// item shows its id only. */
  readonly ipfs: readonly string[];
  readonly arweave: readonly string[];
  readonly fetcher: typeof fetch;
}

/**
 * The first gateway answer of at most `cap` bytes; null when none gives one in time. SH-WITHHELD-SITE fix round af1:
 * the location's withheld ids (`ids`) are checked against the list as it is now right before each gateway's request:
 * listed, the answer is Withheld and no gateway more is asked (a refresh between two gateways stops it there).
 */
async function fetchFrom(urls: readonly string[], cap: number, fetcher: typeof fetch, ids: readonly string[]): Promise<Uint8Array | Withheld | null> {
  for (const url of urls) {
    const listed = await withheldVerdict(ids);
    if (listed !== null) return listed;
    try {
      const reply = await fetcher(url, { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'force-cache', signal: AbortSignal.timeout(PICTURE_TIMEOUT_MS) });
      if (!reply.ok || reply.body === null) continue;
      // A declared length past the cap is not read at all; an undeclared or false one is cut off by readCapped.
      const declared = reply.headers.get('content-length');
      if (declared !== null && /^\d{1,30}$/.test(declared) && BigInt(declared) > BigInt(cap)) continue;
      const bytes = await readCapped(reply.body, cap);
      if (bytes !== null && bytes.byteLength > 0) return bytes;
    } catch {
      // This gateway gave no usable answer: the next one, or the id alone.
    }
  }
  return null;
}

/**
 * An ar:// item on one of the site's Arweave gateways (pictures/arweave-hosts.ts `ARWEAVE_RAW_GATEWAYS`, one list for
 * the whole site): a bare transaction id as `/raw/<id>`, its bytes with no sandbox redirect; one with a path inside a
 * manifest as `/<id>/<path>` (a gateway that redirects it gets no second request: redirects are refused).
 */
const arweaveUrl = (gateway: string, path: string): string => (/^[A-Za-z0-9_-]{43}$/.test(path) ? `${gateway}/raw/${path}` : `${gateway}/${path}`);

/** The bytes a location names, through the allowed gateways only, at most `cap` bytes. */
async function bytesAt(location: ItemLocation, cap: number, ctx: PictureContext): Promise<Uint8Array | Withheld | null> {
  if (location.kind === 'data') return location.bytes;
  const urls = location.kind === 'ipfs' ? ctx.ipfs.map((gateway) => `${gateway}/ipfs/${location.path}`) : ctx.arweave.map((gateway) => arweaveUrl(gateway, location.path));
  return urls.length === 0 ? null : fetchFrom(urls, cap, ctx.fetcher, locationIds(location));
}

/** A raster picture from bytes, by their first bytes only; null for anything else (SVG, HTML, JSON, text). */
function raster(bytes: Uint8Array | null): VerifiedPicture | null {
  if (bytes === null || bytes.byteLength === 0) return null;
  const type = pictureType(bytes);
  return type ? { bytes, type } : null;
}

/** The metadata's picture field: `image`, else `image_url`; never `image_data` (inline markup) or `animation_url`. */
function imageField(text: string): string | null {
  try {
    const json: unknown = JSON.parse(text);
    if (json === null || typeof json !== 'object' || Array.isArray(json)) return null;
    const record = json as Record<string, unknown>;
    const image = typeof record.image === 'string' ? record.image : typeof record.image_url === 'string' ? record.image_url : null;
    return image !== null && image.length <= MAX_TOKEN_URI_CHARS ? image : null;
  } catch {
    return null;
  }
}

/**
 * SH-WITHHELD-SITE: the withheld-list id a location names, if any: a bare canonical raw CID on our gateway (the only
 * IPFS form our node serves, and the only one the list holds), or the Arweave transaction (a manifest path: the
 * transaction it starts from). Inline data has none (its bytes' own id is checked once decoded).
 */
export function locationIds(location: ItemLocation): string[] {
  if (location.kind === 'ipfs') return pictureIds(ipfsPictureId(location.path));
  if (location.kind === 'ar') return pictureIds(arweavePictureId(location.path.slice(0, 43)));
  return [];
}

/** A picture read for an item, with the withheld ids of the locations it was read from. */
export interface ItemPictureFound {
  readonly picture: VerifiedPicture;
  readonly ids: readonly string[];
}
const foundAt = (picture: VerifiedPicture | null, ids: readonly string[]): ItemPictureFound | null => (picture === null ? null : { picture, ids });

/**
 * An item's picture from its tokenURI's value, or null (the id alone): the metadata, then its image, each through the
 * rules above. A tokenURI that names a raster picture directly is that picture. Withheld (nothing more read) when our
 * withheld list names a location, checked right before each of its requests (fetchFrom).
 */
export async function findItemPicture(uri: unknown, ctx: PictureContext): Promise<ItemPictureFound | Withheld | null> {
  const location = locate(uri, MAX_METADATA_BYTES);
  if (location === null) return null;
  if (location.kind === 'data' && !/^(application\/json|text\/plain)$/.test(location.mime)) {
    return location.mime.startsWith('image/') ? foundAt(raster(location.bytes.byteLength <= MAX_DATA_PICTURE_BYTES ? location.bytes : null), []) : null;
  }
  const first = locationIds(location);
  const metadata = await bytesAt(location, Math.max(MAX_METADATA_BYTES, location.kind === 'data' ? 0 : MAX_PICTURE_BYTES), ctx);
  if (metadata === null || isWithheldResult(metadata)) return metadata;
  const direct = raster(metadata);
  if (direct) return { picture: direct, ids: first };
  if (metadata.byteLength > MAX_METADATA_BYTES) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(metadata);
  } catch {
    return null;
  }
  const image = locate(imageField(text), MAX_DATA_PICTURE_BYTES);
  if (image === null) return null;
  if (image.kind === 'data') return image.mime.startsWith('image/') ? foundAt(raster(image.bytes), []) : null;
  const bytes = await bytesAt(image, MAX_PICTURE_BYTES, ctx);
  if (bytes !== null && isWithheldResult(bytes)) return bytes;
  return foundAt(raster(bytes), locationIds(image));
}

/** As findItemPicture, the picture alone: null for none and for a withheld one. */
export async function pictureOfUri(uri: unknown, ctx: PictureContext): Promise<VerifiedPicture | null> {
  const found = await findItemPicture(uri, ctx);
  return found === null || isWithheldResult(found) ? null : found.picture;
}

/** A URL the page draws the verified bytes from: a blob with the sniffed type, or a data URL where there are no blobs. */
function urlOf(picture: VerifiedPicture): string {
  try {
    if (typeof URL.createObjectURL === 'function' && typeof Blob === 'function') return URL.createObjectURL(new Blob([picture.bytes.slice()], { type: picture.type }));
  } catch {
    // No blob URLs here (a test DOM): the data URL below draws the same verified bytes.
  }
  let binary = '';
  for (let i = 0; i < picture.bytes.length; i += 0x8000) binary += String.fromCharCode(...picture.bytes.subarray(i, i + 0x8000));
  return `data:${picture.type};base64,${btoa(binary)}`;
}

/** At most this many items are read at once (a fast scroll queues the rest). */
const PARALLEL = 4;
const RETRY_MS = 60_000;
/** An item's answer: its URL with the withheld keys it was checked with, or the keys that withhold it, or neither. */
type Entry = { readonly url: string | null; readonly pending: boolean; readonly at: number; readonly keys: readonly string[]; readonly withheld: readonly string[] | null };
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const queue: (() => Promise<void>)[] = [];
let running = 0;
let fetcher: typeof fetch | null = null;
let watching = false;
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const withheldEntry = (keys: readonly string[]): Entry => ({ url: null, pending: false, at: Date.now(), keys, withheld: keys });
const noEntry = (): Entry => ({ url: null, pending: false, at: Date.now(), keys: [], withheld: null });

/** SH-WITHHELD-SITE: each change of the list checks every kept picture again (a listed one is let go; one taken off is asked again). */
function recheck(): void {
  let changed = false;
  for (const [key, entry] of entries) {
    if (entry.url !== null && listedKeys(entry.keys)) {
      try { if (entry.url.startsWith('blob:')) URL.revokeObjectURL(entry.url); } catch { /* nothing to let go */ }
      entries.set(key, withheldEntry(entry.keys));
      changed = true;
    } else if (entry.withheld !== null && !listedKeys(entry.withheld)) {
      entries.delete(key);
      changed = true;
    }
  }
  if (changed) notify();
}

/** What an item's read leaves for the page: a URL once its bytes' own id is checked too, or the tile, or the id alone. */
async function settle(found: ItemPictureFound | Withheld | null): Promise<Entry> {
  if (found === null) return noEntry();
  if (isWithheldResult(found)) return withheldEntry(found.keys);
  const content = committedPictureId(`0x${hexOf(await sha256Of(found.picture.bytes))}`);
  const check = await checkWithheld(pictureIds(...found.ids, content));
  return check.withheld ? withheldEntry(check.keys) : { url: urlOf(found.picture), pending: false, at: Date.now(), keys: check.keys, withheld: null };
}

function pump(): void {
  while (running < PARALLEL && queue.length > 0) {
    const job = queue.shift();
    if (!job) break;
    running += 1;
    void job().finally(() => {
      running -= 1;
      pump();
    });
  }
}

/**
 * Reads an item's tokenURI, then its picture; any failure (a revert, a timeout, a refusal above) is the id alone.
 * SH-WITHHELD-SITE: Withheld when our withheld list names a location before it is asked.
 */
export async function readItemPicture(reads: Pick<SetReads, 'read'>, collection: Address, id: bigint, ctx: PictureContext): Promise<ItemPictureFound | Withheld | null> {
  let uri: unknown;
  try {
    uri = await reads.read(collection, ERC721_ABI, 'tokenURI', [id]);
  } catch {
    return null;
  }
  try {
    return await findItemPicture(uri, ctx);
  } catch {
    return null;
  }
}

/** As readItemPicture, the picture alone: null for none and for a withheld one. */
export async function loadItemPicture(reads: Pick<SetReads, 'read'>, collection: Address, id: bigint, ctx: PictureContext): Promise<VerifiedPicture | null> {
  const found = await readItemPicture(reads, collection, id, ctx);
  return found === null || isWithheldResult(found) ? null : found.picture;
}

/** An item's picture on this page: its URL once read and checked, or whether our withheld list names it (the tile). */
export interface ItemPictureState { readonly url: string | null; readonly withheld: boolean }
const NONE: ItemPictureState = Object.freeze({ url: null, withheld: false });
const states = new Map<string, ItemPictureState>();
function stateOf(key: string | null): ItemPictureState {
  if (key === null) return NONE;
  const entry = entries.get(key);
  const listedNow = entry !== undefined && entry.url !== null && listedKeys(entry.keys);
  const url = listedNow ? null : entry?.url ?? null;
  const withheld = listedNow || (entry !== undefined && entry.withheld !== null);
  const cached = states.get(key);
  if (cached && cached.url === url && cached.withheld === withheld) return cached;
  const next = Object.freeze({ url, withheld });
  states.set(key, next);
  return next;
}

/**
 * The item's picture state: its URL once read and checked, else null (its id shows), or withheld (the neutral tile).
 * `reads` null: nothing is read. Answers are kept for the page's life by chain, collection and id; one that gave nothing
 * is asked again after a minute, one taken off the withheld list at its next change.
 */
export function useItemPicture(reads: Pick<SetReads, 'read'> | null, chainId: number, collection: Address, id: bigint, ipfs: readonly string[]): ItemPictureState {
  const key = reads ? `${chainId}:${collection.toLowerCase()}:${id.toString()}` : null;
  const gateways = ipfs.join(' ');
  const list = useSyncExternalStore(subscribeWithheld, withheldState, withheldState).version;
  useEffect(() => {
    if (key === null || reads === null) return;
    if (!watching) {
      watching = true;
      subscribeWithheld(recheck);
    }
    const known = entries.get(key);
    if (known && (known.pending || known.url !== null || known.withheld !== null || Date.now() - known.at < RETRY_MS)) return;
    entries.set(key, { url: null, pending: true, at: Date.now(), keys: [], withheld: null });
    const ctx: PictureContext = { ipfs: gateways === '' ? [] : gateways.split(' '), arweave: ARWEAVE_RAW_GATEWAYS, fetcher: fetcher ?? fetch.bind(globalThis) };
    queue.push(async () => {
      const entry = await readItemPicture(reads, collection, id, ctx).then(settle).catch(noEntry);
      entries.set(key, entry);
      notify();
    });
    pump();
  }, [key, reads, collection, id, gateways, list]);
  return useSyncExternalStore(subscribe, () => stateOf(key), () => NONE);
}

/** Test seam: forget every answer and fetch through `next` (default: the global fetch). */
export function resetItemPicturesForTests(next: typeof fetch | null = null): void {
  entries.clear();
  states.clear();
  queue.length = 0;
  fetcher = next;
  notify();
}
