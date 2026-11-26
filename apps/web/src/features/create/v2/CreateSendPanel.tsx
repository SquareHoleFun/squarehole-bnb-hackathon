/**
 * TA-22: the Overview's plan on a real build. Before Create, the steps the plan lists (creation-plan.ts); once the run
 * reads the chain, its own steps (create-send.ts), each marked done by the chain, the one in the wallet marked current,
 * and one short status line. Numbers first: "2/5", never a paragraph. The buttons stay in the page's bar.
 */
import { formatUnits } from '@squarehole/domain';
import { starterApproveLabel, starterPageLabel, type CreationPlan, type PlanStep } from './creation-plan';
import { amountText, type SiteListing } from './listings';
import { ChunkPart } from './spec-types';
import type { CreateSendView } from './useCreateSend';

type Seed = { readonly listing: SiteListing; readonly amount: bigint } | null;

/** The plan's steps in the run's words, before the chain is read. */
export function planLabels(plan: CreationPlan, pricing: SiteListing, seed: Seed, ticker: string): readonly string[] {
  const parts = new Map<number, number>();
  for (const step of plan.steps) if (step.call === 'loadChunk' && step.part !== undefined) parts.set(step.part, (parts.get(step.part) ?? 0) + 1);
  const starters = plan.steps.filter((step) => step.call === 'approveStarter').length;
  const pages = plan.steps.filter((step) => step.call === 'loadStarter').length;
  const label = (step: PlanStep): string => {
    if (step.call === 'approve') return `Approve ${amountText(step.amount ?? 0n, pricing)}`;
    if (step.call === 'createBox') return 'Create the box';
    if (step.call === 'loadChunk') return `Load ${step.part === ChunkPart.Table ? 'items' : 'texts'} ${(step.index ?? 0) + 1}/${parts.get(step.part ?? 0) ?? 0}`;
    if (step.call === 'approveSeed') return `Approve the seed · ${seed ? amountText(step.amount ?? 0n, seed.listing) : ''}`;
    if (step.call === 'loadSeed') return 'Load the pile';
    if (step.call === 'approveStarter') return starterApproveLabel(step.index ?? 0, starters);
    if (step.call === 'loadStarter') return starterPageLabel(step.index ?? 0, pages);
    if (step.call === 'approveShopSeed') return `Approve the seed · ${formatUnits(step.amount ?? 0n, 18)} ${ticker || 'T'}`;
    if (step.call === 'fundSeed') return 'Fund the shop';
    return 'Open the shop';
  };
  return plan.steps.map(label);
}

/** The status line: where the run stands, as a count. */
export function sendStatusText(view: CreateSendView): string | null {
  if (view.phase === 'idle') return null;
  if (view.phase === 'preparing') return 'Finding the box’s address';
  if (view.phase === 'failed') return null;
  const total = view.progress.steps.length + view.progress.later.length;
  const done = view.progress.done.filter(Boolean).length;
  if (view.phase === 'done') return `Created · ${done}/${total}`;
  if (view.phase === 'stopped') return `Stopped · ${done}/${total}`;
  if (view.stopping) return `Stopping · ${done}/${total}`;
  return view.sending === null ? `Reading the chain · ${done}/${total}` : `${view.sending + 1}/${total} · Confirm in your wallet`;
}

export interface CreateSendPanelProps {
  readonly view: CreateSendView;
  /** The plan's labels, shown until the run has read the chain. */
  readonly planned: readonly string[];
  /** The box a stored run creates, when it is not this draft (after a reload): its ticker. */
  readonly runTicker: string | null;
  readonly blockedTitle: string | null;
}

export function CreateSendPanel({ view, planned, runTicker, blockedTitle }: CreateSendPanelProps) {
  const progress = view.phase === 'running' || view.phase === 'stopped' || view.phase === 'done' || (view.phase === 'failed' && view.progress) ? view.progress : null;
  const rows = progress
    ? [...progress.steps.map((step, i) => ({ label: step.label, done: progress.done[i] === true, current: view.phase === 'running' && view.sending === i })),
      ...progress.later.map((label) => ({ label, done: false, current: false }))]
    : planned.map((label) => ({ label, done: false, current: false }));
  const status = sendStatusText(view);
  const count = `${rows.length} ${rows.length === 1 ? 'transaction' : 'transactions'}`;
  return (
    <section className="sh-newbox-group sh-v2-send" aria-labelledby="overview-v2-plan" data-send-phase={view.phase}>
      <div className="sh-newbox-group__head">
        <h2 id="overview-v2-plan">{blockedTitle && !progress ? blockedTitle : `Create${runTicker ? ` ${runTicker}` : ''} · ${count}`}</h2>
      </div>
      <ol className="sh-v2-plan">
        {rows.map((row, index) => (
          <li key={`${index}-${row.label}`} data-done={row.done ? '' : undefined} data-current={row.current ? '' : undefined} aria-current={row.current ? 'step' : undefined}>
            {row.label}
          </li>
        ))}
      </ol>
      {status ? <p className="sh-newbox-status sh-v2-status" role="status" data-create-status="">{status}</p> : null}
      {view.phase === 'failed' ? <p className="sh-newbox-error" role="alert" data-create-error=""><span aria-hidden="true">!</span> {view.message}</p> : null}
    </section>
  );
}
