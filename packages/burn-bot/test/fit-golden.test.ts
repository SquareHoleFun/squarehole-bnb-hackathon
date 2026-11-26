import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, stringToHex, zeroAddress,
  type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { receiverV2Abi } from '../../chain/src/core/v2/abi-v2';
import { boxTokenAbi } from '../../chain/src/abi/boxToken';
import { fitBuybackExecutorAbi } from '../../chain/src/abi/fitBuybackExecutor';
import { poolManagerAbi } from '../../chain/src/abi/poolManager';
import { Bot } from '../src/bot';
import { ViemChainReader, type ChainObservation, type ReaderRpc } from '../src/chain';
import { safeReadAbi } from '../src/chain-abi';
import { Journal, MemoryAppendStore } from '../src/journal';
import { runCycle, type ReconciledExecution, type RunnerReader } from '../src/runner';
import { FakeSafeService } from '../src/service';
import type { Manifest, Quote, ReceiptLot, SafeTransaction, Snapshot } from '../src/types';
import { addr, hash, lot, manifest, quote, snapshot } from './fixtures';

/*
 * SH-173 golden: the FIT Safe's decisions (proposals, Safe transactions and hashes, signed service payloads,
 * simulations, waiting reasons, journal rows and the replayed state) on fixed inputs. The JSON was written by
 * the code before the platform role was removed (SH_BOT_WRITE_GOLDEN=1) and is compared, unchanged, after it.
 */
const GOLDEN = new URL('./fixtures/fit-golden.json', import.meta.url);
const FIT = manifest.safes.fit;
// The platform Safe's address on the fake chain: receivers name it and it answers as a deployed Safe.
const PLATFORM = addr(3n);

type Json = null | boolean | string | Json[] | { [key: string]: Json };
function plain(value: unknown): Json {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'bigint' || typeof value === 'number') return value.toString();
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === 'object') {
    const out: Record<string, Json> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : 1)) {
      if (item !== undefined) out[key] = plain(item);
    }
    return out;
  }
  throw new Error('unexpected golden value');
}
/*
 * Fields the platform-role removal changes by design, never a FIT decision: the wall clock, the manifest hash
 * (the manifest loses its platform keys), the platform cap's receipt epoch on each lot, the runner's rows about
 * the platform Safe, and its platform reports (owed platform credit, box 0's receiver state).
 */
function normalize(value: Json): Json {
  if (Array.isArray(value)) return value.map(normalize);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, Json> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'recordedUtc' || key === 'manifestHash' || key === 'epoch' || key === 'platformOwed') continue;
    out[key] = normalize(item);
  }
  return out;
}
function journal(store: MemoryAppendStore): Json[] {
  return new Journal(store).entries.map(entry => plain(entry.record) as Record<string, Json>)
    .filter(r => !(r.kind === 'runner-reconciliation' && (r.detail as Record<string, Json>).safe !== FIT))
    .map(r => {
      if (r.kind !== 'runner-cycle') return normalize(r);
      const detail = { ...(r.detail as Record<string, Json>) };
      delete detail.box0; // the cycle's report of box 0's receiver (graduation time, owed and held platform money)
      return normalize({ ...r, detail });
    });
}
function state(bot: Bot): Json {
  const { caps, epochs, ...rest } = bot.inspect() as Record<string, unknown>;
  // A FIT-only run leaves the retired platform ledgers empty; anything else must show up as a difference.
  return normalize(plain({ ...rest, ...(Array.isArray(caps) && caps.length === 0 ? {} : { caps }),
    ...(Array.isArray(epochs) && epochs.length === 0 ? {} : { epochs }),
    available: Object.fromEntries(bot.inspect().lots.map(v => [v.lot.id, bot.available(v.lot.id)])) }));
}
const result = (value: unknown) => normalize(plain(value));

