/**
 * SH-RC7-SITE-INBOX (rc7 open item 11): public upkeep a page may offer, decided from live reads before any button shows.
 *
 * - The income inbox's `refreshOrder(coin)` and `observe(coin)` (COW-2's last piece): `inboxUpkeepV21` says which one
 *   would change the coin's state now, by the inbox's own arithmetic (`BoxRoyaltyRouterV2.refreshOrder`, `_observe`):
 *   a refresh registers or raises the VaultRelayer approval to the whole lots the hour's budget leaves; an observation
 *   records an unrecorded sale (allowance below the recorded approval) or starts a clock nobody has started.
 * - The release's sale list a new box copies at creation (`sellableVersion()`; `BoxFactoryV2Parts.sol:152`), for the
 *   create page's read-only preview.
 * - The launch router's public `sweep()` (KF-5), prepared for the shared send guard.
 *
 * Every amount and time is bigint; nothing here asks a wallet.
 */
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, erc20Abi, keccak256, parseAbi, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { coordinatorV2Abi, launchRouterV2Abi, listingRegistryV2Abi, royaltyRouterV2Abi } from './abi-v2';
import type { WriteCallV2, WriteTargetV2 } from './write-calls-v2';

/** `BoxRoyaltyRouterV2.MAX_LOTS_PER_HOUR`: at most 20 lots of a coin are approved per UTC hour. */
export const INBOX_MAX_LOTS_PER_HOUR_V21 = 20n;
const HOUR = 3_600n;

/** One inbox coin as a public refresh or observe would find it, read at one block. */
export interface InboxCoinLiveV21 {
  readonly coin: Address;
  /** The coin's raw lot at the box's frozen list version (0: not on the list, never offered). */
  readonly lot: bigint;
  /** The custody the call counts: for WETH the inbox's WETH and its ETH, which refresh and observe wrap first. */
  readonly balance: bigint;
  /** The coin's ERC-20 allowance from the inbox to CoW's VaultRelayer now. */
  readonly allowance: bigint;
  /** The inbox's recorded approval, clock hour and spent capacity (`CoinState`, read from storage). */
  readonly approved: bigint;
  readonly hour: bigint;
  readonly spent: bigint;
  readonly registered: boolean;
  /** 0: no clock started. */
  readonly oldestUnsoldAt: bigint;
  readonly failed: boolean;
  /** The block's timestamp the reads were made at. */
  readonly now: bigint;
}

/** What one public call would do now; null: nothing, so no control is offered. */
export type InboxUpkeepV21 =
  | { readonly kind: 'refresh'; /** the whole lots, in raw units, the refresh would approve */ readonly offered: bigint }
  | { readonly kind: 'observe'; readonly reason: 'sale' | 'clock' }
  | null;

/**
 * The inbox's own arithmetic: an observation first charges an unrecorded sale to the current hour (`_observe`), then a
 * refresh approves the lesser of the custody and the hour's remaining 20 lots, rounded down to whole lots. A refresh is
 * worth offering only when it would register the coin or approve more than its allowance; otherwise an observation is
 * worth offering when it would record a sale or start a clock. A failed box's inbox offers nothing (R53-E: its upkeep
 * only clears approvals, which no order can use).
 */
export function inboxUpkeepV21(c: InboxCoinLiveV21): InboxUpkeepV21 {
  if (c.failed || c.lot === 0n) return null;
  const sold = c.approved > c.allowance ? c.approved - c.allowance : 0n;
  const spent = (c.hour === c.now / HOUR ? c.spent : 0n) + sold;
  const cap = INBOX_MAX_LOTS_PER_HOUR_V21 * c.lot;
  const left = spent >= cap ? 0n : cap - spent;
  const offered = ((c.balance < left ? c.balance : left) / c.lot) * c.lot;
  if (c.registered ? offered > c.allowance : offered > 0n) return { kind: 'refresh', offered };
  if (sold > 0n) return { kind: 'observe', reason: 'sale' };
  if (c.balance > 0n && c.oldestUnsoldAt === 0n) return { kind: 'observe', reason: 'clock' };
  return null;
}

/** RC6's immutable layout (as our keeper reads it): `_coins` is mapping slot 0; `CoinState` is oldestUnsoldAt, hour, spent, approved. */
export function inboxCoinSlotsV21(coin: Address): { readonly hour: Hex; readonly spent: Hex; readonly approved: Hex } {
  const base = BigInt(keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [coin, 0n])));
  const slot = (offset: bigint) => toHex((base + offset) % (1n << 256n), { size: 32 });
  return { hour: slot(1n), spent: slot(2n), approved: slot(3n) };
}

/** Reads pinned to one block: `call` and `storage` answer at `block`, which `block()` names with its timestamp. */
export interface InboxLiveReaderV21 {
  block(): Promise<{ readonly number: bigint; readonly timestamp: bigint }>;
  call(to: Address, data: Hex, block: bigint): Promise<Hex>;
  storage(address: Address, slot: Hex, block: bigint): Promise<Hex>;
}

const word = (value: Hex): bigint => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('inbox recorded state unavailable');
  return BigInt(value);
};

