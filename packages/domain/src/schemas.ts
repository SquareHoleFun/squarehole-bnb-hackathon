/**
 * Runtime validation (zod 4.6.5). `feedFixtureSchema` mirrors square-hole-handoff/schemas/feed.schema.json for the
 * fixture FILE; `createFeedSnapshotSchema` mirrors `FeedSnapshot` in types.ts. Both add the guards in guards.ts.
 * Values are never rewritten: addresses keep their source case (ADR-0003), only the static types narrow.
 */
import { z } from 'zod';
import { DECIMAL_AMOUNT_PATTERN, MAX_TOKEN_DECIMALS, RAW_AMOUNT_PATTERN } from './amounts';
import { FeedValidationError, type ValidationIssue } from './errors';
import {
  duplicateAssetIssues,
  duplicatePairIssues,
  launchAfterAsOfIssues,
  pairRecordIssues,
  platformCountIssues,
  type FeedMode,
  type GuardIssue,
  type LocatedPair,
} from './guards';
import { isAddress, isPairId } from './ids';
import { isIsoTimestamp } from './time';
import type { Address, FeedSnapshot, PairId, PairRecord, TxHash } from './types';

/** The fixture file format (`feed.schema.json`). Not part of types.ts: it is a data-at-rest format. */
export interface FeedFixture {
  schemaVersion: '1.0';
  snapshotId: string;
  mode: FeedMode;
  chainId: number;
  asOf: string;
  items: PairRecord[];
}

/** JSON Schema `maxLength` counts code points, not UTF-16 units. */
const codePoints = (value: string): number => [...value].length;
const boundedText = (min: number, max: number) =>
  z.string().refine((value) => codePoints(value) >= min && codePoints(value) <= max, `must be ${min}-${max} characters`);

const address = z.string().refine(isAddress, 'must be a 0x-prefixed 20-byte hex address').transform((value) => value as Address);
const txHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte hex hash').transform((value) => value as TxHash);
const pairId = z
  .string()
  .refine(isPairId, 'must be "<chainId>:<0x address>" with a positive chain id')
  .transform((value) => value as PairId);
const rawAmount = z.string().regex(RAW_AMOUNT_PATTERN, 'must be an unsigned decimal integer string');
const decimalAmount = z.string().regex(DECIMAL_AMOUNT_PATTERN, 'must be a non-negative decimal string');
const isoTimestamp = z.string().refine(isIsoTimestamp, 'must be YYYY-MM-DDTHH:MM:SS[.mmm] with Z or ±HH:MM');
const chainId = z.number().int().min(1);

export const assetIdentitySchema = z.strictObject({
  chainId,
  address,
  symbol: boundedText(1, 32),
  decimals: z.number().int().min(0).max(MAX_TOKEN_DECIMALS),
  issuerStatus: z.enum(['mock', 'verified', 'unverified']),
  underlyingAddress: address.optional(),
  wrapperVersion: z.string().optional(),
});

export const provenanceSchema = z.strictObject({
  state: z.enum(['mock', 'fresh', 'stale', 'partial', 'unavailable']),
  asOf: isoTimestamp,
  blockNumber: rawAmount.optional(),
  blockHash: txHash.optional(),
  source: z.string(),
  coverage: z.enum(['demo', 'canonical_markets', 'partial', 'declared_venues']),
});

/** Structure only; collection validators run the guards with their declared mode. */
const pairRecordShape = z.strictObject({
  pairId,
  chainId,
  slug: z.string().optional(),
  name: boundedText(1, 64),
  symbol: boundedText(0, 32),
  type: z.enum(['token', 'nft_collection']),
  isPlatform: z.boolean(),
  launchedAt: isoTimestamp,
  lifecycle: z.enum(['curve', 'graduating', 'amm', 'unlaunched']),
  token: assetIdentitySchema,
  quote: assetIdentitySchema,
  mirrorAddress: address.optional(),
  nftUnitRaw: rawAmount.optional(),
  rewardSide: z.enum(['T', 'Q']),
  totalSupplyRaw: rawAmount,
  circulatingSupplyRaw: rawAmount.nullable(),
  burnedRaw: rawAmount,
  priceUsd: decimalAmount.nullable(),
  marketCapUsd: decimalAmount.nullable(),
  turnover24hUsd: decimalAmount.nullable(),
  holders: z.number().int().min(0).nullable(),
  routeState: z.enum(['unverified', 'available', 'unavailable']),
  provenance: provenanceSchema,
});

