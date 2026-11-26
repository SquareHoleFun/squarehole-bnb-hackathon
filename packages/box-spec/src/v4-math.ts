/**
 * The pinned Uniswap v4 maths the layout library uses, ported to bigint line by line (v4-core 46c6834: TickMath,
 * SqrtPriceMath, FullMath; v4-periphery 9969eec: LiquidityAmounts), as packages/contracts/script-py/launch_shape.py
 * ports them in Python. Integer arithmetic only: no Number for amounts, prices or liquidity.
 */

export const Q96 = 1n << 96n;
const U256_MAX = (1n << 256n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
export const MIN_TICK = -887_272;
export const MAX_TICK = 887_272;
export const MIN_SQRT_PRICE = 4_295_128_739n;
export const MAX_SQRT_PRICE = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342n;

/** TickMath.sol: the factors for bits 0x2 ... 0x80000 of |tick|. */
const BIT_FACTORS: readonly (readonly [number, bigint])[] = [
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

const divUp = (a: bigint, b: bigint): bigint => (a % b === 0n ? a / b : a / b + 1n);

/** FullMath.mulDiv: floor(a × b / d), refused when the result does not fit 256 bits. */
export function mulDiv(a: bigint, b: bigint, d: bigint): bigint {
  const r = (a * b) / d;
  if (r > U256_MAX) throw new Error('FullMath.mulDiv overflow');
  return r;
}

/** TickMath.getSqrtPriceAtTick. */
export function getSqrtPriceAtTick(tick: number): bigint {
  const absTick = Math.abs(tick);
  if (!Number.isInteger(tick) || absTick > MAX_TICK) throw new Error(`InvalidTick(${tick})`);
  let price = absTick & 0x1 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 1n << 128n;
  for (const [bit, factor] of BIT_FACTORS) {
    if (absTick & bit) price = (price * factor) >> 128n;
  }
  if (tick > 0) price = U256_MAX / price;
  return (price + (1n << 32n) - 1n) >> 32n;
}

/** TickMath.getTickAtSqrtPrice: the greatest tick whose sqrt price is at most `sqrtPriceX96`. */
export function getTickAtSqrtPrice(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 < MIN_SQRT_PRICE || sqrtPriceX96 >= MAX_SQRT_PRICE) throw new Error(`InvalidSqrtPrice(${sqrtPriceX96})`);
  let lo = MIN_TICK;
  let hi = MAX_TICK;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (getSqrtPriceAtTick(mid) <= sqrtPriceX96) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** SqrtPriceMath.getAmount0Delta (unsigned liquidity). */
export function getAmount0Delta(a: bigint, b: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  if (lo === 0n) throw new Error('InvalidPrice');
  const numerator1 = liquidity << 96n;
  const numerator2 = hi - lo;
  return roundUp ? divUp(divUp(numerator1 * numerator2, hi), lo) : (numerator1 * numerator2) / hi / lo;
}

/** SqrtPriceMath.getAmount1Delta (unsigned liquidity). */
export function getAmount1Delta(a: bigint, b: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const diff = a > b ? a - b : b - a;
  return roundUp ? divUp(liquidity * diff, Q96) : (liquidity * diff) / Q96;
}

function toUint128(v: bigint): bigint {
  if (v > U128_MAX) throw new Error('LiquidityAmounts: uint128 overflow');
  return v;
}

/** LiquidityAmounts.getLiquidityForAmount0. */
export function getLiquidityForAmount0(a: bigint, b: bigint, amount0: bigint): bigint {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return toUint128(mulDiv(amount0, mulDiv(lo, hi, Q96), hi - lo));
}

/** LiquidityAmounts.getLiquidityForAmount1. */
export function getLiquidityForAmount1(a: bigint, b: bigint, amount1: bigint): bigint {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return toUint128(mulDiv(amount1, Q96, hi - lo));
}

/** floor(√x): the same Newton iteration as BoxLayoutV1.floorSqrt. */
export function isqrt(x: bigint): bigint {
  if (x < 0n) throw new Error('isqrt of a negative number');
  if (x < 2n) return x;
  let z = x;
  let y = (x + 1n) >> 1n;
  while (y < z) {
    z = y;
    y = (x / y + y) >> 1n;
  }
  return z;
}
