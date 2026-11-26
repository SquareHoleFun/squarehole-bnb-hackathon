/**
 * SH-RC7-SITE-INBOX (rc7 open item 11): the public upkeep a page may offer, decided from live reads before any button is
 * shown. The inbox's refresh and observe (COW-2's last piece), the release's creation-time sale list for the create
 * page, and the launch router's public sweep (KF-5). Amounts and times are bigint throughout.
 */
import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, erc20Abi, getAddress, keccak256, parseAbi, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { coordinatorV2Abi, launchRouterV2Abi, listingRegistryV2Abi, royaltyRouterV2Abi } from './abi-v2';
import { INBOX_MAX_LOTS_PER_HOUR_V21, SALE_LIST_READ_LIMIT_V21, inboxCoinSlotsV21, inboxUpkeepV21, readInboxCoinLiveV21, readSaleListV21, routerSweepCallV2, type InboxCoinLiveV21 } from './upkeep-v21';
import { assertSendableCallV2, type WriteTargetV2 } from './write-calls-v2';

const a = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const LOT = 100n;
const HOUR = 3_600n;
const NOW = 1_800_000_000n;
const live = (patch: Partial<InboxCoinLiveV21> = {}): InboxCoinLiveV21 => ({ coin: a(66), lot: LOT, balance: 0n, allowance: 0n, approved: 0n,
  hour: NOW / HOUR, spent: 0n, registered: false, oldestUnsoldAt: 0n, failed: false, now: NOW, ...patch });

describe('inboxUpkeepV21: what a public refresh or observe would do now', () => {
  it('nothing on a failed box or for a coin without a lot', () => {
    expect(inboxUpkeepV21(live({ balance: 5n * LOT, failed: true }))).toBeNull();
    expect(inboxUpkeepV21(live({ balance: 5n * LOT, lot: 0n }))).toBeNull();
  });

  it('an unregistered coin with whole lots registers them, rounded down; dust with no clock starts the clock', () => {
    expect(inboxUpkeepV21(live({ balance: 250n }))).toEqual({ kind: 'refresh', offered: 200n });
    expect(inboxUpkeepV21(live({ balance: 40n }))).toEqual({ kind: 'observe', reason: 'clock' });
    // Dust whose clock already runs: nothing to do (observing it again restarts nothing).
    expect(inboxUpkeepV21(live({ balance: 40n, oldestUnsoldAt: NOW - 86_400n }))).toBeNull();
    expect(inboxUpkeepV21(live({ balance: 0n }))).toBeNull();
  });

  it('a registered coin is refreshed only when it would approve more whole lots than its allowance', () => {
    const offered = live({ registered: true, balance: 500n, allowance: 200n, approved: 200n, oldestUnsoldAt: NOW - HOUR });
    expect(inboxUpkeepV21(offered)).toEqual({ kind: 'refresh', offered: 500n });
    // Already approved: nothing to do.
    expect(inboxUpkeepV21({ ...offered, allowance: 500n, approved: 500n })).toBeNull();
    // Gifts below a lot above the approval add nothing.
    expect(inboxUpkeepV21({ ...offered, balance: 299n, allowance: 200n })).toBeNull();
  });

  it('the hour’s budget of 20 lots: spent capacity is never offered again in the same hour, and resets in the next', () => {
    const exhausted = live({ registered: true, balance: 30n * LOT, allowance: 0n, approved: 0n, spent: INBOX_MAX_LOTS_PER_HOUR_V21 * LOT, oldestUnsoldAt: NOW - HOUR });
    expect(inboxUpkeepV21(exhausted)).toBeNull();
    // The same coin with no clock yet: the refresh would offer nothing, so the observation that starts the clock is offered.
    expect(inboxUpkeepV21({ ...exhausted, oldestUnsoldAt: 0n })).toEqual({ kind: 'observe', reason: 'clock' });
    // Recorded in an earlier hour: the budget is whole again, capped at 20 lots.
    expect(inboxUpkeepV21({ ...exhausted, hour: NOW / HOUR - 1n })).toEqual({ kind: 'refresh', offered: 20n * LOT });
    // Part of this hour spent: only the rest is offered.
    expect(inboxUpkeepV21({ ...exhausted, spent: 15n * LOT })).toEqual({ kind: 'refresh', offered: 5n * LOT });
  });

  it('an unrecorded sale (allowance below the recorded approval) is observed in its own hour, whatever the balance', () => {
    // 3 lots approved, 2 sold: the sale counts against the hour, and the 1 lot left is still approved.
    const sold = live({ registered: true, balance: LOT, allowance: LOT, approved: 3n * LOT, oldestUnsoldAt: NOW - HOUR });
    expect(inboxUpkeepV21(sold)).toEqual({ kind: 'observe', reason: 'sale' });
    expect(inboxUpkeepV21({ ...sold, balance: 0n, allowance: 0n })).toEqual({ kind: 'observe', reason: 'sale' });
    // A sale with whole lots waiting above the rest of the approval: the refresh observes it first, and offers them.
    expect(inboxUpkeepV21({ ...sold, balance: 4n * LOT })).toEqual({ kind: 'refresh', offered: 4n * LOT });
  });

  it('exact beyond 2^53', () => {
    const lot = 10n ** 30n;
    expect(inboxUpkeepV21(live({ lot, balance: 3n * lot + 1n }))).toEqual({ kind: 'refresh', offered: 3n * lot });
  });
});

