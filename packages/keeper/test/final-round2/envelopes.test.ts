import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { charge, decide, openBudget } from '../../src/decide';
import { EIP7825_GAS_CAP, feesFor, transactionGas } from '../../src/gas';
import { JOBS, jobSpec } from '../../src/jobs';
import { runTick } from '../../src/run';
import { box, options, quiet, world } from '../support/v2';

const measured = {
  fail: 15_000_000n, failClosed: 15_000_000n, graduate: 13_500_000n,
  collect: 8_000_000n, buyBack: 8_000_000n, deepen: 8_000_000n,
  burnPending: 1_500_000n, royaltyFlush: 8_000_000n, royaltySweep: 8_000_000n, routerSweep: 2_000_000n,
  eatPriceCoin: 3_500_000n, moveToPile: 3_500_000n, executeModule: 3_500_000n, shopFees: 3_500_000n,
  sellFees: 16_000_000n, royaltyRefresh: 5_000_000n,
} as const;

// Acceptance list independent of JobSpec.reserved: every exit, fixed-Safe payment and
// recovery retry must still send when only the protected daily capacity remains.
const recoveryJobs = [
  'drandPostRound', 'drandRequestWord', 'drandAcceptWord', 'drandSettle', 'backupStart', 'backupFix',
  'graduate', 'fail', 'failClosed', 'claimReward', 'receiverPayFit', 'receiverPayPlatform',
  'burnPending', 'royaltyFlush', 'royaltySweep', 'routerSweep',
  'holderSettle', 'holderResidue', 'shopBurn', 'shopReturn',
  'itemSync', 'itemResidue', 'pileLoadSeed', 'pileReturnSeed',
] as const;
const ordinaryJobs = ['drandGraduationBounty', 'drandWithdrawBounty', 'collect', 'buyBack', 'deepen', 'eatPriceCoin', 'moveToPile', 'executeModule', 'shopFees', 'sellFees', 'royaltyRefresh', 'royaltyObserve', 'poke', 'executorTopUp', 'executorExecute'] as const;

function reserveOnlyContext() {
  const cfg = loadConfig({ SH_KEEPER_RPC_URL: 'http://fake.invalid', SH_KEEPER_DESTINATION_FORK: 'osaka',
    SH_KEEPER_TRANSACTION_GAS_CAP: '16777216' });
  return { fees: feesFor(1_475_000_000n, cfg.priorityFeeWei), limits: cfg.limits, privateEndpoint: true,
    budget: { ...openBudget(undefined, 1n, 0n), oursWei: 51_000_000_000_000_000n,
      pokesWei: 12_000_000_000_000_000n, totalWei: 63_000_000_000_000_000n } };
}

