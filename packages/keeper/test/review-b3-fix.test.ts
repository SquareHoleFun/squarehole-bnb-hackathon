import { expect, it, vi } from 'vitest';
import { type Address, type PublicClient } from 'viem';
import { ViemChain } from '../src/chain';
import { incomeRefusal, incomeReservationTime, reconcileStarts, startUnpaid, activeIncomeSpend, type IncomeReceipt, type IncomeSnapshot, type IncomeSpend } from '../src/income';
import { runTick, type KeeperState } from '../src/run';
import { restartStarts as restart } from './support/start-state';
import type { Candidate, Sim } from '../src/types';
import { addr, box, keeper, options, quiet, time, v2, world } from './support/v2';

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


// Ports of R3-M1/M2/L1 and the operator rules of R3-L2. Actual old-code walks also run in scratch.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore, encodeState, decodeState } from '../src/state';
const identity = 'chain:signer:registry';
const file = () => join(mkdtempSync(join(tmpdir(), 'keeper-b3-')), 'state');
const cut = vi.hoisted(() => ({ path: '', after: false, nth: 0, count: 0, writes: [] as string[] }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, renameSync: (from: Parameters<typeof fs.renameSync>[0], to: Parameters<typeof fs.renameSync>[1]) => {
    const target = String(to);
    if (!cut.after && target === cut.path) throw new Error('stopped');
    fs.renameSync(from, to);
    if (!target.endsWith('.released') && !target.endsWith('.cleared')) {
      cut.writes.push(target);
      if ((cut.after && target === cut.path) || (cut.nth && ++cut.count === cut.nth)) throw new Error('stopped');
    }
  } };
});
const resetCut = () => { cut.path = ''; cut.after = false; cut.nth = 0; cut.count = 0; cut.writes = []; };
const equalCost = 25200000000000000n;
function ambiguous() {
  const h = harness(addr(0), 3n * C); h.jobs = ['collect', 'sellFees']; h.estimate = 7000000n;
  h.b = { ...h.b, v2: { ...v2, depthBudget: 0n, buyBackP: 0n } };
  h.income = { ...empty(), boxes: { [addr(3)]: { shareWei: 0n, tipsWei: equalCost } } };
  h.send.mockRejectedValueOnce(new Error('ambiguous RPC result')).mockResolvedValue(hash(2));
  return h;
}
function fundedOther(at: bigint) {
  const other = box({ id: 6n, receiver: addr(88), hook: addr(89), coordinator: addr(90),
    v2: { ...v2, buyBackP: 1n, depthBudget: 0n } });
  return { read: async () => world(other, 1000n, at),
    readIncome: async () => ({ ...empty(at), boxes: { [addr(88)]: { tipsWei: 100n * C, shareWei: 0n } } }),
    simulate: async (c: Candidate) => ({ ok: c.job === 'buyBack', estimate: 1000000n, tipWei: null }),
    send: vi.fn(async () => hash(8)) };
}
const checkpoint = (st: StateStore) => async (s: KeeperState, now: bigint) => st.save(s, now);

