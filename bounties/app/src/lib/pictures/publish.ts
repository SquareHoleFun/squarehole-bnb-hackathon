/**
 * SH-294: a launch's picture, published the platform's Arweave way and named in the launch's own link field.
 *
 * Copies (the launch stage builds only bounties/, test/stage-imports.test.ts), each named:
 * - the hosts and sizes: apps/web/src/features/pictures/arweave-hosts.ts (TURBO_UPLOAD_ORIGIN, ARWEAVE_RAW_GATEWAYS,
 *   ARWEAVE_SEARCH_GATEWAYS, PICTURE_ORIGINS, APP_NAME, TURBO_FREE_BYTES, MAX_PICTURE_BYTES);
 * - the raster check: packages/artwork/src/box-picture.ts `pictureFormat`, its four raster types only (never an SVG);
 * - the free size and the publish: apps/web/src/features/pictures/arweave-publish.ts (`tagsFor`, `fitsFree`,
 *   `readFreeLimit`, `publishToArweave` for one picture, without the withheld guard, which the launch page does not load);
 * - the canvas encoder: apps/web/src/features/create/art-files.ts (`draw`, `blobOf`, `webpEncoder`, BROWSER_ENCODER).
 * One throwaway key per publish, made in memory and dropped: no wallet prompt, no account, no cost (Turbo's free tier).
 *
 * THE LINK'S FORM (both rails): `https://arweave.net/<item id>#sha256=<hex of the exact bytes>`.
 * - Flap: the Portal's `meta` is documented as "The metadata URI of the token"; Flap's own flow is the IPFS CID of a
 *   metadata JSON pinned through Flap's upload API (https://funcs.flap.sh/api/upload), "Our indexer will not be able to
 *   fetch your file if it is not pinned on our gateway" (docs.flap.sh, "Launch token through Portal", read 26 Nov
 *   2026). That needs Flap's own service, so today the field carries a plain https link to the picture instead.
 * - Four.meme's copy (OpenFour): `tokenUri`, a plain link; its signing service takes `https://` or `ipfs://`, printable
 *   ASCII, at most 200 characters (bounties/openfour/sign/sign-create.js `BAD_URI`). This link is 135 characters.
 * The fragment is not sent to any server: anyone loads the picture at the link; the site checks the bytes against it.
 */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createEthDataItem, hexOf, itemSize, sha256Of, verifyEthDataItem, type ItemSigner, type Tag } from './ans104-eth';
import { shrinkPicture, type PictureEncoder, type Shrunk } from './shrink';

export const TURBO_UPLOAD_ORIGIN = 'https://upload.ardrive.io';
export const ARWEAVE_RAW_GATEWAYS: readonly string[] = Object.freeze(['https://turbo-gateway.com', 'https://arweave.net']);
export const ARWEAVE_SEARCH_GATEWAYS: readonly string[] = Object.freeze(['https://turbo-gateway.com', 'https://arweave.net', 'https://goldsky.arweave.net']);
export const PICTURE_ORIGINS: readonly string[] = Object.freeze([TURBO_UPLOAD_ORIGIN, ...new Set([...ARWEAVE_RAW_GATEWAYS, ...ARWEAVE_SEARCH_GATEWAYS])]);
export const APP_NAME = 'Square Hole';
export const TURBO_FREE_BYTES = 107_520;
export const MAX_PICTURE_BYTES = 128 * 1024;

// ------------------------------------------------------------------------------------------------ the raster check

