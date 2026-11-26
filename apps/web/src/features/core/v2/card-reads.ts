/**
 * SH-297: which cards of a shop's listed collections a wallet holds, for the shop's own grid and for My Box alike. The
 * test collections list no owner's cards (no ERC-721 Enumerable, SH-283), and cards reach a wallet three ways (a pick,
 * a mint, a transfer), so the read follows the collections' own `Transfer` events TO the wallet (at most ten collections
 * per query, the public endpoint's limit; one query per 50,000 blocks, all asked together), then checks each card's
 * owner now with `ownerOf` (a card passed on since is not shown). It starts `LOOKBACK` blocks before the shop's creation
 * block: cards minted for a shop's start arrive around it. A failed read is a failure, never "no cards".
 *
 * SH-297 notes, older cards: each collection's `balanceOf` the wallet (at the read's block) says how many cards it
 * holds. A collection with none is not searched at all; one that lists its owner's cards (ERC-721 Enumerable) is read
 * by index, exactly; for the rest the read walks back before the window, `WALK_STEP` blocks at a time, only for the
 * collections still short of their count, up to `WALK_MAX` blocks. What is still not found then is counted (`unfound`)
 * and said, never silently dropped. The way the ticket named (each collection's first block by a binary search on its
 * code) cannot run on the public endpoints: both refuse state older than about 220,000 blocks ("state at block
 * #144703489 is pruned", "historical state … is not available"; asked 26 Nov 2026 at head 144,926,517), and their log
 * queries stop at 50,000 and 5,000 blocks, so a search from a collection's birth would cost thousands of queries.
 */
import { BaseError, ContractFunctionRevertedError, createPublicClient, http, parseAbiItem, type Abi, type Address } from 'viem';
import { useQuery } from '@tanstack/react-query';
import { pageClient } from '../../create/v2/view-client';
import type { V2Snapshot, V2Source } from './indexer-v2';
import { batchedLogClient, historyLogs } from './history-logs';
import { ERC721_ABI, shopOf } from './shop-actions';
import { LOG_SPAN } from './shop-book';

/** Collections per log query: the public endpoint's own limit of addresses. */
export const COLLECTIONS_PER_QUERY = 10;
/** Cards checked per wallet and shop, at most (each costs one `ownerOf`, folded into Multicall3). */
export const CARDS_MAX = 60;
/** Blocks before the shop's creation the read starts at (about 12 hours on BNB Chain testnet). */
export const LOOKBACK = 100_000n;
/** Blocks per step of the walk back for collections short of their count (ten log queries per group of ten). */
export const WALK_STEP = 500_000n;
/** Blocks the walk goes back at most before the window (about ten days on BNB Chain testnet; 40 queries per group). */
export const WALK_MAX = 2_000_000n;

export interface CardV2 { readonly collection: Address; readonly id: bigint }
/**
 * `unfound`: the wallet's count at the snapshot block less the cards listed: cards older than the walk, cards a failed
 * walk step did not reach, or cards that left the wallet since the snapshot (owners are read now). Said only as "could
 * not be listed", never with a reason.
 */
export interface OwnCardsV2 { readonly cards: readonly CardV2[]; readonly more: boolean; readonly unfound: bigint }

/** The reads the card read needs: transfers to a wallet over a block range, a card's owner, a count, and a listing. */
export interface CardReaderV2 {
  transfersTo(collections: readonly Address[], to: Address, fromBlock: bigint, toBlock: bigint): Promise<readonly CardV2[]>;
  ownerOf(collection: Address, id: bigint): Promise<Address>;
  /** The wallet's card count at `block`; null when the collection refuses the call (then only the window is read). */
  balanceOf(collection: Address, owner: Address, block: bigint): Promise<bigint | null>;
  /** The wallet's first `count` card ids by index (ERC-721 Enumerable); null when the collection does not list them. */
  ownedByIndex(collection: Address, owner: Address, count: bigint): Promise<readonly bigint[] | null>;
}

/** A shop's listed collections: its spec's and those the index's shop history names (added later). */
export function shopCollectionsV2(view: V2Snapshot): readonly Address[] {
  const all = new Map<string, Address>();
  for (const c of shopOf(view, null)?.collections ?? []) all.set(c.toLowerCase(), c);
  for (const c of Object.keys(view.m2?.history?.shop?.collections ?? {})) if (/^0x[0-9a-fA-F]{40}$/.test(c)) all.set(c.toLowerCase(), c as Address);
  return [...all.values()];
}

const reverted = (error: unknown) => error instanceof BaseError && error.walk((cause) => cause instanceof ContractFunctionRevertedError) !== null;

