/**
 * SH-BOX-CANDLES: the chart's reads (useCandlesV2.ts). One request per box and step, kept in the query cache (a step
 * read before costs nothing while the box's figures stand); the shown step read again when the figures move, and after
 * 1.5, 3 and 6 s while the answer shows nothing new, never on time alone; nothing while the tab is hidden; a read no
 * longer needed cancelled, its fetch aborted, never stored as an answer (fix round 1, F1 and F2); every unasked read
 * charged first to its query key and figures for the query client's lifetime, so a hidden tab, a step switch and back or
 * a remount never refill it (fix round 2, F2); Max from the box's age. On GPU Poor's recorded life
 * (test-support/life-v2.ts) through the test route (test-support/candles-v2.ts).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fetcher } from '../core-client';
import { boxStartV2, maxStepV2, type CandleChoiceV2 } from './candles-v2';
import { parseSnapshotV2, type V2Snapshot } from './indexer-v2';
import { candleAnswerV2 } from './test-support/candles-v2';
import { gpuPoorLifeV2, recordedLifeV2, sepoliaLifeSourceV2 } from './test-support/life-v2';
import { CANDLE_CACHE_MS, CANDLE_READS_PER_FIGURES, CANDLE_SOON_MS, CandleReadBudgetV2, candleQueryV2, CatchUpV2, readSignatureV2, type CandleReadV2, useCandlesV2 } from './useCandlesV2';

type Wire = Record<string, unknown>;
const source = sepoliaLifeSourceV2();

/** The candle route over a fixture's items; `steps`: the steps it serves; `fail`: answer 503 while set. */
function candleRoute(activity: Wire, steps?: readonly string[]) {
  const state = { items: structuredClone(activity.items as Wire[]), asOf: activity.asOf, urls: [] as string[], fail: false, steps };
  const fetcher: Fetcher = async (url) => {
    const parsed = new URL(url);
    state.urls.push(parsed.search.slice(1));
    if (state.fail) return { ok: false, status: 503, json: async () => ({ error: 'busy' }) };
    const answer = candleAnswerV2(state.items, parsed, state.asOf, state.steps);
    return { ok: answer.status === 200, status: answer.status, json: async () => answer.body };
  };
  return { state, fetcher };
}

/**
 * The route with its answers held until `release()`: each read's signal kept, and an abort rejects the read as fetch
 * does, so a test sees which reads were cancelled.
 */
