/**
 * The shop page's reads over the source's RPC (SH-V21-FE13): the shop's book (shop-book.ts), its collections' names,
 * one item's owner and approval, a wallet's own items where a collection lists them (ERC-721 Enumerable) and this
 * wallet's T. View calls and logs only: no wallet, no funds. Each read checks the RPC serves the box's chain first.
 */
import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { createPublicClient, erc20Abi, http, type Abi, type Address, type Hex } from 'viem';
import type { V2Snapshot, V2Source } from './indexer-v2';
import { historyLogs } from './history-logs';
import { readShopEventsV2, shopBookV2, type ShopLogReaderV2 } from './shop-book';
import { ERC721_ABI } from './shop-actions';
import { pageClient } from '../../create/v2/view-client';

const ENUMERABLE = '0x780e9d63';
/** A wallet's own items shown per collection, at most (ERC-721 Enumerable, read one by one). */
export const OWN_ITEMS_MAX = 24n;

function clientOf(source: V2Source) {
  const client = pageClient(source.rpc, source.manifest.chainId, () => createPublicClient({ transport: http(source.rpc, { retryCount: 0 }), ccipRead: false }));
  let checked: Promise<void> | null = null;
  const sameChain = () => {
    checked ??= client.getChainId().then((id) => { if (id !== source.manifest.chainId) throw new Error('Wrong network'); });
    checked.catch(() => { checked = null; });
    return checked;
  };
  const read = async (address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) => {
    await sameChain();
    return client.readContract({ address, abi, functionName, args } as never) as Promise<unknown>;
  };
  return { client, sameChain, read };
}

/** The book's chain reads: the shop's logs over a block range and a block's time. */
export function rpcShopLogReaderV2(source: V2Source): ShopLogReaderV2 {
  const { client, sameChain } = clientOf(source);
  const sourceClient = async () => { await sameChain(); return client; };
  return {
    logs: async (address, fromBlock, toBlock) => {
      const logs = await historyLogs(source, sourceClient, { address, fromBlock, toBlock });
      return logs.map((log) => ({ topics: log.topics as Hex[], data: log.data, blockNumber: log.blockNumber as bigint, logIndex: log.logIndex as number }));
    },
    timestamp: async (block) => { await sameChain(); return (await client.getBlock({ blockNumber: block })).timestamp; },
  };
}

/**
 * The shop's book at the snapshot (null while it reads; `failed` when it could not be read or did not add up). Its logs
 * are read again only when the shop itself changed (its budget, items, collections, curator or opening, as the
 * snapshot reads them), not on every block; the week follows the snapshot's time without a new read.
 */
export function useShopBookV2(source: V2Source, view: V2Snapshot, shop: Address | null, reader?: ShopLogReaderV2) {
  const money = view.m2?.money?.shop ?? null; const history = view.m2?.history?.shop ?? null;
  const logs = useMemo(() => rpcShopLogReaderV2(source), [source]);
  const enabled = shop !== null && !view.failed && money !== null;
  const changes = money && history ? [money.budgetT, money.inside, money.collectionSize, money.curator, money.nextAdditionAt, history.seedFundedT, history.givenT, history.pickedT,
    history.openedAt ?? '', Object.keys(history.collections).length, Object.keys(history.starters).length].join('|') : view.blockHash;
  const query = useQuery({
    queryKey: ['v2-shop-book', source.network, source.manifest.chainId, shop, changes],
    queryFn: async () => ({ ...await readShopEventsV2(reader ?? logs, shop as Address, view.record.creationBlock, view.block, view.timestamp), budgetT: money?.budgetT ?? null }),
    enabled, retry: false, staleTime: Infinity,
    // Keep the last book while the next one is read, so the lists do not empty on every change.
    placeholderData: (previous) => previous,
  });
  const data = query.data;
  const book = useMemo(() => (data ? shopBookV2(data.events, data.times, view.timestamp, data.block) : null), [data, view.timestamp]);
  // The replay must add up to the budget read with it, else it is refused.
  const differs = book !== null && data?.budgetT !== null && data?.budgetT !== undefined && book.budgetT !== data.budgetT;
  return { book: differs ? null : book, failed: enabled && (query.isError || differs) };
}

