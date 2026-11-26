import { expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { accepted, charge, decide, openBudget, reserve, settle } from '../src/decide';
import { decodeState, encodeState } from '../src/state';
import { incomeCapped } from '../src/income';
import { jobSpec } from '../src/jobs';
import { feesFor } from '../src/gas';
import { addr, options, time } from './support/v2';
import type { Candidate } from '../src/types';
const env = { SH_KEEPER_RPC_URL: 'https://fake.invalid', SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216' };
it('defaults off, refuses over 0.05 ETH and over ordinary ours room', () => {
  expect(loadConfig(env).graduationBountyWei).toBe(0n);
  expect(loadConfig({ ...env, SH_KEEPER_GRADUATION_BOUNTY_WEI: '50000000000000000' }).graduationBountyWei).toBe(50000000000000000n);
  for (const extra of [{ SH_KEEPER_GRADUATION_BOUNTY_WEI: '50000000000000001' }, { SH_KEEPER_GRADUATION_BOUNTY_WEI: '2', SH_KEEPER_OURS_WEI_PER_DAY: '11', SH_KEEPER_RESERVE_WEI_PER_DAY: '10' }]) {
    expect(() => loadConfig({ ...env, ...extra })).toThrow(/SH_KEEPER_GRADUATION_BOUNTY_WEI/);
  }
});
it('reserves the value in ordinary ours, never the reserve, and never releases it on settlement', () => {
  const c: Candidate = { job: 'drandGraduationBounty', key: 'bounty', to: addr(1), version: 1, fn: 'addBounty', args: [1n], value: 100n, drandDeadline: time };
  const sim = { ok: true, tipWei: null, estimate: 100000n };
  const ctx = { candidate: c, now: time, fees: feesFor(1n, 0n), budget: openBudget(undefined, 1n, time), limits: options().limits, privateEndpoint: false, version: 1 as const };
  expect(jobSpec(c.job)).toMatchObject({ tip: 'none', priority: 3, reserved: false, budget: 'ours', gasPerRun: 100000n });
  expect(incomeCapped(c, sim)).toBe(false);
  const d = decide(c.job, sim, ctx); expect(d).toMatchObject({ send: true, costWei: 500100n, valueWei: 100n });
  const budget = accepted(reserve(charge(ctx.budget, c.job, d), c.job, d), 'hash');
  expect(decodeState(encodeState({ budget }, 'bounty'), 'bounty').budget).toEqual(budget);
  expect(settle(budget, { hash: 2n })).toMatchObject({ oursWei: 102n, totalWei: 102n });
  expect(decide(c.job, sim, { ...ctx, limits: { ...ctx.limits, oursWeiPerDay: 500099n, reserveWeiPerDay: 0n } })).toEqual({ send: false, why: 'ours budget spent' });
  expect(decide(c.job, sim, { ...ctx, limits: { ...ctx.limits, oursWeiPerDay: 500100n, reserveWeiPerDay: 1n } }).send).toBe(false);
  expect(decide(c.job, sim, { ...ctx, fees: feesFor(1600000000n, 50000000n) })).toEqual({ send: false, why: 'fee ceiling reached' });
});

it('retains a value reservation when a receipt reports negative gas payment', () => {
  const budget = { ...openBudget(undefined, 1n, time), oursWei: 200n, totalWei: 200n,
    pending: [{ hash: 'hash', costWei: 200n, valueWei: 100n, ours: 'ours' as const }] };
  expect(settle(budget, { hash: -1n })).toEqual(budget);
});
