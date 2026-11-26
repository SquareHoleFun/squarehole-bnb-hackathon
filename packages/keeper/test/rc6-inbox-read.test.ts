import { expect, it, vi } from 'vitest';
import { encodeAbiParameters, keccak256, toHex, type Address, type Hex, type PublicClient } from 'viem';
import { ViemChain } from '../src/chain';
import { addr, options, quiet, time } from './support/v2';

it('COW-2 reads WETH without ETH, recorded approval and the clock at one snapshot; an unreadable coin is isolated', async () => {
  const weth = addr(20), other = addr(21), inbox = addr(8), registry = addr(10), listing = addr(11);
  let broken = false;
  let lotBroken = true;
  let held = 99n;
  let now = time;
  const immutable = vi.fn();
  const slots = new Map([weth, other].map(c => [toHex(BigInt(keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }], [c, 0n]))) + 3n, { size: 32 }), c]));
  const storage = vi.fn(async ({ address, slot, blockNumber }: { address: Address; slot: Hex; blockNumber: bigint }) => {
    expect(address).toBe(inbox); expect(blockNumber).toBe(99n);
    expect(slots.has(slot)).toBe(true);
    if (broken && slots.get(slot) === other) throw new Error('unreadable storage');
    return toHex(held === 0n ? 0n : 2n ** 200n, { size: 32 });
  });
  const client = {
    getChainId: async () => 11155111,
    request: async () => ({ number: '0x64', timestamp: toHex(now), baseFeePerGas: '0x1' }),
    getBlock: async () => ({ number: 100n, timestamp: time, baseFeePerGas: 1n }),
    getBalance: async () => 0n,
    getStorageAt: storage,
    readContract: async ({ address, functionName: fn, args = [], blockNumber }: { address: Address; functionName: string; args?: unknown[]; blockNumber: bigint }) => {
      expect(blockNumber).toBe(99n);
      if (['listingRegistry', 'listVersion', 'vaultRelayer', 'sellableCount', 'sellableToken', 'lotSize'].includes(fn)) immutable(fn);
      if (address === registry) {
        if (fn === 'boxCount') return 1n;
        if (fn === 'roleOf') return ({ 0: addr(1), 2: addr(2), 5: addr(3), 6: addr(6) })[String(args[1]) as '0'] ?? addr(0);
      }
      if (address === listing) {
        if (fn === 'sellableCount') { expect(args).toEqual([7n]); return 2n; }
        if (fn === 'sellableToken') return args[0] === 0n ? weth : other;
      }
      if (address === inbox) {
        if (fn === 'weth') return weth;
        if (fn === 'listingRegistry') return listing;
        if (fn === 'listVersion') return 7n;
        if (fn === 'vaultRelayer') return addr(50);
        if (fn === 'lotSize') { if (lotBroken && args[0] === other) throw new Error('lot read failed'); return 100n; }
        if (fn === 'oldestUnsoldAt') return time - 100n;
        if (fn === 'orderRegistered') return true;
      }
      if (address === weth || address === other || address === addr(9)) {
        if (fn === 'balanceOf') return address === addr(9) ? 0n : held;
        if (fn === 'allowance') { expect(args).toEqual([inbox, addr(50)]); return 2n ** 199n; }
        if (fn === 'decimals') return 18;
      }
      if (fn === 'q') return addr(9);
      if (fn === 'poolId') return toHex(0n, { size: 32 });
      if (fn === 'poolManager') return addr(7);
      if (fn === 'roleAddress') return args[0] === 8n ? inbox : addr(0);
      if (['failed', 'closed', 'graduated'].includes(fn)) return false;
      if (fn === 'gateOpen') return true;
      if (fn === 'openAt') return time;
      if (fn === 'deadline') return time + 100n;
      if (['closedAt', 'lastProtocolBlock', 'fitOwed', 'platformOwed', 'buyBackP', 'tBurnPending', 'buyersChoice', 'sellersChoice'].includes(fn)) return 0n;
      throw new Error(`unexpected ${fn}`);
    },
  } as unknown as PublicClient;
  const chain = new ViemChain({ ...options(), boxRegistry: registry }, client, addr(99), { public: null, private: null }, null, quiet);
  const read = async () => (await chain.read()).boxes[0]?.v2?.royalty;
  expect((await read())?.coins?.map(c => c.coin)).toEqual([weth]);
  lotBroken = false;
  expect(await read()).toMatchObject({ eth: 0n, wrapped: 99n, coins: [
    { coin: weth, lot: 100n, balance: 99n, approved: 2n ** 200n, allowance: 2n ** 199n, oldestUnsoldAt: time - 100n },
    { coin: other, lot: 100n, balance: 99n, approved: 2n ** 200n, allowance: 2n ** 199n, oldestUnsoldAt: time - 100n },
  ] });
  const firstListReads = immutable.mock.calls.length;
  held = 0n;
  // Cached positive state is refreshed before it can authorize another observe.
  expect((await read())?.coins?.every(c => c.balance === 0n)).toBe(true);
  const firstStateReads = storage.mock.calls.length;
  await read();
  expect(storage).toHaveBeenCalledTimes(firstStateReads);
  expect(immutable).toHaveBeenCalledTimes(firstListReads);
  now += 3600n;
  held = 99n;
  broken = true;
  expect((await read())?.coins?.map(c => c.coin)).toEqual([weth]);
});
