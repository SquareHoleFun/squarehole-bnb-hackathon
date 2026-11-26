import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionResult, keccak256, parseAbi, stringToHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Bot } from '../src/bot';
import { buildAction, validateManifest } from '../src/builders';
import { Journal, MemoryAppendStore } from '../src/journal';
import { ViemQuoteSource } from '../src/quotes';
import { safeTransaction } from '../src/safe';
import type { Manifest } from '../src/types';
import { addr, hash, lot, manifest, must, quote, snapshot } from './fixtures';

const reviewed = vi.hoisted(() => ({ entries: {} as Record<string, unknown> }));
vi.mock('../src/listing-route-manifest', () => ({
  get listingRouteManifest() { return reviewed.entries; },
}));
const account = privateKeyToAccount(keccak256(stringToHex('ROUTE af1 fake signer, no funds')));
const factory = addr(200n), registry = addr(50n);
const factoryAbi = parseAbi(['function factory() view returns (address)']);
const quoterAbi = parseAbi(['function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)']);

function revision(version: string, fees: number[], path = [addr(15n), manifest.weth]): Manifest {
  const route = must(manifest.routes[0]);
  if (route.kind !== 'v3') throw new Error('missing v3 fixture');
  return { ...structuredClone(manifest), policyVersion: `reviewed-${version}`,
    owners: { ...manifest.owners, bot: account.address.toLowerCase() as typeof account.address },
    routes: [{ ...route, version, fees, path, codeHash: keccak256('0x1234') }] };
}
function publish(m: Manifest) {
  const route = must(m.routes[0]);
  if (route.kind !== 'v3') throw new Error('missing v3 fixture');
  reviewed.entries = { [`1:${registry}:7:${route.tokenIn}`]: {
    chainId: '1', registry, listingId: '7', p: route.tokenIn, weth: m.weth, factory,
    routeId: route.id, routeVersion: route.version, path: route.path, fees: route.fees.map(String),
    pools: route.fees.map((_, i) => addr(201n + BigInt(i))),
  } };
}
const currentSnapshot = (nonce = 0n) => ({ ...snapshot(), nonce,
  owners: Object.values(revision('1', [3000]).owners),
  codeHashes: { ...snapshot().codeHashes, [addr(16n)]: keccak256('0x1234') } });
const request = (version = '1') => ({ kind: 'sale', lotId: 'lot-1', routeId: 'coin-eth', amount: 100n,
  quote: { ...quote(), routeVersion: version } });
function setup() {
  const old = revision('1', [3000]), next = revision('2', [500]); publish(old);
  const store = new MemoryAppendStore(), bot = new Bot(old, new Journal(store));
  bot.receive(lot());
  const sale = bot.plan(currentSnapshot(), request());
  return { old, next, store, bot, sale };
}
function adapters() {
  return { reader: { snapshot: async () => currentSnapshot(), simulate: vi.fn(async () => true) },
    service: { propose: vi.fn(async () => {}) },
    signer: { signDigest: vi.fn(async (digest: Hex) => account.sign({ hash: digest })) } };
}
const proof = (id: Hex, nonce: bigint) => ({ chainId: manifest.chainId, safe: manifest.safes.fit,
  status: 'success', canonical: true, effectsVerified: true, txHash: hash(300n + nonce), logIndex: 0n,
  safeTxHash: id, nonce, nonceAfter: nonce + 1n });
beforeEach(() => { reviewed.entries = {}; });

