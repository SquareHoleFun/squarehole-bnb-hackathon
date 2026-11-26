/**
 * SH-258 round 3: the BNB Chain testnet build's bundled picture files (build/bnb-variants.ts takes this file in place of
 * bundled-picture-files.ts). Only box 0's spec commits these files; there is no box 0 there. Same exports, nothing of box 0.
 */

export interface BundledPictureFile {
  readonly source: string;
  readonly type: 'image/svg+xml' | 'image/png';
  bytes(): Uint8Array;
}

export const BUNDLED_PICTURE_FILES: readonly BundledPictureFile[] = Object.freeze([]);
