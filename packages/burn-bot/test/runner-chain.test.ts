import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createPublicClient, custom, encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, parseAbi, zeroAddress, type Abi, type Address, type Hex } from 'viem';
import { ViemChainReader, type ChainLog, type ReaderRpc } from '../src/chain';
import { receiverModulesV21Abi, receiverV2Abi } from '../../chain/src/core/v2/abi-v2';
import { alchemistV21Abi } from '../../chain/src/core/v2/alchemist-v21';
import { runCycle } from '../src/runner';
import { FakeSafeService } from '../src/service';
import { Bot } from '../src/bot';
import { Journal, MemoryAppendStore } from '../src/journal';
import { fitBuybackExecutorAbi } from '../../chain/src/abi/fitBuybackExecutor';
import { boxTokenAbi } from '../../chain/src/abi/boxToken';
import { poolManagerAbi } from '../../chain/src/abi/poolManager';
import { boxReceiverAbi } from '../../chain/src/abi/boxReceiver';
import { safeReadAbi } from '../src/chain-abi';
import { addr, hash, lot, manifest, must, snapshot } from './fixtures';

export function chainFixture() {
  const code = '0x1234' as const, codeHash = keccak256(code);
  const m = { ...structuredClone(manifest), chainId: 11155111n };
  m.safeConfigs.fit = { ...m.safeConfigs.fit, codeHash, singletonCodeHash: codeHash };
  m.multiSend.codeHash = codeHash;
  const block = { number: 100n, hash: hash(100n), timestamp: 3000000n };
  const reads: string[] = [], scanned: string[] = [];
  const logs: Awaited<ReturnType<ReaderRpc['getLogs']>> = [];
  const rpc: ReaderRpc = {
    getChainId: async () => 11155111,
    getBlock: async request => request.blockNumber === undefined || request.blockNumber === 100n ? block
      : { number: request.blockNumber, hash: hash(request.blockNumber), timestamp: request.blockNumber * 30000n },
    getCode: async request => request.blockNumber === 0n ? undefined : code,
    getBalance: async () => 10000n,
    getStorageAt: async ({ slot }) => BigInt(slot) === 0n ? hash(20n) : hash(0n),
    readContract: async request => {
      expect(request.blockNumber).toBe(100n); reads.push(request.functionName);
      const values: Record<string, unknown> = {
        budget: 5n, totalBurned: 7n, totalEthSpent: 3n, nonce: 0n, getThreshold: 2n, getOwners: Object.values(m.owners),
        VERSION: '1.4.1', getModulesPaginated: [[], addr(1n)], balanceOf: 10000n,
        graduated: true, failed: false, claimState: [0n, 0n],
        poolManager: addr(60n), token: m.box0.fit, executor: m.box0.executor,
        coordinator: request.address === m.boxes[0]?.receiver ? addr(51n) : addr(52n),
        q: request.address === m.boxes[0]?.receiver ? m.boxes[0]?.p : zeroAddress,
        boxId: request.address === m.boxes[0]?.receiver || request.address === addr(51n) ? 1n : 2n,
        // Platform Safe, cap and box-0 ledger views are not answered: the bot must not read them (F164 D2).
        FIT_SAFE: m.safes.fit, fitOwed: 11n,
      };
      if (request.functionName === 'receiver' && request.address !== m.box0.coordinator) return request.address === addr(51n) ? addr(12n) : addr(14n);
      if (!(request.functionName in values)) throw new Error(`unexpected fake read ${request.functionName}`);
      return values[request.functionName];
    },
    getLogs: async request => {
      scanned.push(request.address);
      return logs.filter(l => l.address === request.address && l.blockNumber !== null && l.blockNumber >= request.fromBlock && l.blockNumber <= request.toBlock);
    },
    getTransaction: async () => { throw new Error('fake transaction not configured'); },
    getTransactionReceipt: async () => ({ status: 'success', blockNumber: 90n, blockHash: hash(90n), logs }),
    call: async () => ({ data: encodeAbiParameters([{ type: 'bool' }], [true]) }),
  };
  const event = (abi: Abi, name: string, address: Address, data: Hex, args: Record<string, unknown>, index: number) => ({
    address, topics: encodeEventTopics({ abi, eventName: name, args }) as [Hex, ...Hex[]], data,
    blockNumber: 90n, blockHash: hash(90n), transactionHash: hash(900n), logIndex: index, removed: false,
  });
  return { rpc, m, block, reads, scanned, logs, event };
}
// Exercise viem's formatter through an entirely offline JSON-RPC transport.
function useViemBlocks(f: ReturnType<typeof chainFixture>) {
  const client = createPublicClient({ transport: custom({ request: async ({ method, params }) => {
    expect(method).toBe('eth_getBlockByNumber');
    const tag = (params as [string, boolean])[0];
    const number = tag === 'finalized' || tag === 'latest' ? 100n : BigInt(tag);
    return { number: `0x${number.toString(16)}`, hash: hash(number),
      timestamp: `0x${(number * 30000n).toString(16)}`, parentHash: hash(number - 1n),
      gasLimit: '0x1c9c380', gasUsed: '0x0', transactions: [], uncles: [],
      miner: addr(99n), extraData: '0x', baseFeePerGas: '0x1' };
  } }) });
  f.rpc.getBlock = args => client.getBlock(args.blockNumber === undefined
    ? { blockTag: args.blockTag } : { blockNumber: args.blockNumber });
}
describe('finalized viem chain reader', () => {
  it('pins views, validates wiring and reads owed credits without treating them as receipts', async () => {
    const f = chainFixture(); const reader = new ViemChainReader(f.m, f.rpc, { startBlock: 1n, logChunk: 100n, maxScanBlocks: 1000n });
    const observed = await reader.observe();
    expect(observed.snapshots.fit.box0.graduated).toBe(true);
    expect(observed.credits[0]).toEqual({ boxId: '1', receiver: f.m.boxes[0]?.receiver, fitOwed: 11n });
    expect(observed.lots).toEqual([]);
    expect(f.reads).not.toContain('CONVERSION_SAFE');
    expect(f.reads.filter(name => /platform/i.test(name))).toEqual([]);
    f.rpc.getChainId = async () => 1;
    await expect(reader.observe()).rejects.toThrow(/chain/);
  });
  it('requires a matching actual transfer for paid credits and keeps the receipt block', async () => {
    const f = chainFixture();
    const amount = 9007199254740993000n;
    f.logs.push(f.event(receiverV2Abi, 'FitPaid', addr(14n), encodeAbiParameters([{ type: 'uint256' }], [amount]), { safe: f.m.safes.fit }, 2));
    const reader = new ViemChainReader(f.m, f.rpc, { startBlock: 1n, logChunk: 100n, maxScanBlocks: 1000n });
    await expect(reader.observe()).rejects.toThrow(/receipt transfer/);
    f.logs.push(f.event(safeReadAbi, 'SafeReceived', f.m.safes.fit, encodeAbiParameters([{ type: 'uint256' }], [amount]), { sender: addr(60n) }, 1));
    f.logs.push(f.event(poolManagerAbi, 'Transfer', addr(60n), encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [addr(14n), amount]),
      { from: addr(14n), to: zeroAddress, id: 0n }, 0));
    const observation = await reader.observe();
    expect(observation.lots[0]).toMatchObject({ role: 'fit', asset: zeroAddress, amount });
    expect(observation.lots[0]?.source.timestamp).toBe(2700000n);
    expect(observation.lots[0]).not.toHaveProperty('epoch');
  });
  it('refuses incomplete receiver history', async () => {
    const f = chainFixture();
    const reader = new ViemChainReader(f.m, f.rpc, { startBlock: 1n, logChunk: 100n, maxScanBlocks: 1000n });
    await reader.observe();
    f.rpc.getCode = async () => '0x1234';
    await expect(reader.observe()).rejects.toThrow(/history/);
  });
  it('resolves a funded Safe execution only with exact event effects and consumed nonce', async () => {
    const f = chainFixture();
    const bot = new Bot(f.m, new Journal(new MemoryAppendStore()));
    bot.receive({ ...lot('fit', zeroAddress), chainId: f.m.chainId });
    const s = { ...snapshot(), block: f.block, chainId: f.m.chainId, ...{ codeHashes: { ...snapshot().codeHashes,
      [f.m.safes.fit]: f.m.safeConfigs.fit.codeHash, [f.m.safeConfigs.fit.singleton]: f.m.safeConfigs.fit.singletonCodeHash,
      [f.m.multiSend.address]: f.m.multiSend.codeHash } } };
    const proposal = bot.plan(s, { kind: 'fund', lotId: 'lot-1', amount: 100n });
    const t = proposal.transaction;
    f.rpc.getTransaction = async () => ({ to: f.m.safes.fit, input: encodeFunctionData({ abi: safeReadAbi, functionName: 'execTransaction', args: [t.to, t.value, t.data, t.operation, t.safeTxGas, t.baseGas, t.gasPrice, t.gasToken, t.refundReceiver, '0x'] }) });
    f.logs.push(f.event(safeReadAbi, 'ExecutionSuccess', f.m.safes.fit,
      encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [proposal.id, 0n]), {}, 3));
    const reader = new ViemChainReader(f.m, f.rpc, { startBlock: 1n, logChunk: 100n, maxScanBlocks: 1000n });
    const observation = await reader.observe(); observation.snapshots.fit.nonce = 1n;
    await expect(reader.reconcile(bot, observation)).rejects.toThrow(/funding/);
    f.logs.push(f.event(fitBuybackExecutorAbi, 'BudgetFunded', f.m.box0.executor,
      encodeAbiParameters([{ type: 'uint256' }], [100n]), { from: f.m.safes.fit }, 2));
    const results = await reader.reconcile(bot, observation);
    expect(results).toHaveLength(1);
    bot.resolve(proposal.id, results[0]?.result);
    expect(bot.available('lot-1')).toBe(900n);
    expect(await reader.reconcile(bot, observation)).toEqual([]);
  });

  it('refuses a head simulation that has become stale', async () => {
    const f = chainFixture();
    const reader = new ViemChainReader(f.m, f.rpc, { startBlock: 1n, logChunk: 100n, maxScanBlocks: 1000n });
    await reader.observe();
    const t = { to: f.m.box0.executor, value: 1n, data: '0x' as const, operation: 0 as const,
      safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: zeroAddress, refundReceiver: zeroAddress, nonce: 0n };
    let calls = 0;
    f.rpc.call = async () => { calls++; if (calls === 2) throw new Error('fake stale deadline'); return { data: encodeAbiParameters([{ type: 'bool' }], [true]) }; };
    expect(await reader.simulate(f.m.safes.fit, t, f.block, 200000n)).toBe(false);
    expect(calls).toBe(2);
  });

  it('reports the executor budget apart from v2 spendable income and reads no box-0 platform payout', async () => {
    const f = chainFixture();
    f.logs.push(f.event(boxReceiverAbi, 'PlatformPaid', addr(50n), encodeAbiParameters([{ type: 'uint256' }], [17n]), { safe: addr(3n) }, 0));
    const reader = new ViemChainReader(f.m, f.rpc, { startBlock: 1n, logChunk: 100n, maxScanBlocks: 1000n });
    const observation = await reader.observe();
    expect(observation.executor).toMatchObject({ budget: 5n, totalBurned: 7n, totalEthSpent: 3n });
    expect(observation.lots).toHaveLength(0);
    expect(observation).not.toHaveProperty('box0');
    expect(f.scanned).not.toContain(addr(50n));
  });

  it('simulates finalized and head blocks formatted by viem', async () => {
    const f = chainFixture(); useViemBlocks(f);
    const reader = new ViemChainReader(f.m, f.rpc, { startBlock: 1n, logChunk: 100n, maxScanBlocks: 1000n });
    const tx = { to: f.m.box0.executor, value: 1n, data: '0x' as const, operation: 0 as const,
      safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: zeroAddress, refundReceiver: zeroAddress, nonce: 0n };
    expect(await reader.simulate(f.m.safes.fit, tx, f.block, 200000n)).toBe(true);
  });

  it('reconciles a burn with viem-formatted execution blocks', async () => {
    const f = chainFixture();
    const reader = new ViemChainReader(f.m, f.rpc, { startBlock: 1n, logChunk: 100n, maxScanBlocks: 1000n });
    const observation = await reader.observe(), bot = new Bot(f.m, new Journal(new MemoryAppendStore()));
    bot.receive({ ...lot('fit', f.m.box0.fit), chainId: f.m.chainId });
    const p = bot.plan(observation.snapshots.fit, { kind: 'burn', lotId: 'lot-1', amount: 1000n });
    const t = p.transaction;
    f.rpc.getTransaction = async () => ({ to: f.m.safes.fit, input: encodeFunctionData({ abi: safeReadAbi,
      functionName: 'execTransaction', args: [t.to, t.value, t.data, t.operation, t.safeTxGas, t.baseGas,
        t.gasPrice, t.gasToken, t.refundReceiver, '0x'] }) });
    f.logs.push(f.event(safeReadAbi, 'ExecutionSuccess', f.m.safes.fit,
      encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [p.id, 0n]), {}, 3));
    f.logs.push(f.event(boxTokenAbi, 'Transfer', f.m.box0.fit, encodeAbiParameters([{ type: 'uint256' }], [1000n]), { from: f.m.safes.fit, to: zeroAddress }, 2));
    const read = f.rpc.readContract;
    f.rpc.readContract = args => args.functionName === 'totalSupply'
      ? Promise.resolve(args.blockNumber === 89n ? 2000n : 1000n) : read(args);
    observation.snapshots.fit.nonce = 1n;
    useViemBlocks(f);
    const results = await reader.reconcile(bot, observation);
    expect(results).toHaveLength(1);
    expect(results[0]?.result.status).toBe('success');
  });

  it('matches bounded native and ERC20 FitPaid claim redemptions, never reusing a take', async () => {
    const name = 'FitPaid';
    for (const asset of [zeroAddress, addr(13n)]) {
      const f = chainFixture(), receiver = asset === zeroAddress ? addr(14n) : addr(12n);
      const safe = f.m.safes.fit;
      const part = (1n << 127n) - 1n, amount = part * 3n + 9n;
      for (const [i, value] of [part, part, part, 9n].entries()) {
        f.logs.push(f.event(poolManagerAbi, 'Transfer', addr(60n), encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [receiver, value]),
          { from: receiver, to: zeroAddress, id: BigInt(asset) }, i * 2));
        f.logs.push(asset === zeroAddress
          ? f.event(safeReadAbi, 'SafeReceived', safe, encodeAbiParameters([{ type: 'uint256' }], [value]), { sender: addr(60n) }, i * 2 + 1)
          : f.event(boxTokenAbi, 'Transfer', asset, encodeAbiParameters([{ type: 'uint256' }], [value]), { from: addr(60n), to: safe }, i * 2 + 1));
      }
      f.logs.push(f.event(receiverV2Abi, name, receiver, encodeAbiParameters([{ type: 'uint256' }], [amount]), { safe }, 8));
      const reader = new ViemChainReader(f.m, f.rpc, { startBlock: 1n, logChunk: 100n, maxScanBlocks: 1000n });
      expect((await reader.observe()).lots[0]).toMatchObject({ asset, amount, safe });
      // A second payment cannot appropriate the first payment's burn/take pairs.
      f.logs.push(f.event(receiverV2Abi, name, receiver, encodeAbiParameters([{ type: 'uint256' }], [amount]), { safe }, 9));
      await expect(reader.observe()).rejects.toThrow(/receipt transfer/);
    }
  });

  it.each(['receiver-sender', 'wrong-claim-owner', 'zero-manager', 'oversized-part'] as const)('rejects %s payment evidence', async fault => {
    const f = chainFixture(), receiver = addr(14n), safe = f.m.safes.fit;
    const amount = fault === 'oversized-part' ? 1n << 127n : 17n;
    f.logs.push(f.event(poolManagerAbi, 'Transfer', addr(60n), encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [receiver, amount]),
      { from: fault === 'wrong-claim-owner' ? addr(12n) : receiver, to: zeroAddress, id: 0n }, 0));
    f.logs.push(f.event(safeReadAbi, 'SafeReceived', safe, encodeAbiParameters([{ type: 'uint256' }], [amount]),
      { sender: fault === 'receiver-sender' ? receiver : addr(60n) }, 1));
    f.logs.push(f.event(receiverV2Abi, 'FitPaid', receiver, encodeAbiParameters([{ type: 'uint256' }], [amount]), { safe }, 2));
    if (fault === 'zero-manager') {
      const read = f.rpc.readContract;
      f.rpc.readContract = args => args.functionName === 'poolManager' ? Promise.resolve(zeroAddress) : read(args);
    }
    const reader = new ViemChainReader(f.m, f.rpc, { startBlock: 1n, logChunk: 100n, maxScanBlocks: 1000n });
    await expect(reader.observe()).rejects.toThrow(/receipt transfer|PoolManager/);
  });

  it.each(['before', 'after'] as const)('admits a FitPaid receipt exactly once after an interruption %s its journal append', async boundary => {
    const f = chainFixture(), amount = 1000n;
    let armed = false;
    class InterruptedStore extends MemoryAppendStore {
      override append(expected: string, line: string) {
        const hit = armed && (JSON.parse(line) as { record: { kind: string } }).record.kind === 'receipt';
        if (hit) armed = false;
        if (hit && boundary === 'before') throw new Error('fake interrupted append');
        super.append(expected, line);
        if (hit) throw new Error('fake interrupted append');
      }
    }
    f.logs.push(
      f.event(poolManagerAbi, 'Transfer', addr(60n), encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [addr(14n), amount]),
        { from: addr(14n), to: zeroAddress, id: 0n }, 0),
      f.event(safeReadAbi, 'SafeReceived', f.m.safes.fit, encodeAbiParameters([{ type: 'uint256' }], [amount]), { sender: addr(60n) }, 1),
      f.event(receiverV2Abi, 'FitPaid', addr(14n), encodeAbiParameters([{ type: 'uint256' }], [amount]), { safe: f.m.safes.fit }, 2));
    const store = new InterruptedStore();
    const reader = new ViemChainReader(f.m, f.rpc, { startBlock: 1n, logChunk: 100n, maxScanBlocks: 1000n });
    const options = { reader, service: new FakeSafeService(), dryRun: true,
      quotes: { quote: async () => { throw new Error('unused quote'); } } };
    armed = true;
    await expect(runCycle({ ...options, bot: new Bot(f.m, new Journal(store)) })).rejects.toThrow('fake interrupted append');
    const replay = new Bot(f.m, new Journal(store));
    const recovered = await runCycle({ ...options, bot: replay });
    expect(replay.inspect().lots.map(v => [v.lot.id, v.lot.role, v.lot.amount])).toEqual([[`${hash(900n)}:2`, 'fit', amount]]);
    expect(recovered.proposals.map(p => [p.draft.request.kind, p.draft.amountIn])).toEqual([['fund', amount]]);
    await runCycle({ ...options, bot: new Bot(f.m, new Journal(store)) });
    const records = new Journal(store).entries.map(e => e.record as { kind: string });
    expect(records.filter(e => e.kind === 'receipt')).toHaveLength(1);
  });

});

