/**
 * Whether a typed collection is one a shop can list: ShopVaultV2 lists only a contract that says it is an ERC-721
 * (`supportsInterface(0x80ac58cd)`, its `_add` check, which also runs at Create for every starting collection, so
 * Create would revert otherwise). The page asks the source's chain once per address, over its RPC: a view call, no
 * funds and no wallet. The Demo has no chain, so nothing is asked there; a failed read is asked again after RETRY_MS.
 */
import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, stringToHex, type Address } from 'viem';
import { useDataSource } from '../../data-source';
import { BUILD_CORE } from '../../core/useCore';
import { sourceV2 } from '../../core/v2/indexer-v2';
import { rpcTokenReader } from './indexer-listings';
import { RETRY_MS, type TokenReader } from './issuer-powers';
import { starterKey, type CollectionCheck, type StarterCheck, type StarterItem } from './shop';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

const ERC165 = parseAbi(['function supportsInterface(bytes4 id) view returns (bool)']);
/** ERC-721's interface id, as ShopVaultV2 `_add` asks it. */
export const ERC721_INTERFACE = '0x80ac58cd';

/** The chain's answer for one address: no contract, a contract that is not an ERC-721, or an ERC-721. */
export async function collectionCheckV2(reader: TokenReader, collection: Address): Promise<CollectionCheck> {
  if (!(await reader.hasCode(collection))) return 'no-code';
  const reply = await reader.call(collection, encodeFunctionData({ abi: ERC165, functionName: 'supportsInterface', args: [ERC721_INTERFACE] }));
  if (reply === null) return 'not-erc721';
  try {
    return decodeFunctionResult({ abi: ERC165, functionName: 'supportsInterface', data: reply }) === true ? 'erc721' : 'not-erc721';
  } catch {
    return 'not-erc721';
  }
}

/** TA-27: a loaded shop's starting collections, each asked once before the setup is installed (lower-case keys). */
export type CollectionChecker = (collections: readonly Address[]) => Promise<ReadonlyMap<string, CollectionCheck | 'unknown'>>;

/** Every address's answer at once; one the chain could not answer is 'unknown' (the load is then refused, not guessed). */
export async function checkCollectionsV2(reader: TokenReader, collections: readonly Address[]): Promise<ReadonlyMap<string, CollectionCheck | 'unknown'>> {
  const asked = [...new Set(collections.map((collection) => collection.toLowerCase()))];
  const answers = await Promise.all(asked.map((collection) => collectionCheckV2(reader, collection as Address).catch((): 'unknown' => 'unknown')));
  return new Map(asked.map((collection, i) => [collection, answers[i] ?? 'unknown']));
}

/** The page's checker for a loaded shop: this source's chain, as `useShopChecks` asks it; null where there is none (the Demo). */
export function useCollectionChecker(): CollectionChecker | null {
  const data = useDataSource();
  const source = useMemo(() => { try { return sourceV2(data.id, BUILD_CORE); } catch { return null; } }, [data.id]);
  const reader = useMemo(() => (source ? rpcTokenReader(source.rpc, source.manifest.chainId) : null), [source]);
  const enabled = reader !== null && !(DEMO_BUILD && data.isDemo);
  return useMemo(() => (enabled && reader ? (collections: readonly Address[]) => checkCollectionsV2(reader, collections) : null), [enabled, reader]);
}

const OWNER_OF = parseAbi(['function ownerOf(uint256 id) view returns (address)']);
/** How many starter items are asked at once (a set holds up to 10,000). */
const STARTER_READS = 16;

/**
 * SH-SHOP-CREATE: whether `owner` holds one starter item now, as ShopVaultV2 `_receiveItem` requires when the loader
 * pulls it (`ownerOf(id) == creator`; the shop's own approval comes after Create). An id the collection refuses to
 * answer (none minted, burned) is not the owner's; a read the chain could not make throws.
 */
export async function starterOwnerV2(reader: TokenReader, item: Pick<StarterItem, 'collection' | 'id'>, owner: Address): Promise<StarterCheck> {
  const reply = await reader.call(item.collection, encodeFunctionData({ abi: OWNER_OF, functionName: 'ownerOf', args: [item.id] }));
  if (reply === null) return 'not-yours';
  try {
    const holder = decodeFunctionResult({ abi: OWNER_OF, functionName: 'ownerOf', data: reply });
    return holder.toLowerCase() === owner.toLowerCase() ? 'yours' : 'not-yours';
  } catch {
    return 'not-yours';
  }
}

