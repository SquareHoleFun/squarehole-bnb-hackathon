import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionData, parseTransaction } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { receiverEatV21Abi } from '../../chain/src/core/v2/abi-v2';
import { abiFor } from '../src/abi';
import { interpret, ViemChain } from '../src/chain';
import { loadConfig } from '../src/config';
import { openBudget } from '../src/decide';
import { EIP7825_GAS_CAP, feesFor, transactionGas } from '../src/gas';
import { incomeCapped, INCOME_WINDOW_SECONDS } from '../src/income';
import { JOBS } from '../src/jobs';
import { afterRun, emptyMemory, plan } from '../src/plan';
import { runTick, type KeeperState } from '../src/run';
import { decodeState, encodeState } from '../src/state';
import type { Candidate } from '../src/types';
import { fakeClient, fakeNode, REVERT } from './support/fake-rpc';
import { addr, box, fundedIncome, keeper, options, quiet, time, v2, world } from './support/v2';

const amount = (1n << 140n) + 17n;
const floor = 3_500_000n;
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing eating fixture value');
  return value;
}
const eat: Candidate = { job: 'eatPriceCoin', key: 'eatPriceCoin:2:test', to: addr(3), fn: 'eatPriceCoin', args: [], version: 2, boxId: 0n };
const eatingBox = () => box({ v2: { ...v2, eatPendingP: amount, buyBackP: 0n, depthBudget: 0n } });
const eating = (w = world(eatingBox()), mem = emptyMemory()) => plan(w, mem, options()).candidates.filter(c => c.job === 'eatPriceCoin');

describe('WIRING-K: ordinary permissionless eating', () => {
  it('schedules pending raw P after graduation without a tip/recipient or a pool-step wait', () => {
    const b = eatingBox();
    const cs = eating(world({ ...b, v2: { ...required(b.v2), qDecimals: null, lastProtocolBlock: 100n } }));
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ job: 'eatPriceCoin', to: b.receiver, fn: 'eatPriceCoin', args: [], version: 2 });
    expect(incomeCapped(eat)).toBe(true);
    expect(JOBS.find(j => j.name === eat.job)).toMatchObject({ tip: 'none', reserved: false, privately: false, gasPerRun: floor });
    expect(encodeFunctionData({ abi: abiFor(eat), functionName: eat.fn, args: [] }))
      .toBe(encodeFunctionData({ abi: receiverEatV21Abi, functionName: 'eatPriceCoin' }));
  });

  it('sends no eating job for empty/unknown pending, before graduation, after failure, or on Box 0', () => {
    for (const pending of [0n, null, undefined]) {
      expect(eating(world(box({ v2: { ...v2, eatPendingP: pending } })))).toEqual([]);
    }
    for (const overrides of [{ graduated: false }, { failed: true }, { version: 1 as const }]) {
      expect(eating(world({ ...eatingBox(), ...overrides }))).toEqual([]);
    }
    expect(eating(world(box({ v2: { ...v2, eatPendingP: 1n } })))).toHaveLength(1);
  });

  it('rejects refused/empty or malformed simulation results and retries with existing backoff', () => {
    for (const result of [0n, -1n, undefined, true, '1']) expect(interpret(eat, result, null).ok).toBe(false);
    expect(interpret(eat, amount, null)).toEqual({ ok: true, tipWei: null, estimate: 0n });
    const candidate = required(eating()[0]);
    const mem = afterRun(emptyMemory(), candidate, false, world(eatingBox()));
    expect(eating(world(eatingBox(), 101n), mem)).toEqual([]);
    expect(eating(world(eatingBox(), 102n), mem)).toHaveLength(1);
  });

  it('can drain another bounded portion next block after progress without taking the pool swap slot', () => {
    const candidate = required(eating()[0]);
    const mem = afterRun(emptyMemory(), candidate, true, world(eatingBox()));
    expect(eating(world(eatingBox(), 101n), mem)).toHaveLength(1);
    expect(mem.steps).toEqual({});
  });

  it('covers full EAT_GAS, EIP-150 admission, reserve and measured cold entry under the transaction cap', () => {
    const cap = 2_800_000n, reserve = 200_000n, measuredAdmission = 3_141_263n;
    expect(floor).toBeGreaterThan(cap + cap / 63n + reserve + 21_064n);
    expect(floor).toBeGreaterThan(measuredAdmission + 21_064n);
    expect(transactionGas(eat.job, 100_000n)).toBe(floor);
    expect(transactionGas(eat.job, floor)).toBe(4_200_000n);
    expect(transactionGas(eat.job, floor)).toBeLessThan(EIP7825_GAS_CAP);
    expect(() => transactionGas(eat.job, 100_000n, { fork: 'osaka', transactionCap: EIP7825_GAS_CAP, blockGasLimit: floor - 1n })).toThrow(/floor/);
    expect(() => transactionGas(eat.job, EIP7825_GAS_CAP + 1n)).toThrow(/estimate/);
  });
});

