/// <reference types="vite/client" />
/**
 * SH-BOX0-ART-TEST-SITE: the public design files the app carries for box 0's pictures, in a chunk of their own
 * (bundled-pictures.ts loads it only when a spec commits one of their hashes). The bytes are inlined, so drawing them
 * asks no server: the SVG as exact shared bytes (`artwork/box-picture`), the PNG as a base64 data URL (`?inline`). Both are public brand
 * art: the FIT token icon (box 0's logo, field 23) and the Misfits collection picture, the Sorter mascot in the box
 * (field 28; "No edition item, Icon or cast piece", docs/design/misfits-v2/banner/final/README.md). No item art here.
 */
import { fitPictureBytes } from '@squarehole/artwork/box-picture';
import misfitsCollectionCover from '../../../../../docs/design/misfits-v2/banner/final/misfits-collection-sorter-1024.png?inline';

export interface BundledPictureFile {
  /** Where the bytes come from in the repository (for the record; nothing reads it). */
  readonly source: string;
  /** The type the file is drawn as; the bytes are this repository's own reviewed file, checked by hash first. */
  readonly type: 'image/svg+xml' | 'image/png';
  /** The file's bytes. */
  bytes(): Uint8Array;
}

function fromDataUrl(url: string): Uint8Array {
  const comma = url.indexOf(',');
  if (!url.startsWith('data:') || comma < 0 || !url.slice(0, comma).endsWith(';base64')) return new Uint8Array();
  const binary = atob(url.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const BUNDLED_PICTURE_FILES: readonly BundledPictureFile[] = Object.freeze([
  { source: 'packages/design/art/fit/fit-icon.svg', type: 'image/svg+xml', bytes: fitPictureBytes },
  { source: 'docs/design/misfits-v2/banner/final/misfits-collection-sorter-1024.png', type: 'image/png', bytes: () => fromDataUrl(misfitsCollectionCover) },
]);
