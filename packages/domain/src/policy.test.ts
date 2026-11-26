import { describe, expect, it } from 'vitest';
import {
  BURN_NATIVE_T_ROUTE_Q_V1,
  DEMO_CLAIM_TOLERANCE_BPS,
  DRAFT_FEE_TERMS,
  feeTermsIssues,
  minPayoutRaw,
  type FeeTerms,
} from './index';

describe('BURN_NATIVE_T_ROUTE_Q_V1 policy constants (D02, D03; one source of truth)', () => {
  it('declares the draft 3% headline target and the 1:2 protocol/holder Q split', () => {
    expect(BURN_NATIVE_T_ROUTE_Q_V1).toEqual({
      policyId: 'BURN_NATIVE_T_ROUTE_Q_V1',
      status: 'draft',
      headlineFeeTargetBps: 300,
      qProtocolShare: { num: 1, den: 3 },
      qHolderShare: { num: 2, den: 3 },
      nativeTBurnShareBps: 10_000,
    });
    const { qProtocolShare: p, qHolderShare: h } = BURN_NATIVE_T_ROUTE_Q_V1;
    expect(p.num * h.den + h.num * p.den).toBe(p.den * h.den);
  });

  it('is deeply frozen so no caller can change the policy at runtime', () => {
    expect(Object.isFrozen(BURN_NATIVE_T_ROUTE_Q_V1)).toBe(true);
    expect(Object.isFrozen(BURN_NATIVE_T_ROUTE_Q_V1.qProtocolShare)).toBe(true);
    expect(Object.isFrozen(DRAFT_FEE_TERMS)).toBe(true);
  });

  it('derives the pair-detail fee terms from the constants', () => {
    expect(DRAFT_FEE_TERMS).toEqual({
      policyId: 'BURN_NATIVE_T_ROUTE_Q_V1',
      status: 'draft',
      headlineFeeTargetBps: 300,
      qProtocolShare: { num: 1, den: 3 },
    });
    expect(feeTermsIssues(DRAFT_FEE_TERMS)).toEqual([]);
  });

  it.each([
    ['approved status', { status: 'approved' }, 'status'],
    ['another headline target', { headlineFeeTargetBps: 250 }, 'headlineFeeTargetBps'],
    ['an equivalent but non-canonical ratio', { qProtocolShare: { num: 2, den: 6 } }, 'qProtocolShare'],
    ['a numerator above the denominator', { qProtocolShare: { num: 4, den: 3 } }, 'qProtocolShare'],
  ] as const)('rejects fee terms with %s', (_label, patch, path) => {
    const terms = { ...DRAFT_FEE_TERMS, ...patch } as FeeTerms;
    expect(feeTermsIssues(terms).map((issue) => issue.path.join('.'))).toContain(path);
  });
});

describe('minPayoutRaw: fixed draft demo tolerance (1%, not user-editable)', () => {
  it('is 100 bps', () => {
    expect(DEMO_CLAIM_TOLERANCE_BPS).toBe(100);
  });

  it.each([
    [0n, 0n],
    [1n, 0n],
    [99n, 98n],
    [100n, 99n],
    [101n, 99n],
    [10_000n, 9_900n],
    [50_000_000_000_000_000_000n, 49_500_000_000_000_000_000n],
  ])('floor(%s x 0.99) = %s (never above the quote)', (payout, expected) => {
    expect(minPayoutRaw(payout)).toBe(expected);
  });

  it('rejects negative payouts and tolerances outside 0..10000 bps', () => {
    expect(() => minPayoutRaw(-1n)).toThrow(RangeError);
    expect(() => minPayoutRaw(1n, -1)).toThrow(RangeError);
    expect(() => minPayoutRaw(1n, 10_001)).toThrow(RangeError);
    expect(() => minPayoutRaw(1n, 1.5)).toThrow(RangeError);
  });
});
