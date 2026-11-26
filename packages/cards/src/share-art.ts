/**
 * Card pictures use artwork/box-picture for hash, format, structure and allocation bounds. The page imports that same
 * judge. IPFS and Arweave only discover bytes; neither host's MIME header grants permission to decode them.
 * FIT is the exact bundled public SVG. Admitted pictures reach role selection before rendering.
 */
import { rawCidV1 } from '@squarehole/artwork';
import { inspectBoxPicture, pictureStructure, PICTURE_BUDGET, verifiedBoxPicture, fitPictureBytes, FIT_ICON_SHA256, type BoxPicture, type BoxPictureType } from '@squarehole/artwork/box-picture';
import { originOf } from './origin';

export { originOf };

/** Compatibility exports; all eligibility policy lives in artwork/box-picture. */
export const MAX_LOGO_BYTES = PICTURE_BUDGET.bytes;
export const MAX_LOGO_SIDE = PICTURE_BUDGET.side;
export const MAX_LOGO_PIXELS = PICTURE_BUDGET.pixels;
export type LogoType = BoxPictureType;
export type Logo = BoxPicture;
export interface PixelSize { readonly width: number; readonly height: number }
export function decodedSize(bytes: Uint8Array, type: LogoType): PixelSize | null {
  const info = pictureStructure(bytes);
  return info?.type === type ? { width: info.width, height: info.height } : null;
}
export function logoFits({ bytes, type }: Logo): boolean { return inspectBoxPicture(bytes)?.type === type; }
export const pictureEndsWhole = logoFits;
export function sniffImage(bytes: Uint8Array): LogoType | null { return inspectBoxPicture(bytes)?.type ?? null; }

