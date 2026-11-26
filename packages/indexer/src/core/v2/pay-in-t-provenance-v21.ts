/** Canonical appended ledger arguments; the old P prefix stays byte-for-byte unchanged. */
import { toHex, type Address, type Hex } from 'viem';
import type { BoxSpecV2 } from './chain-v2';
export function rewardMaskV21(spec: BoxSpecV2, dest: 6 | 8): number {
  return (spec.buyers.a.leg === 2 && spec.buyers.a.dest === dest ? 1 : 0)
    + (spec.sellers.a.leg === 2 && spec.sellers.a.dest === dest ? 2 : 0);
}
export function rewardArgsSuffixV21(spec: BoxSpecV2, dest: 6 | 8, token: Address): string {
  const mask = rewardMaskV21(spec, dest);
  return mask === 0 ? '' : toHex(mask, { size: 1 }).slice(2) + (dest === 8 ? token.slice(2).toLowerCase() : '');
}
export const hasRewardDestV21 = (spec: BoxSpecV2, dest: 6 | 8): boolean => [spec.buyers, spec.sellers].some(s => s.a.dest === dest);
export const appendRewardArgsV21 = (prefix: Hex, spec: BoxSpecV2, dest: 6 | 8, token: Address): Hex => `${prefix}${rewardArgsSuffixV21(spec, dest, token)}`;

/** Step 1 appends its four-byte burn selector whenever either side selects Eat. */
export const receiverArgsHexLengthV21 = (spec: BoxSpecV2): number =>
  [spec.buyers, spec.sellers].some(s => s.a.leg === 1 && s.a.dest === 9) ? 782 :
  [spec.buyers, spec.sellers].some(s => s.a.leg === 1 && s.a.dest === 7) ? 574 :
  [spec.buyers, spec.sellers].some(s => s.a.leg === 1 && s.a.dest === 1) ? 534 : 526;
