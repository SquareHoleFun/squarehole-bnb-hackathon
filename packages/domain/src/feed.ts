/**
 * Feed selection: an exact port of reference/feed_model.py `select()` plus the ADR-0003 lifecycle and rewardSide
 * filters. Items must already be validated (see schemas.ts); metrics are compared as exact decimals.
 *
 * Ordering: non-null metric first -> metric desc -> launchedAt desc -> canonical pairId asc ("new" skips the
 * metric). The platform item is returned separately and never appears in `rows` (FEED-01).
 */
import { compareDecimal, parseDecimal, type ScaledDecimal } from './amounts';
import { FeedDataError, FeedQueryError } from './errors';
import { canonicalPairId } from './ids';
import { caseFold, matchNormalized, normalizeSearch } from './search';
import { parseIsoTimestamp } from './time';
import type { AssetKind, FeedSort, Lifecycle, PairRecord, RewardSide } from './types';

export const FEED_SORTS: readonly FeedSort[] = ['market_cap', 'new', 'turnover'];

/** The selection part of `FeedQuery` (a full `FeedQuery` is accepted). Omitted fields take reference defaults. */
export interface FeedSelectionQuery {
  search?: string;
  sort?: FeedSort;
  type?: 'all' | AssetKind;
  lifecycle?: 'all' | Lifecycle;
  rewardSide?: RewardSide;
  /** Selected payout asset (T when R=T, Q when R=Q), compared case-insensitively. Empty string = no filter. */
  rewardAddress?: string;
}

/** Defaults applied and text normalised; also the basis of the cursor query fingerprint. */
export interface NormalizedFeedQuery {
  search: string;
  sort: FeedSort;
  type: 'all' | AssetKind;
  lifecycle: 'all' | Lifecycle;
  rewardSide: RewardSide | null;
  rewardAddress: string | null;
}

export interface FeedSelection {
  platform: PairRecord | null;
  /** Whether the pinned platform itself satisfies the search and filters (ADR-0003). */
  platformMatchesQuery: boolean;
  rows: PairRecord[];
}

export function normalizeFeedQuery(query: FeedSelectionQuery = {}): NormalizedFeedQuery {
  const sort = query.sort ?? 'market_cap';
  if (!FEED_SORTS.includes(sort)) throw new FeedQueryError('unknown_sort', 'Sort must be market_cap, new or turnover');
  return {
    search: normalizeSearch(query.search ?? ''),
    sort,
    type: query.type ?? 'all',
    lifecycle: query.lifecycle ?? 'all',
    rewardSide: query.rewardSide ?? null,
    rewardAddress: query.rewardAddress ? caseFold(query.rewardAddress) : null,
  };
}

/** Search + filters, platform flag ignored (used for organic rows and for `platformMatchesQuery`). */
function matchesQuery(pair: PairRecord, q: NormalizedFeedQuery): boolean {
  if (q.type !== 'all' && pair.type !== q.type) return false;
  if (q.lifecycle !== 'all' && pair.lifecycle !== q.lifecycle) return false;
  if (q.search !== '' && matchNormalized(pair, q.search) === null) return false;
  if (q.rewardSide !== null && pair.rewardSide !== q.rewardSide) return false;
  if (q.rewardAddress !== null) {
    const selectedReward = pair.rewardSide === 'T' ? pair.token.address : pair.quote.address;
    if (caseFold(selectedReward) !== q.rewardAddress) return false;
  }
  return true;
}

interface Keyed {
  pair: PairRecord;
  metric: ScaledDecimal | null;
  launchedMs: number;
  idKey: string;
}

function metricOf(pair: PairRecord, sort: FeedSort): ScaledDecimal | null {
  if (sort === 'new') return null;
  const value = sort === 'market_cap' ? pair.marketCapUsd : pair.turnover24hUsd;
  return value === null ? null : parseDecimal(value);
}

function compareKeyed(sort: FeedSort) {
  return (a: Keyed, b: Keyed): number => {
    if (sort !== 'new') {
      if (a.metric === null && b.metric !== null) return 1;
      if (a.metric !== null && b.metric === null) return -1;
      if (a.metric !== null && b.metric !== null) {
        const byMetric = compareDecimal(b.metric, a.metric);
        if (byMetric !== 0) return byMetric;
      }
    }
    if (a.launchedMs !== b.launchedMs) return a.launchedMs > b.launchedMs ? -1 : 1;
    return a.idKey < b.idKey ? -1 : a.idKey > b.idKey ? 1 : 0;
  };
}

/**
 * Throws `FeedQueryError('unknown_sort')`, `FeedDataError('duplicate_platform' | 'duplicate_pair')` (duplicates are
 * detected by canonical, case-insensitive pair id across all items, including filtered-out ones).
 */
export function selectFeed(items: readonly PairRecord[], query: FeedSelectionQuery = {}): FeedSelection {
  const q = normalizeFeedQuery(query);
  const roots = items.filter((pair) => pair.isPlatform);
  if (roots.length > 1) throw new FeedDataError('duplicate_platform', 'More than one platform item');
  const seen = new Set<string>();
  const keyed: Keyed[] = [];
  for (const pair of items) {
    const idKey = canonicalPairId(pair.pairId);
    if (seen.has(idKey)) throw new FeedDataError('duplicate_pair', 'Duplicate pair id');
    seen.add(idKey);
    if (pair.isPlatform || !matchesQuery(pair, q)) continue;
    keyed.push({ pair, metric: metricOf(pair, q.sort), launchedMs: parseIsoTimestamp(pair.launchedAt), idKey });
  }
  const platform = roots[0] ?? null;
  return {
    platform,
    platformMatchesQuery: platform !== null && matchesQuery(platform, q),
    rows: [...keyed].sort(compareKeyed(q.sort)).map((entry) => entry.pair),
  };
}
