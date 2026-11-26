/**
 * SH-BOX-LIFE-VIEW: where a v2 box is in its life, as the top of its page shows it. Four steps, Launch, Raise, Graduate
 * and Pool, each with one number; a finished step is done, the box's step is current, later ones are next, and the step
 * a closed box ended at is failed. The stage is read from the snapshot in chain time (the block's timestamp), never the
 * browser's clock; only the countdowns count down with the clock. Amounts stay bigint until they are text.
 */
import { WINDOW_SECONDS } from '@squarehole/box-spec';
import { windowStepAt } from '@squarehole/chain';
import { LAUNCH_TAX_TABLE_PIPS } from '@squarehole/indexer/client';
import { formatAgo, formatBps, formatTaxPips, formatUtc } from '../../fit-pair/fit-format';
import type { V2Snapshot } from './indexer-v2';
import { pAmountV2, raiseShownV2 } from './stats-v2';
import { TAX_LOOKAHEAD_SECONDS } from '../../data-source/chain-clock';

export type LifeStageV2 = 'scheduled' | 'window' | 'raising' | 'graduating' | 'graduated' | 'failed';
export type LifeStepIdV2 = 'launch' | 'raise' | 'graduate' | 'pool';
export type LifeStepStatusV2 = 'done' | 'current' | 'next' | 'failed';

export interface LifeStepV2 {
  readonly id: LifeStepIdV2;
  /** One word. */
  readonly label: string;
  readonly status: LifeStepStatusV2;
  /** The step's one number (or one or two words when it has none). */
  readonly value: string;
  /** Its unit or its moment, small; null when the value says it all. */
  readonly sub: string | null;
  /** The whole step in words, for a screen reader and the title. */
  readonly spoken: string;
}

type StageInput = Pick<V2Snapshot, 'failed' | 'graduated' | 'closedAt' | 'gate' | 'timestamp'>;

/** The stage at the snapshot's block: closed, graduated, full (graduating), not open yet, the launch window, raising. */
export function lifeStageV2(view: StageInput): LifeStageV2 {
  if (view.failed) return 'failed';
  if (view.graduated) return 'graduated';
  if (view.closedAt > 0n) return 'graduating';
  if (!view.gate.open || view.timestamp < view.gate.effectiveOpenAt) return 'scheduled';
  if (view.timestamp < view.gate.effectiveOpenAt + WINDOW_SECONDS) return 'window';
  return 'raising';
}

/** "2 d 3 h", "2 h 14 min", "14 min", "45 s": a wait, truncated (never more than is left). */
export function durationShortV2(seconds: bigint): string {
  const s = seconds < 0n ? 0n : seconds;
  if (s >= 86_400n) {
    const h = (s % 86_400n) / 3_600n;
    return `${s / 86_400n} d${h > 0n ? ` ${h} h` : ''}`;
  }
  if (s >= 3_600n) {
    const m = (s % 3_600n) / 60n;
    return `${s / 3_600n} h${m > 0n ? ` ${m} min` : ''}`;
  }
  if (s >= 60n) return `${s / 60n} min`;
  return `${s} s`;
}

/** "5:12": minutes and seconds left on a short clock (the launch window's 384 s). */
export function clockLeftV2(seconds: bigint): string {
  const s = seconds < 0n ? 0n : seconds;
  return `${s / 60n}:${String(s % 60n).padStart(2, '0')}`;
}

/**
 * The launch tax of the next block in the window (12 s after `at` on Sepolia, 1 s on BNB Chain testnet: SH-258,
 * chain-clock.ts), as the launch router charges it; null outside it.
 */
export function windowTaxV2(openAt: bigint, at: bigint): string | null {
  const step = windowStepAt(openAt, at + TAX_LOOKAHEAD_SECONDS);
  const pips = step === null ? undefined : LAUNCH_TAX_TABLE_PIPS[step];
  return pips === undefined ? null : formatTaxPips(pips);
}

/**
 * The raise in the price coin: "100 tNVDA", every digit while the figure has at most twelve characters (F74 U5: one
 * raise, every digit); a longer one in the short form (SH-276, stats-v2.ts `raiseShownV2`).
 */
