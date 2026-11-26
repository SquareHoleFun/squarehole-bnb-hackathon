/**
 * The layout library's TypeScript mirror (launch pipeline v1 § 1, layout CURVE_V1, slice S1): a line-for-line port of
 * packages/contracts/src/box/BoxLayoutV1.sol, with the same fixed values (generated from box-spec.v1.json). The three
 * implementations (Solidity, this file, packages/contracts/script-py/launch_shape.py) are compared on the shared vectors
 * packages/contracts/test/vectors/box-spec/layout-v1.json (BC-002, BC-003). bigint only.
 */
import {
  BID_SHARE_PERCENT,
  CURVE_SHARE_TARGET,
  CURVE_SPAN_TICKS,
  GradLayout,
  ISSUANCE,
  MAX_USABLE_TICK,
  MIN_USABLE_TICK,
  TICK_SPACING,
} from './generated/box-spec.v1';
import {
  getAmount0Delta,
  getAmount1Delta,
  getLiquidityForAmount0,
  getLiquidityForAmount1,
  getSqrtPriceAtTick,
  getTickAtSqrtPrice,
  isqrt,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  mulDiv,
} from './v4-math';

export interface BoxCurve {
  readonly tIsCurrency0: boolean;
  readonly raise: bigint;
  readonly tickLower: number;
  readonly tickUpper: number;
  /** The cheapest-T edge, where the curve starts (P0). */
  readonly tickStart: number;
  /** The graduation edge (P1). */
  readonly tickEnd: number;
  readonly sqrtPriceLowerX96: bigint;
  readonly sqrtPriceUpperX96: bigint;
  readonly sqrtPriceStartX96: bigint;
  readonly sqrtPriceEndX96: bigint;
  readonly liquidity: bigint;
  readonly curveT: bigint;
  readonly poolShare: bigint;
}

export interface LayoutPosition {
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly liquidity: bigint;
  /** What adding it takes: Q for the bid and the sentinel, T for the ask. */
  readonly amount: bigint;
}

export interface GraduatedLayout {
  readonly gradLayout: number;
  readonly bid: LayoutPosition;
  readonly sentinel: LayoutPosition;
  readonly ask: LayoutPosition;
  readonly qDust: bigint;
  readonly tDust: bigint;
}

const U128_MAX = (1n << 128n) - 1n;

/** Pool order: T is currency0 when its address sorts below Q's (native ETH, the zero address, is always currency0). */
export function tIsCurrency0(t: string, q: string): boolean {
  return BigInt(t) < BigInt(q);
}

/** BoxLayoutV1.centreTick: the 80% price's tick, rounded to the nearest multiple of 60 (ties up). */
export function centreTick(raise: bigint, tIsC0: boolean): number {
  const ratioX192 = tIsC0 ? mulDiv(raise, 1n << 192n, CURVE_SHARE_TARGET) : mulDiv(CURVE_SHARE_TARGET, 1n << 192n, raise);
  const sqrtPriceX96 = isqrt(ratioX192);
  if (sqrtPriceX96 < MIN_SQRT_PRICE || sqrtPriceX96 >= MAX_SQRT_PRICE) throw new Error(`CentreOutOfRange(${sqrtPriceX96})`);
  const tick = getTickAtSqrtPrice(sqrtPriceX96);
  let remainder = tick % TICK_SPACING;
  if (remainder < 0) remainder += TICK_SPACING;
  const below = tick - remainder;
  return remainder >= TICK_SPACING / 2 ? below + TICK_SPACING : below;
}

const qAmount = (a: bigint, b: bigint, l: bigint, up: boolean, tIsC0: boolean) =>
  tIsC0 ? getAmount1Delta(a, b, l, up) : getAmount0Delta(a, b, l, up);
const tAmount = (a: bigint, b: bigint, l: bigint, up: boolean, tIsC0: boolean) =>
  tIsC0 ? getAmount0Delta(a, b, l, up) : getAmount1Delta(a, b, l, up);
const tLiquidity = (a: bigint, b: bigint, amount: bigint, tIsC0: boolean) =>
  tIsC0 ? getLiquidityForAmount0(a, b, amount) : getLiquidityForAmount1(a, b, amount);
const ordered = (a: number, b: number): [number, number] => (a < b ? [a, b] : [b, a]);

/** BoxLayoutV1._smallestLiquidity: the least L below 2^128 whose fully crossed range holds exactly `raise` Q. */
function smallestLiquidity(a: bigint, b: bigint, raise: bigint, tIsC0: boolean): bigint {
  let lo = 0n;
  let hi = 1n << 128n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1n;
    if (qAmount(a, b, mid, false, tIsC0) >= raise) hi = mid;
    else lo = mid + 1n;
  }
  if (lo >> 128n !== 0n || qAmount(a, b, lo, false, tIsC0) !== raise) throw new Error(`NoExactLiquidity(${raise})`);
  return lo;
}

