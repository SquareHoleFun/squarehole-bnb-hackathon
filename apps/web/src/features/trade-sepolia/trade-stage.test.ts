import { describe, expect, it } from 'vitest';
import { LAUNCH_TAX_TABLE_PIPS } from '@squarehole/indexer/client';
import { clockUtc, stageOfPhase, stageOfView, tradesIn, windowTaxAt, slotSecondsSince } from './trade-stage';

const OPEN = 1_790_000_000n;

describe('windowTaxAt: the launch router’s table, one step every 12 s for 384 s (F157 Q1)', () => {
  it('names the step, its rate rounded up, and when it ends', () => {
    expect(windowTaxAt(OPEN, OPEN)).toEqual({ step: 0, pips: 931_974, text: '93.20%', endsAt: OPEN + 12n });
    expect(windowTaxAt(OPEN, OPEN + 11n)?.step).toBe(0);
    expect(windowTaxAt(OPEN, OPEN + 12n)).toEqual({ step: 1, pips: 926_013, text: '92.61%', endsAt: OPEN + 24n });
    expect(windowTaxAt(OPEN, OPEN + 383n)).toEqual({ step: 31, pips: 80_565, text: '8.06%', endsAt: OPEN + 384n });
  });
  it('has no tax before the open or from 384 s on', () => {
    expect(windowTaxAt(OPEN, OPEN - 1n)).toBeNull();
    expect(windowTaxAt(OPEN, OPEN + 384n)).toBeNull();
  });
  it('uses the router’s 32 rates in order (BoxLaunchRouterV2.taxTable())', () => {
    expect(LAUNCH_TAX_TABLE_PIPS).toHaveLength(32);
    LAUNCH_TAX_TABLE_PIPS.forEach((pips, step) => expect(windowTaxAt(OPEN, OPEN + 12n * BigInt(step))?.pips).toBe(pips));
  });
});

describe('the stage: the snapshot before a plan, the hook’s phase after one', () => {
  const view = (patch: Partial<Parameters<typeof stageOfView>[0]> = {}) => ({ failed: null, graduated: false, closedAt: 0n,
    gate: { open: true, deadline: OPEN + 86_400n, effectiveOpenAt: OPEN }, timestamp: OPEN + 1n, ...patch });
  it('maps the life stages', () => {
    expect(stageOfView(view({ timestamp: OPEN - 5n }))).toBe('upcoming');
    expect(stageOfView(view({ gate: { open: false, deadline: 0n, effectiveOpenAt: 0n } }))).toBe('upcoming');
    expect(stageOfView(view())).toBe('window');
    expect(stageOfView(view({ timestamp: OPEN + 384n }))).toBe('bonding');
    expect(stageOfView(view({ closedAt: OPEN + 500n }))).toBe('closed');
    expect(stageOfView(view({ graduated: true }))).toBe('graduated');
    expect(stageOfView(view({ failed: { cause: 'Deadline', at: OPEN } }))).toBe('failed');
  });
  it('maps the hook’s phases 1 to 6, and nothing else', () => {
    expect([1, 2, 3, 4, 5, 6].map(stageOfPhase)).toEqual(['upcoming', 'window', 'bonding', 'closed', 'graduated', 'failed']);
    expect(stageOfPhase(0)).toBeNull();
    expect(stageOfPhase(7)).toBeNull();
  });
  it('trades in the window, on the curve and after graduation only', () => {
    expect((['upcoming', 'window', 'bonding', 'closed', 'graduated', 'failed'] as const).filter(tradesIn)).toEqual(['window', 'bonding', 'graduated']);
  });
});

describe('clockUtc', () => {
  it('is a time of day in UTC', () => {
    expect(clockUtc(1_790_000_000n)).toBe('14:13:20 UTC');
    expect(clockUtc(0n)).toBe('00:00:00 UTC');
  });
});

describe('slotSecondsSince: the seconds a quote may count, in whole 12 s slots (SH-ALPHA-TEST-COINS review)', () => {
  it('counts a slot only once it is whole, never a negative time', () => {
    expect(slotSecondsSince(1_000, 1_000)).toBe(0n);
    expect(slotSecondsSince(1_000, 12_999)).toBe(0n);
    expect(slotSecondsSince(1_000, 13_000)).toBe(12n);
    expect(slotSecondsSince(1_000, 37_000)).toBe(36n);
    expect(slotSecondsSince(5_000, 1_000)).toBe(0n);
  });
});