/** RC5-B: pool dust is box property. Neither old nor new dust events fund Safe inventory. */
describe('RC5 dust stays outside FIT inventory', () => {
  const MODULE = addr(71n), EXECUTOR = addr(72n), MANAGER = addr(60n), HOOK = addr(73n);
  const word = (amount: bigint) => encodeAbiParameters([{ type: 'uint256' }], [amount]);
  const oldAbi = parseAbi(['event DustForwarded(address indexed receiver,address indexed safe,address indexed asset,uint256 amount)']);
  const depthAbi = parseAbi(['event DustToDepth(address indexed receiver,address indexed hook,address indexed asset,uint256 amount)']);
  function dustFixture(native: boolean) {
    const f = chainFixture(), box = must(f.m.boxes[native ? 1 : 0]), read = f.rpc.readContract;
    f.rpc.readContract = async args => {
      if (args.functionName === 'sideModule') return [MODULE, keccak256('0x1234')];
      if (args.address === MODULE) {
        const values: Record<string, unknown> = { executor: EXECUTOR, executorCodeHash: keccak256('0x1234'), priceCoin: box.p, poolManager: MANAGER };
        return values[args.functionName];
      }
      return read(args);
    };
    const claim = (caller: Address, from: Address, to: Address, index: number) => f.event(poolManagerAbi, 'Transfer', MANAGER,
      encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [caller, 10n]), { from, to, id: BigInt(box.p) }, index);
    const executed = (index: number) => f.event(receiverModulesV21Abi, 'ModuleExecuted', box.receiver, word(10n), { sellers: false, module: MODULE }, index);
    const reader = () => new ViemChainReader(f.m, f.rpc, { startBlock: 1n, logChunk: 100n, maxScanBlocks: 1000n });
    return { f, box, claim, executed, reader };
  }
  it.each([false, true])('never admits even fully authenticated legacy dust (native P: %s)', async native => {
    const d = dustFixture(native), { f, box } = d;
    f.logs.push(d.claim(box.receiver, box.receiver, MODULE, 0), d.claim(MODULE, MODULE, EXECUTOR, 1),
      d.claim(EXECUTOR, EXECUTOR, zeroAddress, 2),
      native ? f.event(safeReadAbi, 'SafeReceived', f.m.safes.fit, word(10n), { sender: MANAGER }, 3)
        : f.event(boxTokenAbi, 'Transfer', box.p, word(10n), { from: MANAGER, to: f.m.safes.fit }, 3),
      f.event(oldAbi, 'DustForwarded', MODULE, word(10n), { receiver: box.receiver, safe: f.m.safes.fit, asset: box.p }, 4), d.executed(5));
    expect((await d.reader().observe()).lots).toEqual([]);
  });
  it.each([false, true])('ignores depth claims and conversions while admitting ordinary FIT fees (native P: %s)', async native => {
    const d = dustFixture(native), { f, box } = d;
    f.logs.push(d.claim(box.receiver, box.receiver, MODULE, 0), d.claim(MODULE, MODULE, EXECUTOR, 1),
      d.claim(EXECUTOR, EXECUTOR, HOOK, 2),
      f.event(depthAbi, 'DustToDepth', MODULE, word(10n), { receiver: box.receiver, hook: HOOK, asset: box.p }, 3), d.executed(4),
      f.event(alchemistV21Abi, 'PileConverted', MODULE, encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [10n, 37n]),
        { receiver: box.receiver, pile: addr(74n), asset: addr(75n) }, 5), d.executed(6));
    f.logs.push(d.claim(box.receiver, box.receiver, zeroAddress, 7),
      native ? f.event(safeReadAbi, 'SafeReceived', f.m.safes.fit, word(10n), { sender: MANAGER }, 8)
        : f.event(boxTokenAbi, 'Transfer', box.p, word(10n), { from: MANAGER, to: f.m.safes.fit }, 8),
      f.event(receiverV2Abi, 'FitPaid', box.receiver, word(10n), { safe: f.m.safes.fit }, 9));
    const observed = await d.reader().observe();
    expect(observed.lots.map(l => [l.id, l.amount, l.asset])).toEqual([[`${hash(900n)}:9`, 10n, box.p]]);
    const bot = new Bot(f.m, new Journal(new MemoryAppendStore()));
    for (const cycle of [observed, await d.reader().observe()]) for (const l of cycle.lots) if (!bot.hasReceipt(l)) bot.receive(l);
    expect(bot.inspect().lots.map(v => v.lot.amount)).toEqual([10n]);
  });
  it.each([false, true])('ignores the real recorded dust vector (canonical receipt: %s)', async canonical => {
    const d = dustFixture(false);
    const raw = JSON.parse(readFileSync(new URL('./vectors/alchemist-dust-recorded.json', import.meta.url), 'utf8')) as Pick<ChainLog, 'address' | 'topics' | 'data'>[];
    expect(raw).toHaveLength(7);
    const addresses = [[must(raw[0]).address, MANAGER], [must(raw[3]).address, d.box.p],
      [must(raw[5]).address, MODULE], [must(raw[6]).address, d.box.receiver],
      [`0x${must(must(raw[1]).topics[2]).slice(-40)}`, EXECUTOR],
      [`0x${must(must(raw[5]).topics[2]).slice(-40)}`, HOOK]];
    const relocate = (value: string): Hex => {
      let result = value.toLowerCase();
      for (const [from, to] of addresses) result = result.replaceAll(must(from).slice(2).toLowerCase(), must(to).slice(2));
      return result as Hex;
    };
    const logs = raw.filter((_, i) => !canonical || (i !== 2 && i !== 3)).map((log, logIndex) => ({
      address: relocate(log.address), topics: log.topics.map(relocate), data: relocate(log.data),
      blockNumber: 90n, blockHash: hash(90n), transactionHash: hash(900n), logIndex, removed: false,
    }));
    d.f.logs.push(...logs);
    expect((await d.reader().observe()).lots).toEqual([]);
  });
});
