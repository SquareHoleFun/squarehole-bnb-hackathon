/**
 * Which feed state to render (SH-007). Pure functions so every state is unit-tested without a browser.
 * A failed read is never an empty feed or a zero-valued market (06-ARCHITECTURE, FEED-06).
 */
import type { FeedSort, PairRecord, Provenance, SnapshotHead } from '@squarehole/domain';

export type ResultsKind = 'loading' | 'unavailable' | 'no_launches' | 'no_match' | 'results';

export interface ResultsInput {
  /** A snapshot page is available (possibly from an earlier query while the next one loads). */
  readonly hasData: boolean;
  readonly isError: boolean;
  /** Organic matches for the query (platform excluded, FEED-01). */
  readonly totalMatches: number;
  /** A search or filter is narrowing the organic set. */
  readonly filtersActive: boolean;
}

export function selectResultsKind({ hasData, isError, totalMatches, filtersActive }: ResultsInput): ResultsKind {
  if (!hasData) return isError ? 'unavailable' : 'loading';
  if (totalMatches > 0) return 'results';
  return filtersActive ? 'no_match' : 'no_launches';
}

/**
 * Whether the rows on screen may be shown as results. A previous query's rows (placeholder data) stay while the next
 * read runs, but if that read failed they must not stand in for it: the feed is then unavailable, with a retry.
 */
export function hasUsableData({ hasData, current, isError }: { hasData: boolean; current: boolean; isError: boolean }): boolean {
  return current || (hasData && !isError);
}

export type PinKind = 'loading' | 'unavailable' | 'unlaunched' | 'launched';

export function selectPinKind({ hasData, isError, platform }: { hasData: boolean; isError: boolean; platform: PairRecord | null }): PinKind {
  if (!hasData) return isError ? 'unavailable' : 'loading';
  // ADR-0003: `platform === null` in a served snapshot means the root asset has not launched.
  return platform === null ? 'unlaunched' : 'launched';
}

/**
 * The order the rows are really in (SH-C review). A USD sort (market cap, 24h turnover) puts unavailable figures last
 * and breaks ties by launch time, newest first. On a chain source without a USD figure on any row (no USD source is
 * adopted for test chains, ADR-0012), that is simply launch order: the page must say so, and mark the Age column, never
 * claim a USD ranking it does not have. The demo fixtures always carry their own figures and keep the chosen sort.
 */
export function effectiveFeedSort(
  sort: FeedSort,
  rows: readonly Pick<PairRecord, 'marketCapUsd' | 'turnover24hUsd'>[],
  { chainSource }: { chainSource: boolean },
): { sort: FeedSort; usdUnavailable: boolean } {
  if (sort === 'new' || !chainSource) return { sort, usdUnavailable: false };
  const ranked = rows.some((row) => (sort === 'market_cap' ? row.marketCapUsd : row.turnover24hUsd) !== null);
  return ranked ? { sort, usdUnavailable: false } : { sort: 'new', usdUnavailable: true };
}

export interface FeedNotices {
  readonly stale: { readonly asOf: string; readonly blockNumber?: string } | null;
  readonly partial: boolean;
}

export function selectNotices(provenance: Provenance): FeedNotices {
  const stale =
    provenance.state === 'stale'
      ? provenance.blockNumber === undefined
        ? { asOf: provenance.asOf }
        : { asOf: provenance.asOf, blockNumber: provenance.blockNumber }
      : null;
  return { stale, partial: provenance.state === 'partial' || provenance.coverage === 'partial' };
}

/** 03-FEED: rows on screen never reorder by themselves; a newer snapshot is offered instead. */
export function updateAvailable(onScreen: string | null, head: SnapshotHead | undefined): boolean {
  return onScreen !== null && head !== undefined && head.snapshotId !== onScreen;
}