describe('readInboxCoinLiveV21', () => {
  it('reads one coin at one block: lot, custody (WETH with the inbox’s ETH), allowance, the recorded approval, hour and spent', async () => {
    const router = a(8); const coordinator = a(1); const weth = a(12); const relayer = a(13); const usdc = a(14);
    const slots = inboxCoinSlotsV21(weth);
    const base = BigInt(keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [weth, 0n])));
    expect(slots).toEqual({ hour: toHex(base + 1n, { size: 32 }), spent: toHex(base + 2n, { size: 32 }), approved: toHex(base + 3n, { size: 32 }) });
    const blocks: bigint[] = [];
    const reader = {
      block: async () => ({ number: 77n, timestamp: NOW }),
      call: async (to: Address, data: Hex, block: bigint) => {
        blocks.push(block);
        if (to === coordinator) return encodeFunctionResult({ abi: coordinatorV2Abi, functionName: 'failed', result: false });
        if (to === weth || to === usdc) {
          expect(decodeFunctionData({ abi: erc20Abi, data })).toMatchObject({ functionName: 'allowance', args: [router, relayer] });
          return encodeFunctionResult({ abi: erc20Abi, functionName: 'allowance', result: 2n ** 200n });
        }
        expect(to).toBe(router);
        const d = decodeFunctionData({ abi: royaltyRouterV2Abi, data });
        const coin = (d.args as readonly Address[] | undefined)?.[0];
        switch (d.functionName) {
          case 'weth': return encodeFunctionResult({ abi: royaltyRouterV2Abi, functionName: 'weth', result: weth });
          case 'vaultRelayer': return encodeFunctionResult({ abi: royaltyRouterV2Abi, functionName: 'vaultRelayer', result: relayer });
          case 'lotSize': return encodeFunctionResult({ abi: royaltyRouterV2Abi, functionName: 'lotSize', result: 5n * 10n ** 16n } as never);
          case 'heldBalance': return encodeFunctionResult({ abi: royaltyRouterV2Abi, functionName: 'heldBalance', result: coin === zeroAddress ? 3n : 10n ** 17n });
          case 'orderRegistered': return encodeFunctionResult({ abi: royaltyRouterV2Abi, functionName: 'orderRegistered', result: true } as never);
          case 'oldestUnsoldAt': return encodeFunctionResult({ abi: royaltyRouterV2Abi, functionName: 'oldestUnsoldAt', result: NOW - 5n } as never);
          default: throw new Error(`unexpected ${d.functionName}`);
        }
      },
      storage: async (address: Address, slot: Hex, block: bigint) => {
        expect(address).toBe(router); blocks.push(block);
        const coin = [weth, usdc].map(inboxCoinSlotsV21).find((s) => Object.values(s).includes(slot));
        if (coin && slot === coin.hour) return toHex(NOW / HOUR, { size: 32 });
        if (coin && slot === coin.spent) return toHex(7n, { size: 32 });
        if (coin && slot === coin.approved) return toHex(2n ** 201n, { size: 32 });
        throw new Error('unexpected slot');
      },
    };
    expect(await readInboxCoinLiveV21(reader, router, coordinator, weth)).toEqual({ coin: weth, lot: 5n * 10n ** 16n, balance: 10n ** 17n + 3n,
      allowance: 2n ** 200n, approved: 2n ** 201n, hour: NOW / HOUR, spent: 7n, registered: true, oldestUnsoldAt: NOW - 5n, failed: false, now: NOW });
    expect(new Set(blocks)).toEqual(new Set([77n]));
    // Any other coin counts only its own custody, never the inbox's ETH.
    expect((await readInboxCoinLiveV21(reader, router, coordinator, usdc)).balance).toBe(10n ** 17n);
    // A storage word that is not one word is refused, never read as zero.
    await expect(readInboxCoinLiveV21({ ...reader, storage: async () => '0x' as Hex }, router, coordinator, weth)).rejects.toThrow();
  });
});