it('R3-M1: an ambiguous ordinary collect and equal-cost start must both survive, then paid removal must allow another funded box', async () => {
  const h = ambiguous(), f = file(), st = new StateStore(f, identity);
  try {
    const out = await runTick(h.port, {}, { ...h.cfg, checkpoint: checkpoint(st) }, quiet);
    expect(out.report.sent.map(s => s.job)).toEqual(['sellFees']);
    expect(out.state.incomeSpend?.map(s => [s.at, s.costWei, s.hash, !!s.start])).toEqual([
      [time, equalCost, undefined, false], [time + 1n, equalCost, hash(2), true],
    ]);
    const paidSpend = reconcileStarts(out.state.incomeSpend ?? [], proved([paid({ hash: hash(2), tipsWei: equalCost, startTipWei: equalCost })]));
    expect(paidSpend[1]?.start?.settledAt).toBe(time + 12n);
    st.save({ ...out.state, incomeSpend: paidSpend }, time + 24n);
    const at = time + 86412n, port = fundedOther(at);
    const next = await runTick(port, st.load(at), { ...h.cfg, checkpoint: checkpoint(st) }, quiet);
    expect(port.send).toHaveBeenCalledOnce(); expect(next.report.sent.map(s => s.job)).toEqual(['buyBack']);
    expect(st.load(at).incomeSpend?.filter(s => s.box === addr(3))).toEqual([{ box: addr(3), at: time, costWei: equalCost }]);
    expect(JSON.parse(readFileSync(f + '.starts', 'utf8')).starts).toEqual([]);
    st.save(next.state, at + 86400n); // Both removals have completed; later checkpoints also work.
  } finally { st.close(); }
});
it('R3-M1: a stop after the start reaches A must retain both the ordinary cost and the full unpaid start', async () => {
  const h = ambiguous(), f = file(), st = new StateStore(f, identity);
  try {
    await expect(runTick(h.port, {}, { ...h.cfg, checkpoint: async (s, now) => {
      if (s.incomeSpend?.some(s => s.start)) cut.path = f;
      st.save(s, now);
    } }, quiet)).rejects.toThrow('stopped'); resetCut();
    const got = st.load(time).incomeSpend ?? [];
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(got.map(s => [s.at, s.costWei, s.start])).toEqual([
      [time, equalCost, undefined], [time + 1n, equalCost, { job: 'sellFees' }],
    ]);
    const income = { ...empty(time + 12n), boxes: { [addr(88)]: { shareWei: 0n, tipsWei: equalCost + C } } };
    expect(incomeRefusal(addr(88), C, got, income)).toBe('platform income cap');
    st.save({ incomeSpend: got }, time + 12n); expect(st.load(time + 12n).incomeSpend).toHaveLength(2);
  } finally { resetCut(); st.close(); }
});
it.each([false, true])('R3-M1: return after old receipt expiry must preserve ordinary debt and recover the start by payment state (paid=%s)', async isPaid => {
  const h = ambiguous(), f = file(), st = new StateStore(f, identity);
  try {
    const out = await runTick(h.port, {}, { ...h.cfg, checkpoint: checkpoint(st) }, quiet);
    const spends = isPaid ? reconcileStarts(out.state.incomeSpend ?? [], proved([paid({ hash: hash(2), tipsWei: equalCost, startTipWei: equalCost })])) : out.state.incomeSpend ?? [];
    st.save({ ...out.state, incomeSpend: spends }, time + 24n);
    // Literal old ordinary expiry: only the known receipt leaves J. No sidecar is touched.
    const old = decodeState(readFileSync(f, 'utf8'), identity), at = time + 90000n;
    writeFileSync(f, encodeState({ ...old, incomeSpend: old.incomeSpend?.filter(s => s.hash !== hash(2)) }, identity));
    const got = st.load(at).incomeSpend ?? [], ordinary = { box: addr(3), at: time, costWei: equalCost };
    expect(got.filter(s => !s.start)).toEqual([ordinary]);
    expect(got.filter(s => s.start)).toEqual(isPaid ? [] : [{ box: addr(3), at: time + 1n, costWei: equalCost, hash: undefined, start: { job: 'sellFees' } }]);
    expect(startUnpaid(addr(3), got)).toBe(!isPaid);
    const port = fundedOther(at);
    await runTick(port, st.load(at), { ...h.cfg, checkpoint: checkpoint(st) }, quiet);
    expect(port.send).toHaveBeenCalledOnce();
    expect(st.load(at).incomeSpend?.filter(s => s.box === addr(3) && !s.start)).toEqual([ordinary]);
  } finally { st.close(); }
});
it('R3-M2: pending expiry must permit the first funded send when the computer clock is one second behind', async () => {
  const f = file(), st = new StateStore(f, identity), expiry = time + 86412n;
  st.save({ incomeSpend: [debt({ start: { job: 'collect', settledAt: time + 12n } })] }, time + 24n);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Number(expiry - 1n) * 1000);
  const send = vi.fn(async () => hash(8)), stamps: bigint[] = [];
  const port = { read: async () => world(box(), 1000n, expiry),
    readIncome: async () => ({ ...empty(expiry), boxes: { [addr(3)]: { tipsWei: 2n * C, shareWei: 0n } } }),
    simulate: async (c: Candidate) => ({ ok: c.job === 'collect', estimate: 1190000n, tipWei: null }), send };
  try {
    const out = await runTick(port, st.load(), { ...options(), dryRun: false, priorityFeeWei: 2999999998n,
      checkpoint: async (state, now) => { stamps.push(now); st.save(state, now); } }, quiet);
    expect(out.report.sent.map(s => s.job)).toEqual(['collect']); expect(send).toHaveBeenCalledOnce();
    expect(stamps).toEqual([expiry, expiry, expiry]); expect(clock).not.toHaveBeenCalled();
    expect(st.load(expiry).incomeSpend?.some(s => s.start)).toBe(false);
    for (const path of ['../src/main.ts', '../../../infra/server/services/keeper.mjs']) {
      expect(readFileSync(new URL(path, import.meta.url), 'utf8')).toContain('store.save(next, now)');
    }
  } finally { clock.mockRestore(); st.close(); }
});
it('R3-L1: a hash known only in J must join once by time and reach A on the next save', () => {
  const f = file(), st = new StateStore(f, identity); st.save({ incomeSpend: [debt({ hash: undefined })] }, time);
  writeFileSync(f, encodeState({ incomeSpend: [{ box: addr(3), at: time, costWei: C, hash: hash(1) }] }, identity));
  try {
    const got = st.load(time); expect(got.incomeSpend).toEqual([debt()]); st.save(got, time);
    expect(JSON.parse(readFileSync(f + '.starts', 'utf8')).starts[0].hash).toBe(hash(1));
  } finally { st.close(); }
});
it.each(['cost', 'hash', 'duplicate'] as const)('U2: a damaged %s at a start pair must stop with fixed text before publication', kind => {
  const f = file(), st = new StateStore(f, identity); st.save({ incomeSpend: [debt()] }, time);
  const ordinary = { box: addr(3), at: time, costWei: kind === 'cost' ? C + 1n : C, hash: kind === 'hash' ? hash(2) : hash(1) };
  writeFileSync(f, encodeState({ incomeSpend: kind === 'duplicate' ? [ordinary, ordinary] : [ordinary] }, identity));
  const before = [f, f + '.starts', f + '.starts-required'].map(p => readFileSync(p, 'utf8'));
  try { expect(() => st.load(time)).toThrow('keeper starts invalid or belongs to another chain/signer/registry'); }
  finally { st.close(); }
  expect([f, f + '.starts', f + '.starts-required'].map(p => readFileSync(p, 'utf8'))).toEqual(before);
});
it('U2: matching must never fall back to cost or hash when no time matches', () => {
  const f = file(), st = new StateStore(f, identity); st.save({ incomeSpend: [debt()] }, time);
  const ordinary = { box: addr(3), at: time + 12n, costWei: C, hash: hash(1) };
  writeFileSync(f, encodeState({ incomeSpend: [ordinary] }, identity));
  try { expect(st.load(time).incomeSpend).toEqual([ordinary, debt({ hash: undefined })]); }
  finally { st.close(); }
});
it.each([2, 3, 4])('U1(a): a start among %i same-box entries must take the next free second and preserve all costs', count => {
  for (const repeated of [true, false]) {
    const f = file(), st = new StateStore(f, identity);
    const ordinary = Array.from({ length: count - 1 }, (_, n) => ({ box: addr(3), at: time + (repeated ? 0n : BigInt(n)), costWei: C }));
    const at = incomeReservationTime(addr(3), time, ordinary, true), entries = [...ordinary, debt({ at, hash: undefined })];
    try {
      expect(at).toBe(time + (repeated ? 1n : BigInt(count - 1))); st.save({ incomeSpend: entries }, time);
      expect(st.load(time).incomeSpend).toEqual(entries);
      expect(incomeReservationTime(addr(3), time, [{ box: addr(3), at: time, costWei: C }, { box: addr(3), at: time + 2n, costWei: C }], true)).toBe(time + 1n);
    } finally { st.close(); }
  }
});
it.each([2, 3, 4])('U1(b): later entries among %i same-tick spends must move off the start second only', count => {
  const f = file(), st = new StateStore(f, identity), entries: IncomeSpend[] = [debt({ hash: undefined })];
  for (let i = 1; i < count; i++) entries.push({ box: addr(3), at: incomeReservationTime(addr(3), time, entries, false), costWei: C });
  try {
    expect(entries.map(s => s.at)).toEqual(Array.from({ length: count }, (_, n) => time + BigInt(n)));
    expect(incomeReservationTime(addr(88), time, entries, false)).toBe(time);
    expect(incomeReservationTime(addr(3), time + 1n, entries, false)).toBe(time + 1n); // ordinary duplicates remain legal
    st.save({ incomeSpend: entries }, time); expect(st.load(time).incomeSpend).toEqual(entries);
  } finally { st.close(); }
});
it('U1(b): an ordinary send sharing a paid start second must move while a box with no start keeps its old entry', async () => {
  const h = harness(), f = file(), st = new StateStore(f, identity);
  h.income = { ...empty(), boxes: { [addr(3)]: { shareWei: 0n, tipsWei: 100n * C } } };
  const initial = { incomeSpend: [debt({ start: { job: 'collect', settledAt: time } })] };
  try {
    st.save(initial, time);
    const out = await runTick(h.port, st.load(time), { ...h.cfg, checkpoint: checkpoint(st) }, quiet);
    expect(out.report.sent.map(s => s.job)).toEqual(['collect']);
    expect(out.state.incomeSpend?.map(s => s.at)).toEqual([time, time + 1n]);
    expect(st.load(time).incomeSpend).toEqual(out.state.incomeSpend);
  } finally { st.close(); }
});
it('R3-L2: both operator guides must describe unchanged J, paid orphans, rollback and refused first-fix A', () => {
  for (const path of ['../../../docs/ops/keeper.md', '../../../docs/runbooks/keeper-sepolia-env.md']) {
    const text = readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
    for (const phrase of ['unchanged', '.starts', '.starts-required', 'unpaid', 'remaining', 'first fix round', 'outside tests']) expect(text).toContain(phrase);
    expect(text).not.toContain('inline starts from the reviewed part B build migrate on save');
    expect(text).not.toContain('A start whose journal spend expired becomes full hashless unpaid debt.');
  }
});
it.each([false, true])('C2: every first-use publication must permit restart and continued work (first start=%s)', async withStart => {
  for (const nth of [1, 2, 3]) {
    const f = file(), st = new StateStore(f, identity), initial = { incomeSpend: withStart ? [debt({ hash: undefined })] : [] };
    resetCut(); cut.nth = nth;
    try { expect(() => st.save(initial, time)).toThrow('stopped'); }
    finally { resetCut(); st.close(); }
    expect(existsSync(f + '.starts')).toBe(true);
    const next = new StateStore(f, identity);
    try {
      const got = next.load(time); expect(got.incomeSpend ?? []).toEqual(initial.incomeSpend);
      const port = fundedOther(time); await runTick(port, got, { ...options(), dryRun: false, checkpoint: checkpoint(next) }, quiet);
      expect(port.send).toHaveBeenCalledOnce(); expect(existsSync(f + '.starts-required')).toBe(true);
    } finally { next.close(); }
  }
});

