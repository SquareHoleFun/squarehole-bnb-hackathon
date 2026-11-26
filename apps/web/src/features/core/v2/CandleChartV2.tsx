/**
 * SH-BOX-CANDLES: a v2 box's price chart on its page, in both phases (it replaces the launch curve picture and the pool's
 * line). The founder (2026-10-28): "lets try a candle stick chart … I want to avoid making this our business … we build
 * a basic version to satisfy customer needs and stop there. … What we definitely need for candlesticks is granularity in
 * the time dimension". So: the step buttons (candles-v2.ts `CANDLE_STEPS_V2`, then Max, the default), candles and
 * volume drawn by the library as it comes (candle-canvas.ts, loaded on demand), its own drag, zoom and crosshair, and one
 * readout line under it: the open, high, low, close and volume of the candle under the crosshair, from the exact
 * candle, and nothing at rest. With no trade yet, or an answer that failed, one line says so. Graduation's progress is
 * the raise bar's (no price line of ours on the chart).
 *
 * Display only: no trading control, nothing asks a wallet.
 */
import { parseHexColor } from '@squarehole/design';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { formatUtc } from '../../fit-pair/fit-format';
import type { Fetcher } from '../core-client';
import type { CandleCanvasV2, CandlePaletteV2 } from './candle-canvas';
import { CANDLE_CHOICES_V2, DEFAULT_CANDLE_CHOICE_V2, candleLimitV2, candleReadoutV2, type CandleChoiceV2, type PriceCandleV2 } from './candles-v2';
import type { V2Snapshot, V2Source } from './indexer-v2';
import { pricePerMillionV2 } from './stats-v2';
import { useCandlesV2 } from './useCandlesV2';
import './candles-v2.css';

/** The step buttons' words. */
const CHOICE_WORD: Readonly<Record<CandleChoiceV2, string>> = { '12s': '12s', '1m': '1m', '10m': '10m', '1h': '1h', '10h': '10h', '1d': '1d', max: 'Max' };
const WORDS = Object.freeze({ reading: 'Reading prices…', unavailable: 'Price history unavailable', empty: 'No trades yet' });

/** The library, on demand: only the box page loads it; one load for every chart (a failed one is tried again next time). */
let loading: Promise<typeof import('./candle-canvas')> | null = null;
const loadCanvas = () => (loading ??= import('./candle-canvas').catch((error: unknown) => {
  loading = null;
  throw error;
}));