export const raiseTextV2 = (view: Pick<V2Snapshot, 'record' | 'decimals'>, coin: string): string => `${raiseShownV2(view.record.raise, view.decimals)} ${coin}`;

/** The raise bar's figures; null when the indexer publishes no progress (outside the curve, or no statistics). */
export interface RaiseBarV2 {
  /** 0 … 10,000. */
  readonly bps: number;
  readonly full: boolean;
  /** "42.1%". */
  readonly percent: string;
  /** "42.1 / 100 tNVDA": the raised part short, the raise exact. */
  readonly amount: string;
}

export function raiseBarV2(view: Pick<V2Snapshot, 'statistics' | 'decimals' | 'closedAt' | 'record' | 'graduated'>, coin: string): RaiseBarV2 | null {
  if (view.graduated) return null;
  const progress = view.statistics?.raiseProgress ?? null;
  if (progress === null) {
    // A filled curve whose statistics are not published yet is still full (closedAt is the hook's own CurveClosed).
    if (view.closedAt === 0n) return null;
    return { bps: 10_000, full: true, percent: formatBps(10_000), amount: `${raiseShownV2(view.record.raise, view.decimals)} / ${raiseShownV2(view.record.raise, view.decimals)} ${coin}` };
  }
  const bps = view.closedAt > 0n ? 10_000 : Number(progress.progressBps);
  return { bps, full: bps >= 10_000, percent: formatBps(bps), amount: `${pAmountV2(view.closedAt > 0n ? progress.raiseP : progress.raisedP, view.decimals)} / ${raiseShownV2(progress.raiseP, view.decimals)} ${coin}` };
}

export interface LifeStepsInput {
  readonly view: V2Snapshot;
  /** The reader's clock (whole seconds), for the countdowns only. */
  readonly nowSec: bigint;
  readonly coin: string;
  readonly ticker: string;
  /** The pool price per 1M box tokens as text ("0.4872"), or a dash. */
  readonly price: string;
  /** When the box graduated (its `Graduated` event's block time), when known. */
  readonly graduatedAt: bigint | null;
}

const STATUS_WORD: Readonly<Record<LifeStepStatusV2, string>> = { done: 'done', current: 'now', next: 'next', failed: 'ended here' };
const step = (id: LifeStepIdV2, label: string, status: LifeStepStatusV2, value: string, sub: string | null, spokenExtra: string | null = null): LifeStepV2 => ({
  id, label, status, value, sub, spoken: `${label}: ${STATUS_WORD[status]}, ${value}${sub ? `, ${sub}` : ''}${spokenExtra ? ` (${spokenExtra})` : ''}`,
});

/** The step a closed box ended at (BoxFailed's cause): the gate's cap at Launch, the deadline at Raise, the hatch at Graduate. */
export function failedStepV2(cause: string): LifeStepIdV2 {
  if (cause === 'ClosedPastCap') return 'launch';
  if (cause === 'GraduationTimedOut') return 'graduate';
  return 'raise';
}

/**
 * Whether the box can still graduate, by the contract's rules (review fix 2; the evidence cites the lines): never once
 * failed or graduated; a full raise (the curve closed, `closedAt`) can be graduated by anyone until someone fails it
 * (`graduate()` needs only a closed curve; `fail()` opens seven days after `closedAt`); an unfilled raise only before
 * its deadline (the hook refuses every buy from the deadline on, `FailurePending`), or while its deadline is not set
 * (the gate still holding). Chain time: the snapshot's block. Every "After graduation" and "Opens at graduation" on
 * the page shows only while this holds; the strip's Graduate step too.
 */
export const canStillGraduateV2 = (view: Pick<V2Snapshot, 'failed' | 'graduated' | 'closedAt' | 'gate' | 'timestamp'>): boolean =>
  !view.failed && !view.graduated && (view.closedAt > 0n || view.gate.deadline === 0n || view.timestamp < view.gate.deadline);

