/** CQ11 independent menu enumeration for tests; ABI types come from the frozen generated shapes. */
import type { Address } from 'viem';
import type { SideV2 } from '../generated/box-spec.v2';
export const ZERO: Address = '0x0000000000000000000000000000000000000000';
export const choices = ['keep', 'burn', 'grow', 'eat'] as const;
export type Choice = (typeof choices)[number];
export function side(choice: Choice): SideV2 {
  return {
    split: 1, splitParams: '0x', b: { leg: 0, dest: 0, legParams: '0x', destParams: '0x' },
    a: { leg: choice === 'burn' ? 2 : 1, dest: choice === 'keep' ? 2 : choice === 'burn' || choice === 'eat' ? 1 : 4, legParams: '0x', destParams: '0x' },
  };
}
