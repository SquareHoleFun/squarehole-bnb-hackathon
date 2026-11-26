/**
 * SH-BOX-LIFE-VIEW § 2: the live activity controller against a scripted activity route (paged exactly like the
 * gateway: newest first, `before=<block>-<logIndex>`, a `next` cursor on a full page). New rows arrive when the box's
 * figures move, without a reload, newest first, each once; on a live chain, where the snapshot's block (the indexer's
 * head) moves every 12 s whatever the box does, an idle box is read on the polite schedule only and a failing route
 * keeps its back-off; a burst larger than one read is read further back until it joins, also from an indexer whose
 * older pages repeat the cursor's own item; a failing route backs off and reconnects without losing a row; a hidden
 * tab reads nothing, also after a read that was in flight; Show more and the holders' history page back; a stopped
 * controller drops what was in flight.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fetcher } from '../core-client';
import { parseSnapshotV2 } from './indexer-v2';
import { parseActivityPageV2 } from './life-activity';
import { figuresSignatureV2, LifeActivityControllerV2 } from './useLifeActivity';
import { gpuPoorLifeV2, recordedLifeV2, sepoliaLifeSourceV2 } from './test-support/life-v2';

type Wire = Record<string, unknown>;
const URL_BASE = 'https://indexer.example/v2/boxes/11155111/0xbox/activity';
const recorded = () => structuredClone((recordedLifeV2.gpuPoor.activity as { items: Wire[] }).items);
const key = (item: Wire) => [BigInt(item.block as string), item.logIndex as number] as const;

/** One synthetic swap at a later block (the gateway's trade shape), newest first among its block's items. */
function swapAt(block: number, logIndex = 5): Wire {
  return { kind: 'trade', id: `${block}-${logIndex}`, block: String(block), blockHash: `0x${block.toString(16).padStart(64, '0')}`, timestamp: String(1_793_083_300 + block - 12_003_400), txHash: `0x${(block * 100 + logIndex).toString(16).padStart(64, '0')}`, logIndex,
    side: 'buy', route: 'other', qRaw: '1000', tRaw: '2000', feeQ: '10', feeT: '0', taxQ: '0', trader: null, sqrtPriceX96After: '113506849788177122193529205755893', tickAfter: 145353 };
}

/**
 * The route: `items` newest first, paged like the gateway; `fail` makes the next reads answer 503; `at` records when
 * each read came (ms of the fake clock); `inclusive`: a gateway whose `before` page starts with the cursor's own item.
 */
function route(initial: Wire[], options: { readonly inclusive?: boolean } = {}) {
  const state = { items: initial, fail: 0, head: 12_003_391, calls: [] as string[], at: [] as number[] };
  const fetcher: Fetcher = async (url) => {
    state.calls.push(url.slice(URL_BASE.length));
    state.at.push(Date.now());
    if (state.fail > 0) { state.fail -= 1; return { ok: false, status: 503, json: async () => ({ error: 'busy' }) }; }
    const params = new URL(url).searchParams;
    const limit = Number(params.get('limit') ?? '50');
    const before = params.get('before');
    const [b, l] = before ? before.split('-').map((v) => BigInt(v)) : [null, null];
    const older = state.items.filter((item) => b === null || l === null || key(item)[0] < b || (key(item)[0] === b && (options.inclusive ? BigInt(key(item)[1]) <= l : BigInt(key(item)[1]) < l)));
    const page = older.slice(0, limit);
    const last = page.at(-1);
    return { ok: true, status: 200, json: async () => ({ asOf: { block: String(state.head), hash: `0x${'1'.repeat(64)}`, timestamp: '1793083272', tier: 'head' }, items: page, next: page.length === limit && last ? `${last.block as string}-${last.logIndex as number}` : null }) };
  };
  return { state, fetcher };
}
const ids = (c: LifeActivityControllerV2) => c.getState().store.items.map((item) => item.id);
/** Seconds since `t0` of each read the route saw. */
const seconds = (state: { at: number[] }, t0: number) => state.at.map((t) => (t - t0) / 1000);

/**
 * The page on a live chain for `forSeconds`: the snapshot is read every 4 s and the indexer's head moves every 12 s,
 * whatever the box does; `figures(t)` is the snapshot's figures signature at second `t` (the box's own moves).
 */
