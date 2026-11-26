/**
 * Prices and amounts of a core v1 box in its OWN Q and token order (BC-083: nothing assumes ETH, 18 decimals or T as
 * currency1). bigint only; browser-safe (exported through `@squarehole/indexer/client` for the site).
 *
 * Uniswap v4: √P (Q64.96) is √(currency1 / currency0) in raw units. A box's T is currency0 when its address sorts below
 * Q's (native ETH, the zero address, is always currency0, so box 0's T is currency1).
 */
import { getAmount0Delta, getAmount1Delta, getSqrtPriceAtTick } from '../v4-math';

const Q192 = 1n << 192n;

/** MIN_USABLE_TICK / MAX_USABLE_TICK at spacing 60 (BoxSpecV1). */
export const MIN_USABLE_TICK = -887_220;
export const MAX_USABLE_TICK = 887_220;

export interface PriceSide {
  readonly tIsCurrency0: boolean;
  readonly qDecimals: number;
  readonly tDecimals: number;
}

/** A decimal string of `numerator / denominator` with `digits` fraction digits, truncated ("0.000123"). */
export function ratioDecimal(numerator: bigint, denominator: bigint, digits: number): string {
  if (denominator === 0n) throw new RangeError('division by zero');
  const scaled = (numerator * 10n ** BigInt(digits)) / denominator;
  const whole = scaled / 10n ** BigInt(digits);
  const fraction = (scaled % 10n ** BigInt(digits)).toString().padStart(digits, '0').replace(/0+$/, '');
  return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
}

/** Q per one whole T at √P, as a ratio of bigints (numerator, denominator), in whole units of each. */
export function qPerTRatio(sqrtPriceX96: bigint, side: PriceSide): { readonly numerator: bigint; readonly denominator: bigint } {
  const p2 = sqrtPriceX96 * sqrtPriceX96;
  // Raw Q per raw T: T currency0 → Q/T = P = √P²/2^192; T currency1 → Q/T = 1/P = 2^192/√P².
  let numerator = side.tIsCurrency0 ? p2 : Q192;
  let denominator = side.tIsCurrency0 ? Q192 : p2;
  // Whole units: × 10^tDecimals / 10^qDecimals.
  const shift = side.tDecimals - side.qDecimals;
  if (shift >= 0) numerator *= 10n ** BigInt(shift);
  else denominator *= 10n ** BigInt(-shift);
  return { numerator, denominator };
}

/** Q per one whole T, decimal, `digits` fraction digits (the pool's price, before the 1% fee and any tax). */
export function priceQPerT(sqrtPriceX96: bigint, side: PriceSide, digits = 18): string {
  const { numerator, denominator } = qPerTRatio(sqrtPriceX96, side);
  return ratioDecimal(numerator, denominator, digits);
}

/** Raw Q worth `tRaw` raw T at √P (FDV: price × supply), truncated. */
export function qValueOfT(sqrtPriceX96: bigint, tIsCurrency0: boolean, tRaw: bigint): bigint {
  const p2 = sqrtPriceX96 * sqrtPriceX96;
  return tIsCurrency0 ? (tRaw * p2) / Q192 : (tRaw * Q192) / p2;
}

export interface CurveRange {
  readonly tIsCurrency0: boolean;
  readonly raise: bigint;
  readonly sqrtPriceLowerX96: bigint;
  readonly sqrtPriceUpperX96: bigint;
  readonly liquidity: bigint;
}

/**
 * The Q the curve holds at √P (net of sells): 0 at the start (P0), exactly the raise at P1 (BoxLayoutV1 sizes the curve
 * so the whole range holds the raise). T currency1: buys move √P down from the upper edge; T currency0: up from the lower.
 */
export function curveRetainedQ(curve: CurveRange, sqrtPriceX96: bigint): bigint {
  const { sqrtPriceLowerX96: lo, sqrtPriceUpperX96: hi, liquidity } = curve;
  if (curve.tIsCurrency0) {
    if (sqrtPriceX96 <= lo) return 0n;
    if (sqrtPriceX96 >= hi) return curve.raise;
    return getAmount1Delta(lo, sqrtPriceX96, liquidity, false);
  }
  if (sqrtPriceX96 >= hi) return 0n;
  if (sqrtPriceX96 <= lo) return curve.raise;
  return getAmount0Delta(sqrtPriceX96, hi, liquidity, false);
}

