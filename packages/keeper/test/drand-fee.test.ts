import { DRAND_SILENCE_SECONDS } from '../../box-spec/src/generated/box-spec.v1';
import { DRAND_UNREQUESTED_SECONDS } from '../src/drand';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { DRAND_RESCUE_JOBS, drandFeeApplies, maxFeeFor } from '../src/drand-fee';
import { loadConfig } from '../src/config';
import { charge, decide, openBudget, reserve, accepted, settle } from '../src/decide';
import { feesFor } from '../src/gas';
import { runTick, type ChainPort } from '../src/run';
import { addr, options, quiet, time } from './support/v2';
import type { Candidate } from '../src/types';

const env = { SH_KEEPER_RPC_URL: 'https://fake.invalid', SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216' };
const candidate = (hours = 71n): Candidate => ({ job: 'drandPostRound', key: 'post:1', to: addr(1), fn: 'postRound', args: [1n], version: 1, drandDeadline: time + hours * 3600n });
const sim = { ok: true, tipWei: null, estimate: 450_000n };
const cfg = () => ({ ...options(), dryRun: false });
const context = () => ({ candidate: candidate(), now: time, fees: feesFor(1_600_000_000n, 50_000_000n), budget: openBudget(undefined, 1n, time), limits: options().limits, privateEndpoint: false });

describe('R62-FEE deadline admission', () => {
  it('pins the only four rescue jobs and the on-chain silence clocks', () => {
    expect(DRAND_RESCUE_JOBS).toEqual(['drandPostRound', 'drandRequestWord', 'backupStart', 'backupFix']);
    for (const file of ['box/BoxTickets.sol', 'box-v2/BoxTicketsV2.sol']) {
      const text = readFileSync(new URL(`../../contracts/src/${file}`, import.meta.url), 'utf8');
      expect(text).toMatch(/SILENCE = 7 days;/); expect(text).toMatch(/SILENCE_UNREQUESTED = 30 days;/);
    }
    expect(DRAND_SILENCE_SECONDS).toBe(7n * 86400n); expect(DRAND_SILENCE_SECONDS).toBe(604800n);
    expect(DRAND_UNREQUESTED_SECONDS).toBe(30n * 86400n); expect(DRAND_UNREQUESTED_SECONDS).toBe(2592000n);
  });
  it('loads defaults, rejects zero/below ordinary max, and disables at window or cap zero', () => {
    const { limits } = loadConfig(env);
    expect(limits).toMatchObject({ drandRescueMaxFeeWei: 50_000_000_000n, drandRescueWindowSeconds: 259200n, drandRescueWeiPerDay: 50_000_000_000_000_000n });
    for (const n of ['0', '2999999999']) expect(() => loadConfig({ ...env, SH_KEEPER_DRAND_RESCUE_MAX_FEE_WEI: n })).toThrow(/SH_KEEPER_DRAND_RESCUE_MAX_FEE_WEI/);
    for (const field of ['drandRescueWindowSeconds', 'drandRescueWeiPerDay']) {
      expect(drandFeeApplies(candidate(), time, { ...limits, [field]: 0n })).toBe(false);
    }
    expect(maxFeeFor({ ...candidate(), drandDeadline: undefined }, time, { ...limits, maxFeePerGas: 2n })).toBe(2n);
  });
  it.each([73n, 72n, 71n, 0n, -1n])('serves %s hours left strictly inside the window, through the requested deadline', hours => {
    const ctx = { ...context(), candidate: candidate(hours) };
    const d = decide('drandPostRound', sim, ctx);
    if (hours === 71n || hours === 0n) {
      expect(d).toMatchObject({ send: true, counter: 'drandRescue' });
      expect(charge(ctx.budget, 'drandPostRound', d)).toMatchObject({ oursWei: 0n, pokesWei: 0n, totalWei: 0n, drandRescueWei: 600_000n * 3_250_000_000n });
    } else expect(d).toEqual({ send: false, why: 'fee ceiling reached' });
  });
  it('accepts a late unrequested word but never rescues collect or acceptance', () => {
    const ctx = context();
    expect(drandFeeApplies({ ...candidate(-1n), job: 'drandRequestWord' }, time, ctx.limits)).toBe(true);
    expect(drandFeeApplies({ ...candidate(), job: 'drandAcceptWord' }, time, ctx.limits)).toBe(false);
    expect(decide('collect', sim, { ...ctx, candidate: { ...candidate(), job: 'collect' } })).toEqual({ send: false, why: 'fee ceiling reached' });
  });
  it('admits the exact fee and rescue cap, refuses one wei more, and keeps rate/gas guards', () => {
    const ctx = context();
    const atFee = { ...ctx, fees: { ...ctx.fees, maxFeePerGas: 50_000_000_000n, maxPriorityFeePerGas: 50_000_000n } };
    expect(decide('drandPostRound', sim, atFee).send).toBe(true);
    expect(decide('drandPostRound', sim, { ...atFee, fees: { ...atFee.fees, maxFeePerGas: 50_000_000_001n } })).toEqual({ send: false, why: 'fee ceiling reached' });
    const cost = 600_000n * ctx.fees.maxFeePerGas;
    expect(decide('drandPostRound', sim, { ...ctx, limits: { ...ctx.limits, drandRescueWeiPerDay: cost } }).send).toBe(true);
    expect(decide('drandPostRound', sim, { ...ctx, limits: { ...ctx.limits, drandRescueWeiPerDay: cost - 1n } })).toEqual({ send: false, why: 'drand rescue allowance spent' });
    expect(decide('drandPostRound', sim, { ...ctx, budget: { ...ctx.budget, txInBlock: 4 } })).toEqual({ send: false, why: 'rate limit' });
  });
  it('rescues exhausted daily limits even at ordinary fees and otherwise keeps the ordinary path', () => {
    const ctx = context(); const fees = { ...ctx.fees, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 0n };
    const full = { ...ctx, fees, budget: { ...ctx.budget, totalWei: ctx.limits.totalWeiPerDay } };
    expect(decide('drandPostRound', sim, full)).toMatchObject({ send: true, counter: 'drandRescue' });
    expect(decide('drandPostRound', sim, { ...full, candidate: candidate(73n) })).toEqual({ send: false, why: 'daily ceiling reached' });
    const d = decide('drandPostRound', sim, { ...ctx, fees, candidate: candidate(73n) });
    expect(d).toMatchObject({ send: true });
    expect(charge(ctx.budget, 'drandPostRound', d)).toMatchObject({ oursWei: 600_000n * fees.maxFeePerGas, totalWei: 600_000n * fees.maxFeePerGas });
  });
  it('settles rescue only from rescue, preserving ordinary counters', () => {
    const ctx = context(); const d = decide('drandPostRound', sim, ctx);
    const b = accepted(reserve(charge(ctx.budget, 'drandPostRound', d), 'drandPostRound', d), 'hash');
    expect(b.pending?.[0]).toMatchObject({ counter: 'drandRescue' });
    expect(settle(b, { hash: 100n })).toMatchObject({ drandRescueWei: 100n, oursWei: 0n, pokesWei: 0n, totalWei: 0n, pending: [] });
  });
  it('runs the pre-simulation rule, keeps fee-wait eligibility and logs hourly per key', async () => {
    let c = candidate(); let now = time;
    const port: ChainPort = { read: async () => ({ block: { number: now, timestamp: now, baseFeePerGas: 1_600_000_000n }, boxes: [], fitGraduated: false, drand: [c] }), simulate: vi.fn(async () => sim), send: vi.fn(async () => 'hash') };
    const log = { ...quiet, warn: vi.fn() };
    const first = await runTick(port, {}, cfg(), log);
    expect(first.report.sent).toHaveLength(1); expect(first.state.budget?.totalWei).toBe(0n);
    expect(log.warn).toHaveBeenCalledWith('drand deadline fee in use', expect.objectContaining({ job: c.job, key: c.key, maxFeePerGas: 3_250_000_000n, secondsLeft: 71n * 3600n }));
    now += 12n; await runTick(port, { ...first.state, mem: undefined }, cfg(), log);
    expect(log.warn.mock.calls.filter(([s]) => s === 'drand deadline fee in use')).toHaveLength(1);
    c = candidate(72n); now = time;
    const waiting = await runTick(port, {}, cfg(), log);
    expect(waiting.report.skipped[0]?.why).toBe('fee ceiling reached'); expect(waiting.state.mem?.attempts[c.key]).toBeUndefined();
  });
});

describe('R62 has one allowance only', () => {
  it('persists rescue reservations, loads pre-R62 state as zero, and resets on a new UTC day', async () => {
    const { encodeState, decodeState } = await import('../src/state');
    const ctx = context(); const d = decide('drandPostRound', sim, ctx);
    const b = reserve(charge(ctx.budget, 'drandPostRound', d), 'drandPostRound', d);
    expect(decodeState(encodeState({ budget: b }, 'test'), 'test').budget).toEqual(b);
    const old = { ...b, drandRescueWei: undefined, pending: undefined };
    expect(decodeState(encodeState({ budget: old }, 'test'), 'test').budget?.drandRescueWei).toBe(0n);
    expect(openBudget(b, 100n, time + 86400n).drandRescueWei).toBe(0n);
  });
  it('logs half and mostly once per day, including after reload, and leaves the monitor inequality true', async () => {
    const { encodeState, decodeState } = await import('../src/state');
    const cost = 600000n * 3250000000n;
    let now = time;
    const port: ChainPort = { read: async () => ({ block: { number: now, timestamp: now, baseFeePerGas: 1600000000n }, boxes: [], fitGraduated: false, drand: [candidate()] }), simulate: async () => sim, send: async () => 'hash' };
    const log = { ...quiet, warn: vi.fn() };
    const config = { ...cfg(), limits: { ...cfg().limits, drandRescueWeiPerDay: cost * 2n } };
    let state = (await runTick(port, {}, config, log)).state;
    expect(log.warn.mock.calls.filter(([s]) => s === 'drand rescue allowance half used')).toHaveLength(1);
    now += 12n;
    state = (await runTick(port, { ...decodeState(encodeState(state, 'test'), 'test'), mem: undefined }, config, log)).state;
    expect(log.warn.mock.calls.filter(([s]) => s === 'drand rescue allowance mostly used')).toHaveLength(1);
    now += 12n; await runTick(port, { ...state, mem: undefined }, config, log);
    expect(log.warn.mock.calls.filter(([s]) => s === 'drand rescue allowance half used')).toHaveLength(1);
    expect(state.budget.totalWei >= state.budget.oursWei + state.budget.pokesWei).toBe(true);
    now += 86400n; await runTick(port, { ...state, mem: undefined }, config, log);
    expect(log.warn.mock.calls.filter(([s]) => s === 'drand rescue allowance half used')).toHaveLength(2);
  });
  it('warns on ordinary daily waits at most hourly per key', async () => {
    let now = time;
    const port: ChainPort = { read: async () => ({ block: { number: now, timestamp: now, baseFeePerGas: 1000000000n }, boxes: [], fitGraduated: false, drand: [candidate(100n)] }), simulate: async () => sim, send: async () => 'hash' };
    const log = { ...quiet, warn: vi.fn() };
    const config = { ...cfg(), limits: { ...cfg().limits, totalWeiPerDay: 1n } };
    let state = (await runTick(port, {}, config, log)).state;
    now += 12n; state = (await runTick(port, state, config, log)).state;
    expect(log.warn.mock.calls.filter(([s]) => s === 'drand waits on the daily budget')).toHaveLength(1);
    now += 3600n; await runTick(port, state, config, log);
    expect(log.warn.mock.calls.filter(([s]) => s === 'drand waits on the daily budget')).toHaveLength(2);
  });
});

describe('a timely word leaves acceptance on ordinary limits', () => {
  const accept = (hours = 71n): Candidate => ({ ...candidate(hours), job: 'drandAcceptWord', key: 'accept:1', fn: 'acceptGraduationWord' });
  it.each([100n, 71n, 0n, -1n])('waits above the ordinary ceiling with %s hours left and reserves nothing', async hours => {
    const c = accept(hours);
    const port: ChainPort = { read: async () => ({ block: { number: 1n, timestamp: time, baseFeePerGas: 1600000000n }, boxes: [], fitGraduated: false, drand: [c] }),
      simulate: vi.fn(async () => sim), send: vi.fn(async () => 'hash') };
    const out = await runTick(port, {}, cfg(), quiet);
    expect(out.report.skipped).toContainEqual(expect.objectContaining({ job: c.job, why: 'fee ceiling reached' }));
    expect(port.simulate).not.toHaveBeenCalled(); expect(port.send).not.toHaveBeenCalled();
    expect(out.state.budget).toMatchObject({ totalWei: 0n, oursWei: 0n, drandRescueWei: 0n });
    expect(out.state.budget?.pending ?? []).toEqual([]);
    expect(maxFeeFor(c, time, cfg().limits)).toBe(3000000000n);
    expect(maxFeeFor(c, time, { ...cfg().limits, maxFeePerGas: 2000000000n })).toBe(2000000000n);
  });
  it.each(['totalWei', 'oursWei'] as const)('waits when %s is spent without a drand daily-budget warning', async counter => {
    const config = cfg();
    const budget = { ...openBudget(undefined, 1n, time), [counter]: counter === 'totalWei' ? config.limits.totalWeiPerDay : config.limits.oursWeiPerDay };
    const port: ChainPort = { read: async () => ({ block: { number: 1n, timestamp: time, baseFeePerGas: 1n }, boxes: [], fitGraduated: false, drand: [accept()] }),
      simulate: async () => sim, send: vi.fn(async () => 'hash') };
    const log = { ...quiet, warn: vi.fn() };
    const out = await runTick(port, { budget }, config, log);
    expect(out.report.skipped).toContainEqual(expect.objectContaining({ why: counter === 'totalWei' ? 'daily ceiling reached' : 'ours budget spent' }));
    expect(port.send).not.toHaveBeenCalled();
    expect(out.state.budget?.drandRescueWei).toBe(0n);
    expect(log.warn).not.toHaveBeenCalledWith('drand waits on the daily budget', expect.anything());
  });
  it('keeps acceptance in protected ours capacity and never charges rescue', () => {
    const ctx = context();
    const budget = { ...ctx.budget, oursWei: ctx.limits.oursWeiPerDay - ctx.limits.reserveWeiPerDay };
    const fees = feesFor(1n, 50000000n);
    const d = decide('drandAcceptWord', sim, { ...ctx, candidate: accept(), budget, fees });
    expect(d).toMatchObject({ send: true, asOurs: true });
    expect(charge(budget, 'drandAcceptWord', d)).toMatchObject({ drandRescueWei: 0n, oursWei: budget.oursWei + 600000n * fees.maxFeePerGas });
  });
  it.each(['drandPostRound', 'drandRequestWord', 'backupStart', 'backupFix'] as const)('%s still sends at 3.25 gwei from rescue', async job => {
    const c = { ...candidate(), job };
    const port: ChainPort = { read: async () => ({ block: { number: 1n, timestamp: time, baseFeePerGas: 1600000000n }, boxes: [], fitGraduated: false, drand: [c] }),
      simulate: async () => sim, send: vi.fn(async () => 'hash') };
    const out = await runTick(port, {}, cfg(), quiet);
    expect(out.report.sent.map(s => s.job)).toEqual([job]);
    expect(out.state.budget).toMatchObject({ totalWei: 0n, oursWei: 0n, drandRescueWei: 600000n * 3250000000n });
    expect(port.send).toHaveBeenCalledWith(c, 600000n, expect.objectContaining({ maxFeePerGas: 3250000000n }), false);
  });
});

describe.each(['backupStart', 'backupFix'] as const)('%s shares R62 without changing other jobs', job => {
  const c = (hours = job === 'backupStart' ? 17n : 71n): Candidate => ({ ...candidate(hours), job, fn: job === 'backupStart' ? 'startBackup' : 'fixBackup' });
  it('sends at a 1.6 gwei base fee and charges only rescue', async () => {
    const port: ChainPort = { read: async () => ({ block: { number: 1n, timestamp: time, baseFeePerGas: 1600000000n }, boxes: [], fitGraduated: false, drand: [c()] }), simulate: async () => sim, send: vi.fn(async () => 'hash') };
    const result = await runTick(port, {}, cfg(), quiet);
    expect(result.report.sent.map(s => s.job)).toEqual([job]);
    expect(result.state.budget).toMatchObject({ oursWei: 0n, pokesWei: 0n, totalWei: 0n, drandRescueWei: 600000n * 3250000000n });
    expect(port.send).toHaveBeenCalledWith(c(), 600000n, expect.objectContaining({ maxFeePerGas: 3250000000n }), false);
  });
  it('refuses one wei over the shared rescue cap, and keeps ordinary limits outside the rule', () => {
    const ctx = { ...context(), candidate: c() }, cost = 600000n * ctx.fees.maxFeePerGas;
    expect(decide(job, sim, { ...ctx, limits: { ...ctx.limits, drandRescueWeiPerDay: cost - 1n } })).toEqual({ send: false, why: 'drand rescue allowance spent' });
    for (const hours of [72n, -1n]) expect(decide(job, sim, { ...ctx, candidate: c(hours) })).toEqual({ send: false, why: 'fee ceiling reached' });
    const ordinary = { ...ctx, fees: feesFor(1n, 50000000n), candidate: c(72n) };
    expect(charge(ctx.budget, job, decide(job, sim, ordinary))).toMatchObject({ oursWei: 600000n * ordinary.fees.maxFeePerGas, drandRescueWei: 0n });
    expect(decide(job, sim, { ...ordinary, budget: { ...ordinary.budget, totalWei: ordinary.limits.totalWeiPerDay } })).toEqual({ send: false, why: 'daily ceiling reached' });
    expect(decide(job, sim, { ...ctx, budget: { ...ctx.budget, txInBlock: 4 } })).toEqual({ send: false, why: 'rate limit' });
  });
});
