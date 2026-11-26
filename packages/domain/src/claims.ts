/**
 * Accounts and claims contract validation (SH-014, SH-015; 03-FEED "Holder counts and rewards"; 05-ECONOMICS;
 * ECO-04/05/06/07).
 *
 * `earned`, `claimable`, `claimed`, `pendingHarvest`, the convertible estimate and `asOfBlock` are separate fields.
 * Identities enforced: earned = claimable + claimed; claimed = sum of settled history; a reverted attempt consumes
 * and pays nothing; `rewardSide` equals the pair's immutable reward side; the payout asset is Q for R=Q and T for R=T;
 * an R=T estimate is exactly floor(claimable x tPerQ) with the fixed draft minimum. Pending harvest is never added to
 * claimable. An R=T conversion is a claim-specific settlement of the whole earned entitlement: there is no user
 * amount, target or calldata anywhere in this contract.
 */
import { z } from 'zod';
import { AmountError } from './errors';
import { MAX_TOKEN_DECIMALS, isDecimalAmount, isRawAmount, parseDecimal } from './amounts';
import { sameAssetIdentity } from './asset-registry';
import type { GuardIssue, IssuePath } from './guards';
import { canonicalPairId, isAddress, isPairId, isZeroAddress, sameAddress } from './ids';
import { DEMO_CLAIM_TOLERANCE_BPS, minPayoutRaw } from './policy';
import { assetIdentitySchema, provenanceSchema, type SafeParseResult } from './schemas';
import { isIsoTimestamp, parseIsoTimestamp } from './time';
import type { AccountClaims, AccountPositions, AssetIdentity, ClaimView, DecimalAmount, PairRecord, Position } from './types';
import {
  addressField,
  decimalAmountField,
  isRecord,
  isoTimestampField,
  pairIdField,
  parseWith,
  rawAmountField,
  reportIssues,
  safeParseWith,
  textField,
} from './validation';

const rawOrNull = (value: unknown): bigint | null => (isRawAmount(value) ? BigInt(value) : null);
const timeOrNull = (value: unknown): number | null => (isIsoTimestamp(value) ? parseIsoTimestamp(value) : null);
const isAsset = (value: unknown): value is AssetIdentity =>
  isRecord(value) && typeof value.chainId === 'number' && typeof value.address === 'string' && typeof value.decimals === 'number';
const samePair = (a: unknown, b: string): boolean => isPairId(a) && canonicalPairId(a) === canonicalPairId(b);

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_TOKEN_DECIMALS) {
    throw new AmountError('invalid_decimals', `decimals must be an integer between 0 and ${MAX_TOKEN_DECIMALS}`);
  }
}

/** Whole NFT units and the remaining fraction of a balance (exact bigint division). */
export function splitWholeUnits(balanceRaw: bigint, unitRaw: bigint): { whole: bigint; fraction: bigint } {
  if (unitRaw <= 0n) throw new RangeError('unitRaw must be greater than zero');
  if (balanceRaw < 0n) throw new RangeError('balanceRaw must be non-negative');
  return { whole: balanceRaw / unitRaw, fraction: balanceRaw % unitRaw };
}

/**
 * floor(claimableQ x tPerQ) in raw T units, where `tPerQ` is T per Q in display units. Exact: no float at any step,
 * rounded down so an estimate never overstates the payout.
 */
export function estimatePayoutRaw(claimableQRaw: bigint, tPerQ: DecimalAmount, qDecimals: number, tDecimals: number): bigint {
  if (claimableQRaw < 0n) throw new RangeError('claimableQRaw must be non-negative');
  assertDecimals(qDecimals);
  assertDecimals(tDecimals);
  const rate = parseDecimal(tPerQ);
  return (claimableQRaw * rate.units * 10n ** BigInt(tDecimals)) / 10n ** BigInt(qDecimals + rate.scale);
}

// --- Position ---------------------------------------------------------------------------------------------------

const positionShape = z.strictObject({
  pairId: pairIdField,
  balanceRaw: rawAmountField,
  wholeNftCount: rawAmountField.nullable(),
  fractionalRaw: rawAmountField.nullable(),
  nftTokenIds: z.array(rawAmountField).max(10_000),
});

