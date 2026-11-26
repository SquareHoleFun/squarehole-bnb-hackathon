import { V2BoxPage } from '../features/core/v2/V2BoxPage';
import { SetBoxPage } from '../features/set/SetBoxPage';
import { CastCharacter } from '@squarehole/design';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useParams, useSearchParams } from 'react-router';
import { useDataSource } from '../features/data-source';
import { AboutPanel } from '../features/boxes/AboutPanel';
import { priceTrusted } from '../features/boxes/box-figure';
import { boxPath, formatBoxId, parseBoxId, parseBoxRoute } from '../features/boxes/box-id';
import type { BoxRecord, BoxState } from '../features/boxes/box-model';
import { findBox, lookupOf, misfitsPackFor } from '../features/boxes/box-sources';
import type { CoreBuild } from '../features/core/core-build';
import type { Fetcher } from '../features/core/core-client';
import { RowBoxPage } from '../features/core/RowBoxPage';
import { demoHeader, launchBand, launchPhase, launchStats } from '../features/boxes/box-stats';
import { BoxHeader } from '../features/boxes/BoxHeader';
import { CONTENTS_LEAD_ID, ContentsPanel, type ContentsCounts, type EditionSize } from '../features/boxes/ContentsPanel';
import { countersFor } from '../features/boxes/counters';
import { OwnRow, PeekStrip } from '../features/boxes/HeaderSide';
import { MISFITS_TAGLINE } from '../features/boxes/misfits-content';
import { OWNING_LEAD_ID, OwningPanel, PriceExplainer } from '../features/boxes/OwningPanel';
import { chargedQuote, priceModel } from '../features/boxes/price-model';
import { SectionBar, useSectionParam, type Section } from '../features/boxes/SectionBar';
import { DemoTokenPanel, LaunchTokenPanel } from '../features/boxes/TokenPanel';
import { useBoxSources } from '../features/boxes/useBoxSources';
import { useLaunchBox, type LaunchBoxSeams } from '../features/boxes/useLaunchBox';
import { ContractAddress } from '../features/fit-pair/ContractAddress';
import { isDemoScenario, type DemoScenario } from '../features/fit-pair/demo-chain';
import { formatCount, shortAddress } from '../features/fit-pair/fit-format';
import { DisclosureIcon, freshnessWord, staleDetail } from '../features/fit-pair/FitParts';
import type { FitBuild, FitMarketTarget } from '../features/fit-pair/fit-target';
import type { LiveView } from '../features/fit-pair/live-controller';
import type { VaultState } from '../features/fit-pair/useLivePool';
import { BackIcon } from '../features/pair/pair-icons';
import { CopyButton } from '../features/pair/CopyButton';
import { PAGE_TITLE_ID, PageHeading, usePageTitle } from './page-parts';
import { chainRowOf } from '../features/core/row-record';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;
// SH-EXISTING-NFTS-E08C: the existing-NFTs add-on is local only until its release ticket: none on the production site.
const SET_BUILD = !import.meta.env?.SH_PRODUCTION;

type Tab = 'contents' | 'token' | 'owning' | 'about';
const SECTIONS: readonly Section<Tab>[] = [
  { id: 'contents', label: 'What’s in the box?' },
  { id: 'token', label: 'Token' },
  { id: 'owning', label: 'Owning one' },
  { id: 'about', label: 'About' },
];
/** The Demo Misfits' states, for the Demo-only switcher. */
const DEMO_STATES: readonly (readonly [DemoScenario, string])[] = [
  ['before_open', 'Upcoming'],
  ['window', 'Launch window'],
  ['curve', 'Bonding'],
  ['completed', 'Graduating'],
  ['migrated', 'Graduated'],
];

function BackToBoxes() {
  return (
    <p className="sh-pair-back">
      <Link to="/" className="sh-pair-back__link">
        <BackIcon />
        Boxes
      </Link>
    </p>
  );
}

export interface BoxPageProps {
  /** Test seam: what the build embeds (production: `virtual:squarehole-deployments`). */
  readonly build?: FitBuild;
  /** Test seams for core v1: the build's core manifests and indexers, and how the site fetches. */
  readonly coreBuild?: CoreBuild;
  readonly fetcher?: Fetcher;
}

