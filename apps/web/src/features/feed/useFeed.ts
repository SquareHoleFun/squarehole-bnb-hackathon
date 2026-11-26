/**
 * Feed data through TanStack Query (SH-005…SH-007).
 *
 * - One read per query key; every read passes the query's AbortSignal, so a request superseded by a newer search or
 *   filter (the old key loses its last observer) is aborted rather than raced (08-SECURITY "stale-response cancellation").
 * - Snapshot pinning (03-FEED): the first read uses the latest snapshot; every later read (filters, sorts, pages)
 *   names that snapshot, so rows never reorder by themselves. A newer snapshot is only offered ("Show updated
 *   ranking"); applying it moves the pin and restarts pagination from page one.
 * - A `?reward=` address is only sent once the pinned snapshot's reward assets are known and include it.
 */
import {
  FeedCursorError,
  FeedQueryError,
  canonicalPairId,
  type FeedQuery,
  type FeedSnapshot,
  type PairRecord,
  type SnapshotHead,
} from '@squarehole/domain';
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useFeedContext } from './feed-context';
import { DEFAULT_FEED_STATE, isRewardAddress, resolveRewardFilter, serialiseFeedParams, toFeedQuery, type FeedUrlState } from './feed-params';
import { updateAvailable } from './feed-state';

/** How often the ranking head is re-checked while the feed is open. */
export const HEAD_POLL_MS = 60_000;

export interface FeedUpdate {
  readonly available: boolean;
  readonly head: SnapshotHead | undefined;
  readonly apply: () => void;
}

export interface FeedData {
  /** URL state after resolving values the snapshot does not know (e.g. an unknown reward address). */
  readonly effective: FeedUrlState;
  /** First page of the data on screen (platform, counts, reward assets, provenance). */
  readonly snapshot: FeedSnapshot | undefined;
  readonly snapshotId: string | null;
  /** Organic rows of every loaded page, in provider order, deduplicated by canonical pair id. */
  readonly items: readonly PairRecord[];
  readonly hasData: boolean;
  /** The first page belongs to the current query (not a previous query's placeholder). */
  readonly current: boolean;
  /** A read is in flight (aria-busy). */
  readonly busy: boolean;
  readonly isError: boolean;
  readonly retry: () => void;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly loadMoreFailed: boolean;
  readonly loadMore: () => void;
  readonly update: FeedUpdate;
}

function isSnapshotGone(error: unknown): boolean {
  return (
    (error instanceof FeedQueryError && error.code === 'unknown_snapshot') ||
    (error instanceof FeedCursorError && error.code === 'snapshot_mismatch')
  );
}

function dedupe(pages: readonly FeedSnapshot[]): PairRecord[] {
  const seen = new Set<string>();
  const rows: PairRecord[] = [];
  for (const page of pages) {
    for (const pair of page.items) {
      const key = canonicalPairId(pair.pairId);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(pair);
    }
  }
  return rows;
}