async function liveChain(c: LifeActivityControllerV2, forSeconds: number, figures: (t: number) => string) {
  let block = 12_003_391n;
  for (let t = 0; t < forSeconds; t += 4) {
    if (t % 12 === 0) block += 1n;
    c.signal(block, figures(t));
    await vi.advanceTimersByTimeAsync(4_000);
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the live activity', () => {
  it('reads the newest rows once on start, then moved figures bring the new rows on top, newest first, each once', async () => {
    const { state, fetcher } = route(recorded());
    const c = new LifeActivityControllerV2(URL_BASE, fetcher);
    c.start(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.calls).toEqual(['?limit=50']);
    expect(c.getState()).toMatchObject({ status: 'live', arrived: [] });
    expect(ids(c)).toEqual(parseActivityPageV2(recordedLifeV2.gpuPoor.activity).items.map((item) => item.id));
    c.signal(12_003_391n, 'a');
    // Two swaps land; the snapshot moves to their block with new figures.
    state.items = [swapAt(12_003_402, 9), swapAt(12_003_401), ...state.items];
    state.head = 12_003_402;
    c.signal(12_003_402n, 'b');
    await vi.advanceTimersByTimeAsync(0);
    expect(ids(c).slice(0, 3)).toEqual(['12003402-9', '12003401-5', '12003365-63']);
    expect(new Set(ids(c)).size).toBe(ids(c).length);
    expect(c.getState().arrived).toEqual(['12003401-5', '12003402-9']);
    // The same snapshot again reads nothing and doubles nothing; so does a new block with the same figures.
    c.signal(12_003_402n, 'b');
    c.signal(12_003_403n, 'b');
    await vi.advanceTimersByTimeAsync(0);
    expect(state.calls).toHaveLength(2);
    expect(ids(c)).toHaveLength(39);
    // An older snapshot (a late answer) says nothing, whatever its figures.
    c.signal(12_003_401n, 'a');
    await vi.advanceTimersByTimeAsync(0);
    expect(state.calls).toHaveLength(2);
    c.stop();
  });

  it('an idle box on a live chain: the head moving every 12 s reads nothing; the polite poll alone, 15 s, 30 s, then every 60 s', async () => {
    const { state, fetcher } = route(recorded());
    const c = new LifeActivityControllerV2(URL_BASE, fetcher);
    const t0 = Date.now();
    c.start(true);
    await vi.advanceTimersByTimeAsync(0);
    c.signal(12_003_391n, 'idle');
    await liveChain(c, 600, () => 'idle');
    // Ten minutes, 50 new heads and 150 snapshot reads: twelve activity reads, never one per block.
    expect(seconds(state, t0)).toEqual([0, 15, 45, 105, 165, 225, 285, 345, 405, 465, 525, 585]);
    expect(c.getState().status).toBe('live');
    c.stop();
  });

  it('a busy box on a live chain: every move of its figures reads its new rows at once', async () => {
    const { state, fetcher } = route(recorded());
    const c = new LifeActivityControllerV2(URL_BASE, fetcher);
    const t0 = Date.now();
    c.start(true);
    await vi.advanceTimersByTimeAsync(0);
    c.signal(12_003_391n, 'trades 5');
    // A buy lands in the blocks of second 24 and of second 48: the snapshot shows it the next time it is read.
    let block = 12_003_391n;
    for (let t = 0; t < 60; t += 4) {
      if (t % 12 === 0) block += 1n;
      if (t === 24) state.items = [swapAt(Number(block)), ...state.items];
      if (t === 48) state.items = [swapAt(Number(block), 9), ...state.items];
      c.signal(block, t < 24 ? 'trades 5' : t < 48 ? 'trades 6' : 'trades 7');
      await vi.advanceTimersByTimeAsync(4_000);
    }
    // The moves read at once (24 s, 48 s); after each new row the polite poll starts again from 15 s (39 s).
    expect(seconds(state, t0)).toEqual([0, 15, 24, 39, 48]);
    expect(ids(c).slice(0, 2)).toEqual(['12003396-9', '12003394-5']);
    expect(c.getState().arrived).toEqual(['12003394-5', '12003396-9']);
    c.stop();
  });

  it('a failing route on a live chain keeps its back-off (2, 4, 8, 16, 32, then 60 s): neither new heads nor moved figures read sooner', async () => {
    const { state, fetcher } = route(recorded());
    const c = new LifeActivityControllerV2(URL_BASE, fetcher);
    const t0 = Date.now();
    c.start(true);
    await vi.advanceTimersByTimeAsync(0);
    c.signal(12_003_391n, 'a');
    let block = 12_003_391n;
    // Three minutes, second by second: the snapshot read every 4 s, a new head every 12 s. The route fails from second
    // 1 to second 100; a buy lands at second 1 (its moved figures read once, which fails) and another at second 50.
    for (let t = 1; t <= 180; t += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      if (t === 1) {
        state.fail = 1_000;
        state.items = [swapAt(12_003_392), ...state.items];
      }
      if (t === 50) state.items = [swapAt(12_003_396), ...state.items];
      if (t === 100) state.fail = 0;
      if (t % 12 === 0) block += 1n;
      if (t % 4 === 1) c.signal(block, t < 50 ? 'b' : 'c');
      if (t === 2) expect(c.getState().status).toBe('reconnecting');
      if (t === 99) expect(c.getState().status).toBe('reconnecting');
    }
    // The retries came on the back-off's schedule alone; the first answer brought both buys, each once; then the polite
    // poll from 15 s.
    expect(seconds(state, t0)).toEqual([0, 1, 3, 7, 15, 31, 63, 123, 138, 168]);
    expect(c.getState().status).toBe('live');
    expect(ids(c).slice(0, 3)).toEqual(['12003396-5', '12003392-5', '12003365-63']);
    expect(new Set(ids(c)).size).toBe(ids(c).length);
    c.stop();
  });

  it('an indexer whose older pages repeat the cursor’s own item: a burst read back still holds each row once, in order', async () => {
    const { state, fetcher } = route(recorded(), { inclusive: true });
    const c = new LifeActivityControllerV2(URL_BASE, fetcher, { livePage: 5, olderPage: 4 });
    c.start(true);
    await vi.advanceTimersByTimeAsync(0);
    c.signal(12_003_391n, 'a');
    state.items = [...Array.from({ length: 12 }, (_, i) => swapAt(12_003_420 - i)), ...state.items];
    c.signal(12_003_420n, 'b');
    await vi.advanceTimersByTimeAsync(0);
    // Each older page starts again with the item its cursor names: read twice, held once.
    expect(state.calls.slice(1)).toEqual(['?limit=5', '?limit=4&before=12003416-5', '?limit=4&before=12003413-5', '?limit=4&before=12003410-5']);
    expect(ids(c)).toEqual(state.items.slice(0, 17).map((item) => item.id));
    expect(new Set(ids(c)).size).toBe(17);
    expect(c.getState().arrived).toHaveLength(12);
    c.stop();
  });

  it('a burst larger than one read is read further back until it joins the held rows: no hole, no double', async () => {
    const { state, fetcher } = route(recorded());
    const c = new LifeActivityControllerV2(URL_BASE, fetcher, { livePage: 5, olderPage: 4 });
    c.start(true);
    await vi.advanceTimersByTimeAsync(0);
    // The first read holds 5; the rest is behind Show more.
    expect(ids(c)).toHaveLength(5);
    c.signal(12_003_391n, 'a');
    state.items = [...Array.from({ length: 12 }, (_, i) => swapAt(12_003_420 - i)), ...state.items];
    c.signal(12_003_420n, 'b');
    await vi.advanceTimersByTimeAsync(0);
    // 5 + 4 + 4 newest items read before the run reached the held newest row.
    expect(state.calls).toEqual(['?limit=5', '?limit=5', '?limit=4&before=12003416-5', '?limit=4&before=12003412-5']);
    expect(ids(c)).toEqual(state.items.slice(0, 17).map((item) => item.id));
    expect(c.getState().arrived).toHaveLength(12);
    c.stop();
  });

  it('a failing route backs off (2 s, then 4 s) and says Reconnecting; the next answer joins without losing a row', async () => {
    const { state, fetcher } = route(recorded());
    const c = new LifeActivityControllerV2(URL_BASE, fetcher);
    c.start(true);
    await vi.advanceTimersByTimeAsync(0);
    c.signal(12_003_391n, 'a');
    state.fail = 2;
    state.items = [swapAt(12_003_405), ...state.items];
    c.signal(12_003_405n, 'b');
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getState().status).toBe('reconnecting');
    expect(ids(c)[0]).toBe('12003365-63');
    await vi.advanceTimersByTimeAsync(1_999);
    expect(state.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.calls).toHaveLength(3);
    expect(c.getState().status).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(c.getState().status).toBe('live');
    expect(ids(c)[0]).toBe('12003405-5');
    expect(ids(c)).toHaveLength(38);
    c.stop();
  });

  it('a first read that keeps failing ends as Unavailable, and keeps trying', async () => {
    const { state, fetcher } = route(recorded());
    state.fail = 3;
    const c = new LifeActivityControllerV2(URL_BASE, fetcher);
    c.start(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getState().status).toBe('loading');
    await vi.advanceTimersByTimeAsync(2_000 + 4_000);
    expect(c.getState().status).toBe('unavailable');
    await vi.advanceTimersByTimeAsync(8_000);
    expect(c.getState()).toMatchObject({ status: 'live', store: { loaded: true } });
    c.stop();
  });

  it('a hidden tab reads nothing, also when the box moves; shown again it reads at once', async () => {
    const { state, fetcher } = route(recorded());
    const c = new LifeActivityControllerV2(URL_BASE, fetcher);
    c.start(true);
    await vi.advanceTimersByTimeAsync(0);
    c.signal(12_003_391n, 'a');
    c.setVisible(false);
    expect(c.getState().status).toBe('paused');
    state.items = [swapAt(12_003_410), ...state.items];
    c.signal(12_003_410n, 'b');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(state.calls).toHaveLength(1);
    c.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.calls).toHaveLength(2);
    expect(c.getState().status).toBe('live');
    expect(ids(c)[0]).toBe('12003410-5');
    c.stop();
  });

  it('a read in flight when the tab is hidden: its answer is kept, the move made meanwhile is not read while hidden; shown again it reads at once', async () => {
    const base = route(recorded());
    const held: (() => void)[] = [];
    let hold = false;
    const fetcher: Fetcher = async (url) => {
      if (hold) await new Promise<void>((resolve) => held.push(resolve));
      return base.fetcher(url);
    };
    const c = new LifeActivityControllerV2(URL_BASE, fetcher);
    c.start(true);
    await vi.advanceTimersByTimeAsync(0);
    c.signal(12_003_391n, 'a');
    // A buy lands; its read is slow. Another move arrives while it is out, then the tab is hidden.
    hold = true;
    base.state.items = [swapAt(12_003_395), ...base.state.items];
    c.signal(12_003_395n, 'b');
    await vi.advanceTimersByTimeAsync(0);
    c.signal(12_003_396n, 'c');
    c.setVisible(false);
    hold = false;
    for (const release of held.splice(0)) release();
    await vi.advanceTimersByTimeAsync(0);
    // The answer joined (each row once) and the chip still says Paused; the second move waits for the tab: nothing is
    // read in two hidden minutes.
    expect(base.state.calls).toHaveLength(2);
    expect(ids(c)[0]).toBe('12003395-5');
    expect(c.getState().status).toBe('paused');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(base.state.calls).toHaveLength(2);
    c.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(base.state.calls).toHaveLength(3);
    expect(new Set(ids(c)).size).toBe(ids(c).length);
    c.stop();
  });

  it('polite on its own: every 15 s, doubling to 60 s while nothing arrives; figures that moved without a new row are asked again soon', async () => {
    const { state, fetcher } = route(recorded());
    const c = new LifeActivityControllerV2(URL_BASE, fetcher);
    c.start(true);
    await vi.advanceTimersByTimeAsync(0);
    c.signal(12_003_391n, 'a');
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.calls).toHaveLength(5);
    // The snapshot's figures moved (a trade the history writer has not stored yet): 1.5 s, then 3 s, then the row.
    c.signal(12_003_400n, 'moved');
    await vi.advanceTimersByTimeAsync(0);
    expect(state.calls).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(state.calls).toHaveLength(7);
    state.items = [swapAt(12_003_400), ...state.items];
    await vi.advanceTimersByTimeAsync(3_000);
    expect(state.calls).toHaveLength(8);
    expect(ids(c)[0]).toBe('12003400-5');
    c.stop();
  });

  it('Show more reads the next older page; the holders’ history reads back to the first item; a stopped controller drops a late answer', async () => {
    const { state, fetcher } = route(recorded());
    const c = new LifeActivityControllerV2(URL_BASE, fetcher, { livePage: 10, olderPage: 10, historyPages: 5 });
    c.start(true);
    await vi.advanceTimersByTimeAsync(0);
    expect([ids(c).length, c.getState().store.next]).toEqual([10, '12003363-141']);
    await c.loadMore();
    expect([ids(c).length, c.getState().store.next]).toEqual([20, '12003359-76']);
    c.wantHistory(true);
    expect(c.getState().readingHistory).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect([ids(c).length, c.getState().store.next, c.getState().readingHistory]).toEqual([37, null, false]);
    expect(ids(c)).toEqual(state.items.map((item) => item.id as string));
    // Stopped mid-read: the answer is dropped, nothing else is read.
    state.items = [swapAt(12_003_430), ...state.items];
    c.setVisible(false);
    c.setVisible(true);
    c.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ids(c)).toHaveLength(37);
  });
});

