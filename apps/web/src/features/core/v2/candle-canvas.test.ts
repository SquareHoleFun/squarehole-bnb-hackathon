/**
 * SH-BOX-CANDLES: the drawing (candle-canvas.ts) against a stand-in for Lightweight Charts (jsdom has no canvas): the
 * library as it comes, its attribution logo left on; a vertical swipe scrolls the page; the site's colours; candles on
 * an even time axis; volume; no price line of ours (fix round 1, F5); prices and volumes cut to their own 15 digits in
 * bigint before they become floats, the axis labelled by the readout's own helper and stepped down to the smallest
 * candle (F3, fix rounds 1 and 2); the crosshair's candle told by its start.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { candlePriceV2, type PriceCandleV2 } from './candles-v2';

type Options = Record<string, unknown>;
interface FakeSeries { kind: string; options: Options; data: unknown[]; lines: { options: Options; removed: boolean }[]; applied: Options[] }
const lib = vi.hoisted(() => ({
  chart: null as null | { options: Options; applied: Options[]; series: FakeSeries[]; scales: Record<string, Options[]>; ranges: unknown[]; hover: ((param: unknown) => void) | null; removed: boolean },
}));

vi.mock('lightweight-charts', () => {
  const series = (kind: string, options: Options): FakeSeries & Record<string, unknown> => {
    const made: FakeSeries & Record<string, unknown> = {
      kind, options, data: [], lines: [], applied: [],
      setData(data: unknown[]) { made.data = data; },
      applyOptions(next: Options) { made.applied.push(next); },
      createPriceLine(line: Options) {
        const entry = { options: line, removed: false };
        made.lines.push(entry);
        return { applyOptions: (next: Options) => Object.assign(entry.options, next), entry };
      },
      removePriceLine(line: { entry: { removed: boolean } }) { line.entry.removed = true; },
    };
    return made;
  };
  return {
    ColorType: { Solid: 'solid' },
    LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
    CandlestickSeries: { type: 'Candlestick' },
    HistogramSeries: { type: 'Histogram' },
    createChart: (_element: HTMLElement, options: Options) => {
      const chart = {
        options, applied: [] as Options[], series: [] as FakeSeries[], scales: {} as Record<string, Options[]>, ranges: [] as unknown[], hover: null as ((param: unknown) => void) | null, removed: false,
      };
      lib.chart = chart;
      return {
        addSeries: (definition: { type: string }, seriesOptions: Options) => {
          const made = series(definition.type, seriesOptions);
          chart.series.push(made);
          return made;
        },
        priceScale: (id: string) => ({ applyOptions: (next: Options) => { (chart.scales[id] ??= []).push(next); } }),
        timeScale: () => ({ setVisibleLogicalRange: (range: unknown) => chart.ranges.push(range) }),
        applyOptions: (next: Options) => chart.applied.push(next),
        subscribeCrosshairMove: (handler: (param: unknown) => void) => { chart.hover = handler; },
        unsubscribeCrosshairMove: () => { chart.hover = null; },
        remove: () => { chart.removed = true; },
      };
    },
  };
});

const { createCandleCanvasV2 } = await import('./candle-canvas');
const palette = { up: '#62dca3', down: '#ff8ca8', volumeUp: 'rgba(98, 220, 163, 0.35)', volumeDown: 'rgba(255, 140, 168, 0.35)', text: '#899ab6', grid: 'rgba(48, 65, 93, 0.45)', font: 'Plus Jakarta Sans Variable' };
const candle = (start: bigint, open: bigint, close: bigint, volumeP = 0n): PriceCandleV2 => ({ start, open, high: open > close ? open : close, low: open < close ? open : close, close, volumeP, trades: 1 });
// Prices per 1M T of an 18-decimal coin: 1.2 × 10^-8 and 1.5 × 10^-8 (raw P per whole T × 10^18).
const P1 = 12_000_000_000_000_000_000_000n;
const P2 = 15_000_000_000_000_000_000_000n;
const chart = () => lib.chart as NonNullable<typeof lib.chart>;
const candleSeries = () => chart().series[0] as FakeSeries & { options: { priceFormat: { formatter: (value: number) => string; base: number; minMove: number }; autoscaleInfoProvider?: unknown } };
/** The price format the last scene applied. */
const appliedFormat = () => (candleSeries().applied.at(-1) as { priceFormat: { type: string; formatter: (value: number) => string; base: number; minMove: number } }).priceFormat;

