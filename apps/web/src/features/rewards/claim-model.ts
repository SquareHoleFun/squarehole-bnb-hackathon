/**
 * What a claim card can do (SH-014, SH-015; 03-FEED "Holder counts and rewards"; 05-ECONOMICS; ECO-05, ECO-07).
 * Pure functions over the domain `ClaimView`, so every branch is unit-tested without React.
 *
 * - A claim always settles the WHOLE claimable entitlement: there is no amount to choose, anywhere.
 * - R=Q pays the claimable Q. R=T converts it to T at claim time, bounded by a read-only minimum and deadline.
 * - The emergency direct-Q settlement is offered ONLY when the conversion is unavailable (`conversionAvailable` false)
 *   and the published fallback is present; it is always labelled as a fallback.
 * - Pending harvest is never claimable and never added to anything claimable.
 */
import { parseIsoTimestamp, type AssetIdentity, type ClaimView, type ConvertibleEstimate, type DirectSourceFallback, type PairRecord, type RawAmount, type TxHash } from '@squarehole/domain';
import { formatAmount, isZeroRaw } from '../accounts/amounts';
import type { DemoSettlement } from '../accounts/demo-settlements';
import { displaySymbol } from '../feed/format';

export type ClaimAction =
  /** Nothing to claim: the button reads "Nothing claimable yet" and is disabled. */
  | { readonly kind: 'nothing' }
  /** R=Q: pays the claimable Q. */
  | { readonly kind: 'claim_q'; readonly payoutRaw: RawAmount; readonly payoutAsset: AssetIdentity }
  /** R=T with a current quote: converts the claimable Q to T, at or above the signed minimum, before the deadline. */
  | { readonly kind: 'claim_t'; readonly estimate: ConvertibleEstimate; readonly payoutAsset: AssetIdentity }
  /** R=T, conversion available but no current quote (expired or not yet read): refresh before claiming. */
  | { readonly kind: 'needs_quote' }
  /** R=T, the quoted minimum rounds to 0 T: a claim would consume the entitlement for nothing, so none can start (ECO-15). */
  | { readonly kind: 'too_small' }
  /** R=T, conversion unavailable: the labelled emergency settlement pays the credited Q directly. */
  | { readonly kind: 'fallback'; readonly fallback: DirectSourceFallback }
  /** R=T, conversion unavailable and no published fallback: the claim waits, intact. */
  | { readonly kind: 'blocked' };

export function claimActionOf(claim: ClaimView): ClaimAction {
  if (isZeroRaw(claim.claimableQRaw)) return { kind: 'nothing' };
  if (claim.rewardSide === 'Q') return { kind: 'claim_q', payoutRaw: claim.claimableQRaw, payoutAsset: claim.payoutAsset };
  if (claim.conversionAvailable) {
    const estimate = claim.convertibleEstimate;
    if (estimate === null) return { kind: 'needs_quote' };
    return isZeroRaw(estimate.minPayoutRaw) ? { kind: 'too_small' } : { kind: 'claim_t', estimate, payoutAsset: claim.payoutAsset };
  }
  return claim.directSourceFallbackAvailable && claim.directSourceFallback !== null
    ? { kind: 'fallback', fallback: claim.directSourceFallback }
    : { kind: 'blocked' };
}

export const isStartable = (action: ClaimAction): boolean =>
  action.kind === 'claim_q' || action.kind === 'claim_t' || action.kind === 'fallback';

/**
 * The same action once its quote is known to be stale (the deadline passed on the demo clock, or a request saw it pass
 * before signing): an expired quote is not an estimate (ADR-0008 §7), so a conversion waits for a current one.
 */
export const withoutQuote = (action: ClaimAction): ClaimAction => (action.kind === 'claim_t' ? { kind: 'needs_quote' } : action);

/** The claim's quote deadline is at or before `nowMs` (the claim still carries the estimate until it is re-read). */
export function isQuoteExpired(claim: ClaimView, nowMs: number): boolean {
  const estimate = claim.convertibleEstimate;
  return estimate !== null && parseIsoTimestamp(estimate.deadline) <= nowMs;
}