/** A route whose answers wait until released (a slow phone connection). */
function held(base: ReturnType<typeof route>) {
  const waiting: (() => void)[] = [];
  const control = { hold: false, release: () => { for (const go of waiting.splice(0)) go(); } };
  const fetcher: Fetcher = async (url) => {
    if (control.hold) await new Promise<void>((resolve) => waiting.push(resolve));
    return base.fetcher(url);
  };
  return { control, fetcher };
}

describe('the holders’ history (review round 2)', () => {
  it('since: the block of the first snapshot, then of each move of the figures; a new head alone or an older snapshot keeps it', async () => {
    const { fetcher } = route(recorded());
    const c = new LifeActivityControllerV2(URL_BASE, fetcher);
    c.start(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getState().since).toBeNull();
    c.signal(12_003_391n, 'a');
    expect(c.getState().since).toBe(12_003_391n);
    c.signal(12_003_392n, 'a');
    c.signal(12_003_393n, 'a');
    expect(c.getState().since).toBe(12_003_391n);
    c.signal(12_003_395n, 'b');
    expect(c.getState().since).toBe(12_003_395n);
    c.signal(12_003_394n, 'c');
    expect(c.getState().since).toBe(12_003_395n);
    c.stop();
  });

  it('Holders opened before the first read answered: the history is read as soon as it answers, back to the first item', async () => {
    const base = route(recorded());
    const slow = held(base);
    slow.control.hold = true;
    const c = new LifeActivityControllerV2(URL_BASE, slow.fetcher, { livePage: 10, olderPage: 10 });
    c.start(true);
    c.wantHistory(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(c.getState().store.loaded).toBe(false);
    slow.control.hold = false;
    slow.control.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(base.state.calls).toEqual(['?limit=10', '?limit=10&before=12003363-141', '?limit=10&before=12003359-76', '?limit=10&before=12003304-73']);
    expect([ids(c).length, c.getState().store.next, c.getState().readingHistory]).toEqual([37, null, false]);
    c.stop();
  });

  it('a history page that fails is read again on the error back-off (2 s, then 4 s) until the history is whole', async () => {
    const { state, fetcher } = route(recorded());
    const c = new LifeActivityControllerV2(URL_BASE, fetcher, { livePage: 10, olderPage: 20 });
    const t0 = Date.now();
    c.start(true);
    await vi.advanceTimersByTimeAsync(0);
    state.fail = 2;
    c.wantHistory(true);
    await vi.advanceTimersByTimeAsync(0);
    // The first page failed: the holders still wait for it (Reading, never "list unavailable").
    expect([c.getState().store.next, c.getState().readingHistory, c.getState().loadingMore]).toEqual(['12003363-141', true, false]);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(seconds(state, t0)).toEqual([0, 0, 2, 6, 6]);
    expect([ids(c).length, c.getState().store.next, c.getState().readingHistory]).toEqual([37, null, false]);
    c.stop();
  });

  it('closed, the holders read no further page; opened again, a fresh allowance of pages', async () => {
    const { state, fetcher } = route(recorded());
    const c = new LifeActivityControllerV2(URL_BASE, fetcher, { livePage: 10, olderPage: 10, historyPages: 1 });
    c.start(true);
    await vi.advanceTimersByTimeAsync(0);
    c.wantHistory(true);
    await vi.advanceTimersByTimeAsync(0);
    // One page allowed: the history is still not whole, and nothing more is read for it.
    expect([ids(c).length, c.getState().readingHistory]).toEqual([20, false]);
    c.wantHistory(false);
    c.wantHistory(true);
    await vi.advanceTimersByTimeAsync(0);
    expect([ids(c).length, state.calls.length]).toEqual([30, 3]);
    c.wantHistory(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.calls).toHaveLength(3);
    c.stop();
  });

  it('a hidden tab reads no history page; shown again, the history goes on', async () => {
    const { state, fetcher } = route(recorded());
    const c = new LifeActivityControllerV2(URL_BASE, fetcher, { livePage: 10, olderPage: 10 });
    c.start(true);
    await vi.advanceTimersByTimeAsync(0);
    c.setVisible(false);
    c.wantHistory(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.calls).toEqual(['?limit=10']);
    c.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect([ids(c).length, c.getState().store.next]).toEqual([37, null]);
    c.stop();
  });
});

describe('a new row flashes once (review round 2)', () => {
  it('a row the page has shown is no longer new once its flash has run (2.4 s); one not shown yet stays new', async () => {
    const { state, fetcher } = route(recorded());
    const c = new LifeActivityControllerV2(URL_BASE, fetcher);
    c.start(true);
    await vi.advanceTimersByTimeAsync(0);
    c.signal(12_003_391n, 'a');
    state.items = [swapAt(12_003_402, 9), swapAt(12_003_401), ...state.items];
    c.signal(12_003_402n, 'b');
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getState().arrived).toEqual(['12003401-5', '12003402-9']);
    // The page shows the newest (the other, say, below Show more); an id that is not new is left alone.
    c.shown(['12003402-9', '12003365-63']);
    await vi.advanceTimersByTimeAsync(2_399);
    expect(c.getState().arrived).toEqual(['12003401-5', '12003402-9']);
    // Shown again before its flash has run: still one flash.
    c.shown(['12003402-9']);
    await vi.advanceTimersByTimeAsync(1);
    expect(c.getState().arrived).toEqual(['12003401-5']);
    c.shown(['12003401-5']);
    await vi.advanceTimersByTimeAsync(2_400);
    expect(c.getState().arrived).toEqual([]);
    c.stop();
  });

  it('a stopped controller holds no shown row as new', async () => {
    const { state, fetcher } = route(recorded());
    const c = new LifeActivityControllerV2(URL_BASE, fetcher);
    c.start(true);
    await vi.advanceTimersByTimeAsync(0);
    c.signal(12_003_391n, 'a');
    state.items = [swapAt(12_003_401), ...state.items];
    c.signal(12_003_401n, 'b');
    await vi.advanceTimersByTimeAsync(0);
    c.shown(['12003401-5']);
    c.stop();
    expect(c.getState().arrived).toEqual([]);
  });
});

