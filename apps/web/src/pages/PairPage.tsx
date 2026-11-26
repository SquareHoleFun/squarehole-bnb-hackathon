import { CastCharacter } from '@squarehole/design';
import type { PairRouteFailure } from '@squarehole/domain';
import { MOCK_SCENARIOS, type MockScenario } from '@squarehole/providers';
import { useEffect, useRef } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useDataSource } from '../features/data-source';
import { useFeedContext } from '../features/feed/feed-context';
import { selectNotices } from '../features/feed/feed-state';
import { RefreshIcon, WarningIcon } from '../features/feed/feed-icons';
import { SnapshotNotices } from '../features/feed/FeedStates';
import { formatAsOf, toPairView } from '../features/feed/format';
import { ChainMarketCard } from '../features/pair/ChainMarketCard';
import { PairDetailBody } from '../features/pair/PairDetailView';
import { PairHeader } from '../features/pair/PairHeader';
import { BackIcon } from '../features/pair/pair-icons';
import { usePairDetail } from '../features/pair/usePairDetail';
import { PAGE_TITLE_ID, PageHeading, usePageTitle } from './page-parts';
import { resolvePairRoute } from './pair-route';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

// The mock scenarios exist only with the Demo (the production site reads none of them).
const SCENARIOS: ReadonlyMap<string, MockScenario> = DEMO_BUILD ? new Map(MOCK_SCENARIOS.map((s) => [s, s] as const)) : new Map();

type PageState = 'invalid' | 'unavailable' | 'not_found' | 'loading' | 'ready';

/**
 * The shell focuses the page heading after a navigation. When the state then swaps the heading for another one
 * (loading → not found / unavailable), focus would drop to the document; this puts it on the new heading. It never
 * moves focus on a first page load, only when the heading had it.
 */
function useKeepHeadingFocus(state: PageState) {
  const headingFocused = useRef(false);
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      headingFocused.current = event.target instanceof Element && event.target.id === PAGE_TITLE_ID;
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, []);
  useEffect(() => {
    if (headingFocused.current && document.activeElement === document.body) {
      document.getElementById(PAGE_TITLE_ID)?.focus({ preventScroll: true });
    }
  }, [state]);
}

function BackToFeed() {
  return (
    <p className="sh-pair-back">
      <Link to="/pairs" className="sh-pair-back__link">
        <BackIcon />
        Feed
      </Link>
    </p>
  );
}

const PAGE_TITLES: Readonly<Partial<Record<PageState, string>>> = {
  invalid: 'Not a valid pair address',
  unavailable: 'Pair unavailable',
  not_found: 'Pair not found',
  loading: 'Pair detail',
};

const ROUTE_FAILURE_TEXT: Readonly<Record<PairRouteFailure, string>> = {
  malformed_chain_id: 'The chain id in this link is not a positive whole number.',
  malformed_address: 'The address in this link is not 0x followed by 40 hexadecimal characters.',
  chain_mismatch: 'This snapshot only shows pairs on local chain 31337. A pair on another chain is never looked up here.',
};

/** Chain data sources name their own chain (the demo keeps the wording above). */
function routeFailureText(reason: PairRouteFailure, chainId: number, demo: boolean): string {
  if (reason !== 'chain_mismatch' || demo) return ROUTE_FAILURE_TEXT[reason];
  return `This data source only shows pairs on chain ${chainId}. A pair on another chain is never looked up here.`;
}

function InvalidPair({ reason }: { reason: PairRouteFailure }) {
  const source = useDataSource();
  return (
    <section className="sh-page" aria-labelledby={PAGE_TITLE_ID}>
      <div className="sh-page__header">
        <PageHeading>Not a valid pair address</PageHeading>
      </div>
      <div className="sh-panel sh-pair-missing" data-reason={reason}>
        <CastCharacter id="sorter" size={84} caption={false} />
        <div className="sh-pair-missing__body">
          <p>{routeFailureText(reason, source.chainId, DEMO_BUILD && source.isDemo)}</p>
          <p>
            Pair links look like <code>/pair/{source.chainId}/0x</code> followed by 40 hexadecimal characters. We don’t guess which
            pair you meant.
          </p>
          <p>
            <Link to="/pairs" className="sh-button">
              Back to the feed
            </Link>
          </p>
        </div>
      </div>
    </section>
  );
}

