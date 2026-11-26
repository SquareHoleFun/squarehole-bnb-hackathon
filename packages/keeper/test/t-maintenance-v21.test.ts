/**
 * SH-V21-FIX-KEEPER-INDEX, findings ACC-V21-M02 and V21-OC-02 (F111): routine T maintenance stays inside each box's
 * income caps and outside the protected recovery reserve; a pass that cannot move money is never proposed; every
 * path a claim waits on (P settlement, item sync, exits, Safe payments) keeps its reserve.
 */
import { describe, expect, it } from 'vitest';
import { toHex, type Address, type PublicClient } from 'viem';
import { readM2 } from '../src/m2';
import { readM3 } from '../src/m3';
import { ViemChain, interpret } from '../src/chain';
import { decide, openBudget } from '../src/decide';
import { incomeCapped } from '../src/income';
import { emptyMemory, plan } from '../src/plan';
import { runTick, type ChainPort } from '../src/run';
import { loadConfig } from '../src/config';
import { feesFor } from '../src/gas';
import type { Candidate } from '../src/types';
import type { M2Work } from '../src/m2';
import { addr, box, fundedIncome, keeper, options, quiet, time, v2, world } from './support/v2';

/** 0.01 T in raw units; spelled out so a changed floor fails here first. */
const FLOOR = 10_000_000_000_000_000n;
const ledger = addr(17), token = addr(1), receiver = addr(5), hook = addr(2);

interface Holders {
  choices: readonly [number, number];
  payout?: Address;
  active: bigint;
  paid: Record<string, bigint>;
  complete: Record<string, boolean>;
  residue: Record<string, bigint>;
  reads: string[];
}
const holders = (over: Partial<Holders> = {}): Holders =>
  ({ choices: [7, 4], active: 5n, paid: {}, complete: {}, residue: {}, reads: [], ...over });
/** Canonical reads of one box: HoldersT on odd (buyers) ids by default, Holders in P on even ids. */
function readHolders(s: Holders, failed = false) {
  const call = async <T>(_to: Address, _abi: readonly unknown[], fn: string, args?: readonly unknown[]): Promise<T> => {
    s.reads.push(fn);
    const id = String(args?.[0]);
    const result = fn === 'roleOf' ? (args?.[1] === 17n ? ledger : token)
      : fn === 'holderLedger' ? ledger
        : fn === 'currentTradeBatch' ? s.active
          : fn === 'tradeBatch' ? { closed: true }
            : fn === 'holderBatchClosed' ? true
              : fn === 'buyersChoice' ? s.choices[0]
                : fn === 'sellersChoice' ? s.choices[1]
                  : fn === 'payoutAsset' ? s.payout ?? token
                    : fn === 'holderBatchPaid' ? s.paid[id] ?? 0n
                      : fn === 'batchState' ? [s.complete[id] ?? false, 0n, 0n, s.residue[id] ?? 0n] : undefined;
    if (result === undefined) throw new Error(`unexpected read ${fn}`);
    return result as T;
  };
  return readM2({ registry: addr(90), id: 1n, hook, receiver, coordinator: addr(0), failed, scan: {}, call,
    code: async () => '0x', guard: async (_key, read, fallback) => { try { return await read(); } catch { return fallback(); } } });
}
const summary = (work: readonly M2Work[]) => work.map(w => [w.fn, w.args[0], w.ordinary === true, w.minAmountRaw]);

