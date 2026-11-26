/**
 * SH-258 round 3: the BNB Chain testnet build's burn log (build/bnb-variants.ts takes this file in place of
 * FitBurnLogV2.tsx). It mounts only where core v1 exists (V2BoxPage). Same exports, nothing of box 0.
 */
import type { Fetcher } from '../core-client';
import type { V2Snapshot, V2Source } from './indexer-v2';

export async function loadFitBurnLogV2(): Promise<null> {
  return null;
}

/** The props the original takes (its callers type-check against the original). */
export type FitBurnLogV2Props = { source: V2Source; view: V2Snapshot; fetcher?: Fetcher };

export function FitBurnLogV2(): null {
  return null;
}