/** A token's colour with `alpha`, for the canvas (which cannot read CSS); `fallback` when the token is not a hex colour. */
function withAlpha(hex: string, alpha: number, fallback: string): string {
  try {
    const [r, g, b] = parseHexColor(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  } catch {
    return fallback;
  }
}

/** The chart's colours and font from the site's design tokens where it sits. */
export function paletteOfV2(element: Element): CandlePaletteV2 {
  const style = getComputedStyle(element);
  const token = (name: string) => style.getPropertyValue(name).trim();
  const up = token('--sh-positive') || '#888888';
  const down = token('--sh-negative') || '#888888';
  return {
    up,
    down,
    volumeUp: withAlpha(up, 0.35, up),
    volumeDown: withAlpha(down, 0.35, down),
    text: token('--sh-text-muted') || '#888888',
    grid: withAlpha(token('--sh-border'), 0.45, 'rgba(136, 136, 136, 0.2)'),
    font: style.fontFamily || 'sans-serif',
  };
}

/**
 * The newest candles a chart this wide asks for (candles-v2.ts `candleLimitV2`), from its own box: null before it is
 * laid out; without a layout engine (jsdom) the narrow one. Attach the returned callback ref.
 */
function useCandleLimit(): readonly [ref: (element: HTMLElement | null) => void, limit: number | null] {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const subscribe = useCallback((onChange: () => void) => {
    if (!element || typeof ResizeObserver !== 'function') return () => undefined;
    const observer = new ResizeObserver(onChange);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  const limit = useSyncExternalStore(subscribe, () => (element ? candleLimitV2(element.getBoundingClientRect().width) : null), () => null);
  return [setElement, limit] as const;
}

export interface CandleChartProps {
  readonly view: V2Snapshot;
  readonly source: V2Source;
  /** The price coin's name (never "P") and the box's ticker. */
  readonly coin: string;
  readonly ticker: string;
  /** Test seam: how the candles are read. */
  readonly fetcher?: Fetcher;
}

export function CandleChartV2({ view, source, coin, ticker, fetcher }: CandleChartProps) {
  const [choice, setChoice] = useState<CandleChoiceV2>(DEFAULT_CANDLE_CHOICE_V2);
  /** Presses of Max: each one shows the box's whole life again, wherever the visitor moved the chart. */
  const [maxPresses, setMaxPresses] = useState(0);
  const [measure, limit] = useCandleLimit();
  const candles = useCandlesV2(source, view, choice, limit, fetcher);
  const [plot, setPlot] = useState<HTMLDivElement | null>(null);
  const [canvas, setCanvas] = useState<CandleCanvasV2 | null>(null);
  const [drawFailed, setDrawFailed] = useState(false);
  const [hovered, setHovered] = useState<bigint | null>(null);

  // The library loads once the chart is on the page; it follows the plot's size itself.
  useEffect(() => {
    if (!plot) return;
    let gone = false;
    let made: CandleCanvasV2 | null = null;
    loadCanvas()
      .then(({ createCandleCanvasV2 }) => {
        if (gone) return;
        made = createCandleCanvasV2(plot, paletteOfV2(plot), setHovered);
        setCanvas(made);
      })
      .catch(() => {
        if (!gone) setDrawFailed(true);
      });
    return () => {
      gone = true;
      made?.destroy();
    };
  }, [plot]);

  const answer = candles.status === 'ready' ? candles.answer : null;
  const shown: readonly PriceCandleV2[] = useMemo(() => answer?.candles ?? [], [answer]);
  // The newest screen on a new scene (another box, step or limit) or a press of Max; anything else (the snapshot's time
  // moving on, which the feed's 4 s read brings every block, or new candles) keeps the visitor's drag and zoom.
  const fitted = useRef<{ readonly scene: string; readonly presses: number } | null>(null);
  const ready = candles.status === 'ready';
  const until = choice === 'max' ? view.timestamp : null;
  useEffect(() => {
    if (!canvas || candles.step === null || candles.limit === null) return;
    const scene = `${view.token}|${candles.step}|${candles.limit}`;
    const fit = ready && (fitted.current?.scene !== scene || fitted.current.presses !== maxPresses);
    if (fit) fitted.current = { scene, presses: maxPresses };
    canvas.show({ step: candles.step, candles: shown, until, limit: candles.limit, pDecimals: view.decimals, fit });
  }, [canvas, ready, shown, candles.step, candles.limit, view.token, until, view.decimals, maxPresses]);

  const byStart = useMemo(() => new Map(shown.map((c) => [c.start, c])), [shown]);
  const under = hovered === null ? undefined : byStart.get(hovered);
  const message = candles.status === 'reading' ? WORDS.reading
    : candles.status === 'unavailable' || drawFailed ? WORDS.unavailable
      : shown.length === 0 ? WORDS.empty : null;
  const press = (next: CandleChoiceV2) => {
    if (next === 'max') setMaxPresses((presses) => presses + 1);
    if (next === choice && candles.status === 'unavailable') candles.retry();
    else setChoice(next);
  };
  const first = shown[0];
  const last = shown.at(-1);
  const unit = `${coin} per 1M ${ticker}`;
  return (
    <figure className="sh-candles" data-choice={choice} data-step={candles.step ?? undefined} data-status={message === null ? 'drawn' : candles.status}>
      <div className="sh-candles__steps" role="group" aria-label="Candle step">
        {CANDLE_CHOICES_V2.map((id) => (
          <button key={id} type="button" className="sh-candles__step" aria-pressed={id === choice} data-max={choice === 'max' && id === candles.step ? '' : undefined} onClick={() => press(id)}>
            {CHOICE_WORD[id]}
          </button>
        ))}
      </div>
      <div className="sh-candles__frame" ref={measure}>
        <div className="sh-candles__plot" ref={setPlot} aria-hidden="true" />
        {message ? <p className="sh-candles__message">{message}</p> : null}
      </div>
      <p className="sh-candles__readout" aria-hidden="true">
        {under ? candleReadoutV2(under, view.decimals, coin).map(([word, value], i) => <Fragment key={word}>{i > 0 ? ' ' : null}<span className="sh-candles__pair"><span className="sh-candles__word">{word}</span> {value}</span></Fragment>) : null}
      </p>
      {first && last && message === null ? (
        <figcaption className="sh-visually-hidden">
          {`Price chart, ${candles.step} candles, ${shown.length === 1 ? '1 candle' : `${shown.length} candles`} from ${formatUtc(first.start, false)} to ${formatUtc(last.start, false)}; the last close ${pricePerMillionV2(last.close, view.decimals)} ${unit}.`}
        </figcaption>
      ) : null}
    </figure>
  );
}
