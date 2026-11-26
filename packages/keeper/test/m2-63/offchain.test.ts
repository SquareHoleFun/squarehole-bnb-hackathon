import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { transactionGas } from '../../src/gas';
import { readM2, type M2Scan } from '../../src/m2';
import { decodeState, encodeState } from '../../src/state';
import { runTick, type KeeperState } from '../../src/run';
import { interpret } from '../../src/chain';
import { addr, box, options, quiet, time, v2, world } from '../support/v2';

function fixture() {
  const state = { active: 19n, closed: true, final: true, complete: false, failed: true, broken: '', residue: 9n, wired: true };
  const reads: string[] = [], errors: string[] = [];
  const context: Parameters<typeof readM2>[0] = { registry: addr(90), id: 1n, hook: addr(2), receiver: addr(5), coordinator: addr(1), failed: true, scan: {},
    code: async () => `0x363d3d373d3d3d363d73${'11'.repeat(20)}5af43d82803e903d91602b57fd5bf3${'00'.repeat(234)}04`,
    guard: async (source, read, fallback) => { try { return await read(); } catch { errors.push(source); return fallback(); } },
    call: async <T>(_to: unknown, _abi: unknown, fn: string, args: readonly unknown[] = []) => {
      reads.push(fn); if (fn === state.broken) throw new Error('RPC unavailable');
      if (fn === 'roleOf') return addr(args[1] === 17n ? 17 : args[1] === 3n ? 3 : 10) as T;
      // Both sides pay holders in P (choice 4); the v2.1 reader checks the side choice before any T-only read.
      const values: Record<string, unknown> = { holderLedger: addr(state.wired ? 17 : 18), currentTradeBatch: state.active, buyersChoice: 4, sellersChoice: 4,
        tradeBatch: { closed: state.closed }, holderBatchClosed: state.final, holderBatchPaid: 100n, batchState: [state.complete, 20n, 0n, state.residue], failedT: 1n, collectionSize: 18n };
      if (!(fn in values)) throw new Error(`unexpected read ${fn}`);
      return values[fn] as T;
    } };
  return { state, context, reads, errors };
}

