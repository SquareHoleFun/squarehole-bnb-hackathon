/**
 * A core v1 box's page (S10a § 5): the one template for every box (F46) — the header (cover and state band, chips,
 * name, contract address with Copy, phase line, stats, counters) and the same four sections — fed by the box's snapshot
 * (the indexer's, or a direct read pinned to one block, C19) and built from its row alone (BC-086). The Misfits pack
 * attaches by box 0's row (BC-095). Box 0, once graduated, carries its draw, open and claim panel (SH-BOX0-ACTIONS,
 * box0/Box0Panel.tsx); nothing asks a wallet anything until one of its buttons is clicked. Box 0's Token tab opens with
 * the sample page's live "Bonding curve" card, fed by the same snapshot (SH-BOX0-LIVE-CURVE, box0-curve.ts).
 */
import { type ReactNode } from 'react';
import { AboutPanel } from '../boxes/AboutPanel';
import { misfitsPackFor } from '../boxes/box-sources';
import type { BoxRecord, BoxState } from '../boxes/box-model';
import { BoxHeader } from '../boxes/BoxHeader';
import { CONTENTS_LEAD_ID, ContentsPanel, type ContentsCounts, type EditionSize } from '../boxes/ContentsPanel';
import { countersFor } from '../boxes/counters';
import { OwnRow, PeekStrip } from '../boxes/HeaderSide';
import { MISFITS_TAGLINE } from '../boxes/misfits-content';
import { OWNING_LEAD_ID, OwningPanel } from '../boxes/OwningPanel';
import { priceModel } from '../boxes/price-model';
import { SectionBar, useSectionParam, type Section } from '../boxes/SectionBar';
import { formatBlock, shortAddress } from '../fit-pair/fit-format';
import { CopyButton } from '../pair/CopyButton';
import { Link } from 'react-router';
import { PAGE_TITLE_ID, usePageTitle } from '../../pages/page-parts';
import { BackIcon } from '../pair/pair-icons';
import type { CoreBuild } from './core-build';
import type { Fetcher } from './core-client';
import { ActivityCard, ContractsCard, DrawsCard, FeesCard, PoolCard, StreamCard } from './CoreCards';
import { rowBand, rowPhaseLine, rowStats } from './row-header';
import { STATE_OF_PHASE, staleByClock } from './row-summary';
import { RowLinks, rowMarketLink } from './RowLinks';
import { BUILD_CORE, useClockMs, useCoreActivity, useCoreBox, useCoreSource } from './useCore';
import { Box0Panel } from './box0/Box0Panel';
import { box0Curve } from './box0-curve';
import { CurvePanel } from '../fit-pair/CurvePanel';


type Tab = 'contents' | 'token' | 'owning' | 'about';
const SECTIONS: readonly Section<Tab>[] = [
  { id: 'contents', label: 'What’s in the box?' },
  { id: 'token', label: 'Token' },
  { id: 'owning', label: 'Owning one' },
  { id: 'about', label: 'About' },
];

function focusLead(id: string) {
  window.setTimeout(() => document.getElementById(id)?.focus(), 0);
}

export interface RowBoxPageProps {
  readonly record: BoxRecord;
  /** Test seams: what the build embeds and how the site fetches. */
  readonly coreBuild?: CoreBuild;
  readonly fetcher?: Fetcher;
}

/**
 * The honesty lines under the phase, never hidden (BC-094): stale (the gateway's word, a refresh that failed, or too old
 * by the clock), unverified, a direct read (the indexer down or not in this build), an unreadable box.
 */
function notices(status: 'loading' | 'ready' | 'error', view: import('@squarehole/indexer/client').CoreBoxView | null, error: string | null, stale: boolean, refreshError: string | null): ReactNode {
  const lines: { text: string; kind: string }[] = [];
  if (status === 'error') lines.push({ text: `Unavailable · ${error ?? 'the box could not be read'} · nothing is shown as zero`, kind: 'unavailable' });
  if (view?.verified === false) lines.push({ text: 'Unverified · the chain disagrees with the index · price not shown', kind: 'unverified' });
  if (view && stale) lines.push({ text: `Stale · since block ${formatBlock(BigInt(view.asOf.block))}${refreshError ? ' · could not refresh' : ''}`, kind: 'stale' });
  if (view?.source === 'direct') lines.push({ text: `Read from the chain at block ${formatBlock(BigInt(view.asOf.block))} · activity needs the indexer`, kind: 'direct' });
  if (lines.length === 0) return null;
  return (
    <>
      {lines.map((line) => (
        <p key={line.text} className="sh-box-notice" data-disclosure="" data-freshness={line.kind}>
          {line.text}
        </p>
      ))}
    </>
  );
}

