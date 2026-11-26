/** TA28: log-only market statistics. P is currency0 and T is currency1 (18 decimals) in core v2. */
import { curveRetainedQ, qValueOfT } from '../core-math';
import { getSqrtPriceAtTick } from '../../v4-math';
import type { CoreTrade } from '../derive-core';
import type { LiveStateV2 } from './views-v2';

const HOUR = 3600n;
const DAY = 24n * HOUR;
const HOURS_KEPT = 168n;
const T_UNIT = 10n ** 18n;

export interface HourlyCandleV2 {
  readonly start: bigint;
  /** Raw P per whole T, scaled by 10^18, rounded down. */
  readonly open: bigint; readonly high: bigint; readonly low: bigint; readonly close: bigint;
  readonly volumeP: bigint;
  readonly tradeCount: bigint;
}
export interface StatisticsStateV2 {
  readonly raiseP: bigint;
  readonly burnedT: bigint;
  readonly holderCount: bigint;
  readonly tradeCount: bigint;
  /** One sum per distinct block timestamp; never clipped by the recent-activity limit. */
  readonly volumeByTime: readonly { readonly timestamp: bigint; readonly volumeP: bigint }[];
  readonly hourlyCandles: readonly HourlyCandleV2[];
}

export const pricePPerTX18 = (sqrtPriceX96: bigint): bigint => qValueOfT(sqrtPriceX96, false, T_UNIT * T_UNIT);
const counted = (trade: CoreTrade): boolean => !['hook', 'executor', 'converter', 'swap_module', 'buy_back'].includes(trade.route);
const candleFloor = (now: bigint): bigint => (now / HOUR - HOURS_KEPT + 1n) * HOUR;

/** Immutable block reduction: prior snapshots remain usable for a canonical rewind. */
export function statisticsAfterTrades(previous: StatisticsStateV2, trades: readonly CoreTrade[], now: bigint): StatisticsStateV2 {
  let tradeCount = previous.tradeCount;
  let volumeP = 0n;
  const candles = new Map(previous.hourlyCandles.filter(c => c.start >= candleFloor(now)).map(c => [c.start, c]));
  for (const trade of trades) {
    const include = counted(trade);
    if (include) { tradeCount += 1n; volumeP += trade.qRaw; }
    const start = trade.timestamp / HOUR * HOUR;
    const price = pricePPerTX18(trade.sqrtPriceX96After);
    const old = candles.get(start);
    candles.set(start, { start, open: old?.open ?? price, high: old && old.high > price ? old.high : price,
      low: old && old.low < price ? old.low : price, close: price,
      volumeP: (old?.volumeP ?? 0n) + (include ? trade.qRaw : 0n), tradeCount: (old?.tradeCount ?? 0n) + (include ? 1n : 0n) });
  }
  const volumeByTime = previous.volumeByTime.filter(v => v.timestamp > now - DAY);
  if (volumeP > 0n) {
    const last = volumeByTime.at(-1);
    if (last?.timestamp === now) volumeByTime[volumeByTime.length - 1] = { timestamp: now, volumeP: last.volumeP + volumeP };
    else volumeByTime.push({ timestamp: now, volumeP });
  }
  return { ...previous, tradeCount, volumeByTime, hourlyCandles: [...candles.values()] };
}

/** Wire amounts become decimal strings through jsonV2, just like the existing v2 view fields. */
export function statisticsViewV2(state: LiveStateV2, now: bigint) {
  const stats = state.statistics;
  // Old/manual snapshots without a full replay cannot attest lifetime burns/counts or a 24h window.
  if (!stats) return null;
  const sqrt = state.view.failed ? undefined : state.pool?.sqrtPriceX96;
  const position = state.view.position;
  let raiseProgress = null;
  if (!state.view.graduated && !state.view.failed && position?.kind === 'curve' && sqrt && sqrt > 0n) {
    const raw = curveRetainedQ({ tIsCurrency0: false, raise: stats.raiseP, liquidity: position.liquidity,
      sqrtPriceLowerX96: getSqrtPriceAtTick(position.tickLower), sqrtPriceUpperX96: getSqrtPriceAtTick(position.tickUpper) }, sqrt);
    const raisedP = raw > stats.raiseP ? stats.raiseP : raw;
    raiseProgress = { raisedP, raiseP: stats.raiseP, progressBps: stats.raiseP > 0n ? raisedP * 10000n / stats.raiseP : 0n };
  }
  return {
    pricePPerTX18: sqrt && sqrt > 0n ? pricePPerTX18(sqrt) : null,
    marketCapP: sqrt && sqrt > 0n ? qValueOfT(sqrt, false, state.supply) : null,
    raiseProgress, totalSupplyT: state.supply, burnedT: stats.burnedT, holderCount: stats.holderCount,
    volume24hP: stats.volumeByTime.reduce((sum, v) => v.timestamp > now - DAY && v.timestamp <= now ? sum + v.volumeP : sum, 0n),
    tradeCount: stats.tradeCount,
    hourlyCandles: stats.hourlyCandles.filter(c => c.start >= candleFloor(now) && c.start <= now),
  };
}
