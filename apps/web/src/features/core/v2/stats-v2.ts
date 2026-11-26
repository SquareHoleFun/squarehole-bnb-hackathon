/**
 * SH-TA-29: a v2 box's market numbers from the indexer's `statistics` (SH-TA-28; field contract in
 * docs/evidence/SH-TA-28.md): price, market cap, raise progress during the curve, supply, burned, holders, 24 h
 * volume, trade count and hourly candles, every one a decimal string on the wire and a bigint here. The founder's
 * "numbers and visuals first" set for the cards and the box page is formatted from them, never through a JS number for
 * an amount: a figure the indexer does not have (null) is a dash, never a zero.
 */
import { formatTokenAmount, formatUnits } from '@squarehole/domain';
import { formatBps, formatCount, formatTokenShort, significant } from '../../fit-pair/fit-format';

export interface HourlyCandleV2 {
  /** UTC Unix seconds of the hour's start. */
  readonly start: bigint;
  /** Raw P per whole T × 10^18 (the indexer's `pricePPerTX18` unit), rounded down. */
  readonly open: bigint;
  readonly high: bigint;
  readonly low: bigint;
  readonly close: bigint;
  readonly volumeP: bigint;
  readonly tradeCount: bigint;
}

export interface StatisticsV2 {
  /** Raw P per whole T × 10^18; null before the pool is initialised or after a failure. */
  readonly pricePPerTX18: bigint | null;
  /** Raw P: price × current supply; null with the price. */
  readonly marketCapP: bigint | null;
  /** The curve's retained principal against the frozen raise; null outside the curve (graduated, failed, not launched). */
  readonly raiseProgress: { readonly raisedP: bigint; readonly raiseP: bigint; readonly progressBps: bigint } | null;
  readonly totalSupplyT: bigint;
  readonly burnedT: bigint;
  readonly holderCount: bigint;
  readonly volume24hP: bigint;
  readonly tradeCount: bigint;
  /** Ascending hours with at least one swap, at most the current one and the 167 before it. */
  readonly hourlyCandles: readonly HourlyCandleV2[];
}

const UINT = /^(0|[1-9][0-9]{0,77})$/;
const uint = (v: unknown, what: string): bigint => {
  if (typeof v !== 'string' || !UINT.test(v)) throw new Error(`statistics.${what} must be a decimal string`);
  return BigInt(v);
};
const uintOrNull = (v: unknown, what: string): bigint | null => (v === null ? null : uint(v, what));
const objectOf = (v: unknown, what: string): Record<string, unknown> => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error(`statistics.${what} must be an object`);
  return v as Record<string, unknown>;
};
/** The indexer keeps the current hour and the 167 before it. */
export const HOURS_KEPT = 168;

/**
 * The `statistics` of one v2 feed card or box snapshot: null when the publication has none (an older indexer, or a
 * snapshot without a full replay); a malformed one fails the answer's checks like any other field.
 */
export function parseStatisticsV2(input: unknown): StatisticsV2 | null {
  if (input === undefined || input === null) return null;
  const s = objectOf(input, 'object');
  const progress = s.raiseProgress === null ? null : objectOf(s.raiseProgress, 'raiseProgress');
  const raiseProgress = progress && { raisedP: uint(progress.raisedP, 'raiseProgress.raisedP'), raiseP: uint(progress.raiseP, 'raiseProgress.raiseP'), progressBps: uint(progress.progressBps, 'raiseProgress.progressBps') };
  if (raiseProgress && (raiseProgress.raisedP > raiseProgress.raiseP || raiseProgress.progressBps > 10_000n)) throw new Error('statistics.raiseProgress is out of range');
  if (!Array.isArray(s.hourlyCandles) || s.hourlyCandles.length > HOURS_KEPT) throw new Error('statistics.hourlyCandles must be a list of at most 168 hours');
  let previous = -1n;
  const hourlyCandles = s.hourlyCandles.map((item, i) => {
    const c = objectOf(item, `hourlyCandles[${i}]`);
    const candle: HourlyCandleV2 = { start: uint(c.start, 'hourlyCandles.start'), open: uint(c.open, 'hourlyCandles.open'), high: uint(c.high, 'hourlyCandles.high'), low: uint(c.low, 'hourlyCandles.low'), close: uint(c.close, 'hourlyCandles.close'), volumeP: uint(c.volumeP, 'hourlyCandles.volumeP'), tradeCount: uint(c.tradeCount, 'hourlyCandles.tradeCount') };
    const inside = (v: bigint) => v >= candle.low && v <= candle.high;
    if (candle.start % 3600n !== 0n || candle.start <= previous || !inside(candle.open) || !inside(candle.close)) throw new Error('statistics.hourlyCandles are not ascending hours with low ≤ open, close ≤ high');
    previous = candle.start;
    return Object.freeze(candle);
  });
  return Object.freeze({
    pricePPerTX18: uintOrNull(s.pricePPerTX18, 'pricePPerTX18'),
    marketCapP: uintOrNull(s.marketCapP, 'marketCapP'),
    raiseProgress: raiseProgress && Object.freeze(raiseProgress),
    totalSupplyT: uint(s.totalSupplyT, 'totalSupplyT'),
    burnedT: uint(s.burnedT, 'burnedT'),
    holderCount: uint(s.holderCount, 'holderCount'),
    volume24hP: uint(s.volume24hP, 'volume24hP'),
    tradeCount: uint(s.tradeCount, 'tradeCount'),
    hourlyCandles: Object.freeze(hourlyCandles),
  });
}

