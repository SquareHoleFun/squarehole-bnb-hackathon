/**
 * SH-258 round 3: the BNB Chain testnet build's Safes panel (build/bnb-variants.ts takes this file in place of
 * SafesV2.tsx). It mounts only where box 0 exists (V2BoxPage). Same exports, nothing of box 0.
 */
import type { V2Snapshot, V2Source } from './indexer-v2';

export async function readSafesV2(): Promise<null> {
  return null;
}

/** The props the original takes (its callers type-check against the original). */
export type SafesV2Props = { source: V2Source; view: V2Snapshot; coin?: string };

export function SafesV2(): null {
  return null;
}
