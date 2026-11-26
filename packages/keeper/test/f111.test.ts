import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config';
import { decide, openBudget } from '../src/decide';
import { runTick, type ChainPort, type KeeperState } from '../src/run';
import { decodeState, encodeState, StateStore } from '../src/state';
import { INCOME_WINDOW_SECONDS } from '../src/income';
import type { Candidate, Sim } from '../src/types';
import { JOBS } from '../src/jobs';
import { addr, box, options, quiet, time, v2, world } from './support/v2';

const cost = 8_000_000n * 3n;
function fixture(share = cost, platform = cost * 4n, tips = 0n) {
  const b = box();
  let now = time;
  const income = { at: time, platformWei: platform, boxes: { [b.receiver.toLowerCase()]: { shareWei: share, tipsWei: tips } }, mined: {} };
  const send = vi.fn(async () => '0x' + 'ab'.repeat(32));
  const readIncome = vi.fn(async () => ({ ...income, at: now }));
  const port = { read: async () => world(b, 100n + now - time, now), readIncome,
    simulate: async (c: Candidate): Promise<Sim> => ({ ok: c.job === 'buyBack' || c.job === 'deepen', estimate: 100_000n, tipWei: null }), send };
  const cfg = { ...options(), dryRun: false, priorityFeeWei: 1n };
  return { b, port, income, cfg, send, advance: (n: bigint) => { now += n; } };
}

