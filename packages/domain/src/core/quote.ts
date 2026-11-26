/**
 * Conversion quotes (v2 AGENTS.md: "All quotes bind asset/chain/policy and include limits/deadlines"; docs/03
 * "Withdrawing k NFTs" / "Returning k NFTs"; SH-V2-T03). A quote is computed from one pre-operation snapshot, names
 * the exact policies it used, carries fees as separate burned lines, a max-spend or min-receive limit that includes
 * those fees, and a deadline inside the quote policy's window. `quoteIssues` recomputes everything and reports any
 * difference; nothing here signs, sends or builds a transaction.
 *
 * Fee order (whether a fee burn sees pre- or post-conversion occupancy) is still open (G05); these quotes price fees
 * on the principal only and leave that choice to the approved policy.
 */
import { CoreModelError } from '../errors';
import type { GuardIssue } from '../guards';
import { addAmounts, amountOf, mulDiv, sameAsset, subAmounts, type Amount } from './amounts';
import type { NftTokenId } from './ids';
import { meetsFinality, snapshotIssues, type VaultSnapshot } from './metrics';
import {
  PPM,
  conversionFeeFor,
  policyRef,
  samePolicyRef,
  type ConversionFeeAction,
  type FeePolicy,
  type PolicyRef,
  type QuotePolicy,
  type VaultPolicy,
} from './policy';

export type ConversionAction = 'withdraw' | 'return';
/** How a withdrawal chooses its Misfits. Which draw mechanism is used is still open (F23 A2, G08). */
export type WithdrawSelection = 'draw' | 'named_pick';

export interface QuoteFee {
  readonly action: ConversionFeeAction;
  readonly amount: Amount;
  readonly destination: 'burn';
  readonly policy: PolicyRef;
}

export interface ConversionQuote {
  readonly action: ConversionAction;
  /** Withdrawals only; null for a return. */
  readonly selection: WithdrawSelection | null;
  readonly snapshot: VaultSnapshot;
  readonly quantity: bigint;
  /** Exact IDs for a named pick or a return; empty for a draw. */
  readonly tokenIds: readonly NftTokenId[];
  readonly principal: Amount;
  readonly fees: readonly QuoteFee[];
  /** Withdraw: the most FIT the user pays (principal + fees). Return: the least FIT the user receives (principal − fees). */
  readonly limit: Amount;
  readonly quotePolicy: PolicyRef;
  readonly feePolicy: PolicyRef;
  /** Unix seconds. */
  readonly quotedAt: number;
  /** Unix seconds; the quote is unusable at or after this time. */
  readonly expiresAt: number;
}

export interface QuoteContext {
  readonly quotePolicy: QuotePolicy;
  readonly feePolicy: FeePolicy;
  readonly vaultPolicy: VaultPolicy;
  /** Injected clock (unix seconds); nothing here reads the wall clock. */
  readonly nowSeconds: number;
}

/** principal = ceil(A × k / n) to withdraw, floor(A × k / n) to return, from the pre-operation state. */
export function principalFor(snapshot: VaultSnapshot, action: ConversionAction, quantity: bigint): Amount {
  const n = snapshot.insideCount;
  if (n <= 0n) throw new CoreModelError('invalid_quote', 'No Misfit is in the vault, so r = A / n is undefined');
  if (quantity <= 0n) throw new CoreModelError('invalid_quote', 'Quantity must be positive');
  const A = subAmounts(snapshot.totalSupply, snapshot.escrowFit);
  return amountOf(snapshot.fit, mulDiv(A.raw, quantity, n, action === 'withdraw' ? 'ceil' : 'floor'));
}

function feeActionOf(action: ConversionAction, selection: WithdrawSelection | null): ConversionFeeAction | null {
  if (action === 'return') return 'return';
  return selection;
}

/** The fee line for a principal under the fee policy (rounded as the policy says). */
export function feeLineFor(principal: Amount, action: ConversionFeeAction, feePolicy: FeePolicy): QuoteFee {
  const fee = conversionFeeFor(feePolicy, action);
  const raw = mulDiv(principal.raw, BigInt(fee.ratePpm), BigInt(PPM), feePolicy.conversion.rounding);
  return Object.freeze({ action, amount: amountOf(principal.asset, raw), destination: 'burn', policy: policyRef(feePolicy) });
}