/** What a figure the indexer does not have shows: a dash, never a zero. */
export const NO_FIGURE = '—';

/** raw ÷ 10^scale as an exact decimal string ("0.0042068292…"). */
function decimalOf(raw: bigint, scale: number): string {
  if (scale === 0) return raw.toString();
  const digits = raw.toString().padStart(scale + 1, '0');
  const fraction = digits.slice(-scale).replace(/0+$/, '');
  const whole = digits.slice(0, -scale);
  return fraction ? `${whole}.${fraction}` : whole;
}

/** A decimal string with the whole part grouped ("12,345.6"). */
function grouped(decimal: string): string {
  const [whole = '0', fraction] = decimal.split('.');
  return `${formatCount(BigInt(whole))}${fraction ? `.${fraction}` : ''}`;
}

/**
 * The price in P per 1M T (the site's one price unit), 5 significant digits, truncated: `pricePPerTX18` is raw P per
 * whole T × 10^18, so P per 1M whole T is pricePPerTX18 × 10^6 ÷ 10^(pDecimals + 18).
 */
export function pricePerMillionV2(pricePPerTX18: bigint | null, pDecimals: number): string {
  if (pricePPerTX18 === null) return NO_FIGURE;
  return grouped(significant(decimalOf(pricePPerTX18 * 1_000_000n, pDecimals + 18), 5));
}

/**
 * A closed box's claim price per 1M T, short like every other price (SH-BOX-LIFE-VIEW: "0.071758"): the pot over the
 * coins still counted, the same floor as `claimPriceV2` (raw P per whole T × 10^18 is pot × 10^36 ÷ tLeft). Null when no
 * coin is left to claim.
 */
export const closingPricePerMillionV2 = (pot: bigint, tLeft: bigint, pDecimals: number): string | null =>
  tLeft > 0n ? pricePerMillionV2((pot * 10n ** 36n) / tLeft, pDecimals) : null;

/**
 * A raw P amount (market cap, volume, raised): two truncated decimals from one whole P up ("41.82"), four significant
 * digits below it ("0.0004206"), "0" for an exact zero; a dash for null.
 */
export function pAmountV2(raw: bigint | null, pDecimals: number): string {
  if (raw === null) return NO_FIGURE;
  if (raw >= 10n ** BigInt(pDecimals)) return formatTokenAmount(raw, pDecimals, { maxFractionDigits: Math.min(pDecimals, 2) });
  return significant(decimalOf(raw, pDecimals), 4);
}

/**
 * SH-276: a raise as the card and the box page's stepper print it: every digit while that fits (at most 12 characters,
 * "0.4206980085"), else the short form `pAmountV2` gives ("0.001854" for 0.001854565578800516, a raise a price row
 * sets on BNB Chain testnet). The bar under the chart prints the same form (it shares `raiseBarV2` with the stepper); the
 * Create overview's Raise row and the box page's fee details keep every digit.
 */
export function raiseShownV2(raw: bigint, pDecimals: number): string {
  const exact = formatUnits(raw, pDecimals);
  return exact.length <= 12 ? exact : pAmountV2(raw, pDecimals);
}