describe('what counts as the box moving', () => {
  const source = sepoliaLifeSourceV2();
  /** The same snapshot `by` blocks later: the head, its hash and time, and the money read move; nothing in the box does. */
  const later = (body: Wire, by: bigint, patch: Wire = {}): Wire => {
    const asOf = body.asOf as { block: string; timestamp: string };
    const block = BigInt(asOf.block) + by;
    const hash = `0x${block.toString(16).padStart(64, '0')}`;
    return { ...body, ...patch, asOf: { ...(body.asOf as Wire), block: String(block), hash, timestamp: String(BigInt(asOf.timestamp) + 12n * by) }, money: { ...(body.money as Wire), block: String(block), hash } };
  };
  const signature = (body: Wire) => figuresSignatureV2(parseSnapshotV2(body, source));

  it('a new head, its time, the money read at it and the 24 h volume sliding change nothing; a trade, a burn, a holder, the raise and a claim do', () => {
    const body = recordedLifeV2.gpuPoor.body;
    const stats = body.statistics as Wire;
    expect(signature(later(body, 1n))).toBe(signature(body));
    expect(signature(later(body, 50n, { statistics: { ...stats, volume24hP: '0', hourlyCandles: [] } }))).toBe(signature(body));
    expect(signature(later(body, 1n, { statistics: { ...stats, tradeCount: String(BigInt(stats.tradeCount as string) + 1n) } }))).not.toBe(signature(body));
    expect(signature(later(body, 1n, { statistics: { ...stats, holderCount: '3' } }))).not.toBe(signature(body));
    expect(signature(later(body, 1n, { statistics: { ...stats, burnedT: String(BigInt(stats.burnedT as string) + 1n), totalSupplyT: String(BigInt(stats.totalSupplyT as string) - 1n) } }))).not.toBe(signature(body));
    const raising = gpuPoorLifeV2('raising').body;
    const progress = (raising.statistics as Wire).raiseProgress as Wire;
    expect(signature(later(raising, 1n))).toBe(signature(raising));
    expect(signature(later(raising, 1n, { statistics: { ...(raising.statistics as Wire), raiseProgress: { ...progress, raisedP: String(BigInt(progress.raisedP as string) + 1n) } } }))).not.toBe(signature(raising));
    // A closed box: a claim moves the pot and the coins left, which no trade figure shows.
    const closed = gpuPoorLifeV2('failed').body;
    const closing = closed.closing as Wire;
    expect(signature(later(closed, 1n))).toBe(signature(closed));
    expect(signature(later(closed, 1n, { closing: { ...closing, pot: '1', tLeft: '1' } }))).not.toBe(signature(closed));
  });
});

