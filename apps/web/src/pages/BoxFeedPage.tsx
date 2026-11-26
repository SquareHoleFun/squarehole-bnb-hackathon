import type { Address } from '@squarehole/domain';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Link, Navigate, useLocation, useSearchParams } from 'react-router';
import { useDataSource } from '../features/data-source';
import { BoxCard, BoxTable, FeaturedBoxCard, WalletCard, type CardLinkProps, type WalletCardFacts } from '../features/boxes/BoxCard';
import { demoSummary } from '../features/boxes/box-figure';
import { filterSummaries, mixedAssets, sortAvailability, sortSummaries, stateCounts, walletQuery } from '../features/boxes/box-feed';
import { pairFeedRedirect, parseBoxFeedParams, serialiseBoxFeedParams, type BoxFeedUrlState } from '../features/boxes/box-feed-params';
import { BoxFeedControls, type BoxFeedChange } from '../features/boxes/BoxFeedControls';
import { boxPath } from '../features/boxes/box-id';
import type { BoxRecord, BoxSummary } from '../features/boxes/box-model';
import { launchRecord, lookupOf, type BoxSources } from '../features/boxes/box-sources';
import { FEED_WORDS } from '../features/boxes/feed-words';
import { useBoxSources } from '../features/boxes/useBoxSources';
import { useLaunchSummary } from '../features/boxes/useLaunchBox';
import { LAUNCHES_PATH } from '../features/create/picture/LaunchOn';
import { activeLaunchRail, LaunchRails } from '../features/boxes/LaunchRails';
import { LaunchCards } from '../features/launch-cards/LaunchCards';
import { demoWalletBox, walletStats } from '../features/boxes/wallet-box';
import type { DemoScenario } from '../features/fit-pair/demo-chain';
import type { FitBuild, FitMarketTarget } from '../features/fit-pair/fit-target';
import { InfoButton, InfoPanel, useInfoTip } from '../features/fit-pair/InfoTip';
import { PlusIcon } from '../shell/icons';
import { LiveLine } from '../shell/PartFailed';
import { focusFeedSearch, focusSearchIfRequested } from '../shell/search-focus';
import type { CoreBuild } from '../features/core/core-build';
import type { Fetcher } from '../features/core/core-client';
import { PAGE_TITLE_ID, PageHeading, usePageTitle } from './page-parts';
import { chainRowOf } from '../features/core/row-record';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

export interface BoxFeedPageProps {
  /** Test seam: what the build embeds (production: `virtual:squarehole-deployments`). */
  readonly build?: FitBuild;
  /** Test seams for core v1: the build's core manifests and indexers, and how the site fetches. */
  readonly coreBuild?: CoreBuild;
  readonly fetcher?: Fetcher;
}

/** Where a card goes: the box page, keeping a chosen Demo scenario for the Demo Misfits. */
function linkTo(record: BoxRecord, scenario: DemoScenario): string {
  return record.market && DEMO_BUILD && record.demo && scenario !== 'curve' ? `${boxPath(record.id)}?scenario=${scenario}` : boxPath(record.id);
}

/**
 * Home: the feed of boxes (F46; BOX-INTERFACE § 3). One search over names, tickers and addresses (a full address that
 * is no box shows that wallet as a box-shaped card, view only), state chips with counts, one sort, Grid or List. The
 * Misfits launch is pinned first ("Featured"). Every card links to the one box page; nothing on this page asks a
 * wallet for anything. An old link to the pair feed (it was here before the launch set) opens this feed with its search.
 */
export function BoxFeedPage(props: BoxFeedPageProps) {
  usePageTitle('Boxes');
  const [params] = useSearchParams();
  const fromPairs = pairFeedRedirect(params);
  if (fromPairs) return <Navigate replace to={fromPairs} />;
  const rail = activeLaunchRail(params);
  return (
    <section className="sh-page sh-box-feed" aria-labelledby={PAGE_TITLE_ID}>
      <LaunchRails params={params} />
      {rail ? (
        <>
          <div className="sh-box-feed__head">
            <PageHeading>Boxes</PageHeading>
            <a href={`${LAUNCHES_PATH}#/${rail}/create`} className="sh-button sh-box-feed__create">
              <PlusIcon />
              {rail === 'flap' ? 'Launch on Flap' : 'Launch on Four.meme'}
            </a>
          </div>
          <LaunchCards rail={rail} ready query="" />
        </>
      ) : <BoxesFeed {...props} />}
    </section>
  );
}