export interface QuoteRequest {
  readonly action: ConversionAction;
  readonly selection?: WithdrawSelection;
  readonly snapshot: VaultSnapshot;
  readonly quantity: bigint;
  readonly tokenIds?: readonly NftTokenId[];
  readonly nowSeconds: number;
  /** Defaults to the quote policy's maximum window. */
  readonly ttlSeconds?: number;
}

/** Builds an exact quote (limit = principal ± fees, no extra tolerance). Validate with `quoteIssues` before use. */
export function buildQuote(request: QuoteRequest, context: QuoteContext): ConversionQuote {
  const selection = request.action === 'withdraw' ? (request.selection ?? 'draw') : null;
  const principal = principalFor(request.snapshot, request.action, request.quantity);
  const feeAction = feeActionOf(request.action, selection);
  const fees = feeAction === null ? [] : [feeLineFor(principal, feeAction, context.feePolicy)];
  const total = fees.reduce((sum, fee) => addAmounts(sum, fee.amount), amountOf(principal.asset, 0n));
  const limit = request.action === 'withdraw' ? addAmounts(principal, total) : subAmounts(principal, total);
  return Object.freeze({
    action: request.action,
    selection,
    snapshot: request.snapshot,
    quantity: request.quantity,
    tokenIds: Object.freeze([...(request.tokenIds ?? [])]),
    principal,
    fees: Object.freeze(fees),
    limit,
    quotePolicy: policyRef(context.quotePolicy),
    feePolicy: policyRef(context.feePolicy),
    quotedAt: request.nowSeconds,
    expiresAt: request.nowSeconds + (request.ttlSeconds ?? context.quotePolicy.maxQuoteTtlSeconds),
  });
}

type Add = (path: (string | number)[], message: string) => void;

function bindingIssues(quote: ConversionQuote, context: QuoteContext, add: Add): void {
  if (!samePolicyRef(quote.quotePolicy, policyRef(context.quotePolicy))) add(['quotePolicy'], 'quoted under another quote policy');
  if (!samePolicyRef(quote.feePolicy, policyRef(context.feePolicy))) add(['feePolicy'], 'quoted under another fee policy');
  if (!samePolicyRef(quote.snapshot.vaultPolicy, policyRef(context.vaultPolicy))) add(['snapshot', 'vaultPolicy'], 'the snapshot is under another vault policy');
  for (const issue of snapshotIssues(quote.snapshot)) add(['snapshot', ...issue.path], issue.message);
  if (!meetsFinality(quote.snapshot.at.finality, context.quotePolicy.minFinality)) {
    add(['snapshot', 'at', 'finality'], `the snapshot block must be at least ${context.quotePolicy.minFinality}`);
  }
}

function timeIssues(quote: ConversionQuote, context: QuoteContext, add: Add): void {
  const { quotedAt, expiresAt } = quote;
  const now = context.nowSeconds;
  if (!Number.isSafeInteger(quotedAt) || quotedAt > now) add(['quotedAt'], 'the quote time must be a past or present unix second');
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) add(['expiresAt'], 'the quote has expired');
  else if (expiresAt <= quotedAt || expiresAt - quotedAt > context.quotePolicy.maxQuoteTtlSeconds) {
    add(['expiresAt'], `the deadline must be within ${context.quotePolicy.maxQuoteTtlSeconds} s of the quote`);
  }
}

