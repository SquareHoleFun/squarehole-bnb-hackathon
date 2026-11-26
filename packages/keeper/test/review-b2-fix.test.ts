import { expect, it, vi } from 'vitest';
import { type Address, type PublicClient } from 'viem';
import { ViemChain } from '../src/chain';
import { incomeCost, incomeRefusal, reconcileStarts, startUnpaid, activeIncomeSpend, type IncomeReceipt, type IncomeSnapshot, type IncomeSpend } from '../src/income';
import { runTick, type KeeperState } from '../src/run';
import { restartStarts as restart } from './support/start-state';
import type { Candidate, Sim } from '../src/types';
import { addr, box, keeper, options, quiet, time, v2, world } from './support/v2';

const TETH: Address = '0x7156c3e4DD23F5776c26b3F6140BC03fFb7c4D5E';
const TUSDC: Address = '0x5B397F65571deF193Ba5DBE8b2a353C3963c65F6';
// Offline stand-in for runtime code only. The production addresses, decimals and founder rates are unchanged.
vi.mock('../src/income-parity-manifest', async original => {
  const real = await original<typeof import('../src/income-parity-manifest')>();
  const { keccak256 } = await import('viem');
  return { ...real, ethParityManifest: Object.fromEntries(Object.entries(real.ethParityManifest)
    .map(([key, pin]) => [key, { ...pin, codeHash: keccak256('0x6000') }])) };
});
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const;
const C = 15_000_000_000_000_000n;
const empty = (at = time): IncomeSnapshot => ({ at, platformWei: 0n, boxes: {}, mined: {} });
const debt = (over: Partial<IncomeSpend> = {}): IncomeSpend => ({ box: addr(3), at: time, costWei: C,
  hash: hash(1), start: { job: 'collect' }, ...over });
const paid = (over: Partial<IncomeReceipt> = {}): IncomeReceipt => ({ box: addr(3), hash: hash(1), at: time + 12n,
  shareWei: 0n, tipsWei: C, startTipWei: C, ...over });
const proved = (rs: readonly IncomeReceipt[], at = time + 24n): IncomeSnapshot => ({ at,
  boxes: { [addr(3)]: { shareWei: rs.reduce((n, r) => n + r.shareWei, 0n), tipsWei: rs.reduce((n, r) => n + r.tipsWei, 0n) } },
  platformWei: rs.reduce((n, r) => n + r.shareWei, 0n), mined: { [hash(1)]: time + 12n }, startReceipts: rs });

function harness(q = addr(0) as Address, rawTip = C) {
  let at = time, block = 100n;
  let b = box({ id: 5n, v2: { ...v2, q, qDecimals: q === TUSDC ? 6 : 18, buyBackP: 0n, depthBudget: 1n },
    qPerEthX18: BigInt(q) === 0n ? 10n ** 18n : null });
  let income: IncomeSnapshot | null = empty();
  let tip = rawTip, estimate = 1_190_000n;
  let jobs = ['collect'];
  const current = () => world(b, block, at);
  const cfg = { ...options(), dryRun: false, priorityFeeWei: 2_999_999_998n,
    coinMinimums: { [q.toLowerCase()]: { collectRaw: 1n } } };
  const pub = {
    getChainId: vi.fn(async () => 11155111),
    getBytecode: vi.fn(async () => '0x6000'),
    getBlock: vi.fn(async () => ({ number: block - 10n, hash: hash(90), timestamp: at - 120n, gasLimit: 60000000n })),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'decimals') return q === TUSDC ? 6 : 18;
      throw new Error('no route');
    }),
    simulateContract: vi.fn(async ({ functionName }: { functionName: string }) => ({ result:
      functionName === 'collect' ? { buyersP: 990102n, sellersP: 0n, qToReserve: 0n, tip }
        : [0, 100n, 164190n, tip] })),
    estimateGas: vi.fn(async () => estimate),
  };
  const adapter = new ViemChain(cfg, pub as unknown as PublicClient, keeper, { public: null, private: null }, null, quiet);
  const send = vi.fn(async (): Promise<string> => hash(1));
  const port = {
    read: async () => current(),
    readIncome: async () => { if (!income) throw new Error('no snapshot'); return { ...income, at }; },
    simulate: async (c: Candidate, fees: Parameters<ViemChain['simulate']>[1], start = false): Promise<Sim> => {
      if (!jobs.includes(c.job)) return { ok: false, tipWei: null, estimate: 0n };
      if (c.job === 'receiverPayFit') return { ok: true, tipWei: null, estimate: 100_000n };
      Object.assign(adapter, { last: current(), now: at });
      return adapter.simulate(c, fees, start);
    }, send,
  };
  return { cfg, port, pub, send, adapter, get b() { return b; }, set b(x) { b = x; },
    set tip(x: bigint) { tip = x; }, set estimate(x: bigint) { estimate = x; },
    set jobs(x: string[]) { jobs = x; }, set income(x: IncomeSnapshot | null) { income = x; },
    advance(seconds = 12n) { at += seconds; block += 25n; },
    tick: (s: KeeperState = {}) => runTick(port, restart(s), cfg, quiet) };
}


