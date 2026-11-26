import { describe, expect, it, vi } from 'vitest';
import { type Address, type PublicClient } from 'viem';
import { ViemChain } from '../src/chain';
import { incomeCost, incomeRefusal, reconcileStarts, startRefusal, startUnpaid, activeIncomeSpend,
  START_MAX_SIGNED_COST_WEI, type IncomeReceipt, type IncomeSnapshot, type IncomeSpend } from '../src/income';
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
    getBlock: vi.fn(async () => ({ number: block - 10n, hash: hash(90), timestamp: at - 120n })),
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
  const send = vi.fn(async () => hash(1));
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
  return { cfg, port, pub, send, get b() { return b; }, set b(x) { b = x; },
    set tip(x: bigint) { tip = x; }, set estimate(x: bigint) { estimate = x; },
    set jobs(x: string[]) { jobs = x; }, set income(x: IncomeSnapshot | null) { income = x; },
    advance(seconds = 12n) { at += seconds; block += 25n; },
    tick: (s: KeeperState = {}) => runTick(port, restart(s), cfg, quiet) };
}

describe('F182 candidate-only start admission', () => {
  it.each([[addr(0), C], [TETH, C], [TUSDC, 1500n]] as const)('starts %s at exact signed cost from the same pending paid tip', async (q, raw) => {
    const h = harness(q, raw), checkpoints: KeeperState[] = [];
    h.send.mockImplementation(async () => {
      expect(checkpoints.at(-1)?.incomeSpend).toEqual([debt({ hash: undefined })]);
      return hash(1);
    });
    const out = await runTick(h.port, {}, { ...h.cfg, checkpoint: async s => { checkpoints.push(restart(s)); } }, quiet);
    expect(out.report.sent).toEqual([expect.objectContaining({ job: 'collect', asOurs: true, gas: 5_000_000n })]);
    expect(out.state.incomeSpend).toEqual([debt({ at: time })]);
    expect(out.state.budget.oursWei).toBe(C);
    expect(checkpoints[0]?.incomeSpend).toEqual([debt({ hash: undefined })]);
    expect(checkpoints[1]?.incomeSpend?.[0]?.hash).toBe(hash(1));
    expect(out.observed.income?.boxes).toEqual({});
    expect(h.pub.simulateContract).toHaveBeenCalledTimes(2);
    expect(h.pub.simulateContract).toHaveBeenCalledWith(expect.objectContaining({ blockTag: 'pending', account: keeper, args: [keeper] }));
    expect(h.pub.estimateGas).toHaveBeenCalledWith(expect.objectContaining({ blockTag: 'pending', maxFeePerGas: 3_000_000_000n }));
  });
  it('one wei short refuses even when the tip covers the gas estimate', async () => {
    const h = harness(addr(0), C - 1n);
    h.income = { ...empty(), boxes: { [addr(3)]: { shareWei: 0n, tipsWei: 1n } } };
    const out = await h.tick();
    expect(out.report.skipped).toContainEqual(expect.objectContaining({ job: 'collect', code: 'START_TIP_TOO_SMALL' }));
    expect(h.send).not.toHaveBeenCalled();
  });
  it.each(['zero', 'unknown coin', 'no snapshot', 'bad pin', 'stale price'] as const)('%s gives no start', async mode => {
    const h = harness(mode === 'unknown coin' ? addr(777) : TETH);
    if (mode === 'zero') h.tip = 0n;
    if (mode === 'no snapshot') h.income = null;
    if (mode === 'bad pin') h.pub.getBytecode.mockResolvedValue('0x6001');
    if (mode === 'stale price') h.pub.getBlock.mockResolvedValue({ number: 90n, hash: hash(90), timestamp: time - 1801n });
    expect((await h.tick()).report.sent).toEqual([]);
  });
  it('binds the paid-tip value to the simulated box, target and keeper beneficiary', async () => {
    const h = harness();
    const c: Candidate = { job: 'collect', version: 2, key: 'collect', boxId: 5n, to: addr(3), fn: 'collect',
      args: [keeper], minAmountRaw: 1n };
    const fees = { baseFeePerGas: 1n, maxPriorityFeePerGas: 2999999998n, maxFeePerGas: 3000000000n };
    for (const wrong of [{ ...c, args: [addr(77)] }, { ...c, to: addr(77) }, { ...c, boxId: 77n }, { ...c, value: 1n }]) {
      expect((await h.port.simulate(wrong, fees, true)).startTipWei).toBeNull();
    }
    expect((await h.port.simulate(c, fees, true)).startTipWei).toBe(C);
  });
  it('keeps the simulation minimum, gas, fee and block-rate checks', async () => {
    const h = harness();
    const minimum = await runTick(h.port, {}, { ...h.cfg, coinMinimums: { [addr(0)]: { collectRaw: 10n ** 18n } } }, quiet);
    expect(minimum.report.sent).toEqual([]);
    h.estimate = 16777217n;
    expect((await h.tick()).report.skipped).toContainEqual(expect.objectContaining({ code: 'GAS_ADMISSION' }));
    h.estimate = 1190000n;
    expect((await runTick(h.port, {}, { ...h.cfg, priorityFeeWei: 3000000000n }, quiet)).report.skipped)
      .toContainEqual(expect.objectContaining({ code: 'FEE_CAP' }));
    expect((await runTick(h.port, {}, { ...h.cfg, limits: { ...h.cfg.limits, maxTxPerBlock: 0 } }, quiet)).report.skipped)
      .toContainEqual(expect.objectContaining({ code: 'RATE_LIMIT' }));
    expect(h.send).not.toHaveBeenCalled();
  });
  it('a signed cost above 0.05 ETH refuses with START_COST_CAP', async () => {
    const h = harness(addr(0), 60_000_000_000_000_000n); h.estimate = 16_700_000n;
    expect((await h.tick()).report.skipped).toContainEqual(expect.objectContaining({ job: 'collect', code: 'START_COST_CAP' }));
    expect(h.send).not.toHaveBeenCalled();
  });
  it.each(['buyBack', 'deepen'] as const)('%s never starts, even with a valued tip', job => {
    const c: Candidate = { job, key: job, version: 2, to: addr(2), fn: job, args: [keeper] };
    expect(startRefusal(c, { ok: true, estimate: 1n, tipWei: C, startTipWei: C }, addr(3), C, [], empty())).not.toBeNull();
  });
  it('positive fee sale can start on a seller-only box', async () => {
    const h = harness(TUSDC, 8209n); h.jobs = ['sellFees'];
    h.b = { ...h.b, v2: { ...present(h.b.v2), depthBudget: 0n } };
    const out = await h.tick();
    expect(out.report.sent.map(s => s.job)).toEqual(['sellFees']);
    expect(out.state.incomeSpend?.[0]).toMatchObject({ costWei: 24_600_000_000_000_000n, start: { job: 'sellFees' } });
    expect(h.pub.simulateContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'sellFees', args: [] }));
  });
  it.each(['total', 'ours'] as const)('the daily %s limit still refuses a native paid-tip start', async counter => {
    const h = harness();
    const cfg = { ...h.cfg, limits: { ...h.cfg.limits, [counter === 'total' ? 'totalWeiPerDay' : 'oursWeiPerDay']: h.cfg.limits.reserveWeiPerDay + C - 1n } };
    const out = await runTick(h.port, {}, cfg, quiet);
    expect(out.report.skipped).toContainEqual(expect.objectContaining({ code: counter === 'total' ? 'DAILY_TOTAL' : 'DAILY_OURS' }));
    expect(h.send).not.toHaveBeenCalled();
  });
  it('the forecast gives no received income, no room to another box, and no second send', async () => {
    const h = harness(); h.jobs = ['collect', 'deepen'];
    const out = await h.tick();
    expect(out.report.sent.map(s => s.job)).toEqual(['collect']);
    expect(out.report.skipped).toContainEqual(expect.objectContaining({ job: 'deepen', code: 'START_UNPAID' }));
    expect(out.observed.income).toEqual(empty());
    expect(incomeRefusal(addr(88), 1n, out.state.incomeSpend ?? [], out.observed.income)).toBe('box income cap');
    h.advance(); h.income = { ...empty(), platformWei: 10n ** 18n, boxes: { [addr(3)]: { shareWei: 10n ** 18n, tipsWei: 0n } } };
    expect((await h.tick(out.state)).report.skipped).toContainEqual(expect.objectContaining({ job: 'collect', code: 'START_UNPAID' }));
    expect(h.send).toHaveBeenCalledTimes(1);
  });
  it('a reserved payment passes an unpaid lock', async () => {
    const h = harness(); const first = await h.tick(); h.advance();
    h.b = { ...h.b, fitOwed: 1000n }; h.jobs = ['collect', 'receiverPayFit'];
    expect((await h.tick(first.state)).report.sent.map(s => s.job)).toEqual(['receiverPayFit']);
  });
  it('ordinary income is tried first and keeps native tip budget treatment', async () => {
    const h = harness(); h.income = { ...empty(), platformWei: C * 4n, boxes: { [addr(3)]: { shareWei: C * 4n, tipsWei: 0n } } };
    const out = await h.tick();
    expect(out.report.sent[0]?.asOurs).toBe(false);
    expect(out.state.incomeSpend?.[0]?.start).toBeUndefined();
    expect(out.state.budget.oursWei).toBe(0n);
  });
  it('a failed pre-signing checkpoint cannot broadcast a start', async () => {
    const h = harness();
    await expect(runTick(h.port, {}, { ...h.cfg, checkpoint: async () => { throw new Error('disk unavailable'); } }, quiet))
      .rejects.toThrow('disk unavailable');
    expect(h.send).not.toHaveBeenCalled();
  });
  it('ambiguous sends stay hashless and never repay automatically, across midnight and downtime', async () => {
    const h = harness(); h.send.mockRejectedValue(new Error('accepted then lost reply'));
    const out = await h.tick(); h.advance(172_800n);
    h.income = proved([paid({ hash: hash(2), tipsWei: C * 100n })]);
    const later = await h.tick(out.state);
    expect(later.state.incomeSpend?.[0]).toEqual(debt({ hash: undefined }));
    expect(later.report.skipped).toContainEqual(expect.objectContaining({ code: 'START_UNPAID' }));
    expect(h.send).toHaveBeenCalledTimes(1);
  });
});

