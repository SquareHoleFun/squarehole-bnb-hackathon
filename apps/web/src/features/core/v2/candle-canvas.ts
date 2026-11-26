/**
 * SH-BOX-CANDLES: the drawing. TradingView's Lightweight Charts 5.2.1 (Apache-2.0) as it comes: candles, volume bars,
 * its own drag, zoom and crosshair. Nothing more (no indicator, drawing tool, compare, alert, setting, chart type, full
 * screen, log scale, saved layout, USD, market-cap view, trade marker or price line of our own: the founder keeps this a
 * basic chart; the pool's other platforms have the rest; the raise bar above shows how far graduation is).
 *
 * This module is the only one that imports the library, and CandleChartV2.tsx imports it on demand, so only the box page
 * loads it. The library's TradingView attribution logo stays on (its default, part of its license notice).
 *
 * The library draws floats: prices and volumes are handed over ÷ 10^scale (the series' high at four to five digits
 * before the point), each amount with its own 15 significant digits cut in bigint before it becomes a number
 * (candles-v2.ts `drawValueV2`); its axis turns them back into bigint prices at that precision and labels them with the
 * readout's own helper (`axisPriceV2`), so both read the same, and its finest step follows the smallest candle
 * (`drawBaseV2`). The readout under the chart is formatted from the exact bigint candle (CandleChartV2.tsx), never from
 * these floats.
 *
 * On a phone a vertical swipe over the chart scrolls the page (`vertTouchDrag: false`, its price axis included); a
 * sideways drag moves the chart and a pinch zooms it (the library's defaults).
 */
import { CandlestickSeries, ColorType, createChart, HistogramSeries, type MouseEventParams, type Time, type UTCTimestamp, type WhitespaceData } from 'lightweight-charts';
import { formatUtc } from '../../fit-pair/fit-format';
import { axisPriceV2, drawBaseV2, drawScaleV2, drawValueV2, timeSlotsV2, type CandleStepV2, type PriceCandleV2 } from './candles-v2';

/** The chart's colours and font, read from the site's design tokens where the chart sits (CandleChartV2.tsx). */
export interface CandlePaletteV2 {
  readonly up: string;
  readonly down: string;
  readonly volumeUp: string;
  readonly volumeDown: string;
  readonly text: string;
  readonly grid: string;
  readonly font: string;
}

/** What the chart shows. */
export interface CandleSceneV2 {
  readonly step: CandleStepV2;
  /** Oldest first. */
  readonly candles: readonly PriceCandleV2[];
  /** Max: the snapshot's time, the time axis runs on to its bucket (the box's whole life); else null, it ends at the last candle. */
  readonly until: bigint | null;
  /** The newest buckets one screen shows (the `limit` the candles were asked with). */
  readonly limit: number;
  readonly pDecimals: number;
  /** Show the newest screen (a new step, a new box, a press of Max); else the view stays where the visitor moved it. */
  readonly fit: boolean;
}

export interface CandleCanvasV2 {
  show(scene: CandleSceneV2): void;
  destroy(): void;
}

/** The library's price format: our axis labels, and its finest step, 1 ÷ `base` (a power of ten, `drawBaseV2`). */
const priceFormatOf = (formatter: (value: number) => string, base: number) => ({ type: 'custom' as const, formatter, minMove: 1 / base, base });
const seconds = (time: Time): bigint => BigInt(typeof time === 'number' ? time : 0);

/**
 * The chart in `element` (which it fills, following its size). `onHover`: the start of the candle under the crosshair,
 * or null when there is none (the pointer left, the finger lifted).
 */
export function createCandleCanvasV2(element: HTMLElement, palette: CandlePaletteV2, onHover: (start: bigint | null) => void): CandleCanvasV2 {
  let scale = 0;
  let decimals = 18;
  let step: CandleStepV2 | null = null;
  const format = (value: number) => axisPriceV2(value, scale, decimals);
  const chart = createChart(element, {
    autoSize: true,
    layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: palette.text, fontFamily: palette.font, fontSize: 12 },
    grid: { vertLines: { color: palette.grid }, horzLines: { color: palette.grid } },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.26 } },
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, maxBarSpacing: 36, rightOffset: 1 },
    handleScroll: { vertTouchDrag: false },
    localization: { locale: 'en-GB', timeFormatter: (time: Time) => formatUtc(seconds(time), step === '12s') },
  });
  const candles = chart.addSeries(CandlestickSeries, {
    // Hollow up, filled down: the direction shows without its colour too.
    upColor: 'transparent', borderUpColor: palette.up, wickUpColor: palette.up,
    downColor: palette.down, borderDownColor: palette.down, wickDownColor: palette.down,
    priceFormat: priceFormatOf(format, drawBaseV2([])),
  });
  const volume = chart.addSeries(HistogramSeries, { priceScaleId: 'volume', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
  chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

  const hover = (param: MouseEventParams<Time>) => onHover(param.point === undefined || param.time === undefined ? null : seconds(param.time));
  chart.subscribeCrosshairMove(hover);

  return {
    show(scene) {
      decimals = scene.pDecimals;
      scale = drawScaleV2(scene.candles.map((c) => c.high));
      const volumeScale = drawScaleV2(scene.candles.map((c) => c.volumeP));
      if (scene.step !== step) {
        step = scene.step;
        chart.applyOptions({ timeScale: { timeVisible: scene.step !== '1d', secondsVisible: scene.step === '12s' } });
      }
      const at = (start: bigint) => Number(start) as UTCTimestamp;
      // Time runs evenly: a bucket without a swap is an empty slot (never a carried price).
      const bars = new Map(scene.candles.map((c) => [c.start, { time: at(c.start), open: drawValueV2(c.open, scale), high: drawValueV2(c.high, scale), low: drawValueV2(c.low, scale), close: drawValueV2(c.close, scale) }]));
      // The scale may have moved: the axis is labelled again, its finest step down to the smallest candle's digits.
      candles.applyOptions({ priceFormat: priceFormatOf(format, drawBaseV2([...bars.values()].map((bar) => bar.low))) });
      const slots = timeSlotsV2(scene.candles, scene.step, scene.until);
      const data = slots === null ? [...bars.values()] : slots.map((start) => bars.get(start) ?? ({ time: at(start) } satisfies WhitespaceData<Time>));
      candles.setData(data);
      volume.setData(scene.candles.map((c) => ({ time: at(c.start), value: drawValueV2(c.volumeP, volumeScale), color: c.close >= c.open ? palette.volumeUp : palette.volumeDown })));
      // The newest screen, only when asked (`fit`): every slot when they fit (Max's do), else the newest `limit` of them.
      // A logical range, not the library's fitContent: that stops at the last candle, and Max's empty slots on to now
      // belong in it. Otherwise new data keeps the visitor's drag and zoom.
      if (scene.fit) chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, data.length - scene.limit) - 0.5, to: data.length - 0.5 });
    },
    destroy() {
      chart.unsubscribeCrosshairMove(hover);
      chart.remove();
    },
  };
}