// Ports of the five delta findings from review-delta.test.ts, with success properties.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore, decodeState, encodeState } from '../src/state';
const identity = 'chain:signer:registry';
const file = () => join(mkdtempSync(join(tmpdir(), 'keeper-b2-')), 'state');
const cut = vi.hoisted(() => ({ path: '', writes: [] as string[] }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, renameSync: (from: Parameters<typeof fs.renameSync>[0], to: Parameters<typeof fs.renameSync>[1]) => {
    if (String(to) === cut.path) throw new Error('process stopped');
    fs.renameSync(from, to); cut.writes.push(String(to));
  } };
});

it.each([false, true])('R2-M1: an ordinary collection and a start in one tick must each survive restart once (equal cost=%s)', async equal => {
  const h = harness(addr(0), 3n * C); h.jobs = ['collect', 'sellFees'];
  h.b = { ...h.b, v2: { ...v2, depthBudget: 0n, buyBackP: 0n } };
  // Both signed gas amounts become 8.4M when the collection estimate is high enough.
  if (equal) h.estimate = 7000000n;
  const collectCost = equal ? 25200000000000000n : C;
  h.income = { ...empty(), boxes: { [addr(3)]: { shareWei: 0n, tipsWei: collectCost } } };
  let n = 1; h.send.mockImplementation(async () => hash(n++));
  const f = file(), store = new StateStore(f, identity);
  try {
    const out = await runTick(h.port, {}, { ...h.cfg, checkpoint: async (s, now) => store.save(s, now) }, quiet);
    expect(out.report.sent.map(s => s.job)).toEqual(['collect', 'sellFees']);
    expect(out.state.incomeSpend?.map(s => s.costWei)).toEqual([collectCost, equal ? collectCost : 24600000000000000n]);
    expect(store.load(time).incomeSpend).toEqual(out.state.incomeSpend);
    expect(startUnpaid(addr(3), store.load(time).incomeSpend ?? [])).toBe(true);
    const starts = JSON.parse(readFileSync(f + '.starts', 'utf8')).starts;
    expect(starts).toHaveLength(1); expect(starts[0].id).toMatch(/^[a-f0-9-]{36}$/);
    expect(readFileSync(f, 'utf8')).not.toContain('start');
  } finally { store.close(); }
});

it('R2-M2: a repaid unmined start must leave no debit after a stop between J removal and A removal', () => {
  const f = file(), store = new StateStore(f, identity);
  const repayment = paid({ hash: hash(2), at: time + 100n, tipsWei: C, startTipWei: 0n });
  const repaid = reconcileStarts([debt()], proved([repayment], time + 120n));
  expect(repaid[0]?.start?.repaidAt).toBe(time + 120n);
  try {
    store.save({ incomeSpend: repaid }, time + 120n); cut.writes = []; cut.path = f + '.starts';
    expect(() => store.save({ incomeSpend: [] }, time + 86520n)).toThrow('process stopped');
    expect(cut.writes).toEqual([f]);
  } finally { cut.path = ''; store.close(); }
  const restarted = new StateStore(f, identity);
  try {
    const recovered = restarted.load(time + 86520n);
    expect(recovered.incomeSpend).toEqual([]);
    expect(JSON.parse(readFileSync(f + '.starts', 'utf8')).starts).toEqual([]);
    const income = { ...empty(time + 86520n), boxes: { [addr(88)]: { shareWei: 0n, tipsWei: C } } };
    expect(incomeRefusal(addr(88), C, recovered.incomeSpend ?? [], income)).toBeNull();
    restarted.save(recovered, time + 86520n);
    expect(JSON.parse(readFileSync(f + '.starts', 'utf8')).starts).toEqual([]);
  } finally { restarted.close(); }
});

