/**
 * Pair detail contract validation (SH-012; 01-PRODUCT "Pair detail"; 05-ECONOMICS "Burn mechanics"; FEED-07/10).
 *
 * `pairDetailSchema` checks structure plus context-free invariants. `safeParsePairDetail(input, pair, { asOf })`
 * adds the cross-checks against the pair's feed record: supply identities, NFT mapping, history window, reward
 * assets and demo labelling. Supply concepts stay separate: current supply, derived initial cap, fee-burned T,
 * whole-unit CAPACITY and the observed active NFT count (never derived) are distinct fields.
 */
import { z } from 'zod';
import { compareDecimal, isDecimalAmount, isRawAmount } from './amounts';
import { sameAssetIdentity } from './asset-registry';
import { isDemoRecord, type FeedMode, type GuardIssue, type IssuePath } from './guards';
import { canonicalPairId, isPairId, sameAddress } from './ids';
import { feeTermsIssues } from './policy';
import { assetIdentitySchema, provenanceSchema, type FeedFixture, type SafeParseResult } from './schemas';
import { isIsoTimestamp, parseIsoTimestamp } from './time';
import type { AssetIdentity, FeeTerms, PairActivity, PairDetail, PairRecord, RawAmount } from './types';
import {
  addressField,
  chainIdField,
  decimalAmountField,
  isRecord,
  isoTimestampField,
  pairIdField,
  parseWith,
  rawAmountField,
  reportIssues,
  safeParseWith,
  textField,
  txHashField,
} from './validation';

const ART_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const artIdField = z.string().max(64).regex(ART_ID, 'must be a lowercase kebab-case art id');

const rawOrNull = (value: unknown): bigint | null => (isRawAmount(value) ? BigInt(value) : null);
const timeOrNull = (value: unknown): number | null => (isIsoTimestamp(value) ? parseIsoTimestamp(value) : null);
const isAsset = (value: unknown): value is AssetIdentity =>
  isRecord(value) && typeof value.chainId === 'number' && typeof value.address === 'string' && typeof value.decimals === 'number';

/** floor(current / unit): the maximum number of whole NFT units the current supply could back. */
export function wholeUnitCapacity(currentRaw: RawAmount, unitRaw: RawAmount): RawAmount {
  const unit = BigInt(unitRaw);
  if (unit <= 0n) throw new RangeError('unitRaw must be greater than zero');
  return (BigInt(currentRaw) / unit).toString();
}

const feeTermsSchema = z.strictObject({
  policyId: z.literal('BURN_NATIVE_T_ROUTE_Q_V1'),
  status: z.enum(['draft', 'approved']),
  headlineFeeTargetBps: z.number().int().min(0).max(10_000),
  qProtocolShare: z.strictObject({ num: z.number().int().min(0), den: z.number().int().min(1) }),
});

const supplySchema = z.strictObject({
  currentRaw: rawAmountField,
  initialCapRaw: rawAmountField,
  initialCapBasis: z.enum(['demo_derived_total_plus_burned', 'onchain_initial_supply']),
  feeBurnedRaw: rawAmountField,
  wholeUnitCapacity: z.strictObject({ count: rawAmountField, basis: z.literal('floor_current_supply_over_unit') }).nullable(),
  activeNftCount: z.number().int().min(0).nullable(),
  circulatingRaw: rawAmountField.nullable(),
  exclusionBasis: z.enum(['demo_fixture_declared', 'ledger_eligible_supply', 'unavailable']),
});

const nftSchema = z.strictObject({
  mirrorAddress: addressField,
  unitRaw: rawAmountField,
  gallery: z
    .array(
      z.strictObject({
        tokenId: rawAmountField,
        artId: artIdField.nullable(),
        name: textField({ min: 1, max: 64, innerSpaces: true, newlines: false }),
        attributes: z
          .array(
            z.strictObject({
              trait: textField({ min: 1, max: 32, innerSpaces: true, newlines: false }),
              value: textField({ min: 1, max: 64, innerSpaces: true, newlines: false }),
            }),
          )
          .max(32),
      }),
    )
    .max(200),
});

const priceHistorySchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('unavailable'), reason: z.enum(['demo_no_history', 'unpriced', 'not_indexed']) }),
  z.strictObject({
    state: z.literal('observed'),
    unit: z.literal('usd_per_t'),
    points: z.array(z.strictObject({ t: isoTimestampField, priceUsd: decimalAmountField.nullable() })).min(1).max(2000),
  }),
]);

const activityAmountSchema = z.strictObject({ asset: assetIdentitySchema, amountRaw: rawAmountField });

const pairDetailShape = z.strictObject({
  pairId: pairIdField,
  description: textField({ min: 0, max: 500, innerSpaces: true, newlines: true }),
  artwork: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('ok'), artId: artIdField }),
    z.strictObject({ state: z.literal('unavailable'), reason: z.enum(['not_uploaded', 'failed_validation', 'not_loaded']) }),
  ]),
  canonicalStatus: z.enum(['demo_not_deployed', 'unverified', 'approved_factory']),
  showcase: z.boolean(),
  supply: supplySchema,
  nft: nftSchema.optional(),
  priceHistory: priceHistorySchema,
  rewards: z.array(z.strictObject({ asset: assetIdentitySchema, paidRaw: rawAmountField.nullable(), accruedRaw: rawAmountField.nullable() })).max(4),
  activity: z
    .array(
      z.strictObject({
        kind: z.enum(['launch', 'burn', 'claim', 'swap_observation']),
        at: isoTimestampField,
        block: rawAmountField,
        txHash: txHashField.nullable(),
        amounts: z.array(activityAmountSchema).max(8),
      }),
    )
    .max(1000),
  feeTerms: feeTermsSchema,
  provenance: provenanceSchema,
});

// --- context-free invariants ------------------------------------------------------------------------------------

function supplyIssues(supply: PairDetail['supply']): GuardIssue[] {
  const issues: GuardIssue[] = [];
  const add = (field: string, message: string): void => {
    issues.push({ path: ['supply', field], message });
  };
  const current = rawOrNull(supply.currentRaw);
  const initial = rawOrNull(supply.initialCapRaw);
  const burned = rawOrNull(supply.feeBurnedRaw);
  const circulating = rawOrNull(supply.circulatingRaw);
  if (supply.initialCapBasis === 'demo_derived_total_plus_burned' && current !== null && initial !== null && burned !== null && initial !== current + burned) {
    add('initialCapRaw', 'a demo-derived initial cap must equal current + fee-burned supply');
  }
  if (initial !== null && burned !== null && burned > initial) add('feeBurnedRaw', 'fee-burned T cannot exceed the initial cap');
  if (current !== null && initial !== null && current > initial) add('currentRaw', 'current supply cannot exceed the initial cap');
  if (current !== null && circulating !== null && circulating > current) add('circulatingRaw', 'circulating supply cannot exceed current supply');
  if ((supply.circulatingRaw === null) !== (supply.exclusionBasis === 'unavailable')) {
    add('exclusionBasis', "the exclusion basis is 'unavailable' exactly when circulating supply is unknown");
  }
  const capacity: unknown = supply.wholeUnitCapacity;
  const count = isRecord(capacity) ? rawOrNull(capacity.count) : null;
  if (count !== null && typeof supply.activeNftCount === 'number' && BigInt(supply.activeNftCount) > count) {
    add('activeNftCount', 'active NFTs cannot exceed the whole-unit capacity');
  }
  return issues;
}

