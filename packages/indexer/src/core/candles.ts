/**
 * Price candles of one box from its trades (S10a § 4: 1 min kept 30 days, 1 h and 1 d kept; the same function for the
 * hot path and the history store, so a rebuild gives identical candles, BC-078). Open, high, low, close of √P after
 * each trade (the site converts √P to Q per T with the box's own order and decimals, BC-083), Q volume, trade count.
 * Trades by the hook (its walk and depth conversions) and FIT's executor move the price but are not volume.
 */
import type { Candle, CandleInterval } from './core-gateway';
import type { CoreTrade } from './derive-core';

export const INTERVAL_SECONDS: Readonly<Record<CandleInterval, bigint>> = Object.freeze({ '12s': 12n, '1m': 60n, '10m': 600n, '1h': 3_600n, '10h': 36_000n, '1d': 86_400n });

export function candlesFromTrades(trades: readonly Pick<CoreTrade, 'timestamp' | 'block' | 'logIndex' | 'sqrtPriceX96After' | 'qRaw' | 'route'>[], interval: CandleInterval): Candle[] {
  const size = INTERVAL_SECONDS[interval];
  const ordered = [...trades].sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));
  const out = new Map<bigint, { open: bigint; high: bigint; low: bigint; close: bigint; volume: bigint; count: number }>();
  for (const t of ordered) {
    const start = (t.timestamp / size) * size;
    const p = t.sqrtPriceX96After;
    const counted = t.route !== 'hook' && t.route !== 'executor' && t.route !== 'converter' && t.route !== 'swap_module' && t.route !== 'buy_back';
    const c = out.get(start);
    if (!c) out.set(start, { open: p, high: p, low: p, close: p, volume: counted ? t.qRaw : 0n, count: counted ? 1 : 0 });
    else out.set(start, { open: c.open, high: p > c.high ? p : c.high, low: p < c.low ? p : c.low, close: p, volume: c.volume + (counted ? t.qRaw : 0n), count: c.count + (counted ? 1 : 0) });
  }
  return [...out.entries()].map(([start, c]) => ({
    start: start.toString(),
    openSqrtPriceX96: c.open.toString(),
    highSqrtPriceX96: c.high.toString(),
    lowSqrtPriceX96: c.low.toString(),
    closeSqrtPriceX96: c.close.toString(),
    volumeQ: c.volume.toString(),
    trades: c.count,
  }));
}

/** Coalesce ascending stored candles. Amounts and aggregation arithmetic stay exact. Empty buckets stay absent. */
export function aggregateCandles(candles: readonly Candle[], interval: '10m' | '10h'): Candle[] {
  const size = INTERVAL_SECONDS[interval];
  const out: Candle[] = [];
  for (const candle of candles) {
    const start = (BigInt(candle.start) / size * size).toString();
    const last = out.at(-1);
    if (!last || last.start !== start) out.push({ ...candle, start });
    else out[out.length - 1] = {
      start, openSqrtPriceX96: last.openSqrtPriceX96, closeSqrtPriceX96: candle.closeSqrtPriceX96,
      highSqrtPriceX96: BigInt(last.highSqrtPriceX96) > BigInt(candle.highSqrtPriceX96) ? last.highSqrtPriceX96 : candle.highSqrtPriceX96,
      lowSqrtPriceX96: BigInt(last.lowSqrtPriceX96) < BigInt(candle.lowSqrtPriceX96) ? last.lowSqrtPriceX96 : candle.lowSqrtPriceX96,
      volumeQ: (BigInt(last.volumeQ) + BigInt(candle.volumeQ)).toString(),
      // Existing wire shape: at most ten stored int32 counts, safely representable as a JSON number.
      trades: Number(BigInt(last.trades) + BigInt(candle.trades)),
    };
  }
  return out;
}
