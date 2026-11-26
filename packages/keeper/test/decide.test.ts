import { describe, expect, it } from 'vitest';
import { charge, decide, openBudget, type Limits } from '../src/decide';
import { reservedCostWei, feesFor, tipPays } from '../src/gas';
import { JOBS, oursList } from '../src/jobs';
import { loadConfig } from '../src/config';

const GWEI = 1_000_000_000n;
const fees = feesFor(GWEI, GWEI / 10n);
const limits: Limits = { oursWeiPerDay: 10n ** 16n, pokesWeiPerDay: 10n ** 16n, reserveWeiPerDay: 0n, totalWeiPerDay: 10n ** 18n, maxTxPerBlock: 3 };
const T0 = 1_791_300_000n;
const ctx = (over: Partial<Parameters<typeof decide>[2]> = {}) => ({
  fees,
  budget: openBudget(undefined, 1n, T0),
  limits,
  privateEndpoint: true,
  ...over,
});

describe('what the keeper sends (the ticket\'s review lens)', () => {
  it('never sends a transaction that cannot pay for itself unless it is ours to run', () => {
    const ours = new Set(oursList(JOBS).map((e) => e.job));
    for (const job of JOBS) {
      for (const tipWei of [null, 0n, 1n, 10n ** 12n, 10n ** 18n]) {
        const sim = { ok: true, tipWei, estimate: 100_000n };
        const d = decide(job.name, sim, ctx());
        if (d.send && !tipPays(tipWei, sim.estimate, fees)) {
          expect(d.asOurs, job.name).toBe(true);
          expect(ours.has(job.name)).toBe(true);
        }
        if (d.send && tipPays(tipWei, sim.estimate, fees)) expect(d.asOurs).toBe(false);
      }
    }
  });

  it('sends nothing a simulation says would revert, wait or skip', () => {
    expect(decide('collect', { ok: false, tipWei: 10n ** 18n, estimate: 100_000n }, ctx())).toMatchObject({ send: false });
  });

  it('stops ours jobs once the day\'s budget is spent; pokes have their own budget', () => {
    const sim = { ok: true, tipWei: null, estimate: 100_000n };
    let budget = openBudget(undefined, 1n, T0);
    let sent = 0;
    for (let i = 0; i < 1_000; i++) {
      budget = openBudget(budget, BigInt(i + 1), T0 + BigInt(i) * 12n);
      const d = decide('graduate', sim, ctx({ budget }));
      if (!d.send) break;
      budget = charge(budget, 'graduate', d);
      sent++;
    }
    // CQ11-E: reserve the maximum signed cost, including headroom.
    expect(BigInt(sent)).toBe(limits.oursWeiPerDay / reservedCostWei('graduate', 100_000n, fees));
    expect(decide('poke', sim, ctx({ budget }))).toMatchObject({ send: true, asOurs: true });
    expect(openBudget(budget, 2_000n, T0 + 86_400n).oursWei).toBe(0n);
  });

  it('keeps to the per-block rate limit', () => {
    const sim = { ok: true, tipWei: 10n ** 18n, estimate: 100_000n };
    let budget = openBudget(undefined, 7n, T0);
    for (let i = 0; i < limits.maxTxPerBlock; i++) budget = charge(budget, 'collect', decide('collect', sim, ctx({ budget })));
    expect(decide('collect', sim, ctx({ budget }))).toEqual({ send: false, why: 'rate limit' });
    expect(decide('collect', sim, ctx({ budget: openBudget(budget, 8n, T0 + 12n) }))).toMatchObject({ send: true });
  });

  it('CQ11-E permissionless jobs have no dependency on a private endpoint', () => {
    expect(JOBS.map((j) => j.name)).toEqual(expect.arrayContaining(['buyBack', 'claimReward', 'routerSweep', 'royaltyFlush']));
    // Production defaults admit the recovery floors; the small fixture budget tests exhaustion above.
    const limits = loadConfig({ SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_RPC_URL: 'https://rpc.example' }).limits;
    for (const j of JOBS.filter(j => j.name !== 'executeModule')) expect(decide(j.name, { ok: true, tipWei: null, estimate: 100n }, ctx({ limits, privateEndpoint: false })), j.name).toMatchObject({ send: true, privately: false });
  });

  it('FINAL-ACCESS-G01 shop recovery can use protected capacity but still stops at daily limits', () => {
    const cfg = loadConfig({ SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_RPC_URL: 'https://rpc.example' });
    const maxFeePerGas = cfg.limits.maxFeePerGas;
    if (maxFeePerGas === undefined) throw new Error('missing production fee ceiling');
    const ceilingFees = feesFor((maxFeePerGas - cfg.priorityFeeWei) / 2n, cfg.priorityFeeWei);
    expect(ceilingFees.maxFeePerGas).toBe(maxFeePerGas);
    const sim = { ok: true, tipWei: null, estimate: 30_000n };
    let budget = openBudget(undefined, 1n, T0);
    expect(maxFeePerGas).toBe(3_000_000_000n);
    for (const [job, costWei] of [['shopBurn', 15_000_000_000_000_000n], ['shopReturn', 6_000_000_000_000_000n]] as const) {
      const d = decide(job, sim, ctx({ limits: cfg.limits, fees: ceilingFees, budget, privateEndpoint: false }));
      expect(d, job).toEqual({ send: true, asOurs: true, privately: false, costWei, gas: costWei / maxFeePerGas });
      budget = charge(budget, job, d);
    }
    expect(budget.oursWei).toBeLessThanOrEqual(cfg.limits.oursWeiPerDay - cfg.limits.reserveWeiPerDay);
    // Recovery retries may spend protected capacity, but never more than the whole ours budget.
    for (let i = 0; i < 10; i++) {
      budget = openBudget(budget, budget.block + 1n, T0);
      const d = decide('shopBurn', sim, ctx({ limits: cfg.limits, fees: ceilingFees, budget }));
      if (!d.send) break;
      budget = charge(budget, 'shopBurn', d);
    }
    expect(budget.oursWei).toBe(96_000_000_000_000_000n);
    expect(budget.oursWei).toBeLessThanOrEqual(cfg.limits.oursWeiPerDay);
    const refused = decide('shopBurn', sim, ctx({ limits: cfg.limits, fees: ceilingFees, budget }));
    expect(refused).toEqual({ send: false, why: 'ours budget spent' });
    expect(charge(budget, 'shopBurn', refused)).toBe(budget);
    // A smaller return exactly uses the remaining 0.006 ETH, then both recovery jobs must wait.
    const last = decide('shopReturn', sim, ctx({ limits: cfg.limits, fees: ceilingFees, budget }));
    expect(last).toMatchObject({ send: true, costWei: 6_000_000_000_000_000n });
    budget = charge(budget, 'shopReturn', last);
    expect(budget.oursWei).toBe(cfg.limits.oursWeiPerDay);
    expect(decide('shopBurn', sim, ctx({ limits: cfg.limits, fees: ceilingFees, budget }))).toEqual({ send: false, why: 'daily ceiling reached' });
    expect(decide('shopReturn', sim, ctx({ limits: cfg.limits, fees: ceilingFees, budget }))).toEqual({ send: false, why: 'ours budget spent' });
    expect(decide('shopBurn', sim, ctx({ limits: cfg.limits, fees: { ...ceilingFees, maxFeePerGas: maxFeePerGas + 1n } }))).toEqual({ send: false, why: 'fee ceiling reached' });
    const tomorrow = openBudget(budget, 2n, T0 + 86_400n);
    expect(decide('shopBurn', sim, ctx({ limits: cfg.limits, fees: ceilingFees, budget: tomorrow, privateEndpoint: false }))).toMatchObject({ send: true });
  });
});