function galleryIssues(nft: NonNullable<PairDetail['nft']>): GuardIssue[] {
  const issues: GuardIssue[] = [];
  const seen = new Set<string>();
  const gallery: unknown = nft.gallery;
  if (!Array.isArray(gallery)) return issues;
  nft.gallery.forEach((item, index) => {
    if (!isRecord(item)) return;
    const base: IssuePath = ['nft', 'gallery', index];
    if (isRawAmount(item.tokenId)) {
      if (BigInt(item.tokenId) === 0n) issues.push({ path: [...base, 'tokenId'], message: 'NFT ids start at 1' });
      if (seen.has(item.tokenId)) issues.push({ path: [...base, 'tokenId'], message: 'duplicate NFT id in the gallery' });
      seen.add(item.tokenId);
    }
    const traits = new Set<string>();
    const attributes: unknown = item.attributes;
    if (!Array.isArray(attributes)) return;
    item.attributes.forEach((attribute, attributeIndex) => {
      if (!isRecord(attribute) || typeof attribute.trait !== 'string') return;
      const key = attribute.trait.toLowerCase();
      if (traits.has(key)) issues.push({ path: [...base, 'attributes', attributeIndex, 'trait'], message: 'duplicate trait' });
      traits.add(key);
    });
  });
  return issues;
}

function historyIssues(history: PairDetail['priceHistory']): GuardIssue[] {
  if (history.state !== 'observed' || !Array.isArray(history.points)) return [];
  const issues: GuardIssue[] = [];
  let previous: number | null = null;
  history.points.forEach((point, index) => {
    const at = isRecord(point) ? timeOrNull(point.t) : null;
    if (at !== null && previous !== null && at <= previous) {
      issues.push({ path: ['priceHistory', 'points', index, 't'], message: 'points must be strictly ascending in time' });
    }
    if (at !== null) previous = at;
  });
  if (history.points.length > 0 && history.points.every((point) => isRecord(point) && point.priceUsd === null)) {
    issues.push({ path: ['priceHistory', 'points'], message: "a series with no observed price is 'unavailable', not observed" });
  }
  return issues;
}

const assetKey = (asset: unknown): string | null =>
  isAsset(asset) ? `${asset.chainId}:${asset.address.toLowerCase()}` : null;

function rewardIssues(rewards: PairDetail['rewards']): GuardIssue[] {
  const issues: GuardIssue[] = [];
  const seen = new Set<string>();
  rewards.forEach((row, index) => {
    const key = isRecord(row) ? assetKey(row.asset) : null;
    if (key === null) return;
    if (seen.has(key)) issues.push({ path: ['rewards', index, 'asset'], message: 'one row per asset; rows are never summed across assets' });
    seen.add(key);
  });
  return issues;
}

function activityIssues(activity: readonly PairActivity[]): GuardIssue[] {
  const issues: GuardIssue[] = [];
  let previousAt: number | null = null;
  let previousBlock: bigint | null = null;
  activity.forEach((row, index) => {
    if (!isRecord(row)) return;
    const at = timeOrNull(row.at);
    const block = rawOrNull(row.block);
    if (at !== null && previousAt !== null && at < previousAt) issues.push({ path: ['activity', index, 'at'], message: 'activity must be oldest first' });
    if (block !== null && previousBlock !== null && block < previousBlock) issues.push({ path: ['activity', index, 'block'], message: 'blocks must not go backwards' });
    if (row.kind === 'launch' && index !== 0) issues.push({ path: ['activity', index, 'kind'], message: 'the launch is the first and only launch row' });
    if (at !== null) previousAt = at;
    if (block !== null) previousBlock = block;
  });
  return issues;
}

function internalIssues(detail: PairDetail): GuardIssue[] {
  const candidate: unknown = detail;
  if (!isRecord(candidate)) return [];
  return [
    ...(isRecord(candidate.supply) ? supplyIssues(detail.supply) : []),
    ...(isRecord(candidate.nft) ? galleryIssues(detail.nft as NonNullable<PairDetail['nft']>) : []),
    ...(isRecord(candidate.priceHistory) ? historyIssues(detail.priceHistory) : []),
    ...(Array.isArray(candidate.rewards) ? rewardIssues(detail.rewards) : []),
    ...(Array.isArray(candidate.activity) ? activityIssues(detail.activity) : []),
    ...(isRecord(candidate.feeTerms) ? feeTermsIssues(detail.feeTerms as FeeTerms, ['feeTerms']) : []),
  ];
}