function quantityIssues(quote: ConversionQuote, context: QuoteContext, add: Add): void {
  const { quantity, snapshot, tokenIds } = quote;
  const n = snapshot.insideCount;
  const m = snapshot.collectionCount - n;
  if (quantity < 1n || quantity > BigInt(context.quotePolicy.maxQuantityPerCall)) {
    add(['quantity'], `quantity must be 1 to ${context.quotePolicy.maxQuantityPerCall}`);
  }
  if (new Set(tokenIds).size !== tokenIds.length) add(['tokenIds'], 'token IDs must be unique');
  if (quote.action === 'withdraw') {
    if (quote.selection === null) add(['selection'], 'a withdrawal is a draw or a named pick');
    if (quantity > n) add(['quantity'], 'more Misfits than the vault holds');
    else if (context.vaultPolicy.emptyVault === 'BLOCK_LAST_WITHDRAWAL' && quantity >= n) add(['quantity'], 'the last Misfit cannot leave the vault (F23 C2)');
    if (quote.selection === 'draw' && tokenIds.length > 0) add(['tokenIds'], 'a draw names no token IDs');
    if (quote.selection === 'named_pick' && BigInt(tokenIds.length) !== quantity) add(['tokenIds'], 'a named pick names exactly one ID per Misfit');
  } else {
    if (quote.selection !== null) add(['selection'], 'a return has no selection');
    if (quantity > m) add(['quantity'], 'more Misfits than are outside the vault');
    if (BigInt(tokenIds.length) !== quantity) add(['tokenIds'], 'a return names exactly one ID per Misfit');
  }
}

/** Expected principal, or null when the snapshot cannot price this quote (reported elsewhere). */
function expectedPrincipal(quote: ConversionQuote): bigint | null {
  try {
    return principalFor(quote.snapshot, quote.action, quote.quantity).raw;
  } catch {
    return null;
  }
}

function amountIssues(quote: ConversionQuote, context: QuoteContext, add: Add): void {
  const { snapshot, principal, fees, limit } = quote;
  const fit = snapshot.fit;
  const expected = expectedPrincipal(quote);
  if (!sameAsset(principal.asset, fit)) add(['principal'], `the principal must be ${fit.id}`);
  else if (expected === null) add(['principal'], 'this snapshot cannot price the quote (no Misfit inside, or E above S)');
  else if (expected !== principal.raw) add(['principal'], 'the principal does not match (S − E) × k / n at the snapshot');
  const feeAction = feeActionOf(quote.action, quote.selection);
  if (feeAction !== null) {
    if (fees.length !== 1 || fees[0]?.action !== feeAction) add(['fees'], `exactly one ${feeAction} fee line`);
  }
  let feeTotal = 0n;
  fees.forEach((fee, index) => {
    if (!sameAsset(fee.amount.asset, fit)) add(['fees', index, 'amount'], `fees are paid in ${fit.id}`);
    if (fee.destination !== 'burn') add(['fees', index, 'destination'], 'conversion fees are burned');
    if (!samePolicyRef(fee.policy, quote.feePolicy)) add(['fees', index, 'policy'], 'the fee line names another fee policy');
    if (sameAsset(principal.asset, fit) && fee.action === feeAction && fee.amount.raw !== feeLineFor(principal, feeAction, context.feePolicy).amount.raw) {
      add(['fees', index, 'amount'], 'the fee does not match the fee policy');
    }
    feeTotal += fee.amount.raw;
  });
  if (!sameAsset(limit.asset, fit)) {
    add(['limit'], `the limit must be ${fit.id}`);
  } else if (quote.action === 'withdraw') {
    if (limit.raw < principal.raw + feeTotal) add(['limit'], 'the max-spend limit must cover principal plus fees');
  } else if (feeTotal > principal.raw || limit.raw > principal.raw - feeTotal) {
    add(['limit'], 'the min-receive limit must not exceed principal minus fees');
  }
}

/** Every problem with a quote against the given policies and clock, in a stable order. Empty = usable. */
export function quoteIssues(quote: ConversionQuote, context: QuoteContext): GuardIssue[] {
  const issues: GuardIssue[] = [];
  const add: Add = (path, message) => {
    issues.push({ path, message });
  };
  bindingIssues(quote, context, add);
  timeIssues(quote, context, add);
  quantityIssues(quote, context, add);
  amountIssues(quote, context, add);
  return issues;
}

/** Throws `CoreModelError('invalid_quote')` naming every problem. */
export function assertQuoteUsable(quote: ConversionQuote, context: QuoteContext): void {
  const issues = quoteIssues(quote, context);
  if (issues.length > 0) {
    throw new CoreModelError('invalid_quote', `Quote rejected: ${issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  }
}
