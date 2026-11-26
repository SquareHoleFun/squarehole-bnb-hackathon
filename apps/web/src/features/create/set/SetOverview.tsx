/**
 * SH-EXISTING-NFTS-E08C: the set Create flow's Overview: every parameter the spec commits (each group with its Edit
 * link), the full list in committed order (windowed: all 10,000 rows scroll, a few are in the page), the list file's
 * state, and the plan: before Create the steps it takes, once the run reads the chain its own rows, each marked done by
 * the chain. Numbers first; outside pictures are read lazily and never needed.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { Address, Hex } from 'viem';
import type { SetSpecV2 } from '@squarehole/box-spec';
import { formatCount } from '../../fit-pair/fit-format';
import { SetItemPicture } from '../../set/SetItemPicture';
import { VirtualList } from '../../set/VirtualList';
import type { SetReads } from '../../set/set-reads';
import { EditGlyph } from '../create-parts';
import { amountText, raiseText, type SiteListing } from '../v2/listings';
import type { SetItems } from './set-create-model';
import type { SetDraft } from './set-draft';
import type { SetPlanRow } from './set-send';
import { SET_STEPS, setPath, type SetStepId } from './set-steps';
import type { SetCreateView } from './useSetCreate';

/** A row of the full list is this tall (a 78-digit id wraps to a second line on a phone). */
export const LIST_ROW_PX = 48;
const LIST_HEIGHT_PX = 336;

