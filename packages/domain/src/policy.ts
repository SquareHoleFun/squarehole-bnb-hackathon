/**
 * BURN_NATIVE_T_ROUTE_Q_V1 (D02, D03; 05-ECONOMICS). The ONE place these draft constants are defined: the launch
 * draft validator, pair-detail fee terms, claim estimates and the mock template all read them from here.
 *
 * Draft policy only. It is not an approved fee schedule (G05), not a universal 3% trading tax, and it does not
 * describe how any venue collects fees (G01). The 1:2 split allocates Q that was ALREADY collected.
 */
import type { GuardIssue } from './guards';
import type { FeeTerms } from './types';

export const BURN_NATIVE_T_ROUTE_Q_V1 = Object.freeze({
  policyId: 'BURN_NATIVE_T_ROUTE_Q_V1',
  status: 'draft',
  /** Historical 3% headline economic target (D03); draft until the fee-incidence table is approved. */
  headlineFeeTargetBps: 300,
  /** Share of collected Q allocated to the protocol treasury. */
  qProtocolShare: Object.freeze({ num: 1, den: 3 }),
  /** Share of collected Q allocated to historical holder entitlements. */
  qHolderShare: Object.freeze({ num: 2, den: 3 }),
  /** 100% of native fee-origin T is burned; never also distributed or swapped (ECO-01). */
  nativeTBurnShareBps: 10_000,
} as const);

/** Fee terms shown on pair detail and in the launch review (derived from the constants above). */
export const DRAFT_FEE_TERMS: Readonly<FeeTerms> = Object.freeze({
  policyId: BURN_NATIVE_T_ROUTE_Q_V1.policyId,
  status: BURN_NATIVE_T_ROUTE_Q_V1.status,
  headlineFeeTargetBps: BURN_NATIVE_T_ROUTE_Q_V1.headlineFeeTargetBps,
  qProtocolShare: BURN_NATIVE_T_ROUTE_Q_V1.qProtocolShare,
});

export const BPS_DENOMINATOR = 10_000;

/**
 * Fixed draft demo tolerance for the signed minimum payout of an R=T claim conversion (ECO-07). It is a documented
 * constant, not a user setting: there is no slippage field in the app (04-EXTERNAL-TRADING: no forced high slippage).
 */
export const DEMO_CLAIM_TOLERANCE_BPS = 100;

/** `floor(payout x (10000 - toleranceBps) / 10000)`: the minimum the user signs; never above the quoted payout. */
export function minPayoutRaw(payoutRaw: bigint, toleranceBps: number = DEMO_CLAIM_TOLERANCE_BPS): bigint {
  if (payoutRaw < 0n) throw new RangeError('payoutRaw must be non-negative');
  if (!Number.isInteger(toleranceBps) || toleranceBps < 0 || toleranceBps > BPS_DENOMINATOR) {
    throw new RangeError(`toleranceBps must be an integer between 0 and ${BPS_DENOMINATOR}`);
  }
  return (payoutRaw * BigInt(BPS_DENOMINATOR - toleranceBps)) / BigInt(BPS_DENOMINATOR);
}

/** Fee terms must equal the policy constants exactly (no equivalent ratios, no approved status in this client). */
export function feeTermsIssues(terms: FeeTerms, basePath: readonly (string | number)[] = []): GuardIssue[] {
  const issues: GuardIssue[] = [];
  const policy = BURN_NATIVE_T_ROUTE_Q_V1;
  const add = (field: string, message: string): void => {
    issues.push({ path: [...basePath, field], message });
  };
  if (terms.policyId !== policy.policyId) add('policyId', `must be ${policy.policyId}`);
  if (terms.status !== policy.status) add('status', 'the fee policy is draft until economics approval (G05)');
  if (terms.headlineFeeTargetBps !== policy.headlineFeeTargetBps) {
    add('headlineFeeTargetBps', `must equal the policy constant (${policy.headlineFeeTargetBps} bps)`);
  }
  const share: unknown = terms.qProtocolShare;
  const num = typeof share === 'object' && share !== null ? (share as { num?: unknown }).num : undefined;
  const den = typeof share === 'object' && share !== null ? (share as { den?: unknown }).den : undefined;
  if (num !== policy.qProtocolShare.num || den !== policy.qProtocolShare.den) {
    add('qProtocolShare', `must equal the policy constant ${policy.qProtocolShare.num}/${policy.qProtocolShare.den}`);
  }
  return issues;
}