describe('ACC-V21-M02 / V21-OC-02: holder passes move money, T maintenance is ordinary', () => {
  it('proposes no pass for allocated, zero-funded batches on either side before graduation or after failure', async () => {
    for (const failed of [false, true]) {
      const s = holders();
      expect(summary(await readHolders(s, failed))).toEqual([]);
      // G1-D3: both P and T batches must have actual funding before settlement is scheduled.
      expect(s.reads.filter(fn => fn === 'holderBatchPaid')).toHaveLength(4);
      expect(s.reads.filter(fn => fn === 'payoutAsset')).toHaveLength(1);
      expect(await readHolders(holders({ choices: [7, 7] }), failed)).toEqual([]);
    }
  });

  it('schedules only newly funded T batches, once each, as ordinary work; a later purchase reopens a tranche', async () => {
    const s = holders({ choices: [7, 7], paid: { 3: 1n } });
    expect(summary(await readHolders(s))).toEqual([['settleBatch', 3n, true, undefined]]);
    Object.assign(s, { paid: { 1: 5n, 3: 1n }, complete: { 3: true } });
    const work = await readHolders(s);
    expect(summary(work)).toEqual([['settleBatch', 1n, true, undefined]]);
    expect(work[0]).toMatchObject({ job: 'holderSettle', to: ledger, args: [1n, 16n], key: `holderSettle:2:${ledger}:1` });
    Object.assign(s, { complete: { 1: false, 3: false }, paid: { 1: 6n, 3: 9n } });
    expect(summary(await readHolders(s))).toEqual([['settleBatch', 1n, true, undefined], ['settleBatch', 3n, true, undefined]]);
  });

  it('burns T residue only from 0.01 T as ordinary work; P residue keeps any positive proved amount and its reserve', async () => {
    const s = holders({ paid: { 1: 5n, 3: 5n }, complete: { 1: true, 2: true, 3: true, 4: true },
      residue: { 1: FLOOR - 1n, 2: 1n, 3: FLOOR, 4: 0n } });
    const work = await readHolders(s);
    expect(summary(work)).toEqual([['flushResidue', 2n, false, undefined], ['flushResidue', 3n, true, FLOOR]]);
    const [p, t] = work as [Candidate, Candidate];
    expect(interpret(t, FLOOR - 1n, null).ok).toBe(false);
    expect(interpret(t, FLOOR, null).ok).toBe(true);
    expect(interpret(p, 1n, null).ok).toBe(true);
    expect(interpret(p, 0n, null).ok).toBe(false);
  });

  it('item T residue burns carry the same floor and ordinary mark; item P residue and item sync keep theirs', async () => {
    const call = async <T>(_to: Address, _abi: readonly unknown[], fn: string, args?: readonly unknown[]): Promise<T> =>
      (fn === 'roleOf' ? addr(args?.[1] === 16n ? 16 : 3) : fn === 'itemLedger' ? addr(16)
        : fn === 'tokenSides' ? 3 : fn === 'itemFundingCount' ? 20n : 0n) as T;
    const work = await readM3({ registry: addr(90), id: 1n, receiver: addr(5), coordinator: addr(1), failed: false,
      graduated: true, gateOpen: true, call, guard: async (_key, read, fallback) => { try { return await read(); } catch { return fallback(); } } });
    const byFn = (fn: string) => work.find(w => w.fn === fn) as Candidate;
    expect(byFn('flushResidueT')).toMatchObject({ job: 'itemResidue', ordinary: true, minAmountRaw: FLOOR });
    expect(byFn('flushResidue').ordinary).toBeUndefined();
    expect(byFn('sync').ordinary).toBeUndefined();
    expect(interpret(byFn('flushResidueT'), FLOOR - 1n, null).ok).toBe(false);
    expect(interpret(byFn('flushResidueT'), FLOOR, null).ok).toBe(true);
    expect(interpret(byFn('flushResidue'), 1n, null).ok).toBe(true);
  });

  it('refuses all holder work when a T side ledger does not pay the box token; v2.0 choices never read T views', async () => {
    expect(await readHolders(holders({ payout: addr(77) }))).toEqual([]);
    const legacy = holders({ choices: [4, 1], paid: { 1: 5n, 2: 5n, 3: 5n, 4: 5n } });
    expect(summary(await readHolders(legacy))).toEqual([1n, 2n, 3n, 4n].map(id => ['settleBatch', id, false, undefined]));
    expect(legacy.reads.filter(fn => fn === 'holderBatchPaid')).toHaveLength(4);
    expect(legacy.reads).not.toContain('payoutAsset');
  });

  it('keeps an ordinary call of a reserved job out of the reserve and inside the income caps', () => {
    const cfg = loadConfig({ SH_KEEPER_RPC_URL: 'http://fake.invalid', SH_KEEPER_DESTINATION_FORK: 'osaka',
      SH_KEEPER_TRANSACTION_GAS_CAP: '16777216' });
    const fees = feesFor(1_475_000_000n, cfg.priorityFeeWei);
    // Only protected capacity remains: 0.051 ETH ours and the matching total.
    const budget = { ...openBudget(undefined, 1n, 0n), oursWei: 51_000_000_000_000_000n, totalWei: 63_000_000_000_000_000n };
    const sim = { ok: true, tipWei: null, estimate: 3_000_000n };
    for (const job of ['holderSettle', 'holderResidue', 'itemResidue'] as const) {
      const ctx = { fees, limits: cfg.limits, privateEndpoint: false, budget };
      expect(decide(job, sim, ctx), job).toMatchObject({ send: true, asOurs: true });
      expect(decide(job, sim, { ...ctx, ordinary: true }), job).toEqual({ send: false, why: 'daily ceiling reached' });
      // With total room left, the ours reserve still refuses it.
      expect(decide(job, sim, { ...ctx, ordinary: true, budget: { ...budget, totalWei: budget.oursWei } }), job)
        .toEqual({ send: false, why: 'ours budget spent' });
      const c: Candidate = { job, key: job, to: ledger, fn: 'x', args: [], version: 2 };
      expect([incomeCapped(c), incomeCapped({ ...c, ordinary: true }), incomeCapped({ ...c, ordinary: true, version: 1 })]).toEqual([false, true, false]);
    }
  });
});