/**
 * `/box/:chain/:address`: one template for every box (F46; BOX-INTERFACE § 4, § 9): the header (cover and state band,
 * chips, name, address, phase, the peek strip and "Owning one", four stats, the counters), then the same four sections
 * for every box. Read-only: vault actions are not in this app yet, the only working action is a verified link out;
 * nothing asks a wallet for anything on navigation. `?scenario=` picks a state of the Demo Misfits and is honoured only
 * for the Demo data. A box link in another spelling (an upper-case address, the earlier `/box/<chainId>-<token>`) is
 * replaced by its canonical path.
 */
export function BoxPage({ build, coreBuild, fetcher }: BoxPageProps) {
  // `/box/:chain/:address`; the earlier `/box/:id` (`<chainId>-<token>`) is redirected.
  const { id, chain, address } = useParams();
  const { pathname, search } = useLocation();
  const source = useDataSource();
  const sources = useBoxSources(build, coreBuild, fetcher);
  const [params] = useSearchParams();
  const parsed = id !== undefined ? parseBoxId(id) : parseBoxRoute(chain, address);
  const canonical = parsed ? formatBoxId(parsed.chainId, parsed.token) : null;
  const record = canonical ? findBox(sources, canonical) : null;
  const requested = params.get('scenario');
  const scenario: DemoScenario = DEMO_BUILD && source.isDemo && isDemoScenario(requested) ? requested : 'curve';
  // SH-SITE-FIXES-10: while any part of the source (core v1, v2, the add-on) has not answered, nothing is said about the
  // box; a part that could not be read at all leaves it unavailable, with a retry; "not in this source" only once every
  // part answered without it. A link that is no box address says so at once.
  const lookup = sources.lookup ?? lookupOf(sources.core);
  const shown = record ? `box:${record.id}` : parsed === null ? 'malformed' : lookup.status;
  // Retry replaces the page's content in place (Reading, then the box or Unavailable again), so the pressed button is
  // gone: the new heading takes focus, as after a page change, and is announced.
  const [retries, setRetries] = useState(0);
  useEffect(() => {
    if (retries > 0) document.getElementById(PAGE_TITLE_ID)?.focus({ preventScroll: true });
  }, [retries, shown]);
  const retry = sources.retry;
  const onRetry = retry ? () => { setRetries((count) => count + 1); retry(); } : undefined;
  if (canonical !== null && boxPath(canonical) !== pathname) return <Navigate replace to={`${boxPath(canonical)}${search}`} />;
  if (!record) {
    if (parsed === null) return <NotInSource label={DEMO_BUILD && source.isDemo ? null : source.dataLabel} malformed />;
    if (lookup.status === 'loading') return <ReadingBox />;
    if (lookup.status === 'unreachable') return <UnavailableBox reason={lookup.reason} onRetry={onRetry} />;
    return <NotInSource label={DEMO_BUILD && source.isDemo ? null : source.dataLabel} malformed={false} />;
  }
  // SH-EXISTING-NFTS-E08C: a box of the existing-NFTs add-on (local only; the production site has none).
  if (SET_BUILD && record.set) return <SetBoxPage key={record.id} record={record} />;
  if (record.v2Chain && !(DEMO_BUILD && record.demo)) return <V2BoxPage key={record.id} record={record} />;
  // SH-258 round 3: a BNB build has no market record (no box 0); the launch page folds away with its reads.
  if (record.market && !(import.meta.env?.SH_BNB === true)) return <LaunchBoxPage key={`${source.id}:${record.id}:${scenario}`} record={record} target={record.market} scenario={scenario} />;
  // A core v1 box on a chain source: its page from its row and snapshot (S10a § 5).
  if (chainRowOf(record)) return <RowBoxPage key={`${source.id}:${record.id}`} record={record} {...(coreBuild ? { coreBuild } : {})} {...(fetcher ? { fetcher } : {})} />;
  // The Demo's own boxes (the five, the created ones); the production site has none.
  return DEMO_BUILD ? <DemoBoxPage record={record} /> : <NotInSource label={DEMO_BUILD && source.isDemo ? null : source.dataLabel} malformed={false} />;
}