/** Fill in basis points, truncated (10,000 = the raise). */
export function fillBps(retainedQ: bigint, raise: bigint): number {
  if (raise === 0n) return 0;
  const bps = (retainedQ * 10_000n) / raise;
  return Number(bps > 10_000n ? 10_000n : bps);
}

/** A position's amounts (currency0, currency1) at √P (v4 LiquidityAmounts, rounded down). */
export function amountsForLiquidity(sqrtPriceX96: bigint, tickLower: number, tickUpper: number, liquidity: bigint): { readonly amount0: bigint; readonly amount1: bigint } {
  if (liquidity === 0n) return { amount0: 0n, amount1: 0n };
  const a = getSqrtPriceAtTick(tickLower);
  const b = getSqrtPriceAtTick(tickUpper);
  if (sqrtPriceX96 <= a) return { amount0: getAmount0Delta(a, b, liquidity, false), amount1: 0n };
  if (sqrtPriceX96 >= b) return { amount0: 0n, amount1: getAmount1Delta(a, b, liquidity, false) };
  return { amount0: getAmount0Delta(sqrtPriceX96, b, liquidity, false), amount1: getAmount1Delta(a, sqrtPriceX96, liquidity, false) };
}

export interface GraduatedPositions {
  readonly askLiquidity: bigint;
  readonly bidLiquidity: bigint;
  readonly sentinelLiquidity: bigint;
  readonly pairedLiquidity: bigint;
}

/**
 * Q and T in the hook's positions at √P (the graduated layout L7 and the pair-and-lock position; plan § 5 Pool card, I:
 * v4 maths over the hook's positions). Ranges from BoxLayoutV1.graduated: the ask from P1 to T's edge, the bid from P1
 * to Q's edge, the sentinel from P0 to Q's edge, the pair full range.
 */
export function hookHoldings(positions: GraduatedPositions, curve: { readonly tIsCurrency0: boolean; readonly tickLower: number; readonly tickUpper: number }, sqrtPriceX96: bigint): { readonly q: bigint; readonly t: bigint } {
  const tIsC0 = curve.tIsCurrency0;
  const tickEnd = tIsC0 ? curve.tickUpper : curve.tickLower;
  const tickStart = tIsC0 ? curve.tickLower : curve.tickUpper;
  const qEdge = tIsC0 ? MIN_USABLE_TICK : MAX_USABLE_TICK;
  const tEdge = tIsC0 ? MAX_USABLE_TICK : MIN_USABLE_TICK;
  const range = (a: number, b: number): [number, number] => (a < b ? [a, b] : [b, a]);
  const parts: [number, number, bigint][] = [
    [...range(tickEnd, tEdge), positions.askLiquidity],
    [...range(tickEnd, qEdge), positions.bidLiquidity],
    [...range(tickStart, qEdge), positions.sentinelLiquidity],
    [MIN_USABLE_TICK, MAX_USABLE_TICK, positions.pairedLiquidity],
  ];
  let c0 = 0n;
  let c1 = 0n;
  for (const [lo, hi, l] of parts) {
    const { amount0, amount1 } = amountsForLiquidity(sqrtPriceX96, lo, hi, l);
    c0 += amount0;
    c1 += amount1;
  }
  return tIsC0 ? { t: c0, q: c1 } : { q: c0, t: c1 };
}

/** Raw codec (0x55) CIDv1 prefix with a sha2-256 multihash of 32 bytes: version 1, raw, sha2-256, length 32. */
const RAW_CID_PREFIX = Uint8Array.from([0x01, 0x55, 0x12, 0x20]);
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function digestBytes(sha256: `0x${string}`): Uint8Array {
  if (!/^0x[0-9a-fA-F]{64}$/.test(sha256)) throw new Error(`not a sha256: ${sha256}`);
  return Uint8Array.from(sha256.slice(2).match(/../g) ?? [], (byte) => parseInt(byte, 16));
}

function base32Lower(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

/** The raw CIDv1 (base32, `b…`) of one raw block whose sha256 is `sha256`. */
export function rawCid(sha256: `0x${string}`): string {
  const digest = digestBytes(sha256);
  const bytes = new Uint8Array(RAW_CID_PREFIX.length + digest.length);
  bytes.set(RAW_CID_PREFIX, 0);
  bytes.set(digest, RAW_CID_PREFIX.length);
  return `b${base32Lower(bytes)}`;
}