function heldRoute(route: ReturnType<typeof candleRoute>) {
  const reads: { query: string; signal: AbortSignal | null | undefined; release: () => void }[] = [];
  const fetcher: Fetcher = (url, init) => new Promise((resolve, reject) => {
    const signal = init?.signal;
    reads.push({ query: new URL(url).search.slice(1), signal, release: () => void route.fetcher(url).then(resolve, reject) });
    signal?.addEventListener('abort', () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError')), { once: true });
  });
  return { reads, fetcher };
}

function setup(stage: Parameters<typeof gpuPoorLifeV2>[0] = 'graduated', options: { readonly steps?: readonly string[]; readonly client?: QueryClient; readonly limit?: number | null; readonly fail?: boolean; readonly choice?: CandleChoiceV2; readonly held?: boolean; readonly view?: (view: V2Snapshot) => V2Snapshot } = {}) {
  const fixture = gpuPoorLifeV2(stage);
  const parsed = parseSnapshotV2(fixture.body, source);
  const view = options.view ? options.view(parsed) : parsed;
  const route = candleRoute(fixture.activity, options.steps);
  route.state.fail = options.fail === true;
  const held = heldRoute(route);
  const fetcher = options.held ? held.fetcher : route.fetcher;
  const client = options.client ?? new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook((props: { view: V2Snapshot; choice: CandleChoiceV2; limit: number | null }) => useCandlesV2(source, props.view, props.choice, props.limit, fetcher), {
    wrapper, initialProps: { view, choice: options.choice ?? 'max', limit: options.limit === undefined ? 120 : options.limit },
  });
  return { view, route, client, hook, reads: held.reads };
}
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
/** The same box after a trade: its trade count moved (figuresSignatureV2), in its last hour too. */
function traded(view: V2Snapshot): V2Snapshot {
  const stats = view.statistics;
  if (!stats) throw new Error('statistics expected');
  const hours = stats.hourlyCandles.map((hour, i) => (i === stats.hourlyCandles.length - 1 ? { ...hour, tradeCount: hour.tradeCount + 1n } : hour));
  return { ...view, block: view.block + 1n, timestamp: view.timestamp + 12n, statistics: { ...stats, tradeCount: stats.tradeCount + 1n, hourlyCandles: hours } };
}
/** One more buy (a counted swap) right after the box's newest item. */
function addSwap(route: ReturnType<typeof candleRoute>, view: V2Snapshot) {
  const trade = structuredClone(route.state.items.find((item) => item.kind === 'trade' && item.route === 'other') as Wire);
  route.state.items = [{ ...trade, id: `${view.block + 1n}-1`, block: String(view.block + 1n), logIndex: 1, timestamp: String(view.timestamp + 12n) }, ...route.state.items];
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('one request per box and step', () => {
  it('reads the step with the chart’s limit; a step read before costs no request while the figures stand', async () => {
    const { hook, route, view } = setup();
    hook.rerender({ view, choice: '1h', limit: 120 });
    await flush();
    expect(hook.result.current).toMatchObject({ step: '1h', limit: 120, status: 'ready' });
    hook.rerender({ view, choice: '1d', limit: 120 });
    await flush();
    hook.rerender({ view, choice: '1h', limit: 120 });
    await flush();
    expect(route.state.urls.filter((url) => !url.startsWith('interval=1m'))).toEqual(['interval=1h&limit=120', 'interval=1d&limit=120']);
    expect(hook.result.current.answer?.step).toBe('1h');
    // A wide chart asks with the wide limit: another cache key.
    hook.rerender({ view, choice: '1h', limit: 300 });
    await flush();
    expect(route.state.urls.at(-1)).toBe('interval=1h&limit=300');
  });

  it('nothing is read before the chart is measured', async () => {
    const { hook, route, view } = setup('graduated', { limit: null });
    await flush();
    expect(hook.result.current).toMatchObject({ step: null, limit: null, status: 'reading' });
    hook.rerender({ view, choice: '1h', limit: null });
    await flush();
    expect(route.state.urls).toEqual([]);
  });
});

describe('Max', () => {
  it('picks its step from the box’s age, from the snapshot’s first hour, with one read', async () => {
    const { hook, route, view } = setup();
    await flush();
    const start = boxStartV2(view.statistics);
    expect(start).toBe(1793080800n);
    const step = maxStepV2(start as bigint, view.timestamp, 120);
    expect(step).toBe('1m');
    expect(hook.result.current).toMatchObject({ step, status: 'ready' });
    expect(route.state.urls).toEqual(['interval=1m&limit=120']);
    // Wide: 207 buckets of 12 s fit.
    hook.rerender({ view, choice: 'max', limit: 300 });
    await flush();
    expect(hook.result.current.step).toBe('12s');
  });

  it('when the snapshot’s hours do not hold every trade, the first daily candle starts the box (the 1d step’s own read)', async () => {
    const { hook, route, view } = setup();
    const older: V2Snapshot = { ...view, statistics: view.statistics ? { ...view.statistics, tradeCount: view.statistics.tradeCount + 9n } : null };
    hook.rerender({ view: older, choice: 'max', limit: 120 });
    await flush();
    expect(route.state.urls.slice(-2)).toEqual(['interval=1d&limit=120', `interval=${hook.result.current.step}&limit=120`]);
    // The first daily candle is the day's start: an older box than its hours say, so a coarser step.
    expect(hook.result.current.step).toBe(maxStepV2(1793059200n, older.timestamp, 120));
    // The 1d button then costs no request.
    const asked = route.state.urls.length;
    hook.rerender({ view: older, choice: '1d', limit: 120 });
    await flush();
    expect(route.state.urls).toHaveLength(asked);
  });
});

describe('live, at the life view’s cadence', () => {
  it('moved figures: the shown step at once, then after 1.5, 3 and 6 s while nothing new; then no more', async () => {
    const { hook, route, view } = setup();
    await flush();
    expect(route.state.urls).toEqual(['interval=1m&limit=120']);
    hook.rerender({ view: traded(view), choice: 'max', limit: 120 });
    await flush();
    expect(route.state.urls).toHaveLength(2);
    expect(CANDLE_SOON_MS).toEqual([1_500, 3_000, 6_000]);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_499); });
    expect(route.state.urls).toHaveLength(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(route.state.urls).toHaveLength(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(route.state.urls).toHaveLength(4);
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(route.state.urls).toHaveLength(5);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(route.state.urls).toHaveLength(5);
  });

  it('the bound (fix round 2, F2): each read charged before it starts, a resumed first one too; a re-read set and then stopped spent; refused once spent, by any run', async () => {
    expect(CANDLE_READS_PER_FIGURES).toBe(4);
    const budget = new CandleReadBudgetV2();
    const same: CandleReadV2 = { ok: true, answer: { step: '1m', asOfBlock: null, candles: [] }, readFor: 'f' };
    let reads = 0;
    const read = async () => { reads += 1; return same; };
    const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    const run = new CatchUpV2();
    expect(run.start(budget, 'k|f', readSignatureV2(same), read)).toBe(true);
    await tick(0);
    // The first read, and its re-read set for 1.5 s: both charged already.
    expect([reads, budget.usedBy('k|f')]).toEqual([1, 2]);
    // Stopped with that re-read pending (the tab hidden): it stays spent. A new run (a remount: another instance) on the
    // same budget: its resumed first read charged, then only the last re-read is left.
    run.stop();
    const again = new CatchUpV2();
    expect(again.start(budget, 'k|f', readSignatureV2(same), read)).toBe(true);
    await tick(0);
    expect([reads, budget.usedBy('k|f')]).toEqual([2, 4]);
    await tick(6_000);
    await tick(60_000);
    expect(reads).toBe(3);
    // Spent: refused, nothing read, however often and by whatever run it is asked.
    for (let i = 0; i < 5; i += 1) expect(new CatchUpV2().start(budget, 'k|f', readSignatureV2(same), read)).toBe(false);
    await tick(60_000);
    expect([reads, budget.spent('k|f')]).toEqual([3, true]);
    // A first read with no answer held: one read, no re-reads.
    expect(run.start(budget, 'k|g', null, read)).toBe(true);
    await tick(60_000);
    expect([reads, budget.usedBy('k|g')]).toEqual([4, 1]);
    // New figures: their own count, a read and three re-reads 1.5, 3 and 6 s apart.
    run.start(budget, 'k|h', readSignatureV2(same), read);
    for (const ms of [0, 1_500, 3_000, 6_000, 60_000]) await tick(ms);
    expect([reads, budget.usedBy('k|h')]).toEqual([8, 4]);
    run.stop();
    // The cache letting the query go takes all its counts with it.
    budget.forget('k');
    expect([budget.usedBy('k|f'), budget.usedBy('k|g'), budget.usedBy('k|h')]).toEqual([0, 0, 0]);
  });

  it('time passing without a move reads nothing: no polling (F2), however long the page stays and the blocks go by', async () => {
    const { hook, route, view } = setup();
    await flush();
    expect(route.state.urls).toEqual(['interval=1m&limit=120']);
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    // A new block every 12 s, the box idle: the snapshot's time moves, its figures do not.
    for (let t = 12n; t <= 120n; t += 12n) {
      hook.rerender({ view: { ...view, block: view.block + t / 12n, timestamp: view.timestamp + t }, choice: 'max', limit: 120 });
      await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
    }
    expect(route.state.urls).toEqual(['interval=1m&limit=120']);
  });

  it('the trade’s candle arrives on a re-read: no more re-reads, the new candle shown', async () => {
    const { hook, route, view } = setup();
    await flush();
    const before = hook.result.current.answer?.candles.reduce((sum, c) => sum + c.trades, 0) ?? 0;
    hook.rerender({ view: traded(view), choice: 'max', limit: 120 });
    await flush();
    // The history writer lags: the first read after the move shows nothing new; the swap lands before the next one.
    addSwap(route, view);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    // The query cache tells its observers on timers of its own: a moment for them under the fake clock.
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    await flush();
    expect(route.state.urls).toHaveLength(3);
    expect(hook.result.current.answer?.candles.reduce((sum, c) => sum + c.trades, 0)).toBe(before + 1);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(route.state.urls).toHaveLength(3);
  });

  it('a step read before a move is read again when it is shown again; one read before the move is not', async () => {
    const { hook, route, view } = setup();
    hook.rerender({ view, choice: '1h', limit: 120 });
    await flush();
    hook.rerender({ view, choice: '1d', limit: 120 });
    await flush();
    const moved = traded(view);
    hook.rerender({ view: moved, choice: '1d', limit: 120 });
    await flush();
    expect(route.state.urls.at(-1)).toBe('interval=1d&limit=120');
    const asked = route.state.urls.length;
    hook.rerender({ view: moved, choice: '1h', limit: 120 });
    await flush();
    expect(route.state.urls.slice(asked, asked + 1)).toEqual(['interval=1h&limit=120']);
  });

  it('nothing while the tab is hidden; shown again, the moved step is read', async () => {
    const { hook, route, view } = setup();
    await flush();
    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    hook.rerender({ view: traded(view), choice: 'max', limit: 120 });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(route.state.urls).toHaveLength(1);
    state.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(route.state.urls).toHaveLength(2);
  });

  it('coming back to the box: its answer from the cache while the figures stand, a read when they moved', async () => {
    const first = setup();
    await flush();
    first.hook.unmount();
    const again = setup('graduated', { client: first.client });
    await flush();
    expect(again.route.state.urls).toEqual([]);
    expect(again.hook.result.current.status).toBe('ready');
    again.hook.rerender({ view: traded(again.view), choice: 'max', limit: 120 });
    await flush();
    expect(again.route.state.urls).toEqual(['interval=1m&limit=120']);
  });
});

describe('a step the server does not answer', () => {
  it('is unavailable (the live server answers 400 for 12s, 10m and 10h until its update); a press reads it again, as does a move', async () => {
    const { hook, route, view } = setup('graduated', { steps: ['1m', '1h', '1d'] });
    hook.rerender({ view, choice: '10m', limit: 120 });
    await flush();
    expect(hook.result.current).toMatchObject({ step: '10m', status: 'unavailable', answer: null });
    const asked = route.state.urls.length;
    act(() => hook.result.current.retry());
    await flush();
    expect(route.state.urls).toHaveLength(asked + 1);
    hook.rerender({ view: traded(view), choice: '10m', limit: 120 });
    await flush();
    expect(route.state.urls).toHaveLength(asked + 2);
    // No re-reads after a failed read: the history lag is not the reason.
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(route.state.urls).toHaveLength(asked + 2);
  });

  it('a failed read (503) shows unavailable, then the answer once a move reads it again', async () => {
    const { hook, route, view } = setup('graduated', { fail: true });
    await flush();
    expect(hook.result.current.status).toBe('unavailable');
    route.state.fail = false;
    hook.rerender({ view: traded(view), choice: 'max', limit: 120 });
    await flush();
    expect(hook.result.current.status).toBe('ready');
  });
});

describe('a read the chart no longer needs is cancelled (fix round 1, F1)', () => {
  const key = (step: string) => ['v2-candles', source.network, source.manifest.chainId, source.origin, '0x6eaf89c9895dbaf9fd07c78bb3fae7cabf0a0fdf', step, 120] as const;

  it('the page gone: the fetch aborted, and the cancelled read is not an answer in the cache', async () => {
    const { hook, reads, client } = setup('graduated', { held: true, choice: '1h' });
    await flush();
    expect(reads.map((read) => [read.query, read.signal?.aborted])).toEqual([['interval=1h&limit=120', false]]);
    hook.unmount();
    await flush();
    expect(reads[0]?.signal?.aborted).toBe(true);
    expect(client.getQueryState(key('1h'))).toMatchObject({ data: undefined, status: 'pending', fetchStatus: 'idle' });
  });

  it('another step pressed: the read of the step left is aborted, the new one goes on', async () => {
    const { hook, reads, client, view } = setup('graduated', { held: true, choice: '1h' });
    await flush();
    hook.rerender({ view, choice: '1d', limit: 120 });
    await flush();
    expect(reads.map((read) => [read.query, read.signal?.aborted])).toEqual([['interval=1h&limit=120', true], ['interval=1d&limit=120', false]]);
    await act(async () => { reads[1]?.release(); await vi.advanceTimersByTimeAsync(0); });
    await flush();
    expect(hook.result.current).toMatchObject({ step: '1d', status: 'ready' });
    expect(client.getQueryState(key('1h'))?.data).toBeUndefined();
  });

  it('the tab hidden: the read is aborted; shown again, it is asked again and answers', async () => {
    const { hook, reads, client } = setup('graduated', { held: true, choice: '1h' });
    await flush();
    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(reads[0]?.signal?.aborted).toBe(true);
    expect(client.getQueryState(key('1h'))?.data).toBeUndefined();
    expect(reads).toHaveLength(1);
    state.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(reads.map((read) => read.signal?.aborted)).toEqual([true, false]);
    await act(async () => { reads[1]?.release(); await vi.advanceTimersByTimeAsync(0); });
    await flush();
    expect(hook.result.current.status).toBe('ready');
  });

  it('another box in the same page (the route\'s token changes, the chart stays): the first box\'s read is aborted', async () => {
    const { hook, reads, view } = setup('graduated', { held: true, choice: '1h' });
    await flush();
    const other = parseSnapshotV2(recordedLifeV2.dragonsHoard.body, source);
    expect(other.token.toLowerCase()).not.toBe(view.token.toLowerCase());
    hook.rerender({ view: other, choice: '1h', limit: 120 });
    await flush();
    expect(reads.map((read) => [read.query, read.signal?.aborted])).toEqual([['interval=1h&limit=120', true], ['interval=1h&limit=120', false]]);
  });

  it('Max\'s read of the first day, its 1d observer staying on the page: aborted when another step is pressed', async () => {
    const older = (view: V2Snapshot): V2Snapshot => ({ ...view, statistics: view.statistics ? { ...view.statistics, tradeCount: view.statistics.tradeCount + 9n } : null });
    const { hook, reads, view } = setup('graduated', { held: true, view: older });
    await flush();
    expect(reads.map((read) => [read.query, read.signal?.aborted])).toEqual([['interval=1d&limit=120', false]]);
    hook.rerender({ view, choice: '1h', limit: 120 });
    await flush();
    expect(reads.map((read) => [read.query, read.signal?.aborted])).toEqual([['interval=1d&limit=120', true], ['interval=1h&limit=120', false]]);
  });

  it('the query function: an aborted read rejects (react-query then keeps the cache as it was), a refusal or the deadline is an answer', async () => {
    const client = new QueryClient();
    const run = (fetcher: Fetcher, signal: AbortSignal) => {
      const options = candleQueryV2(source, '0x6eaf89c9895dbaf9fd07c78bb3fae7cabf0a0fdf', '1h', 120, 'figures', fetcher);
      return (options.queryFn as (context: unknown) => Promise<unknown>)({ client, queryKey: options.queryKey, signal, meta: undefined });
    };
    const hanging: Fetcher = (_url, init) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }));
    const controller = new AbortController();
    const aborted = run(hanging, controller.signal);
    controller.abort();
    await expect(aborted).rejects.toBeDefined();
    const refused: Fetcher = async () => ({ ok: false, status: 400, json: async () => ({ error: 'interval is 1m, 1h or 1d' }) });
    await expect(run(refused, new AbortController().signal)).resolves.toEqual({ ok: false, status: 400, readFor: 'figures' });
    const late = run(hanging, new AbortController().signal);
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    await expect(late).resolves.toEqual({ ok: false, status: null, readFor: 'figures' });
  });

  it('a finished answer stays: the page gone after its read, it is there for the next visit', async () => {
    const first = setup('graduated', { choice: '1h' });
    await flush();
    first.hook.unmount();
    await flush();
    expect(first.client.getQueryData(key('1h'))).toMatchObject({ ok: true });
  });
});

