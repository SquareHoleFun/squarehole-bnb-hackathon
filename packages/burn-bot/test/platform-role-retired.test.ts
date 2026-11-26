import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, keccak256, stringToHex, zeroAddress, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { receiverV2Abi } from '../../chain/src/core/v2/abi-v2';
import { poolManagerAbi } from '../../chain/src/abi/poolManager';
import { Bot } from '../src/bot';
import { ViemChainReader, type ChainLog, type ReaderRpc } from '../src/chain';
import { safeReadAbi } from '../src/chain-abi';
import { parseRunnerConfig } from '../src/config';
import { contentHash, Journal, MemoryAppendStore, toWire } from '../src/journal';
import { runCycle } from '../src/runner';
import { lotSchema, roleSchema } from '../src/schema';
import { FakeSafeService } from '../src/service';
import { addr, hash, lot, manifest } from './fixtures';

// F164 D2 and F160 (SH-173): the bot has no platform role. F151: the mainnet platform Safe is 2-of-3.
const PLATFORM = addr(3n);
const account = privateKeyToAccount(keccak256(stringToHex('SH-173 platform-role fake signer, no funds')));
const noQuotes = { quote: async () => { throw new Error('no route in this fixture'); } };

/** Offline chain: box 2 pays FIT 1000 wei and, optionally, the platform Safe; that Safe is 2-of-3 on 1.5.0. */
function chain(platformPaid = 0n) {
  const code = '0x1234' as const, codeHash = keccak256(code);
  const base = structuredClone(manifest);
  const m = { ...base, chainId: 11155111n, owners: { ...base.owners, bot: account.address.toLowerCase() as Address },
    multiSend: { ...base.multiSend, codeHash }, safeConfigs: { fit: { ...base.safeConfigs.fit, codeHash, singletonCodeHash: codeHash } } };
  const block = { number: 100n, hash: hash(100n), timestamp: 3000000n };
  const touched = new Set<string>(), reads: string[] = [], logs: ChainLog[] = [];
  const rpc: ReaderRpc = {
    getChainId: async () => 11155111,
    getBlock: async r => r.blockNumber === undefined || r.blockNumber === 100n ? block
      : { number: r.blockNumber, hash: hash(r.blockNumber), timestamp: r.blockNumber * 30000n },
    getCode: async r => { touched.add(r.address); return r.blockNumber === 0n ? undefined : code; },
    getBalance: async r => { touched.add(r.address); return 10000n; },
    getStorageAt: async r => { touched.add(r.address); return BigInt(r.slot) === 0n ? hash(20n) : hash(0n); },
    readContract: async r => {
      touched.add(r.address); reads.push(r.functionName);
      const platform = r.address === PLATFORM;
      const values: Record<string, unknown> = {
        nonce: 0n, getThreshold: 2n, getOwners: platform ? [m.owners.founder, addr(33n), addr(34n)] : Object.values(m.owners),
        VERSION: platform ? '1.5.0' : '1.4.1', getModulesPaginated: [[], addr(1n)], balanceOf: 10000n,
        graduated: true, graduatedAt: 1n, failed: false, budget: 5n, totalBurned: 7n, totalEthSpent: 3n,
        poolManager: addr(60n), token: m.box0.fit, executor: m.box0.executor, receiver: addr(50n),
        coordinator: r.address === m.boxes[0]?.receiver ? addr(51n) : addr(52n),
        q: r.address === m.boxes[0]?.receiver ? m.boxes[0]?.p : zeroAddress,
        boxId: r.address === m.boxes[0]?.receiver || r.address === addr(51n) ? 1n : 2n,
        FIT_SAFE: m.safes.fit, PLATFORM_SAFE: PLATFORM, platformSafe: PLATFORM,
        fitOwed: 11n, platformOwed: 12n, platformHeld: 13n, graduationSettled: true,
      };
      if (r.functionName === 'receiver' && r.address !== m.box0.coordinator) return r.address === addr(51n) ? addr(12n) : addr(14n);
      if (!(r.functionName in values)) throw new Error(`unexpected fake read ${r.functionName}`);
      return values[r.functionName];
    },
    getLogs: async r => {
      touched.add(r.address);
      return logs.filter(l => l.address === r.address && l.blockNumber !== null && l.blockNumber >= r.fromBlock && l.blockNumber <= r.toBlock);
    },
    getTransaction: async () => { throw new Error('fake transaction not configured'); },
    getTransactionReceipt: async () => ({ status: 'success', blockNumber: 90n, blockHash: hash(90n), logs }),
    call: async r => { touched.add(r.to); return { data: encodeAbiParameters([{ type: 'bool' }], [true]) }; },
  };
  const event = (abi: Abi, name: string, address: Address, data: Hex, args: Record<string, unknown>, index: number) => ({
    address, topics: encodeEventTopics({ abi, eventName: name, args }) as [Hex, ...Hex[]], data,
    blockNumber: 90n, blockHash: hash(90n), transactionHash: hash(900n), logIndex: index, removed: false,
  });
  const word = (amount: bigint) => encodeAbiParameters([{ type: 'uint256' }], [amount]);
  const pay = (name: 'FitPaid' | 'PlatformPaid', safe: Address, amount: bigint, first: number) => [
    event(poolManagerAbi, 'Transfer', addr(60n), encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [addr(14n), amount]),
      { from: addr(14n), to: zeroAddress, id: 0n }, first),
    event(safeReadAbi, 'SafeReceived', safe, word(amount), { sender: addr(60n) }, first + 1),
    event(receiverV2Abi, name, addr(14n), word(amount), { safe }, first + 2),
  ];
  logs.push(...pay('FitPaid', m.safes.fit, 1000n, 0));
  if (platformPaid > 0n) logs.push(...pay('PlatformPaid', PLATFORM, platformPaid, 3));
  const reader = new ViemChainReader(m, rpc, { startBlock: 1n, logChunk: 100n, maxScanBlocks: 1000n });
  return { m, rpc, reader, touched, reads };
}

