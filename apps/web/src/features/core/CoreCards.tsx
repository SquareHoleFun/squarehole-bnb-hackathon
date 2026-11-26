/**
 * The core v1 box page's cards (S10a § 5), numbers first and the rest behind (i), read-only (no draw, take, open or
 * claim action; nothing asks a wallet), no yield, earn or reward words (BC-091: D6's payment is the "graduation tip", the
 * stream "per Misfit so far"):
 *
 * - Fees (F77): fees so far in Q and T, each side's split with box 0's shares from `@squarehole/box-spec`, the
 *   platform's share kept (no cap named on the site: F160, F209, SH-245), the launch tax into the pool after graduation. Every figure comes from
 *   `feeSummary` (core-fees.ts), one rule for the indexer's view and a direct read: the platform's 2/15 held until
 *   graduation, its part above the cap into the pool, and the 13/15 T that funds the per-Misfit stream after graduation
 *   are counted though no BatchSplit field carries them.
 * - Figures read from views (the hook's depth budget, the stream's index) carry their block when they are older than
 *   the box's last event ("at block N (last check)"); the pool share and the Misfits outside come from events.
 * - Pool (BC-142's page part): before graduation the raise and fill, the pool share waiting, the depth held, the tax
 *   waiting; after it the Q and T in the hook's positions at the price, locked by fees, waiting, the last add and the
 *   conversions.
 * - Per-Misfit stream: "Starts at graduation", then per Misfit so far, Misfits outside, claimed and burned.
 * - Draws: placeholders taken, draws settled, the graduation word, terminal mode only when entered.
 * - Activity (never box 0's backup start or fix: F142, desk R64-ROWS "hide"), and the contracts by role (explorer links
 *   on Sepolia only).
 */
import { BOX0_FEE_SHARE_FIT, BOX0_FEE_SHARE_PLATFORM, BOX0_FEE_SHARE_T_BURN, FEE_SHARE_DENOMINATOR, FEE_SHARE_DEPTH } from '@squarehole/box-spec';
import { ROLE_NAMES, type BoxRow, type RoleName } from '@squarehole/chain';
import { feeSummary, type CoreBoxView } from '@squarehole/indexer/client';
import type { BoxNetwork } from '@squarehole/links';
import { testnetContractHref } from '../data-source/testnet';
import type { ReactNode } from 'react';
import { formatPair } from '../boxes/box-figure';
import type { BoxRecord } from '../boxes/box-model';
import { perMillion } from '../boxes/price-format';
import { formatBlock, formatCount, formatTokenShort, shortAddress } from '../fit-pair/fit-format';
import { InfoButton, InfoPanel, useInfoTip } from '../fit-pair/InfoTip';
import { CopyButton } from '../pair/CopyButton';
import { ExternalIcon } from '../pair/pair-icons';
import type { ActivityItem } from './core-client';


const share = (n: bigint): string => `${n}/${FEE_SHARE_DENOMINATOR}`;
const big = (v: string | null | undefined): bigint | null => (v === null || v === undefined ? null : BigInt(v));
/** T in short form, trimmed ("1.07M"). */
export const shortT = (raw: bigint): string => formatTokenShort(raw, '').trim();

function Card({ id, title, info, children }: { id: string; title: string; info?: ReactNode; children: ReactNode }) {
  const tip = useInfoTip();
  return (
    <section className="sh-detail-card sh-core-card" aria-labelledby={id} data-card={id}>
      <div className="sh-detail-card__head">
        <h3 id={id} className="sh-detail-card__title">
          {title}
        </h3>
        {info ? <InfoButton tip={tip} label={`About ${title.toLowerCase()}`} /> : null}
      </div>
      {info ? <InfoPanel tip={tip}>{info}</InfoPanel> : null}
      {children}
    </section>
  );
}