describe('F111 income admission', () => {
  it('scales the fixed outer limits and protects a padded 16.2M graduation at 3 gwei', () => {
    const cfg = options();
    expect(cfg.limits).toEqual({ drandRescueMaxFeeWei: 50_000_000_000n, drandRescueWindowSeconds: 259200n, drandRescueWeiPerDay: 50_000_000_000_000_000n, oursWeiPerDay: 102_000_000_000_000_000n, pokesWeiPerDay: 12_000_000_000_000_000n,
      reserveWeiPerDay: 51_000_000_000_000_000n, totalWeiPerDay: 114_000_000_000_000_000n, maxFeePerGas: 3_000_000_000n, maxTxPerBlock: 4, unblockingGasPerBoxPerDay: 816_000_000n,
      unblockingWeiPerDay: 25_500_000_000_000_000n, unblockingWeiPerBoxPerDay: 6_375_000_000_000_000n });
    expect(cfg.limits.reserveWeiPerDay).toBeGreaterThanOrEqual(16_200_000n * 3_000_000_000n);
  });
  it.each(JOBS.map(j => j.name))('%s waits above 3 gwei, including with a tip and a larger override', job => {
    const limits = { ...options().limits, maxFeePerGas: 50_000_000_000n };
    const ctx = { fees: { baseFeePerGas: 1n, maxPriorityFeePerGas: 1n, maxFeePerGas: 3_000_000_001n },
      limits, budget: openBudget(undefined, 1n, time), privateEndpoint: true };
    expect(decide(job, { ok: true, tipWei: 10n ** 18n, estimate: 100_000n }, ctx)).toEqual({ send: false, why: 'fee ceiling reached' });
  });
  it.each([[0n, cost * 4n, 'box income cap'], [cost, 0n, 'platform income cap'],
    [cost - 1n, cost * 4n, 'box income cap'], [cost, cost * 4n - 1n, 'platform income cap']] as const)('defers at own share %s / platform %s', async (share, platform, why) => {
    const f = fixture(share, platform);
    const out = await runTick(f.port, {}, f.cfg, quiet);
    expect(f.send).not.toHaveBeenCalled();
    expect(out.report.skipped).toContainEqual(expect.objectContaining({ job: 'buyBack', why }));
    expect(out.state.budget.totalWei).toBe(0n);
  });
  it('admits exact room, reserves before broadcast and keeps liability across a restart and UTC midnight', async () => {
    const f = fixture();
    const checkpoints: KeeperState[] = [];
    const cfg = { ...f.cfg, checkpoint: async (s: KeeperState) => { checkpoints.push(decodeState(encodeState(s, 'f111'), 'f111')); } };
    f.send.mockImplementation(async () => { expect(checkpoints.at(-1)).toHaveProperty('incomeSpend'); throw new Error('ambiguous'); });
    const first = await runTick(f.port, {}, cfg, quiet);
    expect(f.send).toHaveBeenCalledTimes(1);
    f.advance(3600n);
    const second = await runTick(f.port, decodeState(encodeState(first.state, 'f111'), 'f111'), cfg, quiet);
    expect(second.report.skipped).toContainEqual(expect.objectContaining({ why: 'box income cap' }));
    expect(f.send).toHaveBeenCalledTimes(1);
    f.advance(INCOME_WINDOW_SECONDS + 1n);
    const third = await runTick(f.port, decodeState(encodeState(second.state, 'f111'), 'f111'), cfg, quiet);
    expect(third.report.skipped).toContainEqual(expect.objectContaining({ why: 'box income cap' }));
    expect(third.state.incomeSpend).toEqual(first.state.incomeSpend);
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it.each([INCOME_WINDOW_SECONDS, INCOME_WINDOW_SECONDS + 1n])('expires dry-run spend after %s seconds across disk restarts without broadcasting', async elapsed => {
    const f = fixture();
    const read = f.port.read;
    f.port.read = async () => ({ ...await read(), boxes: [box({ v2: { ...v2, depthBudget: 0n } })] });
    f.port.simulate = async c => ({ ok: c.job === 'buyBack', estimate: 100_000n, tipWei: null });
    const scratch = new URL('../../../.cache/keeper-tests/', import.meta.url);
    mkdirSync(scratch, { recursive: true });
    const file = `${mkdtempSync(fileURLToPath(new URL('f111-', scratch)))}/state.json.dry`;
    const tickAfterRestart = async () => {
      const store = new StateStore(file, 'f111-dry');
      try {
        return await runTick(f.port, store.load(), { ...f.cfg, dryRun: true,
          checkpoint: async (s, now) => { store.save(s, now); } }, quiet);
      } finally { store.close(); }
    };
    const first = await tickAfterRestart();
    expect(first.report.sent.map(s => s.job)).toEqual(['buyBack']);
    expect(first.state.incomeSpend).toEqual([{ box: f.b.receiver, at: time, costWei: cost }]);
    expect(first.state.budget.totalWei).toBe(cost);
    f.advance(INCOME_WINDOW_SECONDS - 1n);
    const beforeExpiry = await tickAfterRestart();
    expect(beforeExpiry.report.sent).toEqual([]);
    expect(beforeExpiry.report.skipped).toContainEqual(expect.objectContaining({ job: 'buyBack', why: 'box income cap' }));
    // UTC daily ceilings have rolled over, but the rolling reservation has not.
    expect(beforeExpiry.state.budget.totalWei).toBe(0n);
    f.advance(elapsed - INCOME_WINDOW_SECONDS + 1n);
    // The reader supplies freshly funded income at the new pending time, with no mined transaction.
    const afterExpiry = await tickAfterRestart();
    expect(afterExpiry.report.sent.map(s => s.job)).toEqual(['buyBack']);
    expect(afterExpiry.state.incomeSpend).toEqual([{ box: f.b.receiver, at: time + elapsed, costWei: cost }]);
    expect(afterExpiry.state.budget.totalWei).toBe(cost);
    expect(f.send).not.toHaveBeenCalled();
  });
  it('buyBack and deepen credit received tips but never their simulated tip or another box share', async () => {
    const f = fixture(0n, cost * 4n);
    f.port.simulate = async c => ({ ok: c?.job === 'buyBack' || c?.job === 'deepen', estimate: 100_000n, tipWei: cost * 10n });
    const first = await runTick(f.port, {}, f.cfg, quiet);
    expect(first.report.sent).toEqual([]);
    f.income.boxes[f.b.receiver.toLowerCase()] = { shareWei: 0n, tipsWei: cost };
    // The deferred buyBack passed its turn (SH-KEEPER-V2-STEPS, STEPS-A): the received tip admits the next step, deepen.
    expect((await runTick(f.port, first.state, f.cfg, quiet)).report.sent.map(s => s.job)).toEqual(['deepen']);
    const g = fixture(0n, cost * 100n);
    g.income.boxes[addr(88)] = { shareWei: cost * 100n, tipsWei: cost * 100n };
    expect((await runTick(g.port, {}, g.cfg, quiet)).report.sent).toEqual([]);
  });
  it('fails closed for pokes when receipt reads fail, while recovery still runs', async () => {
    const f = fixture();
    f.port.readIncome.mockRejectedValue(new Error('no archive'));
    f.port.read = async () => world(box({ graduated: false }));
    f.port.simulate = async c => ({ ok: c?.job === 'graduate' || c?.job === 'collect', estimate: 100_000n, tipWei: null });
    const out = await runTick(f.port, {}, f.cfg, quiet);
    expect(out.report.sent.map(s => s.job)).toEqual(['graduate']);
    expect(out.report.skipped).toContainEqual(expect.objectContaining({ job: 'collect', why: 'income unavailable' }));
  });
  it('does not send an empty box, even when income exists; the pending simulation enforces batching', async () => {
    const f = fixture();
    f.port.read = async () => world(box({ v2: { ...v2, depthBudget: 0n, buyBackP: 0n } }));
    f.port.simulate = async () => ({ ok: false, estimate: 100_000n, tipWei: null });
    expect((await runTick(f.port, {}, f.cfg, quiet)).report.sent).toEqual([]);
  });
  it('logs fee deferral and admits exactly 3 gwei without borrowing recovery income', async () => {
    const f = fixture();
    let base = 1_475_000_001n;
    f.port.read = async () => ({ ...world(box({ graduated: false })), block: { number: 100n, timestamp: time, baseFeePerGas: base } });
    f.port.simulate = async c => ({ ok: c?.job === 'graduate', estimate: 13_500_000n, tipWei: null });
    const log = { ...quiet, warn: vi.fn() };
    const cfg = { ...f.cfg, priorityFeeWei: 50_000_000n };
    const first = await runTick(f.port as ChainPort, {}, cfg, log);
    expect(f.send).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith('skipped', expect.objectContaining({ code: 'FEE_CAP' }));
    base = 1_475_000_000n;
    expect((await runTick(f.port, first.state, cfg, log)).report.sent.map(s => s.job)).toEqual(['graduate']);
  });
  it('does not reset a legacy journal liability when income tracking is introduced', async () => {
    const f = fixture();
    const budget = { ...openBudget(undefined, 1n, time), totalWei: cost, oursWei: cost };
    const out = await runTick(f.port, { budget }, f.cfg, quiet);
    expect(out.report.sent).toEqual([]);
    expect(out.report.skipped).toContainEqual(expect.objectContaining({ why: 'box income cap' }));
  });
  it('defers high fees before an RPC simulation can obscure the reason', async () => {
    const f = fixture();
    f.port.read = async () => ({ ...world(), block: { number: 100n, timestamp: time, baseFeePerGas: 3_000_000_000n } });
    f.port.simulate = async () => { throw new Error('fee error'); };
    const out = await runTick(f.port, {}, f.cfg, quiet);
    expect(out.report.skipped.every(s => s.why === 'fee ceiling reached')).toBe(true);
  });
  it('recovers late failed-hook money with zero observed pot and income, but never sends an empty sweep', async () => {
    const f = fixture(0n, 0n);
    f.port.read = async () => world(box({ graduated: false, failed: true,
      v2: { ...v2, pot: 0n, tLeft: 0n, depthBudget: 0n, buyBackP: 0n } }));
    let waiting = false;
    f.port.simulate = async c => ({ ok: c.job === 'routerSweep' && waiting, estimate: 100_000n, tipWei: null });
    expect((await runTick(f.port, {}, f.cfg, quiet)).report.sent).toEqual([]);
    waiting = true;
    expect((await runTick(f.port, {}, f.cfg, quiet)).report.sent.map(s => s.job)).toEqual(['routerSweep']);
  });
  it('parses amounts beyond Number precision without rounding', () => {
    expect(loadConfig({ SH_KEEPER_RPC_URL: 'http://fake.invalid', SH_KEEPER_DESTINATION_FORK: 'osaka',
      SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_TOTAL_WEI_PER_DAY: '9007199254740993123' }).limits.totalWeiPerDay).toBe(9007199254740993123n);
  });
});
