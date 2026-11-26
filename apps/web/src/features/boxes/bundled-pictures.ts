/**
 * SH-BOX0-ART-TEST-SITE: box 0's committed pictures from the app's own bundle. Box 0's spec commits the FIT token icon
 * (an SVG, field 23) and the Misfits collection picture (a PNG, field 28) by sha256. Our node's picture route serves
 * raster blocks only and refuses SVG on purpose (infra/server/ipfs/gateway.mjs), so the logo can never come from it.
 * The app carries both public files instead and draws one only when the sha256 of the bytes it carries equals the
 * spec's commitment: no request to any gateway, and the SVG only ever as an <img> source (a blob or data URL), where it
 * cannot run script or load anything. Anything else (a hash the bundle does not carry, or bytes that do not hash to it)
 * goes the gateway way of box-pictures.ts, or shows the placeholder.
 *
 * `BUNDLED_PICTURE_HASHES` is the small index the main chunk holds; the files load from their own chunk on first use.
 */
import { sha256Hex } from '@squarehole/artwork';
import { FIT_ICON_SHA256 } from '@squarehole/artwork/box-picture';
export { FIT_ICON_SHA256 } from '@squarehole/artwork/box-picture';
import type { BundledPictureFile } from './bundled-picture-files';

type Hash = `0x${string}`;

/** The Misfits collection picture, docs/design/misfits-v2/banner/final/misfits-collection-sorter-1024.png. */
export const MISFITS_COLLECTION_COVER_SHA256: Hash = '0x41cf86fd8bf4bf185534477e35ca01b8183316adc947a92f9c3d8933a90f11fb';

/** The hashes the bundle carries a file for (a lookup only: the bytes are hashed again before they are drawn). */
export const BUNDLED_PICTURE_HASHES: ReadonlySet<string> = new Set([FIT_ICON_SHA256, MISFITS_COLLECTION_COVER_SHA256]);

export interface BundledPicture {
  readonly bytes: Uint8Array;
  readonly type: string;
}

/** The first file whose bytes hash to `sha256`, or null: the one equality that lets a bundled file be drawn. */
export function matchBundled(sha256: string, files: readonly BundledPictureFile[]): BundledPicture | null {
  const expected = sha256.toLowerCase();
  for (const file of files) {
    const bytes = file.bytes();
    if (bytes.byteLength > 0 && sha256Hex(bytes).toLowerCase() === expected) return { bytes, type: file.type };
  }
  return null;
}

let files: Promise<readonly BundledPictureFile[]> | null = null;

/** Whether the bundle carries a file for this hash (nothing is read). */
export const mayBeBundled = (sha256: string): boolean => BUNDLED_PICTURE_HASHES.has(sha256.toLowerCase());

/** The committed picture from the bundle when it carries one that hashes to `sha256`; null otherwise. */
export async function bundledPicture(sha256: string): Promise<BundledPicture | null> {
  if (!mayBeBundled(sha256)) return null;
  const list = await (files ??= import('./bundled-picture-files').then((m) => m.BUNDLED_PICTURE_FILES));
  return matchBundled(sha256, list);
}