/** While the source's boxes are read (a chain source's feed answer): nothing is guessed meanwhile. */
function ReadingBox() {
  usePageTitle('Box');
  return (
    <section className="sh-page sh-fit-page sh-box-page" aria-labelledby={PAGE_TITLE_ID} data-freshness="loading">
      <BackToBoxes />
      <div className="sh-page__header">
        <PageHeading>Reading the box…</PageHeading>
      </div>
    </section>
  );
}

/**
 * The source's boxes could not be read (SH-SITE-FIXES-10: no answer in time, the server unreachable, or an answer that
 * failed its checks): a few words and Retry; the reason only behind Details. Nothing is claimed about the box.
 */
function UnavailableBox({ reason, onRetry }: { reason: string; onRetry?: () => void }) {
  usePageTitle('Box unavailable');
  return (
    <section className="sh-page sh-fit-page sh-box-page" aria-labelledby={PAGE_TITLE_ID} data-freshness="unavailable">
      <BackToBoxes />
      <div className="sh-page__header">
        <PageHeading>Unavailable</PageHeading>
      </div>
      <div className="sh-panel sh-pair-missing">
        <CastCharacter id="sorter" size={84} caption={false} />
        <div className="sh-pair-missing__body">
          <p role="status">The box could not be read.</p>
          {onRetry ? (
            <p>
              <button type="button" className="sh-button sh-button--primary" onClick={onRetry}>
                Retry
              </button>
            </p>
          ) : null}
          <details className="sh-fit-details">
            <summary>
              <span className="sh-fit-details__chevron" aria-hidden="true">
                <DisclosureIcon />
              </span>
              Details
            </summary>
            <p className="sh-muted">{reason}</p>
          </details>
          <p>
            <Link to="/">Back to the boxes</Link>
          </p>
        </div>
      </div>
    </section>
  );
}

/** `label`: the chain source's name; null for the sample data, which names no source on a page (F130). */
function NotInSource({ label, malformed }: { label: string | null; malformed: boolean }) {
  usePageTitle('Box not found');
  return (
    <section className="sh-page sh-fit-page sh-box-page" aria-labelledby={PAGE_TITLE_ID}>
      <BackToBoxes />
      <div className="sh-page__header">
        <PageHeading>{malformed ? 'Not a box address' : label === null ? 'Box not found' : `Not in ${label}`}</PageHeading>
      </div>
      <div className="sh-panel sh-pair-missing">
        <CastCharacter id="sorter" size={84} caption={false} />
        <div className="sh-pair-missing__body">
          <p>{malformed ? 'A box link is a chain id and a token address.' : label === null ? 'This box is not in this snapshot. Settings → Data source picks another source.' : DEMO_BUILD ? `This box is not on ${label} in this build. Settings → Data source picks another source.` : `This box is not on ${label} in this build.`}</p>
          <p>
            <Link to="/">Back to the boxes</Link>
          </p>
        </div>
      </div>
    </section>
  );
}

/**
 * The honesty lines under the phase: stale, unverified or unavailable data, a vault read that failed (the counts are
 * the last good read's) or a vault that could not be read, said in words, never hidden.
 */
function freshnessNotice(view: LiveView, vault: VaultState): ReactNode {
  const lines: string[] = [];
  const f = view.freshness;
  if (f === 'stale' || f === 'unverified' || f === 'unavailable') {
    const detail = staleDetail(view);
    lines.push(`${freshnessWord(view)}${detail ? ` · ${detail}` : ''}${f === 'unverified' ? ' · price not shown' : f === 'unavailable' ? ' · nothing is shown as zero' : ''}`);
  }
  if (vault.status === 'ready' && vault.failed) {
    const block = vault.counters.block;
    lines.push(`Vault read failed · figures from ${block === null ? 'the last good read' : `block ${formatCount(block)}`}`);
  }
  if (vault.status === 'unavailable') lines.push(`Vault not read · ${vault.reason}`);
  if (lines.length === 0) return null;
  return (
    <>
      {lines.map((line) => (
        <p key={line} className="sh-box-notice" data-disclosure="" data-freshness={f}>
          {line}
        </p>
      ))}
    </>
  );
}

