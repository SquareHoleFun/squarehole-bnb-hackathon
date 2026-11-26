/**
 * SH-294: a launch's picture read back from its link, the platform's way (copies, each naming its original; the launch
 * stage builds only bounties/):
 * - the bytes: apps/web/src/features/pictures/arweave-read.ts `fetchItem` (the item's own id only, no search): the
 *   site's two raw gateways in turn (`/raw/<id>`), no credentials, no referrer, no redirect followed, a time box per
 *   gateway, read up to a cap, raster only (never an SVG), and shown only when the bytes' SHA-256 is the link's;
 * - the withheld list: apps/web/src/features/pictures/withheld.ts (`/v2/withheld` on the site's own origin, version 1,
 *   keys = SHA-256 of "sh-withheld-v1:" + id; a picture's ids: `ar:<item id>` and `ipfs:<raw CIDv1 of its hash>`).
 *   The list is read before every lookup; a list that cannot be read shows no picture.
 * No link, a link of any other form, a withheld picture or a failed read: no picture, silently (the caller's plain look).
 */
import { useEffect, useState } from 'react';
import { hexOf, sha256Of } from './ans104-eth';
import { ARWEAVE_RAW_GATEWAYS, MAX_PICTURE_BYTES, parsePictureLink, rasterType, type RasterType } from './publish';
import '../../styles/launch-picture.css';

export const WITHHELD_PATH = '/v2/withheld';
const WITHHELD_PREFIX = 'sh-withheld-v1:';
const READ_TIMEOUT_MS = 5_000;
const LIST_TIMEOUT_MS = 5_000;
const MAX_LIST_BYTES = 2 * 1024 * 1024;
const RAW_READ = { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'manual' } as const;

export interface LaunchPictureBytes { readonly bytes: Uint8Array; readonly type: RasterType }

/** The raw CIDv1 (codec raw 0x55, sha2-256) of a SHA-256, base32 lower case with its `b` prefix (withheld.ts ids). */
export function rawCidOf(sha256Hex: string): string {
  const bytes = [0x01, 0x55, 0x12, 0x20, ...(sha256Hex.match(/../g) ?? []).map((h) => parseInt(h, 16))];
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0; let value = 0; let out = 'b';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

async function capped(response: Response, limit: number): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const parts: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel().catch(() => undefined); return null; }
    parts.push(value);
  }
  const out = new Uint8Array(size); let at = 0;
  for (const part of parts) { out.set(part, at); at += part.byteLength; }
  return out;
}

export interface ReadSeams {
  readonly fetcher?: typeof fetch;
  readonly gateways?: readonly string[];
  /** The withheld list's address (default: the site's own /v2/withheld). */
  readonly withheld?: string;
}

/** The withheld keys as the list holds them now, or null when the list cannot be read (then nothing is shown). */
async function withheldKeys(fetcher: typeof fetch, url: string): Promise<ReadonlySet<string> | null> {
  try {
    const response = await fetcher(url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
    if (!response.ok) return null;
    const bytes = await capped(response, MAX_LIST_BYTES);
    if (bytes === null) return null;
    const body = JSON.parse(new TextDecoder().decode(bytes)) as { version?: unknown; hashes?: unknown };
    if (body.version !== 1 || !Array.isArray(body.hashes) || !body.hashes.every((h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h))) return null;
    return new Set(body.hashes as string[]);
  } catch {
    return null;
  }
}
const keyOf = async (id: string) => hexOf(await sha256Of(new TextEncoder().encode(`${WITHHELD_PREFIX}${id}`)));

const kept = new Map<string, LaunchPictureBytes>();

/** Keeps a picture this page just published (its bytes checked against the hash first), so it shows without a read. */
export async function rememberLaunchPicture(link: string, bytes: Uint8Array): Promise<void> {
  const ref = parsePictureLink(link);
  const type = rasterType(bytes);
  if (ref && type && hexOf(await sha256Of(bytes)) === ref.sha256) kept.set(ref.sha256, { bytes: bytes.slice(), type });
}

/** The picture a launch's link names, or null. Never throws. */
export async function readLaunchPicture(link: string | null | undefined, seams: ReadSeams = {}): Promise<LaunchPictureBytes | null> {
  const ref = typeof link === 'string' ? parsePictureLink(link) : null;
  if (!ref) return null;
  const fetcher = seams.fetcher ?? fetch.bind(globalThis);
  const list = await withheldKeys(fetcher, seams.withheld ?? WITHHELD_PATH);
  if (list === null) return null;
  if (list.size > 0) {
    for (const id of [`ar:${ref.id}`, `ipfs:${rawCidOf(ref.sha256)}`]) if (list.has(await keyOf(id))) return null;
  }
  const own = kept.get(ref.sha256);
  if (own) return own;
  for (const gateway of seams.gateways ?? ARWEAVE_RAW_GATEWAYS) {
    try {
      const response = await fetcher(`${gateway}/raw/${ref.id}`, { ...RAW_READ, signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); continue; }
      const bytes = await capped(response, MAX_PICTURE_BYTES);
      const type = bytes ? rasterType(bytes) : null;
      if (bytes && type && hexOf(await sha256Of(bytes)) === ref.sha256) return { bytes, type };
    } catch {
      // the next gateway
    }
  }
  return null;
}

/** A blob: URL of a launch's picture while it is shown, or null (no picture: the caller's plain look). */
export function useLaunchPictureUrl(link: string | null | undefined, seams?: ReadSeams): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true; let made: string | null = null;
    setUrl(null);
    void readLaunchPicture(link, seams).then((picture) => {
      if (!live || !picture) return;
      made = URL.createObjectURL(new Blob([new Uint8Array(picture.bytes)], { type: picture.type }));
      setUrl(made);
    });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
    // The seams are a test's; the link alone decides the picture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link]);
  return url;
}

/** A launch's picture as an <img>, or nothing. */
export function LaunchPictureImg({ link, className, size }: { link: string | null | undefined; className?: string; size: number }) {
  const url = useLaunchPictureUrl(link);
  return url ? <img className={className ?? 'launch-picture'} src={url} alt="" width={size} height={size} data-launch-picture="" /> : null;
}