const payment = time + 24n;
it.each(['reserve', 'hash', 'settle', 'repay', 'expiry', 'mixed'] as const)('every write of %s must restart with the required costs and permit another funded box', async event => {
  const old = debt({ start: { job: 'collect', repaidAt: payment, paymentHashes: [hash(4)] } });
  const fresh = debt({ box: addr(4), at: time + 86424n, hash: undefined });
  const ordinary = { box: addr(3), at: time - 1n, costWei: C };
  const before = event === 'reserve' ? [ordinary] : [ordinary, event === 'hash' ? debt({ hash: undefined }) : ['expiry', 'mixed'].includes(event) ? old : debt()];
  const after = event === 'reserve' ? [ordinary, debt({ hash: undefined })] : event === 'hash' ? [ordinary, debt()]
    : event === 'settle' ? [ordinary, debt({ start: { job: 'collect', settledAt: payment } })]
    : event === 'repay' ? [ordinary, old] : event === 'mixed' ? [ordinary, fresh] : [ordinary];
  const now = ['expiry', 'mixed'].includes(event) ? payment + 86400n : payment;
  const writes = event === 'mixed' ? 3 : 2;
  for (let nth = 1; nth <= writes; nth++) {
    const f = file(), st = new StateStore(f, identity); st.save({ incomeSpend: before }, time);
    resetCut(); cut.nth = nth;
    try { expect(() => st.save({ incomeSpend: after }, now)).toThrow('stopped'); }
    finally { resetCut(); st.close(); }
    const next = new StateStore(f, identity);
    try {
      const got = next.load(now), active = activeIncomeSpend(got.incomeSpend ?? [], empty(now));
      expect(active).toEqual(after);
      const port = fundedOther(now); await runTick(port, got, { ...options(), dryRun: false, checkpoint: checkpoint(next) }, quiet);
      expect(port.send).toHaveBeenCalledOnce();
      expect(next.load(now).incomeSpend?.filter(s => s.box !== addr(88))).toEqual(after);
    } finally { next.close(); }
  }
});
it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])('two same-tick attempts stopped after write %i must preserve each published debt and continue', async nth => {
  const h = ambiguous(), f = file(), st = new StateStore(f, identity); resetCut(); cut.nth = nth;
  try { await expect(runTick(h.port, {}, { ...h.cfg, checkpoint: checkpoint(st) }, quiet)).rejects.toThrow('stopped'); }
  finally { resetCut(); st.close(); }
  const next = new StateStore(f, identity);
  try {
    const got = next.load(time), spends = got.incomeSpend ?? [];
    expect(spends).toHaveLength(nth < 3 ? 0 : nth < 4 ? 1 : 2);
    expect(spends.reduce((n, s) => n + s.costWei, 0n)).toBe(BigInt(spends.length) * equalCost);
    expect(startUnpaid(addr(3), spends)).toBe(nth >= 4);
    if (nth >= 4) expect(spends.map(s => s.at)).toEqual([time, time + 1n]);
    const port = fundedOther(time + 90000n); await runTick(port, got, { ...h.cfg, checkpoint: checkpoint(next) }, quiet);
    expect(port.send).toHaveBeenCalledOnce();
  } finally { next.close(); }
});
it('U1: duplicate A pairs must be refused even when J is missing and the UUIDs differ', () => {
  const f = file(), st = new StateStore(f, identity);
  st.save({ incomeSpend: [debt()] }, time);
  const a = JSON.parse(readFileSync(f + '.starts', 'utf8'));
  a.starts.push({ ...a.starts[0], id: '00000000-0000-4000-8000-000000000001' });
  writeFileSync(f + '.starts', JSON.stringify(a)); writeFileSync(f, encodeState({ incomeSpend: [] }, identity));
  try { expect(() => st.load(time)).toThrow('keeper starts invalid or belongs to another chain/signer/registry'); }
  finally { st.close(); }
});
it('S7: a spend that loses data on load-back must publish no book or marker', () => {
  const f = file(), st = new StateStore(f, identity);
  const unencodable = { ...debt(), unencoded: 'cannot survive the unchanged journal and starts schemas' };
  try {
    expect(() => st.save({ incomeSpend: [unencodable] }, time)).toThrow('keeper books do not round trip');
    for (const p of [f, f + '.starts', f + '.starts-required']) expect(existsSync(p)).toBe(false);
  } finally { st.close(); }
});
it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])('two successful same-tick sends stopped after write %i must retain the published costs and continue', async nth => {
  const h = ambiguous(), f = file(), st = new StateStore(f, identity);
  h.send.mockReset().mockResolvedValueOnce(hash(1)).mockResolvedValue(hash(2));
  resetCut(); cut.nth = nth;
  try { await expect(runTick(h.port, {}, { ...h.cfg, checkpoint: checkpoint(st) }, quiet)).rejects.toThrow('stopped'); }
  finally { resetCut(); st.close(); }
  const next = new StateStore(f, identity);
  try {
    const got = next.load(time), spends = got.incomeSpend ?? [];
    expect(spends).toHaveLength(nth < 3 ? 0 : nth < 6 ? 1 : 2);
    expect(spends.reduce((n, s) => n + s.costWei, 0n)).toBe(BigInt(spends.length) * equalCost);
    expect(startUnpaid(addr(3), spends)).toBe(nth >= 6);
    if (nth >= 3) expect(spends[0]?.hash).toBe(nth >= 5 ? hash(1) : undefined);
    if (nth >= 6) {
      expect(spends.map(s => s.at)).toEqual([time, time + 1n]);
      expect(spends[1]?.hash).toBe(nth >= 8 ? hash(2) : undefined);
    }
    const port = fundedOther(time + 90000n);
    await runTick(port, got, { ...h.cfg, checkpoint: checkpoint(next) }, quiet);
    expect(port.send).toHaveBeenCalledOnce();
  } finally { next.close(); }
});