export function useFeed(urlState: FeedUrlState): FeedData {
  const { sourceFor, session } = useFeedContext();
  const queryClient = useQueryClient();
  const scenario = urlState.scenario;
  const { provider } = sourceFor(scenario);
  const pin = useSyncExternalStore(
    session.subscribe,
    () => session.get(scenario),
    () => session.get(scenario),
  );
  const pinnedId = pin?.snapshotId ?? null;
  const latestSnapshot = provider.latestSnapshot?.bind(provider);

  /**
   * Every read names a snapshot. Before anything is pinned, the provider's current head is resolved first, so a
   * duplicate or abandoned first read (StrictMode, fast navigation) can never let a newer ranking in unasked.
   */
  async function readSnapshot(query: FeedQuery, signal: AbortSignal): Promise<FeedSnapshot> {
    if (pinnedId !== null) return provider.readFeed({ ...query, snapshotId: pinnedId }, signal);
    if (!latestSnapshot) return provider.readFeed(query, signal);
    const head = await latestSnapshot(signal);
    return provider.readFeed({ ...query, snapshotId: head.snapshotId }, signal);
  }

  // Reward assets of the pinned snapshot decide whether a `?reward=` address is known.
  const needsRewardAssets = isRewardAddress(urlState.reward) && !pin?.rewardAssets;
  const meta = useQuery({
    queryKey: ['feed-meta', scenario, pinnedId],
    queryFn: ({ signal }) => readSnapshot({ ...toFeedQuery(DEFAULT_FEED_STATE), limit: 1 }, signal),
    enabled: needsRewardAssets,
    staleTime: Infinity,
  });

  const effective = pin?.rewardAssets ? resolveRewardFilter(urlState, pin.rewardAssets) : urlState;
  const filterKey = serialiseFeedParams({ ...effective, scenario: 'default' });

  const feed = useInfiniteQuery({
    queryKey: ['feed', scenario, pinnedId, filterKey],
    queryFn: ({ pageParam, signal }) =>
      readSnapshot({ ...toFeedQuery(effective), ...(pageParam === null ? {} : { cursor: pageParam }) }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: !needsRewardAssets,
    placeholderData: keepPreviousData,
    // A pinned snapshot never changes, so its pages never go stale.
    staleTime: Infinity,
  });

  const head = useQuery({
    queryKey: ['feed-head', scenario],
    queryFn: ({ signal }) => (latestSnapshot ? latestSnapshot(signal) : Promise.reject(new Error('no latestSnapshot'))),
    enabled: pinnedId !== null && latestSnapshot !== undefined,
    refetchInterval: HEAD_POLL_MS,
  });

  const first = feed.data?.pages[0];
  const firstIsCurrent = first !== undefined && !feed.isPlaceholderData;

  // Pin the snapshot of the first unpinned read, reusing its pages (no second read), and learn its reward assets.
  useEffect(() => {
    if (!firstIsCurrent || !first || !feed.data) return;
    if (pinnedId === null) {
      queryClient.setQueryData(['feed', scenario, first.snapshotId, filterKey], feed.data);
      session.set(scenario, { snapshotId: first.snapshotId, rewardAssets: first.rewardAssets });
    } else if (!pin?.rewardAssets && first.snapshotId === pinnedId) {
      session.set(scenario, { snapshotId: pinnedId, rewardAssets: first.rewardAssets });
    }
  }, [firstIsCurrent, first, feed.data, pinnedId, pin, queryClient, scenario, filterKey, session]);

  useEffect(() => {
    const data = meta.data;
    if (!data || (pinnedId !== null && data.snapshotId !== pinnedId)) return;
    if (pin?.snapshotId === data.snapshotId && pin.rewardAssets) return;
    session.set(scenario, { snapshotId: data.snapshotId, rewardAssets: data.rewardAssets });
  }, [meta.data, pinnedId, pin, scenario, session]);

  // The provider no longer holds the pinned snapshot: forget it (and any cached "latest" read) and start again.
  const failure = feed.error ?? meta.error;
  useEffect(() => {
    if (pinnedId === null || !isSnapshotGone(failure)) return;
    queryClient.removeQueries({ queryKey: ['feed', scenario, null] });
    session.set(scenario, null);
  }, [failure, pinnedId, queryClient, scenario, session]);

  const items = useMemo(() => dedupe(feed.data?.pages ?? []), [feed.data]);
  const isError = feed.isError || meta.isError;

  return {
    effective,
    snapshot: first,
    snapshotId: first?.snapshotId ?? null,
    items,
    hasData: first !== undefined,
    current: firstIsCurrent,
    busy: feed.isFetching || meta.isFetching,
    isError,
    retry: () => {
      if (meta.isError) void meta.refetch();
      else void feed.refetch();
    },
    hasMore: feed.hasNextPage,
    loadingMore: feed.isFetchingNextPage,
    loadMoreFailed: feed.isFetchNextPageError,
    loadMore: () => {
      if (feed.hasNextPage && !feed.isFetchingNextPage) void feed.fetchNextPage();
    },
    update: {
      available: updateAvailable(pinnedId, head.data),
      head: head.data,
      apply: () => {
        if (head.data) session.set(scenario, { snapshotId: head.data.snapshotId, rewardAssets: null });
      },
    },
  };
}