const signerAccount = privateKeyToAccount(keccak256(stringToHex('SH-173 FIT golden fake signer, no funds')));
const signer = { signDigest: async (digest: Hex) => signerAccount.sign({ hash: digest }) };
const source = (n: bigint) => ({ ...lot().source, txHash: hash(500n + n), logIndex: n });
const fitLot = (id: string, asset: Address, n: bigint): ReceiptLot => ({ ...lot('fit', asset, id), source: source(n) });
const quotes = (block: Snapshot['block']) => ({
  quote: async (routeId: string, amount: bigint): Promise<Quote> => {
    const q = quote(routeId);
    return { ...q, amountIn: amount, quotedOut: routeId === 'weth-eth' ? amount : amount * 2n, block, deadline: block.timestamp + 200n };
  },
});

function fakeReader(observed: () => ChainObservation, simulations: Json[], refuse = new Set<number>(),
  reconciled: () => ReconciledExecution[] = () => []): RunnerReader {
  return {
    observe: async () => observed(),
    snapshot: async () => observed().snapshots.fit,
    simulate: async (safe: Address, tx: SafeTransaction, block: Snapshot['block'], gas: bigint) => {
      simulations.push(plain({ safe, tx, block, gas }));
      return !refuse.has(simulations.length);
    },
    reconcile: async () => reconciled(),
  };
}

async function dryFakeReader() {
  const m = manifest, store = new MemoryAppendStore(), simulations: Json[] = [];
  const fit = snapshot('fit');
  fit.box0 = { ...fit.box0, graduated: false };
  const observation = (): ChainObservation => ({ snapshots: { fit }, credits: [],
    lots: [fitLot('eth-1', zeroAddress, 1n), fitLot('fit-1', m.box0.fit, 2n), fitLot('coin-1', addr(15n), 3n),
      fitLot('weth-1', m.weth, 4n), fitLot('p-1', addr(13n), 5n)],
    quarantined: [{ lot: { ...fitLot('q-1', addr(99n), 6n) }, reason: 'unsupported-asset' as const }] });
  // Simulation 2 (the WETH unwrap) is refused once: it waits, then plans in the next cycle.
  const reader = fakeReader(observation, simulations, new Set([2]));
  const service = new FakeSafeService();
  const cycles: Json[] = [];
  let bot = new Bot(m, new Journal(store));
  cycles.push(result(await runCycle({ bot, reader, quotes: quotes(fit.block), service, dryRun: true, allowMainnet: true })));
  fit.box0 = { ...fit.box0, graduated: true };
  cycles.push(result(await runCycle({ bot, reader, quotes: quotes(fit.block), service, dryRun: true, allowMainnet: true })));
  bot = new Bot(m, new Journal(store));
  cycles.push(result(await runCycle({ bot, reader, quotes: quotes(fit.block), service, dryRun: true, allowMainnet: true })));
  return { cycles, simulations, journal: journal(store), replay: state(new Bot(m, new Journal(store))),
    service: plain([...service.proposals.values()]) };
}

async function liveFakeReader() {
  const m: Manifest = { ...manifest, owners: { ...manifest.owners, bot: signerAccount.address.toLowerCase() as Address } };
  const store = new MemoryAppendStore(), simulations: Json[] = [], service = new FakeSafeService();
  const fit = { ...snapshot('fit'), owners: Object.values(m.owners) };
  let reconciled: ReconciledExecution[] = [];
  const observation = (): ChainObservation => ({ snapshots: { fit }, credits: [],
    lots: [fitLot('eth-1', zeroAddress, 1n), fitLot('fit-1', m.box0.fit, 2n), fitLot('coin-1', addr(15n), 3n)] });
  const reader = fakeReader(observation, simulations, new Set(), () => reconciled);
  const cycles: Json[] = [];
  let bot = new Bot(m, new Journal(store));
  const first = await runCycle({ bot, reader, quotes: quotes(fit.block), service, signer, dryRun: false, allowMainnet: true });
  cycles.push(result(first));
  const [fund, burn, sale] = first.proposals;
  if (!fund || !burn || !sale) throw new Error('golden proposals missing');
  const proof = (id: Hex, nonce: bigint, logIndex: bigint) => ({ chainId: m.chainId, safe: FIT, txHash: hash(700n + nonce),
    logIndex, safeTxHash: id, nonce, nonceAfter: 3n, canonical: true, effectsVerified: true });
  // Executed by the owners: funding and sale succeed, the burn's batch fails and its input is free again.
  reconciled = [
    { kind: 'action', id: fund.id, result: { ...proof(fund.id, 0n, 1n), status: 'success', amountIn: 1000n, amountOut: 0n, budgetFunded: 1000n } },
    { kind: 'action', id: burn.id, result: { ...proof(burn.id, 1n, 2n), status: 'failed' } },
    { kind: 'action', id: sale.id, result: { ...proof(sale.id, 2n, 3n), status: 'success', amountIn: 1000n, amountOut: 1990n } },
  ];
  fit.nonce = 3n;
  bot = new Bot(m, new Journal(store));
  const second = await runCycle({ bot, reader, quotes: quotes(fit.block), service, signer, dryRun: false, allowMainnet: true });
  cycles.push(result(second));
  reconciled = [];
  const output = second.proposals.find(p => p.draft.request.kind === 'fund');
  if (!output) throw new Error('golden output funding missing');
  bot = new Bot(m, new Journal(store));
  cycles.push(result(await runCycle({ bot, reader, quotes: quotes(fit.block), service, signer, dryRun: false,
    allowMainnet: true, cancel: [output.id] })));
  return { cycles, simulations, journal: journal(store), replay: state(new Bot(m, new Journal(store))),
    service: plain([...service.proposals.values()]) };
}

