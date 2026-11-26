import { FeedCursorError, FeedQueryError, type FeedProvider, type FeedQuery, type FeedSnapshot } from '@squarehole/domain';
import { createMockFeedProvider, type MockScenario } from '@squarehole/providers';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../../app-providers';
import { createFeedSession, type FeedSession } from './feed-session';
import { DEFAULT_FEED_STATE, type FeedUrlState } from './feed-params';
import { useFeed } from './useFeed';

afterEach(cleanup);

const SNAPSHOT = 'demo-20260925T120000Z';
const USDC = '0x000000000000000000000000000000000000232a';

type ReadFeed = FeedProvider['readFeed'];

/** Wraps a real mock provider so every call (query + signal) is recorded. */
function spiedProvider(scenario: MockScenario = 'default', transform: (query: FeedQuery) => FeedQuery = (q) => q) {
  const inner = createMockFeedProvider({ scenario });
  const readFeed = vi.fn<ReadFeed>((query, signal) => inner.readFeed(transform(query), signal));
  const latestSnapshot = vi.fn((signal?: AbortSignal) => inner.latestSnapshot(signal));
  const provider: FeedProvider = { readFeed, readPair: inner.readPair, latestSnapshot };
  return { provider, readFeed, latestSnapshot };
}

function setup(provider: FeedProvider, initial: FeedUrlState = DEFAULT_FEED_STATE, session: FeedSession = createFeedSession()) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AppProviders feedSources={() => ({ provider, mode: 'demo' })} feedSession={session}>
      {children}
    </AppProviders>
  );
  return renderHook((state: FeedUrlState) => useFeed(state), { wrapper, initialProps: initial });
}

const names = (items: readonly { name: string }[]) => items.map((item) => item.name);

