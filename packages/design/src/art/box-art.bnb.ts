/**
 * SH-258 round 3: the BNB Chain testnet build's box picture registry (build/bnb-variants.ts takes this file in place of
 * misfits-art.ts). No box on that network uses the bundled box 0 art (only Demo and box 0 records name it). Same exports, nothing of box 0.
 */

export interface BoxArtAsset {
  readonly id: string;
  readonly src: string;
  readonly width: number;
  readonly height: number;
}

export const MISFITS_ART: ReadonlyMap<string, BoxArtAsset> = new Map();

/** No bundled picture: every caller shows its plain glyph. */
export function boxArt(): BoxArtAsset | null {
  return null;
}