// The finalized reader on an offline fake chain whose receivers also name a platform Safe.
function fakeChain(m: Manifest) {
  const code = '0x1234' as const, block = { number: 100n, hash: hash(100n), timestamp: 3000000n };
  const logs: Awaited<ReturnType<ReaderRpc['getLogs']>> = [];
  let fitNonce = 0n, transaction: { to: Address; input: Hex } | null = null;
  const event = (abi: Abi, name: string, address: Address, data: Hex, args: Record<string, unknown>, index: number) => ({
    address, topics: encodeEventTopics({ abi, eventName: name, args }) as [Hex, ...Hex[]], data,
    blockNumber: 90n, blockHash: hash(90n), transactionHash: hash(900n), logIndex: index, removed: false,
  });
  const rpc: ReaderRpc = {
    getChainId: async () => 11155111,
    getBlock: async request => request.blockNumber === undefined || request.blockNumber === 100n ? block
      : { number: request.blockNumber, hash: hash(request.blockNumber), timestamp: request.blockNumber * 30000n },
    getCode: async request => request.blockNumber === 0n ? undefined : code,
    getBalance: async () => 10000n,
    getStorageAt: async ({ slot }) => BigInt(slot) === 0n ? hash(20n) : hash(0n),
    readContract: async request => {
      const values: Record<string, unknown> = {
        budget: 5n, totalBurned: 7n, totalEthSpent: 3n, nonce: request.address === FIT ? fitNonce : 0n,
        getThreshold: request.address === PLATFORM ? 1n : 2n,
        getOwners: request.address === PLATFORM ? [m.owners.founder] : Object.values(m.owners),
        VERSION: '1.4.1', getModulesPaginated: [[], addr(1n)], balanceOf: 10000n,
        graduated: true, graduatedAt: 1n, failed: false,
        poolManager: addr(60n), token: m.box0.fit, executor: m.box0.executor, receiver: addr(50n),
        coordinator: request.address === m.boxes[0]?.receiver ? addr(51n) : addr(52n),
        q: request.address === m.boxes[0]?.receiver ? m.boxes[0]?.p : zeroAddress,
        boxId: request.address === m.boxes[0]?.receiver || request.address === addr(51n) ? 1n : 2n,
        FIT_SAFE: FIT, PLATFORM_SAFE: PLATFORM, platformSafe: PLATFORM,
        fitOwed: 11n, platformOwed: 12n, platformHeld: 13n, graduationSettled: true,
      };
      if (request.functionName === 'receiver' && request.address !== m.box0.coordinator) return request.address === addr(51n) ? addr(12n) : addr(14n);
      if (!(request.functionName in values)) throw new Error(`unexpected fake read ${request.functionName}`);
      return values[request.functionName];
    },
    getLogs: async request => logs.filter(l => l.address === request.address && l.blockNumber !== null
      && l.blockNumber >= request.fromBlock && l.blockNumber <= request.toBlock),
    getTransaction: async () => { if (!transaction) throw new Error('fake transaction not configured'); return transaction; },
    getTransactionReceipt: async () => ({ status: 'success', blockNumber: 90n, blockHash: hash(90n), logs }),
    call: async () => ({ data: encodeAbiParameters([{ type: 'bool' }], [true]) }),
  };
  const word = (amount: bigint) => encodeAbiParameters([{ type: 'uint256' }], [amount]);
  const claim = (receiver: Address, asset: Address, amount: bigint, index: number) => event(poolManagerAbi, 'Transfer', addr(60n),
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [receiver, amount]), { from: receiver, to: zeroAddress, id: BigInt(asset) }, index);
  // Box 2 pays FIT 1000 wei in native P; box 1 pays 500 of its ERC-20 P (no route: it waits).
  logs.push(claim(addr(14n), zeroAddress, 1000n, 0),
    event(safeReadAbi, 'SafeReceived', FIT, word(1000n), { sender: addr(60n) }, 1),
    event(receiverV2Abi, 'FitPaid', addr(14n), word(1000n), { safe: FIT }, 2),
    claim(addr(12n), addr(13n), 500n, 3),
    event(boxTokenAbi, 'Transfer', addr(13n), word(500n), { from: addr(60n), to: FIT }, 4),
    event(receiverV2Abi, 'FitPaid', addr(12n), word(500n), { safe: FIT }, 5));
  const execute = (t: SafeTransaction, id: Hex) => {
    transaction = { to: FIT, input: encodeFunctionData({ abi: safeReadAbi, functionName: 'execTransaction',
      args: [t.to, t.value, t.data, t.operation, t.safeTxGas, t.baseGas, t.gasPrice, t.gasToken, t.refundReceiver, '0x'] }) };
    logs.push(event(safeReadAbi, 'ExecutionSuccess', FIT, encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [id, 0n]), {}, 7),
      event(fitBuybackExecutorAbi, 'BudgetFunded', m.box0.executor, word(t.value), { from: FIT }, 6));
    fitNonce = 1n;
  };
  return { rpc, execute };
}

