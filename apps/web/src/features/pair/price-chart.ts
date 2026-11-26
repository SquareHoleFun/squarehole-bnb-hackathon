/**
 * Read-only price chart geometry (SH-012, FEED-10). Observed points only: a `null` price is a visible gap, never
 * interpolated or zero, and a timeframe is offered only when observed history covers all of it.
 *
 * Prices are decimal strings compared and scaled with bigint; only the resulting pixel offsets (bounded by the plot
 * size) and epoch-millisecond timestamps (range-checked by `parseIsoTimestamp`) become JavaScript numbers.
 */
import { decimalToString, formatUsdCompact, parseDecimal, parseIsoTimestamp, type PricePoint } from '@squarehole/domain';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export type TimeframeId = '24h' | '7d' | '30d' | 'all';

export interface Timeframe {
  readonly id: TimeframeId;
  readonly label: string;
  /** Accessible name. */
  readonly name: string;
  /** Window length; null = since the first observation. */
  readonly ms: number | null;
}

export const TIMEFRAMES: readonly Timeframe[] = [
  { id: '24h', label: '24H', name: 'Last 24 hours', ms: DAY_MS },
  { id: '7d', label: '7D', name: 'Last 7 days', ms: 7 * DAY_MS },
  { id: '30d', label: '30D', name: 'Last 30 days', ms: 30 * DAY_MS },
  { id: 'all', label: 'All', name: 'All observed history', ms: null },
];

interface TimedPoint {
  readonly t: string;
  readonly ms: number;
  readonly priceUsd: string | null;
}

function timed(points: readonly PricePoint[]): TimedPoint[] | null {
  try {
    return points.map((point) => ({ t: point.t, ms: parseIsoTimestamp(point.t), priceUsd: point.priceUsd }));
  } catch {
    return null;
  }
}

/**
 * Timeframes whose whole window lies inside the observed history ending at `asOf`, plus "All". A two-day history
 * never gets a 7D button (REFERENCE_OVERRIDES "7D chart on a two-day-old token").
 */
export function coveredTimeframes(points: readonly PricePoint[], asOf: string): Timeframe[] {
  const series = timed(points);
  const first = series?.find((point) => point.priceUsd !== null);
  if (!series || !first) return [];
  let end: number;
  try {
    end = parseIsoTimestamp(asOf);
  } catch {
    return [];
  }
  return TIMEFRAMES.filter((frame) => frame.ms === null || first.ms <= end - frame.ms);
}

export interface ChartPoint {
  readonly x: number;
  readonly y: number;
  readonly t: string;
  readonly priceUsd: string;
}

export interface ChartGap {
  readonly x: number;
  /** Band between the neighbouring observations (or the plot edge). */
  readonly x0: number;
  readonly x1: number;
  readonly t: string;
}

export interface ChartGeometry {
  readonly width: number;
  readonly height: number;
  readonly plot: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
  /** Runs of consecutive observations; a gap always starts a new run. */
  readonly segments: readonly (readonly ChartPoint[])[];
  readonly gaps: readonly ChartGap[];
  readonly yTicks: readonly { readonly y: number; readonly label: string }[];
  readonly xTicks: readonly { readonly x: number; readonly t: string }[];
  readonly last: ChartPoint | null;
  /** Points inside the window, in order (observations and gaps), for the text table. */
  readonly points: readonly PricePoint[];
}

export interface ChartSize {
  readonly width: number;
  readonly height: number;
}

const PAD = { left: 56, right: 16, top: 16, bottom: 28 } as const;
const PX_SCALE = 100n; // hundredths of a pixel

/** Scales every observed price to one common decimal scale (exact bigint units). */
function commonScale(prices: readonly string[]): { units: bigint[]; scale: number } {
  const parsed = prices.map(parseDecimal);
  const scale = Math.max(0, ...parsed.map((p) => p.scale));
  return { units: parsed.map((p) => p.units * 10n ** BigInt(scale - p.scale)), scale };
}