/** Each listed collection's name, where it has one (ERC-721 metadata); the address stands in otherwise. */
export function useCollectionNamesV2(source: V2Source, collections: readonly Address[]): (collection: string) => string | null {
  const { read } = useMemo(() => clientOf(source), [source]);
  const names = useQueries({
    queries: collections.map((collection) => ({
      queryKey: ['v2-shop-name', source.network, source.manifest.chainId, collection.toLowerCase()],
      queryFn: async () => { const name = await read(collection, ERC721_ABI, 'name'); return typeof name === 'string' && name.length > 0 && name.length <= 48 ? name : null; },
      retry: false, staleTime: Infinity,
    })),
  });
  return (collection) => names[collections.findIndex((c) => c.toLowerCase() === collection.toLowerCase())]?.data ?? null;
}

/** Up to OWN_ITEMS_MAX of `owner`'s items in `collection`, where it lists them (ERC-721 Enumerable); null otherwise. */
export function useOwnItemsV2(source: V2Source, collection: Address | null, owner: Address | null) {
  const { read } = useMemo(() => clientOf(source), [source]);
  const query = useQuery({
    queryKey: ['v2-shop-own', source.network, source.manifest.chainId, collection?.toLowerCase(), owner?.toLowerCase()],
    queryFn: async (): Promise<readonly bigint[] | null> => {
      if (!collection || !owner) return null;
      const enumerable = await read(collection, ERC721_ABI, 'supportsInterface', [ENUMERABLE]).catch(() => false);
      if (enumerable !== true) return null;
      const balance = await read(collection, ERC721_ABI, 'balanceOf', [owner]) as bigint;
      const count = balance < OWN_ITEMS_MAX ? balance : OWN_ITEMS_MAX;
      const ids: bigint[] = [];
      for (let i = 0n; i < count; i += 1n) ids.push(await read(collection, ERC721_ABI, 'tokenOfOwnerByIndex', [owner, i]) as bigint);
      return ids;
    },
    enabled: collection !== null && owner !== null, retry: false, staleTime: 15_000,
  });
  return query.data ?? null;
}

/** One item now: its owner and whether the shop may take it from that owner (approved for it, or for all). */
export function useShopItemV2(source: V2Source, shop: Address | null, collection: Address | null, id: bigint | null) {
  const { read } = useMemo(() => clientOf(source), [source]);
  const query = useQuery({
    queryKey: ['v2-shop-item', source.network, source.manifest.chainId, shop, collection?.toLowerCase(), id?.toString()],
    queryFn: async () => {
      if (!shop || !collection || id === null) return null;
      let owner: Address;
      try { owner = await read(collection, ERC721_ABI, 'ownerOf', [id]) as Address; } catch { return { owner: null, approved: false }; }
      const [one, all] = await Promise.all([
        read(collection, ERC721_ABI, 'getApproved', [id]).catch(() => null),
        read(collection, ERC721_ABI, 'isApprovedForAll', [owner, shop]).catch(() => false),
      ]);
      return { owner, approved: (typeof one === 'string' && one.toLowerCase() === shop.toLowerCase()) || all === true };
    },
    enabled: shop !== null && collection !== null && id !== null, retry: false, staleTime: 5_000,
  });
  return { item: query.data ?? null, reading: query.isFetching };
}

/** This wallet's T and what it lets the shop take, now. */
export function useShopCoinsV2(source: V2Source, token: Address, shop: Address | null, owner: Address | null) {
  const { read } = useMemo(() => clientOf(source), [source]);
  const query = useQuery({
    queryKey: ['v2-shop-coins', source.network, source.manifest.chainId, token.toLowerCase(), shop, owner?.toLowerCase()],
    queryFn: async () => {
      if (!shop || !owner) return null;
      const [balance, allowance] = await Promise.all([read(token, erc20Abi as Abi, 'balanceOf', [owner]), read(token, erc20Abi as Abi, 'allowance', [owner, shop])]);
      return { balance: balance as bigint, allowance: allowance as bigint };
    },
    enabled: shop !== null && owner !== null, retry: false, staleTime: 5_000,
  });
  return query.data ?? null;
}
