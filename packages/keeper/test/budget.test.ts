/**
 * Review round 1, finding M3: budgets reserve the signed maximum cost; `fail`, `failClosed`, `graduate` keep a reserve of the day's budget; one daily ceiling covers every send of the hot wallet, tipped
 * ones included; the defaults are sized from the evidence's own figures.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { charge, decide, openBudget, type Budget, type Limits } from '../src/decide';
import { costWei, reservedCostWei, feesFor } from '../src/gas';
import { JOBS, jobSpec } from '../src/jobs';
import type { JobName, Sim } from '../src/types';

const GWEI = 10n ** 9n;
const fees = feesFor(GWEI, GWEI / 10n);
const T0 = 1_791_300_000n;
const limits: Limits = { oursWeiPerDay: 5n * 10n ** 16n, pokesWeiPerDay: 10n ** 16n, reserveWeiPerDay: 4n * 10n ** 16n, totalWeiPerDay: 8n * 10n ** 16n, maxTxPerBlock: 1_000 };
const tipless: Sim = { ok: true, tipWei: null, estimate: 100_000n };
const tipped: Sim = { ok: true, tipWei: 10n ** 18n, estimate: 100_000n };

/** Sends `job` until refused; returns the budget and the refusal. */
function spend(job: JobName, sim: Sim, from: Budget, l: Limits = limits) {
  let budget = from;
  for (let i = 0; i < 100_000; i++) {
    const d = decide(job, sim, { fees, budget, limits: l, privateEndpoint: true });
    if (!d.send) return { budget, why: d.why, sent: i };
    budget = charge(budget, job, d);
  }
  throw new Error('never refused');
}