describe('KEEPER-WIRE FINAL2-GAS measured outer envelopes', () => {
  it.each(Object.entries(measured))('publishes and admits %s without truncating its required allowance', (job, floor) => {
    expect(JOBS.find(j => j.name === job)?.gasPerRun).toBe(floor);
    // Both publish their Amsterdam floors; before Amsterdam they sign lower. Zero-P presses have their own floor.
    expect(transactionGas(job, 100_000n, (job === 'sellFees' || job === 'collect') ? { fork: 'amsterdam', transactionCap: EIP7825_GAS_CAP,
      blockGasLimit: 60_000_000n, stateGas: 0n } : undefined)).toBe(floor);
    // Headroom above a floor is clipped at the destination ceiling (here the Osaka cap), never added beyond it.
    const padded = floor * 12n / 10n;
    expect(transactionGas(job, floor)).toBe(padded < EIP7825_GAS_CAP ? padded : EIP7825_GAS_CAP);
    expect(transactionGas(job, floor)).toBeLessThanOrEqual(EIP7825_GAS_CAP);
    const osakaFloor = job === 'sellFees' ? 8_200_000n : job === 'collect' ? 5_000_000n : floor;
    expect(() => transactionGas(job, 100_000n, { fork: 'osaka', transactionCap: EIP7825_GAS_CAP,
      blockGasLimit: osakaFloor - 1n })).toThrow(/required floor/);
  });

  it('keeps Box 0 allowances and failure floor separate from v2', () => {
    expect(jobSpec('graduate', 1).gasPerRun).toBe(6_150_000n);
    expect(jobSpec('deepen', 1).gasPerRun).toBe(400_000n);
    expect(jobSpec('collect', 1).gasPerRun).toBe(300_000n);
    expect(jobSpec('receiverPayFit', 1).gasPerRun).toBe(80_000n);
    expect(transactionGas('fail', 100_000n, undefined, 1)).toBe(3_500_000n);
    expect(transactionGas('collect', 100_000n, undefined, 1)).toBe(250_000n);
    expect(transactionGas('graduate', 100_000n, undefined, 1)).toBe(250_000n);
  });

  it.each([1, 2] as const)('carries version %s through the runner into the signed envelope', async version => {
    const w = world(box({ version, graduated: false, v2: version === 2 ? box().v2 : undefined }));
    const sent: bigint[] = [];
    const result = await runTick({ read: async () => w,
      simulate: async c => ({ ok: c.job === 'graduate', estimate: 100_000n, tipWei: null }),
      send: async (_c, gas) => { sent.push(gas); return 'local'; },
    }, {}, { ...options(), dryRun: false, priorityFeeWei: 1n }, quiet);
    const expected = version === 2 ? 13_500_000n : 250_000n;
    expect(sent).toEqual([expected]);
    expect(result.state.budget.totalWei).toBe(expected * 3n);
  });

  it('budgets published jobs at the fee ceiling and protects the complete graduation envelope', () => {
    const cfg = loadConfig({ SH_KEEPER_RPC_URL: 'http://fake.invalid', SH_KEEPER_DESTINATION_FORK: 'osaka',
      SH_KEEPER_TRANSACTION_GAS_CAP: '16777216' });
    expect(cfg.limits.oursWeiPerDay).toBe(102_000_000_000_000_000n);
    expect(cfg.limits.reserveWeiPerDay).toBe(51_000_000_000_000_000n);
    expect(cfg.limits.oursWeiPerDay - cfg.limits.reserveWeiPerDay).toBe(51_000_000_000_000_000n);
    expect(cfg.limits.pokesWeiPerDay).toBe(12_000_000_000_000_000n);
    expect(cfg.limits.totalWeiPerDay).toBe(114_000_000_000_000_000n);
    expect(cfg.limits.maxFeePerGas).toBe(3_000_000_000n);
    const fees = feesFor(1_475_000_000n, cfg.priorityFeeWei);
    expect(fees.maxFeePerGas).toBe(3_000_000_000n);
    for (const job of JOBS) {
      const context = { fees, limits: cfg.limits, privateEndpoint: true, budget: openBudget(undefined, 1n, 0n) };
      const d = decide(job.name, { ok: true, tipWei: null, estimate: job.gasPerRun }, context);
      if (job.name === 'receiverPayFit' || job.name === 'receiverPayPlatform') {
        // Both padded 12M Safe payments fit ordinary capacity without using the reserve.
        expect(d, job.name).toMatchObject({ send: true, gas: 14_400_000n, costWei: 43_200_000_000_000_000n });
      }
      expect(d, job.name).toMatchObject({ send: true, asOurs: true });
      if (!d.send) throw new Error('unfunded recovery job');
      expect(d.costWei).toBe(d.gas * fees.maxFeePerGas);
      expect(d.gas).toBeLessThanOrEqual(EIP7825_GAS_CAP);
      expect(charge(context.budget, job.name, d).totalWei).toBe(d.costWei);
      const refused = decide(job.name, { ok: true, tipWei: 10n ** 18n, estimate: job.gasPerRun },
        { ...context, fees: { ...fees, maxFeePerGas: 3_000_000_001n } });
      expect(refused, job.name).toEqual({ send: false, why: 'fee ceiling reached' });
      expect(charge(context.budget, job.name, refused)).toEqual(context.budget);
    }
    expect([...recoveryJobs, ...ordinaryJobs].sort()).toEqual(JOBS.map(j => j.name).sort());
  });

  it.each(recoveryJobs)('admits %s from reserve alone and enforces both exact capacity boundaries', job => {
    const context = reserveOnlyContext();
    const sim = { ok: true, tipWei: null, estimate: jobSpec(job).gasPerRun };
    const gas = transactionGas(job, sim.estimate);
    const costWei = gas * 3_000_000_000n;
    const sent = decide(job, sim, context);
    expect(sent).toEqual({ send: true, asOurs: true, privately: false, gas, costWei });
    expect(charge(context.budget, job, sent)).toEqual({ ...context.budget, txInBlock: 1,
      oursWei: context.budget.oursWei + costWei, totalWei: context.budget.totalWei + costWei });
    const exact = { ...context.budget, oursWei: context.limits.oursWeiPerDay - costWei,
      totalWei: context.limits.totalWeiPerDay - costWei };
    expect(decide(job, sim, { ...context, budget: exact })).toEqual(sent);
    expect(charge(exact, job, sent)).toMatchObject({
      oursWei: context.limits.oursWeiPerDay, totalWei: context.limits.totalWeiPerDay,
    });
    for (const [key, why] of [['oursWei', 'ours budget spent'], ['totalWei', 'daily ceiling reached']] as const) {
      const spent = { ...exact, [key]: exact[key] + 1n };
      const refused = decide(job, sim, { ...context, budget: spent });
      expect(refused).toEqual({ send: false, why });
      expect(charge(spent, job, refused)).toBe(spent);
    }
    for (const tipWei of [null, 10n ** 18n]) {
      const refused = decide(job, { ...sim, tipWei }, { ...context,
        fees: { ...context.fees, maxFeePerGas: 3_000_000_001n } });
      expect(refused).toEqual({ send: false, why: 'fee ceiling reached' });
      expect(charge(context.budget, job, refused)).toBe(context.budget);
    }
  });

  it.each(ordinaryJobs)('keeps %s out of both protected budgets even with a covering tip', job => {
    const context = reserveOnlyContext();
    const sim = { ok: true, tipWei: null, estimate: jobSpec(job).gasPerRun };
    for (const tipWei of [null, 10n ** 18n]) {
      const refused = decide(job, { ...sim, tipWei }, context);
      expect(refused).toEqual({ send: false, why: 'daily ceiling reached' });
      expect(charge(context.budget, job, refused)).toBe(context.budget);
    }
    if (job === 'poke') return; // Its independent budget is exhausted above too.
    // Leave total capacity available to isolate the ours reserve.
    const budget = { ...context.budget, pokesWei: 0n, totalWei: context.budget.oursWei };
    // Use a low fee so even the largest ordinary job fits the total's unprotected remainder.
    const oursRefused = decide(job, sim, { ...context, budget,
      fees: feesFor(1n, 1n) });
    expect(oursRefused).toEqual({ send: false, why: 'ours budget spent' });
    expect(charge(budget, job, oursRefused)).toBe(budget);
  });

  it.each(['receiverPayFit', 'receiverPayPlatform'] as const)('keeps Box 0 %s outside protected capacity', job => {
    const context = reserveOnlyContext();
    const sim = { ok: true, tipWei: null, estimate: 80_000n };
    const refused = decide(job, sim, { ...context, version: 1 });
    expect(refused).toEqual({ send: false, why: 'daily ceiling reached' });
    expect(charge(context.budget, job, refused)).toBe(context.budget);
  });

  it('defers a real runner candidate above 3 gwei without charging or delaying its retry', async () => {
    const cfg = { ...options(), dryRun: false };
    const w = world(box({ graduated: false }));
    const sent: bigint[] = [];
    let baseFeePerGas = 1_475_000_001n; // max fee = 3 gwei + 2 wei, including priority.
    const port = {
      read: async () => ({ ...w, block: { ...w.block, baseFeePerGas } }),
      simulate: async (c: { job: string }) => ({ ok: c.job === 'graduate', estimate: 13_500_000n, tipWei: null }),
      send: async (_c: unknown, gas: bigint) => { sent.push(gas); return 'local'; },
    };
    const deferred = await runTick(port, {}, cfg, quiet);
    expect(sent).toEqual([]);
    expect(deferred.report.sent).toEqual([]);
    expect(deferred.report.skipped).toContainEqual(expect.objectContaining({ job: 'graduate', why: 'fee ceiling reached' }));
    expect(deferred.state.budget).toMatchObject({ oursWei: 0n, totalWei: 0n, pokesWei: 0n, txInBlock: 0 });
    baseFeePerGas = 1_475_000_000n;
    const resumed = await runTick(port, deferred.state, cfg, quiet);
    expect(sent).toEqual([16_200_000n]);
    expect(resumed.report.sent.map(s => s.job)).toEqual(['graduate']);
    expect(resumed.state.budget).toMatchObject({ oursWei: 48_600_000_000_000_000n,
      totalWei: 48_600_000_000_000_000n, pokesWei: 0n, txInBlock: 1 });
  });
});
