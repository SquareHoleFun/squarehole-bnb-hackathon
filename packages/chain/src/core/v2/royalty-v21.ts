/** RC5 royalties stay with each box. Reads are pinned to a canonical hash; claims never choose a recipient. */
import { decodeFunctionResult, encodeFunctionData, zeroAddress, type Address, type Hex } from 'viem';
import { listingRegistryV2Abi, receiverV2Abi, royaltyRouterV2Abi } from './abi-v2';
import type { WriteCallV2, WriteTargetV2 } from './write-calls-v2';
export interface RoyaltyStateV21 {
  readonly router: Address;
  readonly payee: Address;
  readonly balances: Readonly<Record<string, bigint>>;
  /** RC6 inbox: the frozen sellable-list version and listed or otherwise known coins (absent before RC6 reads). */
  readonly listVersion?: bigint;
  readonly coins?: readonly InboxCoinV21[];
  /** False when a held, known or listed coin could not be read or discovery exceeded the read bound. */
  readonly complete?: boolean;
}
/** One RC6 inbox coin at a canonical hash, in that coin's raw units; a zero lot has no standing order. */
export interface InboxCoinV21 {
  readonly coin: Address; readonly lot: bigint; readonly balance: bigint; readonly oldestUnsoldAt: bigint; readonly registered: boolean;
  /** Positive listed custody below its sale lot; absent in older snapshots. The clock may still be zero. */
  readonly belowOneLot?: boolean;
}
/** At most this many coin rows are read per box and block; omissions publish complete: false. */
export const INBOX_COIN_READ_LIMIT = 32n;
export async function readRoyaltyStateV21(reader: { callAt(to: Address, data: Hex, hash: Hex): Promise<Hex> }, router: Address, receiver: Address, p: Address, t: Address, hash: Hex): Promise<RoyaltyStateV21> {
  const [payeeData, wethData] = await Promise.all([
    reader.callAt(receiver, encodeFunctionData({ abi: receiverV2Abi, functionName: 'creatorPayee' }), hash),
    reader.callAt(router, encodeFunctionData({ abi: royaltyRouterV2Abi, functionName: 'weth' }), hash),
  ]);
  const payee = decodeFunctionResult({ abi: receiverV2Abi, functionName: 'creatorPayee', data: payeeData });
  const weth = decodeFunctionResult({ abi: royaltyRouterV2Abi, functionName: 'weth', data: wethData });
  const assets = [...new Set([zeroAddress, weth, p, t].map(a => a.toLowerCase() as Address))];
  // RC6RR-FC-1: heldBalance calls an outside coin's balanceOf, and the router refuses it (TokenUnreadable) when that
  // call reverts, answers a short word or needs more than READ_GAS. One such coin is left out as unknown.
  const rows = await Promise.all(assets.map(async (token): Promise<readonly [Address, bigint] | null> => {
    try {
      return [token, decodeFunctionResult({ abi: royaltyRouterV2Abi, functionName: 'heldBalance', data: await reader.callAt(router,
        encodeFunctionData({ abi: royaltyRouterV2Abi, functionName: 'heldBalance', args: [token] }), hash) })];
    } catch { return null; }
  }));
  const read = rows.filter((row): row is readonly [Address, bigint] => row !== null);
  return { router, payee, balances: Object.fromEntries(read), complete: read.length === rows.length };
}
/**
 * RC6 (F138): frozen-list coins with a positive lot, plus explicitly known coins even with no order/lot.
 * Every read uses the same canonical hash. Read failures and the shared row bound publish complete: false.
 * Arbitrary silent ERC-20 deposits cannot be enumerated; callers supply coins learned from receipts or custody.
 */
export async function readInboxCoinsV21(reader: { callAt(to: Address, data: Hex, hash: Hex): Promise<Hex> }, router: Address, hash: Hex, knownCoins: readonly Address[] = []): Promise<{ listVersion: bigint; coins: InboxCoinV21[]; complete: boolean }> {
  const read = async <T>(to: Address, abi: typeof royaltyRouterV2Abi | typeof listingRegistryV2Abi, functionName: string, args: readonly unknown[] = []): Promise<T> =>
    decodeFunctionResult({ abi, functionName, data: await reader.callAt(to, encodeFunctionData({ abi, functionName, args } as never), hash) } as never) as T;
  const [registry, listVersion] = await Promise.all([read<Address>(router, royaltyRouterV2Abi, 'listingRegistry'), read<bigint>(router, royaltyRouterV2Abi, 'listVersion')]);
  const count = BigInt(registry) === 0n ? 0n : await read<bigint>(registry, listingRegistryV2Abi, 'sellableCount', [listVersion]);
  const n = Number(count < INBOX_COIN_READ_LIMIT ? count : INBOX_COIN_READ_LIMIT);
  const listed = await Promise.all(Array.from({ length: n }, (_, i) =>
    read<Address>(registry, listingRegistryV2Abi, 'sellableToken', [BigInt(i)]).catch(() => undefined)));
  const known = new Set(knownCoins.map(coin => coin.toLowerCase()));
  const candidates = [...new Set([...known, ...listed.filter((coin): coin is Address => coin !== undefined).map(coin => coin.toLowerCase())])];
  // Bound all per-coin reads, including event-discovered in-kind coins. Omitted or unreadable rows are explicit.
  const selected = candidates.slice(0, Number(INBOX_COIN_READ_LIMIT));
  const rows = await Promise.all(selected.map(async (address): Promise<InboxCoinV21 | null | undefined> => {
    const coin = address as Address;
    try {
      const lot = await read<bigint>(router, royaltyRouterV2Abi, 'lotSize', [coin]);
      if (lot === 0n && !known.has(coin)) return null;
      const [balance, oldestUnsoldAt, registered] = await Promise.all([read<bigint>(router, royaltyRouterV2Abi, 'heldBalance', [coin]),
        read<bigint>(router, royaltyRouterV2Abi, 'oldestUnsoldAt', [coin]), read<boolean>(router, royaltyRouterV2Abi, 'orderRegistered', [coin])]);
      return { coin, lot, balance, oldestUnsoldAt, registered, belowOneLot: lot > 0n && balance > 0n && balance < lot };
    } catch { return undefined; }
  }));
  const coins = rows.filter((row): row is InboxCoinV21 => row !== null && row !== undefined);
  return { listVersion, coins, complete: count <= INBOX_COIN_READ_LIMIT && candidates.length <= selected.length && !listed.includes(undefined) && !rows.includes(undefined) };
}
/** The current payee signs; authorization and asset exclusions are checked again by the router. */
export function claimRoyaltyInKindCallV21(target: WriteTargetV2, token: Address): WriteCallV2 {
  if (!target.royaltyRouter || token.toLowerCase() === target.p.toLowerCase()) throw new Error('in-kind royalty needs a router and a non-price coin');
  return { to: target.royaltyRouter, data: encodeFunctionData({ abi: royaltyRouterV2Abi, functionName: 'claimInKind', args: [token] }), value: 0n };
}

