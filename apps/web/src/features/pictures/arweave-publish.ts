/**
 * SH-ARWEAVE-PICTURES-WEB (from the SH-ARWEAVE-PICTURES-SPIKE prototype): a box's logo and cover go from the browser
 * straight to Arweave through ArDrive Turbo's public upload endpoint. No account, no sign-up, no wallet prompt, no cost,
 * and no server of ours in between.
 *
 * - One throwaway Ethereum key per call, made in memory (viem `generatePrivateKey`). It signs that call's items and is
 *   then dropped: never saved, logged, shown or sent. Turbo learns only its public key (the item's owner).
 * - Each item carries the tags the reader searches by: Content-Type (from the bytes' own first bytes), App-Name
 *   "Square Hole", SHA-256 (lower-case hex of the exact bytes, the hash the box commits) and Box-Chain-Id.
 * - Free tier only: an item larger than Turbo's current free size (`GET /info` `freeUploadLimitBytes`, 107,520 bytes on
 *   2026-10-24) is refused before anything is sent, so no payment is ever asked. Create shrinks the logo and cover to
 *   fit before the box is created (`freeFit`, pictures/shrink.ts), so a box never commits a picture it cannot publish.
 * - Each picture is checked against its committed hash and the signed item against its own signature before it is
 *   sent; Turbo's answer must name the id computed here.
 * - SH-WITHHELD-SITE fix round af4 (R77-TAKEDOWN-CREATE): a caller's `refuse` guard (our withheld list as it is then) is
 *   asked right before each upload request; a refusal stops the batch there, and that picture and every later one are
 *   not sent ('withheld'). Bytes already sent cannot be called back.
 */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createEthDataItem, hexOf, itemSize, sha256Of, verifyEthDataItem, type ItemSigner, type Tag } from './ans104-eth';
import { APP_NAME, MAX_PICTURE_BYTES, TURBO_FREE_BYTES, TURBO_UPLOAD_ORIGIN } from './arweave-hosts';
import { pictureType } from './picture-type';

export { APP_NAME, TURBO_FREE_BYTES, TURBO_UPLOAD_ORIGIN };

