/**
 * SH-258 round 3: the BNB Chain testnet build's first-generation box page (build/bnb-variants.ts takes this file in place of
 * RowBoxPage.tsx). That network has no core v1 version, so no row record reaches it. Same exports, nothing of box 0.
 */
import type { BoxRecord } from '../boxes/box-model';
import type { CoreBuild } from './core-build';
import type { Fetcher } from './core-client';

export interface RowBoxPageProps {
  readonly record: BoxRecord;
  readonly coreBuild?: CoreBuild;
  readonly fetcher?: Fetcher;
}

export function RowBoxPage(): null {
  return null;
}