describe('the bound across a hidden tab, a step switch and back and a remount, one shared query client (fix round 2, F2)', () => {
  /** One query client and one held route for every mount: what the reviewer drove the real hook with. */
  function shared() {
    const fixture = gpuPoorLifeV2('graduated');
    const view = parseSnapshotV2(fixture.body, source);
    const route = candleRoute(fixture.activity);
    const held = heldRoute(route);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const mount = (props: { view: V2Snapshot; choice: CandleChoiceV2; limit: number | null }) =>
      renderHook((p: { view: V2Snapshot; choice: CandleChoiceV2; limit: number | null }) => useCandlesV2(source, p.view, p.choice, p.limit, held.fetcher), { wrapper, initialProps: props });
    const count = (step: string) => held.reads.filter((read) => read.query === `interval=${step}&limit=120`).length;
    const release = (i: number) => act(async () => { held.reads[i]?.release(); await vi.advanceTimersByTimeAsync(0); });
    return { view, reads: held.reads, client, mount, count, release };
  }
  const visibility = () => {
    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const set = async (value: 'hidden' | 'visible') => {
      state.mockReturnValue(value);
      document.dispatchEvent(new Event('visibilitychange'));
      await flush();
    };
    return { hide: () => set('hidden'), show: () => set('visible') };
  };

  it('hide then show, eight times, a read after a move pending each time: one first read and three more at most for the key and figures; the answer held stays', async () => {
    const { view, reads, mount, count, release } = shared();
    const hook = mount({ view, choice: '1h', limit: 120 });
    await flush();
    await release(0);
    await flush();
    expect(hook.result.current.status).toBe('ready');
    hook.rerender({ view: traded(view), choice: '1h', limit: 120 });
    await flush();
    const tab = visibility();
    for (let i = 0; i < 8; i += 1) {
      await tab.hide();
      await tab.show();
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    // One read for the figures before the move; four for the moved ones, each aborted by the hide after it.
    expect(count('1h')).toBe(1 + CANDLE_READS_PER_FIGURES);
    expect(reads.slice(1).map((read) => read.signal?.aborted)).toEqual([true, true, true, true]);
    expect(hook.result.current.status).toBe('ready');
  });

  it('hide then show, eight times, from no answer: four reads at most, then the step unavailable; a press reads it once more and answers', async () => {
    const { view, reads, mount, count, release } = shared();
    const hook = mount({ view, choice: '1h', limit: 120 });
    await flush();
    const tab = visibility();
    for (let i = 0; i < 8; i += 1) {
      await tab.hide();
      await tab.show();
    }
    expect(count('1h')).toBe(CANDLE_READS_PER_FIGURES);
    expect(reads.every((read) => read.signal?.aborted)).toBe(true);
    expect(hook.result.current).toMatchObject({ step: '1h', status: 'unavailable' });
    act(() => hook.result.current.retry());
    await flush();
    await release(4);
    await flush();
    expect(count('1h')).toBe(CANDLE_READS_PER_FIGURES + 1);
    expect(hook.result.current.status).toBe('ready');
  });

  it('a step switch and back, eight times, both reads pending: four reads at most for each step\'s key and figures; new figures read again', async () => {
    const { view, mount, count } = shared();
    const hook = mount({ view, choice: '1h', limit: 120 });
    await flush();
    for (let i = 0; i < 8; i += 1) {
      hook.rerender({ view, choice: '1d', limit: 120 });
      await flush();
      hook.rerender({ view, choice: '1h', limit: 120 });
      await flush();
    }
    expect([count('1h'), count('1d')]).toEqual([CANDLE_READS_PER_FIGURES, CANDLE_READS_PER_FIGURES]);
    expect(hook.result.current).toMatchObject({ step: '1h', status: 'unavailable' });
    // A move: new figures, their own count.
    hook.rerender({ view: traded(view), choice: '1h', limit: 120 });
    await flush();
    expect(count('1h')).toBe(CANDLE_READS_PER_FIGURES + 1);
  });

  it('a remount, eight times, its read pending: four reads at most for the key and figures, the count kept by the query client, not the hook', async () => {
    const { view, reads, mount, count } = shared();
    for (let i = 0; i < 8; i += 1) {
      const hook = mount({ view, choice: '1h', limit: 120 });
      await flush();
      hook.unmount();
      await flush();
    }
    expect(count('1h')).toBe(CANDLE_READS_PER_FIGURES);
    expect(reads.every((read) => read.signal?.aborted)).toBe(true);
    const last = mount({ view, choice: '1h', limit: 120 });
    await flush();
    expect(last.result.current.status).toBe('unavailable');
    expect(count('1h')).toBe(CANDLE_READS_PER_FIGURES);
  });

  it('the three paths mixed, a stale answer held: still one first read and three more at most for the moved figures', async () => {
    const { view, mount, count, release } = shared();
    let hook = mount({ view, choice: '1h', limit: 120 });
    await flush();
    await release(0);
    await flush();
    const moved = traded(view);
    hook.rerender({ view: moved, choice: '1h', limit: 120 });
    await flush();
    const tab = visibility();
    for (let i = 0; i < 3; i += 1) {
      await tab.hide();
      await tab.show();
      hook.rerender({ view: moved, choice: '1d', limit: 120 });
      await flush();
      hook.rerender({ view: moved, choice: '1h', limit: 120 });
      await flush();
      hook.unmount();
      await flush();
      hook = mount({ view: moved, choice: '1h', limit: 120 });
      await flush();
    }
    expect(count('1h')).toBe(1 + CANDLE_READS_PER_FIGURES);
    expect(count('1d')).toBeLessThanOrEqual(CANDLE_READS_PER_FIGURES);
    expect(hook.result.current.status).toBe('ready');
  });

  it('the cache letting a query go (30 min after its last observer) takes its count with it: the read that brings the answer back is a first one again', async () => {
    const { view, mount, count } = shared();
    for (let i = 0; i < CANDLE_READS_PER_FIGURES; i += 1) {
      const hook = mount({ view, choice: '1h', limit: 120 });
      await flush();
      hook.unmount();
      await flush();
    }
    const spent = mount({ view, choice: '1h', limit: 120 });
    await flush();
    expect([count('1h'), spent.result.current.status]).toEqual([CANDLE_READS_PER_FIGURES, 'unavailable']);
    spent.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(CANDLE_CACHE_MS + 1_000); });
    const again = mount({ view, choice: '1h', limit: 120 });
    await flush();
    expect([count('1h'), again.result.current.status]).toEqual([CANDLE_READS_PER_FIGURES + 1, 'reading']);
  });
});
