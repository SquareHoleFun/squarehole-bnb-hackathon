/**
 * SH-258 round 3: the BNB Chain testnet build's hidden-draw panel (build/bnb-variants.ts takes this file in place of
 * HiddenDrawsV2.tsx). Draws are off there (the profile's draws switch; V2BoxPage does not mount it). Same exports, nothing of box 0.
 */
import type { V2Snapshot, V2Source } from './indexer-v2';

export const REVEAL_FILE_LINE = 'Your reveal file proves each item. Load it to open drawn items.';

export interface HiddenDrawsV2Props {
  readonly view: V2Snapshot;
  readonly source: V2Source;
  readonly ticker: string;
  readonly disabled: boolean;
}

export function HiddenDrawsV2(): null {
  return null;
}