function Group({ step, fix, rows }: { step: SetStepId; fix: boolean; rows: readonly (readonly [string, ReactNode])[] }) {
  const label = SET_STEPS.find((entry) => entry.id === step)?.label ?? step;
  return (
    <section className="sh-newbox-group" aria-labelledby={`overview-${step}`} data-fix={fix || undefined}>
      <div className="sh-newbox-group__head">
        <h2 id={`overview-${step}`}>
          {label}
          {fix ? <span className="sh-newbox-group__fix"> · Fix</span> : null}
        </h2>
        <Link to={setPath(step)} state={{ fromOverview: true }} aria-label={`Edit ${label}`} className="sh-newbox-edit">
          <EditGlyph />
          Edit
        </Link>
      </div>
      <dl className="sh-newbox-rows">
        {rows.map(([name, value]) => (
          <div key={name} className="sh-newbox-row">
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export interface SetOverviewProps {
  readonly draft: SetDraft;
  readonly listing: SiteListing | null;
  readonly items: SetItems | null;
  readonly spec: SetSpecV2 | null;
  readonly specHash: Hex | null;
  readonly fix: ReadonlySet<SetStepId>;
  readonly listSaved: boolean;
  /** For the items' pictures (tokenURI); null: none are read. */
  readonly reads: Pick<SetReads, 'read'> | null;
  readonly chainId: number;
  readonly ipfs: readonly string[];
  /** The plan and the run (SetSendPanel). */
  readonly plan: ReactNode;
}

const code = (value: string) => <code className="sh-set-code">{value}</code>;

export function SetOverview({ draft, listing, items, spec, specHash, fix, listSaved, reads, chainId, ipfs, plan }: SetOverviewProps) {
  const ticker = draft.ticker.trim();
  const groups: [SetStepId, (readonly [string, ReactNode])[]][] = [
    ['set-basics', [
      ['Priced in', listing?.symbol ?? 'Choose a price coin'],
      ['Token', `${draft.name.trim() || '?'} · ${ticker || '?'}`],
      ['Logo', draft.logo?.url ? <img className="sh-newbox-thumb" src={draft.logo.url} width={40} height={40} alt="Logo" /> : 'Add a logo'],
      ['About', draft.about.trim() || 'None'],
    ]],
    ['set-items', [
      ['Collection', items ? code(items.collection) : 'Fix the collection'],
      ['Items', items ? formatCount(BigInt(items.ids.length)) : 'Fix the ids'],
      ['Pick fee', `${draft.pickFeeBps / 100}%`],
      ['Return fee', '5%'],
      ['Set hash', items ? code(items.commitment.setHash) : 'Fix the ids'],
    ]],
    ['set-raise', [
      ['Raise', listing ? raiseText(listing, listing.raise) : 'Unavailable'],
      ['Deadline', `${draft.deadlineDays} days`],
      ['Opens', 'Once loaded'],
      [`Your ${listing?.symbol ?? 'coins'} at start`, listing && spec ? amountText(spec.creatorBuy, listing) : 'Unavailable'],
      ['Trade fee', '1% · pool depth'],
    ]],
  ];
  return (
    <>
      {groups.map(([step, rows]) => <Group key={step} step={step} fix={fix.has(step)} rows={rows} />)}
      {items ? (
        <section className="sh-newbox-group sh-set-list" aria-labelledby="overview-set-list">
          <div className="sh-newbox-group__head">
            <h2 id="overview-set-list">{`List · ${formatCount(BigInt(items.ids.length))}`}</h2>
            <span className="sh-set-list__file" data-list-saved={listSaved || undefined}>{listSaved ? 'File saved' : 'File not saved'}</span>
          </div>
          <VirtualList
            items={items.ids}
            rowHeight={LIST_ROW_PX}
            height={LIST_HEIGHT_PX}
            label="Every item, in order"
            keyOf={(id) => id.toString()}
            render={(id, index) => (
              <span className="sh-set-item">
                <span className="sh-set-item__pos">{formatCount(BigInt(index + 1))}</span>
                <SetItemPicture reads={reads} chainId={chainId} collection={items.collection as Address} id={id} ipfs={ipfs} />
                <span className="sh-set-item__id">{`#${id.toString()}`}</span>
              </span>
            )}
          />
        </section>
      ) : null}
      {plan}
      <details className="sh-newbox-more sh-newbox-spec">
        <summary>Details</summary>
        <p className="sh-newbox-hash">
          <span>Spec hash</span> <code data-spec-hash={specHash ?? ''}>{specHash ?? 'Unavailable'}</code>
        </p>
      </details>
    </>
  );
}

/** The plan's status line: where the run stands, in two or three words. */
export function setStatusText(view: SetCreateView): string | null {
  switch (view.phase) {
    case 'idle': case 'failed': return null;
    case 'preparing': return 'Finding the box’s address';
    case 'running': return view.stopping ? 'Stopping' : view.sending ? 'Confirm in your wallet' : 'Reading the chain';
    case 'stopped': return 'Stopped';
    case 'done': return 'Created · trading open';
    case 'closed': return 'Raise failed';
  }
}

export interface SetSendPanelProps {
  readonly view: SetCreateView;
  /** The plan's rows before the run has read the chain. */
  readonly planned: readonly SetPlanRow[];
  readonly transactions: number;
  /** The ticker of a stored run that is not this draft (after a reload). */
  readonly runTicker: string | null;
}

export function SetSendPanel({ view, planned, transactions, runTicker }: SetSendPanelProps) {
  const progress = 'progress' in view ? view.progress : null;
  const rows = progress?.rows ?? planned;
  const sending = view.phase === 'running' ? view.sending : null;
  const status = setStatusText(view);
  return (
    <section className="sh-newbox-group sh-set-send" aria-labelledby="overview-set-plan" data-send-phase={view.phase}>
      <div className="sh-newbox-group__head">
        <h2 id="overview-set-plan">{`Create${runTicker ? ` ${runTicker}` : ''} · ${formatCount(BigInt(transactions))} transactions`}</h2>
      </div>
      <ol className="sh-set-plan">
        {rows.map((row) => (
          <li key={row.kind} data-done={row.done ? '' : undefined} data-current={sending === row.kind ? '' : undefined} aria-current={sending === row.kind ? 'step' : undefined}>
            {row.label}
          </li>
        ))}
      </ol>
      {status ? <p className="sh-newbox-status" role="status" data-create-status="">{status}</p> : null}
      {view.phase === 'failed' ? <p className="sh-newbox-error" role="alert" data-create-error=""><span aria-hidden="true">!</span> {view.message}</p> : null}
    </section>
  );
}
