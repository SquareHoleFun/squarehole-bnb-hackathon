/**
 * SH-EXISTING-NFTS-E08C: the add-on's boxes for the feed, from one indexer answer (`sh.core-set-feed.v1`), each with its
 * own card summary (set-model.ts). A box whose items are all loaded is Open only once the coordinator's trading gate
 * says so, read over the source's RPC for those boxes alone (the wire does not carry it); until then its card says
 * Loading N/N. Only where the add-on is (local, its factory checked); the production site's hook is a constant null, so
 * nothing of it ships there.
 *
 * XR-ITEM-3D-V2 F1: the feed is read as the core feeds are (SH-SITE-FIXES-10): an answer that has not come within the
 * deadline (set-indexer.ts) is a failed read, asked once more a second later, so a box link waiting on it says
 * "Unavailable" with Retry instead of reading for good.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';
import type { BoxRecord, BoxSummary } from '../boxes/box-model';
import type { CoreBuild } from '../core/core-build';
import { NO_RETRIES, failedSince, type FeedRetries } from '../core/feed-failure';
import { FEED_RETRIES, FEED_RETRY_MS } from '../core/v2/useV2';
import { readTrading } from './set-actions';
import { useSetSource } from './set-build';
import { httpSetIndexer, type SetFetcher, type SetIndexer } from './set-indexer';
import { setRecord, setSummary, type SetTrading } from './set-model';
import { rpcSetReads, type SetReads } from './set-reads';

// The add-on in this build: false on the production site, where this hook is a constant null.
const SET_BUILD = !import.meta.env?.SH_PRODUCTION;

export interface SetFeedState {
  readonly records: readonly BoxRecord[];
  readonly summaries: readonly BoxSummary[];
  /** The last refresh failed: the cards are the last good answer's, each marked Stale. */
  readonly error: string | null;
  readonly loading: boolean;
  /** SH-SITE-FIXES-10: some read has answered (kept through later failed reads); absent: unknown. */
  readonly answered?: boolean;
}

/**
 * SH-SITE-FIXES-10: while the add-on's factory is still being checked its boxes are not known yet, so a box link waits
 * (box-sources.ts lookupOf) instead of saying the box is not there.
 */
const CHECKING: SetFeedState = /* @__PURE__ */ Object.freeze({ records: [], summaries: [], error: null, loading: true, answered: false });
const UNREAD = 'The add-on’s boxes could not be read.';
/**
 * XR-ITEM-3D-V2 F2: the build names the add-on but its factory could not be checked (unreadable, as an RPC that timed
 * out, or not as pinned): its boxes were never read, so it is not loading and not answered, with its error, and a box
 * link says "Unavailable" with Retry (which checks again, set-build.ts `recheckSetFactories`). Never null: null is only
 * a source without the add-on. The words stay the feed's own (checks stay silent).
 */
const REFUSED: SetFeedState = /* @__PURE__ */ Object.freeze({ records: [], summaries: [], error: UNREAD, loading: false, answered: false });

function useSetFeedHere(build: CoreBuild, fetcher?: SetFetcher, seamReads?: SetReads, retries: FeedRetries = NO_RETRIES): SetFeedState | null {
  const set = useSetSource(build);
  const checking = set.status === 'checking';
  const refused = set.status === 'refused';
  const source = set.status === 'ready' ? set.source : null;
  const indexer = useMemo(() => (source ? httpSetIndexer(source, fetcher) : null), [source, fetcher]);
  const reads = useMemo(() => seamReads ?? (source ? rpcSetReads(source.rpc) : null), [seamReads, source]);
  const queryKey = ['set-feed', source?.chainId ?? 0, source?.release.registry.address ?? '', source?.origin ?? ''] as const;
  const query = useQuery({
    queryKey,
    queryFn: () => (indexer as SetIndexer).feed(),
    enabled: indexer !== null, refetchInterval: 6_000, retry: FEED_RETRIES, retryDelay: FEED_RETRY_MS,
  });
  // The trading gate of each box whose items are all in and that has neither failed nor graduated (the rest need none).
  const waiting = useMemo(() => (query.data?.boxes ?? []).filter((box) => box.state.seedReady && !box.state.failed && !box.state.gateOpen).map((box) => box.coordinator), [query.data]);
  const gates = useQuery({
    queryKey: ['set-feed-trading', source?.chainId ?? 0, query.data?.asOf.block ?? '', waiting.join(',')],
    queryFn: async () => {
      const read = reads as SetReads;
      const answers = await Promise.all(waiting.map(async (coordinator) => [coordinator.toLowerCase(), await readTrading(read, coordinator as Address).catch(() => null)] as const));
      return new Map<string, SetTrading | null>(answers);
    },
    enabled: reads !== null && waiting.length > 0, retry: false, placeholderData: (previous) => previous,
  });
  const failed = query.isError;
  // XR2-ITEM-3D-V2 F2: with no answer kept, failed from the first spent read through every later poll, until an answer
  // or the page's Retry (feed-failure.ts); `failed` alone went back to false as each poll started.
  const unread = failedSince(query, queryKey, retries);
  return useMemo(() => {
    if (checking) return CHECKING;
    if (refused) return REFUSED;
    if (!source || !indexer) return null;
    const feed = query.data;
    if (!feed) return { records: [], summaries: [], error: unread ? UNREAD : null, loading: !unread, answered: false };
    const records = feed.boxes.map((box) => setRecord(box, source, feed.asOf));
    const summaries = records.map((record, i) => {
      const box = feed.boxes[i] ?? (record.set as NonNullable<BoxRecord['set']>).box;
      return setSummary(record, box, failed, gates.data?.get(box.coordinator.toLowerCase()) ?? null);
    });
    return { records, summaries, error: failed ? UNREAD : null, loading: false, answered: true };
  }, [checking, refused, source, indexer, query.data, gates.data, failed, unread]);
}

/**
 * The add-on's feed answer as records and summaries; null where the add-on is not (no manifest, an invalid one, no
 * indexer to list its boxes; and the production site). A refused factory check is not "not there" (REFUSED).
 */
export const useSetFeed: (build: CoreBuild, fetcher?: SetFetcher, reads?: SetReads, retries?: FeedRetries) => SetFeedState | null = SET_BUILD ? useSetFeedHere : () => null;