describe('F182 durable settlement and repayment', () => {
  it('success, finality, one credit, then ordinary work continues', async () => {
    const h = harness(), first = await h.tick(); h.advance(); h.jobs = ['deepen'];
    expect((await h.tick(first.state)).report.sent).toEqual([]);
    h.advance(); h.income = proved([paid({ tipsWei: 118_860_000_000_000_000n, startTipWei: 118_860_000_000_000_000n })]);
    const out = await h.tick(first.state);
    expect(out.state.incomeSpend?.[0]?.start).toEqual({ job: 'collect', settledAt: time + 12n });
    expect(out.report.sent.map(s => s.job)).toEqual(['deepen']);
    expect(out.observed.income?.boxes[addr(3)]?.tipsWei).toBe(118_860_000_000_000_000n);
  });
  it.each(['revert', 'small tip', 'unreadable', 'unfinalized'] as const)('%s stays unpaid after 24 hours and restart', kind => {
    const income = kind === 'unreadable' ? null : kind === 'unfinalized' ? empty(time + 172800n)
      : proved(kind === 'small tip' ? [paid({ tipsWei: C - 1n, startTipWei: C - 1n })] : [], time + 172800n);
    const retained = activeIncomeSpend(present(restart({ incomeSpend: [debt()] }).incomeSpend), income);
    expect(retained).toHaveLength(1);
    const next = reconcileStarts(retained, income);
    expect(startUnpaid(addr(3), next)).toBe(true);
    expect(incomeCost(present(next[0]), income)).toBe(C);
  });
  it('final settlement survives missing proofs and drops at the debit boundary', () => {
    const settled = present(restart({ incomeSpend: reconcileStarts([debt()], proved([paid()])) }).incomeSpend);
    expect(startUnpaid(addr(3), reconcileStarts(settled, null))).toBe(false);
    expect(reconcileStarts(settled, empty())).toEqual(settled);
    expect(activeIncomeSpend(settled, empty(time + 86411n))).toHaveLength(1);
    expect(activeIncomeSpend(settled, empty(time + 86412n))).toEqual([]);
  });
  it('later same-box income repays under both caps once and keeps a fresh 24-hour debit', () => {
    const r = paid({ hash: hash(2), at: time + 100n, shareWei: C * 4n, tipsWei: 0n, startTipWei: 0n });
    const tooSmall = proved([{ ...r, shareWei: C * 4n - 1n }], time + 120n);
    expect(startUnpaid(addr(3), reconcileStarts([debt()], tooSmall))).toBe(true);
    const income = proved([r], time + 120n), settled = reconcileStarts([debt()], income);
    expect(settled[0]?.start).toEqual({ job: 'collect', repaidAt: time + 120n, paymentHashes: [hash(2)] });
    expect(incomeRefusal(addr(3), 1n, settled, income)).toBe('platform income cap');
    const replay = reconcileStarts(present(restart({ incomeSpend: settled }).incomeSpend), { ...income, at: time + 150n });
    expect(replay).toEqual(settled);
    expect(incomeCost(present(replay[0]), { ...income, at: time + 86519n })).toBe(C);
    expect(incomeCost(present(replay[0]), { ...income, at: time + 86520n })).toBe(0n);
    const another = debt({ at: time + 1n, hash: hash(3) });
    const attempted = reconcileStarts([...replay, another], { ...income, at: time + 86520n, mined: { ...income.mined, [hash(3)]: time + 20n } });
    expect(startUnpaid(addr(3), attempted)).toBe(true);
    expect(startUnpaid(addr(3), reconcileStarts(replay, { ...income, startReceipts: [] }))).toBe(false);
  });
  it('another box and pre-start income cannot repay this box debt', () => {
    for (const r of [paid({ box: addr(88), hash: hash(2) }), paid({ hash: hash(2), at: time })]) {
      expect(startUnpaid(addr(3), reconcileStarts([debt()], proved([r])))).toBe(true);
    }
  });
  it('old journals preserve spend and have no outstanding start', () => {
    const old = restart({ incomeSpend: [{ box: addr(3), at: time, costWei: 7n }] });
    expect(old.incomeSpend).toEqual([{ box: addr(3), at: time, costWei: 7n }]);
    expect(startUnpaid(addr(3), present(old.incomeSpend))).toBe(false);
  });
  it('the cap is a fixed code constant', () => {
    expect(START_MAX_SIGNED_COST_WEI).toBe(50_000_000_000_000_000n);
  });
});

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing fixture value');
  return value;
}
