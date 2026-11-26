/**
 * SH-BOX-CANDLES: the chart on the box page (CandleChartV2.tsx): the step buttons (Max the default, its step marked), the
 * candles handed to the drawing (the library itself is candle-canvas.ts, faked here: jsdom has no canvas), no price line
 * of ours (fix round 1, F5), the newest screen only for a new scene or a press of Max (F4), the readout of the candle
 * under the crosshair from the exact candle and nothing at rest, one line for no trade yet or a failed step. GPU Poor's
 * recorded life (test-support/life-v2.ts) through the test route (test-support/candles-v2.ts).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fetcher } from '../core-client';
import { CandleChartV2 } from './CandleChartV2';
import { boxStartV2, maxStepV2 } from './candles-v2';
import { parseSnapshotV2, type V2Snapshot } from './indexer-v2';
import { candleAnswerV2, candlesOfItemsV2 } from './test-support/candles-v2';
import { fakeCanvas } from './test-support/candle-canvas-fake';
import { gpuPoorLifeV2, sepoliaLifeSourceV2 } from './test-support/life-v2';

vi.mock('./candle-canvas', () => import('./test-support/candle-canvas-fake'));

type Wire = Record<string, unknown>;
const source = sepoliaLifeSourceV2();

function show(stage: Parameters<typeof gpuPoorLifeV2>[0], options: { readonly steps?: readonly string[]; readonly empty?: boolean } = {}) {
  const fixture = gpuPoorLifeV2(stage);
  const view = parseSnapshotV2(fixture.body, source);
  const items = options.empty ? [] : structuredClone(fixture.activity.items as Wire[]);
  const urls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    const parsed = new URL(url);
    urls.push(parsed.search.slice(1));
    const answer = candleAnswerV2(items, parsed, fixture.activity.asOf, options.steps);
    return { ok: answer.status === 200, status: answer.status, json: async () => answer.body };
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const tree = (v: V2Snapshot) => <QueryClientProvider client={client}><CandleChartV2 view={v} source={source} coin="tNVDA" ticker="VRAM" fetcher={fetcher} /></QueryClientProvider>;
  const result = render(tree(view));
  return { view, items, urls, result, rerender: (v: V2Snapshot) => result.rerender(tree(v)) };
}
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const chart = () => document.querySelector('.sh-candles') as HTMLElement;
const steps = () => within(screen.getByRole('group', { name: 'Candle step' })).getAllByRole('button');
const lastScene = () => fakeCanvas.scenes.at(-1);
const readout = () => document.querySelector('.sh-candles__readout')?.textContent ?? '';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  fakeCanvas.reset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the steps', () => {
  it('seven buttons, Max pressed by default; the step Max shows marked; the library loaded with the chart, gone with it', async () => {
    const { result, view, urls } = show('raising');
    await flush();
    expect(steps().map((button) => [button.textContent, button.getAttribute('aria-pressed')])).toEqual([['12s', 'false'], ['1m', 'false'], ['10m', 'false'], ['1h', 'false'], ['10h', 'false'], ['1d', 'false'], ['Max', 'true']]);
    // Max: the finest step whose buckets over the box's life, from its first hour, fit a narrow chart (jsdom: no width).
    const step = maxStepV2(boxStartV2(view.statistics) as bigint, view.timestamp, 120);
    expect(chart().getAttribute('data-step')).toBe(step);
    expect(steps().filter((button) => button.hasAttribute('data-max')).map((button) => button.textContent)).toEqual([step]);
    expect(urls).toEqual([`interval=${step}&limit=120`]);
    expect(fakeCanvas.created).toBe(1);
    expect(lastScene()).toMatchObject({ step, limit: 120, until: view.timestamp, pDecimals: 18, fit: true });
    result.unmount();
    expect(fakeCanvas.destroyed).toBe(1);
  });

  it('a pressed step: its candles on the newest screen, the view left alone on a refresh of the same step', async () => {
    const { items, urls } = show('graduated');
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '1h' }));
    await flush();
    expect(screen.getByRole('button', { name: '1h' }).getAttribute('aria-pressed')).toBe('true');
    expect(urls.at(-1)).toBe('interval=1h&limit=120');
    const scene = lastScene();
    expect(scene).toMatchObject({ step: '1h', until: null, fit: true });
    expect(scene?.candles.map((c) => String(c.start))).toEqual(candlesOfItemsV2(items, '1h').map((c) => c.start));
    expect(steps().some((button) => button.hasAttribute('data-max'))).toBe(false);
  });
});

describe('no price line of ours (fix round 1, F5)', () => {
  it('on the curve as after graduation the scene carries the candles only: graduation is the raise bar\'s', async () => {
    show('raising');
    await flush();
    expect(lastScene()?.candles.length).toBeGreaterThan(0);
    expect(Object.keys(lastScene() ?? {}).sort()).toEqual(['candles', 'fit', 'limit', 'pDecimals', 'step', 'until']);
  });
});

describe('the visitor\'s view (fix round 1, F4)', () => {
  it('Max fits once; the snapshot\'s time moving on and new candles keep the view; a press of Max or a new step fits again', async () => {
    const { view, items, rerender } = show('graduated');
    await flush();
    const fits = () => fakeCanvas.scenes.filter((scene) => scene.fit).length;
    expect(lastScene()).toMatchObject({ fit: true, until: view.timestamp });
    expect(fits()).toBe(1);
    // A block later and another, the box idle: only the snapshot's time moves (the feed's 4 s read brings each block).
    for (const later of [12n, 24n, 36n]) {
      rerender({ ...view, block: view.block + later / 12n, timestamp: view.timestamp + later });
      await flush();
      expect(lastScene()).toMatchObject({ fit: false, until: view.timestamp + later });
    }
    // A trade: the figures move, the step is read again with the new candle; still the visitor's view.
    const trade = structuredClone(items.find((item) => item.kind === 'trade' && item.route === 'other') as Wire);
    items.unshift({ ...trade, id: `${view.block + 9n}-1`, block: String(view.block + 9n), logIndex: 1, timestamp: String(view.timestamp + 108n) });
    const stats = view.statistics;
    if (!stats) throw new Error('statistics expected');
    const hours = stats.hourlyCandles.map((hour, i) => (i === stats.hourlyCandles.length - 1 ? { ...hour, tradeCount: hour.tradeCount + 1n } : hour));
    rerender({ ...view, block: view.block + 9n, timestamp: view.timestamp + 108n, statistics: { ...stats, tradeCount: stats.tradeCount + 1n, hourlyCandles: hours } });
    await flush();
    expect(lastScene()?.candles.reduce((sum, c) => sum + c.trades, 0)).toBe(candlesOfItemsV2(items, lastScene()?.step ?? '1m').reduce((sum, c) => sum + Number(c.trades), 0));
    expect(lastScene()?.fit).toBe(false);
    expect(fits()).toBe(1);
    // A press of Max, Max already chosen: the box's whole life again.
    fireEvent.click(screen.getByRole('button', { name: 'Max' }));
    await flush();
    expect(lastScene()?.fit).toBe(true);
    expect(fits()).toBe(2);
    // Another step: a new scene, its newest screen; then the snapshot moving on fits nothing more.
    fireEvent.click(screen.getByRole('button', { name: '1h' }));
    await flush();
    expect(lastScene()).toMatchObject({ step: '1h', fit: true });
    expect(fits()).toBe(3);
    rerender({ ...view, block: view.block + 10n, timestamp: view.timestamp + 120n, statistics: { ...stats, tradeCount: stats.tradeCount + 1n, hourlyCandles: hours } });
    await flush();
    expect(fits()).toBe(3);
  });
});

describe('the readout', () => {
  it('the candle under the crosshair from its exact numbers; nothing at rest', async () => {
    show('graduated');
    await flush();
    expect(readout()).toBe('');
    const candle = lastScene()?.candles.find((c) => c.trades > 0);
    if (!candle) throw new Error('a candle with a trade expected');
    act(() => fakeCanvas.hover(candle.start));
    expect([...document.querySelectorAll('.sh-candles__pair')].map((pair) => pair.textContent)).toEqual(['O 0.032724', 'H 0.032724', 'L 0.032724', 'C 0.032724', 'Vol 0.03565 tNVDA']);
    expect(readout()).toBe('O 0.032724 H 0.032724 L 0.032724 C 0.032724 Vol 0.03565 tNVDA');
    // Over an empty slot, or the pointer gone: nothing.
    act(() => fakeCanvas.hover(candle.start + 1n));
    expect(readout()).toBe('');
    act(() => fakeCanvas.hover(candle.start));
    act(() => fakeCanvas.hover(null));
    expect(readout()).toBe('');
  });
});

describe('one line instead of the chart', () => {
  it('no trade yet', async () => {
    show('scheduled', { empty: true });
    await flush();
    expect(document.querySelector('.sh-candles__message')?.textContent).toBe('No trades yet');
    expect(lastScene()?.candles).toEqual([]);
  });

  it('a step the server does not answer (the live server today for 12s, 10m and 10h): unavailable, the other steps as usual; pressed again, read again', async () => {
    const { urls } = show('graduated', { steps: ['1m', '1h', '1d'] });
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '10m' }));
    await flush();
    expect(document.querySelector('.sh-candles__message')?.textContent).toBe('Price history unavailable');
    expect(lastScene()?.candles).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: '10m' }));
    await flush();
    expect(urls.filter((url) => url.startsWith('interval=10m'))).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '1d' }));
    await flush();
    expect(document.querySelector('.sh-candles__message')).toBeNull();
    expect(chart().getAttribute('data-status')).toBe('drawn');
  });
});
