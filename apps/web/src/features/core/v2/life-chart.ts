/**
 * SH-BOX-LIFE-VIEW: the pool price's conversion, bigint only. SH-BOX-CANDLES draws the box's price as candles
 * (candles-v2.ts) and takes it from here; the launch curve's geometry that lived here (`curveModelV2`, the curve picture
 * and then the chart's graduation line) went with its last caller (fix round 1, F5; removed in fix round 2).
 *
 * Exact math, bigint only (packages/indexer/src/v4-math.ts): the curve is one Uniswap v4 range with P as currency0, so
 * the price in P per whole T (× 10^18, the indexer's `pricePPerTX18`) is 2^192·10^36 / √price².
 */
const Q192 = 1n << 192n;
const X36 = 10n ** 36n;

/** The pool's price in raw P per whole T × 10^18 (the indexer's `pricePPerTX18`), from a √price (Q64.96), rounded down. */
export const pricePPerTX18Of = (sqrtPriceX96: bigint): bigint => (sqrtPriceX96 > 0n ? (Q192 * X36) / (sqrtPriceX96 * sqrtPriceX96) : 0n);
