/**
 * Exact bigint ports of the Uniswap v4-core math this service needs (lib/v4-core/src/libraries: FullMath,
 * UnsafeMath, TickMath.getSqrtPriceAtTick, SqrtPriceMath, SwapMath.computeSwapStep). Same rounding as the Solidity,
 * checked in `v4-math.test.ts` against the launch shape's constants (which forge recomputes from the pinned library)
 * and against the live Sepolia bootstrap swap. No float anywhere.
 */
export const Q96 = 1n << 96n;
export const Q128 = 1n << 128n;
const UINT256_MAX = (1n << 256n) - 1n;
const UINT160_MAX = (1n << 160n) - 1n;
export const MAX_TICK = 887_272;
export const MAX_SWAP_FEE = 1_000_000n;

/** FullMath.mulDiv: floor(a × b ÷ d); reverts (throws) when the result does not fit 256 bits. */
export function mulDiv(a: bigint, b: bigint, d: bigint): bigint {
  if (d <= 0n) throw new RangeError('mulDiv: denominator must be positive');
  const result = (a * b) / d;
  if (result > UINT256_MAX) throw new RangeError('mulDiv: overflow');
  return result;
}

/** FullMath.mulDivRoundingUp. */
export function mulDivRoundingUp(a: bigint, b: bigint, d: bigint): bigint {
  const result = mulDiv(a, b, d);
  return (a * b) % d > 0n ? result + 1n : result;
}

/** UnsafeMath.divRoundingUp. */
export function divRoundingUp(x: bigint, y: bigint): bigint {
  return x / y + (x % y > 0n ? 1n : 0n);
}

const TICK_FACTORS: readonly (readonly [number, bigint])[] = [
  [0x2, 0xfff97272373d413259a46990580e213an],
  [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
];

/** TickMath.getSqrtPriceAtTick (Q64.96, rounded up like the library). */
export function getSqrtPriceAtTick(tick: number): bigint {
  if (!Number.isInteger(tick)) throw new RangeError('tick must be an integer');
  const absTick = Math.abs(tick);
  if (absTick > MAX_TICK) throw new RangeError(`tick ${tick} outside ±${MAX_TICK}`);
  let price = absTick & 0x1 ? 0xfffcb933bd6fad37aa2d162d1a594001n : Q128;
  for (const [bit, factor] of TICK_FACTORS) {
    if (absTick & bit) price = (price * factor) >> 128n;
  }
  if (tick > 0) price = UINT256_MAX / price;
  return (price + 0xffffffffn) >> 32n;
}

/**
 * TickMath.getTickAtSqrtPrice by its definition: the greatest tick whose sqrt price is ≤ `sqrtPriceX96`. A binary
 * search over getSqrtPriceAtTick (about 21 evaluations) instead of the library's log2 bit tricks; same result.
 */
export function tickAtSqrtPrice(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 < getSqrtPriceAtTick(-MAX_TICK) || sqrtPriceX96 >= getSqrtPriceAtTick(MAX_TICK)) throw new RangeError('sqrt price outside the tick range');
  let lo = -MAX_TICK;
  let hi = MAX_TICK;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (getSqrtPriceAtTick(mid) <= sqrtPriceX96) lo = mid;
    else hi = mid;
  }
  return lo;
}

function checkSqrtPrice(value: bigint, what: string): void {
  if (value <= 0n || value > UINT160_MAX) throw new RangeError(`${what}: invalid sqrt price`);
}

/** SqrtPriceMath.getAmount0Delta(a, b, L, roundUp). */
export function getAmount0Delta(sqrtPriceAX96: bigint, sqrtPriceBX96: bigint, liquidity: bigint, roundUp: boolean): bigint {
  let a = sqrtPriceAX96;
  let b = sqrtPriceBX96;
  if (a > b) [a, b] = [b, a];
  checkSqrtPrice(a, 'getAmount0Delta');
  const numerator1 = liquidity << 96n;
  const numerator2 = b - a;
  return roundUp ? divRoundingUp(mulDivRoundingUp(numerator1, numerator2, b), a) : mulDiv(numerator1, numerator2, b) / a;
}

/** SqrtPriceMath.getAmount1Delta(a, b, L, roundUp). */
export function getAmount1Delta(sqrtPriceAX96: bigint, sqrtPriceBX96: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const numerator = sqrtPriceAX96 > sqrtPriceBX96 ? sqrtPriceAX96 - sqrtPriceBX96 : sqrtPriceBX96 - sqrtPriceAX96;
  const amount = mulDiv(liquidity, numerator, Q96);
  return roundUp && (liquidity * numerator) % Q96 > 0n ? amount + 1n : amount;
}

