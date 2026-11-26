import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { useDataSource } from '../features/data-source';
import { useChainMarkets } from '../features/feed/chain-markets';
import { useFeedContext } from '../features/feed/feed-context';
import {
  hasActiveFilters,
  parseFeedParams,
  resolveRewardFilter,
  serialiseFeedParams,
  type FeedUrlState,
} from '../features/feed/feed-params';
import { effectiveFeedSort, hasUsableData, selectNotices, selectPinKind, selectResultsKind } from '../features/feed/feed-state';
import { FeedCards } from '../features/feed/FeedCards';
import { FeedControls, focusFirstFilter, type FeedChange } from '../features/feed/FeedControls';
import { FeedUnavailable, NoLaunches, NoMatch, SnapshotNotices } from '../features/feed/FeedStates';
import { FeedTable } from '../features/feed/FeedTable';
import { describeAddressMatches, formatAsOf, toPairView } from '../features/feed/format';
import { PlatformPin } from '../features/feed/PlatformPin';
import { ResultsBar } from '../features/feed/ResultsBar';
import { useFeed } from '../features/feed/useFeed';
import { useFitsWidth } from '../features/feed/useFitsWidth';
import { useFeedScrollRestoration } from '../features/feed/useScrollRestoration';
import { focusFeedSearch } from '../shell/search-focus';
import { PAGE_TITLE_ID, PageHeading, usePageTitle } from './page-parts';

/**
 * The table needs this much width in the results column (holders hidden, wrapped text, `rows.css`); anything narrower
 * gets full-width cards. Measured on the results column, not the viewport (02-DESIGN: no sideways-scrolling table).
 */
export const TABLE_MIN_WIDTH = 780;
const NO_NOTICES = { stale: null, partial: false } as const;

/**
 * The feed (SH-005…SH-007): compact platform pin, one search, sorts and filters in the URL, results as a table
 * (desktop) or cards (narrow), and explicit loading / empty / unavailable / stale / partial / updated states.
 */
