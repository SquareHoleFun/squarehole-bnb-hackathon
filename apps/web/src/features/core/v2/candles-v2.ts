/**
 * SH-BOX-CANDLES: a v2 box's price candles, as the indexer serves them ready-made, one cached answer per box and step
 * (`GET /v2/boxes/<chain>/<token>/candles?interval=<step>&limit=<n>`: the newest n candles, oldest first, each the
 * open, high, low and close of √price after the swaps in its bucket, the P volume and the trade count). The founder
 * (2026-10-28): "What we definitely need for candlesticks is granularity in the time dimension", and nothing beyond a
 * basic chart. Pure functions; the reads are useCandlesV2.ts, the picture CandleChartV2.tsx.
 *
 * Exact math, bigint only: a price is raw P per whole T × 10^18 (the indexer's `pricePPerTX18`, life-chart.ts), shown
 * per 1M T like every price of the site (`pricePerMillionV2`). Only the chart's drawing values are JS numbers.
 */
import { object, raw } from './indexer-v2';
import { pricePPerTX18Of } from './life-chart';
import { pAmountV2, pricePerMillionV2, type StatisticsV2 } from './stats-v2';

/**
 * The steps, finest first: the route's `interval` and its bucket in seconds. One line each, so a step the founder adds,
 * drops or renames is a one-line edit. Max is not a step: it picks one of these (`maxStepV2`).
 */
export const CANDLE_STEPS_V2 = Object.freeze([
  { id: '12s', seconds: 12n },
  { id: '1m', seconds: 60n },
  { id: '10m', seconds: 600n },
  { id: '1h', seconds: 3_600n },
  { id: '10h', seconds: 36_000n },
  { id: '1d', seconds: 86_400n },
] as const);
export type CandleStepV2 = (typeof CANDLE_STEPS_V2)[number]['id'];
/** What the step buttons choose: a step, or Max (the box's whole life on one screen, the default). */
export type CandleChoiceV2 = CandleStepV2 | 'max';
export const CANDLE_CHOICES_V2: readonly CandleChoiceV2[] = Object.freeze([...CANDLE_STEPS_V2.map((step) => step.id), 'max' as const]);
export const DEFAULT_CANDLE_CHOICE_V2: CandleChoiceV2 = 'max';

/**
 * The two `limit`s the page asks for, so the server's cache keys stay few: the newest candles a narrow chart (a phone)
 * and a wide one show, about 3 px or more each. A chart at least `WIDE_CHART_PX` wide is wide.
 */
export const CANDLE_LIMITS_V2 = Object.freeze({ narrow: 120, wide: 300 });
export const WIDE_CHART_PX = 640;
export const candleLimitV2 = (widthPx: number): number => (widthPx >= WIDE_CHART_PX ? CANDLE_LIMITS_V2.wide : CANDLE_LIMITS_V2.narrow);

const stepOf = (id: CandleStepV2) => CANDLE_STEPS_V2.find((step) => step.id === id) as (typeof CANDLE_STEPS_V2)[number];
export const stepSecondsV2 = (id: CandleStepV2): bigint => stepOf(id).seconds;

/** One candle in the site's price unit: raw P per whole T × 10^18 (the indexer's `pricePPerTX18`), rounded down. */
export interface PriceCandleV2 {
  /** The bucket's start, Unix seconds. */
  readonly start: bigint;
  readonly open: bigint;
  readonly high: bigint;
  readonly low: bigint;
  readonly close: bigint;
  /** Raw P the counted swaps moved (the hook's, the executor's and the buy-backs' swaps move the price, not the volume). */
  readonly volumeP: bigint;
  readonly trades: number;
}

export interface CandleAnswerV2 {
  readonly step: CandleStepV2;
  /** The indexer's head the answer names (null when it names none). */
  readonly asOfBlock: bigint | null;
  /** Oldest first, at most the `limit` asked for. */
  readonly candles: readonly PriceCandleV2[];
}

/** The route of one box's candles at one step. */
export const candlesUrlV2 = (origin: string, chainId: number, token: string, step: CandleStepV2, limit: number): string =>
  `${origin}/v2/boxes/${chainId}/${token.toLowerCase()}/candles?interval=${step}&limit=${limit}`;

const count = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error('Invalid candle trade count');
  return v;
};

/**
 * One answer of the candle route for `step`, refused whole when anything is off: another interval, a malformed number, a
 * √price of 0, starts that do not ascend, an open or a close outside its low and high. √price is converted to the
 * price; P is currency0 in core v2, so the price falls as √price rises, and the high and the low are taken from all four
 * prices, whichever way they run. An answer longer than `limit` (a server that does not page yet) keeps its newest.
 */