/** Every starter item's answer for `owner` (`starterKey` keys), STARTER_READS at a time; one the chain could not answer is 'unknown'. */
export async function checkStartersV2(reader: TokenReader, items: readonly StarterItem[], owner: Address): Promise<ReadonlyMap<string, StarterCheck | 'unknown'>> {
  const answers = new Map<string, StarterCheck | 'unknown'>();
  for (let start = 0; start < items.length; start += STARTER_READS) {
    const batch = items.slice(start, start + STARTER_READS);
    const read = await Promise.all(batch.map((item) => starterOwnerV2(reader, item, owner).catch((): 'unknown' => 'unknown')));
    batch.forEach((item, i) => answers.set(starterKey(item), read[i] ?? 'unknown'));
  }
  return answers;
}

/** The page's starter check in the query cache: each Create or Continue press asks for it again (CreateV2Flow). */
export const STARTER_CHECKS_KEY = 'v2-shop-starters';

/**
 * The starter items' answers for the connected wallet, asked on this source's chain once it is known (a view call per
 * item, no wallet); undefined where nothing is asked: the Demo, no wallet or no items. Asked again after RETRY_MS while
 * any item is not the wallet's or unanswered (the creator may move items in), whenever the items or wallet change, and
 * every time the check is shown again or asked for again (`STARTER_CHECKS_KEY`): "all yours" is never fresh for good
 * (XR-SH-SHOP-CREATE F2). The run reads every item again itself before any wallet request (create-send.ts).
 */
export function useStarterChecks(items: readonly StarterItem[] | null, owner: Address | null): ReadonlyMap<string, StarterCheck | 'unknown'> | undefined {
  const data = useDataSource();
  const source = useMemo(() => { try { return sourceV2(data.id, BUILD_CORE); } catch { return null; } }, [data.id]);
  const reader = useMemo(() => (source ? rpcTokenReader(source.rpc, source.manifest.chainId) : null), [source]);
  const enabled = reader !== null && !(DEMO_BUILD && data.isDemo) && owner !== null && items !== null && items.length > 0;
  // The items as one short key (a set holds up to 10,000 of them).
  const key = useMemo(() => keccak256(stringToHex((items ?? []).map(starterKey).join(','))), [items]);
  const query = useQuery({
    queryKey: [STARTER_CHECKS_KEY, source?.network, source?.manifest.chainId, owner?.toLowerCase(), key],
    queryFn: () => { if (!reader || !owner || !items) throw new Error('V2 chain unavailable'); return checkStartersV2(reader, items, owner); },
    enabled,
    staleTime: 0,
    retry: false,
    refetchInterval: (state) => (state.state.data && [...state.state.data.values()].every((answer) => answer === 'yours') ? false : RETRY_MS),
  });
  return useMemo(() => {
    if (!enabled) return undefined;
    return query.data ?? new Map<string, StarterCheck | 'unknown'>();
  }, [enabled, query.data]);
}

/**
 * Each address's answer (lower-case keys), 'unknown' while it is being asked; undefined when the page has no chain to
 * ask (the Demo), so nothing is refused on its account.
 */
export function useShopChecks(collections: readonly Address[]): ReadonlyMap<string, CollectionCheck | 'unknown'> | undefined {
  const data = useDataSource();
  const source = useMemo(() => { try { return sourceV2(data.id, BUILD_CORE); } catch { return null; } }, [data.id]);
  const reader = useMemo(() => (source ? rpcTokenReader(source.rpc, source.manifest.chainId) : null), [source]);
  const asked = useMemo(() => [...new Set(collections.map((collection) => collection.toLowerCase()))], [collections]);
  const enabled = reader !== null && !(DEMO_BUILD && data.isDemo);
  const answers = useQueries({
    queries: asked.map((collection) => ({
      queryKey: ['v2-shop-collection', source?.network, source?.manifest.chainId, collection],
      queryFn: () => { if (!reader) throw new Error('V2 chain unavailable'); return collectionCheckV2(reader, collection as Address); },
      enabled,
      staleTime: Infinity,
      retry: false,
      refetchInterval: (query: { readonly state: { readonly data?: CollectionCheck } }) => (query.state.data ? false : RETRY_MS),
    })),
    combine: (results) => results.map((result) => result.data ?? 'unknown').join('|'),
  });
  return useMemo(() => {
    if (!enabled) return undefined;
    const list = answers.split('|');
    return new Map(asked.map((collection, i) => [collection, (list[i] ?? 'unknown') as CollectionCheck | 'unknown']));
  }, [enabled, asked, answers]);
}