// --- cross-checks against the pair record -------------------------------------------------------------------------

export interface PairDetailOptions {
  /** Snapshot time; history and activity must not be after it. */
  asOf: string;
  mode?: FeedMode;
}

function nftCrossIssues(detail: PairDetail, pair: PairRecord): GuardIssue[] {
  const issues: GuardIssue[] = [];
  const nft: unknown = detail.nft;
  const capacity: unknown = detail.supply.wholeUnitCapacity;
  if (pair.type === 'token') {
    if (nft !== undefined) issues.push({ path: ['nft'], message: 'token pairs have no NFT mirror' });
    if (capacity !== null) issues.push({ path: ['supply', 'wholeUnitCapacity'], message: 'token pairs have no whole-unit capacity' });
    if (detail.supply.activeNftCount !== null) issues.push({ path: ['supply', 'activeNftCount'], message: 'token pairs have no NFTs' });
    return issues;
  }
  if (!isRecord(nft)) issues.push({ path: ['nft'], message: 'nft_collection pairs describe their NFT mirror' });
  else {
    if (typeof nft.mirrorAddress !== 'string' || pair.mirrorAddress === undefined || !sameAddress(nft.mirrorAddress, pair.mirrorAddress)) {
      issues.push({ path: ['nft', 'mirrorAddress'], message: 'must equal the pair mirror address' });
    }
    if (nft.unitRaw !== pair.nftUnitRaw) issues.push({ path: ['nft', 'unitRaw'], message: 'must equal the pair NFT unit' });
  }
  const unit = rawOrNull(pair.nftUnitRaw);
  const current = rawOrNull(detail.supply.currentRaw);
  if (!isRecord(capacity)) {
    issues.push({ path: ['supply', 'wholeUnitCapacity'], message: 'nft_collection pairs state their whole-unit capacity' });
  } else if (unit !== null && unit > 0n && current !== null && rawOrNull(capacity.count) !== current / unit) {
    issues.push({ path: ['supply', 'wholeUnitCapacity', 'count'], message: 'capacity must equal floor(current supply / NFT unit)' });
  }
  return issues;
}

function historyCrossIssues(detail: PairDetail, pair: PairRecord, launched: number, asOf: number): GuardIssue[] {
  const history: unknown = detail.priceHistory;
  if (!isRecord(history) || history.state !== 'observed' || !Array.isArray(history.points)) return [];
  const issues: GuardIssue[] = [];
  const points = history.points as unknown[];
  points.forEach((point, index) => {
    const at = isRecord(point) ? timeOrNull(point.t) : null;
    if (at !== null && (at < launched || at > asOf)) {
      issues.push({ path: ['priceHistory', 'points', index, 't'], message: 'observations only exist between launch and asOf (no fabricated history)' });
    }
  });
  const last = points.at(-1);
  if (isRecord(last) && timeOrNull(last.t) === asOf) {
    const matches =
      last.priceUsd === null || pair.priceUsd === null
        ? last.priceUsd === pair.priceUsd
        : isDecimalAmount(last.priceUsd) && compareDecimal(last.priceUsd, pair.priceUsd) === 0;
    if (!matches) issues.push({ path: ['priceHistory', 'points', points.length - 1, 'priceUsd'], message: 'the observation at asOf must equal the feed price' });
  }
  return issues;
}