/** Checks a position against its pair. Total: tolerates partially malformed input. */
export function positionIssues(position: Position, pair: PairRecord): GuardIssue[] {
  const candidate: unknown = position;
  if (!isRecord(candidate)) return [];
  const issues: GuardIssue[] = [];
  const add = (path: IssuePath, message: string): void => {
    issues.push({ path, message });
  };
  if (!samePair(position.pairId, pair.pairId)) add(['pairId'], 'position must belong to this pair');
  const balance = rawOrNull(position.balanceRaw);
  const supply = rawOrNull(pair.totalSupplyRaw);
  if (balance === 0n) add(['balanceRaw'], 'positions list current holdings only (positive balances)');
  if (balance !== null && supply !== null && balance > supply) add(['balanceRaw'], 'a balance cannot exceed total supply');
  const ids: unknown = position.nftTokenIds;
  const idList = Array.isArray(ids) ? (ids as unknown[]) : [];
  if (pair.type === 'token') {
    if (position.wholeNftCount !== null) add(['wholeNftCount'], 'token positions have no NFT representation');
    if (position.fractionalRaw !== null) add(['fractionalRaw'], 'token positions have no NFT fraction');
    if (idList.length > 0) add(['nftTokenIds'], 'token positions hold no NFTs');
    return issues;
  }
  const unit = rawOrNull(pair.nftUnitRaw);
  if (balance !== null && unit !== null && unit > 0n) {
    const { whole, fraction } = splitWholeUnits(balance, unit);
    if (rawOrNull(position.wholeNftCount) !== whole) add(['wholeNftCount'], 'must equal floor(balance / NFT unit)');
    if (rawOrNull(position.fractionalRaw) !== fraction) add(['fractionalRaw'], 'must equal balance mod NFT unit');
    if (BigInt(idList.length) > whole) add(['nftTokenIds'], 'cannot hold more NFTs than whole units (no duplicate representation, ECO-06)');
  }
  const seen = new Set<string>();
  idList.forEach((id, index) => {
    if (!isRawAmount(id)) return;
    if (BigInt(id) === 0n) add(['nftTokenIds', index], 'NFT ids start at 1');
    if (seen.has(id)) add(['nftTokenIds', index], 'duplicate NFT id');
    seen.add(id);
  });
  return issues;
}

export const positionSchema: z.ZodType<Position> = positionShape;

export function safeParsePosition(input: unknown, pair: PairRecord): SafeParseResult<Position> {
  return safeParseWith(positionShape.superRefine((position, ctx) => reportIssues(ctx, positionIssues(position, pair))), input);
}

export function validatePosition(input: unknown, pair: PairRecord): Position {
  return parseWith(positionShape.superRefine((position, ctx) => reportIssues(ctx, positionIssues(position, pair))), input, 'position');
}

// --- ClaimView --------------------------------------------------------------------------------------------------

const estimateSchema = z.strictObject({
  payoutRaw: rawAmountField,
  tPerQ: decimalAmountField,
  source: z.enum(['demo_quote', 'v4_quoter_eth_call', 'converter_eth_call']),
  asOfBlock: rawAmountField,
  deadline: isoTimestampField,
  minPayoutRaw: rawAmountField,
  toleranceBps: z.number().int().min(0).max(10_000),
});

const historySchema = z.strictObject({
  at: isoTimestampField,
  block: rawAmountField,
  qConsumedRaw: rawAmountField,
  payoutRaw: rawAmountField,
  payoutAsset: assetIdentitySchema,
  outcome: z.enum(['settled', 'reverted']),
  reason: textField({ min: 1, max: 120, innerSpaces: true, newlines: false }).optional(),
});

const claimViewShape = z.strictObject({
  owner: addressField,
  pairId: pairIdField,
  rewardSide: z.enum(['T', 'Q']),
  earnedQRaw: rawAmountField,
  pendingHarvestQRaw: rawAmountField,
  estimatedPayoutRaw: rawAmountField.nullable(),
  payoutAsset: assetIdentitySchema,
  estimateAsOf: isoTimestampField.optional(),
  conversionAvailable: z.boolean(),
  directSourceFallbackAvailable: z.boolean(),
  provenance: provenanceSchema,
  claimableQRaw: rawAmountField,
  claimedQRaw: rawAmountField,
  convertibleEstimate: estimateSchema.nullable(),
  asOfBlock: rawAmountField,
  history: z.array(historySchema).max(1000),
  directSourceFallback: z
    .strictObject({ label: z.literal('emergency_direct_source_q'), payoutAsset: assetIdentitySchema, payoutRaw: rawAmountField })
    .nullable(),
});