/** BoxLayoutV1.curve: the curve for `raise` (Q raw units) and the pool order. */
export function boxCurve(raise: bigint, tIsC0: boolean): BoxCurve {
  if (raise === 0n) throw new Error('RaiseIsZero');
  const centre = centreTick(raise, tIsC0);
  const half = CURVE_SPAN_TICKS / 2;
  const tickLower = centre - half;
  const tickUpper = centre + half;
  if (tickLower < MIN_USABLE_TICK || tickUpper > MAX_USABLE_TICK) throw new Error(`CurveOutOfRange(${tickLower}, ${tickUpper})`);
  const sqrtPriceLowerX96 = getSqrtPriceAtTick(tickLower);
  const sqrtPriceUpperX96 = getSqrtPriceAtTick(tickUpper);
  const liquidity = smallestLiquidity(sqrtPriceLowerX96, sqrtPriceUpperX96, raise, tIsC0);
  const curveT = tAmount(sqrtPriceLowerX96, sqrtPriceUpperX96, liquidity, true, tIsC0);
  if (curveT >= ISSUANCE) throw new Error(`CurveTooLarge(${curveT})`);
  const [tickStart, tickEnd] = tIsC0 ? [tickLower, tickUpper] : [tickUpper, tickLower];
  const [sqrtPriceStartX96, sqrtPriceEndX96] = tIsC0
    ? [sqrtPriceLowerX96, sqrtPriceUpperX96]
    : [sqrtPriceUpperX96, sqrtPriceLowerX96];
  return {
    tIsCurrency0: tIsC0,
    raise,
    tickLower,
    tickUpper,
    tickStart,
    tickEnd,
    sqrtPriceLowerX96,
    sqrtPriceUpperX96,
    sqrtPriceStartX96,
    sqrtPriceEndX96,
    liquidity,
    curveT,
    poolShare: ISSUANCE - curveT,
  };
}

function qPosition(
  tickA: number,
  tickB: number,
  sqrtA: bigint,
  sqrtB: bigint,
  tIsC0: boolean,
  budget: bigint,
  maxLiquidity: bigint,
): LayoutPosition {
  const [tickLower, tickUpper] = ordered(tickA, tickB);
  const l = tIsC0 ? getLiquidityForAmount1(sqrtA, sqrtB, budget) : getLiquidityForAmount0(sqrtA, sqrtB, budget);
  const liquidity = l < maxLiquidity ? l : maxLiquidity;
  return { tickLower, tickUpper, liquidity, amount: qAmount(sqrtA, sqrtB, liquidity, true, tIsC0) };
}

/** BoxLayoutV1.graduated: the graduated layout at exactly P1 for a curve holding `qHeld` Q and `tAvailable` T. */
export function boxGraduated(c: BoxCurve, gradLayout: number, qHeld: bigint, tAvailable: bigint): GraduatedLayout {
  const tIsC0 = c.tIsCurrency0;
  const qEdge = tIsC0 ? MIN_USABLE_TICK : MAX_USABLE_TICK;
  const tEdge = tIsC0 ? MAX_USABLE_TICK : MIN_USABLE_TICK;
  const sqrtQEdge = getSqrtPriceAtTick(qEdge);
  const sqrtTEdge = getSqrtPriceAtTick(tEdge);
  let bid: LayoutPosition;
  if (gradLayout === GradLayout.B_PRIME) {
    bid = qPosition(c.tickEnd, c.tickStart, c.sqrtPriceEndX96, c.sqrtPriceStartX96, tIsC0, (qHeld * BID_SHARE_PERCENT) / 100n, U128_MAX);
  } else if (gradLayout === GradLayout.ASK_FULL_BID_SENTINEL) {
    const askLiquidity = tLiquidity(sqrtTEdge, c.sqrtPriceEndX96, tAvailable, tIsC0);
    bid = qPosition(c.tickEnd, qEdge, c.sqrtPriceEndX96, sqrtQEdge, tIsC0, qHeld, askLiquidity);
  } else {
    throw new Error(`UnknownGradLayout(${gradLayout})`);
  }
  const sentinel = qPosition(c.tickStart, qEdge, c.sqrtPriceStartX96, sqrtQEdge, tIsC0, qHeld - bid.amount, U128_MAX);
  const askLiquidity = tLiquidity(sqrtTEdge, c.sqrtPriceEndX96, tAvailable, tIsC0);
  const [askLower, askUpper] = ordered(c.tickEnd, tEdge);
  const ask: LayoutPosition = {
    tickLower: askLower,
    tickUpper: askUpper,
    liquidity: askLiquidity,
    amount: tAmount(sqrtTEdge, c.sqrtPriceEndX96, askLiquidity, true, tIsC0),
  };
  return {
    gradLayout,
    bid,
    sentinel,
    ask,
    qDust: qHeld - bid.amount - sentinel.amount,
    tDust: tAvailable - ask.amount,
  };
}
