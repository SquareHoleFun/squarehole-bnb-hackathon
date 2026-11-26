import { expect, it, vi } from 'vitest';
import { type Address, type PublicClient } from 'viem';
import { ViemChain } from '../src/chain';
import { incomeCost, incomeRefusal, reconcileStarts, startUnpaid, activeIncomeSpend, type IncomeReceipt, type IncomeSnapshot, type IncomeSpend } from '../src/income';
import { runTick, type KeeperState } from '../src/run';
import { restartStarts as restart } from './support/start-state';
import { readIncome, type ReceiptLog } from '../src/income-read';
import { receiptOf } from './support/income-receipts';
import { makeLogger } from '../src/log';
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
  return { cfg, port, pub, send, get b() { return b; }, set b(x) { b = x; },
    set tip(x: bigint) { tip = x; }, set estimate(x: bigint) { estimate = x; },
    set jobs(x: string[]) { jobs = x; }, set income(x: IncomeSnapshot | null) { income = x; },
    advance(seconds = 12n) { at += seconds; block += 25n; },
    tick: (s: KeeperState = {}) => runTick(port, restart(s), cfg, quiet) };
}


// Ported from the independent review's P:91,102,112,121,145,154,163,177.
it.each(['own', 'global'] as const)('ordinary %s admission keeps the pre-B literal boundary', kind => {
  const cost = 100n, previous = [{ box: addr(3), at: time, costWei: 17n }];
  for (const delta of [-1n, 0n, 1n]) {
    const room = cost + 17n + delta;
    const income = { ...empty(), platformWei: kind === 'global' ? room * 4n : 10000n,
      boxes: { [addr(3)]: { shareWei: kind === 'own' ? room : 10000n, tipsWei: 0n } } };
    expect(incomeRefusal(addr(3), cost, previous, income)).toBe(delta < 0n ? `${kind === 'own' ? 'box' : 'platform'} income cap` : null);
  }
});
it('a dry start stays charged but unlocked, while the same hashless live start stays locked forever', async () => {
  const h = harness(), cfg = { ...h.cfg, dryRun: true };
  const first = await runTick(h.port, {}, cfg, quiet);
  expect(first.report.sent.map(s => s.job)).toEqual(['collect']);
  expect(first.state.incomeSpend?.[0]?.start).toBeUndefined();
  expect(first.state.incomeSpend?.[0]?.at).toBe(time);
  expect(incomeCost(present(present(first.state.incomeSpend)[0]), empty())).toBe(C);
  expect(startUnpaid(addr(3), present(first.state.incomeSpend))).toBe(false);
  h.advance(172800n); h.income = proved([paid({ hash: hash(2), tipsWei: 100n * C })]);
  const later = await runTick(h.port, restart(first.state), cfg, quiet);
  expect(later.report.sent.map(s => s.job)).toEqual(['collect']);
  expect(later.state.incomeSpend?.some(s => s.at === time)).toBe(false);
  expect(h.send).not.toHaveBeenCalled();
  const live = harness(); live.send.mockRejectedValue(new Error('reply lost'));
  const reserved = await live.tick(); live.advance(172800n);
  live.income = proved([paid({ hash: hash(2), tipsWei: 100n * C })]);
  const blocked = await live.tick(reserved.state);
  expect(blocked.state.incomeSpend?.[0]).toEqual(debt({ hash: undefined }));
  expect(blocked.report.skipped).toContainEqual(expect.objectContaining({ code: 'START_UNPAID' }));
  const invalid = debt({ hash: 'UNTRUSTED_INVALID_HASH' });
  expect(reconcileStarts([invalid], proved([paid({ hash: hash(2), tipsWei: C * 100n })]))).toEqual([invalid]);
});
it('a second box cannot spend the first simulated tip', async () => {
  const h = harness(), other = box({ id: 6n, receiver: addr(88), hook: addr(89), coordinator: addr(90),
    v2: { ...v2, buyBackP: 0n, depthBudget: 0n } });
  const port = { ...h.port, read: async () => ({ ...world(h.b), boxes: [h.b, other] }),
    simulate: async (c: Candidate, fees: Parameters<ViemChain['simulate']>[1], start = false) => c.boxId === 6n
      ? { ok: c.job === 'collect', estimate: 1190000n, tipWei: null, startTipWei: 0n } : h.port.simulate(c, fees, start) };
  const out = await runTick(port, {}, h.cfg, quiet);
  expect(out.report.sent.map(s => s.job)).toEqual(['collect']);
  expect(out.report.skipped).toContainEqual(expect.objectContaining({ boxId: 6n, code: 'START_TIP_TOO_SMALL' }));
});
function history(n: number) {
  const a = box(), b = box({ id: 2n, receiver: addr(88), hook: addr(89), coordinator: addr(90) });
  const safe = addr(55), pm = addr(56), now = 1000000000n, height = BigInt(n + 1) * 10000n;
  const stamp = (x: bigint) => now - 12n - (height - x) * 12n;
  const spends = Array.from({ length: n }, (_, i) => ({ box: a.receiver, at: stamp(BigInt(i + 1) * 10000n) - 12n,
    costWei: C, hash: hash((i + 1) * 10000), start: { job: 'collect' as const, settledAt: stamp(BigInt(i + 1) * 10000n) } }));
  const logs = [{ address: b.receiver, eventName: 'PlatformPaid', args: { safe, amount: 4n * C }, blockNumber: height,
    blockHash: hash(Number(height)), transactionHash: hash(9000), logIndex: 1, removed: false },
  { address: safe, eventName: 'SafeReceived', args: { sender: pm, value: 4n * C }, blockNumber: height,
    blockHash: hash(Number(height)), transactionHash: hash(9000), logIndex: 0, removed: false }];
  const pub = {
    getBlock: vi.fn(async ({ blockNumber = height }: { blockNumber?: bigint }) =>
      ({ number: blockNumber, hash: hash(Number(blockNumber)), timestamp: stamp(blockNumber) })),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => functionName === 'q' ? addr(0) : functionName === 'PLATFORM_SAFE' ? safe : pm),
    // SH-247: the box payment's own receipt, holding its logs, is where its proof is read; start hashes keep theirs.
    getTransactionReceipt: vi.fn(async ({ hash: h }: { hash: string }) => h === hash(9000)
      ? { ...receiptOf(h, logs as unknown as ReceiptLog[], { blockNumber: height, blockHash: hash(Number(height)) }), from: keeper, to: b.receiver }
      : { transactionHash: h, blockNumber: BigInt(h), blockHash: h, status: 'success', from: keeper, to: a.receiver }),
    getLogs: vi.fn(async ({ address, event, events, fromBlock, toBlock }: { address: Address | Address[]; event?: { name: string };
      events?: { name: string }[]; fromBlock: bigint; toBlock: bigint }) => logs.filter(l =>
      (Array.isArray(address) ? address : [address]).includes(l.address) && (events ?? [event]).some(e => e?.name === l.eventName)
      && l.blockNumber >= fromBlock && l.blockNumber <= toBlock)),
  };
  return { pub, spends, b, now, run: (spend = spends) => readIncome(pub as unknown as PublicClient, [a, b], keeper, now, 0n, spend) };
}
it.each([0, 124, 125, 1000])('%i paid past starts neither add proof reads nor hide a second box income', async n => {
  const f = history(n), income = await f.run();
  const reads = [f.pub.getLogs.mock.calls.length, f.pub.getBlock.mock.calls.length, f.pub.getTransactionReceipt.mock.calls.length];
  expect(income.boxes[f.b.receiver]?.shareWei).toBe(4n * C);
  expect(incomeRefusal(f.b.receiver, C, activeIncomeSpend(f.spends, income), income)).toBeNull();
  expect(activeIncomeSpend(f.spends, income)).toEqual([]);
  // SH-247: only the second box's paying transaction is read (its proof); never a past start's.
  expect(f.pub.getTransactionReceipt.mock.calls.map(([c]) => c.hash)).toEqual([hash(9000)]);
  f.pub.getLogs.mockClear(); f.pub.getBlock.mockClear(); f.pub.getTransactionReceipt.mockClear();
  await f.run([]);
  expect([f.pub.getLogs.mock.calls.length, f.pub.getBlock.mock.calls.length, f.pub.getTransactionReceipt.mock.calls.length]).toEqual(reads);
});
it('untrusted RPC error messages and thrown strings never reach CLI log lines', async () => {
  const h = harness(), marker = 'UNTRUSTED_ARCHIVE_TEXT', lines: string[] = [];
  const log = makeLogger([], line => lines.push(line));
  await runTick({ ...h.port, readIncome: async () => { throw new Error(marker); } }, { incomeSpend: [debt()] }, h.cfg, log);
  h.send.mockResolvedValue(marker);
  await runTick(h.port, {}, h.cfg, log);
  log.error('keeper failed', { error: marker });
  log.warn('read failed', { error: { message: marker, nested: marker } });
  expect(lines.join('\n')).not.toContain(marker);
  expect(lines.join('\n')).toContain('Error');
  expect(lines.join('\n')).toContain('income read failed; pokes deferred');
});
it('two debts cannot consume one later final receipt twice', () => {
  const a = debt(), b = debt({ at: time + 30n, hash: hash(3) });
  const r = paid({ hash: hash(2), at: time + 100n, shareWei: 8n * C, tipsWei: 0n, startTipWei: 0n });
  const income = { ...proved([r], time + 120n), mined: { [hash(1)]: time + 12n, [hash(3)]: time + 42n } };
  const result = reconcileStarts([a, b], income);
  expect(result[0]?.start?.repaidAt).toBe(time + 120n);
  expect(result[1]?.start?.repaidAt).toBeUndefined();
  expect(reconcileStarts(result, income)).toEqual(result);
});
it('a used receipt leaves the rolling window before its repaid record is dropped', () => {
  const r = paid({ hash: hash(2), at: time + 100n, shareWei: 8n * C, tipsWei: 0n, startTipWei: 0n });
  const income = proved([r], time + 120n);
  const repaid = reconcileStarts([debt()], income);
  const second = debt({ at: time + 30n, hash: hash(3) });
  const at = time + 86520n; // receipt expires at +86500; repayment record expires at +86520.
  expect(activeIncomeSpend(repaid, { ...income, at: at - 1n })).toHaveLength(1);
  expect(activeIncomeSpend(repaid, { ...income, at })).toEqual([]);
  expect(activeIncomeSpend(repaid, null, false, at)).toEqual([]);
  // Even a stale caller supplying the old proof cannot assign it after the consuming record is gone.
  const after = reconcileStarts([second], { ...income, at });
  expect(startUnpaid(addr(3), after)).toBe(true);
  expect(after).toEqual([second]);
});
it.each([addr(0), TETH])('ordinary buy-back for %s keeps its pre-B signed cost boundary', async q => {
  const b = box({ v2: { ...v2, q, buyBackP: 1000000000000000000n, depthBudget: 0n } }), cost = 24000000000000000n;
  for (const delta of [-1n, 0n, 1n]) {
    const income = { ...empty(), boxes: { [b.receiver]: { shareWei: 0n, tipsWei: cost + delta } } };
    const out = await runTick({ read: async () => world(b), readIncome: async () => income,
      simulate: async c => ({ ok: c.job === 'buyBack', estimate: 100000n, tipWei: null }), send: async () => hash(1234) },
    { incomeSpend: [] }, { ...options(), dryRun: false, priorityFeeWei: 2999999998n }, quiet);
    expect(out.report.sent.map(s => s.job)).toEqual(delta < 0n ? [] : ['buyBack']);
    expect(out.state.incomeSpend).toEqual(delta < 0n ? [] : [{ box: b.receiver, at: time, costWei: cost, hash: hash(1234) }]);
  }
});
it.each([false, true])('a changed pending head refuses only start admission (ordinary=%s)', async ordinary => {
  const h = harness(); let pending = 100n; const seen: bigint[] = [];
  h.pub.simulateContract.mockImplementation(async () => { seen.push(pending); return { result: { buyersP: 990102n, sellersP: 0n, qToReserve: 0n, tip: C } }; });
  h.pub.estimateGas.mockImplementation(async () => { pending += 1n; seen.push(pending); return 21000n; });
  h.pub.getBlock.mockImplementation(async () => ({ number: pending, hash: hash(Number(pending)), timestamp: time + 12n, gasLimit: 60000000n }));
  if (ordinary) h.income = proved([paid({ tipsWei: 2n * C })]);
  const out = await h.tick();
  expect(seen).toEqual(ordinary ? [100n, 101n] : [100n, 101n, 101n, 102n]);
  expect(out.report.sent.map(s => s.job)).toEqual(ordinary ? ['collect'] : []);
  if (!ordinary) expect(out.report.skipped).toContainEqual(expect.objectContaining({ code: 'SIMULATION_ERROR' }));
});

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing fixture value');
  return value;
}