beforeEach(() => { lib.chart = null; });

describe('the chart as it comes', () => {
  it('its attribution logo left on; a vertical swipe scrolls the page; the site’s colours and font; English dates', () => {
    createCandleCanvasV2(document.createElement('div'), palette, () => undefined);
    const options = chart().options as { layout: Options; handleScroll: Options; handleScale?: unknown; grid: Options; localization: Options; autoSize: boolean };
    expect(options.layout).toMatchObject({ textColor: palette.text, fontFamily: palette.font });
    expect('attributionLogo' in options.layout).toBe(false);
    expect(options.handleScroll).toEqual({ vertTouchDrag: false });
    // Pinch and the sideways drag stay the library's own.
    expect(options.handleScale).toBeUndefined();
    expect(options.autoSize).toBe(true);
    expect(options.grid).toEqual({ vertLines: { color: palette.grid }, horzLines: { color: palette.grid } });
    expect(options.localization.locale).toBe('en-GB');
    expect(candleSeries().options).toMatchObject({ upColor: 'transparent', borderUpColor: palette.up, downColor: palette.down });
    expect(chart().series.map((s) => s.kind)).toEqual(['Candlestick', 'Histogram']);
    expect(chart().series[1]?.options).toMatchObject({ priceScaleId: 'volume', lastValueVisible: false, priceLineVisible: false });
  });
});

