/**
 * Search semantics ported from reference/feed_model.py: `q = search.strip().casefold()`; a pair matches when `q` is
 * a substring of `name + " " + symbol` or equals one of its token, quote, pair or mirror addresses.
 */
import type { PairRecord } from './types';

export type SearchMatch = 'name' | 'symbol' | 'token' | 'quote' | 'pair' | 'mirror';
export type SearchablePair = Pick<PairRecord, 'name' | 'symbol' | 'pairId' | 'token' | 'quote' | 'mirrorAddress'>;

/**
 * Approximates Python `str.casefold()` (full case folding) without locale data: lower -> upper -> lower expands
 * "ß"/"ẞ" to "ss" and ligatures such as "ﬁ" to "fi"; final sigma is folded to "σ". Known divergences are limited to
 * rare scripts (e.g. Cherokee), which the ASCII fixture does not exercise.
 */
export function caseFold(value: string): string {
  return value.toLowerCase().toUpperCase().toLowerCase().replaceAll('ς', 'σ');
}

/** `strip()` + `casefold()`; JavaScript `trim()` stands in for Python `strip()`. */
export function normalizeSearch(search: string): string {
  return caseFold(search.trim());
}

/** Address part of `${chainId}:${address}` (Python `pairId.split(':', 1)[1]`). */
export function pairAddressOf(pairId: string): string {
  return pairId.slice(pairId.indexOf(':') + 1);
}

/** Match against an already-normalised query. Address identity wins over a name that merely contains it. */
export function matchNormalized(pair: SearchablePair, q: string): SearchMatch | null {
  if (q === '') return null;
  if (caseFold(pair.token.address) === q) return 'token';
  if (caseFold(pair.quote.address) === q) return 'quote';
  if (caseFold(pairAddressOf(pair.pairId)) === q) return 'pair';
  if (pair.mirrorAddress !== undefined && caseFold(pair.mirrorAddress) === q) return 'mirror';
  const name = caseFold(pair.name);
  const symbol = caseFold(pair.symbol);
  if (name.includes(q)) return 'name';
  if (symbol.includes(q)) return 'symbol';
  // The reference searches the joined "NAME SYMBOL" string, so a query may span the boundary.
  if (caseFold(`${pair.name} ${pair.symbol}`).includes(q)) return 'name';
  return null;
}

/** Match kind for UI labels ("token address match", …), or null. An empty/blank query returns null. */
export function matchSearch(pair: SearchablePair, search: string): SearchMatch | null {
  return matchNormalized(pair, normalizeSearch(search));
}
