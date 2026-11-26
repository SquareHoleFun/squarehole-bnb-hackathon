/**
 * SH-BOX-LIFE-VIEW: the top of a v2 box's page, its life at a glance and live. The founder (2026-10-27, GPU Poor between
 * its raise filling and its graduation): "this view onto the process for graduation is underwhelming … it would be good
 * to be able to see the process and who participated live".
 *
 * Three cards, numbers and pictures first (one short line at most, every explanation behind a closed Details):
 * - the life strip, Launch, Raise, Graduate and Pool, the box's step highlighted, each with its one number;
 * - the market: the figures, the raise bar in the box's colour while the curve runs, and the price chart (SH-BOX-CANDLES,
 *   CandleChartV2.tsx: candles at the step the visitor picks, the box's whole life by default);
 * - the activity: Trades (who, buy or sell, both amounts, when, the transaction on the explorer; the box's own events
 *   as rows of its story) and Holders (shares; the pool, the box's contracts and the creator named), live.
 * Display only: no trading control, nothing asks a wallet, and no link or button names a trade.
 */
import { useEffect, useId, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { testnetExplorerHref } from '../../data-source/testnet';
import type { BoxRecord } from '../../boxes/box-model';
import { CopyButton } from '../../pair/CopyButton';
import { ExternalIcon } from '../../pair/pair-icons';
import { formatAgo, formatBps, formatUtc, isoTime, shortAddress } from '../../fit-pair/fit-format';
import { useClockMs } from '../useCore';
import type { V2Snapshot, V2Source } from './indexer-v2';
import { CandleChartV2 } from './CandleChartV2';
import { graduatedAtV2, holdersV2, lifeRowsV2, rolesBookV2, type HoldersV2, type HolderRoleV2, type HolderV2, type LifeEventKindV2, type LifeRowV2 } from './life-activity';
import { lifeStageV2, lifeStepsV2, raiseBarV2, type LifeStageV2, type LifeStepV2, type RaiseBarV2 } from './life-state';
import { figuresOfV2, priceShownV2 } from './StatsV2';
import { pAmountV2, tShortV2 } from './stats-v2';
import { useLifeActivityV2, type LifeActivityV2, type LifeLiveStatusV2 } from './useLifeActivity';
import type { Fetcher } from '../core-client';
import './life-view.css';

/** Rows shown before "Show more" reads or shows older ones. */
export const LIFE_ROWS = 12;
/** Holders shown before "Show all". */
export const LIFE_HOLDERS = 10;

// ------------------------------------------------------------------------------------------------ glyphs

function Glyph({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg className="sh-life-glyph" viewBox="0 0 20 20" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}
const LaunchGlyph = () => <Glyph><path d="M10 2.5c2.6 1.7 3.8 4.3 3.8 7.2L11.7 13.5H8.3L6.2 9.7C6.2 6.8 7.4 4.2 10 2.5z" /><circle cx="10" cy="8" r="1.3" /><path d="M8.3 13.5 7 17M11.7 13.5 13 17M10 13.5V18" /></Glyph>;
const RaiseGlyph = () => <Glyph><rect x="2.5" y="7.5" width="15" height="5" rx="2.5" /><path d="M4.5 10h6" strokeWidth="2.6" /></Glyph>;
const GraduateGlyph = () => <Glyph><path d="M1.8 7.5 10 3.8l8.2 3.7L10 11.2z" /><path d="M5.2 9.3v3.9c1.3 1.4 3 2 4.8 2s3.5-.6 4.8-2V9.3M17.4 7.9v4.6" /></Glyph>;
const PoolGlyph = () => <Glyph><path d="M2.5 8.2c1.2 0 1.9-1.2 3.1-1.2s1.9 1.2 3.1 1.2 1.9-1.2 3.1-1.2 1.9 1.2 3.1 1.2 1.9-1.2 2.6-1.2" /><path d="M2.5 12.2c1.2 0 1.9-1.2 3.1-1.2s1.9 1.2 3.1 1.2 1.9-1.2 3.1-1.2 1.9 1.2 3.1 1.2 1.9-1.2 2.6-1.2" /><path d="M2.5 16.2c1.2 0 1.9-1.2 3.1-1.2s1.9 1.2 3.1 1.2 1.9-1.2 3.1-1.2 1.9 1.2 3.1 1.2 1.9-1.2 2.6-1.2" /></Glyph>;
const CheckGlyph = () => <Glyph size={14}><path d="M4.5 10.5 8.2 14 15.5 6" strokeWidth="2.2" /></Glyph>;
const CrossGlyph = () => <Glyph size={14}><path d="M5.5 5.5l9 9M14.5 5.5l-9 9" strokeWidth="2.2" /></Glyph>;
const FireGlyph = () => <Glyph size={16}><path d="M10 17.5c3.1 0 5-2.1 5-4.9 0-3.1-2.6-4.6-3.1-7.6-1.7 1.2-2.4 2.7-2.4 4.3-1.1-.7-1.6-1.8-1.7-2.9C6.3 7.8 5 9.7 5 12.5c0 2.9 1.9 5 5 5z" /></Glyph>;
const CoinsGlyph = () => <Glyph size={16}><ellipse cx="10" cy="6" rx="5.5" ry="2.5" /><path d="M4.5 6v4c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5V6M4.5 10v4c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5v-4" /></Glyph>;
const FlagGlyph = () => <Glyph size={16}><path d="M5 17.5V3M5 3.5h9.5l-2 3 2 3H5" /></Glyph>;
const CloseGlyph = () => <Glyph size={16}><circle cx="10" cy="10" r="7" /><path d="M7.3 7.3l5.4 5.4M12.7 7.3l-5.4 5.4" /></Glyph>;
const ClaimGlyph = () => <Glyph size={16}><path d="M3.5 10.5v5A1.5 1.5 0 0 0 5 17h10a1.5 1.5 0 0 0 1.5-1.5v-5" /><path d="M10 3v8.5M7 8.5l3 3 3-3" /></Glyph>;
/** The box itself: its creation is not the Launch step (the opening), so it has its own mark. */
const BoxGlyph = () => <Glyph size={16}><path d="M10 2.6 16.6 6.3v7.4L10 17.4 3.4 13.7V6.3z" /><path d="M3.4 6.3 10 10l6.6-3.7M10 10v7.4" /></Glyph>;

const STEP_GLYPH: Readonly<Record<LifeStepV2['id'], () => ReactNode>> = { launch: LaunchGlyph, raise: RaiseGlyph, graduate: GraduateGlyph, pool: PoolGlyph };

// ------------------------------------------------------------------------------------------------ the strip

/** The life strip: four steps, each an icon, one word and one number; the box's own step highlighted. */
export function LifeStripV2({ steps, stage }: { steps: readonly LifeStepV2[]; stage: LifeStageV2 }) {
  return (
    <section className="sh-panel sh-life" aria-label="Box life" data-stage={stage}>
      <ol className="sh-life__steps">
        {steps.map((step) => {
          const Icon = STEP_GLYPH[step.id];
          return (
            <li key={step.id} className="sh-life__step" data-step={step.id} data-status={step.status} aria-current={step.status === 'current' ? 'step' : undefined}>
              <span className="sh-visually-hidden">{step.spoken}</span>
              <span className="sh-life__mark" aria-hidden="true">
                <Icon />
                {step.status === 'done' ? <span className="sh-life__badge"><CheckGlyph /></span> : step.status === 'failed' ? <span className="sh-life__badge" data-failed=""><CrossGlyph /></span> : null}
              </span>
              <span className="sh-life__text" aria-hidden="true">
                <span className="sh-life__label">{step.label}</span>
                <span className="sh-life__value">{step.value}</span>
                {step.sub ? <span className="sh-life__sub">{step.sub}</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ the market

/** The raise bar: the box's colour while it fills, the graduation colour when full, with the goal marked at 100%. */
export function RaiseBarV2View({ bar, filledAgo }: { bar: RaiseBarV2; filledAgo: string | null }) {
  return (
    <div className="sh-life-raise" data-full={bar.full}>
      <p className="sh-life-raise__head">
        <span className="sh-life-raise__label">Raised</span>
        <strong className="sh-life-raise__pct">{bar.percent}</strong>
        <span className="sh-life-raise__amount">{bar.amount}</span>
        {bar.full ? (
          <span className="sh-life-raise__full">
            <CheckGlyph /> Full{filledAgo ? <span className="sh-life-raise__when"> · {filledAgo}</span> : null}
          </span>
        ) : null}
      </p>
      <div className="sh-life-raise__track" role="progressbar" aria-label="Raised" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.trunc(bar.bps / 100)} aria-valuetext={`${bar.percent}, ${bar.amount}${bar.full ? ', full' : ''}`}>
        <span className="sh-life-raise__fill" style={{ width: `${bar.bps / 100}%` }} />
        <span className="sh-life-raise__goal" aria-hidden="true" />
      </div>
    </div>
  );
}

function MarketDetails({ view, stage, coin, ticker }: { view: V2Snapshot; stage: LifeStageV2; coin: string; ticker: string }) {
  const unit = `${coin} per 1M ${ticker}`;
  return (
    <details className="sh-life-details">
      <summary>Details</summary>
      <p>{stage === 'graduated'
        ? `The raise is done: the box's coins trade in its own pool. Prices in ${unit}.`
        : `Each buy moves the price along the curve. At 100% the raise is full and the box graduates into its own pool.${view.gate.deadline > 0n ? ` If it is not full by ${formatUtc(view.gate.deadline, false)}, the box closes and holders claim its pot.` : ''} Prices in ${unit}.`}</p>
    </details>
  );
}

/**
 * The market: price, market cap, holders, burned and 24 h volume; the raise bar while the curve runs; the chart. SH-224:
 * `figures` false leaves the five figures out (the box page's header shows them as its number tiles).
 */
export function LifeMarketV2({ record, view, source, stage, nowSec, fetcher, figures = true }: { record: BoxRecord; view: V2Snapshot; source: V2Source; stage: LifeStageV2; nowSec: bigint; fetcher?: Fetcher; figures?: boolean }) {
  const f = figuresOfV2(view);
  const coin = record.pairAsset;
  const unit = `${coin} per 1M ${record.ticker}`;
  const bar = stage === 'graduated' ? null : raiseBarV2(view, coin);
  const head = view.timestamp > nowSec ? view.timestamp : nowSec;
  return (
    <section className="sh-panel sh-v2-stats sh-life-market" aria-label="Market">
      {figures ? <dl className="sh-v2-stats__grid">
        <div><dt>Price</dt><dd><span className="sh-v2-stats__value">{f.price}</span> <span className="sh-v2-stats__unit">{unit}</span></dd></div>
        <div><dt>Market cap</dt><dd><span className="sh-v2-stats__value">{f.marketCap}</span> <span className="sh-v2-stats__unit">{coin}</span></dd></div>
        <div><dt>Holders</dt><dd><span className="sh-v2-stats__value">{f.holders}</span></dd></div>
        <div><dt>Burned</dt><dd><span className="sh-v2-stats__value">{f.burned}</span> <span className="sh-v2-stats__unit">{record.ticker}</span></dd></div>
        <div><dt>24h volume</dt><dd><span className="sh-v2-stats__value">{f.volume24h}</span> <span className="sh-v2-stats__unit">{coin}</span></dd></div>
      </dl> : null}
      {bar ? <RaiseBarV2View bar={bar} filledAgo={view.closedAt > 0n ? formatAgo(head - view.closedAt) : null} /> : null}
      {/* A box the indexer's audit refuted shows no price history at all (SH-TA-29 finding 3): nothing is read for it. */}
      {!priceShownV2(view) ? <p className="sh-life-chart sh-life-chart--empty">Price history unavailable</p>
        : <CandleChartV2 view={view} source={source} coin={coin} ticker={record.ticker} fetcher={fetcher} />}
      <MarketDetails view={view} stage={stage} coin={coin} ticker={record.ticker} />
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ the activity

const LIVE_WORD: Readonly<Record<LifeLiveStatusV2, string>> = { loading: 'Reading', live: 'Live', reconnecting: 'Reconnecting', paused: 'Paused', unavailable: 'Unavailable' };
const ROLE_WORD: Readonly<Record<HolderRoleV2, string>> = { pool: 'Pool', box: 'Box', creator: 'Creator' };
const EVENT: Readonly<Record<LifeEventKindV2, { readonly word: string; readonly glyph: () => ReactNode }>> = {
  // BoxLaunched is the box's creation (its pool and bootstrap buy); the strip's Launch is its opening.
  created: { word: 'Created', glyph: () => <BoxGlyph /> },
  full: { word: 'Raise full', glyph: () => <FlagGlyph /> },
  graduated: { word: 'Graduated', glyph: () => <GraduateGlyph /> },
  closed: { word: 'Closed', glyph: () => <CloseGlyph /> },
  claim: { word: 'Claim', glyph: () => <ClaimGlyph /> },
  buyBack: { word: 'Buy-back', glyph: () => <FireGlyph /> },
  deepened: { word: 'Pool deepened', glyph: () => <PoolGlyph /> },
  fees: { word: 'Fees', glyph: () => <CoinsGlyph /> },
  swap: { word: 'Box swap', glyph: () => <PoolGlyph /> },
};
const CAUSE_WORD: Readonly<Record<string, string>> = { Deadline: 'deadline passed', ClosedPastCap: 'not opened in time', GraduationTimedOut: '7 days passed' };

/** The activity's freshness word, said politely when it changes (a live region, not the page's one status). */
function LiveChipV2({ status }: { status: LifeLiveStatusV2 }) {
  return (
    <p className="sh-life-live" data-status={status}>
      <span className="sh-life-live__dot" aria-hidden="true" />
      <span className="sh-life-live__word" aria-live="polite">{LIVE_WORD[status]}</span>
    </p>
  );
}

function Who({ address, role, chainId }: { address: string | null; role: HolderRoleV2 | null; chainId: number }) {
  if (address === null) return <span className="sh-life-who sh-life-who--unknown">—</span>;
  const href = testnetExplorerHref({ chainId, address });
  const short = shortAddress(address);
  // The short address and its copy button never part (one line, a phone included); a role chip may wrap after them.
  return (
    <span className="sh-life-who">
      <span className="sh-life-who__id">
        {href ? (
          <a className="sh-life-who__address" href={href} target="_blank" rel="noopener noreferrer" title={address}>
            <code>{short}</code>
            <span className="sh-visually-hidden"> (opens the explorer in a new tab)</span>
          </a>
        ) : (
          <code className="sh-life-who__address" title={address}>{short}</code>
        )}
        <CopyButton value={address} label={`Copy the address ${short}`} />
      </span>
      {role ? <span className="sh-life-chip" data-role={role}>{ROLE_WORD[role]}</span> : null}
    </span>
  );
}

function When({ at, head }: { at: bigint; head: bigint }) {
  const utc = formatUtc(at);
  return (
    <span className="sh-life-row__when">
      <time dateTime={isoTime(at) ?? undefined} title={utc}>{formatAgo(head - at)}</time>
      <span className="sh-visually-hidden">, {utc}</span>
    </span>
  );
}

function TxLink({ txHash, chainId }: { txHash: string; chainId: number }) {
  const href = testnetExplorerHref({ chainId, txHash });
  if (!href) return <span className="sh-life-row__tx" title={txHash} aria-hidden="true" />;
  return (
    <a className="sh-life-row__tx" href={href} target="_blank" rel="noopener noreferrer" title={txHash} aria-label={`Transaction ${shortAddress(txHash)} on Etherscan, opens in a new tab`}>
      <ExternalIcon />
    </a>
  );
}

function Row({ row, record, view, head, fresh }: { row: LifeRowV2; record: BoxRecord; view: V2Snapshot; head: bigint; fresh: boolean }) {
  const coin = record.pairAsset;
  const p = (amount: bigint | null) => (amount === null ? null : `${pAmountV2(amount, view.decimals)} ${coin}`);
  const t = (amount: bigint | null) => (amount === null ? null : `${tShortV2(amount)} ${record.ticker}`);
  const chainId = record.chainId;
  if (row.kind === 'trade') {
    return (
      <li className="sh-life-row" data-kind="trade" data-side={row.side} data-new={fresh ? '' : undefined}>
        <span className="sh-life-row__what">
          <span className="sh-life-side" data-side={row.side}><span aria-hidden="true">{row.side === 'buy' ? '▲' : '▼'}</span> {row.side === 'buy' ? 'Buy' : 'Sell'}</span>
        </span>
        <span className="sh-life-row__detail"><Who address={row.who} role={row.role} chainId={chainId} /></span>
        <span className="sh-life-row__p">{p(row.p)}{row.taxP > 0n ? <span className="sh-life-row__note"> + {pAmountV2(row.taxP, view.decimals)} tax</span> : null}</span>
        <span className="sh-life-row__t">{t(row.t)}</span>
        <When at={row.at} head={head} />
        <TxLink txHash={row.txHash} chainId={chainId} />
      </li>
    );
  }
  const event = EVENT[row.event];
  const detail = row.event === 'graduated' && row.who ? <Who address={row.who} role={row.role} chainId={chainId} />
    : row.event === 'claim' || row.event === 'closed' ? <>{row.cause ? <span>{CAUSE_WORD[row.cause] ?? row.cause}</span> : null}{row.who ? <Who address={row.who} role={row.role} chainId={chainId} /> : null}</>
      : row.event === 'created' ? <span>bootstrap</span>
        : row.event === 'buyBack' ? <span>burned</span>
          : null;
  const amountP = row.event === 'full' ? `${pAmountV2(view.record.raise, view.decimals)} ${coin}` : row.event === 'graduated' && row.p !== null ? `${p(row.p)} tip` : p(row.p);
  return (
    <li className="sh-life-row" data-kind="event" data-event={row.event} data-who={row.who ? '' : undefined} data-new={fresh ? '' : undefined}>
      <span className="sh-life-row__what"><span className="sh-life-event">{event.glyph()} {event.word}</span></span>
      <span className="sh-life-row__detail">{detail}</span>
      <span className="sh-life-row__p">{amountP}</span>
      <span className="sh-life-row__t">{t(row.t)}</span>
      <When at={row.at} head={head} />
      <TxLink txHash={row.txHash} chainId={chainId} />
    </li>
  );
}

function HolderRow({ holder, rank, record, chainId }: { holder: HolderV2; rank: number; record: BoxRecord; chainId: number }) {
  return (
    <li className="sh-life-holder" data-role={holder.role ?? undefined}>
      <span className="sh-life-holder__rank">{rank}</span>
      <span className="sh-life-holder__who"><Who address={holder.address} role={holder.role} chainId={chainId} /></span>
      <span className="sh-life-holder__share">
        <span className="sh-life-holder__bar" aria-hidden="true"><span style={{ width: `${Math.max(1, holder.shareBps) / 100}%` }} /></span>
        {formatBps(holder.shareBps)}
      </span>
      <span className="sh-life-holder__amount">{`${tShortV2(holder.balance)} ${record.ticker}`}</span>
    </li>
  );
}

type ActivityTab = 'trades' | 'holders';

/** The activity card: Trades (the story, newest first, live) and Holders. */
export function LifeActivityCardV2({ record, view, activity, nowSec }: { record: BoxRecord; view: V2Snapshot; activity: LifeActivityV2; nowSec: bigint }) {
  const id = useId();
  const [tab, setTab] = useState<ActivityTab>('trades');
  const [allRows, setAllRows] = useState(false);
  const [allHolders, setAllHolders] = useState(false);
  const book = useMemo(() => rolesBookV2(view.record), [view.record]);
  const store = activity.store;
  const { wantHistory, shown } = activity;
  // The page re-renders every second for its clocks; the story and the holders change only with the rows or the block.
  const rows = useMemo(() => (store.loaded ? lifeRowsV2(store.items, book) : []), [store, book]);
  const visibleRows = allRows ? rows : rows.slice(0, LIFE_ROWS);
  const fresh = new Set(activity.arrived);
  // The new rows on show flash once; then they are no longer new, so a tab switch does not flash them again.
  const flashing = tab === 'trades' ? visibleRows.filter((row) => fresh.has(row.id)).map((row) => row.id).join(' ') : '';
  useEffect(() => { if (flashing) shown(flashing.split(' ')); }, [flashing, shown]);
  // While Holders is open the whole history is read (also when it opened before the first read answered).
  useEffect(() => { wantHistory(tab === 'holders'); }, [tab, wantHistory]);
  const head = view.timestamp > nowSec ? view.timestamp : nowSec;
  const stats = view.statistics ?? null;
  const holderCount = stats ? stats.holderCount.toString() : '—';
  // The snapshot's block is the indexer's head; the history answers for it from the block its figures last moved at.
  const since = activity.since ?? view.block;
  const computed = useMemo(() => holdersV2(store, view.block, stats ? { holderCount: stats.holderCount, totalSupplyT: stats.totalSupplyT } : null, book, since), [store, view.block, stats, book, since]);
  // Moved figures whose rows the history has not stored yet do not match the snapshot for a moment: the last list that
  // matched stays until the next one does.
  const [lastReady, setLastReady] = useState<Extract<HoldersV2, { status: 'ready' }> | null>(null);
  if (computed.status === 'ready' && computed !== lastReady) setLastReady(computed);
  const holders: HoldersV2 = computed.status === 'unavailable' && (computed.reason === 'mismatch' || computed.reason === 'behind') && lastReady !== null ? lastReady : computed;
  const readingHolders = holders.status === 'unavailable' && (holders.reason === 'behind' || (holders.reason === 'unread' && activity.status !== 'unavailable') || (holders.reason === 'incomplete' && (activity.loadingMore || activity.readingHistory)));
  const onKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const next: ActivityTab = event.key === 'Home' ? 'trades' : event.key === 'End' ? 'holders' : tab === 'trades' ? 'holders' : 'trades';
    setTab(next);
    document.getElementById(`${id}-tab-${next}`)?.focus();
  };
  const more = rows.length > LIFE_ROWS && !allRows ? 'shown' : activity.store.next !== null && (allRows || rows.length <= LIFE_ROWS) ? 'older' : null;
  return (
    <section className="sh-panel sh-life-activity" aria-label="Activity">
      <div className="sh-life-activity__head">
        <div className="sh-life-tabs" role="tablist" aria-label="Activity">
          {(['trades', 'holders'] as const).map((name) => (
            <button key={name} type="button" role="tab" id={`${id}-tab-${name}`} className="sh-life-tabs__tab" aria-selected={tab === name} aria-controls={`${id}-panel`} tabIndex={tab === name ? 0 : -1} onClick={() => setTab(name)} onKeyDown={onKey}>
              {name === 'trades' ? 'Trades' : <>Holders <span className="sh-life-tabs__count">{holderCount}</span></>}
            </button>
          ))}
        </div>
        <LiveChipV2 status={activity.status} />
      </div>
      <div className="sh-life-activity__panel" id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${tab}`}>
        {tab === 'trades' ? (
          !activity.store.loaded ? (
            <p className="sh-life-empty">{activity.status === 'unavailable' ? 'Trades unavailable' : 'Reading trades…'}</p>
          ) : rows.length === 0 ? (
            <p className="sh-life-empty">No trades yet</p>
          ) : (
            <>
              <ol className="sh-life-rows">
                {visibleRows.map((row) => <Row key={row.id} row={row} record={record} view={view} head={head} fresh={fresh.has(row.id)} />)}
              </ol>
              {more ? (
                <p className="sh-life-more">
                  <button type="button" className="sh-button" disabled={activity.loadingMore} onClick={() => { setAllRows(true); if (more === 'older') activity.loadMore(); }}>
                    {activity.loadingMore ? 'Reading…' : 'Show more'}
                  </button>
                </p>
              ) : null}
            </>
          )
        ) : holders.status === 'ready' ? (
          <>
            <ol className="sh-life-holders">
              {(allHolders ? holders.holders : holders.holders.slice(0, LIFE_HOLDERS)).map((holder, i) => <HolderRow key={holder.address} holder={holder} rank={i + 1} record={record} chainId={record.chainId} />)}
            </ol>
            {holders.holders.length > LIFE_HOLDERS && !allHolders ? (
              <p className="sh-life-more"><button type="button" className="sh-button" onClick={() => setAllHolders(true)}>{`Show all ${holders.holders.length}`}</button></p>
            ) : null}
          </>
        ) : (
          <p className="sh-life-empty">{readingHolders ? 'Reading holders…' : `${holderCount} holders · list unavailable`}</p>
        )}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ the whole view

export interface LifeViewProps {
  readonly record: BoxRecord;
  readonly view: V2Snapshot;
  readonly source: V2Source;
  /** A closed box's closing price card, shown in the market's place. */
  readonly closing?: ReactNode;
  /** Test seam: how the activity and the candles are read. */
  readonly fetcher?: Fetcher;
}

/** What the three cards share: the clock, the live activity (read once), the stage and the strip's steps. */
export interface LifeV2 {
  readonly nowSec: bigint;
  readonly activity: LifeActivityV2;
  readonly stage: LifeStageV2;
  readonly steps: readonly LifeStepV2[];
}

/**
 * SH-224: the life view's state, for a page that places the strip, the market and the activity apart (the v2 box page puts
 * the strip in its header). One activity read for all three.
 */
export function useLifeV2(record: BoxRecord, view: V2Snapshot, source: V2Source, fetcher?: Fetcher): LifeV2 {
  const nowSec = BigInt(Math.floor(useClockMs(1000) / 1000));
  const activity = useLifeActivityV2(source, view, fetcher);
  const stage = lifeStageV2(view);
  const f = figuresOfV2(view);
  const graduatedAt = graduatedAtV2(activity.store.items);
  const steps = lifeStepsV2({ view, nowSec, coin: record.pairAsset, ticker: record.ticker, price: f.price, graduatedAt });
  return { nowSec, activity, stage, steps };
}

/** The top of a v2 box's page: the life strip, the market (or a closed box's closing price) and the live activity. */
export function LifeViewV2({ record, view, source, closing = null, fetcher }: LifeViewProps) {
  const { nowSec, activity, stage, steps } = useLifeV2(record, view, source, fetcher);
  return (
    <div className="sh-life-view">
      <LifeStripV2 steps={steps} stage={stage} />
      {stage === 'failed' ? closing : <LifeMarketV2 record={record} view={view} source={source} stage={stage} nowSec={nowSec} fetcher={fetcher} />}
      <LifeActivityCardV2 record={record} view={view} activity={activity} nowSec={nowSec} />
    </div>
  );
}