/**
 * Geometry for the points inside `frame` ending at `asOf`, or null when nothing observed is left to draw.
 * Throws nothing on malformed input; malformed data yields null.
 */
export function chartGeometry(points: readonly PricePoint[], asOf: string, frame: Timeframe, size: ChartSize): ChartGeometry | null {
  const series = timed(points);
  let end: number;
  try {
    end = parseIsoTimestamp(asOf);
  } catch {
    return null;
  }
  if (!series) return null;
  const start = frame.ms === null ? (series[0]?.ms ?? end) : end - frame.ms;
  const inside = series.filter((point) => point.ms >= start && point.ms <= end);
  const observed = inside.filter((point): point is TimedPoint & { priceUsd: string } => point.priceUsd !== null);
  if (observed.length === 0) return null;

  let scaled: { units: bigint[]; scale: number };
  try {
    scaled = commonScale(observed.map((point) => point.priceUsd));
  } catch {
    return null;
  }
  const plot = { left: PAD.left, top: PAD.top, right: size.width - PAD.right, bottom: size.height - PAD.bottom };
  const plotW = plot.right - plot.left;
  const plotH = plot.bottom - plot.top;
  const t0 = inside[0]?.ms ?? start;
  const t1 = inside.at(-1)?.ms ?? end;
  const xOf = (ms: number): number => (t1 === t0 ? plot.left + plotW / 2 : plot.left + ((ms - t0) / (t1 - t0)) * plotW);

  // Y domain: observed min..max widened by 1/8 of the range on each side (or ±1 unit for a flat line).
  const min = scaled.units.reduce((a, b) => (b < a ? b : a));
  const max = scaled.units.reduce((a, b) => (b > a ? b : a));
  const margin = max === min ? (min > 0n ? min / 8n || 1n : 1n) : (max - min) / 8n || 1n;
  const lo = min - margin < 0n ? 0n : min - margin;
  const hi = max + margin;
  const yOf = (units: bigint): number => plot.top + Number(((hi - units) * BigInt(plotH) * PX_SCALE) / (hi - lo)) / Number(PX_SCALE);

  const byTime = new Map(observed.map((point, index) => [point.ms, scaled.units[index] ?? 0n]));
  const segments: ChartPoint[][] = [];
  const gaps: ChartGap[] = [];
  let run: ChartPoint[] = [];
  inside.forEach((point, index) => {
    if (point.priceUsd === null) {
      if (run.length > 0) segments.push(run);
      run = [];
      const prev = inside[index - 1];
      const next = inside[index + 1];
      gaps.push({ x: xOf(point.ms), x0: prev ? xOf(prev.ms) : plot.left, x1: next ? xOf(next.ms) : plot.right, t: point.t });
      return;
    }
    run.push({ x: xOf(point.ms), y: yOf(byTime.get(point.ms) ?? 0n), t: point.t, priceUsd: point.priceUsd });
  });
  if (run.length > 0) segments.push(run);

  const label = (units: bigint): string => formatUsdCompact(decimalToString({ units, scale: scaled.scale }));
  const yTicks = [max, min === max ? null : min].flatMap((units) => (units === null ? [] : [{ y: yOf(units), label: label(units) }]));
  const xTicks = inside.length > 1 ? [inside[0], inside.at(-1)] : [inside[0]];
  const lastRun = segments.at(-1);
  return {
    width: size.width,
    height: size.height,
    plot,
    segments,
    gaps,
    yTicks,
    xTicks: xTicks.flatMap((point) => (point ? [{ x: xOf(point.ms), t: point.t }] : [])),
    last: lastRun?.at(-1) ?? null,
    points: inside.map((point) => ({ t: point.t, priceUsd: point.priceUsd })),
  };
}

/** SVG path for one run ("M x y L x y …"), rounded to 0.01 px. */
export function segmentPath(segment: readonly ChartPoint[]): string {
  return segment.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
}
