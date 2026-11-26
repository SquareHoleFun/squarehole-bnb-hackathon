/**
 * SH-251: the picture's model of a trade fee, for "What happens": the fee cut into fifteenths with the plain path's
 * carry. Bigint only. It claims no more than that.
 *
 * What it follows: `ReceiverBooksV21._splitSource` (packages/contracts/src/box-v2/libraries/ReceiverBooksV21.sol, lines
 * 287 to 297 and 298 to 322) on the path where `hasSources` (lines 215 to 218) is false: the side's fee and that side's
 * carried remainder are cut into fifteenths; 2 go to the FIT Safe, 1 to the platform Safe, 2 to the box's pool and 10
 * to the side's own choice; what does not divide by 15 is carried to the same side's next fee. Every trade pays 1%
 * (`LP_FEE`, the release's fee in pips of 1,000,000). The picture shows the FIT and platform parts as one, Square Hole's
 * 3, as the explainer's fee map does.
 *
 * NOT modelled (a design-time picture has neither the collector nor the batch nor the pool):
 * - the collection tip, in EVERY box: before the buyers' fees are split, whoever collects them may take up to 5%
 *   (`TIP_BPS`), capped (`TIP_MAX_Q`), when a collector is named and the amount is at least `BATCH_MIN_Q`. A box without
 *   sources tips the collected buyers' fees (BoxReceiverV2.sol `_collectFees`, lines 130 to 135); a box with sources
 *   (`hasSources`: To holders in the price coin or the box coin on either side, Into the shop, a side paying items)
 *   tips each buyers' batch (ReceiverBooksV21.sol lines 262 to 273, 422 to 426). Sellers' fees are never tipped. This
 *   model shows the fifteenths before the tip, for every box;
 * - boxes with sources only: their remainder is not carried but leaves to the hook (ReceiverBooksV21.sol lines 293 to
 *   297);
 * - sellers' fees: they are paid in the box's token, burned until graduation, and after it sold for the price coin in
 *   the box's own pool before they are split; this model treats them as 1% of the trade in the price coin;
 * - the trade itself: a fixed amount, after graduation, with no curve and no price move.
 * Nothing here sends, reads or asks anything.
 */
import { LP_FEE } from '@squarehole/box-spec';

/** The trade fee in pips (the release's `LP_FEE`, 10,000 of 1,000,000: 1%). */
export const FEE_PIPS = BigInt(LP_FEE);
export const PIPS = 1_000_000n;
export const PARTS = 15n;
export const PICK_PARTS = 10n;
export const POOL_PARTS = 2n;
export const FIT_PARTS = 2n;
export const PLATFORM_PARTS = 1n;
/** Square Hole's parts as the picture shows them: the FIT Safe's and the platform Safe's together. */
export const SQUARE_HOLE_PARTS = FIT_PARTS + PLATFORM_PARTS;

export type FeeSide = 'buyers' | 'sellers';

export interface FeeSplit {
  /** The 10 parts for the side's own choice. */
  readonly pick: bigint;
  /** The 2 parts for the box's pool. */
  readonly pool: bigint;
  /** The 2 parts for the FIT Safe. */
  readonly fit: bigint;
  /** The 1 part for the platform Safe. */
  readonly platform: bigint;
  /** What is left for the side's next fee (0 to 14). */
  readonly carry: bigint;
}

/** One side's fee with that side's carry, cut into fifteenths as `_splitSource` cuts it without sources. */
export function splitFifteenths(fee: bigint, carry: bigint): FeeSplit {
  if (fee < 0n || carry < 0n) throw new RangeError('fee and carry are never negative');
  const total = fee + carry;
  const unit = total / PARTS;
  return { pick: PICK_PARTS * unit, pool: POOL_PARTS * unit, fit: FIT_PARTS * unit, platform: PLATFORM_PARTS * unit, carry: total % PARTS };
}

/** The 1% fee of a trade's amount, rounded down. */
export const feeOf = (amount: bigint): bigint => (amount * FEE_PIPS) / PIPS;

/** The running totals of a run of made-up trades in the fifteenths model, each side with its own carry. */
export interface SimTotals {
  readonly traded: bigint;
  readonly fees: bigint;
  readonly buyers: bigint;
  readonly sellers: bigint;
  readonly pool: bigint;
  readonly squareHole: bigint;
  readonly carry: { readonly buyers: bigint; readonly sellers: bigint };
  readonly trades: number;
}

export const NO_TRADES: SimTotals = Object.freeze({ traded: 0n, fees: 0n, buyers: 0n, sellers: 0n, pool: 0n, squareHole: 0n, carry: Object.freeze({ buyers: 0n, sellers: 0n }), trades: 0 });

/** The totals after one more made-up trade of `amount` on `side` (the fifteenths model above). */
export function addTrade(totals: SimTotals, side: FeeSide, amount: bigint): SimTotals {
  const fee = feeOf(amount);
  const split = splitFifteenths(fee, totals.carry[side]);
  return {
    traded: totals.traded + amount,
    fees: totals.fees + fee,
    buyers: totals.buyers + (side === 'buyers' ? split.pick : 0n),
    sellers: totals.sellers + (side === 'sellers' ? split.pick : 0n),
    pool: totals.pool + split.pool,
    squareHole: totals.squareHole + split.fit + split.platform,
    carry: { ...totals.carry, [side]: split.carry },
    trades: totals.trades + 1,
  };
}

/** "100 trades": 50 buys and 50 sells, alternating, buys first. */
export const HUNDRED_TRADES: readonly FeeSide[] = Object.freeze(Array.from({ length: 100 }, (_, i): FeeSide => (i % 2 === 0 ? 'buyers' : 'sellers')));