/** Moves focus to a tab's lead heading once the tab has rendered (the header's strip and "Owning one" row). */
function focusLead(id: string) {
  window.setTimeout(() => document.getElementById(id)?.focus(), 0);
}

export interface LaunchBoxPageProps extends LaunchBoxSeams {
  readonly record: BoxRecord;
  readonly target: FitMarketTarget;
  readonly scenario: DemoScenario;
}

/** A launch box (the Misfits, a rehearsal): the live curve and the vault. Exported with its seams for the tests. */
export function LaunchBoxPage({ record, target, scenario, deps, readVault }: LaunchBoxPageProps) {
  usePageTitle(`${record.ticker} · ${record.name}`);
  const [tab, setTab] = useSectionParam(SECTIONS);
  const box = useLaunchBox(record, target, scenario, { deps, readVault });
  const { view, state, summary, price, market } = box;
  const data = view.data;
  const counters = countersFor({ record, state, marketLink: market.link, marketReason: market.reason });
  const vault = box.vault.status === 'ready' ? box.vault.counters : null;
  const outdated = box.vault.status === 'ready' && box.vault.failed;
  // N: the vault's once read (the market record's before); when they disagree the counts say "Unverified".
  const vaultSize = vault?.collectionSize ?? null;
  const edition: EditionSize = vaultSize === null ? { size: record.itemCount, check: 'record', recordSize: record.itemCount } : { size: vaultSize, check: vaultSize === record.itemCount ? 'vault' : 'mismatch', recordSize: record.itemCount };
  const counts: ContentsCounts = { inside: vault?.inside ?? null, reserved: vault?.placeholdersTaken ?? null };
  // The Misfits pack attaches by box 0's row (BC-095); a v2 record without a row keeps its launch-names rule.
  const launchContent = misfitsPackFor(record);
  const priceShown = priceTrusted(view);
  const model = price ? priceModel(price) : null;
  const cost = chargedQuote(model, price);
  const header = { record, target, state, data, priceShown, edition, counts, cost, check: model?.check ?? null, summary };
  const phase = launchPhase(header);
  const panels: Record<Tab, ReactNode> = {
    contents: <ContentsPanel record={record} state={state} counts={counts} launchContent={launchContent} edition={edition} />,
    token: <LaunchTokenPanel target={target} view={view} />,
    owning: (
      <OwningPanel
        record={record}
        state={state}
        cost={cost}
        explainer={<PriceExplainer record={record} state={state} inputs={price} priceEthPerToken={priceShown ? (data?.state.figures.priceEthPerToken ?? null) : null} outdated={outdated} />}
      />
    ),
    about: <AboutPanel record={record} state={state} target={target} launchContent={launchContent} size={edition.size} />,
  };
  const openContents = () => {
    setTab('contents');
    focusLead(CONTENTS_LEAD_ID);
  };
  const openOwning = () => {
    setTab('owning');
    focusLead(OWNING_LEAD_ID);
  };
  return (
    <section className="sh-page sh-fit-page sh-box-page" aria-labelledby={PAGE_TITLE_ID} data-freshness={view.freshness}>
      <BackToBoxes />
      <BoxHeader
        record={record}
        state={state}
        band={launchBand(header)}
        line={launchContent ? MISFITS_TAGLINE : null}
        idLine={<ContractAddress target={target} compact />}
        phase={
          phase ? (
            <p className="sh-box-phase" data-state={state ?? 'unavailable'} data-window={data?.window.status}>
              {phase}
            </p>
          ) : null
        }
        stats={launchStats(header)}
        counters={counters}
        notice={freshnessNotice(view, box.vault)}
        side={
          <>
            <PeekStrip record={record} state={state} size={edition.size} launchContent={launchContent} onOpen={openContents} />
            <OwnRow record={record} state={state} onOpen={openOwning} />
          </>
        }
      />
      <SectionBar sections={SECTIONS} selected={tab} onSelect={setTab} label="Box sections" idPrefix="box">
        {panels[tab]}
      </SectionBar>
      {DEMO_BUILD && record.demo ? <DemoStates record={record} scenario={scenario} /> : null}
    </section>
  );
}

