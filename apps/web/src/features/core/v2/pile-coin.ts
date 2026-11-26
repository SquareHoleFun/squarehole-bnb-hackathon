/** A coin pile's seed coin, by name and decimals (F123): ETH for the native coin, otherwise its permanent listing. */
import { useQueries, useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';
import { loadListingsV2 } from '../../create/v2/indexer-listings';
import type { V2Source } from './indexer-v2';
import type { ReleaseV2 } from '../../../../../../packages/chain/src/core/v2';
import { NATIVE_SYMBOL } from '../../data-source/native-coin';

export type PileCoin = { readonly symbol: string; readonly decimals: number };
const NATIVE = /^0x0{40}$/i;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/**
 * One release's listing book: the BOX's release, always named by the caller (SH-300: listing ids repeat across
 * releases, so a book is one registry's; no default to Create's release on a box's page).
 */
export const listingsOptions = (source: V2Source, release: ReleaseV2, enabled: boolean) => ({
  queryKey: ['v2-listings', source.network, source.origin, source.manifest.chainId, release.registry.address],
  queryFn: () => loadListingsV2(source, undefined, undefined, release), enabled, retry: false as const, staleTime: 60_000,
});

/** The seed coin's (or any listed coin's) symbol and decimals; null while unknown or not `wanted` (the caller then shows raw units or P). */
export function usePileCoin(source: V2Source, asset: Address, wanted: boolean, release: ReleaseV2): PileCoin | null {
  const native = NATIVE.test(asset);
  const book = useQuery(listingsOptions(source, release, wanted && !native));
  if (native) return { symbol: NATIVE_SYMBOL, decimals: 18 };
  const listing = book.data?.find((entry) => same(entry.token, asset));
  return listing ? { symbol: listing.symbol, decimals: listing.decimals } : null;
}

/** The same for several seed coins at once (Claim all across boxes): `coinOf(source, asset)`, null while unknown. */
export function usePileCoins(wanted: readonly { readonly source: V2Source; readonly asset: Address; readonly release: ReleaseV2 }[]): (source: V2Source, asset: Address, release: ReleaseV2) => PileCoin | null {
  // One book per source and release (SH-300: a box's seed coin is in its own release's book).
  const keyOf = (source: V2Source, release: ReleaseV2) => `${source.network}|${source.origin}|${source.manifest.chainId}|${release.registry.address.toLowerCase()}`;
  const wantedBooks = [...new Map(wanted.filter((w) => !NATIVE.test(w.asset)).map((w) => [keyOf(w.source, w.release), w] as const)).values()];
  const books = useQueries({ queries: wantedBooks.map((w) => listingsOptions(w.source, w.release, true)) });
  return (source, asset, release) => {
    if (NATIVE.test(asset)) return { symbol: NATIVE_SYMBOL, decimals: 18 };
    const at = wantedBooks.findIndex((w) => keyOf(w.source, w.release) === keyOf(source, release));
    const listing = books[at]?.data?.find((entry) => same(entry.token, asset));
    return listing ? { symbol: listing.symbol, decimals: listing.decimals } : null;
  };
}