const tSettle = (id: bigint): M2Work => ({ job: 'holderSettle', to: ledger, fn: 'settleBatch', args: [id, 16n],
  key: `holderSettle:2:${ledger}:${id}`, ordinary: true });
const pSettle: M2Work = { job: 'holderSettle', to: ledger, fn: 'settleBatch', args: [2n, 16n], key: `holderSettle:2:${ledger}:2` };

describe('ACC-V21-M02: budgets', () => {
  it('caps purchased-T settlement by the box income while P settlement stays exempt', async () => {
    const w = world(box({ v2: { ...v2, buyBackP: 0n, depthBudget: 0n, m2: [tSettle(1n), pSettle] } }));
    expect(plan(w, emptyMemory(), options()).candidates.filter(c => c.job === 'holderSettle').map(c => c.ordinary)).toEqual([true, undefined]);
    const sent: string[] = [];
    const port: ChainPort = { read: async () => w,
      readIncome: async () => ({ ...fundedIncome(w), platformWei: 0n, boxes: {} }),
      simulate: async c => ({ ok: c.job === 'holderSettle', estimate: 100_000n, tipWei: null }),
      send: async c => { sent.push(c.key); return '0x01'; } };
    const out = await runTick(port, {}, { ...options(), dryRun: false }, quiet);
    expect(out.report.skipped).toContainEqual(expect.objectContaining({ key: tSettle(1n).key, why: 'box income cap' }));
    expect(sent).toEqual([pSettle.key]);
  });

  it('after a day of T maintenance the full protected reserve still graduates a box (control: unmarked work starves it)', async () => {
    const tWork: M2Work[] = [...Array.from({ length: 12 }, (_, i) => tSettle(2n * BigInt(i) + 1n)),
      { job: 'holderResidue', to: ledger, fn: 'flushResidue', args: [3n], key: `holderResidue:2:${ledger}:3`, ordinary: true, minAmountRaw: FLOOR }];
    for (const marked of [true, false]) {
      // Control: the same work without its ordinary mark, as the keeper classified it before this fix.
      const m2 = marked ? tWork : tWork.map(w => ({ ...w, ordinary: undefined }));
      const busy = box({ id: 1n, hook: addr(40), receiver: addr(41), coordinator: addr(42), v2: { ...v2, buyBackP: 0n, depthBudget: 0n, m2 } });
      const filled = box({ id: 2n, hook: addr(50), receiver: addr(51), coordinator: addr(52), graduated: false });
      const at = (boxes: typeof busy[], number: bigint) => ({ ...world(busy, number), boxes,
        block: { number, timestamp: time, baseFeePerGas: 1_475_000_000n } });
      const sim = async (c: Candidate) => ({ ok: c.job !== 'collect' && c.job !== 'routerSweep', tipWei: null,
        estimate: c.job === 'graduate' ? 13_500_000n : 3_000_000n });
      const cfg = { ...options(), dryRun: false, priorityFeeWei: 50_000_000n, limits: { ...options().limits, maxTxPerBlock: 100 } };
      let w = at([busy], 100n);
      const port: ChainPort = { read: async () => w, readIncome: async () => fundedIncome(w), simulate: sim, send: async () => '0x01' };
      const day = await runTick(port, {}, cfg, quiet);
      const spent = day.state.budget;
      expect(day.report.sent.every(s => s.job === 'holderSettle' || s.job === 'holderResidue')).toBe(true);
      // Both stop at an ours limit: marked work at ours minus the reserve, unmarked work at the full ours budget.
      const waits = new Set(day.report.skipped.filter(s => s.job === 'holderSettle' || s.job === 'holderResidue').map(s => s.why));
      expect([...waits]).toEqual(['ours budget spent']);
      if (marked) {
        // Ordinary capacity only: 0.051 ETH ours, 0.063 ETH total; each send reserves 3.6M gas at 3 gwei.
        expect(day.report.sent).toHaveLength(4);
        expect(spent.oursWei).toBe(4n * 3_600_000n * 3_000_000_000n);
        expect(spent.oursWei <= cfg.limits.oursWeiPerDay - cfg.limits.reserveWeiPerDay).toBe(true);
        expect(spent.totalWei <= cfg.limits.totalWeiPerDay - cfg.limits.reserveWeiPerDay).toBe(true);
      } else {
        expect(day.report.sent).toHaveLength(9);
      }
      w = at([busy, filled], 101n);
      const later = await runTick(port, day.state, cfg, quiet);
      const graduate = { sent: later.report.sent.some(s => s.job === 'graduate'),
        skipped: later.report.skipped.find(s => s.job === 'graduate')?.why };
      expect(graduate).toEqual(marked ? { sent: true, skipped: undefined } : { sent: false, skipped: 'daily ceiling reached' });
    }
  });
});

