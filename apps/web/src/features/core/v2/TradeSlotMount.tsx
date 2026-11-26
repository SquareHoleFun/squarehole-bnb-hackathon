import { Suspense, lazy } from 'react';
import { PART_WORDS, PartBoundary, PartFailed } from '../../../shell/PartFailed';
import type { BoxRecord } from '../../boxes/box-model';
import type { V2Snapshot, V2Source } from './indexer-v2';

/**
 * F156 (SH-ALPHA-BUILD-SWITCH): what the v2 box page hands the Sepolia alpha's trade slot
 * (features/trade-sepolia/TradeSlot.tsx): the box, its current snapshot and source, and whether actions wait (a stale or
 * unverified read, as for every other action on the page).
 */
export interface TradeSlotProps {
  readonly record: BoxRecord;
  readonly view: V2Snapshot;
  readonly source: V2Source;
  readonly disabled: boolean;
}

/**
 * The trade folders' one door. `import.meta.env.SH_SEPOLIA_TRADE` is a build literal (build-target.ts `sepoliaTradeOf`):
 * `false` in the mainnet build, so this branch and its dynamic import fold away and nothing under
 * features/trade-sepolia enters the bundle; `true` in the Sepolia build (and a dev opt-in), where the slot's own chunk
 * loads once a v2 box page mounts it. No other module of the site imports the trade folders (build-target.test.ts).
 */
const TradeSlot = import.meta.env?.SH_SEPOLIA_TRADE === true ? lazy(() => import('../../trade-sepolia/TradeSlot')) : null;

/** Whether this build carries the trade slot (SH-224: the box page keeps a column for it on a wide screen). */
export const TRADE_IN_BUILD = TradeSlot !== null;

/**
 * The v2 box page's mount for the trade slot: nothing at all unless this build carries the trade code. While the slot's
 * chunk loads, nothing shows (as before); a slot whose chunk fails to load (a dropped connection, an expired Access
 * session, a site update that replaced the file), or that fails while drawing, says so in its place with Reload
 * (SH-246, finding 11.3; before, it showed nothing). The page stays.
 */
export function TradeSlotMount(props: TradeSlotProps) {
  if (TradeSlot === null) return null;
  return <PartBoundary fallback={<PartFailed line={PART_WORDS.part} />}><Suspense fallback={null}><TradeSlot {...props} /></Suspense></PartBoundary>;
}