describe('budgets (review round 1, M3)', () => {
  it('names every protected recovery job and keeps Box 0 policy unchanged', () => {
    expect(JOBS.filter((j) => j.reserved).map((j) => j.name).sort()).toEqual([
      'backupFix', 'backupStart', 'burnPending', 'claimReward', 'drandAcceptWord', 'drandPostRound', 'drandRequestWord', 'drandSettle', 'fail', 'failClosed', 'graduate',
      'holderResidue', 'holderSettle', 'itemResidue', 'itemSync', 'pileLoadSeed', 'pileReturnSeed',
      'receiverPayFit', 'receiverPayPlatform', 'routerSweep', 'royaltyFlush', 'royaltySweep', 'shopBurn', 'shopReturn',
    ]);
    const box0Jobs = ['fail', 'failClosed', 'graduate', 'claimReward', 'deepen', 'collect',
      'receiverPayFit', 'receiverPayPlatform', 'poke', 'executorTopUp', 'executorExecute'] as const;
    expect(box0Jobs.filter(name => jobSpec(name, 1).reserved).sort()).toEqual(['claimReward', 'fail', 'failClosed', 'graduate']);
  });

  it('keeps the last part of the ours budget for the reserved jobs', () => {
    const topUps = spend('executorTopUp', tipless, openBudget(undefined, 1n, T0));
    expect(topUps.why).toBe('ours budget spent');
    expect(topUps.budget.oursWei <= limits.oursWeiPerDay - limits.reserveWeiPerDay).toBe(true);
    expect(BigInt(topUps.sent)).toBe((limits.oursWeiPerDay - limits.reserveWeiPerDay) / reservedCostWei('executorTopUp', 100_000n, fees));
    const graduates = spend('graduate', tipless, topUps.budget);
    expect(graduates.sent).toBeGreaterThan(0);
    expect(graduates.budget.oursWei <= limits.oursWeiPerDay).toBe(true);
  });

  it('stops every send at the daily ceiling, tipped ones too, keeping the reserve for the reserved jobs', () => {
    const steps = spend('collect', tipped, openBudget(undefined, 1n, T0));
    expect(steps.why).toBe('daily ceiling reached');
    expect(steps.budget.totalWei <= limits.totalWeiPerDay - limits.reserveWeiPerDay).toBe(true);
    expect(steps.budget.oursWei).toBe(0n);
    const fails = spend('fail', tipless, steps.budget);
    expect(fails.sent).toBeGreaterThan(0);
    expect(fails.budget.totalWei <= limits.totalWeiPerDay).toBe(true);
    expect(openBudget(fails.budget, 9n, T0 + 86_400n).totalWei).toBe(0n);
  });

  it('retains the historical cadence sizing as an explicit larger-budget environment control', () => {
    const cfg = loadConfig({ SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_RPC_URL: 'https://rpc.example.invalid',
      SH_KEEPER_MAX_FEE_WEI: '50000000000', SH_KEEPER_OURS_WEI_PER_DAY: '1500000000000000000',
      SH_KEEPER_POKES_WEI_PER_DAY: '200000000000000000', SH_KEEPER_RESERVE_WEI_PER_DAY: '810000000000000000',
      SH_KEEPER_TOTAL_WEI_PER_DAY: '1700000000000000000' });
    const at = (base: bigint) => feesFor(base, cfg.priorityFeeWei);
    const l = cfg.limits;
    // Three big moves of about 600 pokes (ADR-0017 § 11).
    expect(l.pokesWeiPerDay >= 3n * 600n * costWei(jobSpec('poke').gasPerRun, at(GWEI))).toBe(true);
    // Ten graduated boxes' top-ups (168 a day each) and their deepens and collects run as ours all day.
    const perBox = 168n * jobSpec('executorTopUp').gasPerRun + 24n * jobSpec('deepen', 1).gasPerRun + 12n * jobSpec('collect', 1).gasPerRun;
    expect(l.oursWeiPerDay - l.reserveWeiPerDay >= costWei(10n * perBox, at(GWEI))).toBe(true);
    // Three graduations at a 5 gwei base fee fit in the reserve.
    expect(l.reserveWeiPerDay >= costWei(3n * jobSpec('graduate').gasPerRun, at(5n * GWEI))).toBe(true);
    expect(l.totalWeiPerDay >= l.oursWeiPerDay + l.pokesWeiPerDay).toBe(true);
  });

  it('refuses a reserve larger than the budgets it is kept in', () => {
    const env = { SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_RPC_URL: 'https://rpc.example.invalid' };
    const reserve = '170000000000000000';
    const below = '169999999999999999';
    expect(() => loadConfig({ ...env, SH_KEEPER_RESERVE_WEI_PER_DAY: reserve, SH_KEEPER_OURS_WEI_PER_DAY: below }))
      .toThrow(/SH_KEEPER_RESERVE_WEI_PER_DAY/);
    expect(() => loadConfig({ ...env, SH_KEEPER_RESERVE_WEI_PER_DAY: reserve, SH_KEEPER_TOTAL_WEI_PER_DAY: below }))
      .toThrow(/SH_KEEPER_RESERVE_WEI_PER_DAY/);
    expect(() => loadConfig({ ...env, SH_KEEPER_RESERVE_WEI_PER_DAY: reserve,
      SH_KEEPER_OURS_WEI_PER_DAY: reserve, SH_KEEPER_TOTAL_WEI_PER_DAY: reserve })).not.toThrow();
  });

  it('funds two padded graduations and the separate poke allocation within the new daily ceiling', () => {
    const cfg = loadConfig({ SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_RPC_URL: 'https://rpc.example.invalid' });
    expect(cfg.limits).toEqual({ drandRescueMaxFeeWei: 50_000_000_000n, drandRescueWindowSeconds: 259200n, drandRescueWeiPerDay: 50_000_000_000_000_000n, oursWeiPerDay: 102_000_000_000_000_000n,
      pokesWeiPerDay: 12_000_000_000_000_000n, reserveWeiPerDay: 51_000_000_000_000_000n,
      totalWeiPerDay: 114_000_000_000_000_000n, maxTxPerBlock: 4, maxFeePerGas: 3_000_000_000n, unblockingGasPerBoxPerDay: 816_000_000n,
      unblockingWeiPerDay: 25_500_000_000_000_000n, unblockingWeiPerBoxPerDay: 6_375_000_000_000_000n });
    const fees = feesFor(1_475_000_000n, cfg.priorityFeeWei);
    const sim = { ok: true, tipWei: null, estimate: 13_500_000n };
    let budget = { ...openBudget(undefined, 1n, T0), pokesWei: cfg.limits.pokesWeiPerDay,
      totalWei: cfg.limits.pokesWeiPerDay };
    for (let i = 0; i < 2; i++) {
      const d = decide('graduate', sim, { fees, budget, limits: cfg.limits, privateEndpoint: false });
      expect(d).toMatchObject({ send: true, gas: 16_200_000n, costWei: 48_600_000_000_000_000n });
      budget = charge(budget, 'graduate', d);
    }
    expect(budget.oursWei).toBe(97_200_000_000_000_000n);
    expect(budget.totalWei).toBe(109_200_000_000_000_000n);
    const refused = decide('graduate', sim, { fees, budget, limits: cfg.limits, privateEndpoint: false });
    expect(refused).toEqual({ send: false, why: 'daily ceiling reached' });
    expect(charge(budget, 'graduate', refused)).toEqual(budget);
  });
});