describe('SH-MN-07-ROUTE af1: historical replay versus current admission', () => {
  it('reopens the cross-review reproduction: a journaled v1-to-v2 migration followed by a committed 500-pip pin', () => {
    const { next, store, bot, sale } = setup();
    // Reproduce a migration already recorded before the current shared pin was compiled.
    reviewed.entries = {};
    bot.migrateManifest(next);
    publish(next);
    expect(validateManifest(next)).toEqual(next);
    const before = store.read();
    const restarted = new Bot(next, new Journal(store));
    expect(restarted.available('lot-1')).toBe(900n);
    expect(restarted.inspect().proposals).toEqual([sale]);
    expect(store.read()).toBe(before);
  });

  it('migrates after pin publication, preserves reservations and reconciles the original sale under its recorded policy', () => {
    const { next, store, bot, sale } = setup();
    const prefix = store.read(); publish(next);
    bot.migrateManifest(next);
    expect(store.read().startsWith(prefix)).toBe(true);
    const restarted = new Bot(next, new Journal(store));
    expect(restarted.inspect().proposals).toEqual([sale]);
    expect(restarted.available('lot-1')).toBe(900n);
    // A retired, already signed transaction can still land; its original minimum remains binding.
    expect(() => restarted.resolve(sale.id, { ...proof(sale.id, 0n), amountIn: 100n, amountOut: 197n })).toThrow(/minimum/);
    restarted.resolve(sale.id, { ...proof(sale.id, 0n), amountIn: 100n, amountOut: 210n });
    const settled = new Bot(next, new Journal(store));
    expect(settled.inspect().lots[0]).toMatchObject({ consumed: 100n, reserved: 0n });
    expect(settled.available('lot-1')).toBe(900n);
    expect(settled.available(`${sale.id}:output`)).toBe(210n);
    expect(() => settled.resolve(sale.id, { ...proof(sale.id, 0n), amountIn: 100n, amountOut: 210n })).toThrow(/resolved/);
    expect(settled.plan(currentSnapshot(1n), request('2')).draft.request).toMatchObject({ quote: { routeVersion: '2' } });
  });

  it('replays intermediate route revisions, pending cancellations and consumed nonces with only the latest pin', async () => {
    const { next, store, bot, sale } = setup();
    publish(next); bot.migrateManifest(next);
    const second = bot.plan(currentSnapshot(1n), request('2'));
    const latest = revision('3', [500, 3000], [addr(15n), addr(90n), manifest.weth]);
    publish(latest); bot.migrateManifest(latest);
    const restarted = new Bot(latest, new Journal(store));
    expect(restarted.inspect().proposals).toEqual([sale, second]);
    expect(restarted.available('lot-1')).toBe(800n);
    const cancel = restarted.planCancellation(sale.id, currentSnapshot());
    const pending = new Bot(latest, new Journal(store)), a = adapters();
    await pending.proposeCancellation(cancel.id, a.reader, a.service, a.signer);
    expect(a.signer.signDigest).toHaveBeenCalledWith(cancel.id);
    expect(a.service.propose).toHaveBeenCalledOnce();
    expect(pending.available('lot-1')).toBe(800n);
    pending.resolveCancellation(cancel.id, proof(cancel.id, 0n));
    const settled = new Bot(latest, new Journal(store));
    expect(settled.available('lot-1')).toBe(900n);
    expect(settled.inspect().lots[0]).toMatchObject({ consumed: 0n, reserved: 100n });
    for (const nonce of [0n, 1n]) expect(() => settled.plan(currentSnapshot(nonce), request('3'))).toThrow(/nonce/);
    expect(settled.plan(currentSnapshot(2n), request('3')).transaction.nonce).toBe(2n);
  });

  it('can reopen before migration for recovery, but refuses retired quotes, direct calldata, plans and submissions', async () => {
    const { old, next, store, bot, sale } = setup(); publish(next);
    const before = store.read(), a = adapters();
    const rpc = { getChainId: async () => 1, getBlock: async () => currentSnapshot().block,
      getCode: async () => '0x1234' as const, call: vi.fn() };
    await expect(new ViemQuoteSource(old, [], rpc, true).quote('coin-eth', 100n, currentSnapshot().block)).rejects.toThrow(/listing route/);
    expect(rpc.call).not.toHaveBeenCalled();
    expect(() => buildAction(old, currentSnapshot(), lot(), request())).toThrow(/listing route/);
    expect(() => safeTransaction(old, currentSnapshot(), sale.draft)).toThrow(/listing route/);
    expect(() => bot.plan(currentSnapshot(1n), request())).toThrow(/listing route/);
    await expect(bot.propose(sale.id, a.reader, a.service, a.signer)).rejects.toThrow(/listing route/);
    expect(a.reader.simulate).not.toHaveBeenCalled();
    expect(a.signer.signDigest).not.toHaveBeenCalled();
    expect(a.service.propose).not.toHaveBeenCalled();
    expect(store.read()).toBe(before);
    const restarted = new Bot(old, new Journal(store));
    expect(restarted.available('lot-1')).toBe(900n);
    expect(() => restarted.plan(currentSnapshot(1n), request())).toThrow(/listing route/);
    await expect(restarted.propose(sale.id, a.reader, a.service, a.signer)).rejects.toThrow(/listing route/);
    expect(store.read()).toBe(before);
    expect(restarted.planCancellation(sale.id, currentSnapshot()).transaction.nonce).toBe(0n);
  });

  it('admits a fresh quote and submission on the replacement route, never resubmitting the reserved retired trade', async () => {
    const { next, store, bot, sale } = setup(); publish(next); bot.migrateManifest(next);
    const restarted = new Bot(next, new Journal(store)), a = adapters();
    await expect(restarted.propose(sale.id, a.reader, a.service, a.signer)).rejects.toThrow(/quote binding/);
    expect(a.signer.signDigest).not.toHaveBeenCalled();
    expect(a.service.propose).not.toHaveBeenCalled();
    const rpc = { getChainId: async () => 1, getBlock: async () => currentSnapshot().block,
      getCode: async () => '0x1234' as const,
      call: vi.fn(async ({ to }: { to: string }) => ({ data: to === addr(16n)
        ? encodeFunctionResult({ abi: factoryAbi, functionName: 'factory', result: factory })
        : encodeFunctionResult({ abi: quoterAbi, functionName: 'quoteExactInput', result: [200n, [], [], 100000n] }) })) };
    const source = new ViemQuoteSource(next, [{ routeId: 'coin-eth', address: addr(43n), codeHash: keccak256('0x1234'), kind: 'v3' }], rpc, true);
    const q = await source.quote('coin-eth', 100n, currentSnapshot().block);
    expect(q.routeVersion).toBe('2');
    const current = restarted.plan(currentSnapshot(1n), { ...request('2'), quote: q });
    await restarted.propose(current.id, a.reader, a.service, a.signer);
    expect(a.signer.signDigest).toHaveBeenCalledWith(current.id);
    expect(a.service.propose).toHaveBeenCalledOnce();
    expect(new Bot(next, new Journal(store)).available('lot-1')).toBe(800n);
  });
});