describe('M263 keeper transaction agreement', () => {
  it('OC-03: the real-contract probe uses the actual keeper envelope for a successful no-op estimate', () => {
    const source = readFileSync(new URL('./ShopBudget.t.sol', import.meta.url), 'utf8');
    const raw = source.match(/KEEPER_FLOOR = ([\d_]+);/)?.[1];
    expect(raw).toBeDefined();
    expect(transactionGas('shopBurn', 30_000n)).toBe(BigInt((raw ?? '').replaceAll('_', '')));
    expect(transactionGas('shopBurn', 5_000_000n)).toBe(6_000_000n);
  });

  it('OC-03: reserves the complete burn envelope before sending and defers below its daily cost', async () => {
    const f = fixture();
    const jobs = (await readM2(f.context)).filter(j => j.fn === 'burnFailedT');
    expect(jobs).toHaveLength(1);
    const liability = 5_000_000n * 3n; // max fee = twice base fee plus priority fee
    let saved: KeeperState = {};
    const sent: { gas: bigint; total: bigint | undefined; ours: bigint | undefined }[] = [];
    const cfg = { ...options(), dryRun: false, priorityFeeWei: 1n,
      checkpoint: async (s: KeeperState) => { saved = s; } };
    const port = { read: async () => world(box({ failed: true, graduated: false,
        v2: { ...v2, m2: jobs } })),
      simulate: async (c: Parameters<typeof interpret>[0]) => ({ ...interpret(c, 1100n, null), ok: c.job === 'shopBurn', estimate: 30_000n }),
      send: async (_c: unknown, gas: bigint) => {
        sent.push({ gas, total: saved.budget?.totalWei, ours: saved.budget?.oursWei });
        return 'burn-hash';
      } };
    const limits = { ...cfg.limits, totalWeiPerDay: liability, oursWeiPerDay: liability, reserveWeiPerDay: 0n };
    const deferred = await runTick(port, {}, { ...cfg, limits: { ...limits, totalWeiPerDay: liability - 1n } }, quiet);
    expect(deferred.report.sent).toHaveLength(0); expect(sent).toHaveLength(0);
    const first = await runTick(port, {}, { ...cfg, limits }, quiet);
    expect(first.report.sent.map(c => c.job)).toEqual(['shopBurn']);
    expect(sent).toEqual([{ gas: 5_000_000n, total: liability, ours: liability }]);
    await runTick(port, decodeState(encodeState(first.state, 'oc03'), 'oc03'), { ...cfg, limits }, quiet);
    expect(sent).toHaveLength(1);
  });

  it('M263-JOBS: restart-safe pages reach every batch and NFT without holder enumeration or pushes', async () => {
    const f = fixture(); let scan: M2Scan = {};
    const batches = new Set<bigint>(), items = new Set<bigint>();
    for (let visit = 0; visit < 3; visit++) {
      const jobs = await readM2({ ...f.context, scan });
      for (const job of jobs) {
        expect(['settleBatch', 'burnFailedT', 'returnStarter']).toContain(job.fn);
        if (job.fn === 'settleBatch') { expect(job.args[1]).toBe(16n); batches.add(job.args[0] as bigint); }
        if (job.fn === 'returnStarter') { expect(job.args).toHaveLength(1); items.add((job.args[0] as [bigint])[0]); }
      }
      const stored = encodeState({ m2Scan: scan }, 'm263');
      const wire = JSON.parse(stored) as { state: { m2Scan: Record<string, unknown> } };
      for (const value of Object.values(wire.state.m2Scan)) expect(value).toMatch(/^[0-9]+$/);
      scan = decodeState(stored, 'm263').m2Scan ?? {};
    }
    expect(batches.size).toBe(18); expect(items.size).toBe(18);
    expect(f.reads).not.toContain('claimable'); expect(f.reads).not.toContain('holderAt');
  });

  it('M263-JOBS: closure and funding independently gate settlement; failure never suppresses residue or NFT recovery', async () => {
    const f = fixture();
    for (const field of ['closed', 'final', 'wired'] as const) {
      f.state[field] = false;
      expect((await readM2(f.context)).filter(j => j.to === addr(17))).toEqual([]);
      f.state[field] = true;
    }
    f.state.complete = true; f.state.broken = 'failedT';
    const jobs = await readM2(f.context);
    expect(jobs.some(j => j.fn === 'flushResidue')).toBe(true);
    expect(jobs.filter(j => j.fn === 'returnStarter')).toHaveLength(8);
    expect(jobs.some(j => j.fn === 'burnFailedT')).toBe(true); // unknown read defers truth to simulation
    f.state.residue = 0n;
    expect((await readM2(f.context)).some(j => j.fn === 'flushResidue')).toBe(false);
    expect(f.errors.length).toBeGreaterThan(0);
  });

  it('M263-BUDGET: untipped settlement reserves the full gas ceiling before broadcast and a spent day sends nothing', async () => {
    const f = fixture(); f.state.active = 3n;
    const jobs = (await readM2({ ...f.context, failed: false })).filter(j => j.fn === 'settleBatch');
    let timestamp = time; let saved: KeeperState = {}; let sends = 0;
    const cfg = { ...options(), dryRun: false, priorityFeeWei: 1n, checkpoint: async (s: KeeperState) => { saved = s; } };
    const port = { read: async () => world(box({ v2: { ...v2, m2: jobs } }), 100n, timestamp),
      simulate: async (c: Parameters<typeof interpret>[0]) => ({ ...interpret(c, false, null), estimate: 100_000n }),
      send: async (_c: unknown, gas: bigint) => { expect(saved.budget?.totalWei).toBeGreaterThanOrEqual(gas * 3n); sends++; return 'hash'; } };
    const first = await runTick(port, {}, cfg, quiet); expect(sends).toBe(2);
    const restarted = decodeState(encodeState(first.state, 'm263'), 'm263');
    await runTick(port, restarted, cfg, quiet); expect(sends).toBe(2);
    timestamp += 86400n;
    const exhausted = { ...cfg, limits: { ...cfg.limits, totalWeiPerDay: 0n, oursWeiPerDay: 0n, reserveWeiPerDay: 0n } };
    expect((await runTick(port, {}, exhausted, quiet)).report.sent).toHaveLength(0);
  });
});