function BoxesFeed({ build, coreBuild, fetcher }: BoxFeedPageProps) {
  const source = useDataSource();
  const sources = useBoxSources(build, coreBuild, fetcher);
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const url = useMemo(() => parseBoxFeedParams(params, { allowScenario: DEMO_BUILD && source.isDemo }), [params, source.isDemo]);

  // Changes merge into the newest URL written, as on the pair feed (two changes before a render keep both).
  const written = useRef<string | null>(null);
  useEffect(() => {
    written.current = null;
  }, [location]);
  const change: BoxFeedChange = useCallback(
    (patch, { replace }) => {
      setParams(
        (rendered) => {
          const current = written.current === null ? rendered : new URLSearchParams(written.current);
          const parsed = parseBoxFeedParams(current, { allowScenario: DEMO_BUILD && source.isDemo });
          const next = serialiseBoxFeedParams({ ...parsed, ...patch }, current);
          written.current = next.toString();
          return next;
        },
        { replace },
      );
    },
    [setParams, source.isDemo],
  );

  const target = sources.launch;
  if (target) return <LaunchFeed key={`${source.id}:${url.scenario}`} sources={sources} target={target} url={url} change={change} />;
  return <BoxFeedView sources={sources} launch={null} url={url} change={change} />;
}

function LaunchFeed({ sources, target, url, change }: { sources: BoxSources; target: FitMarketTarget; url: BoxFeedUrlState; change: BoxFeedChange }) {
  const record = useMemo(() => sources.boxes.find((box) => box.market === target) ?? launchRecord(target), [sources, target]);
  const summary = useLaunchSummary(record, target, url.scenario);
  return <BoxFeedView sources={sources} launch={summary} url={url} change={change} />;
}

/** The feed's count: all boxes, or how many of them the search and the state chip leave, and a wallet found. */
function countLine(shown: number, total: number, wallet: boolean): string {
  const boxes = (n: number) => `${n} ${n === 1 ? 'box' : 'boxes'}`;
  const listed = shown === total ? boxes(total) : `${shown} of ${boxes(total)}`;
  if (!wallet) return listed;
  return shown === 0 ? '1 wallet' : `1 wallet · ${listed}`;
}

function SortNote() {
  const tip = useInfoTip();
  return (
    <div className="sh-box-note">
      <p>
        Sorted within each pair asset <InfoButton tip={tip} label="Why within each pair asset" />
      </p>
      <InfoPanel tip={tip}>
        <p>FDV and volume are in each box’s own pair asset, so boxes are sorted within each asset, never converted.</p>
      </InfoPanel>
    </div>
  );
}

/**
 * Each card's own summary (BC-085, the regression at BoxFeedPage.tsx:106 where every market card got the one launch
 * summary): a core v1 row's from its own card of the one feed answer, the launch market's (the Demo Misfits, a v2
 * rehearsal) from its live curve, keyed by the record it belongs to, a Demo box's from its fixed figures. A box whose
 * figure is not known says "Unavailable", never another box's.
 */
export function feedSummaries(sources: BoxSources, launch: BoxSummary | null): BoxSummary[] {
  const unavailable = (record: BoxRecord): BoxSummary => ({ record, state: null, figure: { text: 'Unavailable', barBps: null }, mcapRaw: null, progressBps: null, volumeRaw: null, notice: null });
  const rowSummaries = sources.core.status === 'ready' ? sources.core.summaries : null;
  return sources.boxes.map((record) => {
    const own = rowSummaries?.get(record.id);
    if (own) return own;
    if (record.market) return launch !== null && launch.record.id === record.id ? launch : unavailable(record);
    if (chainRowOf(record)) return unavailable(record);
    return DEMO_BUILD ? demoSummary(record) : unavailable(record);
  });
}

/** What the feed says about core v1 on this source when it has no row to show (S10a § 2.3). */
function coreLine(sources: BoxSources): string | null {
  const core = sources.core;
  if (core.status === 'loading') return 'Reading the boxes…';
  if (core.status === 'error') return `The boxes could not be read: ${core.reason}`;
  if (core.status === 'awaiting-broadcast') return core.reason;
  if (core.status === 'invalid') return core.reason;
  return null;
}

