/**
 * What the Fees card (F77) shows of a box's snapshot: ONE rule for the indexer's view and a direct read, so the two
 * agree at the same block (the review of S10a found both short of what the receiver split). Browser-safe, bigint only.
 *
 * Box 0's split (BoxReceiver.sol `_split`, `_settleGraduation`), each part where it is reported:
 * - Q: 11/15 to FIT (`BatchSplit.qFit`; REV-16 returns of FIT's executor's own swap fees go to FIT too), 2/15 into
 *   this pool (`BatchSplit.qDepth`, which after graduation includes the platform's part above the cap), 2/15 to the
 *   platform: held by the receiver until graduation (no BatchSplit field: qFit × 2/11 per batch), then through the cap
 *   at the settlement (`PlatformCredited`: kept for the Safe, and `GraduationSettled.platformToDepth` into this pool);
 *   after graduation `PlatformCredited.kept` per batch. The platform's total is what was kept plus what is held.
 * - T: 2/15 into this pool (`BatchSplit.tDepth`), 13/15 burned (`BatchSplit.tBurned`) before graduation and to the
 *   per-Misfit stream after it (`StreamFunded` / `StreamNotifyFailed`: no BatchSplit field).
 *
 * A direct read gets the same parts from the receiver's own totals (`totals()`, `platformHeld()`, `tBurnPending()`)
 * and the stream's (T held + claimed + burned): its view carries them in the same fields with the event-only ones at 0.
 * A gift to the pool (`fundDepth`) is no fee: the indexer leaves it out, a direct read cannot (`qToDepth` counts it).
 */
import { FEE_SHARE_DENOMINATOR, FEE_SHARE_DEPTH } from '@squarehole/box-spec';
import type { CoreBoxView } from './core-views';

export interface FeeSummary {
  /** Q split so far (every part below). */
  readonly qTotal: bigint;
  /** T split so far. */
  readonly tTotal: bigint;
  /** To FIT (box 0: its 11/15, with REV-16 returns of FIT's executor's own swap fees). */
  readonly qFit: bigint;
  /** Into this pool: the 2/15 and, for box 0, the platform's part above its cap. */
  readonly qDepth: bigint;
  /** The platform's 2/15: kept for the Safe plus held until graduation. */
  readonly qPlatform: bigint;
  /** Of `qPlatform`, held by the receiver until graduation. */
  readonly qPlatformHeld: bigint;
  /** Another box's Q stream share. */
  readonly qReward: bigint;
  readonly tDepth: bigint;
  /** Burned (or waiting to be, when the vault's floor refused a burn). */
  readonly tBurned: bigint;
  /** Box 0 after graduation: to the per-Misfit stream. */
  readonly tToStream: bigint;
  readonly tFit: bigint;
  readonly tReward: bigint;
  /** What the platform kept in the current 30-day epoch (box 0). */
  readonly keptThisEpoch: bigint;
}

/**
 * The Fees card's figures. Another box's T total is its pool share × 15/2: every batch's `tDepth` is exactly 2 of its
 * fifteenths, while its other T fields overlap by its T stream (BURN_T reports the share as both `tReward` and
 * `tBurned`; SELL_FOR_Q after graduation adds it to `tFit`).
 */
export function feeSummary(view: Pick<CoreBoxView, 'fees' | 'platform' | 'row'>): FeeSummary {
  const box0 = view.row.isBox0;
  const f = view.fees;
  const p = view.platform;
  const qFit = BigInt(f.qFit) + BigInt(f.qFitReturned);
  const qDepth = BigInt(f.qDepth) + BigInt(f.qDepthSettled);
  const qPlatformHeld = BigInt(p.held);
  // `credited` already counts every BatchSplit.qPlatform (each comes with its PlatformCredited) and the settlement's.
  const qPlatform = BigInt(p.credited) + qPlatformHeld;
  const qReward = BigInt(f.qReward);
  const tDepth = BigInt(f.tDepth);
  const tBurned = BigInt(f.tBurned);
  const tToStream = BigInt(f.tToStream);
  const tFit = BigInt(f.tFit);
  const tReward = BigInt(f.tReward);
  return {
    qTotal: qFit + qDepth + qPlatform + qReward,
    tTotal: box0 ? tDepth + tBurned + tToStream : (tDepth * FEE_SHARE_DENOMINATOR) / FEE_SHARE_DEPTH,
    qFit,
    qDepth,
    qPlatform,
    qPlatformHeld,
    qReward,
    tDepth,
    tBurned,
    tToStream,
    tFit,
    tReward,
    keptThisEpoch: BigInt(p.keptInEpoch),
  };
}
