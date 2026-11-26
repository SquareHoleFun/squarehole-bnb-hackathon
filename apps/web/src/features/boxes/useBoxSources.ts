import { useV2Feed } from '../core/v2/useV2';
import { recordV2, summaryV2 } from '../core/v2/record-v2';
import { usePriceCoinSymbolsV2 } from '../core/v2/price-coin';
import { FIT_MARKETS } from 'virtual:squarehole-deployments';
import { useCallback, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useDataSource } from '../data-source';
import type { CoreBuild } from '../core/core-build';
import type { Fetcher } from '../core/core-client';
import { NO_RETRIES, unansweredFeed, type FeedRetries } from '../core/feed-failure';
import { BUILD_CORE, useClockMs, useCoreFeed, useCoreSource } from '../core/useCore';
import { useDemoV2Closed } from '../core/v2/demo-v2';
import type { FitBuild } from '../fit-pair/fit-target';
import { boxesFor, lookupOf, withCoreRows, type BoxSources, type CoreSourcesState, type LookupPart } from './box-sources';
import { createdBoxRecords, useCreatedBoxes, type CreatedBoxEntry } from './created-boxes';
import { BUILD_SET, recheckSetFactories } from '../set/set-build';
import { useSetFeed, type SetFeedState } from '../set/useSetFeed';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

const NO_CREATED: readonly CreatedBoxEntry[] = Object.freeze([]);
const NO_CLOSED: ReadonlyMap<string, bigint> = new Map();
// The Demo's tab state (boxes created here, Demo v2 boxes closed here), chosen once per build: the production site
// reads neither (a constant hook, so the hooks' order never changes).
const useCreated: () => readonly CreatedBoxEntry[] = DEMO_BUILD ? useCreatedBoxes : () => NO_CREATED;
const useClosedV2: () => ReadonlyMap<string, bigint> = DEMO_BUILD ? useDemoV2Closed : () => NO_CLOSED;

/**
 * The boxes of the current data source; one object per source, so the live curve is keyed on a stable target. On the
 * Demo the boxes created in this tab join them (their "Opens in" counts from creation, read once per page). On a chain
 * source the core v1 boxes join from ONE feed answer (S10a; BC-085), each with its own card's summary.
 */