describe('useFeed (TanStack Query over the FeedProvider boundary)', () => {
  it('reads the sanitised default query, pinned to the provider head, with an AbortSignal and no cursor', async () => {
    const { provider, readFeed, latestSnapshot } = spiedProvider();
    const { result } = setup(provider);
    expect(result.current.hasData).toBe(false);
    await waitFor(() => expect(result.current.hasData).toBe(true));
    expect(readFeed).toHaveBeenCalledTimes(1);
    expect(latestSnapshot.mock.invocationCallOrder[0]).toBeLessThan(readFeed.mock.invocationCallOrder[0] ?? 0);
    const [query, signal] = readFeed.mock.calls[0] ?? [];
    expect(query).toEqual({ search: '', sort: 'market_cap', type: 'all', lifecycle: 'all', limit: 20, snapshotId: SNAPSHOT });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(result.current.items).toHaveLength(11);
    expect(result.current.snapshot?.totalMatches).toBe(11);
    expect(result.current.snapshot?.platform?.name).toBe('Square Hole');
  });

  it('pins the first snapshot: later filter reads name it, and pinning does not read again', async () => {
    const { provider, readFeed } = spiedProvider();
    const { result, rerender } = setup(provider);
    await waitFor(() => expect(result.current.hasData).toBe(true));
    await waitFor(() => expect(result.current.snapshotId).toBe(SNAPSHOT));
    expect(readFeed).toHaveBeenCalledTimes(1);
    rerender({ ...DEFAULT_FEED_STATE, sort: 'new' });
    await waitFor(() => expect(result.current.items[0]?.name).toBe('NO PRICE YET'));
    expect(readFeed).toHaveBeenCalledTimes(2);
    expect(readFeed.mock.calls[1]?.[0]).toMatchObject({ sort: 'new', snapshotId: SNAPSHOT });
  });

  it('aborts the superseded request when the query changes (stale-response cancellation)', async () => {
    const signals: AbortSignal[] = [];
    const readFeed = vi.fn<ReadFeed>(
      (_query, signal) =>
        new Promise<FeedSnapshot>((_resolve, reject) => {
          if (signal) signals.push(signal);
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const provider: FeedProvider = { readFeed, readPair: async () => null };
    const { rerender, result } = setup(provider, { ...DEFAULT_FEED_STATE, q: 'or' });
    await waitFor(() => expect(readFeed).toHaveBeenCalledTimes(1));
    rerender({ ...DEFAULT_FEED_STATE, q: 'orc' });
    await waitFor(() => expect(readFeed).toHaveBeenCalledTimes(2));
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(result.current.busy).toBe(true);
  });

  it('ranking updated: offers the newer snapshot, keeps the order on screen, and applying it restarts at page one', async () => {
    const { provider, readFeed } = spiedProvider('ranking_updated');
    const { result } = setup(provider);
    await waitFor(() => expect(result.current.update.available).toBe(true));
    expect(result.current.update.head?.snapshotId).toBe(`${SNAPSHOT}-r2`);
    expect(names(result.current.items).slice(0, 2)).toEqual(['ORCHARD', 'ROUND TRIP']);
    act(() => result.current.update.apply());
    await waitFor(() => expect(result.current.snapshotId).toBe(`${SNAPSHOT}-r2`));
    await waitFor(() => expect(names(result.current.items).slice(0, 2)).toEqual(['ROUND TRIP', 'ORCHARD']));
    expect(result.current.update.available).toBe(false);
    const last = readFeed.mock.calls.at(-1)?.[0];
    expect(last).toMatchObject({ snapshotId: `${SNAPSHOT}-r2` });
    expect(last?.cursor).toBeUndefined();
  });

  it('ranking updated also works under StrictMode double mounting', async () => {
    const { provider } = spiedProvider('ranking_updated');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>
        <AppProviders feedSources={() => ({ provider, mode: 'demo' })}>{children}</AppProviders>
      </StrictMode>
    );
    const { result } = renderHook(() => useFeed(DEFAULT_FEED_STATE), { wrapper });
    await waitFor(() => expect(result.current.update.available).toBe(true));
    expect(result.current.snapshotId).toBe(SNAPSHOT);
    expect(names(result.current.items).slice(0, 2)).toEqual(['ORCHARD', 'ROUND TRIP']);
  });

  it('loads more with the page cursor and the pinned snapshot, appending in provider order', async () => {
    const { provider, readFeed } = spiedProvider('default', (query) => ({ ...query, limit: 5 }));
    const { result } = setup(provider);
    await waitFor(() => expect(result.current.items).toHaveLength(5));
    expect(result.current.hasMore).toBe(true);
    await act(async () => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toHaveLength(10));
    const second = readFeed.mock.calls.at(-1)?.[0];
    expect(second?.cursor).toEqual(expect.any(String));
    expect(second?.snapshotId).toBe(SNAPSHOT);
    await act(async () => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toHaveLength(11));
    expect(result.current.hasMore).toBe(false);
    expect(names(result.current.items)).toEqual([
      'ORCHARD', 'ROUND TRIP', 'MISFIT STUDIO', 'APPLEHOLE', 'TINY FRAMES', 'SOFT CORNERS',
      'WRONG ANGLE', 'COIN CONFETTI', 'LITTLE ORCHARD', 'NEW SHAPE', 'NO PRICE YET',
    ]);
  });

  it('never sends a reward address the snapshot does not offer', async () => {
    const { provider, readFeed } = spiedProvider();
    const unknown = '0x00000000000000000000000000000000000000ff';
    const { result } = setup(provider, { ...DEFAULT_FEED_STATE, reward: unknown });
    await waitFor(() => expect(result.current.items).toHaveLength(11));
    expect(result.current.effective.reward).toBe('');
    for (const [query] of readFeed.mock.calls) expect(query.rewardAddress).toBeUndefined();
  });

  it('sends a known reward address once the snapshot’s reward assets are known', async () => {
    const { provider, readFeed } = spiedProvider();
    const { result } = setup(provider, { ...DEFAULT_FEED_STATE, reward: USDC });
    await waitFor(() => expect(result.current.effective.reward).toBe(USDC));
    await waitFor(() => expect(names(result.current.items)).toEqual(['MISFIT STUDIO', 'SOFT CORNERS', 'NEW SHAPE']));
    expect(readFeed.mock.calls.at(-1)?.[0]).toMatchObject({ rewardAddress: USDC, snapshotId: SNAPSHOT });
  });

  it('unavailable: reports the error without data, and "retry" reads again', async () => {
    const { provider, readFeed, latestSnapshot } = spiedProvider('unavailable');
    const reads = () => readFeed.mock.calls.length + latestSnapshot.mock.calls.length;
    const { result } = setup(provider);
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.hasData).toBe(false);
    const calls = reads();
    expect(calls).toBeGreaterThan(0);
    await act(async () => result.current.retry());
    await waitFor(() => expect(reads()).toBeGreaterThan(calls));
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it.each([
    ['unknown_snapshot', () => new FeedQueryError('unknown_snapshot', 'gone')],
    ['snapshot_mismatch', () => new FeedCursorError('snapshot_mismatch', 'gone')],
  ])('drops a pinned snapshot the provider rejects (%s) and reads the latest one', async (_code, makeError) => {
    const inner = createMockFeedProvider();
    const readFeed = vi.fn<ReadFeed>((query, signal) =>
      query.snapshotId === 'gone' ? Promise.reject(makeError()) : inner.readFeed(query, signal),
    );
    const session = createFeedSession();
    session.set('default', { snapshotId: 'gone', rewardAssets: [] });
    const { result } = setup({ readFeed, readPair: inner.readPair }, DEFAULT_FEED_STATE, session);
    await waitFor(() => expect(result.current.snapshotId).toBe(SNAPSHOT));
    expect(result.current.items).toHaveLength(11);
    expect(session.get('default')?.snapshotId).toBe(SNAPSHOT);
  });

  it('deduplicates rows by canonical pair id across pages (03-FEED)', async () => {
    const inner = createMockFeedProvider();
    let seen: FeedSnapshot['items'][number] | undefined;
    const readFeed = vi.fn<ReadFeed>(async (query, signal) => {
      const page = await inner.readFeed({ ...query, limit: 2 }, signal);
      if (!query.cursor) {
        seen = page.items[0];
        return page;
      }
      // A misbehaving source repeats a row from page one on page two.
      return { ...page, items: seen ? [seen, ...page.items] : page.items };
    });
    const { result } = setup({ readFeed, readPair: inner.readPair });
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    await act(async () => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toHaveLength(4));
    expect(new Set(result.current.items.map((item) => item.pairId.toLowerCase())).size).toBe(4);
  });
});