function historyIssues(view: ClaimView): GuardIssue[] {
  const issues: GuardIssue[] = [];
  const history: unknown = view.history;
  if (!Array.isArray(history)) return issues;
  let settled = 0n;
  let previousAt: number | null = null;
  let previousBlock: bigint | null = null;
  view.history.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    const base: IssuePath = ['history', index];
    const at = timeOrNull(entry.at);
    const block = rawOrNull(entry.block);
    if (at !== null && previousAt !== null && at < previousAt) issues.push({ path: [...base, 'at'], message: 'history is oldest first' });
    if (block !== null && previousBlock !== null && block < previousBlock) issues.push({ path: [...base, 'block'], message: 'blocks must not go backwards' });
    if (at !== null) previousAt = at;
    if (block !== null) previousBlock = block;
    if (entry.outcome === 'settled') settled += rawOrNull(entry.qConsumedRaw) ?? 0n;
    if (entry.outcome === 'reverted') {
      if (rawOrNull(entry.qConsumedRaw) !== 0n) issues.push({ path: [...base, 'qConsumedRaw'], message: 'a reverted claim consumes no entitlement (ECO-07)' });
      if (rawOrNull(entry.payoutRaw) !== 0n) issues.push({ path: [...base, 'payoutRaw'], message: 'a reverted claim pays nothing' });
    }
  });
  const claimed = rawOrNull(view.claimedQRaw);
  if (claimed !== null && claimed !== settled) issues.push({ path: ['claimedQRaw'], message: 'claimed must equal the Q consumed by settled history' });
  return issues;
}

function estimateIssues(view: ClaimView): GuardIssue[] {
  const issues: GuardIssue[] = [];
  const estimate: unknown = view.convertibleEstimate;
  if (!isRecord(estimate)) {
    if (view.estimateAsOf !== undefined) issues.push({ path: ['estimateAsOf'], message: 'estimateAsOf is only set with a convertible estimate' });
    return issues;
  }
  if (view.conversionAvailable === false) issues.push({ path: ['convertibleEstimate'], message: 'no estimate while conversion is unavailable' });
  if (view.estimateAsOf === undefined) issues.push({ path: ['estimateAsOf'], message: 'an estimate states when it was made' });
  if (estimate.toleranceBps !== DEMO_CLAIM_TOLERANCE_BPS) {
    issues.push({ path: ['convertibleEstimate', 'toleranceBps'], message: `the draft demo tolerance is fixed at ${DEMO_CLAIM_TOLERANCE_BPS} bps (not user-editable)` });
  }
  const payout = rawOrNull(estimate.payoutRaw);
  if (payout !== null && rawOrNull(estimate.minPayoutRaw) !== minPayoutRaw(payout)) {
    issues.push({ path: ['convertibleEstimate', 'minPayoutRaw'], message: 'minimum must be floor(payout x (10000 - tolerance) / 10000)' });
  }
  const made = timeOrNull(view.estimateAsOf);
  const deadline = timeOrNull(estimate.deadline);
  if (made !== null && deadline !== null && deadline <= made) {
    issues.push({ path: ['convertibleEstimate', 'deadline'], message: 'the deadline must be after the estimate time' });
  }
  if (view.estimatedPayoutRaw !== estimate.payoutRaw) {
    issues.push({ path: ['estimatedPayoutRaw'], message: 'must equal the convertible estimate payout' });
  }
  return issues;
}

/** Context-free identities of a claim view. Total: tolerates partially malformed input. */
function claimInternalIssues(view: ClaimView): GuardIssue[] {
  const candidate: unknown = view;
  if (!isRecord(candidate)) return [];
  const issues: GuardIssue[] = [];
  const add = (path: IssuePath, message: string): void => {
    issues.push({ path, message });
  };
  if (isZeroAddress(view.owner)) add(['owner'], 'the zero address owns nothing');
  const earned = rawOrNull(view.earnedQRaw);
  const claimable = rawOrNull(view.claimableQRaw);
  const claimed = rawOrNull(view.claimedQRaw);
  if (earned !== null && claimable !== null && claimed !== null && earned !== claimable + claimed) {
    add(['earnedQRaw'], 'the credited total must equal claimable + claimed (pending harvest is never included)');
  }
  issues.push(...historyIssues(view));
  issues.push(...estimateIssues(view));
  const fallback: unknown = view.directSourceFallback;
  if (view.directSourceFallbackAvailable !== isRecord(fallback)) {
    add(['directSourceFallback'], 'the labelled fallback is present exactly when directSourceFallbackAvailable is true');
  }
  if (isRecord(fallback) && fallback.payoutRaw !== view.claimableQRaw) {
    add(['directSourceFallback', 'payoutRaw'], 'the emergency fallback pays exactly the claimable Q');
  }
  return issues;
}

