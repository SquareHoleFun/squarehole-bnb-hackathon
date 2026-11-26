/**
 * Curve state from one √price. The pool has exactly one position (the hook's, FitPoolHook: add, remove and donate
 * revert) with constant liquidity L over [tickLower, tickUpper], so `Swap.sqrtPriceX96` alone fixes every number here:
 * no call per block. All amounts are bigint and rounded DOWN (never overstate), like the domain display rules.
 *
 * - retainedWei: ETH principal the position holds at √P, net of sells; fees excluded (afterSwap moves each swap's
 *   fee out of the position, FitPoolHook.sol:291-316). = getAmount0Delta(√P, √Pu, L, false).
 * - soldRaw: tokens out of the curve at √P. = getAmount1Delta(√P, √Pu, L, false).
 * - leftRaw: tokens the position still holds. = getAmount1Delta(√Pl, √P, L, false).
 * - fillBps: the band (BOX-SYSTEM § 4.1): min(10 000, retained × 10 000 ÷ target), target 4.206980085 ETH.
 * - curveBps: progress to the completion price (√Pl): retained ÷ the full raise. On the rehearsal's curve the raise is
 *   4.216794836692248391 ETH, so the band fills just before the curve ends; on the Misfits curve (F40 L6) the raise is
 *   the target, so the two are the same number.
 */
import { rawQPerRawT, toSignificantDecimal, toDecimalString, rational, type Rational } from '@squarehole/chain';
import type { DecimalAmount } from '@squarehole/domain';
import { BAND_TARGET_WEI, MISFITS_LAUNCH_SHAPE, REHEARSAL_SHAPE, type LaunchShape } from './shape';
import { getAmount0Delta, getAmount1Delta, getSqrtPriceAtTick } from './v4-math';

export interface CurveShape {
  readonly sqrtPriceLowerX96: bigint;
  readonly sqrtPriceUpperX96: bigint;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly liquidity: bigint;
  readonly raiseWei: bigint;
  readonly targetWei: bigint;
  readonly tokensDeposited: bigint;
}

function curveOf(shape: LaunchShape, targetWei: bigint): CurveShape {
  return Object.freeze({
    sqrtPriceLowerX96: shape.sqrtPriceLowerX96,
    sqrtPriceUpperX96: shape.sqrtPriceUpperX96,
    tickLower: shape.tickLower,
    tickUpper: shape.tickUpper,
    liquidity: shape.liquidity,
    raiseWei: shape.curveRaiseWei,
    targetWei,
    tokensDeposited: shape.curveTokensDeposited,
  });
}

/** The live Sepolia rehearsal's curve: the service's default (the only pool it follows today). */
export const REHEARSAL_CURVE: CurveShape = curveOf(REHEARSAL_SHAPE, BAND_TARGET_WEI);

/** The Misfits launch curve (`FitLaunchShape` since F40 L6): its full raise is the target. */
export const MISFITS_CURVE: CurveShape = curveOf(MISFITS_LAUNCH_SHAPE, BAND_TARGET_WEI);

export interface CurvePoint {
  readonly sqrtPriceX96: bigint;
  readonly retainedWei: bigint;
  readonly soldRaw: bigint;
  readonly leftRaw: bigint;
  readonly fillBps: number;
  readonly curveBps: number;
}

function clampSqrt(shape: CurveShape, sqrtPriceX96: bigint): bigint {
  if (sqrtPriceX96 >= shape.sqrtPriceUpperX96) return shape.sqrtPriceUpperX96;
  if (sqrtPriceX96 <= shape.sqrtPriceLowerX96) return shape.sqrtPriceLowerX96;
  return sqrtPriceX96;
}

function bps(part: bigint, whole: bigint): number {
  if (whole <= 0n) throw new RangeError('bps of a non-positive whole');
  const value = (part * 10_000n) / whole;
  return Number(value > 10_000n ? 10_000n : value);
}

/** Every curve number at √P (clamped to the range: above the top nothing is sold, below the bottom all of it). */
export function curvePoint(sqrtPriceX96: bigint, shape: CurveShape = REHEARSAL_CURVE): CurvePoint {
  const p = clampSqrt(shape, sqrtPriceX96);
  const retainedWei = getAmount0Delta(p, shape.sqrtPriceUpperX96, shape.liquidity, false);
  const soldRaw = getAmount1Delta(p, shape.sqrtPriceUpperX96, shape.liquidity, false);
  const leftRaw = getAmount1Delta(shape.sqrtPriceLowerX96, p, shape.liquidity, false);
  return {
    sqrtPriceX96: p,
    retainedWei,
    soldRaw,
    leftRaw,
    fillBps: bps(retainedWei, shape.targetWei),
    curveBps: bps(retainedWei, shape.raiseWei),
  };
}

/** ETH per token at √P (ETH is currency0, both 18 decimals): (2^96 / √P)². */
export function ethPerToken(sqrtPriceX96: bigint): Rational {
  return rawQPerRawT(sqrtPriceX96, false);
}

export function priceDecimal(sqrtPriceX96: bigint, significantDigits = 12): DecimalAmount {
  return toSignificantDecimal(ethPerToken(sqrtPriceX96), significantDigits);
}

/** Raw 18-decimal amount → truncated decimal string. */
export function units18(raw: bigint, fractionDigits = 18): DecimalAmount {
  if (raw < 0n) return `-${toDecimalString(rational(-raw, 10n ** 18n), fractionDigits)}`;
  return toDecimalString(rational(raw, 10n ** 18n), fractionDigits);
}

export interface CurveDrawPoint {
  readonly tick: number;
  readonly retainedWei: bigint;
  readonly soldRaw: bigint;
  readonly priceEthPerToken: DecimalAmount;
}

/**
 * The curve's shape from the contract's constants, for drawing (a line with a marker; never presented as history):
 * `steps + 1` points at ticks tickUpper − i × (range ÷ steps). 32 steps → 840 ticks each, the launch window's grid.
 * The end points use the exact constants.
 */
export function curveDrawPoints(steps = 32, shape: CurveShape = REHEARSAL_CURVE): readonly CurveDrawPoint[] {
  const span = shape.tickUpper - shape.tickLower;
  if (!Number.isInteger(steps) || steps < 1 || span % steps !== 0) throw new RangeError('steps must divide the tick range');
  const stride = span / steps;
  const points: CurveDrawPoint[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const tick = shape.tickUpper - i * stride;
    const sqrt = i === 0 ? shape.sqrtPriceUpperX96 : i === steps ? shape.sqrtPriceLowerX96 : getSqrtPriceAtTick(tick);
    const point = curvePoint(sqrt, shape);
    points.push({ tick, retainedWei: point.retainedWei, soldRaw: point.soldRaw, priceEthPerToken: priceDecimal(sqrt) });
  }
  return points;
}
