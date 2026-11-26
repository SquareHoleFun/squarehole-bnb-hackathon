/**
 * SH-ARWEAVE-PICTURES-WEB: "Add picture" on a v2 box page. Where a box's committed logo or cover is on no gateway (the
 * creator closed the tab before it was published, an upload failed, or a Safe signed the box later on another device),
 * anyone may drop a file. The page publishes it to Arweave only when it IS the committed picture: the bytes it would
 * publish hash, here, to the sha256 the box committed. No wallet, no account, nothing the box does not already commit.
 *
 * The committed picture is the one Create shrank, which is rarely the file the creator still has, so three files are
 * recognised, each ending in the same hash check:
 * 1. the committed picture itself (its exact bytes);
 * 2. the box's BoxSpec file (Download BoxSpec), which carries every committed picture's bytes;
 * 3. the original picture, shrunk again here the way Create shrank it (same browser engine and free size: same bytes).
 */
import { MAX_RAW_BLOCK_BYTES } from '@squarehole/artwork';
import { hexOf, sha256Of } from './ans104-eth';
import { MAX_PICTURE_BYTES } from './arweave-hosts';
import { pictureType } from './picture-type';

type Hash = `0x${string}`;
/** The largest file read at all (a BoxSpec file with item pictures can be large; anything bigger is refused unread). */
export const MAX_DROPPED_BYTES = 64 * 1024 * 1024;
/** The one line a file that is not the box's picture gets (wording for the founder). */
export const NOT_THIS_PICTURE = 'This file is not this box’s picture.';

export interface MatchedPicture { readonly sha256: Hash; readonly bytes: Uint8Array; readonly from: 'file' | 'boxspec' | 'shrunk' }

const sha = async (bytes: Uint8Array): Promise<Hash> => `0x${hexOf(await sha256Of(bytes))}` as Hash;
const fromBase64 = (text: string): Uint8Array | null => {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) return null;
  try { return Uint8Array.from(atob(text), (char) => char.charCodeAt(0)); } catch { return null; }
};

/** The BoxSpec file's pictures that are wanted, as bytes checked against their hash (format squarehole.boxspec/2). */
async function fromBoxSpec(text: string, wanted: ReadonlySet<string>): Promise<MatchedPicture | null> {
  let body: unknown;
  try { body = JSON.parse(text); } catch { return null; }
  const list = body !== null && typeof body === 'object' ? (body as { pictures?: unknown }).pictures : undefined;
  if (!Array.isArray(list)) return null;
  for (const entry of list) {
    const claimed = entry !== null && typeof entry === 'object' ? (entry as { sha256?: unknown }).sha256 : undefined;
    const base64 = entry !== null && typeof entry === 'object' ? (entry as { base64?: unknown }).base64 : undefined;
    if (typeof claimed !== 'string' || !wanted.has(claimed.toLowerCase()) || typeof base64 !== 'string' || base64.length > (MAX_RAW_BLOCK_BYTES * 4) / 3 + 4) continue;
    const bytes = fromBase64(base64);
    if (bytes === null || pictureType(bytes) === null) continue;
    const hash = await sha(bytes);
    if (wanted.has(hash)) return { sha256: hash, bytes, from: 'boxspec' };
  }
  return null;
}

/**
 * The committed picture this file is, or holds, or shrinks to (`reshrink`: Create's own shrinking, or null where the
 * page cannot); null when it is none of the `wanted` hashes.
 */
export async function matchPicture(file: Blob, wanted: readonly string[], reshrink: ((file: Blob) => Promise<Uint8Array | null>) | null): Promise<MatchedPicture | null> {
  const want = new Set(wanted.map((hash) => hash.toLowerCase()));
  if (want.size === 0 || file.size === 0 || file.size > MAX_DROPPED_BYTES) return null;
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const type = pictureType(head);
  if (type !== null && file.size <= MAX_PICTURE_BYTES) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hash = await sha(bytes);
    if (want.has(hash)) return { sha256: hash, bytes, from: 'file' };
  }
  if (type === null && head.some((byte) => byte === 0x7b)) return fromBoxSpec(await file.text(), want);
  if (type !== null && reshrink !== null) {
    const bytes = await reshrink(file).catch(() => null);
    if (bytes !== null && bytes.byteLength > 0) {
      const hash = await sha(bytes);
      if (want.has(hash)) return { sha256: hash, bytes, from: 'shrunk' };
    }
  }
  return null;
}
