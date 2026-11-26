/**
 * Box 0's fees as F77 decided them ("the Misfits like all the others", DECISION-LOG F77; docs/design/box0-like-others.md
 * § 7.4), every figure from the version's constants (`@squarehole/box-spec`): buyers' fees in ETH 11/15 buy the token
 * and burn it, 2/15 go into the box's own pool and 2/15 to the platform (the site names no cap on it: F160, F209,
 * SH-245); sellers' fees in the token 13/15 burned (the planned per-item stream after graduation) and 2/15 into the
 * pool; the launch tax into the pool after graduation.
 *
 * The Demo shows this design. A deployed pool keeps the lines about its own code (FeeDisclosure's rule): the Sepolia
 * rehearsal and a local chain run today's v2 contracts (2/15 to the treasury, 13/15 buy-and-burn, the tax to the
 * treasury), so `deployment === 'chain'` keeps those texts until a core v1 box 0 is deployed.
 */
import {
  BOX0_FEE_SHARE_FIT,
  BOX0_FEE_SHARE_PLATFORM,
  BOX0_FEE_SHARE_T_BURN,
  FEE_SHARE_DENOMINATOR,
  FEE_SHARE_DEPTH,
} from '@squarehole/box-spec';
import type { LiveData } from './live-model';

const share = (n: bigint): string => `${n}/${FEE_SHARE_DENOMINATOR}`;

/**
 * The box card's setup line for box 0 (the Demo and a chain row): numbers first, both fee sides. SH-245: the sellers' 13/15
 * in the Fees card's own words (CoreCards.tsx), true before and after graduation.
 */
export function box0SetupLine(token: string, item = 'Misfit'): string {
  return `Pool fee 1%: ${share(BOX0_FEE_SHARE_FIT)} burns ${token} · ${share(FEE_SHARE_DEPTH)} into this pool · ${share(BOX0_FEE_SHARE_PLATFORM)} platform. Sellers’ ${token}: ${share(BOX0_FEE_SHARE_T_BURN)} burned or to the per-${item} stream · ${share(FEE_SHARE_DEPTH)} into this pool.`;
}

/** The deployed v2 code's setup line (the Sepolia rehearsal and a local chain): its own split, unchanged. */
export function v2SetupLine(token: string): string {
  return `Pool fee 1%. Of the ETH part, 2/15 goes to the treasury and 13/15 buys ${token} and burns it; the ${token} part is burned.`;
}

/** Where the pool fee goes on the Demo (behind the Fees card's (i)). */
export function box0FeeWhere(token: string, item: string): string {
  return `Of the ETH part, ${share(BOX0_FEE_SHARE_FIT)} buys ${token} and burns it, ${share(FEE_SHARE_DEPTH)} goes into this box’s pool and ${share(BOX0_FEE_SHARE_PLATFORM)} to the platform. Of the ${token} part, ${share(BOX0_FEE_SHARE_T_BURN)} is burned today, and after graduation it is planned to go to the per-${item} stream (Terms 5.10), which is not built yet; ${share(FEE_SHARE_DEPTH)} goes into this pool.`;
}

/** Where the launch tax goes on the Demo. */
export const BOX0_TAX_WHERE = 'into this box’s pool after graduation';

/**
 * The (i) line of the Pool card. The launch tax is Q only, so it is paired through the swap engine (F76, F77): deepen()
 * swaps up to half of it into FIT in small capped steps, then pairs (swap module S5.M5, built; BC-137, BC-142).
 */
export const POOL_STEPS_LINE = 'Fees and the launch tax are added in small capped steps; part of the tax is swapped into FIT first.';

/** What the Pool card shows: added to the pool's own position, and waiting (held, swept or not yet paired). */
export interface PoolFigures {
  readonly addedEth: bigint;
  readonly addedToken: bigint;
  readonly waitingEth: bigint;
  readonly waitingToken: bigint;
}

/**
 * The Demo's pool figures from the Demo chain's frame (D07: labelled Demo): the 2/15 of the pool fees paid so far on
 * each side and the launch tax, all waiting (held until graduation; the Demo chain adds no pair). Null without fee
 * totals (a direct read has none). On a chain box these come from the hook (`pairedLiquidity`, `depthBudget`) and the
 * launch router's balance once S10a reads them (BC-142).
 */
export function demoPoolFigures(data: LiveData | null): PoolFigures | null {
  const state = data?.state;
  if (!state || state.feesWei == null || state.feesTokenRaw == null) return null;
  const depth = (fees: bigint): bigint => (fees / FEE_SHARE_DENOMINATOR) * FEE_SHARE_DEPTH;
  return Object.freeze({
    addedEth: 0n,
    addedToken: 0n,
    waitingEth: depth(state.feesWei) + (state.taxWei ?? 0n),
    waitingToken: depth(state.feesTokenRaw),
  });
}
