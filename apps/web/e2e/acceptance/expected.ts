/**
 * Independent expectation oracle for the M1 feed acceptance tests.
 *
 * Everything here is derived from the handoff fixture (`square-hole-handoff/fixtures/feed.json`, served byte-for-byte
 * by the mock provider) and the written rules in 03-FEED-AND-DATA / ADR-0003 / SH-004. It deliberately does NOT import
 * `@squarehole/domain` (selectFeed, matchSearch, formatters): the acceptance suite must be able to catch a bug in those
 * helpers too. Money is compared as exact scaled bigints, never as JavaScript numbers.
 *
 * The literal orders in `VERIFIED_ORDERS` were cross-checked once against `square-hole-handoff/reference/feed_model.py`
 * (see README.md); `oracle.spec.ts` asserts that this module still reproduces them.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type AssetType = 'token' | 'nft_collection';
export type Lifecycle = 'curve' | 'graduating' | 'amm';
export type SortKey = 'market_cap' | 'new' | 'turnover';

export interface FixtureAsset {
  chainId: number;
  address: string;
  symbol: string;
  decimals: number;
  underlyingAddress?: string;
}

export interface FixturePair {
  pairId: string;
  chainId: number;
  name: string;
  symbol: string;
  type: AssetType;
  isPlatform: boolean;
  launchedAt: string;
  lifecycle: Lifecycle;
  token: FixtureAsset;
  quote: FixtureAsset;
  rewardSide: 'T' | 'Q';
  marketCapUsd: string | null;
  turnover24hUsd: string | null;
  mirrorAddress?: string;
}

export interface Fixture {
  snapshotId: string;
  chainId: number;
  asOf: string;
  items: FixturePair[];
}

const FIXTURE_PATH = fileURLToPath(new URL('../../../../square-hole-handoff/fixtures/feed.json', import.meta.url));

function loadFixture(): Fixture {
  const parsed: unknown = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  const fixture = parsed as Fixture;
  if (!fixture || !Array.isArray(fixture.items) || typeof fixture.asOf !== 'string') {
    throw new Error(`expected.ts: ${FIXTURE_PATH} is not a feed fixture`);
  }
  return fixture;
}

export const FIXTURE: Fixture = loadFixture();
export const CHAIN_ID = FIXTURE.chainId;
export const AS_OF = FIXTURE.asOf;

const platforms = FIXTURE.items.filter((pair) => pair.isPlatform);
if (platforms.length !== 1) throw new Error('expected.ts: the fixture must contain exactly one platform item');
export const PLATFORM: FixturePair = platforms[0] as FixturePair;
export const ORGANIC: readonly FixturePair[] = FIXTURE.items.filter((pair) => !pair.isPlatform);

/** Canonical identity used by `data-pair-id`: `${chainId}:${lowercase address}`. */
export const canonicalId = (pair: FixturePair): string => pair.pairId.toLowerCase();
export const pairAddress = (pair: FixturePair): string => (pair.pairId.split(':')[1] ?? '').toLowerCase();
/** The app's own detail route (ADR-0003): `/pair/<chainId>/<lowercase address>`. */
export const pairPath = (pair: FixturePair): string => `/pair/${pair.chainId}/${pairAddress(pair)}`;

export function byName(name: string): FixturePair {
  const found = FIXTURE.items.find((pair) => pair.name === name);
  if (!found) throw new Error(`expected.ts: no fixture pair named ${name}`);
  return found;
}

// ---------------------------------------------------------------------------------------------------------------
// Exact decimals and timestamps
// ---------------------------------------------------------------------------------------------------------------

interface Scaled {
  units: bigint;
  scale: number;
}

function parseDecimal(value: string): Scaled {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(value);
  if (!match) throw new Error(`expected.ts: not an unsigned decimal string: ${value}`);
  const fraction = match[2] ?? '';
  return { units: BigInt(`${match[1]}${fraction}`), scale: fraction.length };
}

