/**
 * The one discovery search (02-DESIGN: "exactly one primary discovery search"). Its only state is the feed URL's
 * `q` parameter (see features/feed/feed-params.ts), so the header trigger and the feed can never hold two competing
 * queries.
 */
export const SEARCH_PARAM = 'q';
export const MAX_QUERY_LENGTH = 120;

export function normaliseQuery(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_LENGTH);
}
