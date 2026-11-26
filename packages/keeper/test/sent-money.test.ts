/**
 * SH-250 fix round, C: the money rules of a replacement and of a nonce's outcome, pinned by direct calls of
 * `replaceHanging`, `settle` and `applyOutcomes` (the cases of the reviewer's scripts/replace-units.ts). The scheduler
 * tests in sent-replace.test.ts cover the same paths end to end.
 */
import { describe, expect, it, vi } from 'vitest';
import { settle, type Budget, type Limits } from '../src/decide';
import { applyOutcomes, replaceHanging, type ReplacementPlan } from '../src/hanging';
import type { IncomeSnapshot, IncomeSpend } from '../src/income';
import type { SentReservation } from '../src/sent';

const H = `0x${'aa'.repeat(32)}`, BOX = `0x${'0b'.repeat(20)}` as const, DAY = 20_732n;
const limits: Limits = { oursWeiPerDay: 900n, pokesWeiPerDay: 300n, reserveWeiPerDay: 100n, totalWeiPerDay: 1_000n, maxTxPerBlock: 4,
  drandRescueWeiPerDay: 200n, unblockingWeiPerDay: 400n, unblockingWeiPerBoxPerDay: 150n };
const budget = (over: Partial<Budget> = {}): Budget => ({ day: DAY, oursWei: 100n, pokesWei: 0n, totalWei: 100n, drandRescueWei: 0n, block: 1n,
  txInBlock: 0, pending: [{ costWei: 100n, ours: 'ours', hash: H }], ...over });
const reservation = (over: Partial<SentReservation> = {}): SentReservation => ({ at: 1n, day: DAY, costWei: 100n, ours: 'ours', v: 2, ...over });
const plan = (r: SentReservation, costWei = 160n): ReplacementPlan => ({ entry: { signer: BOX, nonce: 7n, txs: [{ hash: H }], reservation: r }, costWei });

async function run(b: Budget, p: ReplacementPlan, spend: readonly IncomeSpend[] = [], income: IncomeSnapshot | null = null) {
  const order: string[] = [];
  const out = await replaceHanging([p], { budget: b, incomeSpend: spend, income, limits, log: { info: () => {}, warn: vi.fn(), error: () => {} },
    save: async () => { order.push('save'); }, replace: async () => { order.push('replace'); return H; } });
  return { ...out, order };
}