it.each([addr(0), TETH])('R2-M3: a funded ordinary collection in %s must keep pre-B adapter reads', async q => {
  const h = harness(q); h.income = { ...empty(), boxes: { [addr(3)]: { shareWei: 0n, tipsWei: 2n * C } } };
  const out = await h.tick();
  expect(out.report.sent.map(s => s.job)).toEqual(['collect']);
  expect(out.state.incomeSpend?.[0]?.start).toBeUndefined();
  expect(h.pub.getBlock).not.toHaveBeenCalled();
  expect(h.pub.getBytecode).not.toHaveBeenCalled(); expect(h.pub.readContract).not.toHaveBeenCalled();
  expect(h.pub.simulateContract).toHaveBeenCalledTimes(1); expect(h.pub.estimateGas).toHaveBeenCalledTimes(1);
});
it('R2-M3: a collection with nothing to do must use one simulation and no start reads', async () => {
  const h = harness(); h.pub.simulateContract.mockResolvedValue({ result: { buyersP: 0n, sellersP: 0n, qToReserve: 0n, tip: 0n } });
  const out = await h.tick(); expect(out.report.sent).toEqual([]);
  expect(h.pub.simulateContract).toHaveBeenCalledTimes(1); expect(h.pub.estimateGas).not.toHaveBeenCalled();
  expect(h.pub.getBlock).not.toHaveBeenCalled(); expect(h.pub.getBytecode).not.toHaveBeenCalled();
});
it.each([addr(0), TETH])('R2-M3: an income-refused start candidate in %s must do its own paired simulation and valuation', async q => {
  const h = harness(q); const out = await h.tick();
  expect(out.report.sent.map(s => s.job)).toEqual(['collect']);
  expect(out.state.incomeSpend?.[0]?.start?.job).toBe('collect');
  expect(h.pub.simulateContract).toHaveBeenCalledTimes(2); expect(h.pub.estimateGas).toHaveBeenCalledTimes(2);
  expect(h.pub.getBlock).toHaveBeenCalledTimes(q === addr(0) ? 2 : 4);
  expect(h.pub.getBytecode).toHaveBeenCalledTimes(q === addr(0) ? 0 : 1);
  expect(h.pub.readContract).toHaveBeenCalledTimes(q === addr(0) ? 0 : 1);
  const calls = h.pub.simulateContract.mock.invocationCallOrder;
  const estimates = h.pub.estimateGas.mock.invocationCallOrder;
  const heads = h.pub.getBlock.mock.invocationCallOrder;
  expect(estimates[0]).toBeLessThan(present(heads[0])); expect(heads[0]).toBeLessThan(present(calls[1]));
  expect(calls[1]).toBeLessThan(present(estimates[1])); expect(estimates[1]).toBeLessThan(present(heads.at(-1)));
  if (q !== addr(0)) expect(h.pub.readContract.mock.invocationCallOrder[0]).toBeLessThan(present(estimates[1]));
});
it('a second simulation that becomes unblocking must not sign under the start exception', async () => {
  const h = harness(); h.jobs = ['sellFees']; h.b = { ...h.b, v2: { ...v2, depthBudget: 0n, buyBackP: 0n } };
  h.pub.simulateContract.mockResolvedValueOnce({ result: [0, 100n, 164190n, C * 3n] })
    .mockResolvedValueOnce({ result: [0, 100n, 0n, C * 3n] });
  expect((await h.tick()).report.sent).toEqual([]); expect(h.send).not.toHaveBeenCalled();
});
it('the fresh start estimate must determine the signed cost and every guard', async () => {
  const h = harness(addr(0), 3n * C);
  h.pub.estimateGas.mockResolvedValueOnce(1190000n).mockResolvedValueOnce(7000000n);
  const out = await h.tick();
  expect(out.report.sent[0]?.gas).toBe(8400000n);
  expect(out.state.incomeSpend?.[0]?.costWei).toBe(25200000000000000n);
});
it('R2-L1: old inline dry start fields must be dropped exactly like the pre-B decoder and must not lock the box', async () => {
  const h = harness(), f = file() + '.dry';
  const text = JSON.stringify({ version: 1, identity, state: { incomeSpend: [debt({ hash: undefined })] } },
    (_, v: unknown) => typeof v === 'bigint' ? String(v) : v);
  writeFileSync(f, text);
  const store = new StateStore(f, identity);
  try {
    const loaded = store.load(time); expect(loaded).toEqual(decodeState(text, identity));
    expect(loaded.incomeSpend).toEqual([{ box: addr(3), at: time, costWei: C }]);
    expect(startUnpaid(addr(3), loaded.incomeSpend ?? [])).toBe(false);
    h.advance(172800n); h.income = proved([paid({ hash: hash(2), tipsWei: 100n * C })]);
    const out = await runTick(h.port, loaded, { ...h.cfg, dryRun: true }, quiet);
    expect(out.report.sent.map(s => s.job)).toEqual(['collect']);
    expect(out.report.skipped.some(s => s.code === 'START_UNPAID')).toBe(false);
  } finally { store.close(); }
});
it('R2-L2: the operator text and monitor comment must describe final settlement and 24-hour removal', () => {
  const guide = readFileSync(new URL('../../../infra/server/monitor/keeper-view.md', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../src/monitor.ts', import.meta.url), 'utf8');
  expect(guide).toContain('settles once on a final receipt'); expect(guide).toContain('dropped 24 hours after it was paid');
  expect(guide).not.toContain('reorg can restore the debt'); expect(source).not.toContain('retained start proof history');
  expect(source).toContain('starts settle once and leave 24 hours after payment');
});
it('S7: books that load differently must publish no files, including the first marker', () => {
  const f = file(), store = new StateStore(f, identity);
  try {
    // Two entries at a start pair violate U1; validation must publish nothing.
    const ordinary = { box: addr(3), at: time, costWei: C + 1n, hash: hash(1) };
    expect(() => store.save({ incomeSpend: [ordinary, debt()] }, time + 120n)).toThrow('keeper starts invalid or belongs to another chain/signer/registry');
    for (const p of [f, f + '.starts', f + '.starts-required']) expect(existsSync(p)).toBe(false);
  } finally { store.close(); }
});
it('S7: a failed known-hash checkpoint must stop the tick before another signature', async () => {
  const h = harness(addr(0), 3n * C); h.jobs = ['collect', 'sellFees'];
  h.b = { ...h.b, v2: { ...v2, depthBudget: 0n, buyBackP: 0n } };
  await expect(runTick(h.port, {}, { ...h.cfg, checkpoint: async s => {
    if (s.incomeSpend?.some(s => s.hash)) throw new Error('keeper books do not round trip');
  } }, quiet)).rejects.toThrow('keeper books do not round trip');
  expect(h.send).toHaveBeenCalledTimes(1);
});
it('S6: journal receipt expiry must never end an unpaid start debit', () => {
  const income = { ...empty(time + 86412n), mined: { [hash(1)]: time + 12n } };
  expect(activeIncomeSpend([debt()], income)).toEqual([debt()]);
  expect(incomeCost(debt(), income)).toBe(C);
});
it('S5: paid orphans must retain only their remaining window while unpaid orphans retain full hashless debt', () => {
  for (const payment of ['settledAt', 'repaidAt'] as const) {
    const f = file(), store = new StateStore(f, identity);
    const s = debt({ start: { job: 'collect', [payment]: time + 120n } });
    try {
      store.save({ incomeSpend: [s] }, time + 120n); writeFileSync(f, encodeState({ incomeSpend: [] }, identity));
      expect(store.load(time + 86519n).incomeSpend).toEqual([s]);
      expect(store.load(time + 86520n).incomeSpend).toEqual([]);
    } finally { store.close(); }
  }
  const f = file(), store = new StateStore(f, identity);
  try {
    store.save({ incomeSpend: [debt()] }, time + 120n); writeFileSync(f, encodeState({ incomeSpend: [] }, identity));
    const restored = store.load(time + 100n * 86400n).incomeSpend ?? [];
    expect(restored).toEqual([debt({ hash: undefined })]); expect(startUnpaid(addr(3), restored)).toBe(true);
  } finally { store.close(); }
});

it.each([false, true])('the full gas-constraint adapter must keep ordinary reads and pair only starts (funded=%s)', async funded => {
  const h = harness(); if (funded) h.income = proved([paid({ tipsWei: C * 2n })]);
  const out = await runTick({ ...h.port, gasConstraints: (c, e) => h.adapter.gasConstraints(c, e) }, {}, h.cfg, quiet);
  expect(out.report.sent.map(s => s.job)).toEqual(['collect']);
  expect(h.pub.getBlock).toHaveBeenCalledTimes(funded ? 1 : 4);
  expect(h.pub.simulateContract).toHaveBeenCalledTimes(funded ? 1 : 2);
  expect(h.pub.estimateGas).toHaveBeenCalledTimes(funded ? 1 : 2);
});
it('the full gas-constraint adapter must refuse a head change during the start estimate', async () => {
  const h = harness(); let pending = 100n;
  h.pub.getBlock.mockImplementation(async () => ({ number: pending, hash: hash(Number(pending)), timestamp: time, gasLimit: 60000000n }));
  h.pub.estimateGas.mockImplementation(async () => { pending += 1n; return 1190000n; });
  const out = await runTick({ ...h.port, gasConstraints: (c, e) => h.adapter.gasConstraints(c, e) }, {}, h.cfg, quiet);
  expect(out.report.sent).toEqual([]); expect(out.report.skipped).toContainEqual(expect.objectContaining({ code: 'SIMULATION_ERROR' }));
});

function present<T>(value: T | undefined): T { if (value === undefined) throw new Error('missing fixture'); return value; }

it('S6: A must control the matched debit even when J has an earlier receipt expiry', () => {
  const f = file(), store = new StateStore(f, identity), repaid = debt({ start: { job: 'collect', repaidAt: time + 120n } });
  try {
    store.save({ incomeSpend: [repaid] }, time + 120n);
    writeFileSync(f, encodeState({ incomeSpend: [{ box: addr(3), at: time, costWei: C, hash: hash(1) }] }, identity));
    const loaded = store.load(time + 86519n).incomeSpend ?? [];
    expect(loaded).toEqual([repaid]);
    const income = { ...empty(time + 86519n), mined: { [hash(1)]: time + 12n } };
    expect(activeIncomeSpend(loaded, income)).toEqual([repaid]); expect(incomeCost(repaid, income)).toBe(C);
    expect(activeIncomeSpend(loaded, { ...income, at: time + 86520n })).toEqual([]);
    expect(incomeCost(repaid, { ...income, at: time + 86520n })).toBe(0n);
  } finally { store.close(); }
});

it.each(['hash', 'payment'] as const)('S7: an interrupted %s checkpoint must not let stale memory overwrite A', event => {
  const f = file(), store = new StateStore(f, identity);
  const prior = event === 'hash' ? debt({ hash: undefined }) : debt();
  const next = event === 'hash' ? debt() : debt({ start: { job: 'collect', settledAt: time + 12n } });
  try {
    store.save({ incomeSpend: [prior] }, time + 120n); cut.path = f;
    expect(() => store.save({ incomeSpend: [next] }, time + 120n)).toThrow('process stopped'); cut.path = '';
    const bytes = readFileSync(f + '.starts', 'utf8');
    expect(() => store.save({ incomeSpend: [prior] }, time + 120n)).toThrow('keeper books do not round trip');
    expect(readFileSync(f + '.starts', 'utf8')).toBe(bytes);
    expect(store.load(time + 24n).incomeSpend).toEqual([next]);
  } finally { cut.path = ''; store.close(); }
});