describe('the burn bot without a platform role (F164 D2, F160, F151)', () => {
  it('runs a full cycle while the platform Safe is 2-of-3 on 1.5.0, reading nothing of that Safe', async () => {
    const f = chain();
    const bot = new Bot(f.m, new Journal(new MemoryAppendStore()));
    const result = await runCycle({ bot, reader: f.reader, quotes: noQuotes, service: new FakeSafeService(), dryRun: true });
    expect(result.proposals.map(p => [p.draft.safe, p.draft.request.kind, p.draft.amountIn])).toEqual([[f.m.safes.fit, 'fund', 1000n]]);
    expect(result.waiting).toEqual([]);
    expect(f.touched.has(PLATFORM)).toBe(false);
    expect(f.reads.filter(name => /platform/i.test(name))).toEqual([]);
  });

  it('never turns a PlatformPaid receipt into inventory, and builds, simulates and posts only FIT Safe transactions', async () => {
    const f = chain(700n);
    const observed = await f.reader.observe();
    expect(observed.lots.map(l => [l.role, l.safe, l.asset, l.amount])).toEqual([['fit', f.m.safes.fit, zeroAddress, 1000n]]);
    expect(observed.quarantined ?? []).toEqual([]);
    const store = new MemoryAppendStore(), bot = new Bot(f.m, new Journal(store)), service = new FakeSafeService();
    const simulate = vi.spyOn(f.reader, 'simulate');
    const signer = { signDigest: vi.fn(async (digest: Hex) => account.sign({ hash: digest })) };
    const result = await runCycle({ bot, reader: f.reader, quotes: noQuotes, service, signer, dryRun: false });
    expect(result.proposals).toHaveLength(1);
    expect(simulate.mock.calls.length).toBeGreaterThan(0);
    expect(simulate.mock.calls.every(([safe]) => safe === f.m.safes.fit)).toBe(true);
    expect([...service.proposals.values()].map(p => [p.safe, p.sender, p.signature !== null])).toEqual([[f.m.safes.fit, f.m.owners.bot, true]]);
    expect(bot.inspect().lots.map(v => v.lot.safe)).toEqual([f.m.safes.fit]);
    expect(store.read()).not.toContain(`"${PLATFORM}"`);
    expect(f.touched.has(PLATFORM)).toBe(false);
  });

  it('refuses a configuration that still names the platform Safe or its pins', () => {
    const input = { manifest: { ...manifest, chainId: '11155111' }, rpcEnv: 'FAKE_RPC', serviceEnv: 'FAKE_SERVICE',
      startBlock: '1', logChunk: '100', maxScanBlocks: '10000', journal: '.cache/bot.sqlite', quoters: [] };
    expect(parseRunnerConfig(input).manifest.safes).toEqual({ fit: manifest.safes.fit });
    expect(() => parseRunnerConfig({ ...input, manifest: { ...input.manifest, safes: { ...manifest.safes, platform: PLATFORM } } })).toThrow(/platform/);
    expect(() => parseRunnerConfig({ ...input, manifest: { ...input.manifest,
      safeConfigs: { ...manifest.safeConfigs, platform: manifest.safeConfigs.fit } } })).toThrow(/platform/);
  });

  it('refuses the platform role on lots, and offers no cap, platform proposal or platform income entry point', () => {
    expect(roleSchema.safeParse('platform').success).toBe(false);
    expect(lotSchema.safeParse({ ...lot(), role: 'platform' }).success).toBe(false);
    const bot = new Bot(manifest, new Journal(new MemoryAppendStore()));
    expect(() => bot.receive({ ...lot(), role: 'platform', safe: PLATFORM })).toThrow();
    for (const name of ['planCap', 'proposeCap', 'resolveCap', 'platformIncome']) expect(name in bot).toBe(false);
    expect(Object.keys(bot.inspect()).sort()).toEqual(['cancellations', 'lots', 'proposals', 'quarantined']);
  });

  it.each(['cap-proposal', 'cap-retained', 'cap-resolution'])('refuses to replay a journal with a %s row', kind => {
    const store = new MemoryAppendStore();
    const current = new Bot(manifest, new Journal(new MemoryAppendStore())).manifest;
    new Journal(store).append(toWire({ kind, schemaVersion: '1', chainId: current.chainId, policyVersion: current.policyVersion,
      manifestHash: contentHash(current) }));
    expect(() => new Bot(manifest, new Journal(store))).toThrow(/unknown bot journal event/);
  });
});