describe('SH-250 replacement charges', () => {
  it('on the same day: the nonce is held at its new maximum, reserved before the replacement is signed', async () => {
    const out = await run(budget(), plan(reservation()));
    expect(out.order).toEqual(['save', 'replace']);
    expect(out.budget.pending).toEqual([{ costWei: 100n, ours: 'ours', hash: H }, { costWei: 60n, ours: 'ours', hash: H }]);
    expect([out.budget.totalWei, out.budget.oursWei, out.budget.txInBlock]).toEqual([160n, 160n, 1]);
    // Idempotent: the day already holds the new maximum (a crash after the reservation, before the save).
    const again = await run(out.budget, plan(reservation()));
    expect([again.budget.totalWei, again.budget.pending?.length]).toEqual([160n, 2]);
  });

  it('on a later day: charges the new maximum less the original cost only (M2)', async () => {
    const out = await run(budget({ day: DAY + 1n, totalWei: 0n, oursWei: 0n, pending: [] }), plan(reservation()));
    expect(out.budget.pending).toEqual([{ costWei: 60n, ours: 'ours', hash: H }]);
    expect(out.budget.totalWei).toBe(60n);
  });

  it('an income-capped replacement waits when its extra does not fit the box income cap; spend unchanged (M4)', async () => {
    const spend: IncomeSpend[] = [{ box: BOX, at: 1n, costWei: 100n, hash: H }];
    const income: IncomeSnapshot = { at: 2n, platformWei: 10n ** 9n, boxes: { [BOX.toLowerCase()]: { shareWei: 120n, tipsWei: 0n } }, mined: {} };
    const out = await run(budget(), plan(reservation({ income: { box: BOX.toLowerCase(), at: 1n } })), spend, income);
    expect(out.order).toEqual([]);
    expect(out.incomeSpend).toEqual(spend);
    expect(out.budget).toEqual(budget());
    // With room the spend entry is raised to the new maximum (Q3).
    const rich: IncomeSnapshot = { ...income, boxes: { [BOX.toLowerCase()]: { shareWei: 10n ** 6n, tipsWei: 0n } } };
    const paid = await run(budget(), plan(reservation({ income: { box: BOX.toLowerCase(), at: 1n } })), spend, rich);
    expect(paid.incomeSpend).toEqual([{ ...spend[0], costWei: 160n }]);
  });

  it.each([
    ['the daily total', budget({ totalWei: 850n }), reservation(), 'daily ceiling reached'],
    ['ours', budget({ oursWei: 760n }), reservation(), 'ours budget spent'],
    ['pokes', budget({ pokesWei: 250n }), reservation({ ours: 'pokes' }), 'pokes budget spent'],
    ['the unblocking wei of a box', budget({ unblockingWeiByBox: { [BOX]: 150n }, unblockingWei: 150n }), reservation({ unblocking: BOX }), 'box unblocking wei spent'],
    ['the rescue allowance', budget({ drandRescueWei: 150n }), reservation({ counter: 'drandRescue', ours: undefined }), 'drand rescue allowance spent'],
    ['the per-block limit', budget({ txInBlock: 4 }), reservation(), null],
  ] as const)('refused by %s: nothing reserved, saved or signed', async (_, b, r, why) => {
    const warn = vi.fn();
    const out = await replaceHanging([plan(r)], { budget: b, incomeSpend: [], income: null, limits, log: { info: () => {}, warn, error: () => {} },
      save: async () => { throw new Error('saved'); }, replace: async () => { throw new Error('signed'); } });
    expect(out.budget).toEqual(b);
    if (why) expect(warn).toHaveBeenCalledWith('replacement waits', expect.objectContaining({ why }));
  });
});

describe('SH-250 a nonce\'s outcome in the journal', () => {
  it('settles the day\'s entries of one hash as one liability to what the winner paid, the release from the latest first', () => {
    const b = budget({ totalWei: 160n, oursWei: 160n, pending: [{ costWei: 100n, ours: 'ours', hash: H }, { costWei: 60n, ours: 'ours', hash: H }] });
    const out = settle(b, { [H]: 70n });
    expect([out.totalWei, out.oursWei, out.pending]).toEqual([70n, 70n, []]);
    // A paid amount above the held maximum is not this nonce's receipt: everything stays.
    expect(settle(b, { [H]: 161n })).toEqual(b);
  });

  it('a release frees the whole reservation, value included, and drops the bounty and the spend of that call (M3)', () => {
    const state = { budget: budget({ totalWei: 500n, oursWei: 500n, pending: [{ costWei: 500n, valueWei: 100n, ours: 'ours', hash: H }] }),
      incomeSpend: [{ box: BOX, at: 1n, costWei: 400n, hash: H }], drandBounties: { [`${BOX.toLowerCase()}:5`]: { hash: H } } };
    const out = applyOutcomes(state, { released: { [H]: 9n } });
    expect([out.budget?.totalWei, out.budget?.oursWei, out.budget?.pending]).toEqual([0n, 0n, []]);
    expect(out.incomeSpend).toEqual([]);
    expect(out.drandBounties).toEqual({});
  });

  it('a renamed winner names every entry of its call, so the day settles on the winner\'s receipt', () => {
    const W = `0x${'bb'.repeat(32)}`;
    const state = { budget: budget({ pending: [{ costWei: 100n, ours: 'ours', hash: H }, { costWei: 60n, ours: 'ours', hash: H }] }),
      incomeSpend: [{ box: BOX, at: 1n, costWei: 160n, hash: H }] };
    const out = applyOutcomes(state, { renamed: { [H]: W } });
    expect(out.budget?.pending?.map(r => r.hash)).toEqual([W, W]);
    expect(out.incomeSpend?.[0]?.hash).toBe(W);
  });
});
