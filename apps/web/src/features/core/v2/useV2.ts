import { useMemo } from 'react';
import { queryOptions, useQuery } from '@tanstack/react-query';
import type { CoreBuild } from '../core-build';
import type { Fetcher } from '../core-client';
import { NO_RETRIES, failedSince, type FeedRetries } from '../feed-failure';
import { useDataSource } from '../../data-source';
import { feedKeyV2, readFeedV2, sourceV2, type V2Source } from './indexer-v2';

/** How often the feed is read again (the indexer answers about once a block). */
export const FEED_POLL_MS = 4_000;
/**
 * SH-SITE-FIXES-10: a failed or unanswered feed read (FEED_DEADLINE_MS) is asked once more, a second later, before the
 * page says it is unavailable; the polling then goes on, so a later answer still shows the boxes.
 */
export const FEED_RETRIES = 1;
export const FEED_RETRY_MS = 1_000;

/**
 * The feed's one query, for every reader of it (useV2Feed, the card after Create): one key, one read with its deadline
 * (FEED_DEADLINE_MS: a request with no answer is aborted), one retry. react-query's signal is left unread on purpose: a
 * read that consumed it is cancelled whenever its last page goes (query-core query.js removeObserver), and the next
 * page, which reads the same feed, would start it over.
 */
export const feedQueryV2 = (source: V2Source, fetcher?: Fetcher) => queryOptions({
  queryKey: feedKeyV2(source),
  queryFn: () => readFeedV2(source, fetcher),
  refetchInterval: FEED_POLL_MS,
  retry: FEED_RETRIES,
  retryDelay: FEED_RETRY_MS,
});

/**
 * The source's v2 feed for the box pages. XR2-ITEM-3D-V2 F2: a feed that never answered stays failed (`error`, not
 * `loading`) through its later polls until an answer comes or the page's Retry (`retries`, feed-failure.ts).
 */
export function useV2Feed(build: CoreBuild, fetcher?: Fetcher, retries: FeedRetries = NO_RETRIES) {
  const data = useDataSource();
  const resolved = useMemo(() => {
    try { return { source: sourceV2(data.id, build), error: null }; }
    catch (error) { return { source: null, error: error instanceof Error ? error.message : 'V2 data unavailable' }; }
  }, [data.id, build]);
  const source = resolved.source;
  const query = useQuery({ ...feedQueryV2(source as V2Source, fetcher), enabled: source !== null });
  const answered = query.data !== undefined;
  const failed = source !== null && failedSince(query, feedKeyV2(source), retries);
  // `read`: which feed read these snapshots came from (LINKS-WEB fix round 2: a save gives way only to a later read).
  // `answered`: some read has answered (its snapshots are kept through later failed reads); until then a box missing from
  // `snapshots` is not known to be absent (SH-SITE-FIXES-10). `error` after an answer: the last refresh failed.
  return { source, snapshots: query.data?.snapshots ?? [], read: query.data?.read ?? null, loading: source !== null && !answered && !failed, error: resolved.error ?? ((answered ? query.isError : failed) ? 'V2 data unavailable' : null), answered };
}