export function parseCandlesV2(input: unknown, step: CandleStepV2, limit: number): CandleAnswerV2 {
  const body = object(input);
  if (body.interval !== step) throw new Error('Candles of another step');
  if (!Array.isArray(body.candles)) throw new Error('Candles missing');
  const asOf = body.asOf === null || body.asOf === undefined ? null : object(body.asOf);
  let previous = -1n;
  const candles = body.candles.map((item): PriceCandleV2 => {
    const c = object(item);
    const start = raw(c.start);
    const [open, high, low, close] = [raw(c.openSqrtPriceX96), raw(c.highSqrtPriceX96), raw(c.lowSqrtPriceX96), raw(c.closeSqrtPriceX96)];
    if (start <= previous) throw new Error('Candles do not ascend');
    if (low === 0n || low > high || open < low || open > high || close < low || close > high) throw new Error('Candle outside its range');
    previous = start;
    const prices = [open, high, low, close].map(pricePPerTX18Of);
    return Object.freeze({
      start,
      open: prices[0] as bigint,
      high: prices.reduce((a, b) => (b > a ? b : a)),
      low: prices.reduce((a, b) => (b < a ? b : a)),
      close: prices[3] as bigint,
      volumeP: raw(c.volumeQ),
      trades: count(c.trades),
    });
  });
  return Object.freeze({ step, asOfBlock: asOf ? raw(asOf.block) : null, candles: Object.freeze(candles.slice(-limit)) });
}

// ------------------------------------------------------------------------------------------------ Max

/**
 * When the box started, for Max: its creation time if the snapshot carries one (it does not today: the record has its
 * creation block, not its time), otherwise its first candle. The snapshot's own hourly candles (the indexer keeps the last
 * 168 hours) hold the first one when they hold every counted trade (a box younger than a week): the start of the hour of
 * its first swap. Null otherwise: the page reads the box's 1d candles and takes the first.
 */
export function boxStartV2(statistics: StatisticsV2 | null | undefined): bigint | null {
  const hours = statistics?.hourlyCandles ?? [];
  const first = hours[0];
  if (!statistics || !first || statistics.tradeCount === 0n) return null;
  const counted = hours.reduce((sum, hour) => sum + hour.tradeCount, 0n);
  return counted === statistics.tradeCount ? first.start : null;
}

/** How many buckets of `seconds` (Unix-epoch aligned) the time from `start` to `now` touches. */
export const bucketsOverV2 = (start: bigint, now: bigint, seconds: bigint): bigint => (now <= start ? 1n : now / seconds - start / seconds + 1n);

/** Max: the finest step whose buckets over the box's life, `start` to `now`, are at most `limit`; else the coarsest. */
export function maxStepV2(start: bigint, now: bigint, limit: number): CandleStepV2 {
  const found = CANDLE_STEPS_V2.find((step) => bucketsOverV2(start, now, step.seconds) <= BigInt(limit));
  return (found ?? (CANDLE_STEPS_V2.at(-1) as (typeof CANDLE_STEPS_V2)[number])).id;
}

/** At most this many slots on the time axis; a longer stretch shows its candles side by side, without the empty ones. */
export const TIME_SLOTS_MAX = 3_000;

/**
 * The bucket starts of the chart's time axis: every bucket from the first candle's to the last one's, or on to the one
 * `until` falls in (Max: the box's whole life up to now), so time runs evenly and a bucket without a swap is an empty
 * slot, never a carried price. Null when that is more than `TIME_SLOTS_MAX` slots (the candles then stand side by side)
 * or there is no candle.
 */
export function timeSlotsV2(candles: readonly PriceCandleV2[], step: CandleStepV2, until: bigint | null): bigint[] | null {
  const first = candles[0];
  const last = candles.at(-1);
  if (!first || !last) return null;
  const size = stepSecondsV2(step);
  const bucket = until === null ? last.start : (until / size) * size;
  const end = bucket > last.start ? bucket : last.start;
  if ((end - first.start) / size + 1n > BigInt(TIME_SLOTS_MAX)) return null;
  const slots: bigint[] = [];
  for (let start = first.start; start <= end; start += size) slots.push(start);
  // A candle off the grid (a server that buckets otherwise) keeps its own place.
  const grid = new Set(slots);
  return candles.some((c) => !grid.has(c.start)) ? [...new Set([...slots, ...candles.map((c) => c.start)])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) : slots;
}

// ------------------------------------------------------------------------------------------------ numbers

const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉';

/**
 * A decimal with many zeros after its point in the zero-count notation of price charts: "0.000000012" is "0.0₇12" (seven
 * zeros, counted). Fewer than `from` zeros, or any other decimal, as it is.
 */
export function zeroCountV2(decimal: string, from = 4): string {
  const match = /^(-?)0\.(0+)(\d+)$/.exec(decimal);
  if (!match || (match[2] ?? '').length < from) return decimal;
  const zeros = String((match[2] ?? '').length).replace(/\d/g, (d) => SUBSCRIPT[Number(d)] ?? d);
  return `${match[1]}0.0${zeros}${match[3]}`;
}

/**
 * The significant digits the chart keeps of an amount: 15, as many as a float holds exactly (a decimal of 15 digits
 * comes back from the float nearest to it unchanged). Fix round 2, F3: each amount keeps its own 15, whatever the
 * series' high.
 */