function rewardCrossIssues(detail: PairDetail, pair: PairRecord): GuardIssue[] {
  const issues: GuardIssue[] = [];
  detail.rewards.forEach((row, index) => {
    if (!isRecord(row) || !isAsset(row.asset)) return;
    const isToken = sameAssetIdentity(row.asset, pair.token);
    const isQuote = sameAssetIdentity(row.asset, pair.quote);
    if (!isToken && !isQuote) issues.push({ path: ['rewards', index, 'asset'], message: 'fee-share rows are in the pair T or Q only' });
    if (isToken && pair.rewardSide === 'Q') issues.push({ path: ['rewards', index, 'asset'], message: 'an R=Q pair pays no fee share in T' });
    if (isToken && pair.rewardSide === 'T' && row.accruedRaw !== null) {
      issues.push({ path: ['rewards', index, 'accruedRaw'], message: 'a credited amount is a Q entitlement until claimed; a credited T amount is not defined' });
    }
  });
  return issues;
}

function activityCrossIssues(detail: PairDetail, pair: PairRecord, launched: number, asOf: number, demo: boolean): GuardIssue[] {
  const issues: GuardIssue[] = [];
  let burned = 0n;
  detail.activity.forEach((row, index) => {
    if (!isRecord(row)) return;
    const base: IssuePath = ['activity', index];
    const at = timeOrNull(row.at);
    if (at !== null && (at < launched || at > asOf)) issues.push({ path: [...base, 'at'], message: 'activity must lie between launch and asOf' });
    if (row.kind === 'launch' && at !== null && at !== launched) issues.push({ path: [...base, 'at'], message: 'the launch row is at launchedAt' });
    if (demo && row.txHash !== null) issues.push({ path: [...base, 'txHash'], message: 'demo activity has no transaction hash (no fake explorer links)' });
    if (!Array.isArray(row.amounts)) return;
    (row.amounts as unknown[]).forEach((amount, amountIndex) => {
      if (!isRecord(amount) || !isAsset(amount.asset)) return;
      const isToken = sameAssetIdentity(amount.asset, pair.token);
      if (!isToken && !sameAssetIdentity(amount.asset, pair.quote)) {
        issues.push({ path: [...base, 'amounts', amountIndex, 'asset'], message: 'activity amounts are in the pair T or Q' });
      } else if (row.kind === 'burn' && !isToken) {
        issues.push({ path: [...base, 'amounts', amountIndex, 'asset'], message: 'only native fee-origin T is burned; Q is never burned' });
      } else if (row.kind === 'burn') {
        burned += rawOrNull(amount.amountRaw) ?? 0n;
      }
    });
  });
  const feeBurned = rawOrNull(detail.supply.feeBurnedRaw);
  if (feeBurned !== null && burned > feeBurned) issues.push({ path: ['activity'], message: 'burn rows exceed the fee-burned supply' });
  return issues;
}

/** Cross-checks a structurally valid detail against its pair record. Total: tolerates malformed input. */
export function pairDetailIssues(detail: PairDetail, pair: PairRecord, options: PairDetailOptions): GuardIssue[] {
  const candidate: unknown = detail;
  if (!isRecord(candidate) || !isRecord(candidate.supply)) return [];
  const issues: GuardIssue[] = [];
  const add = (path: IssuePath, message: string): void => {
    issues.push({ path, message });
  };
  if (!isPairId(detail.pairId) || canonicalPairId(detail.pairId) !== canonicalPairId(pair.pairId)) add(['pairId'], 'detail must describe this pair');
  const { supply } = detail;
  if (supply.currentRaw !== pair.totalSupplyRaw) add(['supply', 'currentRaw'], 'must equal the feed totalSupplyRaw (current post-burn supply)');
  if (supply.feeBurnedRaw !== pair.burnedRaw) add(['supply', 'feeBurnedRaw'], 'must equal the feed burnedRaw');
  if (supply.circulatingRaw !== pair.circulatingSupplyRaw) add(['supply', 'circulatingRaw'], 'must equal the feed circulatingSupplyRaw');
  const demo = isDemoRecord(pair, options.mode);
  if (demo) {
    if (supply.initialCapBasis !== 'demo_derived_total_plus_burned') add(['supply', 'initialCapBasis'], 'demo data labels its initial cap as derived');
    if (detail.canonicalStatus !== 'demo_not_deployed') add(['canonicalStatus'], 'demo records are demo_not_deployed (C14, FEED-09)');
  }
  issues.push(...nftCrossIssues(detail, pair));
  const launched = timeOrNull(pair.launchedAt);
  const asOf = timeOrNull(options.asOf);
  if (launched !== null && asOf !== null) {
    issues.push(...historyCrossIssues(detail, pair, launched, asOf));
    if (Array.isArray(candidate.activity)) issues.push(...activityCrossIssues(detail, pair, launched, asOf, demo));
  }
  if (Array.isArray(candidate.rewards)) issues.push(...rewardCrossIssues(detail, pair));
  return issues;
}