/** Demo only: show the Demo Misfits in another state (closed by default; not part of the first look). */
function DemoStates({ record, scenario }: { record: BoxRecord; scenario: DemoScenario }) {
  return (
    <details className="sh-fit-details sh-box-demo-states">
      <summary>Show another state</summary>
      <ul>
        {DEMO_STATES.map(([id, label]) => (
          <li key={id}>
            <Link to={id === 'curve' ? boxPath(record.id) : `${boxPath(record.id)}?scenario=${id}`} aria-current={id === scenario ? 'page' : undefined}>
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * After Create on the creation page (sample data): "Box created" with the feed and My Box (where the Created group then
 * comes first), filled in a moment after the page renders so a screen reader announces it (focus is on the page
 * title). When this tab's storage could not hold the box, it says the box is gone after a reload.
 */
function CreatedToast() {
  const { state } = useLocation();
  const created = state as { boxCreated?: boolean; kept?: boolean } | null;
  const fresh = created?.boxCreated === true;
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!fresh) return undefined;
    const timer = window.setTimeout(() => setShown(true), 60);
    return () => window.clearTimeout(timer);
  }, [fresh]);
  if (!fresh) return null;
  return (
    <p className="sh-box-toast" role="status">
      {shown ? (
        <>
          <strong>Box created</strong>
          {created?.kept === false ? ' · Not kept after a reload' : null} <Link to="/">Feed</Link> ·{' '}
          <Link to="/my-box" state={{ createdFirst: true }}>
            My Box
          </Link>
        </>
      ) : null}
    </p>
  );
}

function DemoBoxPage({ record }: { record: BoxRecord }) {
  usePageTitle(`${record.ticker} · ${record.name}`);
  // A plain token launch (F70 "Nothing") opens on its token; its "What's in the box?" says it is a token box.
  const [tab, setTab] = useSectionParam(SECTIONS, record.kind === 'token' ? 'token' : undefined);
  const state: BoxState | null = record.demoState;
  const f = record.demoFigures;
  const counters = countersFor({ record, state, marketLink: null, marketReason: 'No links on a local chain' });
  const counts: ContentsCounts = { inside: f ? record.itemCount - f.outside : null, reserved: f?.reserved ?? null };
  const edition: EditionSize = { size: record.itemCount, check: 'record', recordSize: record.itemCount };
  const head = demoHeader(record);
  const panels: Record<Tab, ReactNode> = {
    contents: <ContentsPanel record={record} state={state} counts={counts} launchContent={false} edition={edition} />,
    token: <DemoTokenPanel record={record} />,
    owning: <OwningPanel record={record} state={state} cost={null} explainer={null} />,
    about: <AboutPanel record={record} state={state} target={null} launchContent={false} size={record.itemCount} />,
  };
  return (
    <section className="sh-page sh-fit-page sh-box-page" aria-labelledby={PAGE_TITLE_ID}>
      <BackToBoxes />
      <CreatedToast />
      <BoxHeader
        record={record}
        state={state}
        band={head.band}
        banner={record.spec?.bannerUrl ?? null}
        line={record.line ?? 'No preview shared'}
        idLine={
          <p className="sh-fit-ca sh-fit-ca--compact">
            <strong>{record.ticker}</strong>
            <code className="sh-fit-ca__short" title={record.token}>
              {shortAddress(record.token)}
            </code>
            <CopyButton value={record.token} label={`Copy the ${record.ticker} contract address`} />
          </p>
        }
        phase={
          head.phase ? (
            <p className="sh-box-phase" data-state={state ?? 'unavailable'}>
              {head.phase}
            </p>
          ) : null
        }
        stats={head.stats}
        counters={counters}
        side={
          <>
            <PeekStrip
              record={record}
              state={state}
              size={record.itemCount}
              launchContent={false}
              onOpen={() => {
                setTab('contents');
                focusLead(CONTENTS_LEAD_ID);
              }}
            />
            <OwnRow
              record={record}
              state={state}
              onOpen={() => {
                setTab('owning');
                focusLead(OWNING_LEAD_ID);
              }}
            />
          </>
        }
      />
      <SectionBar sections={SECTIONS} selected={tab} onSelect={setTab} label="Box sections" idPrefix="box">
        {panels[tab]}
      </SectionBar>
    </section>
  );
}

export default BoxPage;
