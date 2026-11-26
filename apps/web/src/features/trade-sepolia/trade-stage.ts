/**
 * F156 / F157 Q1 (SH-ALPHA-TRADE-BOX): where a box is for trading, and the launch tax a window buy pays.
 *
 * Before an amount is typed the stage comes from the page's snapshot (life-state.ts `lifeStageV2`, the same stage the
 * box's strip shows); once a plan is prepared, from the hook's own `phase()` at the plan block (BoxTypes.sol: 1
 * Upcoming, 2 Window, 3 Bonding, 4 Closed, 5 Graduated, 6 Failed). The launch tax is the router's table
 * (BoxLaunchRouterV2.taxTable(), `LAUNCH_TAX_TABLE_PIPS`), one step every 12 seconds from the open: 93.20% in the first
 * step falling to 8.06% in the 32nd, none after 384 s. The router charges the step of the block that includes the buy,
 * which is never earlier than now, so the box shows the step at the latest chain time it knows and when that step ends.
 */
import { windowStepAt } from '@squarehole/chain';
import { LAUNCH_TAX_TABLE_PIPS } from '@squarehole/indexer/client';
import { formatTaxPips } from '../fit-pair/fit-format';
import { lifeStageV2 } from '../core/v2/life-state';
import type { V2Snapshot } from '../core/v2/indexer-v2';
import { NEXT_BLOCK_SECONDS, TAX_LOOKAHEAD_SECONDS } from '../data-source/chain-clock';

export type TradeStage = 'upcoming' | 'window' | 'bonding' | 'closed' | 'graduated' | 'failed';

/** The stage in the page's snapshot. A filled curve before graduate() is `closed`: both directions wait. */
export function stageOfView(view: Pick<V2Snapshot, 'failed' | 'graduated' | 'closedAt' | 'gate' | 'timestamp'>): TradeStage {
  const stage = lifeStageV2(view);
  if (stage === 'scheduled') return 'upcoming';
  if (stage === 'raising') return 'bonding';
  if (stage === 'graduating') return 'closed';
  return stage;
}

/** The stage of a hook phase; null for a phase the box does not know. */
export function stageOfPhase(phase: number): TradeStage | null {
  return ({ 1: 'upcoming', 2: 'window', 3: 'bonding', 4: 'closed', 5: 'graduated', 6: 'failed' } as const)[phase as 1] ?? null;
}

/** Whether a stage takes trades at all (Upcoming, Closed and Failed take none). */
export const tradesIn = (stage: TradeStage): boolean => stage === 'window' || stage === 'bonding' || stage === 'graduated';

export interface WindowTax {
  /** The step, 0 to 31. */
  readonly step: number;
  /** The router's rate in pips (millionths). */
  readonly pips: number;
  /** The rate as the box shows it, rounded up to two decimals ("93.20%"): a charge is never understated. */
  readonly text: string;
  /** When this step ends (Unix seconds): the next block after it pays the next step's rate. */
  readonly endsAt: bigint;
}

/** The launch tax at `at` (Unix seconds) for a box that opened at `openAt`; null outside the 384-second window. */
export function windowTaxAt(openAt: bigint, at: bigint): WindowTax | null {
  const step = windowStepAt(openAt, at);
  const pips = step === null ? undefined : LAUNCH_TAX_TABLE_PIPS[step];
  if (step === null || pips === undefined) return null;
  return { step, pips, text: formatTaxPips(pips), endsAt: openAt + 12n * BigInt(step + 1) };
}

/** "14:02:36 UTC": a time of day the step ends at (the window lasts minutes, so the date would only add text). */
/**
 * The chain seconds a quote may count as passed since it was read at `fromMs` (wall clock), at `toMs`: whole slots
 * only (12 s on Sepolia, 1 s on BNB Chain testnet, whose timestamps count whole seconds: SH-258, chain-clock.ts). A
 * block stamps the start of its slot, so counting a partial slot could run ahead of the chain's clock and show a
 * later, lower window tax than the one a buy lands in (TradeBox.tsx).
 */
export function slotSecondsSince(fromMs: number, toMs: number): bigint {
  return toMs > fromMs ? NEXT_BLOCK_SECONDS * BigInt(Math.floor((toMs - fromMs) / (Number(NEXT_BLOCK_SECONDS) * 1000))) : 0n;
}

/**
 * The chain time the buy form's launch tax is read at: Sepolia, the quote's block plus the whole 12 s slots since it was
 * read (its next block); BNB Chain testnet (SH-258 round 3), the latest observed block's own time, never moved on by
 * the browser's clock (a later block may carry the same second). Never before the snapshot's block.
 */
export function taxChainNow(viewTimestamp: bigint, quote: { readonly blockTimestamp: bigint; readonly at: number } | null, clockMs: number): bigint {
  if (!quote) return viewTimestamp;
  const since = TAX_LOOKAHEAD_SECONDS === 0n ? 0n : slotSecondsSince(quote.at, clockMs);
  return quote.blockTimestamp + since > viewTimestamp ? quote.blockTimestamp + since : viewTimestamp;
}

export function clockUtc(unix: bigint): string {
  const date = new Date(Number(unix) * 1000);
  if (Number.isNaN(date.getTime())) return 'unknown time';
  const pad = (value: number) => value.toString().padStart(2, '0');
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} UTC`;
}