/** The four steps for the box's stage. */
export function lifeStepsV2({ view, nowSec, coin, ticker, price, graduatedAt }: LifeStepsInput): readonly LifeStepV2[] {
  const stage = lifeStageV2(view);
  const openAt = view.gate.effectiveOpenAt;
  // Times since: counted from the snapshot's block, like every other figure (never a future "ago").
  const head = view.timestamp > nowSec ? view.timestamp : nowSec;
  const ago = (at: bigint) => formatAgo(head - at);
  const raise = raiseTextV2(view, coin);
  const bar = raiseBarV2(view, coin);
  const unit = `${coin} per 1M ${ticker}`;
  const launchDone = step('launch', 'Launch', 'done', ago(openAt), null, `opened ${formatUtc(openAt, false)}`);
  const poolNext = step('pool', 'Pool', 'next', '—', null);
  switch (stage) {
    case 'scheduled': {
      const launch = !view.gate.open
        ? step('launch', 'Launch', 'current', 'Not open', null)
        : step('launch', 'Launch', 'current', openAt > nowSec ? `in ${durationShortV2(openAt - nowSec)}` : 'now', formatUtc(openAt, false));
      // The raise as the bar shows it (the bootstrap buy's part included); unpublished, a dash, as the tiles print an
      // unknown figure: a start buy can have raised some before the box opens (SH-255 round 3, D15 a).
      return [launch, step('raise', 'Raise', 'next', bar?.percent ?? '—', bar?.amount ?? raise), step('graduate', 'Graduate', 'next', 'at 100%', null), poolNext];
    }
    case 'window': {
      const end = openAt + WINDOW_SECONDS;
      const left = end > nowSec ? end - nowSec : 0n;
      const tax = windowTaxV2(openAt, view.timestamp);
      return [
        step('launch', 'Launch', 'current', `${clockLeftV2(left)} left`, tax ? `tax ${tax}` : null, 'the launch window: buys pay a launch tax that falls every 12 s'),
        step('raise', 'Raise', 'next', bar?.percent ?? '—', bar?.amount ?? raise),
        step('graduate', 'Graduate', 'next', 'at 100%', null),
        poolNext,
      ];
    }
    case 'raising':
      // Past its deadline, unfilled, a box can no longer graduate (canStillGraduateV2): its Graduate step reads as a
      // closed box's does (SH-255), not "at 100%".
      return [launchDone, step('raise', 'Raise', 'current', bar?.percent ?? '—', bar?.amount ?? raise), canStillGraduateV2(view) ? step('graduate', 'Graduate', 'next', 'at 100%', null) : step('graduate', 'Graduate', 'next', '—', null), poolNext];
    case 'graduating':
      return [launchDone, step('raise', 'Raise', 'done', raise, `full ${ago(view.closedAt)}`), step('graduate', 'Graduate', 'current', 'Pending', null, 'the raise is full; anyone may graduate the box'), poolNext];
    case 'graduated':
      return [
        launchDone,
        step('raise', 'Raise', 'done', raise, null),
        step('graduate', 'Graduate', 'done', graduatedAt === null ? 'Done' : ago(graduatedAt), null, graduatedAt === null ? null : formatUtc(graduatedAt, false)),
        step('pool', 'Pool', 'current', price, unit),
      ];
    case 'failed': {
      const at = failedStepV2(view.failed?.cause ?? 'Deadline');
      const closed = view.failed ? `closed ${ago(view.failed.at)}` : null;
      const launch = at === 'launch' ? step('launch', 'Launch', 'failed', 'Closed', closed) : launchDone;
      const raiseStep = at === 'launch' ? step('raise', 'Raise', 'next', '—', null)
        : at === 'raise' ? step('raise', 'Raise', 'failed', bar?.percent ?? 'Closed', 'deadline passed')
          : step('raise', 'Raise', 'done', raise, null);
      const graduate = at === 'graduate' ? step('graduate', 'Graduate', 'failed', 'Closed', '7 days passed') : step('graduate', 'Graduate', 'next', '—', null);
      return [launch, raiseStep, graduate, poolNext];
    }
  }
}
