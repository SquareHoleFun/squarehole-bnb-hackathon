import { toJson } from '@squarehole/indexer/client';
import { describe, expect, it } from 'vitest';
import { DemoChain } from './demo-chain';
import { createDemoStream } from './demo-live';
import { liveDataFromDirect } from './direct-source';
import { DEMO_FIT_TARGET, type FitMarketTarget } from './fit-target';
import {
  CATCHING_UP_REASON,
  DIRECT_MS,
  LivePoolController,
  POLL_MS,
  SSE_FIRST_GRACE_MS,
  SSE_GRACE_MS,
  SPOT_CHECK_MS,
  SSE_RETRY_MS,
  STALE_AFTER_MS,
  TICK_MS,
  snapshotUrl,
  streamUrl,
  type LiveDeps,
  type SnapshotAnswer,
  type StreamLike,
} from './live-controller';
import type { LiveData } from './live-model';

/** A chain target with an indexer and an RPC (the numbers come from the Demo simulator). */
const TARGET: FitMarketTarget = { ...DEMO_FIT_TARGET, kind: 'chain', networkLabel: 'Local chain 31337', indexerOrigin: 'http://127.0.0.1:8598', rpcUrl: 'http://127.0.0.1:8599' };

class FakeClock {
  now = 1_000_000;
  private id = 0;
  private timers: { at: number; ms: number; fn: () => void; id: number }[] = [];
  setTimeout = (fn: () => void, ms: number) => {
    this.id += 1;
    this.timers.push({ at: this.now + ms, ms, fn, id: this.id });
    return this.id;
  };
  clearTimeout = (handle: unknown) => {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  };
  get pending() {
    return this.timers.length;
  }
  /** Pending timers set with this delay (POLL_MS: poll loops). */
  pendingOf(ms: number) {
    return this.timers.filter((timer) => timer.ms === ms).length;
  }
  async advance(ms: number) {
    const until = this.now + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > until) break;
      this.timers.shift();
      this.now = next.at;
      next.fn();
      await flush();
    }
    this.now = until;
    await flush();
  }
}