export function FeedPage() {
  usePageTitle('Feed');
  const { allowScenario, links } = useFeedContext();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const urlState = useMemo(() => parseFeedParams(params, { allowScenario }), [params, allowScenario]);
  const feed = useFeed(urlState);
  const [resultsBoxRef, tableFits] = useFitsWidth(TABLE_MIN_WIDTH);
  const resultsRef = useRef<HTMLElement>(null);
  const source = useDataSource();
  // Restore only against the current query's rows, never a previous query's placeholder.
  useFeedScrollRestoration(feed.current || feed.isError);

  // Changes are merged into the newest URL, with unknown values resolved to their defaults. react-router hands the
  // updater the params of the last render, so a second change made before the first navigation commits (both in one
  // transition) would drop the first: the last URL written is used until a navigation has rendered.
  const rewardAssets = useRef(feed.snapshot?.rewardAssets ?? null);
  const written = useRef<string | null>(null);
  useEffect(() => {
    rewardAssets.current = feed.snapshot?.rewardAssets ?? null;
  });
  useEffect(() => {
    written.current = null;
  }, [location]);
  const change: FeedChange = useCallback(
    (patch, { replace }) => {
      setParams(
        (rendered) => {
          const current = written.current === null ? rendered : new URLSearchParams(written.current);
          const parsed = parseFeedParams(current, { allowScenario });
          const known = rewardAssets.current;
          const base: FeedUrlState = known ? resolveRewardFilter(parsed, known) : parsed;
          const next = serialiseFeedParams({ ...base, ...patch }, current);
          written.current = next;
          return next;
        },
        { replace },
      );
    },
    [setParams, allowScenario],
  );

  const { snapshot, effective } = feed;
  const asOf = snapshot?.provenance.asOf ?? null;
  const filtersActive = hasActiveFilters(effective);
  const hasData = hasUsableData(feed);
  const kind = selectResultsKind({ hasData, isError: feed.isError, totalMatches: snapshot?.totalMatches ?? 0, filtersActive });
  const pinKind = selectPinKind({ hasData, isError: feed.isError, platform: snapshot?.platform ?? null });
  const query = effective.q;
  const platformRecord = snapshot?.platform ?? null;
  const marketIds = useMemo(
    () => (source.chain ? [...feed.items, ...(platformRecord ? [platformRecord] : [])].map((pair) => pair.pairId) : []),
    [source.chain, feed.items, platformRecord],
  );
  const markets = useChainMarkets(marketIds, feed.snapshotId);
  const rows = useMemo(
    () => (asOf ? feed.items.map((pair) => toPairView(pair, { asOf, links, query, markets })) : []),
    [feed.items, asOf, links, query, markets],
  );
  const block = snapshot?.provenance.blockNumber ?? null;
  // What the rows are really ordered by (a USD sort without USD figures is launch order on a chain source).
  const order = effectiveFeedSort(effective.sort, feed.items, { chainSource: source.chain !== null });
  const matchSummary = kind === 'results' ? describeAddressMatches(rows, query) : null;

  function applyUpdate() {
    feed.update.apply();
    resultsRef.current?.focus({ preventScroll: true });
  }

  // Both buttons live in the "No pairs match" panel, which unmounts once results return: focus moves to a control
  // that stays on the page instead of falling back to the document (WCAG 2.4.3).
  function clearSearch() {
    change({ q: '' }, { replace: true });
    focusFeedSearch();
  }

  function resetFilters() {
    change({ type: 'all', reward: '', lifecycle: 'all' }, { replace: false });
    focusFirstFilter();
  }

  const Results = tableFits ? FeedTable : FeedCards;

  return (
    <section className="sh-page sh-feed" aria-labelledby={PAGE_TITLE_ID}>
      <div className="sh-feed__header">
        <PageHeading>Feed</PageHeading>
        <p className="sh-feed__lede">Launched tokens and NFT collections</p>
        <p className="sh-feed__asof">
          {source.chain ? (
            <span className="sh-feed__source" data-source={source.id}>
              {source.dataLabel}
              {block ? ` · block ${block}` : ''}
            </span>
          ) : null}
          {asOf ? <time dateTime={asOf}>{formatAsOf(asOf)}</time> : null}
          {urlState.scenario === 'default' ? null : <span className="sh-feed__scenario">Scenario: {urlState.scenario.replace('_', ' ')}</span>}
        </p>
      </div>

      <SnapshotNotices notices={snapshot ? selectNotices(snapshot.provenance) : NO_NOTICES} />

      <PlatformPin
        kind={pinKind}
        platform={snapshot?.platform ?? null}
        matchesQuery={snapshot?.platformMatchesQuery ?? true}
        asOf={asOf}
        links={links}
        markets={markets}
      />

      <FeedControls state={effective} rewardAssets={snapshot?.rewardAssets ?? []} onChange={change} revision={location} />

      {source.chain ? (
        <p className="sh-chain-note" data-testid="chain-feed-note">
          No USD source is adopted for test chains, so USD figures are unavailable and the market-cap and turnover rankings
          fall back to launch time. Figures in each pair’s quote asset come straight from the chain: pool mid price (not an
          execution quote), market cap on the fee-credit ledger’s eligible supply, and 24h turnover of the canonical pool.
        </p>
      ) : null}

      <div className="sh-results" ref={resultsBoxRef}>
        <ResultsBar
          kind={kind}
          totalMatches={snapshot?.totalMatches ?? 0}
          sort={effective.sort}
          usdUnavailable={order.usdUnavailable}
          matchSummary={matchSummary}
          update={{ available: feed.update.available, asOf: feed.update.head?.asOf ?? null, apply: applyUpdate }}
        />
        {kind === 'unavailable' ? <FeedUnavailable onRetry={feed.retry} retrying={feed.busy} /> : null}
        {kind === 'no_launches' ? <NoLaunches /> : null}
        {kind === 'no_match' ? (
          <NoMatch
            query={effective.q}
            filtersActive={effective.type !== 'all' || effective.reward !== '' || effective.lifecycle !== 'all'}
            onClearSearch={clearSearch}
            onResetFilters={resetFilters}
          />
        ) : null}
        {kind === 'loading' || kind === 'results' ? (
          <Results rows={rows} sort={order.sort} busy={feed.busy} loading={kind === 'loading'} resultsRef={resultsRef} />
        ) : null}
        {feed.hasMore ? (
          <p className="sh-load-more">
            <button type="button" className="sh-button" onClick={feed.loadMore} disabled={feed.loadingMore}>
              {feed.loadingMore ? 'Loading…' : 'Load more'}
            </button>
          </p>
        ) : null}
        {feed.loadMoreFailed ? (
          <p className="sh-load-more sh-load-more--failed" role="alert">
            More pairs could not be loaded.{' '}
            <button type="button" className="sh-button" onClick={feed.loadMore}>
              Try again
            </button>
          </p>
        ) : null}
      </div>
    </section>
  );
}
