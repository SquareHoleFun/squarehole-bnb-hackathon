import type { AssetKind } from '@squarehole/domain';

/**
 * The feed's `?type=` parameter. The raw value is user-controlled (shared links), so it is looked up in a Map, never
 * by indexing a plain object: `?type=__proto__` or `?type=constructor` must not resolve to Object.prototype members.
 * SH-006 extends this lookup (parseFeedType) rather than adding its own.
 */
export const TYPE_PARAM = 'type';

const TYPE_LABELS: ReadonlyMap<string, string> = new Map([
  ['token', 'Tokens'],
  ['nft_collection', 'NFT collections'],
]);

const TYPES: ReadonlyMap<string, AssetKind> = new Map<string, AssetKind>([
  ['token', 'token'],
  ['nft_collection', 'nft_collection'],
]);

/** Display label for a known feed type, or null for an absent, empty or unknown value. */
export function feedTypeLabel(raw: string | null): string | null {
  return raw === null ? null : (TYPE_LABELS.get(raw) ?? null);
}

/** Known asset kind, or `'all'` for an absent, empty or unknown value. */
export function parseFeedType(raw: string | null): 'all' | AssetKind {
  return raw === null ? 'all' : (TYPES.get(raw) ?? 'all');
}