describe('readSaleListV21: the release’s sale list a new box copies now', () => {
  const registry = a(20); const inbox = a(30); const weth = a(12); const [usdc, link, none] = [a(21), a(22), a(23)];
  const MINIMUM = parseAbi(['function minimumLot() view returns (uint256)']);
  const reader = (rows: readonly Address[], lots: Readonly<Record<string, bigint | null>>, version = 5n) => ({ call: async (to: Address, data: Hex): Promise<Hex | null> => {
    if (to === inbox) return encodeFunctionResult({ abi: MINIMUM, functionName: 'minimumLot', result: 5n * 10n ** 16n });
    expect(to).toBe(registry);
    const d = decodeFunctionData({ abi: listingRegistryV2Abi, data });
    switch (d.functionName) {
      case 'sellableVersion': return encodeFunctionResult({ abi: listingRegistryV2Abi, functionName: 'sellableVersion', result: version });
      case 'sellableCount': expect(d.args).toEqual([version]); return encodeFunctionResult({ abi: listingRegistryV2Abi, functionName: 'sellableCount', result: BigInt(rows.length) });
      case 'sellableToken': { const row = rows[Number(d.args[0])]; return row ? encodeFunctionResult({ abi: listingRegistryV2Abi, functionName: 'sellableToken', result: row }) : null; }
      case 'sellableLotAt': {
        expect(d.args[1]).toBe(version);
        const lot = Object.entries(lots).find(([coin]) => coin.toLowerCase() === String(d.args[0]).toLowerCase())?.[1];
        return lot === null || lot === undefined ? null : encodeFunctionResult({ abi: listingRegistryV2Abi, functionName: 'sellableLotAt', result: lot });
      }
      default: throw new Error(`unexpected ${d.functionName}`);
    }
  } });

  it('lists each coin with its raw lot at the current version; WETH’s lot is at least the release minimum; a zero lot is left out', async () => {
    const list = await readSaleListV21(reader([weth, usdc, link, none], { [weth]: 10n ** 16n, [usdc]: 100_000_000n, [link]: 2n ** 200n, [none]: 0n }), { registry, inbox, weth });
    expect(list).toEqual({ version: 5n, complete: true, coins: [{ coin: weth, lot: 5n * 10n ** 16n }, { coin: usdc, lot: 100_000_000n }, { coin: link, lot: 2n ** 200n }] });
  });

  it('marks the list incomplete when a row cannot be read or the list is longer than the read bound', async () => {
    const partial = await readSaleListV21(reader([usdc, link], { [usdc]: 1n, [link]: null }), { registry, inbox, weth });
    expect(partial).toEqual({ version: 5n, complete: false, coins: [{ coin: usdc, lot: 1n }] });
    const many = Array.from({ length: Number(SALE_LIST_READ_LIMIT_V21) + 3 }, (_, i) => a(100 + i));
    const long = await readSaleListV21(reader(many, Object.fromEntries(many.map((coin) => [coin.toLowerCase(), 7n]))), { registry, inbox, weth });
    expect(long.complete).toBe(false);
    expect(long.coins).toHaveLength(Number(SALE_LIST_READ_LIMIT_V21));
  });

  it('an unreadable version or count is a failed read, never an empty list', async () => {
    const broken = { call: async () => null };
    await expect(readSaleListV21(broken, { registry, inbox, weth })).rejects.toThrow();
  });
});

describe('routerSweepCallV2 (KF-5)', () => {
  const target: WriteTargetV2 = { chainId: 1, coordinator: a(1), token: a(2), receiver: a(3), p: a(9), royaltyRouter: a(8), launchRouter: a(6) };
  it('prepares the launch router’s public sweep: no argument, no value, only at the prepared launch router', () => {
    const call = routerSweepCallV2(target);
    expect(call.to).toBe(a(6)); expect(call.value).toBe(0n);
    expect(decodeFunctionData({ abi: launchRouterV2Abi, data: call.data })).toMatchObject({ functionName: 'sweep' });
    expect(() => assertSendableCallV2(call, target, a(77))).not.toThrow();
    for (const to of [target.coordinator, target.royaltyRouter as Address, target.receiver]) expect(() => assertSendableCallV2({ ...call, to }, target, a(77))).toThrow();
    expect(() => assertSendableCallV2({ ...call, value: 1n }, target, a(77))).toThrow();
    expect(() => assertSendableCallV2({ ...call, data: `${call.data}00` }, target, a(77))).toThrow();
    expect(() => routerSweepCallV2({ ...target, launchRouter: undefined })).toThrow();
    expect(() => assertSendableCallV2(call, { ...target, launchRouter: undefined }, a(77))).toThrow();
    // The prepared role is one of the box's distinct, nonzero roles.
    for (const launchRouter of [zeroAddress, target.receiver]) expect(() => assertSendableCallV2(call, { ...target, launchRouter }, a(77))).toThrow();
  });
});