/** A raw T amount, short ("2.56M"), without the symbol. */
export const tShortV2 = (raw: bigint | null): string => (raw === null ? NO_FIGURE : formatTokenShort(raw, '').trim());

/** Raise progress as a percentage with one truncated decimal ("62.0%"); a dash outside the curve. */
export const progressTextV2 = (progress: StatisticsV2['raiseProgress']): string => (progress === null ? NO_FIGURE : formatBps(Number(progress.progressBps)));

/** A v2 box's figures as the card and the page show them (each a string, a dash when unknown). */
export interface StatFiguresV2 {
  readonly price: string;
  readonly marketCap: string;
  /** "62.0%", or null when the box is not on its curve (no raise row then). */
  readonly progress: string | null;
  /** "0.26 / 0.4206980085", the raised (short) and the raise (exact) in P. */
  readonly raised: string | null;
  /** The bar's width (0-10 000), with the progress. */
  readonly progressBps: number | null;
  readonly holders: string;
  readonly burned: string;
  readonly volume24h: string;
  readonly trades: string;
}

/**
 * The figures of one box. `priceShown` false (a box the indexer's audit refuted) hides the price and the market cap,
 * as a v1 card never shows an Unverified box's FDV; every count still shows.
 */
export function statFiguresV2(stats: StatisticsV2 | null, pDecimals: number, priceShown = true): StatFiguresV2 {
  if (stats === null) return { price: NO_FIGURE, marketCap: NO_FIGURE, progress: null, raised: null, progressBps: null, holders: NO_FIGURE, burned: NO_FIGURE, volume24h: NO_FIGURE, trades: NO_FIGURE };
  const p = stats.raiseProgress;
  return {
    price: priceShown ? pricePerMillionV2(stats.pricePPerTX18, pDecimals) : NO_FIGURE,
    marketCap: priceShown ? pAmountV2(stats.marketCapP, pDecimals) : NO_FIGURE,
    progress: p === null ? null : progressTextV2(p),
    // The raise is stated exactly (F74 U5: one raise, every digit), the raised part short.
    raised: p === null ? null : `${pAmountV2(p.raisedP, pDecimals)} / ${raiseShownV2(p.raiseP, pDecimals)}`,
    progressBps: p === null ? null : Number(p.progressBps),
    holders: formatCount(stats.holderCount),
    burned: tShortV2(stats.burnedT),
    volume24h: pAmountV2(stats.volume24hP, pDecimals),
    trades: formatCount(stats.tradeCount),
  };
}

/** One hour of the chart, in drawing units (0 at the top, `height` at the bottom); bounded small integers. */
export interface CandleGeometryV2 {
  readonly x: number;
  readonly open: number;
  readonly close: number;
  readonly high: number;
  readonly low: number;
  readonly up: boolean;
  readonly candle: HourlyCandleV2;
}

/**
 * The hourly candles laid out on a `width` × `height` box: one slot per hour from the first candle's hour to the last
 * (an hour with no trade leaves its slot empty, never a carried price), prices scaled between the lowest low and the
 * highest high with bigint arithmetic, so only the bounded drawing coordinates are JS numbers. A flat series sits in
 * the middle. Null without candles.
 */
export function candleGeometryV2(candles: readonly HourlyCandleV2[], width: number, height: number): { readonly slot: number; readonly candles: readonly CandleGeometryV2[] } | null {
  const first = candles[0];
  const last = candles.at(-1);
  if (!first || !last) return null;
  let low = first.low;
  let high = first.high;
  for (const c of candles) {
    if (c.low < low) low = c.low;
    if (c.high > high) high = c.high;
  }
  const hours = Number((last.start - first.start) / 3600n) + 1;
  const slot = width / Math.max(hours, 1);
  const span = high - low;
  const H = BigInt(Math.round(height * 100));
  // A price's y in hundredths of a unit: the highest price at the top.
  const y = (v: bigint): number => (span === 0n ? height / 2 : Number(((high - v) * H) / span) / 100);
  return {
    slot,
    candles: candles.map((c) => ({ x: Number((c.start - first.start) / 3600n) * slot + slot / 2, open: y(c.open), close: y(c.close), high: y(c.high), low: y(c.low), up: c.close >= c.open, candle: c })),
  };
}
