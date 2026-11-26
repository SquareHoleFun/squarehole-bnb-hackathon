/**
 * SH-RC7-SITE-INBOX (rc7 open item 11, P2.10 item 2): the create page's read-only preview of the sale list a new box's
 * inbox copies at creation (the listing registry's `sellableVersion()`, `BoxFactoryV2Parts.sol:152`) and each coin's
 * lot, read over the source's RPC by the chain package (`readSaleListV21`): view calls only, no wallet. The Demo has no
 * registry, so it shows none. The box's own price coin is never offered (the inbox's `lotSize` is 0 for P, and for
 * WETH in a box priced in ETH), so it is left out here too.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatUnits, type Address } from '@squarehole/domain';
import { readSaleListV21, type SaleListV21 } from '../../../../../../packages/chain/src/core/v2';
import { useDataSource } from '../../data-source';
import { BUILD_CORE } from '../../core/useCore';
import { sourceV2 } from '../../core/v2/indexer-v2';
import { rpcTokenReader } from './indexer-listings';
import { NATIVE_TOKEN, type SiteListing } from './listings';
import { createReleaseOf } from '../../core/v2/releases';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

export type SaleListAnswer =
  | { readonly state: 'off' }
  | { readonly state: 'checking' }
  | { readonly state: 'failed' }
  | { readonly state: 'ready'; readonly list: SaleListV21; readonly weth: Address };
export const SALE_LIST_OFF: SaleListAnswer = Object.freeze({ state: 'off' });

/** The release's sale list now, while `wanted`, asked again each minute (a lister may add a coin or change a lot for new boxes). */
export function useSaleListV21(wanted = true): SaleListAnswer {
  const data = useDataSource();
  const source = useMemo(() => { try { return sourceV2(data.id, BUILD_CORE); } catch { return null; } }, [data.id]);
  // SH-300: the sale list of Create's release (the first).
  const release = source ? createReleaseOf(source.manifest) ?? null : null;
  const reader = useMemo(() => (source ? rpcTokenReader(source.rpc, source.manifest.chainId) : null), [source]);
  const weth = (source?.manifest.chain.weth.address ?? NATIVE_TOKEN) as Address;
  const off = (DEMO_BUILD && data.isDemo) || !source || !release || !reader;
  const query = useQuery({
    queryKey: ['v2-sale-list', source?.network, source?.manifest.chainId, release?.listingRegistry.address],
    queryFn: () => {
      if (!release || !reader) throw new Error('Sale list unavailable');
      return readSaleListV21(reader, { registry: release.listingRegistry.address, inbox: release.implementations.royaltyRouter.address, weth });
    },
    enabled: !off && wanted, refetchInterval: 60_000, retry: false,
  });
  if (off) return SALE_LIST_OFF;
  if (query.data) return { state: 'ready', list: query.data, weth };
  return query.isError ? { state: 'failed' } : { state: 'checking' };
}

/**
 * The preview's rows for a box priced in `pricing`: each coin it would offer, named by the listing book (WETH, which the
 * book lists as its native row, by name), with its lot in the coin's own units; a coin the book does not name shows its
 * short address and raw units. P, and WETH in a box priced in ETH, are left out: they go to the box, never on sale.
 */
export function saleListRows(list: SaleListV21, pricing: Pick<SiteListing, 'token'>, listings: readonly Pick<SiteListing, 'token' | 'symbol' | 'decimals'>[], weth: Address): readonly { readonly coin: Address; readonly name: string; readonly lot: string }[] {
  const p = pricing.token.toLowerCase();
  const kept = list.coins.filter(({ coin }) => coin.toLowerCase() !== p && !(p === NATIVE_TOKEN && coin.toLowerCase() === weth.toLowerCase()));
  return kept.map(({ coin, lot }) => {
    const listed = listings.find((l) => l.token.toLowerCase() === coin.toLowerCase() && l.token.toLowerCase() !== NATIVE_TOKEN);
    if (listed) return { coin, name: listed.symbol, lot: `${formatUnits(lot, listed.decimals)} ${listed.symbol}` };
    if (coin.toLowerCase() === weth.toLowerCase()) return { coin, name: 'WETH', lot: `${formatUnits(lot, 18)} WETH` };
    const name = `${coin.slice(0, 6)}…${coin.slice(-4)}`;
    return { coin, name, lot: `${lot} raw units` };
  });
}
