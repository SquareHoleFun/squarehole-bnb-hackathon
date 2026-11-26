/**
 * Exact pool price math (bigint only; no float anywhere). Uniswap v4 stores √price as Q64.96:
 * price(currency1 per currency0, raw units) = sqrtPriceX96² / 2^192. Square Hole pools pair T with Q in either order.
 *
 * The price shown is the pool's current MID price from slot0: not an execution quote, not net of the 3% LP fee.
 * Every decimal string is TRUNCATED toward zero (never overstates), like the domain display rules.
 */
import type { DecimalAmount } from '@squarehole/domain';

export const Q96 = 2n ** 96n;
export const Q192 = 2n ** 192n;
/** Uniswap v4 TickMath bounds on √price (MIN_SQRT_PRICE, MAX_SQRT_PRICE). */
export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

/** A non-negative exact rational. `den` is always positive. */
export interface Rational {
  readonly num: bigint;
  readonly den: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

export function rational(num: bigint, den: bigint): Rational {
  if (den <= 0n) throw new RangeError('denominator must be positive');
  if (num < 0n) throw new RangeError('rationals here are non-negative');
  const g = gcd(num, den);
  return g > 1n ? { num: num / g, den: den / g } : { num, den };
}

function checkSqrtPrice(sqrtPriceX96: bigint): void {
  if (sqrtPriceX96 < MIN_SQRT_PRICE || sqrtPriceX96 > MAX_SQRT_PRICE) {
    throw new RangeError('sqrtPriceX96 outside the Uniswap v4 range (uninitialised pool?)');
  }
}

/** Raw Q units per raw T unit at the pool's mid price. `tIsCurrency0` = T sorts below Q (PoolKey order). */
export function rawQPerRawT(sqrtPriceX96: bigint, tIsCurrency0: boolean): Rational {
  checkSqrtPrice(sqrtPriceX96);
  const square = sqrtPriceX96 * sqrtPriceX96;
  return tIsCurrency0 ? rational(square, Q192) : rational(Q192, square);
}

/** Display Q per display T: raw ratio × 10^(tDecimals − qDecimals). */
export function displayQPerT(rawPrice: Rational, tDecimals: number, qDecimals: number): Rational {
  const t = 10n ** BigInt(tDecimals);
  const q = 10n ** BigInt(qDecimals);
  return rational(rawPrice.num * t, rawPrice.den * q);
}

/** floor(amount × r). */
export function mulFloor(amount: bigint, r: Rational): bigint {
  if (amount < 0n) throw new RangeError('amount must be non-negative');
  return (amount * r.num) / r.den;
}

/** Exact truncated decimal with `fractionDigits` digits after the point (trailing zeros removed). */
export function toDecimalString(r: Rational, fractionDigits: number): DecimalAmount {
  if (!Number.isInteger(fractionDigits) || fractionDigits < 0 || fractionDigits > 120) throw new RangeError('fractionDigits must be 0..120');
  const scaled = (r.num * 10n ** BigInt(fractionDigits)) / r.den;
  if (fractionDigits === 0) return scaled.toString();
  const digits = scaled.toString().padStart(fractionDigits + 1, '0');
  const whole = digits.slice(0, digits.length - fractionDigits);
  const fraction = digits.slice(digits.length - fractionDigits).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * Truncated decimal keeping `significantDigits` significant digits (at least the whole integer part). A price of
 * 0.000000123456789… keeps its leading zeros and then 18 digits; zero is "0".
 */
export function toSignificantDecimal(r: Rational, significantDigits = 18): DecimalAmount {
  if (r.num === 0n) return '0';
  const whole = r.num / r.den;
  if (whole > 0n) {
    const intDigits = whole.toString().length;
    return toDecimalString(r, Math.max(0, significantDigits - intDigits));
  }
  // Leading zeros after the point: the smallest z with r × 10^(z+1) >= 1.
  let zeros = 0;
  let probe = r.num * 10n;
  while (probe < r.den && zeros < 110) {
    probe *= 10n;
    zeros += 1;
  }
  return toDecimalString(r, Math.min(120, zeros + significantDigits));
}

/**
 * A decimal `tPerQ` (T per Q in display units) such that `floor(qIn × tPerQ × 10^tDec / 10^(qDec + scale)) = tOut`
 * holds EXACTLY (the domain's `estimatePayoutRaw` identity), for a quoted conversion of `qIn` raw Q into `tOut` raw T.
 * The rate is the ceiling of tOut / qIn at a scale fine enough that the ceiling cannot lift the product past tOut + 1.
 */
export function exactRateForQuote(qInRaw: bigint, tOutRaw: bigint, qDecimals: number, tDecimals: number): DecimalAmount {
  if (qInRaw <= 0n) throw new RangeError('qIn must be positive');
  if (tOutRaw < 0n) throw new RangeError('tOut must be non-negative');
  // estimate = floor(qIn × units × 10^tDec / 10^(qDec + s)); choose s so the rounding step qIn × 10^tDec / 10^(qDec + s) ≤ 1.
  const step = qInRaw * 10n ** BigInt(tDecimals);
  let scale = 0;
  while (step > 10n ** BigInt(qDecimals + scale)) scale += 1;
  const denominator = qInRaw * 10n ** BigInt(tDecimals);
  const numerator = tOutRaw * 10n ** BigInt(qDecimals + scale);
  const units = (numerator + denominator - 1n) / denominator; // ceil
  return toDecimalString({ num: units, den: 10n ** BigInt(scale) }, scale);
}