export function RowBoxPage({ record, coreBuild = BUILD_CORE, fetcher }: RowBoxPageProps) {
  usePageTitle(`${record.ticker} · ${record.name}`);
  const ref = record.row;
  if (!ref) throw new Error('RowBoxPage needs a row');
  const row = ref.row;
  const token = row.contracts.token as string;
  const [tab, setTab] = useSectionParam(SECTIONS, record.kind === 'token' ? 'token' : undefined);
  const core = useCoreSource(coreBuild);
  const box = useCoreBox(core, token, fetcher);
  const activity = useCoreActivity(core, token, fetcher);
  const clockMs = useClockMs();
  const view = box?.status === 'ready' ? (box.value?.view ?? null) : null;
  const status = box?.status ?? 'error';
  const refreshError = box?.status === 'ready' ? box.refreshError : null;
  // Stale: the gateway's word, the last good answer kept after a failed refresh, or (Sepolia) a minute old by the clock.
  const stale = view !== null && (view.stale || refreshError !== null || staleByClock(ref.network, view.asOf.timestamp, clockMs));
  const state: BoxState | null = view ? STATE_OF_PHASE[view.phase] : null;
  const pack = misfitsPackFor(record);
  const market = rowMarketLink(ref, view?.phase ?? null);
  const counters = countersFor({ record, state, marketLink: market.link, marketReason: market.reason });
  const n = BigInt(row.spec.n);
  const inside = view?.vault.inside ? BigInt(view.vault.inside) : null;
  const reserved = view ? BigInt(view.draws.placeholdersTaken) - BigInt(view.draws.placeholdersHandedBack) : null;
  const edition: EditionSize = { size: n, check: 'record', recordSize: n };
  const counts: ContentsCounts = { inside, reserved };
  // What one item costs in T (the vault's quote, F23), from S, E, n at the snapshot's block.
  const model = view && inside !== null && view.vault.escrow !== null ? priceModel({ supply: BigInt(view.supply.total), escrow: BigInt(view.vault.escrow), inside, collectionSize: n, chainQuoteOne: null, block: BigInt(view.asOf.block) }) : null;
  const header = { record, row, view, stale };
  const phase = rowPhaseLine(header);
  const items = activity?.status === 'ready' ? activity.value : null;
  // Box 0's live curve, the sample page's card, first on the Token tab (SH-BOX0-LIVE-CURVE); null for any other box.
  const curve = view ? box0Curve(row, view, { stale }) : null;
  const panels: Record<Tab, ReactNode> = {
    contents: <ContentsPanel record={record} state={state} counts={counts} launchContent={pack} edition={edition} />,
    token: view ? (
      <div className="sh-box-token sh-fit sh-core" data-source={view.source}>
        <h2 className="sh-visually-hidden">Token</h2>
        <div className="sh-fit-grid">
          <div className="sh-fit-grid__main">
            {curve ? <CurvePanel view={curve.view} target={curve.target} /> : null}
            <FeesCard record={record} row={row} view={view} />
            <PoolCard record={record} row={row} view={view} />
            <StreamCard record={record} row={row} view={view} />
            <DrawsCard record={record} row={row} view={view} />
            <ActivityCard record={record} items={view.source === 'direct' ? null : items} />
          </div>
          <div className="sh-fit-grid__side">
            <RowLinks rowRef={ref} phase={view.phase} ticker={record.ticker} />
            <ContractsCard row={row} network={ref.network} />
          </div>
        </div>
      </div>
    ) : (
      <div className="sh-box-token">
        <RowLinks rowRef={ref} phase={null} ticker={record.ticker} />
      </div>
    ),
    owning: <OwningPanel record={record} state={state} cost={model?.fitPerItem ?? null} explainer={null} />,
    about: <AboutPanel record={record} state={state} target={null} launchContent={pack} size={n} />,
  };
  return (
    <section className="sh-page sh-fit-page sh-box-page" aria-labelledby={PAGE_TITLE_ID} data-freshness={view?.verified === false ? 'unverified' : stale ? 'stale' : status} data-row-network={ref.network}>
      <p className="sh-pair-back">
        <Link to="/" className="sh-pair-back__link">
          <BackIcon />
          Boxes
        </Link>
      </p>
      <BoxHeader
        record={record}
        state={state}
        band={rowBand(header)}
        line={pack ? MISFITS_TAGLINE : record.line}
        idLine={
          <p className="sh-fit-ca sh-fit-ca--compact">
            <strong>{record.ticker}</strong>
            <code className="sh-fit-ca__short" title={token}>
              {shortAddress(token)}
            </code>
            <CopyButton value={token} label={`Copy the ${record.ticker} contract address`} />
          </p>
        }
        phase={
          phase ? (
            <p className="sh-box-phase" data-state={state ?? 'unavailable'}>
              {phase}
            </p>
          ) : null
        }
        stats={rowStats(header)}
        counters={counters}
        notice={notices(status, view, box?.status === 'error' ? box.reason : null, stale, refreshError)}
        side={
          <>
            <PeekStrip
              record={record}
              state={state}
              size={n}
              launchContent={pack}
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
      <Box0Panel row={row} core={core} graduated={view?.phase === 'graduated'} disabled={stale || view?.verified !== true} ticker={record.ticker} {...(fetcher ? { fetcher } : {})} />
      <SectionBar sections={SECTIONS} selected={tab} onSelect={setTab} label="Box sections" idPrefix="box">
        {panels[tab]}
      </SectionBar>
    </section>
  );
}
