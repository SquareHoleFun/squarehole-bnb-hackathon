/**
 * Runtime guards that JSON Schema (`feed.schema.json`) cannot express. They run after structural validation and
 * are intentionally STRICTER than the schema; the differential test (schema-differential.test.ts) lists each
 * case where ajv accepts and zod rejects.
 */
import { isRawAmount } from './amounts';
import { canonicalPairId, isAddress, isDemoChain, isPairId, parsePairId } from './ids';
import { isIsoTimestamp, parseIsoTimestamp } from './time';
import type { AssetIdentity, PairRecord } from './types';

/*
 * Guards are TOTAL: zod 4 still runs refinements after non-fatal nested issues (e.g. a failed regex), so a guard
 * may see malformed values. It skips them (the structural issue is already reported) and never throws.
 */
const rawOrNull = (value: unknown): bigint | null => (isRawAmount(value) ? BigInt(value) : null);
const timeOrNull = (value: unknown): number | null => (isIsoTimestamp(value) ? parseIsoTimestamp(value) : null);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

export type FeedMode = 'demo' | 'live';
export type IssuePath = readonly (string | number)[];
export interface GuardIssue {
  readonly path: IssuePath;
  readonly message: string;
}
export interface LocatedPair {
  readonly pair: PairRecord;
  readonly path: IssuePath;
}

/**
 * Demo data (FEED-09): the declared mode is demo, OR the record is on the local demo chain, OR its provenance says
 * mock/demo. Any one is enough, so a mislabelled "live" file on chain 31337 is still treated as demo.
 */
export function isDemoRecord(pair: Pick<PairRecord, 'chainId' | 'provenance'>, mode?: FeedMode): boolean {
  return mode === 'demo' || isDemoChain(pair.chainId) || pair.provenance.state === 'mock' || pair.provenance.coverage === 'demo';
}

/** Per-record guards: NFT mapping, supply ordering, chain consistency and the FEED-09 demo guard. */
export function pairRecordIssues(pair: PairRecord, mode?: FeedMode): GuardIssue[] {
  const candidate: unknown = pair;
  if (!isObject(candidate)) return [];
  const issues: GuardIssue[] = [];
  const add = (path: IssuePath, message: string): void => {
    issues.push({ path, message });
  };
  if (pair.type === 'nft_collection') {
    if (pair.mirrorAddress === undefined) add(['mirrorAddress'], 'nft_collection requires mirrorAddress');
    if (pair.nftUnitRaw === undefined) add(['nftUnitRaw'], 'nft_collection requires nftUnitRaw');
  }
  if (pair.nftUnitRaw !== undefined && rawOrNull(pair.nftUnitRaw) === 0n) {
    add(['nftUnitRaw'], 'nftUnitRaw must be greater than zero');
  }
  const circulating = rawOrNull(pair.circulatingSupplyRaw);
  const total = rawOrNull(pair.totalSupplyRaw);
  if (circulating !== null && total !== null && circulating > total) {
    add(['circulatingSupplyRaw'], 'circulatingSupplyRaw must not exceed totalSupplyRaw');
  }
  if (isPairId(pair.pairId) && parsePairId(pair.pairId).chainId !== pair.chainId) {
    add(['pairId'], 'pairId chain must equal chainId');
  }
  const token: unknown = pair.token;
  const quote: unknown = pair.quote;
  if (isObject(token) && token.chainId !== pair.chainId) add(['token', 'chainId'], 'token must be on the pair chain');
  if (isObject(quote) && quote.chainId !== pair.chainId) add(['quote', 'chainId'], 'quote must be on the pair chain');
  const provenance: unknown = pair.provenance;
  if (isObject(provenance) && isDemoRecord(pair, mode)) {
    if (isObject(token) && token.issuerStatus === 'verified') add(['token', 'issuerStatus'], 'demo data must not claim a verified issuer (FEED-09)');
    if (isObject(quote) && quote.issuerStatus === 'verified') add(['quote', 'issuerStatus'], 'demo data must not claim a verified issuer (FEED-09)');
    if (pair.routeState === 'available') add(['routeState'], 'demo data must not expose an available route (FEED-09)');
  }
  return issues;
}

/** Duplicate canonical pair ids (case-insensitive address). The second and later occurrences are reported. */
export function duplicatePairIssues(entries: readonly LocatedPair[]): GuardIssue[] {
  const seen = new Set<string>();
  const issues: GuardIssue[] = [];
  for (const { pair, path } of entries) {
    const candidate: unknown = pair;
    if (!isObject(candidate) || !isPairId(candidate.pairId)) continue;
    const key = canonicalPairId(candidate.pairId);
    if (seen.has(key)) issues.push({ path: [...path, 'pairId'], message: 'duplicate pairId (canonical, case-insensitive)' });
    seen.add(key);
  }
  return issues;
}

/** At most one platform item. The second and later platform items are reported. */
export function platformCountIssues(entries: readonly LocatedPair[]): GuardIssue[] {
  const platforms = entries.filter(({ pair }) => {
    const candidate: unknown = pair;
    return isObject(candidate) && candidate.isPlatform === true;
  });
  return platforms.slice(1).map(({ path }) => ({ path: [...path, 'isPlatform'], message: 'at most one platform item' }));
}

/** A snapshot cannot contain a launch after its own `asOf`. */
export function launchAfterAsOfIssues(entries: readonly LocatedPair[], asOf: string): GuardIssue[] {
  const asOfMs = timeOrNull(asOf);
  if (asOfMs === null) return [];
  return entries
    .filter(({ pair }) => {
      const candidate: unknown = pair;
      const launchedMs = isObject(candidate) ? timeOrNull(candidate.launchedAt) : null;
      return launchedMs !== null && launchedMs > asOfMs;
    })
    .map(({ path }) => ({ path: [...path, 'launchedAt'], message: 'launchedAt must not be after the snapshot asOf' }));
}

/** Reward filter options must be unique by chain + canonical address. */
export function duplicateAssetIssues(assets: readonly AssetIdentity[], basePath: IssuePath): GuardIssue[] {
  const seen = new Set<string>();
  const issues: GuardIssue[] = [];
  assets.forEach((asset, index) => {
    const candidate: unknown = asset;
    if (!isObject(candidate) || !isAddress(candidate.address)) return;
    const key = `${String(candidate.chainId)}:${candidate.address.toLowerCase()}`;
    if (seen.has(key)) issues.push({ path: [...basePath, index], message: 'duplicate asset identity' });
    seen.add(key);
  });
  return issues;
}
