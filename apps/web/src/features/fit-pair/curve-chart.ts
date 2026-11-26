/**
 * The curve panel's drawing (VL-2): the contract's curve as an engraved line, the bought part filled, the target as a
 * dashed line, and the markers (VL-3): a solid dot for the confirmed state, a hollow ring for the newest block while
 * it differs. x is ETH in the curve (the band's axis), y the price on a log scale, which on a Uniswap v4 curve is
 * linear in the tick. Coordinates come from bigint bps and integer ticks only; no amount passes through a float.
 */
import { curveDrawPoints, type CurveShape } from '@squarehole/indexer/client';

export const CHART = Object.freeze({ width: 640, height: 280, left: 16, right: 16, top: 16, bottom: 28 });

export interface ChartPoint {
  readonly x: number;
  readonly y: number;
}

export interface CurveChartModel {
  /** SVG path of the whole curve. */
  readonly line: string;
  /** Closed SVG path of the bought part (empty when nothing is bought). */
  readonly filled: string;
  readonly targetX: number;
  readonly confirmed: ChartPoint;
  /** The newest block's point while it differs from the confirmed one. */
  readonly head: ChartPoint | null;
  readonly baseline: number;
}

function bps(part: bigint, whole: bigint): number {
  if (whole <= 0n) return 0;
  const value = (part * 10_000n) / whole;
  return Number(value < 0n ? 0n : value > 10_000n ? 10_000n : value);
}

/** Pixel x of an ETH amount on the curve's axis (0 … the larger of the full raise and the target). */
function xOf(retainedWei: bigint, curve: CurveShape): number {
  const span = curve.raiseWei > curve.targetWei ? curve.raiseWei : curve.targetWei;
  const plot = CHART.width - CHART.left - CHART.right;
  return CHART.left + (bps(retainedWei, span) * plot) / 10_000;
}

/** Pixel y of a tick: ETH per FIT = 1.0001^(−tick), so log(price) is linear in the tick. */
function yOf(tick: number, curve: CurveShape): number {
  const clamped = Math.min(curve.tickUpper, Math.max(curve.tickLower, tick));
  const fraction = (curve.tickUpper - clamped) / (curve.tickUpper - curve.tickLower);
  const plot = CHART.height - CHART.top - CHART.bottom;
  return CHART.top + plot - fraction * plot;
}

const fmt = (value: number) => (Math.round(value * 10) / 10).toString();

export function curveChartModel(curve: CurveShape, confirmed: { retainedWei: bigint; tick: number }, head: { retainedWei: bigint; tick: number }): CurveChartModel {
  const points = curveDrawPoints(32, curve).map((point) => ({ x: xOf(point.retainedWei, curve), y: yOf(point.tick, curve), retained: point.retainedWei }));
  const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${fmt(point.x)} ${fmt(point.y)}`).join(' ');
  const baseline = CHART.height - CHART.bottom;
  const at = { x: xOf(confirmed.retainedWei, curve), y: yOf(confirmed.tick, curve) };
  const bought = points.filter((point) => point.retained < confirmed.retainedWei);
  const filled =
    confirmed.retainedWei > 0n && bought.length > 0
      ? `M${fmt(CHART.left)} ${fmt(baseline)} ${[...bought, at].map((point) => `L${fmt(point.x)} ${fmt(point.y)}`).join(' ')} L${fmt(at.x)} ${fmt(baseline)} Z`
      : '';
  const newest = { x: xOf(head.retainedWei, curve), y: yOf(head.tick, curve) };
  const differs = Math.abs(newest.x - at.x) >= 0.05 || Math.abs(newest.y - at.y) >= 0.05;
  return { line, filled, targetX: xOf(curve.targetWei, curve), confirmed: at, head: differs ? newest : null, baseline };
}