describe('a scene', () => {
  it('candles on an even time axis on to now (Max), an empty slot for a bucket without a swap; volume; the newest screen', () => {
    const canvas = createCandleCanvasV2(document.createElement('div'), palette, () => undefined);
    canvas.show({ step: '1m', candles: [candle(60n, P1, P2, 10n ** 18n), candle(180n, P2, P1)], until: 299n, limit: 120, pDecimals: 18, fit: true });
    const data = candleSeries().data as Options[];
    expect(data.map((bar) => [bar.time, 'open' in bar])).toEqual([[60, true], [120, false], [180, true], [240, false]]);
    // Floats of four to five digits: 1.5 × 10^22 ÷ 10^19.
    expect(data[0]).toMatchObject({ open: 1200, close: 1500, high: 1500, low: 1200 });
    // Volumes on their own scale the same way: 10^18 raw ÷ 10^15.
    expect(chart().series[1]?.data).toEqual([{ time: 60, value: 1000, color: palette.volumeUp }, { time: 180, value: 0, color: palette.volumeDown }]);
    expect(chart().ranges).toEqual([{ from: -0.5, to: 3.5 }]);
    expect(chart().applied).toEqual([{ timeScale: { timeVisible: true, secondsVisible: false } }]);
    // The axis labels the floats back as prices per 1M T, the zeros counted; its finest step 10^-4 (every value 1 or more).
    expect(candleSeries().options.priceFormat.formatter(1200)).toBe('0.0₇12');
    expect(candleSeries().options.priceFormat).toMatchObject({ type: 'custom', base: 10 ** 4 });
    expect(appliedFormat()).toMatchObject({ type: 'custom', base: 10 ** 4, minMove: 1 / 10 ** 4 });
    // A refresh that keeps the visitor's view: no new range.
    canvas.show({ step: '1m', candles: [candle(60n, P1, P2)], until: null, limit: 120, pDecimals: 18, fit: false });
    expect(chart().ranges).toHaveLength(1);
  });

  it('more slots than one screen: the newest `limit`; days without seconds or times', () => {
    const canvas = createCandleCanvasV2(document.createElement('div'), palette, () => undefined);
    const many = Array.from({ length: 10 }, (_, i) => candle(BigInt(i) * 86_400n, P1, P1));
    canvas.show({ step: '1d', candles: many, until: null, limit: 4, pDecimals: 18, fit: true });
    expect(chart().ranges).toEqual([{ from: 5.5, to: 9.5 }]);
    expect(chart().applied).toEqual([{ timeScale: { timeVisible: false, secondsVisible: false } }]);
    canvas.show({ step: '12s', candles: many.slice(0, 1), until: null, limit: 4, pDecimals: 18, fit: true });
    expect(chart().applied.at(-1)).toEqual({ timeScale: { timeVisible: true, secondsVisible: true } });
  });

  it('no price line of ours and no autoscale of ours (F5): the price scale is the candles\' own', () => {
    const canvas = createCandleCanvasV2(document.createElement('div'), palette, () => undefined);
    canvas.show({ step: '1m', candles: [candle(60n, P1, P2)], until: null, limit: 120, pDecimals: 18, fit: true });
    expect(candleSeries().lines).toEqual([]);
    expect(candleSeries().options.autoscaleInfoProvider).toBeUndefined();
  });

  it('a price far beyond 2^53 is scaled in bigint before it is a float, and the axis reads it as the readout does (F3)', () => {
    const canvas = createCandleCanvasV2(document.createElement('div'), palette, () => undefined);
    // The Alchemist box's closes as api.squarehole.fun answered (raw P per whole T × 10^18, 33 digits).
    const close = 483809987836201606114851694026802n;
    const bootstrap = 32655944502844340255738282104721n;
    canvas.show({ step: '1m', candles: [candle(60n, bootstrap, bootstrap), candle(120n, close, close, 100974445980372006760603n)], until: null, limit: 120, pDecimals: 18, fit: true });
    const [first, last] = candleSeries().data as { close: number }[];
    // ÷ 10^29, each its own first 15 digits cut in bigint, then the nearest floats.
    expect([first?.close, last?.close]).toEqual([326.559445028443, 4838.09987836201]);
    // The axis label of the last close (the library's last-price label) is the readout's own text.
    const label = candleSeries().options.priceFormat.formatter(last?.close ?? 0);
    expect(label).toBe(candlePriceV2(close, 18));
    expect(label).toBe('483.8');
    expect(candleSeries().options.priceFormat.formatter(first?.close ?? 0)).toBe(candlePriceV2(bootstrap, 18));
    expect(chart().series[1]?.data).toEqual([{ time: 60, value: 0, color: palette.volumeUp }, { time: 120, value: 1009.74445980372, color: palette.volumeUp }]);
  });

  it('a small low beside a large high keeps its digits, the axis reads it as the readout does, and steps down to it (fix round 2, F3)', () => {
    const canvas = createCandleCanvasV2(document.createElement('div'), palette, () => undefined);
    // The reviewer's candle: a high of 1 per 1M T, a low of 0.0000000123456789 (raw P per whole T × 10^18).
    const high = 10n ** 30n;
    const low = 123_456_789n * 10n ** 14n;
    canvas.show({ step: '1h', candles: [{ start: 3_600n, open: high, high, low, close: low, volumeP: 0n, trades: 2 }], until: null, limit: 120, pDecimals: 18, fit: true });
    const [bar] = candleSeries().data as { high: number; low: number }[];
    expect([bar?.high, bar?.low]).toEqual([1000, 0.0000123456789]);
    expect(appliedFormat().formatter(bar?.low ?? 0)).toBe(candlePriceV2(low, 18));
    expect(appliedFormat().formatter(bar?.low ?? 0)).toBe('0.0₇12345');
    // Its finest step: five digits of the low (10^-9 of a drawing unit).
    expect(appliedFormat()).toMatchObject({ base: 10 ** 9, minMove: 1 / 10 ** 9 });
    // A price above 10^12 per 1M T: every whole digit on the axis, as in the readout.
    const large = 1_234_567_890_123n * 10n ** 30n;
    canvas.show({ step: '1h', candles: [{ start: 3_600n, open: large, high: large, low: large, close: large, volumeP: 0n, trades: 1 }], until: null, limit: 120, pDecimals: 18, fit: false });
    const [bigBar] = candleSeries().data as { close: number }[];
    expect(appliedFormat().formatter(bigBar?.close ?? 0)).toBe('1,234,567,890,123');
    expect(appliedFormat().base).toBe(10 ** 4);
  });

  it('the crosshair: the start of the candle under it, none when the pointer leaves; destroy removes the chart', () => {
    const seen: (bigint | null)[] = [];
    const canvas = createCandleCanvasV2(document.createElement('div'), palette, (start) => seen.push(start));
    chart().hover?.({ point: { x: 4, y: 5 }, time: 120, seriesData: new Map() });
    chart().hover?.({ point: undefined, time: undefined, seriesData: new Map() });
    expect(seen).toEqual([120n, null]);
    canvas.destroy();
    expect(chart().removed).toBe(true);
    expect(chart().hover).toBeNull();
  });
});