export function useBoxSources(build?: FitBuild, coreBuild: CoreBuild = BUILD_CORE, fetcher?: Fetcher): BoxSources {
  const source = useDataSource();
  const created = useCreated();
  const [now] = useState(() => Date.now());
  // XR2-ITEM-3D-V2 F2: the failures each feed had seen at this page's last Retry (feed-failure.ts): a feed that never
  // answered stays unavailable through its polls, and only a failure after a Retry ends that Retry's "Reading".
  const [retries, setRetries] = useState<FeedRetries>(NO_RETRIES);
  const core = useCoreSource(coreBuild);
  const feed = useCoreFeed(core, fetcher, retries);
  const clockMs = useClockMs();
  const v2 = useV2Feed(coreBuild, fetcher, retries);
  // SH-BOX-LIFE-VIEW § 3: each v2 box names its price coin by the coin's own symbol (read once per coin), never "P".
  const v2Coins = useMemo(() => v2.snapshots.map((snapshot) => snapshot.record.q), [v2.snapshots]);
  const coinSymbol = usePriceCoinSymbolsV2(v2.source, v2Coins);
  // SH-EXISTING-NFTS-E08C: the existing-NFTs add-on's boxes (local only: none unless the build names its manifest and
  // its factory checks out; a test's own core build carries the add-on only when it names one).
  const sets = useSetFeed(coreBuild === BUILD_CORE ? BUILD_SET : coreBuild, fetcher, undefined, retries);
  const demo = DEMO_BUILD && source.isDemo;
  const createdRecords = useMemo(() => (demo ? createdBoxRecords(created, now) : []), [demo, created, now]);
  const closedV2 = useClosedV2();
  const base = useMemo(
    () => boxesFor(source.id, build ?? { fitMarkets: FIT_MARKETS, localRpcUrl: source.localRpcUrl }, createdRecords, { nowSec: BigInt(Math.floor(now / 1000)), closed: closedV2 }),
    [source.id, source.localRpcUrl, build, createdRecords, now, closedV2],
  );
  // SH-SITE-FIXES-10: Retry reads again only the feeds that never answered (each says loading until its answer, or a new
  // failure); a feed that answered keeps its boxes, and the polling goes on meanwhile. XR-ITEM-3D-V2 F2: and the
  // add-on's factory check when it was refused (its feed is read once the check passes). XR2-ITEM-3D-V2 F2: a read
  // already under way is joined, never cancelled and replaced (refetchQueries runs no second read for a query with no
  // data, query-core query.js fetch; resetQueries did, beside the first one's request), and the failures counted until
  // now are recorded so that only a later one counts.
  const queries = useQueryClient();
  const retry = useCallback(() => {
    recheckSetFactories();
    const failed = queries.getQueryCache().findAll({ type: 'active', predicate: unansweredFeed });
    setRetries(new Map(failed.map((query) => [query.queryHash, query.state.errorUpdateCount])));
    void queries.refetchQueries({ type: 'active', predicate: unansweredFeed }, { cancelRefetch: false });
  }, [queries]);
  const v1 = useMemo(() => {
    if (core.status !== 'ready') return core.status === 'none' && demo ? base : { ...base, core: core as CoreSourcesState };
    // SH-258: no core v1 version (BNB Chain testnet): v1 answers with no rows at once, never asked, never loading, so the
    // v2 feed alone decides what the page shows.
    if (core.version1 === null) return { ...base, missing: null, core: { status: 'ready' as const, via: 'indexer' as const, summaries: new Map(), dropped: 0, refreshError: null, indexerError: null } };
    const state: CoreSourcesState =
      feed === null || feed.status === 'loading'
        ? { status: 'loading' }
        : feed.status === 'error'
          ? { status: 'error', reason: feed.reason }
          : { status: 'ready', via: feed.value.via, summaries: new Map(), dropped: feed.value.dropped, refreshError: feed.refreshError, indexerError: feed.value.indexerError ?? null };
    // The clock ticks every few seconds: a Sepolia card a minute old turns Stale even while its refreshes fail.
    return withCoreRows(base, state, feed?.status === 'ready' ? feed.value : null, core.network, now, clockMs, core.artGateways);
  }, [base, core, feed, now, clockMs, demo]);
  // SH-246 (review M1): whether box 0's feed has failed on this page. Its first read holds the merged sources at loading
  // (BC-086, below); a read again after a failure (the feed's Retry) does not: the boxes already on the page keep their
  // figures meanwhile.
  const [v1HadFailed, setV1HadFailed] = useState(false);
  if (v1.core.status === 'error' && !v1HadFailed) setV1HadFailed(true);
  const v1Part = useMemo(() => v1PartOf(v1.core), [v1.core]);
  // Without v2 the sources keep one object while nothing changes (the feed's memos are keyed on it), as before.
  const withoutV2 = useMemo(() => ({ ...withSetBoxes(v1, sets), lookup: lookupOf(v1.core, null, setsPartOf(sets)), retry, v1: v1Part, v2: null }), [v1, sets, retry, v1Part]);
  if (!v2.source && !v2.error) return withoutV2;
  const summaries = new Map(v1.core.status === 'ready' ? v1.core.summaries : []);
  const v2Source = v2.source;
  const additions = v2Source ? v2.snapshots.map((snapshot) => {
    const record = recordV2(v2.error ? { ...snapshot, stale: true } : snapshot, v2Source, v2.read, coinSymbol(snapshot.record.q));
    summaries.set(record.id, summaryV2(record, snapshot, v2.error !== null || (v2Source.network === 'sepolia' && BigInt(Math.floor(clockMs / 1000)) > snapshot.timestamp + 60n)));
    return record;
  }) : [];
  // Box 0 lives in the v1 feed: while that feed loads, a v2 answer or failure arriving first leaves the sources loading
  // (otherwise /misfits falls back to the launch market's box before box 0 can come, the flaky BC-086 case).
  const v1Loading = v1.core.status === 'loading' && !v1HadFailed;
  const sources = withSetBoxes({ ...v1, boxes: [...v1.boxes, ...additions.filter((r) => !v1.boxes.some((known) => known.id === r.id))], core: (additions.length > 0 && !v1Loading) || v1.core.status === 'ready'
    ? { status: 'ready', via: 'indexer', summaries, dropped: v1.core.status === 'ready' ? v1.core.dropped : 0, refreshError: v2.error }
    : v1Loading || v2.loading ? { status: 'loading' } : v2.error ? { status: 'error', reason: v2.error } : v1.core }, sets);
  // SH-SITE-FIXES-10: `core` says ready once core v1 has answered, while v2 may still be loading (the feed shows box 0
  // meanwhile); a box link says "not found" only once v2 has answered too (box-sources.ts `lookupOf`).
  const v2Part: LookupPart = { loading: v2.loading, answered: v2.answered, error: v2.error };
  return { ...sources, lookup: lookupOf(v1.core, v2Part, setsPartOf(sets)), retry, v1: v1Part, v2: v2Part };
}

/** SH-246: box 0's feed on its own (null: the source has no core v1 feed to read). */
function v1PartOf(core: CoreSourcesState): LookupPart | null {
  if (core.status === 'loading') return { loading: true, answered: false, error: null };
  if (core.status === 'ready') return { loading: false, answered: true, error: null };
  if (core.status === 'error') return { loading: false, answered: false, error: core.reason };
  return null;
}

/**
 * The add-on's part of a box link's lookup (box-sources.ts lookupOf); null where the source has no add-on. A factory
 * check that was refused is a part that could not be read (useSetFeed.ts REFUSED), never an absent one.
 */
function setsPartOf(sets: SetFeedState | null): LookupPart | null {
  return sets === null ? null : { loading: sets.loading, answered: sets.answered ?? sets.records.length > 0, error: sets.error };
}

/**
 * The add-on's boxes after the source's others, each with its own card summary (SH-EXISTING-NFTS-E08C); without them
 * (no add-on, no answer yet) the sources are returned as they are. While box 0's feed still loads nothing joins
 * (BC-086), and a token already listed is not listed twice.
 */
export function withSetBoxes(sources: BoxSources, sets: SetFeedState | null): BoxSources {
  if (sets === null || sets.records.length === 0 || sources.core.status === 'loading') return sources;
  const known = new Set(sources.boxes.map((box) => box.id));
  const fresh = sets.records.filter((record) => !known.has(record.id));
  if (fresh.length === 0) return sources;
  const summaries = new Map(sources.core.status === 'ready' ? sources.core.summaries : []);
  for (const summary of sets.summaries) if (!known.has(summary.record.id)) summaries.set(summary.record.id, summary);
  const core: CoreSourcesState = sources.core.status === 'ready' ? { ...sources.core, summaries }
    : { status: 'ready', via: 'indexer', summaries, dropped: 0, refreshError: sets.error };
  return { ...sources, boxes: [...sources.boxes, ...fresh], core, missing: sources.core.status === 'ready' ? sources.missing : null };
}