// Fix round 3: the third review's reproductions (its `boundaries.test.ts`), as the reviewer wrote them apart from the
// imports, this repo's lint rules (no non-null assertion) and names that sit beside this file's own helpers; then this
// round's own tests of the same findings.
const hash32 = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
/** The reviewer's swap at `block`, log `logIndex`, on the chain's branch `branch` (its block hash says which). */
const trade = (block: number, logIndex: number, branch = 1): Wire => ({
  kind: 'trade', id: `${block}-${logIndex}`, block: String(block), blockHash: hash32(block * 10 + branch),
  timestamp: String(1_793_083_300 + block), txHash: hash32(block * 1000 + logIndex + branch * 100000), logIndex,
  side: 'buy', route: 'other', qRaw: '1000', tRaw: '2000', taxQ: '0', trader: null,
  sqrtPriceX96After: '113506849788177122193529205755893',
});
/** The reviewer's route: paged like the gateway; `hold` keeps the next answer until `release()`; `calls`: every read as it is asked. */
function reviewRoute(initial: Wire[]) {
  const state = { items: initial, calls: [] as string[], hold: false, release: () => {} };
  const fetcher: Fetcher = async (url) => {
    state.calls.push(url);
    if (state.hold) await new Promise<void>((resolve) => { state.release = resolve; });
    const p = new URL(url).searchParams;
    const before = p.get('before');
    const [b, l] = before ? before.split('-').map(BigInt) : [null, null];
    const remaining = state.items.filter((i) => b === null || l === null || BigInt(i.block as string) < b || (BigInt(i.block as string) === b && BigInt(i.logIndex as number) < l));
    const page = remaining.slice(0, Number(p.get('limit')));
    const last = page.at(-1);
    return { ok: true, status: 200, json: async () => ({ asOf: { block: '1000' }, items: page, next: page.length === Number(p.get('limit')) && last ? (last.id as string) : null }) };
  };
  return { state, fetcher };
}

