import type { Limits } from './decide';
import { F111_MAX_FEE_WEI } from './income';
import type { Candidate, JobName } from './types';

/** R62-FEE: the only jobs allowed to use the deadline fee and its separate daily cap. */
export const DRAND_RESCUE_JOBS: readonly JobName[] = Object.freeze(['drandPostRound', 'drandRequestWord', 'backupStart', 'backupFix']);

export function drandFeeApplies(c: Pick<Candidate, 'job' | 'drandDeadline'>, now: bigint, limits: Limits): boolean {
  return DRAND_RESCUE_JOBS.includes(c.job) && c.drandDeadline !== undefined
    && (limits.drandRescueWeiPerDay ?? 0n) > 0n && (limits.drandRescueWindowSeconds ?? 0n) > 0n
    && c.drandDeadline - now < (limits.drandRescueWindowSeconds ?? 0n)
    && (c.job === 'drandRequestWord' || now <= c.drandDeadline);
}

export function maxFeeFor(c: Pick<Candidate, 'job' | 'drandDeadline'>, now: bigint, limits: Limits): bigint {
  if (drandFeeApplies(c, now, limits)) return limits.drandRescueMaxFeeWei ?? F111_MAX_FEE_WEI;
  const configured = limits.maxFeePerGas ?? F111_MAX_FEE_WEI;
  return configured < F111_MAX_FEE_WEI ? configured : F111_MAX_FEE_WEI;
}