/** One coin's live state for `inboxUpkeepV21`, every read at one block. Any failed read throws: no control is offered. */
export async function readInboxCoinLiveV21(reader: InboxLiveReaderV21, router: Address, coordinator: Address, coin: Address): Promise<InboxCoinLiveV21> {
  const block = await reader.block();
  const at = block.number;
  const inbox = async <T>(functionName: string, args: readonly unknown[] = []): Promise<T> =>
    decodeFunctionResult({ abi: royaltyRouterV2Abi, functionName, data: await reader.call(router, encodeFunctionData({ abi: royaltyRouterV2Abi, functionName, args } as never), at) } as never) as T;
  const slots = inboxCoinSlotsV21(coin);
  const [weth, relayer, lot, held, registered, oldestUnsoldAt, failedData, hour, spent, approved] = await Promise.all([
    inbox<Address>('weth'), inbox<Address>('vaultRelayer'), inbox<bigint>('lotSize', [coin]), inbox<bigint>('heldBalance', [coin]),
    inbox<boolean>('orderRegistered', [coin]), inbox<bigint>('oldestUnsoldAt', [coin]),
    reader.call(coordinator, encodeFunctionData({ abi: coordinatorV2Abi, functionName: 'failed' }), at),
    reader.storage(router, slots.hour, at), reader.storage(router, slots.spent, at), reader.storage(router, slots.approved, at),
  ]);
  const isWeth = coin.toLowerCase() === weth.toLowerCase();
  const [eth, allowanceData] = await Promise.all([
    isWeth ? inbox<bigint>('heldBalance', [zeroAddress]) : Promise.resolve(0n),
    reader.call(coin, encodeFunctionData({ abi: erc20Abi, functionName: 'allowance', args: [router, relayer] }), at),
  ]);
  return { coin, lot, balance: held + eth, allowance: decodeFunctionResult({ abi: erc20Abi, functionName: 'allowance', data: allowanceData }),
    approved: word(approved), hour: word(hour), spent: word(spent), registered, oldestUnsoldAt,
    failed: decodeFunctionResult({ abi: coordinatorV2Abi, functionName: 'failed', data: failedData }), now: block.timestamp };
}

/** The sale list rows read per page, as our keeper and indexer bound an inbox's list (the launch check refuses more than 28). */
export const SALE_LIST_READ_LIMIT_V21 = 32n;
/** One coin a new box would offer for P, at its raw lot in the coin's own units. */
export interface SaleListCoinV21 { readonly coin: Address; readonly lot: bigint }
export interface SaleListV21 { readonly version: bigint; readonly coins: readonly SaleListCoinV21[]; readonly complete: boolean }
const MINIMUM_LOT = parseAbi(['function minimumLot() view returns (uint256)']);

/**
 * The release's sale list as a box created now would freeze it: `sellableVersion()`, each listed coin and its raw lot
 * at that version, a zero lot left out (a box token, or a coin not on the list at that version). WETH's lot is at
 * least the release's immutable `minimumLot` (the inbox's `lotSize`). `call` answers null for a revert or no data; an
 * unreadable version, count or minimum is a failed read (thrown), an unreadable row or a longer list `complete: false`.
 */
export async function readSaleListV21(reader: { call(to: Address, data: Hex): Promise<Hex | null> }, release: { readonly registry: Address; readonly inbox: Address; readonly weth: Address }): Promise<SaleListV21> {
  const read = async <T>(functionName: string, args: readonly unknown[] = []): Promise<T | null> => {
    const data = await reader.call(release.registry, encodeFunctionData({ abi: listingRegistryV2Abi, functionName, args } as never));
    return data === null ? null : decodeFunctionResult({ abi: listingRegistryV2Abi, functionName, data } as never) as T;
  };
  const version = await read<bigint>('sellableVersion');
  if (version === null) throw new Error('Sale list unavailable');
  const [count, minimumData] = await Promise.all([read<bigint>('sellableCount', [version]),
    reader.call(release.inbox, encodeFunctionData({ abi: MINIMUM_LOT, functionName: 'minimumLot' }))]);
  if (count === null || minimumData === null) throw new Error('Sale list unavailable');
  const minimum = decodeFunctionResult({ abi: MINIMUM_LOT, functionName: 'minimumLot', data: minimumData });
  const n = count < SALE_LIST_READ_LIMIT_V21 ? count : SALE_LIST_READ_LIMIT_V21;
  const rows = await Promise.all(Array.from({ length: Number(n) }, async (_, i): Promise<SaleListCoinV21 | null | undefined> => {
    const coin = await read<Address>('sellableToken', [BigInt(i)]);
    if (coin === null) return undefined;
    const listed = await read<bigint>('sellableLotAt', [coin, version]);
    if (listed === null) return undefined;
    if (listed === 0n) return null;
    const lot = coin.toLowerCase() === release.weth.toLowerCase() && listed < minimum ? minimum : listed;
    return { coin, lot };
  }));
  return { version, coins: rows.filter((row): row is SaleListCoinV21 => row !== null && row !== undefined), complete: count <= n && !rows.includes(undefined) };
}

/** KF-5: anyone sweeps the launch router's tax after graduation (into the pool's depth) or failure (into the claim pot). */
export function routerSweepCallV2(target: WriteTargetV2): WriteCallV2 {
  if (!target.launchRouter) throw new Error('router sweep needs the launch router');
  return { to: target.launchRouter, data: encodeFunctionData({ abi: launchRouterV2Abi, functionName: 'sweep' }), value: 0n };
}