export async function sha256Of(bytes: Uint8Array): Promise<`0x${string}`> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
  return `0x${Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Gateway origins from configuration (comma-separated): https origins, or http on a loopback address for local testing;
 * no credentials, path, query or fragment. Malformed entries are dropped, at most four are kept.
 */
export function parseGateways(raw: string | undefined): readonly string[] {
  const out: string[] = [];
  for (const entry of (raw ?? '').split(',')) {
    const origin = originOf(entry);
    if (origin !== null && !out.includes(origin)) out.push(origin);
  }
  return out.slice(0, 4);
}

/** Reads a response body up to the cap (null beyond it, without reading the rest). */
async function cappedBody(response: Response, signal: AbortSignal, cap: number = MAX_LOGO_BYTES): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (signal.aborted || declared > cap) { void response.body?.cancel().catch(() => undefined); return null; }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    signal.throwIfAborted();
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  signal.throwIfAborted();
  return bytes;
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

/** The logo the spec commits, from the first gateway that has the right bytes, or null. Never throws. */
export async function loadLogo(sha256: `0x${string}`, gateways: readonly string[], get: (url: string, init?: RequestInit) => Promise<Response>, timeoutMs: number, parent?: AbortSignal): Promise<Logo | null> {
  let cid: string;
  try {
    cid = rawCidV1(sha256);
  } catch {
    return null;
  }
  for (const gateway of gateways) {
    if (parent?.aborted) return null;
    const logo = await withDeadline(async (signal): Promise<Logo | null> => {
      const response = await get(`${gateway}/ipfs/${cid}`, { signal, redirect: 'error', headers: { accept: 'application/vnd.ipld.raw, image/*;q=0.8' } });
      if (!response.ok) { void response.body?.cancel(); return null; }
      const bytes = await cappedBody(response, signal);
      signal.throwIfAborted();
      return bytes === null ? null : verifiedBoxPicture(bytes, sha256);
    }, Math.min(timeoutMs, 3000), parent);
    if (logo !== null) return logo;
  }
  return null;
}

/** Fixed endpoints: index results supply transaction IDs only, never origins or URLs. */
const ARWEAVE_GATEWAYS = ['https://turbo-gateway.com', 'https://arweave.net', 'https://goldsky.arweave.net'] as const;
const ARWEAVE_PAGE_SIZE = 8;
const ARWEAVE_PAGES = 5;
const ARWEAVE_CANDIDATES = 120;
const MAX_INDEX_BYTES = 65_536;
const PICTURE_QUERY = `query Picture($tags: [TagFilter!]!, $after: String) {
  transactions(tags: $tags, sort: HEIGHT_ASC, first: 8, after: $after) { pageInfo { hasNextPage } edges { cursor node { id } } }
}`;
type ArtFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** A deadline includes the body; abort alone cannot bound a fetch implementation that ignores its signal. */
async function withDeadline<T>(work: (signal: AbortSignal) => Promise<T | null>, ms: number, parent?: AbortSignal): Promise<T | null> {
  if (parent?.aborted) return null;
  const controller = new AbortController();
  let stop: () => void = () => undefined;
  const expired = new Promise<null>((resolve) => {
    stop = () => { controller.abort(); resolve(null); };
  });
  const timer = setTimeout(stop, ms);
  parent?.addEventListener('abort', stop, { once: true });
  try {
    return await Promise.race([work(controller.signal).catch(() => null), expired]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', stop);
    controller.abort();
  }
}

/** Reads index JSON or picture bytes with the same redirect, body-size and per-request deadline rules. */
function arweaveBytes(url: string, init: RequestInit, get: ArtFetch, cap: number, parent: AbortSignal): Promise<Uint8Array | null> {
  return withDeadline(async (signal) => {
    const response = await get(url, { ...init, signal, redirect: 'error' });
    if (!response.ok) { void response.body?.cancel().catch(() => undefined); return null; }
    return cappedBody(response, signal, cap);
  }, 1000, parent);
}

const objectOf = (value: unknown): Record<string, unknown> | null => typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;

/** Respect oldest-first ordering, but bound edges, cursors and IDs from untrusted indexes. */
function picturePage(bytes: Uint8Array): { ids: string[]; after: string | null } {
  const result = objectOf(JSON.parse(new TextDecoder().decode(bytes)));
  if (!result || result.errors !== undefined) return { ids: [], after: null };
  const transactions = objectOf(objectOf(result.data)?.transactions);
  const edges = transactions?.edges;
  if (!Array.isArray(edges)) return { ids: [], after: null };
  const bounded = edges.slice(0, ARWEAVE_PAGE_SIZE);
  const cursor = objectOf(bounded.at(-1))?.cursor;
  const after = objectOf(transactions?.pageInfo)?.hasNextPage === true && typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 1024 ? cursor : null;
  const ids = bounded.flatMap((edge: unknown) => {
    const id = objectOf(objectOf(edge)?.node)?.id;
    return typeof id === 'string' && /^[A-Za-z0-9_-]{43}$/.test(id) ? [id] : [];
  });
  return { ids, after };
}

/**
 * A box picture by commitment, preserving IPFS for box 0 and older boxes, then trying Arweave. Tags are discovery
 * hints only: every candidate must hash to the commitment and pass the existing format/decoded-size guard. At most
 * five pages of eight edges per index, 120 distinct IDs total and three raw gateways per ID. The entire Arweave
 * fallback has a 3 s budget, each request (headers and body) at most 1 s. IPFS plus Arweave stays within the old four-gateway allowance (12 s), leaving
 * time to draw the brand fallback inside the service's 15 s wait. Nothing is persisted here; only the existing card
 * cache stores art.
 * Picture admission is shared; rendering outcomes are handled after role selection in the card service.
 */
export async function loadBoxLogo(sha256: `0x${string}`, gateways: readonly string[], get: ArtFetch, timeoutMs: number, parent?: AbortSignal): Promise<Logo | null> {
  if (!/^0x[0-9a-f]{64}$/i.test(sha256) || /^0x0{64}$/i.test(sha256)) return null;
  if (sha256.toLowerCase() === FIT_ICON_SHA256) return verifiedBoxPicture(fitPictureBytes(), sha256);
  const started = Date.now();
  const ipfs = await loadLogo(sha256, gateways.slice(0, 4), get, timeoutMs, parent);
  if (ipfs !== null) return ipfs;
  const remaining = Math.min(timeoutMs, 3000, 12_000 - (Date.now() - started));
  if (remaining <= 0) return null;
  const hash = sha256.toLowerCase();
  return withDeadline(async (signal) => {
    const tried = new Set<string>();
    for (const index of ARWEAVE_GATEWAYS) {
      let after: string | null = null;
      const cursors = new Set<string>();
      for (let page = 0; page < ARWEAVE_PAGES; page++) {
        signal.throwIfAborted();
        const body = JSON.stringify({ query: PICTURE_QUERY, variables: { after, tags: [
          { name: 'App-Name', values: ['Square Hole'] },
          { name: 'SHA-256', values: [hash.slice(2)] },
        ] } });
        const json = await arweaveBytes(`${index}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body }, get, MAX_INDEX_BYTES, signal);
        if (json === null) break;
        let result: ReturnType<typeof picturePage>;
        try { result = picturePage(json); } catch { break; }
        for (const id of result.ids) {
          if (tried.has(id)) continue;
          if (tried.size >= ARWEAVE_CANDIDATES) return null;
          tried.add(id);
          for (const gateway of ARWEAVE_GATEWAYS) {
            signal.throwIfAborted();
            const bytes = await arweaveBytes(`${gateway}/${id}`, { headers: { accept: 'image/*' } }, get, MAX_LOGO_BYTES, signal);
            signal.throwIfAborted();
            const picture = bytes === null ? null : verifiedBoxPicture(bytes, hash);
            if (picture) return picture;
          }
        }
        after = result.after;
        if (!after || cursors.has(after)) break;
        cursors.add(after);
      }
    }
    return null;
  }, remaining, parent);
}