/** SqrtPriceMath.getNextSqrtPriceFromAmount0RoundingUp with add = true (currency0 in). */
function nextSqrtPriceFromAmount0Add(sqrtPX96: bigint, liquidity: bigint, amount: bigint): bigint {
  if (amount === 0n) return sqrtPX96;
  const numerator1 = liquidity << 96n;
  const product = amount * sqrtPX96;
  // Solidity checks for 256-bit overflow of the product and the sum; bigint cannot overflow, so the first branch is
  // the exact one whenever the Solidity would take it.
  if (product <= UINT256_MAX && numerator1 + product <= UINT256_MAX) {
    return mulDivRoundingUp(numerator1, sqrtPX96, numerator1 + product);
  }
  return divRoundingUp(numerator1, numerator1 / sqrtPX96 + amount);
}

/** SqrtPriceMath.getNextSqrtPriceFromAmount1RoundingDown with add = true (currency1 in). */
function nextSqrtPriceFromAmount1Add(sqrtPX96: bigint, liquidity: bigint, amount: bigint): bigint {
  const quotient = amount <= UINT160_MAX ? (amount << 96n) / liquidity : mulDiv(amount, Q96, liquidity);
  const next = sqrtPX96 + quotient;
  if (next > UINT160_MAX) throw new RangeError('next sqrt price overflows uint160');
  return next;
}

/** SqrtPriceMath.getNextSqrtPriceFromInput. */
export function getNextSqrtPriceFromInput(sqrtPX96: bigint, liquidity: bigint, amountIn: bigint, zeroForOne: boolean): bigint {
  if (sqrtPX96 <= 0n || liquidity <= 0n) throw new RangeError('invalid price or liquidity');
  return zeroForOne ? nextSqrtPriceFromAmount0Add(sqrtPX96, liquidity, amountIn) : nextSqrtPriceFromAmount1Add(sqrtPX96, liquidity, amountIn);
}

export interface SwapStep {
  readonly sqrtPriceNextX96: bigint;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly feeAmount: bigint;
}

/** SwapMath.computeSwapStep, exact-input branch only (amountRemaining < 0), which is all the tests replay. */
export function computeSwapStepExactIn(
  sqrtPriceCurrentX96: bigint,
  sqrtPriceTargetX96: bigint,
  liquidity: bigint,
  amountRemainingIn: bigint,
  feePips: bigint,
): SwapStep {
  if (amountRemainingIn <= 0n) throw new RangeError('exact input must be positive');
  const zeroForOne = sqrtPriceCurrentX96 >= sqrtPriceTargetX96;
  const lessFee = mulDiv(amountRemainingIn, MAX_SWAP_FEE - feePips, MAX_SWAP_FEE);
  let amountIn = zeroForOne
    ? getAmount0Delta(sqrtPriceTargetX96, sqrtPriceCurrentX96, liquidity, true)
    : getAmount1Delta(sqrtPriceCurrentX96, sqrtPriceTargetX96, liquidity, true);
  let sqrtPriceNextX96: bigint;
  let feeAmount: bigint;
  if (lessFee >= amountIn) {
    sqrtPriceNextX96 = sqrtPriceTargetX96;
    feeAmount = feePips === MAX_SWAP_FEE ? amountIn : mulDivRoundingUp(amountIn, feePips, MAX_SWAP_FEE - feePips);
  } else {
    amountIn = lessFee;
    sqrtPriceNextX96 = getNextSqrtPriceFromInput(sqrtPriceCurrentX96, liquidity, lessFee, zeroForOne);
    feeAmount = amountRemainingIn - amountIn;
  }
  const amountOut = zeroForOne
    ? getAmount1Delta(sqrtPriceNextX96, sqrtPriceCurrentX96, liquidity, false)
    : getAmount0Delta(sqrtPriceCurrentX96, sqrtPriceNextX96, liquidity, false);
  return { sqrtPriceNextX96, amountIn, amountOut, feeAmount };
}

/**
 * Fees one swap accrues to a single position holding all of the pool's liquidity L: fee growth rounds down
 * (Pool.swap: mulDiv(feeAmount, Q128, L)) and the position's share rounds down again (Position.update), so the
 * realised fee can be a wei below the swap's fee amount.
 */
export function positionFeeFromSwap(feeAmount: bigint, liquidity: bigint): bigint {
  const growth = mulDiv(feeAmount, Q128, liquidity);
  return mulDiv(growth, liquidity, Q128);
}
