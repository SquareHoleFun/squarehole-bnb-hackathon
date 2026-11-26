import { toHex, type Hex } from 'viem';
import { afterEach, expect, it, vi } from 'vitest';
import { CoreChainIndexer, RANGE_TAIL, type CoreIndexerOptions } from '../../src/core/chain-indexer';
import { RpcCoreReader } from '../../src/core/core-reader';
import { agreeingCalls, ev, synthBox, synthManifest, World } from './core-synth';
import { chainRpcAnswer, fakeRpc } from './rpc-fixture';

const slot = 12_000;
const firstHour = [0, 12, 36, 72, 132, 252, 492, 972, 1_932];
const firstHourDeadlines = [null, 27, 66, 132, 252, 492, 972, 1_932, 3_732];
const urls = ['https://pruned.invalid', 'https://archive.invalid'] as const;

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function movingChain(lastBlock = 1_100n, onHistory?: CoreIndexerOptions['onHistory'], lastLogBlock = 10n) {
  vi.useFakeTimers({ now: 0, toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
  const world = new World();
  const box = synthBox({ boxId: 0n, creationBlock: 10n });
  world.block(10n, [world.created(box)]);
  for (let n = 11n; n <= lastLogBlock; n++) world.block(n, [ev.depthHeld(box, n, 0n)]);
  world.to(lastBlock);
  const chain = world.chain();
  const answer = chainRpcAnswer(chain);
  let failuresLeft = 0;
  let refusalDelayMs = 0;
  const archive: { method: string; number: bigint; seconds: number }[] = [];
  const calls = fakeRpc(async request => {
    if (request.method === 'eth_getBlockByNumber' && request.params[0] !== 'latest') {
      const number = BigInt(request.params[0] as Hex);
      if (request.url === urls[0] && number < chain.tip - 16n) {
        throw Object.assign(new Error('pruned history unavailable'), { code: 4444 });
      }
      if (request.url === urls[1]) {
        archive.push({ method: request.method, number, seconds: Date.now() / 1000 });
        if (number === chain.tip - RANGE_TAIL && failuresLeft > 0) {
          failuresLeft--;
          if (refusalDelayMs) await new Promise(resolve => setTimeout(resolve, refusalDelayMs));
          // A mismatched header ends the backfill without triggering a transport retry.
          return answer({ method: request.method, params: [toHex(number - 1n), false] });
        }
      }
    }
    return answer(request);
  });
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  let publications = 0;
  const indexer = new CoreChainIndexer({ reader: new RpcCoreReader({ urls }), manifest: synthManifest(), ...(onHistory ? { onHistory } : {}), onUpdate: () => { publications++; } });
  chain.callAnswers = agreeingCalls(indexer);
  async function headAfter(ms = slot, blocks = 1n) {
    vi.advanceTimersByTime(ms);
    chain.tip += blocks;
    await indexer.enqueue(chain.header(chain.tip));
  }
  function served() {
    return structuredClone({ publications, blocksApplied: indexer.metrics.blocksApplied,
      head: indexer.head(), feed: indexer.feedView(), rows: indexer.allRows(),
      box: indexer.boxView(box.row.contracts.token as string), recent: indexer.recent(box.row.contracts.token as string) });
  }
  function fail(count: number, delayMs = 0) {
    failuresLeft = count;
    refusalDelayMs = delayMs;
  }
  return { indexer, chain, archive, calls, errors, headAfter, served, fail };
}

it.each([false, true])('bounds attempts on a moving chain (retained head: %s)', async retained => {
  const hours = retained ? 3 : 24;
  const f = movingChain(110n + BigInt(hours * 300));
  if (retained) {
    f.chain.tip = 10n;
    await f.indexer.start();
    expect(f.indexer.boxes.size).toBe(1);
  }
  const before = f.served();
  const initialCalls = f.calls.length;
  f.fail(Infinity);
  f.chain.tip = 110n;
  if (retained) await f.indexer.enqueue(f.chain.header(f.chain.tip));
  else await f.indexer.start();
  // Pin every archive request through the first day, including every quiet 12 s head.
  for (let seconds = 12; seconds < hours * 3_600; seconds += 12) {
    const count = f.calls.length;
    const errors = f.errors.mock.calls.length;
    await f.headAfter();
    if (f.errors.mock.calls.length === errors) expect(f.calls.length).toBe(count);
  }
  const attempts = [...firstHour];
  for (let at = 3_732; at < hours * 3_600; at += 1_800) attempts.push(at);
  expect(attempts).toHaveLength(retained ? 13 : 55);
  expect(f.archive).toEqual(attempts.flatMap(seconds => {
    const end = 110n + BigInt(seconds / 12) - RANGE_TAIL;
    return (retained ? [10n, end] : [end]).map(number => ({ method: 'eth_getBlockByNumber', number, seconds }));
  }));
  expect(f.calls.slice(initialCalls).filter(c => c.url === urls[1])).toHaveLength(f.archive.length);
  expect(f.errors.mock.calls).toEqual(attempts.map((seconds, i) => {
    const target = 110n + BigInt(seconds / 12);
    const end = target - RANGE_TAIL;
    const failure = `[core-indexer] block ${target}: range backfill: header ${end} mismatched (received ${end - 1n})`;
    const due = i < firstHourDeadlines.length ? firstHourDeadlines[i] : seconds + 1_800;
    return [due == null ? failure : `${failure}; next backfill due ${new Date(due * 1000).toISOString()}`];
  }));
  expect(f.indexer.metrics.errors).toBe(attempts.length);
  expect(f.served()).toEqual(before);
  f.indexer.stop();
});

it('counts the first 15 s wait from the second refusal arriving', async () => {
  const f = movingChain();
  f.chain.tip = 110n;
  f.fail(1);
  await f.indexer.start();
  await vi.advanceTimersByTimeAsync(slot);
  f.fail(1, 10_000);
  f.chain.tip++;
  const retry = f.indexer.enqueue(f.chain.header(f.chain.tip));
  await vi.advanceTimersByTimeAsync(10_000);
  await retry;
  expect(f.errors.mock.lastCall?.[0]).toContain('next backfill due 1970-01-01T00:00:37.000Z');
  const count = f.calls.length;
  await f.headAfter(2_000); // 24 s
  await f.headAfter(); // 36 s
  expect(f.calls).toHaveLength(count);
  expect(f.errors).toHaveBeenCalledTimes(2);
  await f.headAfter(); // 48 s
  expect(f.indexer.head()?.number).toBe(114n);
  f.indexer.stop();
});

it('recovers on attempt six, follows immediately and waits only after a second long-gap failure', async () => {
  const f = movingChain();
  f.chain.tip = 110n;
  f.fail(5);
  await f.indexer.start();
  for (let seconds = 12; seconds < 252; seconds += 12) await f.headAfter();
  expect(f.indexer.head()).toBeNull();
  expect(f.errors).toHaveBeenCalledTimes(5);
  await f.headAfter();
  expect(f.indexer.head()?.number).toBe(131n);
  expect(f.indexer.boxes.size).toBe(1);
  await f.headAfter();
  expect(f.indexer.head()?.number).toBe(132n);
  f.fail(2);
  await f.headAfter(slot, 65n);
  expect(f.errors).toHaveBeenCalledTimes(6);
  expect(f.errors.mock.lastCall?.[0]).not.toContain('next backfill');
  await f.headAfter();
  expect(f.errors).toHaveBeenCalledTimes(7);
  expect(f.errors.mock.lastCall?.[0]).toContain('next backfill due 1970-01-01T00:05:03.000Z');
  const count = f.calls.length;
  await f.headAfter();
  expect(f.calls).toHaveLength(count);
  await f.headAfter();
  expect(f.indexer.head()?.number).toBe(200n);
  f.indexer.stop();
});

it('asks for the failed following block on the next head', async () => {
  const f = movingChain();
  f.chain.tip = 10n;
  await f.indexer.start();
  const hash = f.chain.header(11n).hash;
  // Inject the failure at the wire so the trace includes the ordinary second pass.
  const respond = globalThis.fetch;
  let down = true;
  const sends: { url: string; time: number; filter: unknown }[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    if (body.method === 'eth_getLogs' && body.params[0].blockHash === hash) {
      sends.push({ url: new URL(url).origin, time: Date.now(), filter: body.params[0] });
      if (down) return Promise.resolve(new Response('unavailable', { status: 500 }));
    }
    return respond(url, init);
  });
  f.chain.tip++;
  await vi.advanceTimersByTimeAsync(slot);
  const failed = f.indexer.enqueue(f.chain.header(11n));
  await vi.advanceTimersByTimeAsync(2_000);
  await failed;
  expect(f.indexer.head()?.number).toBe(10n);
  expect(f.errors.mock.lastCall?.[0]).not.toContain('next backfill');
  down = false;
  await f.headAfter(slot - 2_000);
  expect(f.indexer.head()?.number).toBe(12n);
  const primaryAt = (ms: number) => sends.filter(s => s.url === urls[0] && s.time === ms).map(s => s.filter);
  expect(primaryAt(12_000).length).toBeGreaterThan(0);
  expect(primaryAt(24_000)).toEqual(primaryAt(12_000));
  f.indexer.stop();
});

it('decides from arrival at 24 s even when the queued head runs at 36 s', async () => {
  const f = movingChain();
  f.chain.tip = 110n;
  f.fail(2);
  await f.indexer.start();
  await f.headAfter();
  expect(f.errors.mock.lastCall?.[0]).toContain('next backfill due 1970-01-01T00:00:27.000Z');
  const count = f.calls.length;
  vi.advanceTimersByTime(slot);
  const queued = f.indexer.enqueue(f.chain.header(++f.chain.tip));
  // Keep the current JS turn until the deadline passes. The scheduled head runs in the next microtask.
  vi.advanceTimersByTime(slot);
  await queued;
  expect(f.calls).toHaveLength(count);
  await f.indexer.enqueue(f.chain.header(++f.chain.tip));
  expect(f.indexer.head()?.number).toBe(113n);
  f.indexer.stop();
});

it('keeps the same wait through forward and backward wall-clock steps', async () => {
  const f = movingChain();
  f.chain.tip = 110n;
  f.fail(2);
  await f.indexer.start();
  await f.headAfter();
  const count = f.calls.length;
  vi.setSystemTime(3_612_000);
  await f.headAfter();
  expect(f.calls).toHaveLength(count);
  vi.setSystemTime(0);
  await f.headAfter();
  expect(performance.now()).toBe(36_000);
  expect(f.indexer.head()?.number).toBe(113n);
  f.indexer.stop();
});

it('starts the same stopped object immediately with a new failure row', async () => {
  const f = movingChain();
  f.chain.tip = 110n;
  f.fail(3);
  await f.indexer.start();
  await f.headAfter();
  f.indexer.stop();
  await f.indexer.start();
  expect(f.errors).toHaveBeenCalledTimes(3);
  expect(f.errors.mock.lastCall?.[0]).not.toContain('next backfill');
  await f.headAfter();
  expect(f.indexer.head()?.number).toBe(112n);
  f.indexer.stop();
});

it('keeps the row across a partial range commit and clears it when the short tail follows', async () => {
  let rejectHistory = true;
  const f = movingChain(200n, message => {
    if (message.type === 'block' && rejectHistory) {
      rejectHistory = false;
      throw new Error('history intake failed after block commit');
    }
  });
  f.chain.tip = 44n;
  f.fail(1);
  await f.indexer.start();
  // The second attempt commits block 10 before the history consumer throws.
  await f.headAfter();
  expect(f.indexer.head()?.number).toBe(10n);
  expect(f.errors.mock.lastCall?.[0]).toBe('[core-indexer] block 45: history intake failed after block commit; next backfill due 1970-01-01T00:00:27.000Z');
  await f.headAfter();
  expect(f.indexer.head()?.number).toBe(46n);
  f.fail(2);
  await f.headAfter(slot, 70n);
  expect(f.errors.mock.lastCall?.[0]).not.toContain('next backfill');
  await f.headAfter();
  expect(f.errors).toHaveBeenCalledTimes(4);
  expect(f.errors.mock.lastCall?.[0]).toContain('next backfill due 1970-01-01T00:01:03.000Z');
  f.indexer.stop();
});

it('bounds archive requests when every range commits one block and then fails', async () => {
  const f = movingChain(200n, message => {
    if (message.type === 'block') throw new Error('history intake failed after block commit');
  }, 24n);
  f.chain.tip = 110n;
  await f.indexer.start();
  for (let seconds = 12; seconds <= 240; seconds += 12) await f.headAfter();
  const failures = f.errors.mock.calls.map(([message]) => message);
  expect({
    failures: failures.length,
    waits: failures.filter(line => line.includes('next backfill due')).length,
    archiveRequests: f.calls.filter(c => c.url === urls[1]).length,
  }).toEqual({ failures: 5, waits: 4, archiveRequests: 110 });
  expect(f.indexer.head()?.number).toBe(14n);
  f.indexer.stop();
});

it('announces a deferred deep rebuild once while a retained-head backfill is waiting', async () => {
  const f = movingChain();
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
  f.chain.tip = 10n;
  await f.indexer.start();
  f.fail(2);
  await f.headAfter(slot, 100n);
  await f.headAfter();
  // A competing head at the only retained height has no retained parent.
  await vi.advanceTimersByTimeAsync(slot);
  await f.indexer.enqueue({ ...f.chain.header(10n), hash: toHex(123n, { size: 32 }) });
  expect(f.indexer.metrics.rebuilds).toBe(1);
  expect(f.indexer.head()).toBeNull();
  expect(warnings.mock.calls.filter(([line]) => String(line).includes('rebuilding'))).toEqual([
    [expect.stringContaining('backfill deferred until 1970-01-01T00:00:39.000Z')],
  ]);
  expect(f.errors).toHaveBeenCalledTimes(2);
  await f.headAfter();
  expect(f.indexer.head()?.number).toBe(112n);
  f.indexer.stop();
});

it.each([
  [{ status: 429 }, 'rate limited'],
  [{ code: -33200, message: 'request rate exceeded' }, 'rate limited'],
  [{ code: 4444, message: 'pruned history' }, 'block not held'],
  [{ code: -32000, message: 'fixture anchor refusal' }, 'fixture anchor refusal'],
] as const)('keeps the anchor refusal in a single first-failure line (%j)', async (error, cause) => {
  const f = movingChain();
  f.chain.tip = 110n;
  const end = toHex(f.chain.tip - RANGE_TAIL);
  const respond = globalThis.fetch;
  let endRead = false;
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    const { id, method, params } = JSON.parse(init.body as string);
    if (url.startsWith(urls[1]) && method === 'eth_getBlockByNumber' && params[0] === end) {
      if (endRead) return Promise.resolve('status' in error ? new Response('', { status: error.status })
        : Response.json({ jsonrpc: '2.0', id, error }));
      endRead = true;
    }
    return respond(url, init);
  });
  const start = f.indexer.start();
  await vi.runAllTimersAsync();
  await start;
  expect(f.errors).toHaveBeenCalledTimes(1);
  const line = f.errors.mock.calls[0]?.[0];
  expect(line).toContain('anchor unavailable');
  expect(line).toContain(cause);
  expect(line).not.toMatch(/[\r\n]|next backfill/);
  f.indexer.stop();
});