/**
 * The wallet's cards of these collections now (see the head of this file): newest first, each still its own, at most
 * `CARDS_MAX` checked. Throws on a failed read.
 */
export async function readOwnCardsV2(reader: CardReaderV2, collections: readonly Address[], owner: Address, fromBlock: bigint, toBlock: bigint): Promise<OwnCardsV2> {
  const none: OwnCardsV2 = { cards: [], more: false, unfound: 0n };
  if (collections.length === 0) return none;
  const lc = (c: Address) => c.toLowerCase();
  // A count or a listing that cannot be read leaves that collection to the window, as before these notes: the extra
  // reads only add cards, they never cost the ones the window finds.
  const counts = await Promise.all(collections.map((c) => reader.balanceOf(c, owner, toBlock).catch(() => null)));
  const count = new Map(collections.map((c, i) => [lc(c), counts[i] ?? null]));
  const held = collections.filter((c) => count.get(lc(c)) !== 0n);
  if (held.length === 0) return none;
  let more = false;
  // Collections that list their owner's cards: read by index (no logs, no owner checks).
  const listed = await Promise.all(held.map((c) => {
    const n = count.get(lc(c)) ?? null;
    if (n === null) return null;
    if (n > BigInt(CARDS_MAX)) more = true;
    return reader.ownedByIndex(c, owner, n > BigInt(CARDS_MAX) ? BigInt(CARDS_MAX) : n).catch(() => null);
  }));
  const byIndex = held.flatMap((c, i) => (listed[i] ?? []).map((id) => ({ collection: c, id })));
  const logged = held.filter((_c, i) => listed[i] === null);
  // The rest from their transfers to the wallet, each card checked once with `ownerOf`.
  const found = new Map<string, bigint>(); const seen = new Set<string>(); const cards: CardV2[] = []; let checks = 0;
  const query = async (group: readonly Address[], from: bigint, to: bigint) => {
    const parts: Address[][] = [];
    for (let i = 0; i < group.length; i += COLLECTIONS_PER_QUERY) parts.push(group.slice(i, i + COLLECTIONS_PER_QUERY));
    const got = (await Promise.all(parts.map((g) => reader.transfersTo(g, owner, from, to)))).flat();
    // Newest first, each card once.
    const fresh = [...new Map([...got].reverse().map((c) => [`${lc(c.collection)}:${c.id}`, c])).values()].filter((c) => !seen.has(`${lc(c.collection)}:${c.id}`));
    for (const c of fresh) seen.add(`${lc(c.collection)}:${c.id}`);
    if (fresh.length > CARDS_MAX - checks) more = true;
    const now = fresh.slice(0, Math.max(0, CARDS_MAX - checks)); checks += now.length;
    const mine = await Promise.all(now.map(async (card) => {
      try { return lc(await reader.ownerOf(card.collection, card.id)) === lc(owner) ? card : null; }
      catch (error) { if (reverted(error)) return null; throw error; }
    }));
    for (const card of mine) if (card) { cards.push(card); found.set(lc(card.collection), (found.get(lc(card.collection)) ?? 0n) + 1n); }
  };
  const short = () => logged.filter((c) => { const n = count.get(lc(c)) ?? null; return n !== null && (found.get(lc(c)) ?? 0n) < n; });
  // The window: a failure here fails the read, as before these notes (the page says so, with Retry).
  if (logged.length > 0) {
    try { await query(logged, fromBlock, toBlock); }
    catch (error) { console.warn(`card read: the window ${fromBlock}-${toBlock} failed`, error); throw error; }
  }
  // The walk back only adds cards: a step that fails (a rate limit, a timeout, an endpoint that refuses the range) ends
  // the walk, and what is still short is counted as not listed; the window's cards stay.
  for (let hi = fromBlock - 1n, walked = 0n; hi >= 0n && walked < WALK_MAX && checks < CARDS_MAX; ) {
    const missing = short();
    if (missing.length === 0) break;
    const lo = hi + 1n > WALK_STEP ? hi + 1n - WALK_STEP : 0n;
    try { await query(missing, lo, hi); }
    catch (error) { console.warn(`card read: the walk back stopped at blocks ${lo}-${hi}`, error); break; }
    walked += hi + 1n - lo; hi = lo - 1n;
  }
  // The check budget spent with counts still short: more than shown, not cards that could not be listed.
  if (checks >= CARDS_MAX && short().length > 0) more = true;
  const all = [...cards, ...byIndex];
  if (all.length > CARDS_MAX) more = true;
  const unfound = more ? 0n : short().reduce((sum, c) => sum + ((count.get(lc(c)) ?? 0n) - (found.get(lc(c)) ?? 0n)), 0n);
  return { cards: all.slice(0, CARDS_MAX), more, unfound };
}