function PairNotFound({ pairId }: { pairId: string }) {
  const source = useDataSource();
  return (
    <section className="sh-page" aria-labelledby={PAGE_TITLE_ID}>
      <div className="sh-page__header">
        <PageHeading>Pair not found</PageHeading>
      </div>
      <div className="sh-panel sh-pair-missing" data-reason="unknown_pair">
        <CastCharacter id="sorter" size={84} caption={false} />
        <div className="sh-pair-missing__body">
          <p>
            No launched pair has the id <code>{pairId}</code> {DEMO_BUILD && source.isDemo ? 'in this snapshot' : `on ${source.dataLabel}`}. The
            Sorter checked the square hole anyway.
          </p>
          <p>
            <Link to="/pairs" className="sh-button">
              Back to the feed
            </Link>
          </p>
        </div>
      </div>
    </section>
  );
}

function PairUnavailable({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  return (
    <section className="sh-page" aria-labelledby={PAGE_TITLE_ID}>
      <BackToFeed />
      <div className="sh-page__header">
        <PageHeading>Pair unavailable</PageHeading>
      </div>
      <div className="sh-alert sh-panel" role="alert">
        <WarningIcon />
        <div className="sh-alert__body">
          <h2 className="sh-alert__title">This pair can’t be read right now</h2>
          <p>Nothing is shown as empty or zero in its place.</p>
          <p className="sh-empty__actions">
            <button type="button" className="sh-button" onClick={onRetry} disabled={retrying} aria-busy={retrying}>
              <RefreshIcon />
              Try again
            </button>
          </p>
        </div>
      </div>
    </section>
  );
}

/** `/pair/:chainId/:address`: read-only pair detail (SH-012) with external destinations (SH-013). No trade form. */
export function PairPage() {
  const { chainId, address } = useParams();
  const [params] = useSearchParams();
  const { allowScenario, links } = useFeedContext();
  const source = useDataSource();
  const route = resolvePairRoute(chainId, address, source.chainId);
  const scenario = allowScenario ? (SCENARIOS.get(params.get('scenario') ?? '') ?? 'default') : 'default';
  const query = usePairDetail(route.ok ? route.pairId : null, scenario);
  const record = query.data?.record ?? null;
  const state: PageState = !route.ok
    ? 'invalid'
    : query.isError
      ? 'unavailable'
      : query.data && !record
        ? 'not_found'
        : record
          ? 'ready'
          : 'loading';
  usePageTitle(PAGE_TITLES[state] ?? `${record?.name ?? 'Pair'} · Pair detail`);
  useKeepHeadingFocus(state);

  if (!route.ok) return <InvalidPair reason={route.reason} />;
  if (state === 'unavailable') return <PairUnavailable onRetry={() => void query.refetch()} retrying={query.isFetching} />;
  if (state === 'not_found') return <PairNotFound pairId={route.pairId} />;

  const detail = query.data?.detail ?? null;
  const view = record ? toPairView(record, { asOf: record.provenance.asOf, links }) : null;
  const asOf = record?.provenance.asOf ?? null;
  return (
    <section className="sh-page sh-pair" aria-labelledby={PAGE_TITLE_ID} aria-busy={record === null}>
      <div className="sh-pair-top">
        <BackToFeed />
        <p className="sh-feed__asof">
          {source.chain ? (
            <span className="sh-feed__source" data-source={source.id}>
              {source.dataLabel}
              {record?.provenance.blockNumber ? ` · block ${record.provenance.blockNumber}` : ''}
            </span>
          ) : null}
          {asOf ? <time dateTime={asOf}>{formatAsOf(asOf)}</time> : null}
          {scenario === 'default' ? null : <span className="sh-feed__scenario">Scenario: {scenario.replace('_', ' ')}</span>}
        </p>
      </div>
      {record ? <SnapshotNotices notices={selectNotices(detail?.provenance ?? record.provenance)} /> : null}
      <PairHeader pair={record} detail={detail} view={view} />
      {record && source.chain ? <ChainMarketCard pair={record} /> : null}
      {record && view ? (
        <PairDetailBody pair={record} detail={detail} view={view} links={links} />
      ) : (
        <div className="sh-pair-loading" aria-hidden="true">
          <span className="sh-skeleton sh-pair-loading__block" />
          <span className="sh-skeleton sh-pair-loading__block" />
        </div>
      )}
    </section>
  );
}