const UPLOAD_TIMEOUT_MS = 30_000;
const INFO_TIMEOUT_MS = 8_000;
const ARWEAVE_ID = /^[A-Za-z0-9_-]{43}$/;
const HASH = /^0x[0-9a-f]{64}$/i;
const RASTER = /^image\/(?:png|jpeg|gif|webp)$/;
const NO_LEAKS = { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' } as const;

type Hash = `0x${string}`;
export interface PictureToPublish { readonly sha256: Hash; readonly bytes: Uint8Array }
export type PublishFailure = 'mismatch' | 'type' | 'too-large' | 'refused' | 'network' | 'withheld';
export type PublishResult =
  | { readonly sha256: Hash; readonly ok: true; readonly id: string; readonly itemBytes: number; readonly ms: number }
  | { readonly sha256: Hash; readonly ok: false; readonly reason: PublishFailure; readonly itemBytes: number | null };

export interface PublishOptions {
  readonly chainId: number;
  readonly fetcher?: typeof fetch;
  /** Turbo's upload origin (tests: a fake). */
  readonly upload?: string;
  /** Turbo's free size, when the caller already read it (otherwise `freeLimit`). */
  readonly limit?: number;
  /** Test seam: the signer; by default a fresh throwaway key that never leaves this call. */
  readonly signer?: ItemSigner;
  /** Called as each picture settles (the page's "1/2"). */
  readonly onResult?: (result: PublishResult) => void;
  /**
   * SH-WITHHELD-SITE fix round af4: asked right before each upload request, once its picture is checked, signed and
   * verified; true stops the batch: that picture and every later one settle as 'withheld', unsent.
   */
  readonly refuse?: () => Promise<boolean>;
}

/** The four tags of a picture of `type` whose sha256 is `hex` (lower-case, no 0x). */
export function tagsFor(type: string, hex: string, chainId: number): readonly Tag[] {
  return [
    { name: 'Content-Type', value: type },
    { name: 'App-Name', value: APP_NAME },
    { name: 'SHA-256', value: hex.toLowerCase() },
    { name: 'Box-Chain-Id', value: String(chainId) },
  ];
}

/** The four tags every published picture carries, or null when the bytes are not a raster picture. */
export function pictureTags(bytes: Uint8Array, sha256: Hash, chainId: number): readonly Tag[] | null {
  const type = pictureType(bytes);
  return type === null ? null : tagsFor(type, sha256.slice(2), chainId);
}

/** The signed item's size for a picture of `pictureBytes` bytes and `type`: the header and tags are fixed by their lengths. */
export const itemBytesFor = (pictureBytes: number, type: string, chainId: number): number => itemSize(pictureBytes, tagsFor(type, '0'.repeat(64), chainId));

/** Whether a picture of `bytes` bytes and `type` fits the free tier (shrink.ts asks this at each step). */
export type FreeFit = (bytes: number, type: string) => boolean;
/** The free-tier check for `chainId` under Turbo's free size `limit`: the whole item fits, the picture is at most MAX_PICTURE_BYTES. */
export const fitsFree = (chainId: number, limit: number): FreeFit => (bytes, type) =>
  RASTER.test(type) && bytes > 0 && bytes <= MAX_PICTURE_BYTES && itemBytesFor(bytes, type, chainId) <= limit;

/** Turbo's free item size as it states it now, or the 2026-10-24 figure (and `ok` false) when it cannot be read. */
export async function readFreeLimit(fetcher: typeof fetch = fetch, upload = TURBO_UPLOAD_ORIGIN): Promise<{ readonly limit: number; readonly ok: boolean }> {
  try {
    const response = await fetcher(`${upload}/info`, { ...NO_LEAKS, signal: AbortSignal.timeout(INFO_TIMEOUT_MS) });
    if (!response.ok) return { limit: TURBO_FREE_BYTES, ok: false };
    const info = (await response.json()) as { freeUploadLimitBytes?: unknown };
    const limit = info.freeUploadLimitBytes;
    return typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0 && limit <= 10 * 1024 * 1024 ? { limit, ok: true } : { limit: TURBO_FREE_BYTES, ok: false };
  } catch {
    return { limit: TURBO_FREE_BYTES, ok: false };
  }
}

/** Turbo's free size, read once per page load (a failed read falls back to 107,520 and is asked again next time). */
let known: Promise<number> | null = null;
let stated: number | null = null;
export function freeLimit(fetcher?: typeof fetch): Promise<number> {
  if (known) return known;
  const asked = readFreeLimit(fetcher ?? fetch.bind(globalThis)).then(({ limit, ok }) => {
    if (ok) stated = limit;
    else if (known === asked) known = null;
    return limit;
  });
  known = asked;
  return asked;
}
/** Turbo's free size as this page last read it, without asking (the 2026-10-24 figure until it has been read). */
export const knownFreeLimit = (): number => stated ?? TURBO_FREE_BYTES;
/** The free-tier check for `chainId`, with Turbo's free size as it stands now. */
export const freeFit = async (chainId: number, fetcher?: typeof fetch): Promise<FreeFit> => fitsFree(chainId, await freeLimit(fetcher));

/** A throwaway signer: the key exists only inside the returned account's closure. */
const throwawaySigner = (): ItemSigner => privateKeyToAccount(generatePrivateKey());

/**
 * Publishes each picture in order; one that fails is reported and the rest still go, unless `refuse` stops the batch
 * (fix round af4). Never throws.
 */
export async function publishToArweave(pictures: readonly PictureToPublish[], options: PublishOptions): Promise<readonly PublishResult[]> {
  const fetcher = options.fetcher ?? fetch.bind(globalThis);
  const upload = options.upload ?? TURBO_UPLOAD_ORIGIN;
  const limit = options.limit ?? (options.fetcher || options.upload ? (await readFreeLimit(fetcher, upload)).limit : await freeLimit());
  const fits = fitsFree(options.chainId, limit);
  // The throwaway key lives only in this account's closure and goes with it when this call returns.
  const signer = options.signer ?? throwawaySigner();
  const results: PublishResult[] = [];
  const settle = (result: PublishResult) => { results.push(result); options.onResult?.(result); };
  let stopped = false;
  for (const picture of pictures) {
    const sha256 = picture.sha256.toLowerCase() as Hash;
    // A refusal stopped the batch: nothing after it is prepared or sent.
    if (stopped) { settle({ sha256, ok: false, reason: 'withheld', itemBytes: null }); continue; }
    if (!HASH.test(sha256) || `0x${hexOf(await sha256Of(picture.bytes))}` !== sha256) { settle({ sha256, ok: false, reason: 'mismatch', itemBytes: null }); continue; }
    const tags = pictureTags(picture.bytes, sha256, options.chainId);
    if (tags === null) { settle({ sha256, ok: false, reason: 'type', itemBytes: null }); continue; }
    const size = itemSize(picture.bytes.length, tags);
    if (!fits(picture.bytes.length, tags[0]?.value ?? '')) { settle({ sha256, ok: false, reason: 'too-large', itemBytes: size }); continue; }
    const started = Date.now();
    try {
      const item = await createEthDataItem(picture.bytes, tags, signer);
      const own = await verifyEthDataItem(item.bytes);
      if (!own?.valid || own.id !== item.id) { settle({ sha256, ok: false, reason: 'refused', itemBytes: size }); continue; }
      // Fix round af4: the caller's guard, right before this request (the list may have changed since the last one).
      if (options.refuse && (await options.refuse())) { stopped = true; settle({ sha256, ok: false, reason: 'withheld', itemBytes: size }); continue; }
      const response = await fetcher(`${upload}/v1/tx`, {
        ...NO_LEAKS, method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(item.bytes), signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      let answer: unknown = null;
      try { answer = JSON.parse(await response.text()); } catch { answer = null; }
      const id = answer !== null && typeof answer === 'object' && typeof (answer as { id?: unknown }).id === 'string' ? (answer as { id: string }).id : null;
      if (!response.ok || id === null || !ARWEAVE_ID.test(id) || id !== item.id) { settle({ sha256, ok: false, reason: 'refused', itemBytes: size }); continue; }
      settle({ sha256, ok: true, id, itemBytes: size, ms: Date.now() - started });
    } catch {
      settle({ sha256, ok: false, reason: 'network', itemBytes: size });
    }
  }
  return results;
}

/** Test seam: forget Turbo's free size read on this page. */
export function resetFreeLimitForTests(): void { known = null; stated = null; }