export interface ClaimViewOptions {
  /** Read time; history must not be after it. */
  asOf: string;
}

/** Cross-checks against the pair (ECO-04 reward side, payout asset, exact estimate). Total. */
export function claimViewIssues(view: ClaimView, pair: PairRecord, options: ClaimViewOptions): GuardIssue[] {
  const candidate: unknown = view;
  if (!isRecord(candidate)) return [];
  const issues: GuardIssue[] = [];
  const add = (path: IssuePath, message: string): void => {
    issues.push({ path, message });
  };
  if (!samePair(view.pairId, pair.pairId)) add(['pairId'], 'claim must belong to this pair');
  if (view.rewardSide !== pair.rewardSide) add(['rewardSide'], 'must equal the pair’s fee-share side, immutable for the launch (ECO-04)');
  const expectedPayout = pair.rewardSide === 'Q' ? pair.quote : pair.token;
  if (isAsset(view.payoutAsset) && !sameAssetIdentity(view.payoutAsset, expectedPayout)) {
    add(['payoutAsset'], pair.rewardSide === 'Q' ? 'R=Q pays the quote asset' : 'R=T pays the pair token');
  }
  const fallback: unknown = view.directSourceFallback;
  if (pair.rewardSide === 'Q') {
    if (view.convertibleEstimate !== null) add(['convertibleEstimate'], 'R=Q claims need no conversion');
    if (view.conversionAvailable !== false) add(['conversionAvailable'], 'R=Q claims need no conversion');
    if (view.directSourceFallbackAvailable !== false) add(['directSourceFallbackAvailable'], 'the direct-Q fallback exists only for R=T');
    if (view.estimatedPayoutRaw !== view.claimableQRaw) add(['estimatedPayoutRaw'], 'R=Q payout equals claimable Q');
  } else {
    const estimate: unknown = view.convertibleEstimate;
    const claimable = rawOrNull(view.claimableQRaw);
    if (isRecord(estimate) && claimable !== null && isDecimalAmount(estimate.tPerQ)) {
      const expected = estimatePayoutRaw(claimable, estimate.tPerQ, pair.quote.decimals, pair.token.decimals);
      if (rawOrNull(estimate.payoutRaw) !== expected) {
        add(['convertibleEstimate', 'payoutRaw'], 'must equal floor(claimable Q x tPerQ) in T raw units');
      }
    }
    // Review notes (SH-015 part 2): a zero rate is not a quote, and an expired quote is not a current estimate. The
    // reader must drop the estimate at the deadline (conversion stays available) so the UI refreshes it.
    if (isRecord(estimate) && isDecimalAmount(estimate.tPerQ) && parseDecimal(estimate.tPerQ).units === 0n) {
      add(['convertibleEstimate', 'tPerQ'], 'a zero rate is not a quote');
    }
    const deadline = isRecord(estimate) ? timeOrNull(estimate.deadline) : null;
    const readAt = timeOrNull(options.asOf);
    if (deadline !== null && readAt !== null && deadline <= readAt) {
      add(['convertibleEstimate', 'deadline'], 'the quote expired before the read time; an expired quote is not an estimate');
    }
    if (!isRecord(estimate) && view.estimatedPayoutRaw !== null) add(['estimatedPayoutRaw'], 'no payout estimate without a current quote');
    if (isRecord(fallback) && isAsset(fallback.payoutAsset) && !sameAssetIdentity(fallback.payoutAsset, pair.quote)) {
      add(['directSourceFallback', 'payoutAsset'], 'the emergency fallback pays the credited Q directly');
    }
  }
  const launched = timeOrNull(pair.launchedAt);
  const asOf = timeOrNull(options.asOf);
  const history: unknown = view.history;
  if (Array.isArray(history)) {
    view.history.forEach((entry, index) => {
      if (!isRecord(entry)) return;
      const at = timeOrNull(entry.at);
      if (at !== null && launched !== null && asOf !== null && (at < launched || at > asOf)) {
        add(['history', index, 'at'], 'claim history lies between launch and the read time');
      }
      if (!isAsset(entry.payoutAsset)) return;
      const allowed =
        entry.outcome === 'settled' && pair.rewardSide === 'Q'
          ? sameAssetIdentity(entry.payoutAsset, pair.quote)
          : sameAssetIdentity(entry.payoutAsset, pair.token) || sameAssetIdentity(entry.payoutAsset, pair.quote);
      if (!allowed) add(['history', index, 'payoutAsset'], 'payouts are in the pair payout asset (or Q for the labelled R=T fallback)');
    });
  }
  return issues;
}