/** Anyone can observe the selected coin's clock; no order registration, approval increase or recipient override. */
export function observeRoyaltyCoinCallV21(target: WriteTargetV2, coin: Address): WriteCallV2 {
  if (!target.royaltyRouter) throw new Error('royalty router required');
  return { to: target.royaltyRouter, data: encodeFunctionData({ abi: royaltyRouterV2Abi, functionName: 'observe', args: [coin] }), value: 0n };
}

/** Anyone can refresh. The on-chain receiver and handler fix all financial destinations. */
export function refreshRoyaltyOrderCallV21(target: WriteTargetV2, coin?: Address): WriteCallV2 {
  if (!target.royaltyRouter) throw new Error('royalty router required');
  return { to: target.royaltyRouter, data: encodeFunctionData({ abi: royaltyRouterV2Abi, functionName: 'refreshOrder', ...(coin ? { args: [coin] as const } : {}) }), value: 0n };
}
/** Canonical observations for the indexer/site: bigint amounts and timestamps throughout. */
export async function readRoyaltyCowStateV21(reader: { callAt(to: Address, data: Hex, hash: Hex): Promise<Hex> }, router: Address, hash: Hex) {
  const addressKeys = ['composableCow', 'settlement', 'cowHandler', 'vaultRelayer'] as const;
  const amountKeys = ['lotSize', 'oldestUnsoldAt'] as const;
  const [addresses, amounts, registered] = await Promise.all([
    Promise.all(addressKeys.map(async functionName => decodeFunctionResult({ abi: royaltyRouterV2Abi, functionName,
      data: await reader.callAt(router, encodeFunctionData({ abi: royaltyRouterV2Abi, functionName }), hash) }))),
    Promise.all(amountKeys.map(async functionName => decodeFunctionResult({ abi: royaltyRouterV2Abi, functionName,
      data: await reader.callAt(router, encodeFunctionData({ abi: royaltyRouterV2Abi, functionName }), hash) }))),
    reader.callAt(router, encodeFunctionData({ abi: royaltyRouterV2Abi, functionName: 'orderRegistered' }), hash),
  ]);
  return { composableCow: addresses[0], settlement: addresses[1], handler: addresses[2], vaultRelayer: addresses[3],
    lotSize: amounts[0], oldestUnsoldAt: amounts[1],
    orderRegistered: decodeFunctionResult({ abi: royaltyRouterV2Abi, functionName: 'orderRegistered', data: registered }) };
}

/** Per-coin snapshot and observation, including USDC's raw units. Every read uses the same canonical hash. */
export async function readRoyaltyCowCoinStateV21(reader: { callAt(to: Address, data: Hex, hash: Hex): Promise<Hex> }, router: Address, coin: Address, hash: Hex) {
  const keys = ['lotSize', 'oldestUnsoldAt', 'orderRegistered'] as const;
  const values = await Promise.all(keys.map(async functionName => decodeFunctionResult({ abi: royaltyRouterV2Abi, functionName,
    data: await reader.callAt(router, encodeFunctionData({ abi: royaltyRouterV2Abi, functionName, args: [coin] }), hash) })));
  const [registry, version] = await Promise.all([
    reader.callAt(router, encodeFunctionData({ abi: royaltyRouterV2Abi, functionName: 'listingRegistry' }), hash),
    reader.callAt(router, encodeFunctionData({ abi: royaltyRouterV2Abi, functionName: 'listVersion' }), hash),
  ]);
  return { coin, lotSize: values[0] as bigint, oldestUnsoldAt: values[1] as bigint, orderRegistered: values[2] as boolean,
    listingRegistry: decodeFunctionResult({ abi: royaltyRouterV2Abi, functionName: 'listingRegistry', data: registry }),
    listVersion: decodeFunctionResult({ abi: royaltyRouterV2Abi, functionName: 'listVersion', data: version }) };
}