/** Structure + context-free invariants (no pair record needed). */
export const pairDetailSchema: z.ZodType<PairDetail> = pairDetailShape.superRefine((detail, ctx) => {
  reportIssues(ctx, internalIssues(detail));
});

function schemaFor(pair: PairRecord, options: PairDetailOptions): z.ZodType<PairDetail> {
  return pairDetailShape.superRefine((detail, ctx) => {
    reportIssues(ctx, internalIssues(detail));
    reportIssues(ctx, pairDetailIssues(detail, pair, options));
  });
}

export function safeParsePairDetail(input: unknown, pair: PairRecord, options: PairDetailOptions): SafeParseResult<PairDetail> {
  return safeParseWith(schemaFor(pair, options), input);
}

/** Throws `DataValidationError` listing every issue. */
export function validatePairDetail(input: unknown, pair: PairRecord, options: PairDetailOptions): PairDetail {
  return parseWith(schemaFor(pair, options), input, 'pair detail');
}

// --- fixture file -------------------------------------------------------------------------------------------------

/** Data-at-rest format of packages/providers/src/fixtures/pair-details.json. */
export interface PairDetailsFixture {
  schemaVersion: '1.0';
  mode: 'demo';
  chainId: number;
  asOf: string;
  /** The feed snapshot these details belong to. */
  feedSnapshotId: string;
  details: PairDetail[];
}

/** Validates the file and every detail against its record in `feed` (unknown and duplicate pair ids rejected). */
export function parsePairDetailsFixture(input: unknown, feed: FeedFixture): PairDetailsFixture {
  const records = new Map(feed.items.map((pair) => [canonicalPairId(pair.pairId), pair]));
  const schema: z.ZodType<PairDetailsFixture> = z
    .strictObject({
      schemaVersion: z.literal('1.0'),
      mode: z.literal('demo'),
      chainId: chainIdField,
      asOf: isoTimestampField,
      feedSnapshotId: z.string().min(1),
      details: z.array(pairDetailShape),
    })
    .superRefine((file, ctx) => {
      const add = (path: IssuePath, message: string): void => reportIssues(ctx, [{ path, message }]);
      if (file.chainId !== feed.chainId) add(['chainId'], 'must equal the feed chainId');
      if (file.asOf !== feed.asOf) add(['asOf'], 'must equal the feed snapshot asOf');
      if (file.feedSnapshotId !== feed.snapshotId) add(['feedSnapshotId'], 'must name the feed snapshot');
      const seen = new Set<string>();
      file.details.forEach((detail, index) => {
        if (!isPairId(detail.pairId)) return;
        const key = canonicalPairId(detail.pairId);
        const pair = records.get(key);
        if (seen.has(key)) add(['details', index, 'pairId'], 'duplicate pair detail');
        seen.add(key);
        if (!pair) {
          add(['details', index, 'pairId'], 'every detail must describe a pair in the feed fixture');
          return;
        }
        reportIssues(ctx, internalIssues(detail), ['details', index]);
        reportIssues(ctx, pairDetailIssues(detail, pair, { asOf: feed.asOf, mode: feed.mode }), ['details', index]);
      });
    });
  return parseWith(schema, input, 'pair details fixture');
}