/** Text of the claim button. Names the payout, never offers a choice of amount. */
export function claimButtonLabel(action: ClaimAction, pair: PairRecord): string {
  switch (action.kind) {
    case 'nothing':
      return 'Nothing claimable yet';
    case 'claim_q':
      return `Claim ${formatAmount(action.payoutRaw, action.payoutAsset)}`;
    case 'claim_t':
      return `Claim as ${displaySymbol(pair.token.symbol)}`;
    case 'needs_quote':
      return 'Waiting for a current quote';
    case 'too_small':
      return 'Too small to convert';
    case 'fallback':
      return `Claim ${formatAmount(action.fallback.payoutRaw, action.fallback.payoutAsset)} directly`;
    case 'blocked':
      return 'Conversion unavailable';
  }
}

/** Name of the transaction request (the status panel heading and the demo wallet request). */
export function claimRequestLabel(action: ClaimAction, pair: PairRecord): string {
  if (action.kind === 'claim_t') return `Claim ${pair.name} fee share as ${displaySymbol(pair.token.symbol)}`;
  if (action.kind === 'fallback') return `Emergency claim: ${pair.name} fee share in ${displaySymbol(action.fallback.payoutAsset.symbol)}`;
  return `Claim ${pair.name} fee share`;
}

/** The quote deadline the transaction must be signed by (R=T conversions only). */
export function claimDeadline(action: ClaimAction): string | undefined {
  return action.kind === 'claim_t' ? action.estimate.deadline : undefined;
}

/** What a claim request was started with: the claim as read, the action offered, and the pair (for its settlement). */
export interface StartedClaim {
  readonly claim: ClaimView;
  readonly action: ClaimAction;
  readonly pair: PairRecord;
}

export interface SettledClaim {
  readonly qConsumedRaw: RawAmount;
  readonly payoutRaw: RawAmount;
  readonly payoutAsset: AssetIdentity;
  /** The payout is the pair's own T (credited to the position). */
  readonly paysPairToken: boolean;
}

/**
 * What a finalized request settles, from the claim and action captured when it started. R=T pays the quoted estimate
 * (the demo executes at the quote; a real contract pays the executable output, at least the signed minimum).
 */
export function settledClaimOf(claim: ClaimView, action: ClaimAction): SettledClaim | null {
  if (action.kind === 'claim_q') {
    return { qConsumedRaw: claim.claimableQRaw, payoutRaw: action.payoutRaw, payoutAsset: action.payoutAsset, paysPairToken: false };
  }
  if (action.kind === 'claim_t') {
    return { qConsumedRaw: claim.claimableQRaw, payoutRaw: action.estimate.payoutRaw, payoutAsset: action.payoutAsset, paysPairToken: true };
  }
  if (action.kind === 'fallback') {
    return {
      qConsumedRaw: claim.claimableQRaw,
      payoutRaw: action.fallback.payoutRaw,
      payoutAsset: action.fallback.payoutAsset,
      paysPairToken: false,
    };
  }
  return null;
}

/** The demo ledger entry for a finalized request (see accounts/demo-settlements.ts). */
export function demoSettlementOf(
  claim: ClaimView,
  action: ClaimAction,
  pair: PairRecord,
  receipt: { readonly hash: TxHash; readonly block: string },
): DemoSettlement | null {
  const settled = settledClaimOf(claim, action);
  if (settled === null) return null;
  return {
    owner: claim.owner,
    pairId: claim.pairId,
    qConsumedRaw: settled.qConsumedRaw,
    payoutRaw: settled.payoutRaw,
    payoutAsset: settled.payoutAsset,
    tokenCredit: settled.paysPairToken ? { type: pair.type, nftUnitRaw: pair.nftUnitRaw ?? null } : null,
    block: receipt.block,
    hash: receipt.hash,
  };
}

export interface ClaimCounts {
  readonly claimable: number;
  readonly pendingHarvest: number;
  readonly claimedBefore: number;
}

/** Counts, never sums: amounts in different assets are never added together (03-FEED). */
export function countClaims(claims: readonly ClaimView[]): ClaimCounts {
  return {
    claimable: claims.filter((claim) => !isZeroRaw(claim.claimableQRaw)).length,
    pendingHarvest: claims.filter((claim) => !isZeroRaw(claim.pendingHarvestQRaw)).length,
    claimedBefore: claims.filter((claim) => claim.history.some((entry) => entry.outcome === 'settled')).length,
  };
}