export const claimViewSchema: z.ZodType<ClaimView> = claimViewShape.superRefine((view, ctx) => {
  reportIssues(ctx, claimInternalIssues(view));
});

const claimSchemaFor = (pair: PairRecord, options: ClaimViewOptions) =>
  claimViewShape.superRefine((view, ctx) => {
    reportIssues(ctx, claimInternalIssues(view));
    reportIssues(ctx, claimViewIssues(view, pair, options));
  });

export function safeParseClaimView(input: unknown, pair: PairRecord, options: ClaimViewOptions): SafeParseResult<ClaimView> {
  return safeParseWith(claimSchemaFor(pair, options), input);
}

/** Throws `DataValidationError` listing every issue. */
export function validateClaimView(input: unknown, pair: PairRecord, options: ClaimViewOptions): ClaimView {
  return parseWith(claimSchemaFor(pair, options), input, 'claim view');
}

// --- account wrappers -------------------------------------------------------------------------------------------

type PairLookup = ReadonlyMap<string, PairRecord>;
const lookup = (pairs: PairLookup, pairId: unknown): PairRecord | undefined =>
  isPairId(pairId) ? (pairs.get(canonicalPairId(pairId)) ?? [...pairs.values()].find((pair) => samePair(pairId, pair.pairId))) : undefined;

/** Claims of one owner at one block: every claim valid against its pair, one claim per pair. */
export function validateAccountClaims(input: unknown, pairs: PairLookup, options: ClaimViewOptions): AccountClaims {
  const schema: z.ZodType<AccountClaims> = z
    .strictObject({ owner: addressField, asOfBlock: rawAmountField, claims: z.array(claimViewShape), provenance: provenanceSchema })
    .superRefine((wrapper, ctx) => {
      const seen = new Set<string>();
      wrapper.claims.forEach((claim, index) => {
        const base: IssuePath = ['claims', index];
        const pair = lookup(pairs, claim.pairId);
        if (!pair) {
          reportIssues(ctx, [{ path: [...base, 'pairId'], message: 'claim for an unknown pair' }]);
          return;
        }
        const key = canonicalPairId(pair.pairId);
        if (seen.has(key)) reportIssues(ctx, [{ path: [...base, 'pairId'], message: 'one claim per pair' }]);
        seen.add(key);
        if (isAddress(claim.owner) && isAddress(wrapper.owner) && !sameAddress(claim.owner, wrapper.owner)) {
          reportIssues(ctx, [{ path: [...base, 'owner'], message: 'every claim belongs to the account read' }]);
        }
        if (claim.asOfBlock !== wrapper.asOfBlock) reportIssues(ctx, [{ path: [...base, 'asOfBlock'], message: 'one read block for the whole account' }]);
        reportIssues(ctx, claimInternalIssues(claim), base);
        reportIssues(ctx, claimViewIssues(claim, pair, options), base);
      });
    });
  return parseWith(schema, input, 'account claims');
}

/** Positions of one owner at one block: every position valid against its pair, one position per pair. */
export function validateAccountPositions(input: unknown, pairs: PairLookup): AccountPositions {
  const schema: z.ZodType<AccountPositions> = z
    .strictObject({ owner: addressField, asOfBlock: rawAmountField, positions: z.array(positionShape), provenance: provenanceSchema })
    .superRefine((wrapper, ctx) => {
      const seen = new Set<string>();
      wrapper.positions.forEach((position, index) => {
        const base: IssuePath = ['positions', index];
        const pair = lookup(pairs, position.pairId);
        if (!pair) {
          reportIssues(ctx, [{ path: [...base, 'pairId'], message: 'position in an unknown pair' }]);
          return;
        }
        const key = canonicalPairId(pair.pairId);
        if (seen.has(key)) reportIssues(ctx, [{ path: [...base, 'pairId'], message: 'one position per pair (economic units are shown once)' }]);
        seen.add(key);
        reportIssues(ctx, positionIssues(position, pair), base);
      });
    });
  return parseWith(schema, input, 'account positions');
}