/** The range a shop's card window covers: from `LOOKBACK` blocks before its creation to the snapshot's block. */
export const cardRangeV2 = (view: Pick<V2Snapshot, 'record' | 'block'>): readonly [bigint, bigint] => {
  const from = view.record.creationBlock > LOOKBACK ? view.record.creationBlock - LOOKBACK : 0n;
  return [from, view.block];
};

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)');
const readers = new Map<string, CardReaderV2>();
/** ERC-721 Enumerable's interface id. */
const ENUMERABLE = '0x780e9d63';
/**
 * The page's card reader for a source: log queries through a client that batches them (one HTTP request) and asks
 * again on HTTP 429 by the site's one rule (`refusedRetryFetch`); owners through the page client (Multicall3).
 */
export function cardReaderV2(source: V2Source): CardReaderV2 {
  const key = `${source.manifest.chainId}|${source.rpc}`;
  let reader = readers.get(key);
  if (!reader) {
    const logs = batchedLogClient(source.rpc);
    const page = pageClient(source.rpc, source.manifest.chainId, () => createPublicClient({ transport: http(source.rpc, { retryCount: 0 }), ccipRead: false }));
    reader = {
      transfersTo: async (collections, to, fromBlock, toBlock) => {
        const spans: [bigint, bigint][] = [];
        for (let start = fromBlock; start <= toBlock; start += LOG_SPAN) spans.push([start, start + LOG_SPAN - 1n < toBlock ? start + LOG_SPAN - 1n : toBlock]);
        const pages = await Promise.all(spans.map(([a, b]) => historyLogs(source, () => logs, { address: [...collections], event: TRANSFER, args: { to }, fromBlock: a, toBlock: b })));
        return pages.flat().flatMap((log) => (log.args.tokenId !== undefined ? [{ collection: log.address, id: log.args.tokenId }] : []));
      },
      ownerOf: async (collection, id) => page.readContract({ address: collection, abi: ERC721_ABI as Abi, functionName: 'ownerOf', args: [id] }) as Promise<Address>,
      balanceOf: async (collection, owner, block) => {
        try { return await page.readContract({ address: collection, abi: ERC721_ABI as Abi, functionName: 'balanceOf', args: [owner], blockNumber: block }) as bigint; }
        catch (error) { if (reverted(error)) return null; throw error; }
      },
      ownedByIndex: async (collection, owner, count) => {
        let lists: boolean;
        try { lists = await page.readContract({ address: collection, abi: ERC721_ABI as Abi, functionName: 'supportsInterface', args: [ENUMERABLE] }) === true; }
        catch (error) { if (reverted(error)) return null; throw error; }
        if (!lists) return null;
        return Promise.all(Array.from({ length: Number(count) }, (_, i) => page.readContract({ address: collection, abi: ERC721_ABI as Abi, functionName: 'tokenOfOwnerByIndex', args: [owner, BigInt(i)] }) as Promise<bigint>));
      },
    };
    readers.set(key, reader);
  }
  return reader;
}

export type OwnCardsStateV2 =
  | { readonly status: 'reading' }
  | { readonly status: 'failed'; readonly retry: () => void }
  | { readonly status: 'ready'; readonly cards: readonly CardV2[]; readonly more: boolean; readonly unfound: bigint };

/**
 * The wallet's cards of a shop's listed collections, for the shop's grid: read once per wallet and shop, again after a
 * mined send on this site (the key starts as the shop's own read of a wallet's items, `v2-shop-own`) and on Retry.
 * No wallet: nothing read, nothing shown.
 */
export function useOwnCardsV2(source: V2Source, view: V2Snapshot, owner: Address | null, reader: CardReaderV2 = cardReaderV2(source)): OwnCardsStateV2 | null {
  const collections = shopCollectionsV2(view);
  const [from, to] = cardRangeV2(view);
  const query = useQuery({
    queryKey: ['v2-shop-own', 'cards', source.network, source.manifest.chainId, view.token.toLowerCase(), owner?.toLowerCase(), collections.map((c) => c.toLowerCase()).join(',')],
    queryFn: () => readOwnCardsV2(reader, collections, owner as Address, from, to),
    enabled: owner !== null && collections.length > 0, retry: false, staleTime: 60_000,
    placeholderData: (previous) => previous,
  });
  if (owner === null || collections.length === 0) return null;
  if (query.data) return { status: 'ready', cards: query.data.cards, more: query.data.more, unfound: query.data.unfound };
  if (query.isError) return { status: 'failed', retry: () => { void query.refetch(); } };
  return { status: 'reading' };
}
