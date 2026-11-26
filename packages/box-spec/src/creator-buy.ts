/**
 * What a creator's first tokens come to (launch pipeline v1 § 3.2 "Creator buy", F61 O2, BC-117): `createBox` runs the
 * bootstrap buy and then one untaxed exact-input buy of `creatorBuy` Q from the curve's start, each paying the 1% pool
 * fee (LP_FEE), inside the one curve range. This is the Uniswap v4 swap step for a single range (SwapMath
 * `computeSwapStep` with SqrtPriceMath `getNextSqrtPriceFromInput`), bigint only, so the creation page and the box page
 * can show "≈ 13% of KITE" next to the number. An estimate for display: the factory's own swap is the truth (S4, S11).
 */
import { BOOTSTRAP_ETH, ISSUANCE, LP_FEE } from './generated/box-spec.v1';
import type { BoxCurve } from './layout';
import { getAmount0Delta, getAmount1Delta, Q96 } from './v4-math';

const MAX_FEE_PIPS = 1_000_000n;

const divUp = (a: bigint, b: bigint): bigint => (a % b === 0n ? a / b : a / b + 1n);

/** SqrtPriceMath.getNextSqrtPriceFromInput for one range (Q in pushes the price toward the graduation edge). */
function nextSqrtPrice(c: BoxCurve, sqrtPriceX96: bigint, qInLessFee: bigint): bigint {
  if (qInLessFee === 0n) return sqrtPriceX96;
  const l = c.liquidity;
  if (c.tIsCurrency0) {
    // Q is currency1: oneForZero, the price rises (getNextSqrtPriceFromAmount1RoundingDown, add).
    return sqrtPriceX96 + (qInLessFee * Q96) / l;
  }
  // Q is currency0 (native ETH always is): zeroForOne, the price falls (getNextSqrtPriceFromAmount0RoundingUp, add).
  const numerator1 = l << 96n;
  return divUp(numerator1 * sqrtPriceX96, numerator1 + qInLessFee * sqrtPriceX96);
}

export interface CurveBuyStep {
  /** T received, raw. */
  readonly tOut: bigint;
  /** The pool's sqrt price after the buy. */
  readonly sqrtPriceX96: bigint;
}

/**
 * One exact-input buy of `qIn` Q at `sqrtPriceX96` on the curve: the 1% pool fee comes off the input first, then the
 * rest moves the price. Refused when it would leave the curve range (a buy below the raise never does, § 3.2).
 */
export function curveBuyStep(c: BoxCurve, sqrtPriceX96: bigint, qIn: bigint): CurveBuyStep {
  if (qIn < 0n) throw new Error('qIn must not be negative');
  const lessFee = (qIn * (MAX_FEE_PIPS - BigInt(LP_FEE))) / MAX_FEE_PIPS;
  const next = nextSqrtPrice(c, sqrtPriceX96, lessFee);
  const past = c.tIsCurrency0 ? next > c.sqrtPriceEndX96 : next < c.sqrtPriceEndX96;
  if (past) throw new Error('the buy would leave the curve range');
  const tOut = c.tIsCurrency0 ? getAmount0Delta(sqrtPriceX96, next, c.liquidity, false) : getAmount1Delta(next, sqrtPriceX96, c.liquidity, false);
  return { tOut, sqrtPriceX96: next };
}

/** T a creator buy of `qIn` receives at creation: after the bootstrap buy, from the curve's start, net of the 1% fee. */
export function curveBuyOut(c: BoxCurve, qIn: bigint, bootstrap: bigint = BOOTSTRAP_ETH): bigint {
  if (qIn === 0n) return 0n;
  const afterBootstrap = curveBuyStep(c, c.sqrtPriceStartX96, bootstrap);
  return curveBuyStep(c, afterBootstrap.sqrtPriceX96, qIn).tOut;
}

/** A raw T amount as basis points of the fixed issuance (1e27 raw T per box), truncated. */
export function issuanceBps(tRaw: bigint): bigint {
  return (tRaw * 10_000n) / ISSUANCE;
}