/** Exact comparison of two unsigned decimal strings ("72000.00" equals "72000"). */
export function compareDecimal(a: string, b: string): number {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  const scale = Math.max(x.scale, y.scale);
  const left = x.units * 10n ** BigInt(scale - x.scale);
  const right = y.units * 10n ** BigInt(scale - y.scale);
  return left < right ? -1 : left > right ? 1 : 0;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
/** Millisecond timestamp of a fixture instant (bounded presentation value, not money). */
export function instant(value: string): number {
  if (!ISO_UTC.test(value)) throw new Error(`expected.ts: unexpected timestamp format ${value}`);
  return Date.parse(value);
}

// ---------------------------------------------------------------------------------------------------------------
// Query semantics (03-FEED "Feed contract", ADR-0003 filters)
// ---------------------------------------------------------------------------------------------------------------

export interface FeedQuery {
  sort?: SortKey;
  q?: string;
  type?: 'all' | AssetType;
  /** '' = any, 'T' = pays in its own token, otherwise a lowercase reward-asset address. */
  reward?: string;
  lifecycle?: '' | Lifecycle;
}

/** Address the holders of this pair are paid in: T when R=T, otherwise Q. */
export const rewardAddress = (pair: FixturePair): string =>
  (pair.rewardSide === 'T' ? pair.token.address : pair.quote.address).toLowerCase();
export const rewardSymbol = (pair: FixturePair): string => (pair.rewardSide === 'T' ? pair.token.symbol : pair.quote.symbol);

function searchable(pair: FixturePair): { text: string; addresses: Set<string> } {
  const addresses = [pair.token.address, pair.quote.address, pairAddress(pair)];
  if (pair.mirrorAddress) addresses.push(pair.mirrorAddress);
  // Name/symbol substring (the reference also joins them with one space); addresses must match exactly.
  return { text: `${pair.name} ${pair.symbol}`.toLowerCase(), addresses: new Set(addresses.map((a) => a.toLowerCase())) };
}

export function matchesQuery(pair: FixturePair, query: FeedQuery): boolean {
  const q = (query.q ?? '').trim().toLowerCase();
  if (q) {
    const { text, addresses } = searchable(pair);
    if (!text.includes(q) && !addresses.has(q)) return false;
  }
  if (query.type && query.type !== 'all' && pair.type !== query.type) return false;
  if (query.reward === 'T' && pair.rewardSide !== 'T') return false;
  if (query.reward && query.reward !== 'T' && rewardAddress(pair) !== query.reward.toLowerCase()) return false;
  if (query.lifecycle && pair.lifecycle !== query.lifecycle) return false;
  return true;
}

/** Deterministic order: metric desc (null last, never zero), then launch time desc, then canonical pairId asc. */
function compareForSort(sort: SortKey): (a: FixturePair, b: FixturePair) => number {
  const byLaunchThenId = (a: FixturePair, b: FixturePair): number => {
    const age = instant(b.launchedAt) - instant(a.launchedAt);
    if (age !== 0) return age;
    const ida = canonicalId(a);
    const idb = canonicalId(b);
    return ida < idb ? -1 : ida > idb ? 1 : 0;
  };
  if (sort === 'new') return byLaunchThenId;
  const field = sort === 'market_cap' ? 'marketCapUsd' : 'turnover24hUsd';
  return (a, b) => {
    const va = a[field];
    const vb = b[field];
    if (va === null && vb !== null) return 1;
    if (va !== null && vb === null) return -1;
    if (va !== null && vb !== null) {
      const metric = compareDecimal(vb, va);
      if (metric !== 0) return metric;
    }
    return byLaunchThenId(a, b);
  };
}

/** Expected organic row ids (canonical, lowercase) for a query, in display order. */
export function expectedIds(query: FeedQuery = {}, organic: readonly FixturePair[] = ORGANIC): string[] {
  return organic
    .filter((pair) => matchesQuery(pair, query))
    .sort(compareForSort(query.sort ?? 'market_cap'))
    .map(canonicalId);
}

/** Whether the pinned platform itself passes the search and every filter ("Not a search match" otherwise). */
export const platformMatches = (query: FeedQuery, platform: FixturePair | null = PLATFORM): boolean =>
  platform !== null && matchesQuery(platform, query);

export const countLabel = (n: number): string => (n === 1 ? '1 pair' : `${n} pairs`);

/** Reward filter options after the two fixed ones: distinct Q of organic R=Q pairs, by symbol then address. */
export function rewardAssetOptions(organic: readonly FixturePair[] = ORGANIC): { label: string; value: string }[] {
  const seen = new Map<string, string>();
  for (const pair of organic) {
    if (pair.rewardSide === 'Q') seen.set(pair.quote.address.toLowerCase(), pair.quote.symbol);
  }
  return [...seen.entries()]
    .map(([value, label]) => ({ label, value }))
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------------------------
// Mock scenarios (SH-004 evidence): deterministic transforms of the same fixture
// ---------------------------------------------------------------------------------------------------------------

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
export const STALE_AS_OF_MS = instant(AS_OF) - TWO_HOURS_MS;

/** `stale`: snapshot 2h before asOf; launches after that instant are unknown to it. */
export const STALE_ORGANIC: readonly FixturePair[] = ORGANIC.filter((pair) => instant(pair.launchedAt) <= STALE_AS_OF_MS);

/** `partial`: curve-stage turnover is not indexed, so it is unknown (null), never zero. */
export const PARTIAL_ORGANIC: readonly FixturePair[] = ORGANIC.map((pair) =>
  pair.lifecycle === 'curve' ? { ...pair, turnover24hUsd: null } : pair,
);

/** `ranking_updated` second snapshot: the market caps of the top two organic rows are swapped. */
export const UPDATED_ORGANIC: readonly FixturePair[] = (() => {
  const [first, second] = expectedIds({ sort: 'market_cap' });
  const one = ORGANIC.find((pair) => canonicalId(pair) === first);
  const two = ORGANIC.find((pair) => canonicalId(pair) === second);
  if (!one || !two) throw new Error('expected.ts: fixture needs two organic pairs');
  return ORGANIC.map((pair) => {
    if (pair === one) return { ...pair, marketCapUsd: two.marketCapUsd };
    if (pair === two) return { ...pair, marketCapUsd: one.marketCapUsd };
    return pair;
  });
})();

// ---------------------------------------------------------------------------------------------------------------
// Display expectations
// ---------------------------------------------------------------------------------------------------------------

/** Age relative to the injected snapshot "now": "<1m", "6m", "3h", "2d" (floored). */
export function expectedAge(launchedAt: string, now: string = AS_OF): string {
  const elapsed = instant(now) - instant(launchedAt);
  if (elapsed < 0) throw new Error('expected.ts: launch after now');
  const minute = 60_000;
  if (elapsed < minute) return '<1m';
  if (elapsed < 60 * minute) return `${Math.floor(elapsed / minute)}m`;
  if (elapsed < 24 * 60 * minute) return `${Math.floor(elapsed / (60 * minute))}h`;
  return `${Math.floor(elapsed / (24 * 60 * minute))}d`;
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const exactText = (text: string): RegExp => new RegExp(escapeRe(text));
export const startsWith = (text: string): RegExp => new RegExp(`^\\s*${escapeRe(text)}`);

const groupThousands = (value: bigint): string => value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * Renderings of a USD amount that are honest for this value: full ("$600,000", "$600,000.00") or compact with the
 * largest suffix and 0–2 truncated decimals ("$600K", "$84.2K", "$1K"). Never "$0" for a positive value.
 */
export function usdPattern(value: string): RegExp {
  const { units, scale } = parseDecimal(value);
  const one = 10n ** BigInt(scale);
  const whole = units / one;
  const cents = ((units * 100n) / one) % 100n;
  const centsText = cents.toString().padStart(2, '0');
  const alternatives: string[] = [];
  for (const integer of [groupThousands(whole), whole.toString()]) {
    alternatives.push(cents === 0n ? `${integer}(?:\\.00)?` : `${integer}\\.${centsText}`);
  }
  for (const [exponent, suffix] of [[12n, 'T'], [9n, 'B'], [6n, 'M'], [3n, 'K']] as const) {
    const unit = 10n ** exponent;
    if (whole < unit) continue;
    const hundredths = (units * 100n) / (one * unit);
    const integer = hundredths / 100n;
    const digits = (hundredths % 100n).toString().padStart(2, '0');
    alternatives.push(`${integer}(?:\\.${digits[0]}(?:${digits[1]})?)?${suffix}`);
    break;
  }
  return new RegExp(`\\$(?:${alternatives.join('|')})(?![\\d.,])`);
}

/** A fake zero price/cap/turnover: "$0" not followed by more digits or decimals. */
export const FAKE_ZERO_USD = /\$0(?![\d.,])/;

export const TYPE_LABEL: Record<AssetType, string> = { token: 'Token', nft_collection: 'NFT collection' };

/** Every address in the fixture (tokens, quotes, underlyings, mirrors, pair ids), lowercase, without duplicates. */
export const FIXTURE_ADDRESSES: readonly string[] = [
  ...new Set(
    FIXTURE.items.flatMap((pair) =>
      [pair.token.address, pair.quote.address, pair.quote.underlyingAddress, pair.mirrorAddress, pairAddress(pair)]
        .filter((a): a is string => typeof a === 'string')
        .map((a) => a.toLowerCase()),
    ),
  ),
];

/** Address with its hex digits upper-cased (the `0x` prefix stays lowercase), for mixed-case search input. */
export const shout = (address: string): string => `0x${address.slice(2).toUpperCase()}`;

/**
 * Orders cross-checked with `python3` against `square-hole-handoff/reference/feed_model.py` (see README.md), written as
 * pair-id suffixes. `oracle.spec.ts` asserts that `expectedIds` still reproduces them.
 */
export const VERIFIED_ORDERS = {
  marketCap: ['66', '67', '68', '69', '6a', '6b', '6c', '6d', '6e', '6f', '70'],
  new: ['70', '6f', '6e', '6d', '6b', '6c', '6a', '69', '68', '67', '66'],
  turnover: ['67', '66', '6a', '68', '69', '6b', '6c', '6e', '6d', '6f', '70'],
  partialTurnover: ['67', '66', '6a', '68', '69', '70', '6f', '6e', '6d', '6b', '6c'],
  staleMarketCap: ['66', '67', '68', '69', '6a', '6b', '6c', '6d'],
  updatedMarketCap: ['67', '66', '68', '69', '6a', '6b', '6c', '6d', '6e', '6f', '70'],
} as const;

/** `31337:0x…0066` from the suffix `66`. */
export const idFromSuffix = (suffix: string): string => `${CHAIN_ID}:0x${suffix.padStart(40, '0')}`;