function Facts({ rows }: { rows: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="sh-core-facts">
      {rows.map(([label, value]) => (
        <div key={label} className="sh-core-facts__row">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface CardProps {
  readonly record: BoxRecord;
  readonly row: BoxRow;
  readonly view: CoreBoxView;
}

/** Fees (F77, box 0's split; another box's split as its batches report it). */
export function FeesCard({ record, row, view }: CardProps) {
  const q = (raw: bigint): string => `${formatPair(raw, record, 4)} ${record.pairAsset}`;
  const t = (raw: bigint): string => `${shortT(raw)} ${record.ticker}`;
  const fs = feeSummary(view);
  const taxWaiting = BigInt(view.launch.taxQ) - BigInt(view.launch.sweptQ);
  const box0 = row.isBox0;
  const one = record.itemNoun.replace(/s$/, '');
  const stream = row.contracts.itemStream !== null;
  // Before graduation box 0's platform share waits in the receiver; from the settlement it is kept. The site names no
  // cap on it (F160, F209; SH-245).
  const settled = view.pool.settled && fs.qPlatformHeld === 0n;
  const f = view.fees;
  return (
    <Card
      id="core-fees"
      title="Fees"
      info={
        <p>
          {box0
            ? `Of the ${record.pairAsset} side of each 1% pool fee, ${share(BOX0_FEE_SHARE_FIT)} buys ${record.ticker} and burns it, ${share(FEE_SHARE_DEPTH)} goes into this pool and ${share(BOX0_FEE_SHARE_PLATFORM)} to the platform (held until graduation). Of the ${record.ticker} side, ${share(BOX0_FEE_SHARE_T_BURN)} is burned (after graduation it funds the per-${one} stream) and ${share(FEE_SHARE_DEPTH)} goes into this pool. The launch tax goes into this pool after graduation.`
            : `Each 1% pool fee is split in batches as this box’s spec says; ${share(FEE_SHARE_DEPTH)} of each side goes into its own pool.`}
        </p>
      }
    >
      <p className="sh-fit-fees__line">
        <strong>{view.source === 'direct' && fs.qTotal === 0n && fs.tTotal === 0n ? 'Fees so far: none yet' : `Fees so far: ${q(fs.qTotal)} · ${t(fs.tTotal)}`}</strong>
      </p>
      {box0 ? (
        <Facts
          rows={[
            [`${share(BOX0_FEE_SHARE_FIT)} burns ${record.ticker}`, q(fs.qFit)],
            [`${share(FEE_SHARE_DEPTH)} into this pool`, `${q(fs.qDepth)} · ${t(fs.tDepth)}`],
            [`${share(BOX0_FEE_SHARE_PLATFORM)} platform`, settled ? q(fs.qPlatform) : `${q(fs.qPlatformHeld)} held until graduation`],
            stream
              ? [`${share(BOX0_FEE_SHARE_T_BURN)} burned or to the per-${one} stream`, fs.tToStream > 0n || view.stream.started ? `${t(fs.tBurned)} burned · ${t(fs.tToStream)} to the stream` : `${t(fs.tBurned)} burned`]
              : [`${share(BOX0_FEE_SHARE_T_BURN)} burned`, t(fs.tBurned)],
            ['Launch tax', view.source === 'direct' ? 'with the indexer' : `${q(taxWaiting > 0n ? taxWaiting : 0n)} waiting · into this pool after graduation`],
          ]}
        />
      ) : (
        <Facts
          rows={[
            ['Q side', `${q(fs.qReward)} · FIT ${q(fs.qFit)} · pool ${q(fs.qDepth)}`],
            ['T side', `${t(BigInt(f.tReward))} · burned ${t(BigInt(f.tBurned))} · pool ${t(fs.tDepth)}`],
          ]}
        />
      )}
    </Card>
  );
}

/** Why a depth add was skipped (BoxTypes.DeepenSkip), in words. */
export const DEEPEN_SKIP_REASONS: Readonly<Record<number, string>> = Object.freeze({
  1: 'the box had not graduated',
  2: 'fewer than 300 blocks since the last add',
  3: 'the 1-hour price average was not ready',
  4: 'the price average had not caught up with the price',
  5: 'the price was more than 99 ticks from its 1-hour average',
  6: 'the budget was below the smallest add',
  7: 'the conversion would have been below its minimum',
});

/** A figure read from a view: as is when it holds at the snapshot, else with the block it was read at. */
function readAt(view: CoreBoxView, text: string): string {
  return view.readsCurrent || view.readsBlock === null ? text : `${text} · at block ${formatBlock(BigInt(view.readsBlock))} (last check)`;
}

/** Pool (BC-142's page part): before graduation what waits for it; after, what is in it at the price. */
export function PoolCard({ record, row, view }: CardProps) {
  const q = (raw: bigint): string => `${formatPair(raw, record, 4)} ${record.pairAsset}`;
  const t = (raw: bigint): string => `${shortT(raw)} ${record.ticker}`;
  const p = view.pool;
  const reads = view.reads ?? {};
  const graduated = view.phase === 'graduated';
  const budgetQ = big(reads['hook.depthBudgetQ']);
  const budgetT = big(reads['hook.depthBudgetT']);
  const retained = big(view.curve.retainedQ);
  const taxWaiting = BigInt(view.launch.taxQ) - BigInt(view.launch.sweptQ);
  const skipped = graduated && p.lastSkipReason !== null ? (DEEPEN_SKIP_REASONS[p.lastSkipReason] ?? `reason ${p.lastSkipReason}`) : null;
  const rows: [string, ReactNode][] = graduated
    ? [
        ['In the pool', p.holdings && view.verified !== false ? `${q(BigInt(p.holdings.q))} + ${t(BigInt(p.holdings.t))}` : 'not shown'],
        ['At', view.price.qPerT && view.verified !== false ? `${perMillion(view.price.qPerT)} ${record.pairAsset} per 1M ${record.ticker}` : 'not shown'],
        ['Locked by fees', BigInt(p.pairedLiquidity) > 0n ? 'yes (pair and lock)' : 'not yet'],
        ['Waiting', budgetQ !== null && budgetT !== null ? readAt(view, `${q(budgetQ)} + ${t(budgetT)}`) : 'not read yet'],
        ['Last add', p.lastAddBlock ? `block ${formatBlock(BigInt(p.lastAddBlock))}` : 'none yet'],
        ['Conversions', p.conversions > 0 ? `${p.conversions} · ${q(BigInt(p.convertedQ))} → ${t(BigInt(p.convertedT))}` : 'none'],
      ]
    : [
        ['Raised', retained === null ? 'not shown' : `${q(retained)} of ${q(row.raise)} · ${((view.curve.fillBps ?? 0) / 100).toFixed(1)}%`],
        ['Pool share waiting', t(BigInt(p.poolShare))],
        ['Held for the pool', `${q(BigInt(p.depthHeldQ))} + ${t(BigInt(p.depthHeldT))}`],
        ['Launch tax waiting', view.source === 'direct' ? 'with the indexer' : q(taxWaiting > 0n ? taxWaiting : 0n)],
      ];
  return (
    <Card
      id="core-pool"
      title="Pool"
      info={
        <>
          <p>Fees and the launch tax are added in small capped steps by pair and lock; part of the tax is first swapped into {record.ticker}. Nothing removes this liquidity.</p>
          {skipped ? <p>{`The last add was skipped: ${skipped}.`}</p> : null}
        </>
      }
    >
      <Facts rows={rows} />
    </Card>
  );
}

/** Per-Misfit stream (add-on 2): per Misfit so far, Misfits outside, claimed and burned. */
export function StreamCard({ record, row, view }: CardProps) {
  if (!row.contracts.itemStream) return null;
  const one = record.itemNoun.replace(/s$/, '');
  const reads = view.reads ?? {};
  const index = big(reads['stream.index']);
  const outside = big(view.vault.outside);
  const started = view.stream.started;
  return (
    <Card id="core-stream" title={`Per-${one} stream`} info={<p>{`After graduation, ${share(BOX0_FEE_SHARE_T_BURN)} of the sellers’ ${record.ticker} fees is shared per ${one} outside the vault; the share of the ${record.itemNoun} inside is burned. What one address is owed shows on its wallet page.`}</p>}>
      {started ? (
        <Facts
          rows={[
            [`Per ${one} so far`, index === null ? 'not read yet' : readAt(view, `${shortT(index)} ${record.ticker}`)],
            [`${record.itemNoun} outside`, outside === null ? 'not known yet' : formatCount(outside)],
            ['Claimed', `${shortT(BigInt(view.stream.claimed))} ${record.ticker}`],
            ['Burned', `${shortT(BigInt(view.stream.burned))} ${record.ticker}`],
          ]}
        />
      ) : (
        <p className="sh-fit-fees__line">Starts at graduation</p>
      )}
    </Card>
  );
}

/** Draws (the placeholders add-on): taken, draws settled, the graduation word; terminal mode only when entered. */
export function DrawsCard({ row, view }: CardProps) {
  if (!row.contracts.tickets) return null;
  const d = view.draws;
  const graduated = view.phase === 'graduated';
  const rows: [string, ReactNode][] = [
    ['Placeholders taken', formatCount(BigInt(d.placeholdersTaken) - BigInt(d.placeholdersHandedBack))],
    ['Draws settled', `${d.drawsSettled} of ${d.drawsRequested}`],
    ['Graduation word', d.wordStored ? 'stored' : graduated || d.wordRequestedRound ? 'waiting for its round' : 'at graduation'],
  ];
  if (d.terminal) rows.push(['Terminal mode', 'entered']);
  return (
    <Card id="core-draws" title="Draws" info={<p>Draws and placeholders open with a drand round posted on chain; anyone can post it.</p>}>
      <Facts rows={rows} />
    </Card>
  );
}

const ACTIVITY_LABELS: Readonly<Record<string, string>> = {
  bootstrap: 'Bootstrap',
  window_buy: 'Window buy',
  launched: 'Pool launched',
  closed: 'Filled',
  graduated: 'Graduated',
  reward_claimed: 'Graduation tip paid',
  migrated: 'Graduated layout',
  batch: 'Fee batch',
  platform_credited: 'Platform share',
  platform_paid: 'Platform paid',
  fit_paid: 'FIT buy-and-burn funded',
  depth_held: 'Held for the pool',
  depth_funded: 'Into the pool’s budget',
  depth_gifted: 'Gift to the pool',
  settled: 'Graduation settled',
  deepened: 'Depth added',
  deepen_skipped: 'Depth add skipped',
  depth_converted: 'Depth conversion',
  swept: 'Launch tax moved',
  withdrawn: 'Taken out',
  returned: 'Put back',
  tickets_opened: 'Escrow locked',
  tickets_released: 'Escrow released',
  gate_opened: 'Vault opened',
  placeholders_taken: 'Placeholders taken',
  placeholders_handed_back: 'Placeholders handed back',
  word_requested: 'Graduation word asked',
  word_stored: 'Graduation word stored',
  draw_requested: 'Draw asked',
  draw_settled: 'Draw settled',
  opened: 'Opened',
  ticket_cancelled: 'Draw cancelled',
  terminal: 'Terminal mode',
  round_posted: 'Round posted',
  stream_started: 'Stream started',
  stream_claimed: 'Stream share claimed',
  stream_burned: 'Inside share burned',
  stream_funded: 'Stream funded',
  buyback: 'FIT burned',
  royalty_flushed: 'Royalties in',
  anomaly: 'Unexpected pool change',
};

/**
 * Activity the page never shows (F142, desk R64-ROWS "hide", 2026-10-21): box 0's backup start and fix. The indexer
 * keeps both rows; the card drops them before it picks its twelve, so no raw kind, no label, no missing row and no hint.
 */
const HIDDEN_ACTIVITY: ReadonlySet<string> = new Set(['backup_started', 'backup_fixed']);

/** One line per event, newest first (the indexer's history; a direct read has none). */
export function ActivityCard({ record, items }: { record: BoxRecord; items: readonly ActivityItem[] | null }) {
  const shown = items === null ? null : items.filter((item) => !HIDDEN_ACTIVITY.has(item.kind));
  return (
    <Card id="core-activity" title="Activity">
      {shown === null ? (
        <p className="sh-muted">With the indexer</p>
      ) : shown.length === 0 ? (
        <p className="sh-muted">Nothing yet</p>
      ) : (
        <ol className="sh-core-activity">
          {shown.slice(0, 12).map((item) => {
            // A depth call that only converted (Deepened kind 2) added nothing yet: its conversion says what it did.
            const label = item.kind === 'trade' ? (item.data.side === 'sell' ? 'Sell' : 'Buy') : item.kind === 'deepened' && Number(item.data.kind) !== 1 ? 'Conversion only, no add yet' : (ACTIVITY_LABELS[item.kind] ?? item.kind);
            const amount = item.kind === 'trade' && typeof item.data.qRaw === 'string' ? `${formatPair(BigInt(item.data.qRaw), record, 4)} ${record.pairAsset}` : null;
            return (
              <li key={`${item.block}-${item.logIndex}-${item.kind}`} data-kind={item.kind}>
                <span>{label}</span>
                {amount ? <span className="sh-core-activity__amount">{amount}</span> : null}
                <span className="sh-muted">{`block ${formatBlock(BigInt(item.block))}`}</span>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

const ROLE_LABELS: Readonly<Record<RoleName, string>> = {
  coordinator: 'Coordinator',
  token: 'Token',
  hook: 'Hook',
  vault: 'Vault',
  collection: 'Collection',
  receiver: 'Fee receiver',
  launchRouter: 'Launch router',
  tickets: 'Placeholders',
  royaltyRouter: 'Royalty router',
  executor: 'FIT executor',
  itemStream: 'Per-item stream',
  swapModule: 'Fee module',
  metadataTable: 'Metadata table',
};

/** Every contract of the box by role, from its row; an explorer link only on Sepolia (links follow the source). */
export function ContractsCard({ row, network }: { row: BoxRow; network: BoxNetwork }) {
  return (
    <Card id="core-contracts" title="Contracts">
      <dl className="sh-core-facts sh-core-contracts">
        {ROLE_NAMES.filter((role) => row.contracts[role] !== null).map((role) => {
          const address = row.contracts[role] as string;
          const href = testnetContractHref(network, address);
          return (
            <div key={role} className="sh-core-facts__row">
              <dt>{ROLE_LABELS[role]}</dt>
              <dd>
                <code title={address}>{shortAddress(address)}</code>
                <CopyButton value={address} label={`Copy the ${ROLE_LABELS[role].toLowerCase()} address`} />
                {href ? (
                  <a href={href} target="_blank" rel="noopener noreferrer" className="sh-core-contracts__link">
                    <ExternalIcon />
                    <span className="sh-visually-hidden">{`${ROLE_LABELS[role]} on the explorer (opens in a new tab)`}</span>
                  </a>
                ) : null}
              </dd>
            </div>
          );
        })}
      </dl>
    </Card>
  );
}