function BoxFeedView({ sources, launch, url, change }: { sources: BoxSources; launch: BoxSummary | null; url: BoxFeedUrlState; change: BoxFeedChange }) {
  const source = useDataSource();
  const summaries = useMemo(() => feedSummaries(sources, launch), [sources, launch]);
  const core = coreLine(sources);
  const searched = useMemo(() => filterSummaries(summaries, 'all', url.q), [summaries, url.q]);
  const counts = useMemo(() => stateCounts(searched), [searched]);
  const listed = useMemo(() => sortSummaries(filterSummaries(summaries, url.state, url.q), url.sort), [summaries, url.state, url.q, url.sort]);
  const volumeOff = sortAvailability(listed, 'volume');
  const wallet = walletQuery(summaries, url.q);
  // What a searched wallet holds, when the source can say it without a read (the Demo's two box wallets); a chain
  // wallet is read on its own page.
  const walletFacts: WalletCardFacts | null = useMemo(() => {
    if (wallet === null || !(DEMO_BUILD && source.isDemo)) return null;
    const stats = walletStats(demoWalletBox(wallet as Address, sources.boxes));
    return { items: stats.items, boxes: stats.boxes };
  }, [wallet, source.isDemo, sources.boxes]);
  const rows: CardLinkProps[] = listed.map((summary) => ({ summary, to: linkTo(summary.record, url.scenario) }));
  // A wallet is the only result: the state chips (all 0) would say nothing about it.
  const onlyWallet = wallet !== null && rows.length === 0;
  const featured = url.view === 'grid' ? rows.filter((row) => row.summary.record.featured) : [];
  const rest = url.view === 'grid' ? rows.filter((row) => !row.summary.record.featured) : rows;
  // SH-246: "No boxes yet." only once every part of the source answered; a part still reading says so, a part that
  // could not be read at all says the list may be missing boxes (or did not load), with Retry.
  const lookup = sources.lookup ?? lookupOf(sources.core);
  const unreachable = lookup.status === 'unreachable';
  const reading = sources.core.status === 'loading' || lookup.status === 'loading';
  const retry = sources.retry;
  // Retry takes its own line away (the parts read again): the page's heading keeps the keyboard, as on the box page.
  const onRetry = retry ? () => { document.getElementById(PAGE_TITLE_ID)?.focus({ preventScroll: true }); retry(); } : undefined;
  const retryButton = unreachable && onRetry ? <button type="button" className="sh-button" onClick={onRetry}>{FEED_WORDS.retry}</button> : null;
  const emptyLine = reading ? 'Reading the boxes…' : unreachable ? FEED_WORDS.none : DEMO_BUILD ? `No boxes on ${source.dataLabel} in this build.` : 'No boxes yet.';
  const emptyNote = reading || unreachable ? null : (core ?? sources.missing);
  // SH-246 (review M3): nothing to list while the feeds are still read or could not be read: no count ("0 boxes") and no
  // state chips ("All 0"), which would claim what is not known.
  const countUnknown = summaries.length === 0 && (reading || unreachable);
  // A lazy page: the header's "Search boxes" may have asked for the field before this page had loaded.
  useEffect(() => {
    focusSearchIfRequested();
  }, []);

  function clear() {
    change({ q: '', state: 'all' }, { replace: false });
    focusFeedSearch();
  }

  return (
    <>
      <div className="sh-box-feed__head">
        <PageHeading>Boxes</PageHeading>
        {/* A polite live region: it follows the search and the state chip ("2 of 6 boxes"), as the pair feed's "N pairs". */}
        <p className="sh-box-feed__count" role="status">
          {countUnknown && wallet === null ? '' : countLine(rows.length, summaries.length, wallet !== null)}
        </p>
        {DEMO_BUILD && source.isDemo && url.scenario !== 'curve' ? <p className="sh-feed__asof"><span className="sh-feed__scenario">Scenario: {url.scenario.replace('_', ' ')}</span></p> : null}
        <Link to="/create" className="sh-button sh-box-feed__create">
          <PlusIcon />
          Launch a box
        </Link>
      </div>
      <BoxFeedControls state={url} counts={counts} volumeOff={volumeOff} onChange={change} chips={!onlyWallet && !countUnknown} />
      {(url.sort === 'mcap' || url.sort === 'volume') && mixedAssets(listed) ? <SortNote /> : null}
      {unreachable && summaries.length > 0 ? (
        <div className="sh-panel sh-part-failed" data-feed="partial">
          <LiveLine text={FEED_WORDS.partial} />
          {retryButton}
        </div>
      ) : null}
      {wallet ? (
        <ul className="sh-box-grid" aria-label="Wallet">
          <WalletCard address={wallet} facts={walletFacts} demo={DEMO_BUILD && source.isDemo} />
        </ul>
      ) : null}
      {summaries.length === 0 ? (
        <div className="sh-panel sh-box-empty" data-feed={reading ? 'reading' : unreachable ? 'none' : 'empty'}>
          {/* A read that failed says so: never "no boxes" (the boxes may well be there; S10a review, SH-246). */}
          {/* SH-TA-12: the public site's empty feed is one short line (nothing listed yet, e.g. no v2 box on Sepolia). */}
          {/* SH-246 (review L2): the line is the live region, from "Reading the boxes…" on, and Retry stays outside it. */}
          <p role="status">{emptyLine}</p>
          {emptyNote ? <p className="sh-muted">{emptyNote}</p> : null}
          {retryButton}
        </div>
      ) : rows.length === 0 ? (
        wallet ? null : (
          <div className="sh-panel sh-box-empty">
            <p>No boxes match.</p>
            <button type="button" className="sh-button" onClick={clear}>
              Clear search and state
            </button>
          </div>
        )
      ) : url.view === 'list' ? (
        <BoxTable rows={rows} />
      ) : (
        <ul className="sh-box-grid" aria-label="Boxes">
          {featured.map((row) => (
            <FeaturedBoxCard key={row.summary.record.id} {...row} />
          ))}
          {rest.map((row) => (
            <BoxCard key={row.summary.record.id} {...row} />
          ))}
        </ul>
      )}
      {/* SH-289: the launches on Flap and Four.meme (BNB build), under "All", read once the boxes have answered. */}
      {url.state === 'all' && !wallet ? <LaunchCards ready={!reading} query={url.q} /> : null}
    </>
  );
}

export default BoxFeedPage;