async function chainReader() {
  const base = structuredClone(manifest), codeHash = keccak256('0x1234');
  const m: Manifest = { ...base, chainId: 11155111n, multiSend: { ...base.multiSend, codeHash },
    safeConfigs: { ...base.safeConfigs, fit: { ...base.safeConfigs.fit, codeHash, singletonCodeHash: codeHash } } };
  const chain = fakeChain(m), store = new MemoryAppendStore(), service = new FakeSafeService();
  const reader = new ViemChainReader(m, chain.rpc, { startBlock: 1n, logChunk: 100n, maxScanBlocks: 1000n });
  const quotesFor = { quote: async () => { throw new Error('no route in this golden'); } };
  const cycles: Json[] = [];
  let bot = new Bot(m, new Journal(store));
  const first = await runCycle({ bot, reader, quotes: quotesFor, service, dryRun: true });
  cycles.push(result(first));
  const funding = first.proposals[0];
  if (!funding) throw new Error('golden chain funding missing');
  chain.execute(funding.transaction, funding.id);
  bot = new Bot(m, new Journal(store));
  cycles.push(result(await runCycle({ bot, reader, quotes: quotesFor, service, dryRun: true })));
  return { cycles, journal: journal(store), replay: state(new Bot(m, new Journal(store))) };
}

it('keeps the FIT Safe decisions of the recorded golden (SH-173)', async () => {
  // Write mode never passes and never runs in CI: only a later run without it compares against the file.
  const write = process.env.SH_BOT_WRITE_GOLDEN === '1';
  if (write && process.env.CI) throw new Error('golden write mode is refused when CI is set');
  const actual = { dryFakeReader: plain(await dryFakeReader()), liveFakeReader: plain(await liveFakeReader()),
    chainReader: plain(await chainReader()) };
  if (write) {
    writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 1)}\n`);
    throw new Error('golden written; rerun without SH_BOT_WRITE_GOLDEN to compare');
  }
  const expected = JSON.parse(readFileSync(GOLDEN, 'utf8')) as typeof actual;
  for (const name of Object.keys(actual) as (keyof typeof actual)[]) expect(actual[name], name).toEqual(expected[name]);
});