describe('ACC-V21-M02: canonical chain reads', () => {
  it('reads choices, payout asset and T funding at the box snapshot and delivers ordinary work to the plan', async () => {
    const reads: { fn: string; blockNumber?: bigint }[] = [];
    const roles: Record<string, Address> = { 0: addr(0x10), 1: token, 2: hook, 3: addr(30), 5: receiver, 6: addr(6), 17: ledger };
    const client = {
      getChainId: async () => 11155111,
      request: async () => ({ number: '0x64', timestamp: toHex(time), baseFeePerGas: '0x1' }),
      getBlock: async () => ({ number: 100n, timestamp: time, baseFeePerGas: 1n, gasLimit: 30_000_000n }),
      getLogs: async () => [],
      getBytecode: async () => '0x',
      readContract: async (r: { functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) => {
        const { functionName: fn, args = [] } = r; reads.push({ fn, blockNumber: r.blockNumber });
        switch (fn) {
          case 'boxCount': return 1n;
          case 'roleOf': return roles[String(args[1])] ?? addr(0);
          case 'poolId': return `0x${'11'.repeat(32)}`;
          case 'poolManager': return addr(50);
          case 'q': return addr(0);
          case 'graduated': case 'closed': case 'gateOpen': case 'graduationSettled': case 'holderBatchClosed': return true;
          case 'failed': return false;
          case 'openAt': case 'closedAt': return time - 10n;
          case 'deadline': return time + 1000n;
          case 'holderLedger': return ledger;
          case 'currentTradeBatch': return 3n;
          case 'tradeBatch': return { tradeUnits: 100n, protocolUnits: 1n, netP: 10n, closed: true };
          case 'buyersChoice': return 7;
          case 'sellersChoice': return 4;
          case 'payoutAsset': return token;
          case 'holderBatchPaid': return args[0] === 1n ? 5n : 0n;
          case 'batchState': return [false, 0n, 0n, 0n];
          case 'claimState': return [0n, 1n];
          default: return 0n;
        }
      },
    } as unknown as PublicClient;
    const cfg = { ...options(), boxRegistry: addr(90) };
    const chain = new ViemChain(cfg, client, keeper, { public: null, private: null }, null, quiet);
    const settle = plan(await chain.read(), emptyMemory(), cfg).candidates.filter(c => c.job === 'holderSettle');
    expect(settle.map(c => [c.args[0], c.ordinary])).toEqual([[1n, true]]);
    // T alone reads the payout asset; both sides read funding. The unpaid P batch schedules no work.
    expect(reads.filter(r => r.fn === 'payoutAsset')).toHaveLength(1);
    expect(reads.filter(r => r.fn === 'holderBatchPaid')).toHaveLength(2);
    expect(reads.every(r => r.blockNumber === 99n)).toBe(true);
  });
});
