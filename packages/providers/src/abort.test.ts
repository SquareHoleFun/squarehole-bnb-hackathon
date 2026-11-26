import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderUnavailableError, createMockFeedProvider } from './index';
import { expectAbortError, pid, query, settles } from './test-support';

afterEach(() => {
  vi.useRealTimers();
});

describe('AbortSignal handling', () => {
  it('rejects immediately with AbortError when the signal is already aborted', async () => {
    const provider = createMockFeedProvider();
    const signal = AbortSignal.abort();
    await expectAbortError(provider.readFeed(query(), signal));
    await expectAbortError(provider.readPair(pid('66'), signal));
    await expectAbortError(provider.latestSnapshot(signal));
  });

  it('waits for the simulated latency, then resolves', async () => {
    vi.useFakeTimers();
    const provider = createMockFeedProvider({ latencyMs: 1000 });
    const pending = provider.readFeed(query());
    vi.advanceTimersByTime(999);
    expect(await settles(pending)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(await settles(pending)).toBe(true);
    await expect(pending).resolves.toMatchObject({ totalMatches: 11 });
  });

  it('rejects with AbortError during simulated latency and clears its timer', async () => {
    vi.useFakeTimers();
    const provider = createMockFeedProvider({ latencyMs: 1000 });
    const controller = new AbortController();
    const pending = provider.readFeed(query(), controller.signal);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(500);
    controller.abort(new Error('custom reason is not leaked'));
    await expectAbortError(pending);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an abort before latency ends wins over the unavailable failure', async () => {
    vi.useFakeTimers();
    const provider = createMockFeedProvider({ scenario: 'unavailable', latencyMs: 100 });
    const controller = new AbortController();
    const pending = provider.readFeed(query(), controller.signal);
    controller.abort();
    await expectAbortError(pending);
  });

  it('loading scenario never resolves until aborted (readFeed, readPair, latestSnapshot)', async () => {
    vi.useFakeTimers();
    const provider = createMockFeedProvider({ scenario: 'loading' });
    const controller = new AbortController();
    const reads = [
      provider.readFeed(query(), controller.signal),
      provider.readPair(pid('66'), controller.signal),
      provider.latestSnapshot(controller.signal),
    ];
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    for (const read of reads) expect(await settles(read)).toBe(false);
    controller.abort();
    for (const read of reads) await expectAbortError(read);
  });

  it('unavailable scenario rejects with the typed ProviderUnavailableError', async () => {
    const provider = createMockFeedProvider({ scenario: 'unavailable' });
    for (const read of [provider.readFeed(query()), provider.readPair(pid('66')), provider.latestSnapshot()]) {
      const error: unknown = await read.then(
        () => null,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(ProviderUnavailableError);
      expect(error).toMatchObject({ name: 'ProviderUnavailableError', code: 'provider_unavailable' });
    }
  });

  it('rejects invalid construction options', () => {
    expect(() => createMockFeedProvider({ latencyMs: -1 })).toThrow(RangeError);
    expect(() => createMockFeedProvider({ latencyMs: 1.5 })).toThrow(RangeError);
    expect(() => createMockFeedProvider({ latencyMs: 60_001 })).toThrow(RangeError);
    expect(() => createMockFeedProvider({ scenario: 'chaos' as never })).toThrow(RangeError);
  });
});