export const CHART_DIGITS_V2 = 15;

/** `amount` cut to its first `digits` significant digits, the rest zeros (truncated, as the site's prices are). */
export function significantV2(amount: bigint, digits = CHART_DIGITS_V2): bigint {
  const cut = amount.toString().length - digits;
  if (amount <= 0n || cut <= 0) return amount;
  const unit = 10n ** BigInt(cut);
  return (amount / unit) * unit;
}

/**
 * A price (raw P per whole T × 10^18) per 1M T as the chart shows it, on its axis and in its readout alike: the site's
 * price (`pricePerMillionV2`: five significant digits, whole numbers whole, truncated) of the price cut to the chart's
 * 15 digits, zeros counted. Below 10^15 per 1M T that is the site's own text; only the chart uses it.
 */
export const candlePriceV2 = (pricePPerTX18: bigint, pDecimals: number): string => zeroCountV2(pricePerMillionV2(significantV2(pricePPerTX18), pDecimals));

/**
 * The power of ten the chart divides amounts by, so the library draws numbers of four to five digits before the point
 * at the series' high whatever the box's price or volume: from the largest of `amounts`; 0 without any. It sets where
 * the numbers sit, not how many digits they keep (`drawValueV2`).
 */
export function drawScaleV2(amounts: readonly bigint[]): number {
  let high = 0n;
  for (const amount of amounts) if (amount > high) high = amount;
  return Math.max(0, high.toString().length - 4);
}

/**
 * An amount (a price, a volume) as the chart draws it, amount ÷ 10^scale: its own first 15 significant digits, cut in
 * bigint, written as a decimal and read as the float nearest to it. So every amount keeps its digits, a small candle
 * next to a large high as well as a price above 10^12, and none becomes 0; the raw amount itself never is a number.
 */
export function drawValueV2(amount: bigint, scale: number): number {
  if (amount <= 0n) return 0;
  const digits = amount.toString();
  const cut = Math.max(0, digits.length - CHART_DIGITS_V2);
  return Number(`${digits.slice(0, digits.length - cut)}e${cut - scale}`);
}

/**
 * A value the chart drew (an axis mark, the crosshair's price, the last price: the library's own floats) back as the
 * amount it stands for, in bigint, at the precision the chart draws with: the value's 15 significant digits (the float's
 * nearest decimal of 15) × 10^scale. A candle's own value comes back as its amount cut to 15 digits, exactly. Null
 * below zero (the room under the lowest candle) or for no number.
 */
export function drawnPriceV2(value: number, scale: number): bigint | null {
  if (!Number.isFinite(value) || value < 0) return null;
  if (value === 0) return 0n;
  const [mantissa = '0', exponent = '0'] = value.toExponential(CHART_DIGITS_V2 - 1).split('e');
  const digits = BigInt(mantissa.replace('.', ''));
  const shift = Number(exponent) - (CHART_DIGITS_V2 - 1) + scale;
  return shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift);
}

/**
 * The chart's price axis: a drawn value labelled by the readout's own helper (`candlePriceV2`), so the axis and the
 * readout never disagree: a candle's price reads the same on the axis and in the readout, whole or fractional, large or
 * small (both are the price cut to the 15 digits the drawing keeps). Nothing below zero.
 */
export function axisPriceV2(value: number, scale: number, pDecimals: number): string {
  const price = drawnPriceV2(value, scale);
  return price === null ? '' : candlePriceV2(price, pDecimals);
}

/** The finest base the axis may mark with: steps of 10^-12 are about the library's own float tolerance (10^-14). */
const BASE_MAX_POWER = 12;

/**
 * The library's price base for these drawn values (10^k, its finest axis step 10^-k): fine enough to mark the smallest
 * positive value to five digits, so a run of small candles zoomed in still gets its marks; 10^4 when every value is 1 or
 * more (the series' high draws as 1,000 to 9,999), at most 10^12.
 */
export function drawBaseV2(values: readonly number[]): number {
  let low = Number.POSITIVE_INFINITY;
  for (const value of values) if (value > 0 && value < low) low = value;
  const power = Number.isFinite(low) ? 4 - Math.floor(Math.log10(low)) : 4;
  return 10 ** Math.min(BASE_MAX_POWER, Math.max(4, power));
}

/**
 * The readout of the candle under the crosshair, from the exact candle: open, high, low and close per 1M T, and the
 * volume in the price coin; each a word and its value.
 */
export function candleReadoutV2(candle: PriceCandleV2, pDecimals: number, coin: string): readonly (readonly [string, string])[] {
  const p = (price: bigint) => candlePriceV2(price, pDecimals);
  return [['O', p(candle.open)], ['H', p(candle.high)], ['L', p(candle.low)], ['C', p(candle.close)], ['Vol', `${pAmountV2(candle.volumeP, pDecimals)} ${coin}`]];
}