function funded(share = floor * 3n, platform = floor * 12n, tips = 0n) {
  let w = world(eatingBox());
  const send = vi.fn(async () => '0x' + 'ab'.repeat(32));
  const port = { read: async () => w, send,
    readIncome: async () => ({ at: w.block.timestamp, platformWei: platform,
      boxes: { [required(w.boxes[0]).receiver.toLowerCase()]: { shareWei: share, tipsWei: tips } }, mined: {} }),
    simulate: vi.fn(async (c: Candidate) => ({ ok: c.job === eat.job, tipWei: null, estimate: 100_000n })),
  };
  const cfg = { ...options(), dryRun: false, priorityFeeWei: 1n };
  return { port, cfg, send, setWorld: (next: typeof w) => { w = next; } };
}

describe('WIRING-F111: eating shares ordinary admission and batching', () => {
  it.each([[0n, floor * 12n, 'box income cap'], [floor * 3n - 1n, floor * 12n, 'box income cap'],
    [floor * 3n, floor * 12n - 1n, 'platform income cap']] as const)('refuses own share %s and total %s', async (share, total, why) => {
    const f = funded(share, total);
    const out = await runTick(f.port, {}, f.cfg, quiet);
    expect(out.report.skipped).toContainEqual(expect.objectContaining({ job: eat.job, why }));
    expect(f.send).not.toHaveBeenCalled();
    expect(out.state.budget.totalWei).toBe(0n);
  });

  it('reserves exact room before signing and retains ambiguous spending across a 24-hour restart', async () => {
    const f = funded();
    let saved: KeeperState = {};
    f.send.mockImplementation(async () => {
      expect(saved.incomeSpend).toEqual([{ box: addr(3), at: time, costWei: floor * 3n }]);
      expect(saved.budget?.oursWei).toBe(floor * 3n);
      throw new Error('ambiguous send');
    });
    const out = await runTick(f.port, {}, { ...f.cfg, checkpoint: async s => { saved = s; } }, quiet);
    f.setWorld(world(eatingBox(), 200n, time + INCOME_WINDOW_SECONDS));
    const next = await runTick(f.port, decodeState(encodeState(out.state, 'eat'), 'eat'), f.cfg, quiet);
    expect(next.report.skipped).toContainEqual(expect.objectContaining({ job: eat.job, why: 'box income cap' }));
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it('credits received tips, defers missing income, and cannot spend recovery reserve', async () => {
    const f = funded(0n, 0n, floor * 3n);
    expect((await runTick(f.port, {}, f.cfg, quiet)).report.sent.map(c => c.job)).toEqual([eat.job]);
    f.port.readIncome = async () => { throw new Error('missing receipts'); };
    expect((await runTick(f.port, {}, f.cfg, quiet)).report.skipped).toContainEqual(expect.objectContaining({ job: eat.job, why: 'income unavailable' }));
    const g = funded();
    const budget = { ...openBudget(undefined, 100n, time), oursWei: 51_000_000_000_000_000n, totalWei: 51_000_000_000_000_000n };
    expect((await runTick(g.port, { budget, incomeSpend: [] }, g.cfg, quiet)).report.skipped)
      .toContainEqual(expect.objectContaining({ job: eat.job, why: 'ours budget spent' }));
  });

  it('waits above 3 gwei before simulation and admits exactly 3 gwei', async () => {
    const f = funded(10n ** 18n, 10n ** 18n);
    f.setWorld({ ...world(eatingBox()), block: { number: 100n, timestamp: time, baseFeePerGas: 1_500_000_000n } });
    const refused = await runTick(f.port, {}, f.cfg, quiet);
    expect(refused.report.skipped).toContainEqual(expect.objectContaining({ job: eat.job, why: 'fee ceiling reached' }));
    expect(f.port.simulate).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    const out = await runTick(f.port, {}, { ...f.cfg, priorityFeeWei: 0n }, quiet);
    expect(out.report.sent.map(c => c.job)).toEqual([eat.job]);
    expect(out.state.budget.totalWei).toBe(floor * 3_000_000_000n);
  });

  it('batches across boxes with the existing four-send limit', async () => {
    const boxes = Array.from({ length: 5 }, (_, i) => ({ ...eatingBox(), id: BigInt(i), receiver: addr(20 + i), hook: addr(30 + i) }));
    const w = { ...world(), boxes };
    const f = funded(); f.setWorld(w);
    f.port.readIncome = async () => fundedIncome(w);
    const out = await runTick(f.port, {}, f.cfg, quiet);
    expect(out.report.sent.map(c => c.job)).toEqual(Array(4).fill(eat.job));
    expect(out.report.skipped).toContainEqual(expect.objectContaining({ job: eat.job, why: 'rate limit' }));
    expect(out.state.budget.totalWei).toBe(floor * 3n * 4n);
  });
});

function rpcFixture() {
  const registry = addr(10), co = addr(1), hk = addr(2), rc = addr(3);
  const node = fakeNode({ block: { number: 100n, timestamp: time, baseFeePerGas: 1n }, versions: { [hk]: 2, [rc]: 2 } });
  node.calls = {
    [`${registry}:boxCount`]: () => 1n,
    [`${registry}:roleOf`]: ([, role]) => ({ 0: co, 2: hk, 5: rc, 6: addr(6) })[String(role) as '0'] ?? addr(0),
    [`${hk}:q`]: () => addr(0), [`${hk}:poolId`]: () => `0x${'11'.repeat(32)}`, [`${hk}:poolManager`]: () => addr(7),
    [`${hk}:closed`]: () => true, [`${hk}:closedAt`]: () => time - 100n, [`${hk}:lastProtocolBlock`]: () => 0n,
    [`${hk}:depthBudget`]: () => 0n,
    [`${co}:graduated`]: () => true, [`${co}:failed`]: () => false, [`${co}:gateOpen`]: () => true,
    [`${co}:openAt`]: () => time - 100n, [`${co}:deadline`]: () => time + 1000n,
    [`${rc}:buyersChoice`]: () => 6, [`${rc}:sellersChoice`]: () => 3,
    [`${rc}:eatPendingP`]: () => amount, [`${rc}:eatPriceCoin`]: () => amount,
    [`${rc}:platformOwed`]: () => 1n, [`${rc}:payPlatform`]: () => 1n,
  };
  const cfg = loadConfig({ SH_KEEPER_RPC_URL: 'http://fake.invalid', SH_KEEPER_DESTINATION_FORK: 'osaka',
    SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_BOX_REGISTRY: registry });
  const log = { ...quiet, warn: vi.fn() };
  const client = fakeClient(node);
  const read = vi.spyOn(client, 'readContract');
  const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
  const chain = new ViemChain({ ...cfg, dryRun: false }, client, keeper, { public: account, private: null }, null, log);
  return { node, chain, read, log };
}

describe('WIRING-RPC: v2.1 read, simulation and signed receiver call', () => {
  it.each([['burn coin', addr(8), 6, 3], ['lock coin', addr(9), 1, 6], ['native lock', addr(0), 6, 6]] as const)(
    'reads and submits %s through the same zero-value receiver action', async (_mode, q, buyers, sellers) => {
      const f = rpcFixture();
      f.node.calls[`${addr(2)}:q`] = () => q;
      f.node.calls[`${addr(3)}:buyersChoice`] = () => buyers;
      f.node.calls[`${addr(3)}:sellersChoice`] = () => sellers;
      const w = await f.chain.read();
      expect(w.boxes[0]?.v2).toHaveProperty('eatPendingP', amount);
      const request = f.read.mock.calls.find(([r]) => r.functionName === 'eatPendingP')?.[0];
      expect(request).toMatchObject({ address: addr(3), blockNumber: 99n });
      const candidate = required(eating(w)[0]);
      expect(candidate).toBeDefined();
      const fees = feesFor(1n, 1n);
      expect(await f.chain.simulate(candidate, fees)).toEqual({ ok: true, tipWei: null, estimate: 100_000n });
      await f.chain.send(candidate, transactionGas(eat.job, 100_000n), fees, false);
      const tx = parseTransaction(required(f.node.sent[0]).raw);
      expect(tx.to?.toLowerCase()).toBe(addr(3));
      expect(tx.value ?? 0n).toBe(0n);
      expect(tx.gas).toBe(floor);
      expect(decodeFunctionData({ abi: receiverEatV21Abi, data: required(tx.data) })).toEqual({ functionName: 'eatPriceCoin', args: undefined });
    });

  it('does not call additive views on non-eat releases; failed reads stay unknown and other work survives', async () => {
    const f = rpcFixture();
    f.node.calls[`${addr(3)}:buyersChoice`] = () => 2;
    expect((await f.chain.read()).boxes[0]?.v2).toHaveProperty('eatPendingP', 0n);
    expect(f.read.mock.calls.some(([r]) => r.functionName === 'eatPendingP')).toBe(false);
    f.node.calls[`${addr(3)}:buyersChoice`] = () => 6;
    f.node.calls[`${addr(3)}:eatPendingP`] = () => { throw REVERT; };
    const w = await f.chain.read();
    expect(w.boxes[0]?.v2).toHaveProperty('eatPendingP', null);
    expect(eating(w)).toEqual([]);
    expect(plan(w, emptyMemory(), options()).candidates.map(c => c.job)).toContain('receiverPayPlatform');
    expect(f.log.warn).toHaveBeenCalledWith('read failed', expect.objectContaining({ source: `${addr(3)}:eatPendingP` }));
  });

  it('a hostile token refusal or failure race causes no send/charge, backs off and can retry', async () => {
    const f = rpcFixture();
    const send = vi.spyOn(f.chain, 'send');
    f.chain.readIncome = async () => fundedIncome(await f.chain.read());
    f.node.calls[`${addr(3)}:platformOwed`] = () => 0n;
    f.node.calls[`${addr(3)}:eatPriceCoin`] = () => 0n; // optional token call refused, pending restored
    const first = await runTick(f.chain, {}, { ...options(), dryRun: false, priorityFeeWei: 1n }, quiet);
    expect(first.report.skipped).toContainEqual(expect.objectContaining({ job: eat.job, why: 'nothing to do' }));
    expect(first.state.budget.totalWei).toBe(0n);
    expect((await f.chain.read()).boxes[0]?.v2).toHaveProperty('eatPendingP', amount);
    expect(send).not.toHaveBeenCalled();
    f.node.block.number = 101n;
    expect(eating(await f.chain.read(), first.state.mem)).toEqual([]);
    f.node.calls[`${addr(3)}:eatPriceCoin`] = () => { throw REVERT; }; // failure between read and pending call
    expect((await f.chain.simulate(eat, feesFor(1n, 1n))).ok).toBe(false);
    f.node.calls[`${addr(3)}:eatPriceCoin`] = () => amount;
    f.node.block.number = 102n;
    const next = await runTick(f.chain, first.state, { ...options(), dryRun: false, priorityFeeWei: 1n }, quiet);
    expect(next.report.sent.map(c => c.job)).toEqual([eat.job]);
  });
});
