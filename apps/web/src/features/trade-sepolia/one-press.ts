/**
 * SH-ONE-PRESS-TRADE (the founder, 2026-11-01, after his first live swaps: "why approve and swap? this is privy, we can
 * do it all for the user in one click?"): the rules of the trade folder's one press, apart from React (use-sends.ts
 * `press` runs them).
 *
 * - A press on a plan that needs its exact approval sends that approval (a reset to zero first when another amount is
 *   approved: at most `MAX_APPROVALS`), waits for the chain to mine it, makes the plan again at the new block, and sends
 *   the trade only while that plan is still the trade the person saw: `withinLimit`, their tolerance applied to the quote
 *   on show when they pressed. Otherwise the press stops and the page shows the new quote, with its own press.
 * - The plan made again after the approval, when it fails for a moment (`QUIET_REASONS`), is asked for once more,
 *   `QUIET_RETRY_MS` later.
 * - A quote that fails for a moment (a read the public RPC did not answer: SH-ONE-PRESS-TRADE item 2) is asked for again
 *   quietly, `QUIET_RETRY_MS` later; its line shows only once `FAILURES_SHOWN` refreshes in a row failed.
 * Amounts stay bigint throughout.
 */

import type { TradeFloor } from '@squarehole/chain/trade-sepolia';
import type { SentPlan } from './trade-inflight';
import { spendOf } from './trade-run';

/** Where one step of a press stands, for its tick: not yet, under way, done, or where the press stopped. */
export type StepState = 'waiting' | 'active' | 'done' | 'stopped';

/** A press that needed an approval: its two steps, the approval and the trade. */
export interface Progress {
  readonly approve: StepState;
  readonly trade: StepState;
}

/** A quote's figures: what goes in (null: all of `amountIn`) and what comes out (null: no figure). */
export interface QuoteFigures {
  readonly amountIn: bigint;
  readonly expectedInput: bigint | null;
  readonly expectedOutput: bigint | null;
}

/** The approvals a press sends before its trade, at most: a reset to zero, then the exact amount. */
export const MAX_APPROVALS = 2;

const BPS = 10_000n;

/**
 * Whether the plan made after the approval (`next`) is still the trade the person saw (`shown`), within their tolerance:
 * the same amount, filling at least as much as shown (a quote shown whole fills whole), at a rate (what comes out for
 * what goes in) at most `toleranceBps` below the shown one, compared in whole numbers (out × in, never a division).
 * Never true without both figures: a trade nobody saw a figure for is not sent by itself.
 */
export function withinLimit(shown: QuoteFigures, next: QuoteFigures, toleranceBps: bigint): boolean {
  if (shown.expectedOutput === null || next.expectedOutput === null || next.expectedOutput <= 0n) return false;
  if (shown.amountIn !== next.amountIn || toleranceBps < 0n || toleranceBps >= BPS) return false;
  const shownIn = shown.expectedInput ?? shown.amountIn;
  const nextIn = next.expectedInput ?? next.amountIn;
  if (shownIn <= 0n || nextIn < shownIn) return false;
  return next.expectedOutput * shownIn * BPS >= shown.expectedOutput * nextIn * (BPS - toleranceBps);
}

/**
 * Reasons a quote can fail for a moment and come right a few seconds later: a read the RPC did not answer (`rpc_failed`,
 * the trade calls' reading since SH-ONE-PRESS-TRADE; `block_unavailable`, `invalid_block`), a failure without a known
 * revert (`read_or_simulation_failed`: another RPC's "header not found" reads as one), and a simulation that did not match
 * the replay (a node behind another).
 */
export const QUIET_REASONS: ReadonlySet<string> = new Set(['rpc_failed', 'read_or_simulation_failed', 'block_unavailable', 'invalid_block',
  'pool_simulation_mismatch', 'router_simulation_mismatch']);

/** How soon a quote that failed for a moment is asked for again: past the second or two a public RPC's nodes lag. */
export const QUIET_RETRY_MS = 2_000;

/** A quote's failure shows only once this many refreshes in a row failed. */
export const FAILURES_SHOWN = 2;

/** Whether a failed quote is kept quiet: a passing reason, before `FAILURES_SHOWN` failures in a row. */
export const quietFailure = (reason: string, inARow: number): boolean => QUIET_REASONS.has(reason) && inARow < FAILURES_SHOWN;

// --- af1 (review wf_a701d0c3-b4d of b88b81274) ---------------------------------------------------------------------

/** A plan's own figures: its amount in (the typed one only when the plan names none), what goes in and out. */
export const figuresOf = (plan: SentPlan, typed: bigint): QuoteFigures => ({
  amountIn: plan.amountIn ?? typed, expectedInput: plan.expectedInput, expectedOutput: plan.expectedOutput });

/** The bounds of the plan the person pressed on, carried into the plan made after its approval (the trade calls' floor). */
export const floorOf = (plan: SentPlan): TradeFloor => ({ sqrtPriceLimitX96: plan.priceLimitX96, minimumOutput: plan.minimumOutput });

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Whether the plan made after the approval is the same trade as the one pressed: a box trade of the same box, phase and
 * side, or a coin action of the same kind, paying in the same coin to the same spender. A launch window that ends while
 * the approval is mined makes the box's buy a pool buy, through another spender: not the trade the person saw.
 */
export function sameTrade(pressed: SentPlan, next: SentPlan): boolean {
  if ('kind' in pressed || 'kind' in next) {
    if (!('kind' in pressed) || !('kind' in next) || pressed.kind !== next.kind) return false;
  } else if (pressed.phase !== next.phase || pressed.side !== next.side || !sameAddress(pressed.coordinator, next.coordinator)) return false;
  const a = spendOf(pressed);
  const b = spendOf(next);
  return a !== null && b !== null && sameAddress(a.coin, b.coin) && sameAddress(a.spender, b.spender);
}

/** Reasons a plan made with the pressed quote's bound gives when that bound is already passed: the new quote is shown. */
export const LIMIT_REASONS: ReadonlySet<string> = new Set(['price_limit_already_exceeded', 'insufficient_output']);

/** How many times a plan from a block before the approval's (a node behind) is asked for again before the press stops. */
export const PLAN_BEHIND_TRIES = 3;

/** How long a press waits for the page's read of the box to be current again before its trade (or second approval). */
export const READ_WAIT_MS = 5_000;
