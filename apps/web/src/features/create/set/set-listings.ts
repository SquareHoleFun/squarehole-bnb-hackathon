/**
 * SH-EXISTING-NFTS-E08C: the price coins a set box can be created with: the add-on release's own listing registry
 * (`listingRegistry` in its manifest; the add-on never prices from the v2.1 book), read at one block over the source's
 * RPC. Each row is the registry's: its id, coin, decimals, class, kind, raise and bootstrap. A coin's symbol and its
 * issuer's powers are read from its own contract (issuer-powers.ts), never guessed from a ticker. View calls only.
 */
import { useQuery } from '@tanstack/react-query';
import { erc20Abi, type Address } from 'viem';
import { setListingRegistryV2Abi } from '@squarehole/chain/core/set-v2';
import type { SetSource } from '../../set/set-build';
import { rpcSetReads, type SetReads } from '../../set/set-reads';
import { rpcTokenReader } from '../v2/indexer-listings';
import { issuerPowerLines, type TokenReader } from '../v2/issuer-powers';
import { NATIVE_TOKEN, offeredListings, type SiteListing } from '../v2/listings';
import { NATIVE_SYMBOL } from '../../data-source/native-coin';

interface ListingRow {
  readonly id: number;
  readonly token: Address;
  readonly decimals: number;
  readonly class: number;
  readonly kind: number;
  readonly listedAt: bigint;
  readonly raise: bigint;
  readonly q: { readonly bootstrapQ: bigint };
}

/** At most this many listings are read (a longer book shows its first ones). */
const MAX_LISTINGS = 512;

async function symbolOf(reads: SetReads, token: Address, block: bigint): Promise<string> {
  if (token.toLowerCase() === NATIVE_TOKEN) return NATIVE_SYMBOL;
  try {
    const symbol = await reads.read(token, erc20Abi, 'symbol', [], block);
    return typeof symbol === 'string' && symbol.length > 0 && symbol.length <= 32 ? symbol : token;
  } catch {
    return token;
  }
}

/** The add-on's offered price coins, read at one block. */
export async function loadSetListings(reads: SetReads, source: SetSource, tokens: TokenReader): Promise<readonly SiteListing[]> {
  if (await reads.chainId() !== source.chainId) throw new Error('The RPC serves another chain.');
  const registry = source.release.listingRegistry.address;
  const block = await reads.blockNumber();
  const count = await reads.read(registry, setListingRegistryV2Abi, 'listingCount', [], block);
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new Error('Price coins unavailable');
  const ids = Array.from({ length: Math.min(count, MAX_LISTINGS) }, (_, i) => i);
  const rows = await Promise.all(ids.map(async (id): Promise<SiteListing> => {
    const row = await reads.read(registry, setListingRegistryV2Abi, 'listing', [id], block) as ListingRow;
    if (row.id !== id) throw new Error('Inconsistent listing');
    const [symbol, powers] = await Promise.all([symbolOf(reads, row.token, block), issuerPowerLines(tokens, source.chainId, { token: row.token, kind: row.kind })]);
    return { id: row.id, token: row.token, decimals: row.decimals, class: row.class, kind: row.kind, raise: row.raise, bootstrap: row.q.bootstrapQ, listedAt: row.listedAt, symbol, name: symbol, powers };
  }));
  const offered = offeredListings(rows);
  if (offered.length === 0 && rows.length > 0) throw new Error('Invalid or duplicate price coins');
  return offered;
}

/** The add-on's price coins on the current source, refreshed now and then; none until the source is ready. */
export function useSetListings(source: SetSource | null, reads?: SetReads) {
  const query = useQuery({
    queryKey: ['set-listings', source?.chainId ?? 0, source?.release.listingRegistry.address ?? '', source?.rpc ?? ''],
    queryFn: () => {
      if (!source) throw new Error('No add-on here');
      return loadSetListings(reads ?? rpcSetReads(source.rpc), source, rpcTokenReader(source.rpc, source.chainId));
    },
    enabled: source !== null,
    refetchInterval: 30_000,
    retry: false,
  });
  return { listings: query.data ?? null, error: query.isError ? 'Price coins unavailable' : null };
}
