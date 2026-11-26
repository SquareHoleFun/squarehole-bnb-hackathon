/**
 * SH-SITE-FIXES-10: a read with a deadline (deadline.ts), and the two feed reads that use it: the v2 feed
 * (indexer-v2.ts loadFeedV2) and core v1's indexer reads (core-client.ts loadFeed, which then reads the chain). A request
 * that is never answered is aborted at the deadline and its read fails, so a retry can ask again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeadlineError, withDeadline } from './deadline';
import { INDEXER_DEADLINE_MS, loadFeed, type DirectReader, type Fetcher, type ReadyCore } from './core-client';
import { FEED_DEADLINE_MS, loadFeedV2, type V2Source } from './v2/indexer-v2';

/** Only what the feed read uses before its answer: where it asks, and for which chain. */
const SOURCE = { network: 'local', origin: 'http://indexer.test', rpc: 'http://127.0.0.1:8599', manifest: { chainId: 31337 } } as unknown as V2Source;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

/** A fetcher that never answers (and ignores its signal, as a stuck connection would), keeping each signal it got. */
function silent() {
  const signals: AbortSignal[] = [];
  const fetcher: Fetcher = (_url, init) => { if (init?.signal) signals.push(init.signal); return new Promise(() => undefined); };
  return { fetcher, signals };
}

describe('withDeadline', () => {
  it('an answer in time is the answer; nothing is aborted afterwards', async () => {
    let signal: AbortSignal | null = null;
    const answer = await withDeadline(1_000, undefined, async (s) => { signal = s; return 7; });
    expect(answer).toBe(7);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((signal as AbortSignal | null)?.aborted).toBe(false);
  });
  it('no answer: at the deadline the request’s signal aborts and the read fails, even if the fetcher ignores the signal', async () => {
    let signal: AbortSignal | null = null;
    const read = withDeadline(1_000, undefined, (s) => { signal = s; return new Promise<never>(() => undefined); });
    const failed = expect(read).rejects.toBeInstanceOf(DeadlineError);
    await vi.advanceTimersByTimeAsync(999);
    expect((signal as AbortSignal | null)?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await failed;
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    await expect(read).rejects.toThrow('no answer within 1 s');
  });
  it('an outer abort stops the read with its reason at once; an aborted signal starts nothing', async () => {
    const outer = new AbortController();
    let signal: AbortSignal | null = null;
    const read = withDeadline(1_000, outer.signal, (s) => { signal = s; return new Promise<never>(() => undefined); });
    outer.abort(new Error('left'));
    await expect(read).rejects.toThrow('left');
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    const start = vi.fn(async () => 1);
    await expect(withDeadline(1_000, outer.signal, start)).rejects.toThrow('left');
    expect(start).not.toHaveBeenCalled();
  });
});

describe('the feed reads', () => {
  it('v2: the feed request carries a signal; with no answer it is aborted at FEED_DEADLINE_MS and the read fails', async () => {
    const { fetcher, signals } = silent();
    const read = loadFeedV2(SOURCE, fetcher);
    const failed = expect(read).rejects.toBeInstanceOf(DeadlineError);
    await vi.advanceTimersByTimeAsync(FEED_DEADLINE_MS - 1);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await failed;
    expect(signals[0]?.aborted).toBe(true);
    expect(FEED_DEADLINE_MS).toBe(8_000);
  });
  it('v2: a stalled body counts too (headers came, the JSON never does)', async () => {
    const read = loadFeedV2(SOURCE, async () => ({ ok: true, status: 200, json: () => new Promise(() => undefined) }));
    const failed = expect(read).rejects.toBeInstanceOf(DeadlineError);
    await vi.advanceTimersByTimeAsync(FEED_DEADLINE_MS);
    await failed;
  });
  it('core v1: an indexer feed with no answer is abandoned at INDEXER_DEADLINE_MS and the chain is read instead, saying why', async () => {
    const { fetcher, signals } = silent();
    const direct: DirectReader = { feed: vi.fn(async () => ({ via: 'direct' as const, asOf: null, cards: [], dropped: 0 })), box: vi.fn(), wallet: vi.fn() };
    const core = { indexerOrigin: 'http://indexer.test', chainId: 31337 } as unknown as ReadyCore;
    const read = loadFeed(core, fetcher, direct);
    await vi.advanceTimersByTimeAsync(INDEXER_DEADLINE_MS);
    const feed = await read;
    expect(signals[0]?.aborted).toBe(true);
    expect(feed.via).toBe('direct');
    expect(feed.indexerError).toBe('The indexer did not answer: no answer within 8 s');
    expect(direct.feed).toHaveBeenCalledTimes(1);
  });
});