describe('the third review’s reproductions (fix round 3)', () => {
  it('replaces all loaded rows from a reorged block even when newest-page boundary falls inside it', async () => {
    const r = reviewRoute([...Array.from({ length: 60 }, (_, i) => trade(100, 159 - i)), trade(99, 1)]);
    const c = new LifeActivityControllerV2(URL_BASE, r.fetcher);
    try {
      c.start(true);
      c.signal(100n, 'before');
      await vi.advanceTimersByTimeAsync(0);
      await c.loadMore();
      expect(c.getState().store.items).toHaveLength(61);
      r.state.items = [...Array.from({ length: 60 }, (_, i) => trade(100, 164 - i, 2)), trade(99, 1)];
      c.signal(101n, 'after');
      await vi.advanceTimersByTimeAsync(0);
      expect(c.getState().store.items.map((i) => [i.id, i.blockHash])).toEqual(r.state.items.map((i) => [i.id, i.blockHash]));
    } finally { c.stop(); }
  });

  it('does not start gap-page requests after an in-flight newest read finishes in a hidden tab', async () => {
    const r = reviewRoute([trade(100, 1), trade(99, 1)]);
    const c = new LifeActivityControllerV2(URL_BASE, r.fetcher);
    try {
      c.start(true);
      c.signal(100n, 'before');
      await vi.advanceTimersByTimeAsync(0);
      r.state.items = [...Array.from({ length: 120 }, (_, i) => trade(300 - i, 1)), ...r.state.items];
      r.state.hold = true;
      c.signal(300n, 'after');
      await vi.advanceTimersByTimeAsync(0);
      expect(r.state.calls).toHaveLength(2);
      c.setVisible(false);
      r.state.hold = false;
      r.state.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(r.state.calls).toHaveLength(2);
    } finally { c.stop(); }
  });
});

describe('a reorg across the newest read’s boundary (fix round 3)', () => {
  /** Block 100 with 60 swaps from log `top` down on `branch`, then one swap in each of blocks 99 to 90 (never reorged). */
  const chain = (top: number, branch: number) => [...Array.from({ length: 60 }, (_, i) => trade(100, top - i, branch)), ...Array.from({ length: 10 }, (_, i) => trade(99 - i, 1))];
  const pairs = (c: LifeActivityControllerV2) => c.getState().store.items.map((item) => [item.id, item.blockHash]);
  const wirePairs = (items: readonly Wire[]) => items.map((item) => [item.id, item.blockHash]);

  it('read back to a block both hold alike: the rows older than it stay as held, no row of the old branch, in two reads', async () => {
    const { state, fetcher } = route(chain(159, 1));
    const c = new LifeActivityControllerV2(URL_BASE, fetcher, { olderPage: 12 });
    c.start(true);
    c.signal(100n, 'before');
    await vi.advanceTimersByTimeAsync(0);
    await c.loadMore();
    await c.loadMore();
    expect([ids(c).length, c.getState().store.next]).toEqual([70, null]);
    // The reorg replaced block 100: its 60 swaps again, their logs five later, another block hash.
    state.items = chain(164, 2);
    c.signal(101n, 'after');
    await vi.advanceTimersByTimeAsync(0);
    // The newest 50 end inside block 100, whose held rows carry the old hash: one page further back ends at block 98,
    // which both hold alike, so the eight rows below it stay as held (not read again).
    expect(state.calls.slice(3)).toEqual(['?limit=50', '?limit=12&before=100-115']);
    expect(pairs(c)).toEqual(wirePairs(state.items));
    expect(c.getState().store.next).toBeNull();
    c.stop();
  });

  it('a reorg deeper than the reads back allow: the fresh run replaces the held one with its own cursor; Show more reads on from there', async () => {
    const { state, fetcher } = route(chain(159, 1));
    const c = new LifeActivityControllerV2(URL_BASE, fetcher, { olderPage: 4, maxGapPages: 1 });
    c.start(true);
    c.signal(100n, 'before');
    await vi.advanceTimersByTimeAsync(0);
    await c.loadMore();
    expect([ids(c).length, c.getState().store.next]).toEqual([54, '100-106']);
    state.items = chain(164, 2);
    c.signal(101n, 'after');
    await vi.advanceTimersByTimeAsync(0);
    // One page back (the whole allowance) still ends inside block 100: the 54 rows read now, all of the new branch, and
    // their own cursor; none of the held old branch stays.
    expect(state.calls.slice(2)).toEqual(['?limit=50', '?limit=4&before=100-115']);
    expect(pairs(c)).toEqual(wirePairs(state.items.slice(0, 54)));
    expect(c.getState().store.next).toBe('100-111');
    await c.loadMore();
    expect(state.calls.at(-1)).toBe('?limit=4&before=100-111');
    expect(pairs(c)).toEqual(wirePairs(state.items.slice(0, 58)));
    c.stop();
  });
});

