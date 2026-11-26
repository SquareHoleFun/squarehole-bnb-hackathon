/**
 * Deterministic mock scenarios, all derived from the single bundled fixture. Every derived snapshot is re-validated
 * with the domain fixture validator (including the FEED-09 demo guard) before it is served.
 */
import {
  decimalToString,
  formatIsoUtc,
  parseDecimal,
  parseFeedFixture,
  parseIsoTimestamp,
  parseRawAmount,
  selectFeed,
  type AssetIdentity,
  type DecimalAmount,
  type FeedFixture,
  type PairRecord,
  type Provenance,
  type RawAmount,
} from '@squarehole/domain';

export const MOCK_SCENARIOS = [
  'default',
  'loading',
  'stale',
  'partial',
  'unavailable',
  'no_launches',
  'root_unlaunched',
  'ranking_updated',
] as const;
export type MockScenario = (typeof MOCK_SCENARIOS)[number];

export const MOCK_SOURCE = 'Square Hole mock feed provider: deterministic demo fixture, not market data';
const STALE_AGE_MS = 2 * 60 * 60 * 1000;
/** Illustrative local-chain block for the stale scenario; not a real block. */
const STALE_BLOCK_NUMBER = '4200';
const RANKING_UPDATE_AFTER_MS = 5 * 60 * 1000;

export interface ScenarioSnapshot {
  readonly snapshotId: string;
  readonly asOf: string;
  /** Platform (if launched) and organic records, in fixture order. */
  readonly records: readonly PairRecord[];
  readonly provenance: Provenance;
  readonly rewardAssets: readonly AssetIdentity[];
}