it.each([false, true])('an unreadable pending head refuses only a start (ordinary=%s)', async ordinary => {
  const h = harness(); h.pub.getBlock.mockRejectedValue(new Error('UNTRUSTED_PENDING_TEXT'));
  if (ordinary) h.income = proved([paid({ tipsWei: 2n * C })]);
  const out = await h.tick();
  expect(out.report.sent.map(s => s.job)).toEqual(ordinary ? ['collect'] : []);
  if (!ordinary) expect(out.report.skipped).toContainEqual(expect.objectContaining({ code: 'SIMULATION_ERROR' }));
});

it('paid records leave the books on time even when the current income snapshot fails', async () => {
  const h = harness(); h.advance(172800n); h.income = null;
  const out = await h.tick({ incomeSpend: [debt({ start: { job: 'collect', settledAt: time + 12n } })] });
  expect(out.state.incomeSpend).toEqual([]);
  expect(h.send).not.toHaveBeenCalled();
});
it('migration keeps old repayment assignments until the new repayment window ends', () => {
  const old = debt({ start: { job: 'collect', paymentHashes: [hash(2)] } });
  const r = paid({ hash: hash(4), at: time + 200n, shareWei: 8n * C, tipsWei: 0n, startTipWei: 0n });
  const next = reconcileStarts([old], proved([r], time + 220n));
  expect(next[0]?.start?.paymentHashes).toEqual([hash(2), hash(4)]);
  const another = debt({ hash: hash(3), at: time + 30n });
  const reused = reconcileStarts([...next, another], proved([{ ...r, hash: hash(2), at: time + 100n }], time + 220n));
  expect(reused[1]?.start?.repaidAt).toBeUndefined();
});