describe('a hidden tab while a newest read is out (fix round 3)', () => {
  /** The route behind a read counter: `asked` records each read as it is asked; `slow`, when set, holds the reads it matches until `release()`. */
  function slowRoute(base: ReturnType<typeof route>) {
    const control = { asked: [] as string[], slow: null as ((query: string) => boolean) | null, waiting: [] as (() => void)[] };
    const fetcher: Fetcher = async (url) => {
      const query = url.slice(URL_BASE.length);
      control.asked.push(query);
      if (control.slow?.(query)) await new Promise<void>((resolve) => control.waiting.push(resolve));
      return base.fetcher(url);
    };
    const release = () => { for (const go of control.waiting.splice(0)) go(); };
    return { control, fetcher, release };
  }

  it('the newest read answers after the tab was hidden and needs pages back: none is read while hidden, the held rows stay; shown again, the refresh is read to its end', async () => {
    const base = route([trade(100, 1), trade(99, 1)]);
    const slow = slowRoute(base);
    const c = new LifeActivityControllerV2(URL_BASE, slow.fetcher);
    c.start(true);
    c.signal(100n, 'before');
    await vi.advanceTimersByTimeAsync(0);
    // A burst of 120 swaps, more than one read: the read after the move is slow, and the tab is hidden while it is out.
    base.state.items = [...Array.from({ length: 120 }, (_, i) => trade(300 - i, 1)), ...base.state.items];
    slow.control.slow = () => true;
    c.signal(300n, 'after');
    await vi.advanceTimersByTimeAsync(0);
    c.setVisible(false);
    slow.control.slow = null;
    slow.release();
    await vi.advanceTimersByTimeAsync(0);
    // Its answer does not reach the held rows: no page back while hidden, nor in two hidden minutes; the held run stays
    // whole as it was, and the chip says Paused.
    expect(slow.control.asked).toEqual(['?limit=50', '?limit=50']);
    expect([ids(c), c.getState().store.next, c.getState().status]).toEqual([['100-1', '99-1'], null, 'paused']);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(slow.control.asked).toHaveLength(2);
    // Shown again: the newest read and its page back at once, the burst joined to the held rows, each row once.
    c.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(slow.control.asked.slice(2)).toEqual(['?limit=50', '?limit=200&before=251-1']);
    expect(ids(c)).toEqual(base.state.items.map((item) => item.id));
    expect([c.getState().store.next, c.getState().status]).toEqual([null, 'live']);
    c.stop();
  });

  it('hidden between two pages back: the next page is not read while hidden, the held rows stay; shown again, the refresh is read to its end', async () => {
    const base = route(recorded());
    const slow = slowRoute(base);
    const c = new LifeActivityControllerV2(URL_BASE, slow.fetcher, { livePage: 5, olderPage: 4 });
    c.start(true);
    await vi.advanceTimersByTimeAsync(0);
    const first = ids(c);
    expect(first).toHaveLength(5);
    c.signal(12_003_391n, 'a');
    base.state.items = [...Array.from({ length: 12 }, (_, i) => swapAt(12_003_420 - i)), ...base.state.items];
    // The first page back is slow; the tab is hidden while it is out.
    slow.control.slow = (query) => query.includes('before=');
    c.signal(12_003_420n, 'b');
    await vi.advanceTimersByTimeAsync(0);
    expect(slow.control.asked).toEqual(['?limit=5', '?limit=5', '?limit=4&before=12003416-5']);
    c.setVisible(false);
    slow.control.slow = null;
    slow.release();
    await vi.advanceTimersByTimeAsync(120_000);
    // Its answer still does not reach the held rows: the second page back is not read while hidden; the held five stay.
    expect(slow.control.asked).toHaveLength(3);
    expect([ids(c), c.getState().status]).toEqual([first, 'paused']);
    c.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(slow.control.asked.slice(3)).toEqual(['?limit=5', '?limit=4&before=12003416-5', '?limit=4&before=12003412-5']);
    expect(ids(c)).toEqual(base.state.items.slice(0, 17).map((item) => item.id));
    expect(new Set(ids(c)).size).toBe(17);
    expect(c.getState().status).toBe('live');
    c.stop();
  });

  it('hidden and shown again before the newest read answers: once it does, its page back follows at once, the refresh to its end', async () => {
    const base = route([trade(100, 1), trade(99, 1)]);
    const slow = slowRoute(base);
    const c = new LifeActivityControllerV2(URL_BASE, slow.fetcher);
    c.start(true);
    c.signal(100n, 'before');
    await vi.advanceTimersByTimeAsync(0);
    base.state.items = [...Array.from({ length: 120 }, (_, i) => trade(300 - i, 1)), ...base.state.items];
    slow.control.slow = () => true;
    c.signal(300n, 'after');
    await vi.advanceTimersByTimeAsync(0);
    c.setVisible(false);
    c.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    // Shown again while the read is out: no second read meanwhile.
    expect(slow.control.asked).toEqual(['?limit=50', '?limit=50']);
    slow.control.slow = null;
    slow.release();
    await vi.advanceTimersByTimeAsync(0);
    // Visible when it answers: its page back at once, then the read asked for when the tab was shown; each row once.
    expect(slow.control.asked.slice(2)).toEqual(['?limit=200&before=251-1', '?limit=50']);
    expect(ids(c)).toEqual(base.state.items.map((item) => item.id));
    expect(c.getState().status).toBe('live');
    c.stop();
  });
});