const starts = (b: Uint8Array, sig: readonly number[]) => sig.every((v, i) => b[i] === v);
const ascii = (b: Uint8Array, at: number, n = 4) => String.fromCharCode(...b.subarray(at, at + n));
export type RasterType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
/** The type a picture's first bytes say: PNG, JPEG, GIF or WebP; null for anything else (an SVG included). */
export function rasterType(b: Uint8Array): RasterType | null {
  if (starts(b, [137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
  if (starts(b, [255, 216, 255])) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(ascii(b, 0, 6))) return 'image/gif';
  if (ascii(b, 0) === 'RIFF' && ascii(b, 8) === 'WEBP') return 'image/webp';
  return null;
}

// ------------------------------------------------------------------------------------------------ the link

const ARWEAVE_ID = /^[A-Za-z0-9_-]{43}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** The link a launch carries: `https://arweave.net/<id>#sha256=<hex>`. */
export function pictureLink(id: string, sha256Hex: string): string {
  if (!ARWEAVE_ID.test(id) || !HEX64.test(sha256Hex)) throw new Error('bad picture link');
  return `https://arweave.net/${id}#sha256=${sha256Hex}`;
}
/**
 * A launch's link read back: the item id and the hash, from the form above (on arweave.net or turbo-gateway.com, with
 * or without `/raw/`); null for anything else (any other host, `ipfs://`, a JSON document, no hash): no picture.
 */
export function parsePictureLink(link: string): { readonly id: string; readonly sha256: string } | null {
  const m = /^https:\/\/(?:arweave\.net|turbo-gateway\.com)\/(?:raw\/)?([A-Za-z0-9_-]{43})#sha256=([0-9a-f]{64})$/.exec(link);
  return m && m[1] && m[2] ? { id: m[1], sha256: m[2] } : null;
}

// ------------------------------------------------------------------------------------------------ the free size

const UPLOAD_TIMEOUT_MS = 30_000;
const INFO_TIMEOUT_MS = 8_000;
const NO_LEAKS = { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' } as const;
const RASTER = /^image\/(?:png|jpeg|gif|webp)$/;

export function tagsFor(type: string, hex: string, chainId: number): readonly Tag[] {
  return [
    { name: 'Content-Type', value: type },
    { name: 'App-Name', value: APP_NAME },
    { name: 'SHA-256', value: hex.toLowerCase() },
    { name: 'Box-Chain-Id', value: String(chainId) },
  ];
}
export const itemBytesFor = (pictureBytes: number, type: string, chainId: number): number => itemSize(pictureBytes, tagsFor(type, '0'.repeat(64), chainId));
export const fitsFree = (chainId: number, limit: number) => (bytes: number, type: string): boolean =>
  RASTER.test(type) && bytes > 0 && bytes <= MAX_PICTURE_BYTES && itemBytesFor(bytes, type, chainId) <= limit;

export async function readFreeLimit(fetcher: typeof fetch, upload = TURBO_UPLOAD_ORIGIN): Promise<number> {
  try {
    const response = await fetcher(`${upload}/info`, { ...NO_LEAKS, signal: AbortSignal.timeout(INFO_TIMEOUT_MS) });
    if (!response.ok) return TURBO_FREE_BYTES;
    const limit = ((await response.json()) as { freeUploadLimitBytes?: unknown }).freeUploadLimitBytes;
    return typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0 && limit <= 10 * 1024 * 1024 ? limit : TURBO_FREE_BYTES;
  } catch {
    return TURBO_FREE_BYTES;
  }
}

// ------------------------------------------------------------------------------------------------ the browser encoder

function canvasOf(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}
async function draw(file: Blob, side: number, ground: string | null = null): Promise<HTMLCanvasElement | null> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = canvasOf(width, height);
    const context = canvas.getContext('2d');
    if (!context) return null;
    if (ground !== null) {
      context.fillStyle = ground;
      context.fillRect(0, 0, width, height);
    }
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    return canvas;
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}
const blobOf = (canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> =>
  new Promise((resolve) => { canvas.toBlob((blob) => resolve(blob), type, quality); });
let writesWebp: Promise<boolean> | null = null;
function webpEncoder(): Promise<boolean> {
  writesWebp ??= typeof document === 'undefined'
    ? Promise.resolve(false)
    : blobOf(canvasOf(1, 1), 'image/webp', 0.8).then((blob) => blob?.type === 'image/webp').catch(() => false);
  return writesWebp;
}
export const BROWSER_ENCODER: PictureEncoder<HTMLCanvasElement> = { webp: webpEncoder, draw, encode: (canvas, type, quality) => blobOf(canvas, type, quality) };

// ------------------------------------------------------------------------------------------------ shrink, then publish

export type PicturePublish =
  | { readonly ok: true; readonly link: string; readonly bytes: Uint8Array; readonly type: RasterType }
  | { readonly ok: false; readonly reason: 'shrink'; readonly line: string }
  | { readonly ok: false; readonly reason: 'type' | 'too-large' | 'refused' | 'network' };

export interface PublishSeams {
  readonly chainId: number;
  readonly fetcher?: typeof fetch;
  /** Turbo's upload origin (the stand's stand-in, tests). */
  readonly upload?: string;
  readonly encoder?: PictureEncoder<unknown>;
  readonly signer?: ItemSigner;
}

/** A file shrunk the logo's way to Turbo's free size, published, and its link; never throws. */
export async function publishPicture(file: Blob, seams: PublishSeams): Promise<PicturePublish> {
  const fetcher = seams.fetcher ?? fetch.bind(globalThis);
  const upload = seams.upload ?? TURBO_UPLOAD_ORIGIN;
  const limit = await readFreeLimit(fetcher, upload);
  const fits = fitsFree(seams.chainId, limit);
  const shrunk: Shrunk = await shrinkPicture(file, fits, (seams.encoder ?? BROWSER_ENCODER) as PictureEncoder<unknown>);
  if ('error' in shrunk) return { ok: false, reason: 'shrink', line: shrunk.error };
  const bytes = shrunk.bytes;
  const type = rasterType(bytes);
  if (type === null) return { ok: false, reason: 'type' };
  if (!fits(bytes.length, type)) return { ok: false, reason: 'too-large' };
  const hex = hexOf(await sha256Of(bytes));
  try {
    const signer = seams.signer ?? privateKeyToAccount(generatePrivateKey());
    const item = await createEthDataItem(bytes, tagsFor(type, hex, seams.chainId), signer);
    const own = await verifyEthDataItem(item.bytes);
    if (!own?.valid || own.id !== item.id) return { ok: false, reason: 'refused' };
    const response = await fetcher(`${upload}/v1/tx`, {
      ...NO_LEAKS, method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(item.bytes), signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    let answer: unknown = null;
    try { answer = JSON.parse(await response.text()); } catch { answer = null; }
    const id = answer !== null && typeof answer === 'object' && typeof (answer as { id?: unknown }).id === 'string' ? (answer as { id: string }).id : null;
    if (!response.ok || id === null || !ARWEAVE_ID.test(id) || id !== item.id) return { ok: false, reason: 'refused' };
    return { ok: true, link: pictureLink(id, hex), bytes, type };
  } catch {
    return { ok: false, reason: 'network' };
  }
}
