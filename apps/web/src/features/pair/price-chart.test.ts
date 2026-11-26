import type { PricePoint } from '@squarehole/domain';
import { describe, expect, it } from 'vitest';
import { TIMEFRAMES, chartGeometry, coveredTimeframes, segmentPath, type Timeframe } from './price-chart';

const ASOF = '2026-09-25T12:00:00Z';
// ORCHARD's demo series (pair-details.json): three days, one gap.
const ORCHARD: PricePoint[] = [
  { t: '2026-09-22T12:00:00Z', priceUsd: '1.80' },
  { t: '2026-09-23T00:00:00Z', priceUsd: '1.95' },
  { t: '2026-09-23T12:00:00Z', priceUsd: null },
  { t: '2026-09-24T00:00:00Z', priceUsd: '2.10' },
  { t: '2026-09-24T12:00:00Z', priceUsd: '2.25' },
  { t: '2026-09-25T00:00:00Z', priceUsd: '2.30' },
  { t: '2026-09-25T12:00:00Z', priceUsd: '2.40' },
];
const SIZE = { width: 640, height: 220 };
const frame = (id: Timeframe['id']): Timeframe => {
  const found = TIMEFRAMES.find((candidate) => candidate.id === id);
  if (!found) throw new Error(id);
  return found;
};

describe('coveredTimeframes (FEED-10, REFERENCE_OVERRIDES "7D chart on a two-day-old token")', () => {
  it('a three-day history offers 24H and All only', () => {
    expect(coveredTimeframes(ORCHARD, ASOF).map((f) => f.label)).toEqual(['24H', 'All']);
  });

  it('a window is offered only when observations reach back to its start', () => {
    const shortHistory = ORCHARD.slice(4); // from 24T12
    expect(coveredTimeframes(shortHistory, ASOF).map((f) => f.id)).toEqual(['24h', 'all']);
    expect(coveredTimeframes(ORCHARD.slice(5), ASOF).map((f) => f.id)).toEqual(['all']);
  });

  it('nothing observed, or malformed input, offers nothing', () => {
    expect(coveredTimeframes([{ t: ASOF, priceUsd: null }], ASOF)).toEqual([]);
    expect(coveredTimeframes([{ t: 'yesterday', priceUsd: '1' }], ASOF)).toEqual([]);
    expect(coveredTimeframes(ORCHARD, 'now')).toEqual([]);
  });
});

describe('chartGeometry', () => {
  it('splits the line at the gap and marks the gap band between its neighbours', () => {
    const geometry = chartGeometry(ORCHARD, ASOF, frame('all'), SIZE);
    if (!geometry) throw new Error('expected geometry');
    expect(geometry.segments.map((segment) => segment.map((point) => point.priceUsd))).toEqual([
      ['1.80', '1.95'],
      ['2.10', '2.25', '2.30', '2.40'],
    ]);
    expect(geometry.gaps).toHaveLength(1);
    const [gap] = geometry.gaps;
    const [first, second] = geometry.segments;
    expect(gap?.t).toBe('2026-09-23T12:00:00Z');
    expect(gap?.x0).toBeCloseTo(first?.at(-1)?.x ?? NaN);
    expect(gap?.x1).toBeCloseTo(second?.[0]?.x ?? NaN);
    expect(geometry.points).toEqual(ORCHARD);
  });

  it('maps price to height monotonically inside the plot, the latest point last', () => {
    const geometry = chartGeometry(ORCHARD, ASOF, frame('all'), SIZE);
    if (!geometry) throw new Error('expected geometry');
    const points = geometry.segments.flat();
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i]?.y ?? 0).toBeLessThan(points[i - 1]?.y ?? 0); // prices rise → y falls
      expect(points[i]?.x ?? 0).toBeGreaterThan(points[i - 1]?.x ?? 0);
    }
    for (const point of points) {
      expect(point.y).toBeGreaterThanOrEqual(geometry.plot.top);
      expect(point.y).toBeLessThanOrEqual(geometry.plot.bottom);
    }
    expect(geometry.last?.priceUsd).toBe('2.40');
    expect(geometry.yTicks.map((tick) => tick.label)).toEqual(['$2.4', '$1.8']);
  });

  it('24H keeps only the last day of observations', () => {
    const geometry = chartGeometry(ORCHARD, ASOF, frame('24h'), SIZE);
    expect(geometry?.points.map((point) => point.priceUsd)).toEqual(['2.25', '2.30', '2.40']);
    expect(geometry?.gaps).toEqual([]);
  });

  it('compares prices exactly (bigint), whatever their decimal places', () => {
    const geometry = chartGeometry(
      [
        { t: '2026-09-25T10:00:00Z', priceUsd: '0.000000000000000001' },
        { t: '2026-09-25T11:00:00Z', priceUsd: '0.000000000000000002' },
        { t: '2026-09-25T12:00:00Z', priceUsd: '0.000000000000000003' },
      ],
      ASOF,
      frame('all'),
      SIZE,
    );
    const ys = geometry?.segments.flat().map((point) => point.y) ?? [];
    expect(ys).toHaveLength(3);
    expect(ys[0]).toBeGreaterThan(ys[1] ?? 0);
    expect(ys[1]).toBeGreaterThan(ys[2] ?? 0);
  });

  it('a flat series and a single point still draw', () => {
    const flat = chartGeometry(
      [
        { t: '2026-09-25T11:00:00Z', priceUsd: '2' },
        { t: '2026-09-25T12:00:00Z', priceUsd: '2.00' },
      ],
      ASOF,
      frame('all'),
      SIZE,
    );
    expect(flat?.segments[0]?.[0]?.y).toBeCloseTo(flat?.segments[0]?.[1]?.y ?? NaN);
    const single = chartGeometry([{ t: ASOF, priceUsd: '2' }], ASOF, frame('all'), SIZE);
    expect(single?.segments).toHaveLength(1);
    expect(single?.segments[0]?.[0]?.x).toBeCloseTo(SIZE.width / 2 + (56 - 16) / 2);
  });

  it('returns null when nothing observed falls in the window or data is malformed', () => {
    expect(chartGeometry([{ t: ASOF, priceUsd: null }], ASOF, frame('all'), SIZE)).toBeNull();
    expect(chartGeometry([{ t: ASOF, priceUsd: '-1' }], ASOF, frame('all'), SIZE)).toBeNull();
    expect(chartGeometry([{ t: ASOF, priceUsd: '1e3' }], ASOF, frame('all'), SIZE)).toBeNull();
    expect(chartGeometry(ORCHARD, 'soon', frame('all'), SIZE)).toBeNull();
  });

  it('segmentPath draws moves and lines', () => {
    expect(
      segmentPath([
        { x: 1, y: 2, t: 'a', priceUsd: '1' },
        { x: 3.456, y: 4, t: 'b', priceUsd: '1' },
      ]),
    ).toBe('M1.00 2.00 L3.46 4.00');
  });
});