export interface ScenarioData {
  readonly initial: ScenarioSnapshot;
  /** `ranking_updated` only: the newer snapshot published after the first read. */
  readonly next: ScenarioSnapshot | null;
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Distinct Q identities paid by R=Q organic pairs (by chain + canonical address), sorted by symbol then address. */
function rewardAssetsOf(records: readonly PairRecord[]): AssetIdentity[] {
  const byKey = new Map<string, AssetIdentity>();
  for (const pair of records) {
    if (pair.isPlatform || pair.rewardSide !== 'Q') continue;
    const key = `${pair.quote.chainId}:${pair.quote.address.toLowerCase()}`;
    if (!byKey.has(key)) byKey.set(key, pair.quote);
  }
  return [...byKey.values()].sort((a, b) =>
    a.symbol === b.symbol ? (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1) : a.symbol < b.symbol ? -1 : 1,
  );
}

interface SnapshotSpec {
  snapshotId: string;
  asOf: string;
  records: readonly PairRecord[];
  provenance: Omit<Provenance, 'asOf' | 'source'>;
}

function snapshotOf(fixture: FeedFixture, spec: SnapshotSpec): ScenarioSnapshot {
  const validated = parseFeedFixture({
    schemaVersion: '1.0',
    snapshotId: spec.snapshotId,
    mode: 'demo',
    chainId: fixture.chainId,
    asOf: spec.asOf,
    items: spec.records,
  });
  return deepFreeze({
    snapshotId: spec.snapshotId,
    asOf: spec.asOf,
    records: validated.items,
    provenance: { ...spec.provenance, asOf: spec.asOf, source: MOCK_SOURCE },
    rewardAssets: rewardAssetsOf(validated.items),
  });
}

/** Exact terminating price = cap x 10^decimals / circulating; throws if the fixture would need rounding. */
function exactPrice(capUsd: DecimalAmount, circulatingRaw: RawAmount, decimals: number): DecimalAmount {
  const cap = parseDecimal(capUsd);
  const divisor = parseRawAmount(circulatingRaw) * 10n ** BigInt(cap.scale);
  for (let scale = 0; scale <= 36; scale += 1) {
    const numerator = cap.units * 10n ** BigInt(decimals + scale);
    if (numerator % divisor === 0n) return decimalToString({ units: numerator / divisor, scale });
  }
  throw new Error('ranking_updated: swapped market cap has no exact terminating price');
}

/** Swaps the market caps of the top two organic rows and re-derives their prices exactly. */
function swapTopTwoMarketCaps(records: readonly PairRecord[]): PairRecord[] {
  const [first, second] = selectFeed(records).rows;
  if (!first?.marketCapUsd || !second?.marketCapUsd || !first.circulatingSupplyRaw || !second.circulatingSupplyRaw) {
    throw new Error('ranking_updated needs two priced organic pairs');
  }
  const patched = new Map<string, PairRecord>([
    [first.pairId, { ...first, marketCapUsd: second.marketCapUsd, priceUsd: exactPrice(second.marketCapUsd, first.circulatingSupplyRaw, first.token.decimals) }],
    [second.pairId, { ...second, marketCapUsd: first.marketCapUsd, priceUsd: exactPrice(first.marketCapUsd, second.circulatingSupplyRaw, second.token.decimals) }],
  ]);
  return records.map((pair) => patched.get(pair.pairId) ?? pair);
}

const withProvenance = (records: readonly PairRecord[], patch: Partial<Provenance>): PairRecord[] =>
  records.map((pair) => ({ ...pair, provenance: { ...pair.provenance, ...patch } }));

export function buildScenario(fixture: FeedFixture, scenario: MockScenario): ScenarioData {
  const base = snapshotOf(fixture, {
    snapshotId: fixture.snapshotId,
    asOf: fixture.asOf,
    records: fixture.items,
    provenance: { state: 'mock', coverage: 'demo' },
  });
  const derived = (suffix: string, records: readonly PairRecord[], provenance: SnapshotSpec['provenance'], asOf = fixture.asOf) =>
    snapshotOf(fixture, { snapshotId: `${fixture.snapshotId}-${suffix}`, asOf, records, provenance });

  switch (scenario) {
    case 'default':
    case 'loading':
    case 'unavailable':
      return { initial: base, next: null };
    case 'stale': {
      const asOf = formatIsoUtc(parseIsoTimestamp(fixture.asOf) - STALE_AGE_MS);
      const asOfMs = parseIsoTimestamp(asOf);
      // A snapshot taken at `asOf` cannot know launches that happened after it.
      const known = fixture.items.filter((pair) => parseIsoTimestamp(pair.launchedAt) <= asOfMs);
      const records = withProvenance(known, { state: 'stale', asOf, blockNumber: STALE_BLOCK_NUMBER });
      return { initial: derived('stale', records, { state: 'stale', coverage: 'demo', blockNumber: STALE_BLOCK_NUMBER }, asOf), next: null };
    }
    case 'partial': {
      // Curve-stage turnover is not indexed in this scenario: unknown (null), never zero (FEED-06).
      const records = fixture.items.map((pair) =>
        !pair.isPlatform && pair.lifecycle === 'curve'
          ? { ...pair, turnover24hUsd: null, provenance: { ...pair.provenance, state: 'partial' as const, coverage: 'partial' as const } }
          : pair,
      );
      return { initial: derived('partial', records, { state: 'partial', coverage: 'partial' }), next: null };
    }
    case 'no_launches':
      return { initial: derived('no-launches', fixture.items.filter((pair) => pair.isPlatform), { state: 'mock', coverage: 'demo' }), next: null };
    case 'root_unlaunched':
      return { initial: derived('root-unlaunched', fixture.items.filter((pair) => !pair.isPlatform), { state: 'mock', coverage: 'demo' }), next: null };
    case 'ranking_updated': {
      const asOf = formatIsoUtc(parseIsoTimestamp(fixture.asOf) + RANKING_UPDATE_AFTER_MS);
      const records = withProvenance(swapTopTwoMarketCaps(fixture.items), { asOf });
      return { initial: base, next: derived('r2', records, { state: 'mock', coverage: 'demo' }, asOf) };
    }
  }
}
