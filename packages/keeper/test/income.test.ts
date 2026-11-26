import { describe, expect, it } from 'vitest';
import { activeIncomeSpend, incomeCapped, incomeRefusal, startRefusal, incomeCost, INCOME_WINDOW_SECONDS, type IncomeSnapshot, type IncomeSpend } from '../src/income';
import { JOBS } from '../src/jobs';
import { addr, time } from './support/v2';

const a = addr(1), b = addr(2);
const snapshot = (at = time): IncomeSnapshot => ({ at, platformWei: 400n,
  boxes: { [a]: { shareWei: 100n, tipsWei: 0n }, [b]: { shareWei: 300n, tipsWei: 0n } }, mined: {} });
const s: IncomeSpend = { box: a, at: time, costWei: 100n, hash: 'hash' };

describe('F111 rolling conservation', () => {
  it('expires only finalized spending, exactly at 24 hours, never pending or ambiguous liability', () => {
    const now = time + INCOME_WINDOW_SECONDS;
    const income = { ...snapshot(now), mined: { hash: time } };
    expect(activeIncomeSpend([s], { ...income, at: now - 1n })).toEqual([s]);
    expect(activeIncomeSpend([s], income)).toEqual([]);
    expect(activeIncomeSpend([s], snapshot(now))).toEqual([s]);
    expect(activeIncomeSpend([{ ...s, hash: undefined }], income)).toHaveLength(1);
    expect(activeIncomeSpend([s], null)).toEqual([s]);
  });
  it('timestamps a late-mined transaction at inclusion, not reservation', () => {
    const now = time + 2n * INCOME_WINDOW_SECONDS;
    expect(activeIncomeSpend([s], { ...snapshot(now), mined: { hash: now - 1n } })).toEqual([s]);
  });
  it('shares the platform quarter across boxes but never lends another box own share', () => {
    expect(incomeRefusal(a, 100n, [], snapshot())).toBeNull();
    expect(incomeRefusal(a, 101n, [], snapshot())).toBe('box income cap');
    expect(incomeRefusal(b, 1n, [s], snapshot())).toBe('platform income cap');
    const tip = { ...snapshot(), boxes: { [a]: { shareWei: 100n, tipsWei: 1n }, [b]: { shareWei: 300n, tipsWei: 0n } } };
    expect(incomeRefusal(b, 1n, [s], tip)).toBeNull();
    expect(incomeRefusal(b, 2n, [s], tip)).toBe('platform income cap');
  });
  it('does not carry expired receipts or tips into the next window', () => {
    expect(incomeRefusal(a, 1n, [s], { ...snapshot(), platformWei: 0n, boxes: {} })).toBe('box income cap');
  });
  it('caps ordinary v2 money work and exempts every named recovery and Box 0 executor job', () => {
    const capped = JOBS.filter(j => incomeCapped({ job: j.name, version: j.name === 'drandGraduationBounty' ? 1 : 2, key: j.name, to: a, fn: j.name, args: [] })).map(j => j.name);
    // RR2-LIM-3: royaltyObserve is unblocking work, like royaltyRefresh; a below-floor collect for the cursors and a
    // zero-P or low-value press are too, by their simulation, so their jobs stay capped here.
    expect(capped.sort()).toEqual(['buyBack', 'collect', 'deepen', 'eatPriceCoin', 'moveToPile', 'executeModule', 'shopFees', 'sellFees', 'executorExecute', 'executorTopUp', 'poke'].sort());
    for (const job of ['collect', 'deepen', 'poke', 'executorTopUp', 'executorExecute'] as const) {
      expect(incomeCapped({ job, version: 1, key: job, to: a, fn: job, args: [] })).toBe(false);
    }
  });
  it('keeps a source-wide bounty withdrawal outside per-box income accounting in either ABI version', () => {
    for (const version of [1, 2] as const) {
      expect(incomeCapped({ job: 'drandWithdrawBounty', version, key: 'bounty', to: a, fn: 'withdrawBounty', args: [a] })).toBe(false);
    }
  });
});


it('F182 adds provisional room only to this candidate and still enforces both inequalities', () => {
  const candidate = { job: 'collect' as const, version: 2 as const, key: 'collect', to: a, fn: 'collect', args: [a] };
  const sim = { ok: true, estimate: 1n, tipWei: null, startTipWei: 100n };
  const none = { ...snapshot(), platformWei: 0n, boxes: {} };
  expect(startRefusal(candidate, sim, a, 100n, [], none)).toBeNull();
  expect(none.boxes).toEqual({});
  expect(incomeRefusal(b, 1n, [], none)).toBe('box income cap');
  expect(startRefusal(candidate, sim, a, 100n, [s], none)).toBe('box income cap');
  expect(startRefusal(candidate, sim, a, 100n, [{ ...s, box: b }], none)).toBe('platform income cap');
  expect(startRefusal({ ...candidate, value: 1n }, sim, a, 100n, [], none)).toBe('start cost cap');
  expect(startRefusal(candidate, { ...sim, startTipWei: 50000000000000000n }, a, 50000000000000000n, [], none)).toBeNull();
});

it('F182 retains an unpaid start even when its finalized transaction is older than the income window', () => {
  const start = { ...s, start: { job: 'collect' as const } };
  const income = { ...snapshot(time + 172800n), mined: { hash: time } };
  expect(activeIncomeSpend([start], income)).toEqual([start]);
  expect(incomeCost(start, income)).toBe(100n);
});
