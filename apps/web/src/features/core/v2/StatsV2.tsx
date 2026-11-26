/**
 * SH-TA-29: a v2 box's numbers first (the founder: numbers and visuals first, details on demand), from the indexer's
 * `statistics` (stats-v2.ts); an unknown one is a dash. The box page shows them in its market card beside the launch
 * curve or the pool's price (SH-BOX-LIFE-VIEW, LifeViewV2.tsx); a feed card carries the same set in short with a price
 * line. Read only: nothing here touches a wallet.
 */
import type { V2Snapshot } from './indexer-v2';
import { candleGeometryV2, statFiguresV2, type HourlyCandleV2, type StatFiguresV2 } from './stats-v2';
import './stats-v2.css';

/** False for a box the indexer's audit refuted: no price, market cap or price history then (never an Unverified price). */
export const priceShownV2 = (view: Pick<V2Snapshot, 'audited' | 'verified'>): boolean => !(view.audited && !view.verified);

/** A box's figures: its price and market cap hidden when the indexer's audit refuted it. */
export function figuresOfV2(view: V2Snapshot): StatFiguresV2 {
  return statFiguresV2(view.statistics ?? null, view.decimals, priceShownV2(view));
}

/**
 * The hourly candles a box may show: null when unavailable (no statistics published, or the price hidden for a refuted
 * box), which the page says as such; an empty list only when the statistics are there and no hour had a trade.
 */
export function candlesOfV2(view: V2Snapshot): readonly HourlyCandleV2[] | null {
  const stats = view.statistics ?? null;
  return stats === null || !priceShownV2(view) ? null : stats.hourlyCandles;
}

/** A feed card's price line: the hourly closes, decoration only (the card's name says the numbers). */
export function SparkV2({ candles }: { candles: readonly HourlyCandleV2[] }) {
  const layout = candleGeometryV2(candles, 100, 24);
  if (layout === null) return null;
  const points = layout.candles.map((c) => `${c.x.toFixed(2)},${c.close.toFixed(2)}`).join(' ');
  return (
    <svg className="sh-v2-spark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      {layout.candles.length === 1 ? <circle cx={layout.candles[0]?.x} cy={layout.candles[0]?.close} r={1.5} /> : <polyline points={points} />}
    </svg>
  );
}

/**
 * The short set on a feed card, in the order the page uses (the market cap stays out when the card's figure is it); null
 * for a closed box, whose figure is its claim price.
 */
export function cardStatsV2(view: V2Snapshot): readonly (readonly [string, string])[] | null {
  if (view.failed) return null;
  const f = figuresOfV2(view);
  const cells: [string, string][] = [['Price', f.price]];
  if (!view.graduated) cells.push(['Mcap', f.marketCap]);
  cells.push(['Holders', f.holders], ['Burned', f.burned], ['24h', f.volume24h]);
  return cells;
}