const demoClock = (clock: FakeClock) => ({ now: () => clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

class FakeStream implements StreamLike {
  readyState = 0;
  closed = false;
  private listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  emit(type: string, data?: string) {
    if (type === 'open') this.readyState = 1;
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
  fail(readyState: 0 | 2) {
    this.readyState = readyState;
    this.emit('error');
  }
}

function setup(options: { stream?: boolean; poll?: (url: string) => Promise<SnapshotAnswer>; direct?: () => Promise<LiveData> } = {}) {
  const clock = new FakeClock();
  const streams: FakeStream[] = [];
  const deps: LiveDeps = {
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    openStream: options.stream === false ? null : (url) => {
      const stream = new FakeStream(url);
      streams.push(stream);
      return stream;
    },
    fetchSnapshot: options.poll ?? null,
    readDirect: options.direct ?? null,
  };
  const controller = new LivePoolController(TARGET, deps);
  let notified = 0;
  controller.subscribe(() => (notified += 1));
  return { clock, streams, controller, notified: () => notified };
}

function first(streams: readonly FakeStream[]): FakeStream {
  const stream = streams[0];
  if (!stream) throw new Error('no stream was opened');
  return stream;
}

function second(streams: readonly FakeStream[]): FakeStream {
  const stream = streams[1];
  if (!stream) throw new Error('no second stream was opened');
  return stream;
}

function chain(): DemoChain {
  const c = new DemoChain(TARGET);
  c.mineTo(TARGET.openBlock + 60n);
  return c;
}

const directData = (c: DemoChain, sqrtPriceX96: bigint = c.head.state.sqrtPriceX96): LiveData =>
  liveDataFromDirect(
    {
      block: { number: c.head.header.number, hash: c.head.header.hash, timestamp: c.head.header.timestamp },
      safeBlock: null,
      finalizedBlock: null,
      sqrtPriceX96,
      tick: c.head.state.tick,
      phase: 'curve',
      completedBlock: null,
      migratedBlock: null,
      liquidityOpensAtBlock: null,
      openBlock: TARGET.openBlock,
      totalSupplyRaw: 10n ** 27n - c.head.state.burnedRaw,
    },
    TARGET,
  );

describe('LivePoolController: the source ladder (realtime § 7, C19)', () => {
  it('uses the gateway endpoints of this exact pool', () => {
    expect(streamUrl(TARGET)).toBe(`http://127.0.0.1:8598/v1/pools/31337/${TARGET.poolId}/stream`);
    expect(snapshotUrl(TARGET)).toBe(`http://127.0.0.1:8598/v1/pools/31337/${TARGET.poolId}/snapshot`);
    expect(streamUrl(DEMO_FIT_TARGET)).toBeNull();
  });

  it('is live on the stream, follows blocks, and turns stale after 36 s without a new head', async () => {
    const c = chain();
    const { clock, streams, controller } = setup();
    controller.start();
    expect(controller.getSnapshot().freshness).toBe('connecting');
    const stream = first(streams);
    stream.emit('open');
    stream.emit('snapshot', toJson(c.snapshot(0)));
    stream.emit('status', '{"indexer":"live","reason":null}');
    expect(controller.getSnapshot()).toMatchObject({ freshness: 'live', source: 'stream' });
    const block = c.mineNext();
    await clock.advance(12_000);
    stream.emit('block', toJson(c.blockEvent(2, block)));
    expect(controller.getSnapshot().data?.head.number).toBe(block.header.number);
    await clock.advance(STALE_AFTER_MS + 2_000);
    // No poll or RPC to fall back to: the last good state, marked stale.
    const view = controller.getSnapshot();
    expect(view.freshness).toBe('stale');
    expect(view.staleSinceBlock).toBe(block.header.number);
    controller.stop();
  });

  it('keeps the stream through a short reconnect, polls after the grace period, then reads the chain', async () => {
    const c = chain();
    // A stream that delivered once gets the longer grace (a stream that never did gets SSE_FIRST_GRACE_MS).
    let polls = 0;
    const answers: SnapshotAnswer[] = [{ status: 200, etag: '"1"', indexer: 'live', body: toJson(c.snapshot(0)) }];
    const { clock, streams, controller } = setup({
      poll: async () => {
        polls += 1;
        const answer = answers.shift();
        if (!answer) throw new Error('gateway down');
        return answer;
      },
      direct: async () => directData(c),
    });
    controller.start();
    const stream = first(streams);
    stream.emit('snapshot', toJson(c.snapshot(0)));
    answers[0] = { status: 200, etag: '"1"', indexer: 'live', body: toJson(c.snapshot(0)) };
    stream.fail(0); // CONNECTING: the browser retries by itself
    await clock.advance(SSE_GRACE_MS - 2_000);
    expect(stream.closed).toBe(false);
    await clock.advance(4_000);
    expect(stream.closed).toBe(true);
    expect(polls).toBe(1);
    expect(controller.getSnapshot()).toMatchObject({ freshness: 'polling', source: 'poll' });
    await clock.advance(POLL_MS * 2 + 10);
    // Two failed polls: the page reads the chain itself.
    expect(controller.getSnapshot()).toMatchObject({ freshness: 'direct', source: 'direct' });
    expect(controller.getSnapshot().data?.trades).toEqual([]);
    expect(controller.getSnapshot().reason).toMatch(/cannot be reached/);
    controller.stop();
  });

  it('gives a stream that never answers only the short first grace', async () => {
    const c = chain();
    const { clock, streams, controller } = setup({ poll: async () => ({ status: 200, etag: null, indexer: 'live', body: toJson(c.snapshot(0)) }) });
    controller.start();
    await clock.advance(SSE_FIRST_GRACE_MS - 1_000);
    expect(first(streams).closed).toBe(false);
    expect(controller.getSnapshot().freshness).toBe('connecting');
    // The check runs on the 2-second tick: within one tick after the grace.
    await clock.advance(1_000 + TICK_MS + 100);
    expect(first(streams).closed).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ freshness: 'polling', source: 'poll' });
    controller.stop();
  });

  it('goes straight to polling when the browser gives the stream up, and retries the stream later', async () => {
    const c = chain();
    const { clock, streams, controller } = setup({ poll: async () => ({ status: 200, etag: null, indexer: 'live', body: toJson(c.snapshot(0)) }) });
    controller.start();
    first(streams).fail(2);
    await clock.advance(0);
    expect(controller.getSnapshot().source).toBe('poll');
    await clock.advance(SSE_RETRY_MS + 2_000);
    expect(streams).toHaveLength(2);
    second(streams).emit('snapshot', toJson(c.snapshot(0)));
    expect(controller.getSnapshot().source).toBe('stream');
    controller.stop();
  });

  it('keeps one poll loop when the retried stream fails again while a snapshot fetch is pending', async () => {
    const c = chain();
    const ok = (): SnapshotAnswer => ({ status: 200, etag: null, indexer: 'live', body: toJson(c.snapshot(0)) });
    const pending: ((answer: SnapshotAnswer) => void)[] = [];
    let hold = true;
    let fetches = 0;
    const { clock, streams, controller } = setup({
      poll: () => {
        fetches += 1;
        return hold ? new Promise<SnapshotAnswer>((resolve) => pending.push(resolve)) : Promise.resolve(ok());
      },
    });
    controller.start();
    first(streams).fail(2); // the browser gave up: poll 1 starts and waits
    await clock.advance(0);
    expect(pending).toHaveLength(1);
    await clock.advance(SSE_RETRY_MS + TICK_MS); // the stream is tried again…
    expect(streams).toHaveLength(2);
    second(streams).fail(2); // …and fails at once (a CDN answering 502): poll 2 starts
    await clock.advance(0);
    expect(pending).toHaveLength(2);
    for (const resolve of pending) resolve(ok());
    await clock.advance(0);
    // The older fetch belongs to a loop that was replaced: it schedules nothing.
    expect(clock.pendingOf(POLL_MS)).toBe(1);
    expect(controller.getSnapshot()).toMatchObject({ freshness: 'polling', source: 'poll' });
    hold = false;
    fetches = 0;
    await clock.advance(POLL_MS * 8);
    expect(fetches).toBe(8);
    expect(clock.pendingOf(POLL_MS)).toBe(1);
    controller.stop();
    expect(clock.pending).toBe(0);
  });

  it('checks the live service against a direct chain read about once a minute, and stops trusting it on a different price', async () => {
    const c = chain();
    let lie = false;
    const { clock, streams, controller } = setup({ direct: async () => directData(c, lie ? c.head.state.sqrtPriceX96 + 1n : c.head.state.sqrtPriceX96) });
    controller.start();
    const stream = first(streams);
    stream.emit('snapshot', toJson(c.snapshot(0)));
    stream.emit('status', '{"indexer":"live","reason":null}');
    expect(controller.getSnapshot()).toMatchObject({ freshness: 'live', checkedBlock: null });
    // The first check runs on the next tick; the chain agrees at the same block.
    await clock.advance(TICK_MS + 10);
    expect(controller.getSnapshot()).toMatchObject({ freshness: 'live', source: 'stream', checkedBlock: c.head.header.number });
    // Blocks keep coming; the chain now answers another price at the same block as the service.
    lie = true;
    for (let i = 0; i < 6; i += 1) {
      const block = c.mineNext();
      stream.emit('block', toJson(c.blockEvent(i + 2, block)));
      await clock.advance(12_000);
    }
    const view = controller.getSnapshot();
    expect(view.freshness).not.toBe('live');
    expect(view.source).toBe('direct');
    expect(view.checkedBlock).toBeNull();
    expect(view.reason).toMatch(/price at block [\d,]+ differs from the chain/);
    // When the chain and the service agree again, the service is used again.
    lie = false;
    const block = c.mineNext();
    stream.emit('block', toJson(c.blockEvent(9, block)));
    await clock.advance(SPOT_CHECK_MS / 4);
    expect(controller.getSnapshot()).toMatchObject({ freshness: 'live', source: 'stream', checkedBlock: block.header.number });
    controller.stop();
    expect(clock.pending).toBe(0);
  });

  it('drops a stream that sends data it cannot trust', async () => {
    const { clock, streams, controller } = setup({ poll: async () => ({ status: 503, etag: null, indexer: null, body: null }) });
    controller.start();
    first(streams).emit('snapshot', '{"schema":"sh.live-pool.v1","chainId":1}');
    expect(first(streams).closed).toBe(true);
    await clock.advance(POLL_MS * 3);
    // No RPC either: unavailable, with the reason in words.
    const view = controller.getSnapshot();
    expect(view.freshness).toBe('unavailable');
    expect(view.data).toBeNull();
    controller.stop();
  });

  it('shows the chain read instead of an unverified or stale service', async () => {
    const c = chain();
    const { clock, streams, controller } = setup({ direct: async () => directData(c) });
    controller.start();
    first(streams).emit('snapshot', toJson(c.snapshot(0)));
    first(streams).emit('status', '{"indexer":"unverified","reason":"the indexer state differs from the chain"}');
    await clock.advance(2_100);
    const view = controller.getSnapshot();
    expect(view).toMatchObject({ freshness: 'direct', source: 'direct' });
    expect(view.reason).toBe('Live data doesn’t match the chain.');
    first(streams).emit('status', '{"indexer":"live","reason":null}');
    expect(controller.getSnapshot().source).toBe('stream');
    controller.stop();
  });

  it('says the service is catching up as a wait (F51), with or without a chain read beside it', async () => {
    const c = chain();
    const { clock, streams, controller } = setup({ direct: async () => directData(c) });
    controller.start();
    expect(controller.getSnapshot().catchingUp).toBe(false);
    first(streams).emit('snapshot', toJson(c.snapshot(0)));
    first(streams).emit('status', '{"indexer":"stale","reason":"catching up"}');
    // Before the chain read lands: the service's last state, stale, and the reason is the wait.
    expect(controller.getSnapshot()).toMatchObject({ freshness: 'stale', source: 'stream', reason: CATCHING_UP_REASON, catchingUp: true });
    await clock.advance(2_100);
    expect(controller.getSnapshot()).toMatchObject({ freshness: 'direct', source: 'direct', reason: CATCHING_UP_REASON, catchingUp: true });
    // Any other stale reason stays a fault.
    first(streams).emit('status', '{"indexer":"stale","reason":"no new block"}');
    expect(controller.getSnapshot()).toMatchObject({ reason: 'The live service reports stale data: no new block.', catchingUp: false });
    first(streams).emit('status', '{"indexer":"live","reason":null}');
    expect(controller.getSnapshot()).toMatchObject({ freshness: 'live', reason: null, catchingUp: false });
    controller.stop();
  });

  it('marks the service unverified when there is nothing to check it against', async () => {
    const c = chain();
    const { streams, controller } = setup();
    controller.start();
    first(streams).emit('snapshot', toJson(c.snapshot(0)));
    first(streams).emit('status', '{"indexer":"unverified","reason":null}');
    expect(controller.getSnapshot()).toMatchObject({ freshness: 'unverified', source: 'stream' });
    expect(controller.getSnapshot().data).not.toBeNull();
    controller.stop();
  });

  it('reads the chain when there is no live service, and says unavailable when that fails too', async () => {
    const c = chain();
    let fail = false;
    const noIndexer: FitMarketTarget = { ...TARGET, indexerOrigin: null };
    const clock = new FakeClock();
    const controller = new LivePoolController(noIndexer, {
      now: () => clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      openStream: null,
      fetchSnapshot: null,
      readDirect: async () => {
        if (fail) throw new Error('RPC down');
        return directData(c);
      },
    });
    controller.start();
    await clock.advance(0);
    expect(controller.getSnapshot()).toMatchObject({ freshness: 'direct', source: 'direct' });
    fail = true;
    await clock.advance(DIRECT_MS * 3);
    expect(controller.getSnapshot()).toMatchObject({ freshness: 'stale', source: 'direct' });
    expect(controller.getSnapshot().reason).toBe('RPC down');
    controller.stop();
    expect(clock.pending).toBe(0);
  });

  it('runs the Demo stream through the same path, with a reorg notice', async () => {
    const clock = new FakeClock();
    const controller = new LivePoolController(DEMO_FIT_TARGET, {
      now: () => clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      openStream: () => createDemoStream(DEMO_FIT_TARGET, 'reorg', demoClock(clock)),
      fetchSnapshot: null,
      readDirect: null,
    });
    controller.start();
    await clock.advance(0);
    const before = controller.getSnapshot().data?.head.number ?? 0n;
    expect(controller.getSnapshot().freshness).toBe('live');
    await clock.advance(12_000);
    expect(controller.getSnapshot().reorg).toMatchObject({ fromBlock: before, toBlock: before - 1n, depth: 1 });
    await clock.advance(12_000);
    expect(controller.getSnapshot().data?.head.number).toBe(before);
    controller.stop();
    expect(clock.pending).toBe(0);
  });

  it('never falls back from the Demo stream; its stale scenario stays stale', async () => {
    const clock = new FakeClock();
    const controller = new LivePoolController(DEMO_FIT_TARGET, {
      now: () => clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      openStream: () => createDemoStream(DEMO_FIT_TARGET, 'stale', demoClock(clock)),
      fetchSnapshot: null,
      readDirect: null,
    });
    controller.start();
    await clock.advance(120_000);
    expect(controller.getSnapshot()).toMatchObject({ freshness: 'stale', source: 'stream' });
    controller.stop();
  });
});