function report(ctx: z.RefinementCtx, issues: readonly GuardIssue[], prefix: readonly (string | number)[] = []): void {
  for (const issue of issues) ctx.addIssue({ code: 'custom', message: issue.message, path: [...prefix, ...issue.path] });
}

export const pairRecordSchema: z.ZodType<PairRecord> = pairRecordShape.superRefine((pair, ctx) => {
  report(ctx, pairRecordIssues(pair));
});

export const feedFixtureSchema: z.ZodType<FeedFixture> = z
  .strictObject({
    schemaVersion: z.literal('1.0'),
    snapshotId: z.string(),
    mode: z.enum(['demo', 'live']),
    chainId,
    asOf: isoTimestamp,
    items: z.array(pairRecordShape),
  })
  .superRefine((file, ctx) => {
    const entries: LocatedPair[] = file.items.map((pair, index) => ({ pair, path: ['items', index] }));
    for (const { pair, path } of entries) {
      report(ctx, pairRecordIssues(pair, file.mode), path);
      if (pair.chainId !== file.chainId) report(ctx, [{ path: [...path, 'chainId'], message: 'item chain must equal the file chainId' }]);
    }
    report(ctx, duplicatePairIssues(entries));
    report(ctx, platformCountIssues(entries));
    report(ctx, launchAfterAsOfIssues(entries, file.asOf));
  });

/** `FeedSnapshot` validator. `mode` is declared by the provider; demo guards also trigger by chain/provenance. */
export function createFeedSnapshotSchema(options: { mode: FeedMode }): z.ZodType<FeedSnapshot> {
  return z
    .strictObject({
      snapshotId: z.string().min(1),
      platform: pairRecordShape.nullable(),
      platformMatchesQuery: z.boolean(),
      items: z.array(pairRecordShape),
      nextCursor: z.string().min(1).nullable(),
      totalMatches: z.number().int().min(0),
      rewardAssets: z.array(assetIdentitySchema),
      provenance: provenanceSchema,
    })
    .superRefine((snapshot, ctx) => {
      const items: LocatedPair[] = snapshot.items.map((pair, index) => ({ pair, path: ['items', index] }));
      const entries: LocatedPair[] = snapshot.platform ? [{ pair: snapshot.platform, path: ['platform'] }, ...items] : items;
      for (const { pair, path } of entries) report(ctx, pairRecordIssues(pair, options.mode), path);
      if (snapshot.platform && !snapshot.platform.isPlatform) {
        report(ctx, [{ path: ['platform', 'isPlatform'], message: 'the pinned record must be the platform item' }]);
      }
      for (const { pair, path } of items) {
        if (pair.isPlatform) report(ctx, [{ path: [...path, 'isPlatform'], message: 'the platform item must stay outside organic items (FEED-01)' }]);
      }
      if (snapshot.platform === null && snapshot.platformMatchesQuery) {
        report(ctx, [{ path: ['platformMatchesQuery'], message: 'no platform item can match' }]);
      }
      if (snapshot.totalMatches < snapshot.items.length) {
        report(ctx, [{ path: ['totalMatches'], message: 'totalMatches must be at least the page size' }]);
      }
      report(ctx, duplicatePairIssues(entries));
      report(ctx, duplicateAssetIssues(snapshot.rewardAssets, ['rewardAssets']));
      report(ctx, launchAfterAsOfIssues(entries, snapshot.provenance.asOf));
    });
}

function toIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message }));
}

export type SafeParseResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };

export function safeParseFeedFixture(input: unknown): SafeParseResult<FeedFixture> {
  const result = feedFixtureSchema.safeParse(input);
  return result.success ? { ok: true, value: result.data } : { ok: false, issues: toIssues(result.error) };
}

/** Throws `FeedValidationError` listing every issue. */
export function parseFeedFixture(input: unknown): FeedFixture {
  const result = safeParseFeedFixture(input);
  if (!result.ok) throw new FeedValidationError('feed fixture', result.issues);
  return result.value;
}

export function validatePairRecord(input: unknown): PairRecord {
  const result = pairRecordSchema.safeParse(input);
  if (!result.success) throw new FeedValidationError('pair record', toIssues(result.error));
  return result.data;
}

export function validateFeedSnapshot(input: unknown, options: { mode: FeedMode }): FeedSnapshot {
  const result = createFeedSnapshotSchema(options).safeParse(input);
  if (!result.success) throw new FeedValidationError('feed snapshot', toIssues(result.error));
  return result.data;
}