describe('an older page asked for before a reorg (fix round 3)', () => {
  it('a Show more page of the old branch, asked for before a reorg that kept the run’s cursor, is dropped once the reorg is read; Show more again reads the new branch', async () => {
    /** Block 101 with 50 swaps and block 100 with 10, on `branch`, then block 99 (never reorged). */
    const chain = (branch: number) => [...Array.from({ length: 50 }, (_, i) => trade(101, 159 - i, branch)), ...Array.from({ length: 10 }, (_, i) => trade(100, 9 - i, branch)), trade(99, 1)];
    const base = route(chain(1));
    const waiting: (() => void)[] = [];
    let holdOlder = false;
    // Each answer is the indexer's as it stood when asked; a page back can be slow to arrive.
    const fetcher: Fetcher = async (url) => {
      const reply = base.fetcher(url);
      if (holdOlder && url.includes('before=')) await new Promise<void>((resolve) => waiting.push(resolve));
      return reply;
    };
    const c = new LifeActivityControllerV2(URL_BASE, fetcher);
    c.start(true);
    c.signal(101n, 'before');
    await vi.advanceTimersByTimeAsync(0);
    expect([ids(c).length, c.getState().store.next]).toEqual([50, '101-110']);
    // Show more is asked for; its answer, the old branch's blocks 100 and 99, is slow.
    holdOlder = true;
    const more = c.loadMore();
    await vi.advanceTimersByTimeAsync(0);
    // A reorg replaces blocks 100 and 101 (the same logs, another hash); the figures move, and the newest read takes
    // the new branch of block 101, which ends at the same cursor.
    base.state.items = chain(2);
    c.signal(102n, 'after');
    await vi.advanceTimersByTimeAsync(0);
    expect([c.getState().store.items.every((item) => item.blockHash === hash32(1012)), c.getState().store.next]).toEqual([true, '101-110']);
    // The old branch's page arrives now: asked for after another last row, it is dropped.
    holdOlder = false;
    for (const go of waiting.splice(0)) go();
    await more;
    expect(c.getState().store.items.filter((item) => item.blockHash === hash32(1001) || item.blockHash === hash32(1011))).toEqual([]);
    expect([ids(c).length, c.getState().store.next]).toEqual([50, '101-110']);
    // Show more again: the new branch, to the box's first item.
    await c.loadMore();
    expect(c.getState().store.items.map((item) => [item.id, item.blockHash])).toEqual(base.state.items.map((item) => [item.id, item.blockHash]));
    expect(c.getState().store.next).toBeNull();
    c.stop();
  });

  it('a Show more page in flight while new rows land on top (no reorg) still joins: the run’s last row is the same', async () => {
    const base = route(recorded());
    const waiting: (() => void)[] = [];
    let holdOlder = false;
    const fetcher: Fetcher = async (url) => {
      const reply = base.fetcher(url);
      if (holdOlder && url.includes('before=')) await new Promise<void>((resolve) => waiting.push(resolve));
      return reply;
    };
    const c = new LifeActivityControllerV2(URL_BASE, fetcher, { livePage: 10, olderPage: 10 });
    c.start(true);
    c.signal(12_003_391n, 'a');
    await vi.advanceTimersByTimeAsync(0);
    holdOlder = true;
    const more = c.loadMore();
    await vi.advanceTimersByTimeAsync(0);
    // Two swaps land while the page is out; the newest read takes them on top of the held rows.
    base.state.items = [swapAt(12_003_402, 9), swapAt(12_003_401), ...base.state.items];
    c.signal(12_003_402n, 'b');
    await vi.advanceTimersByTimeAsync(0);
    expect(ids(c).slice(0, 2)).toEqual(['12003402-9', '12003401-5']);
    holdOlder = false;
    for (const go of waiting.splice(0)) go();
    await more;
    expect(base.state.calls).toEqual(['?limit=10', '?limit=10&before=12003363-141', '?limit=10']);
    expect(ids(c)).toEqual(base.state.items.slice(0, 22).map((item) => item.id));
    expect(c.getState().store.next).toBe('12003359-76');
    c.stop();
  });

  it('a holders’ page dropped as stale is given back: the holders still read the whole history', async () => {
    /** Block 101 with 50 swaps and block 100 with 10, on `branch`, then block 99 (never reorged). */
    const chain = (branch: number) => [...Array.from({ length: 50 }, (_, i) => trade(101, 159 - i, branch)), ...Array.from({ length: 10 }, (_, i) => trade(100, 9 - i, branch)), trade(99, 1)];
    const base = route(chain(1));
    const waiting: (() => void)[] = [];
    let holdOlder = false;
    // Each answer is the indexer's as it stood when asked; a page back can be slow to arrive.
    const fetcher: Fetcher = async (url) => {
      const reply = base.fetcher(url);
      if (holdOlder && url.includes('before=')) await new Promise<void>((resolve) => waiting.push(resolve));
      return reply;
    };
    // Three pages of 4 read the history below the newest 50, exactly the holders' allowance.
    const c = new LifeActivityControllerV2(URL_BASE, fetcher, { olderPage: 4, historyPages: 3 });
    c.start(true);
    c.signal(101n, 'before');
    await vi.advanceTimersByTimeAsync(0);
    // Holders opens; its first page (the old branch) is slow, and the reorg of blocks 100 and 101 is read meanwhile.
    holdOlder = true;
    c.wantHistory(true);
    await vi.advanceTimersByTimeAsync(0);
    base.state.items = chain(2);
    c.signal(102n, 'after');
    await vi.advanceTimersByTimeAsync(0);
    holdOlder = false;
    for (const go of waiting.splice(0)) go();
    await vi.advanceTimersByTimeAsync(0);
    // The stale page is dropped and given back: the three pages of the new branch follow, to the box's first item.
    expect(base.state.calls).toEqual(['?limit=50', '?limit=4&before=101-110', '?limit=50', '?limit=4&before=101-110', '?limit=4&before=100-6', '?limit=4&before=100-2']);
    expect(c.getState().store.items.map((item) => [item.id, item.blockHash])).toEqual(base.state.items.map((item) => [item.id, item.blockHash]));
    expect([c.getState().store.next, c.getState().readingHistory]).toEqual([null, false]);
    c.stop();
  });
});
