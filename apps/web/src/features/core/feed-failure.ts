/**
 * XR2-ITEM-3D-V2 F2: when a feed that never answered is unreachable, the same for every feed a box link reads (core v1,
 * v2, the existing-NFTs add-on). react-query puts a query with no data back to pending, error cleared, each time a poll
 * starts (@tanstack/query-core 5.103.2 query.js `fetchState`), so a failure read off `isError` lasted only until the next
 * poll: the box page went back to "Reading the box…" and its Retry was gone for the poll's whole read. Here a feed with
 * no answer kept stays failed from its first spent read (the read and its retries) through every later poll, until an
 * answer comes (the polling still recovers it) or the page's Retry. Retry reads again without starting a second request:
 * a read already under way is joined (query.js `fetch` returns the running read for a query that has no data), and
 * `retries` records the failures each feed had seen then, so only a failure after it counts.
 */
import { hashKey, type Query, type QueryKey } from '@tanstack/react-query';

/** Per feed query (by its hash): how many failed reads it had when the page last pressed Retry. */
export type FeedRetries = ReadonlyMap<string, number>;
export const NO_RETRIES: FeedRetries = new Map();

/** A feed with no answer kept that has failed since the last Retry (none: since it was first read). */
export function failedSince(query: { readonly data: unknown; readonly errorUpdateCount: number }, key: QueryKey, retries: FeedRetries = NO_RETRIES): boolean {
  return query.data === undefined && query.errorUpdateCount > (retries.get(hashKey(key)) ?? 0);
}

/** The box page's feed queries (core v1, v2, the add-on), by the first part of their keys. */
export const FEED_QUERIES: ReadonlySet<string> = new Set(['core-feed', 'v2-feed', 'set-feed']);

/** A feed query that never answered and has failed: what the box page's Retry reads again. */
export const unansweredFeed = (query: Query): boolean => FEED_QUERIES.has(String(query.queryKey[0])) && query.state.data === undefined && query.state.errorUpdateCount > 0;
