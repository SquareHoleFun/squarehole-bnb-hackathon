/**
 * Step 2 maintenance shares the existing F111 buy/burn job budgets and per-pool step guard. Its routine calls of
 * reserved jobs (a purchased-T holder tranche, T residue burns) are marked `ordinary`: no claim waits on them, so
 * they take the F111 income caps and never the protected recovery reserve (SH-V21-FIX-KEEPER-INDEX).
 */
import type { Address } from 'viem';
import { receiverPayInTV21Abi, itemLedgerV2Abi, holderLedgerV2Abi } from '../../chain/src/core/v2/abi-v2';
import { holderFundingAbi } from './abi';
import type { V2State } from './world';
import type { M2Work } from './m2';
import type { M3Work } from './m3';
type Call = <T>(address: Address, abi: readonly unknown[], fn: string, args?: readonly unknown[]) => Promise<T>;
type Guard = <T>(source: string, read: () => Promise<T>, fallback: () => T) => Promise<T>;
export const T_ITEM_SYNC_STEPS = 8n;
/** FeeChoice.HoldersT: that side's holder batches are funded with bought T and pay T. */
export const HOLDERS_T_CHOICE = 7;
/**
 * Batching floor for T residue burns in raw T: 0.01 T at the box token's 18 decimals (every box token mints exactly
 * 1e27 raw units), the same 0.01-coin floor collect uses for P. Each burn needs its full BURN_GAS admission; smaller
 * residue waits in its ledger, where no claim can reach it.
 */
export const T_RESIDUE_MIN_RAW = 10n ** 16n;
export const buyBudgetV21 = (v: V2State): bigint => v.buyBackP + (v.rewardsPendingP ?? 0n);
export const burnBudgetV21 = (v: V2State): bigint => v.tBurnPending + (v.rewardBurnPendingT ?? 0n);
/**
 * SH-KEEPER-V2-STEPS (STEPS-B): whether one buyBack call can buy now. The receiver buys from one bucket per call, the
 * buy-back P or one reward kind, and skips with BelowMinimum while every bucket is under the hook's STEP_MIN_Q
 * (BoxReceiverV2.buyBack). An unknown minimum keeps the old rule, any positive budget; without the per-kind view the
 * reward total stands in for its kinds, which can only overstate what is buyable.
 */
export function buyableV21(v: V2State): boolean {
  const minimum = v.stepMinQ !== undefined && v.stepMinQ > 0n ? v.stepMinQ : 1n;
  if (v.buyBackP >= minimum) return true;
  return v.rewardsPendingByKind ? v.rewardsPendingByKind.some(kind => kind >= minimum) : (v.rewardsPendingP ?? 0n) >= minimum;
}
const threeAmounts = (k: readonly unknown[]): readonly [bigint, bigint, bigint] | undefined => {
  const [a, b, c] = k;
  return k.length === 3 && typeof a === 'bigint' && typeof b === 'bigint' && typeof c === 'bigint' ? [a, b, c] : undefined;
};
/**
 * Older receivers have no additive selectors. An unavailable read suppresses only new reward work. The per-kind view
 * is read only while reward P waits, so a receiver without reward P costs no extra read.
 */
export async function readPayInTV21(receiver: Address, call: Call, guard: Guard) {
  const read = (fn: string) => guard(`${receiver}:${fn}`, () => call<bigint>(receiver, receiverPayInTV21Abi, fn), () => 0n);
  const [rewardsPendingP, rewardBurnPendingT] = await Promise.all([read('rewardsPendingP'), read('rewardBurnPendingT')]);
  const kinds = rewardsPendingP > 0n ? await guard(`${receiver}:rewardsPendingByKind`,
    () => call<readonly unknown[]>(receiver, receiverPayInTV21Abi, 'rewardsPendingByKind').then(threeAmounts), () => undefined) : undefined;
  return { rewardsPendingP, rewardBurnPendingT, ...(kinds ? { rewardsPendingByKind: kinds } : {}) };
}
/** Wiring is authenticated by readM3 before this function is called; simulation proves residue at the floor. */
export async function itemTResidueV21(ledger: Address, call: Call, guard: Guard): Promise<readonly M3Work[]> {
  const mask = await guard(`${ledger}:tokenSides`, () => call<number>(ledger, itemLedgerV2Abi, 'tokenSides'), () => 0);
  return mask !== 1 && mask !== 2 && mask !== 3 ? [] : [{ job: 'itemResidue', to: ledger, fn: 'flushResidueT', args: [],
    key: `itemResidue:2:${ledger.toLowerCase()}:t`, ordinary: true, minAmountRaw: T_RESIDUE_MIN_RAW }];
}
/**
 * Which holder sides pay T, as [buyers (odd ids), sellers (even ids)]. The receiver's immutable choice fixes what
 * holderBatchPaid reports; every T side's ledger payoutAsset must be the box token, or no holder work is proposed.
 * V2.0 receivers report their own choices, none of them HoldersT, so their batches keep the P policy unchanged.
 */
export async function holderTSidesV21(receiver: Address, ledger: Address, token: Address, call: Call): Promise<readonly [boolean, boolean]> {
  const [buyers, sellers] = await Promise.all([
    call<number>(receiver, holderFundingAbi, 'buyersChoice'), call<number>(receiver, holderFundingAbi, 'sellersChoice'),
  ]);
  const sides = [buyers === HOLDERS_T_CHOICE, sellers === HOLDERS_T_CHOICE] as const;
  const assets = await Promise.all(sides.map((inT, i) => inT ? call<Address>(ledger, holderLedgerV2Abi, 'payoutAsset', [BigInt(i + 1)]) : null));
  if (assets.some((asset) => asset !== null && asset.toLowerCase() !== token.toLowerCase())) throw new Error('inconsistent holder payout asset');
  return sides;
}
/**
 * One allocated, hook-closed HoldersT batch. holderBatchPaid is its cumulative bought T: zero until a purchase reaches
 * the batch, so always zero before graduation and after failure. A pass then moves nothing and is never proposed.
 * Earlier tranches stay claimable while a later one settles (HolderLedgerV2 claimable/_matured), so no claim waits
 * on this work: it is ordinary per-box maintenance, paid like the purchase that funded it. Burns wait for the floor.
 */
export function holderTWorkV21(settle: M2Work, flush: M2Work, complete: boolean, paid: bigint, residue: bigint): M2Work[] {
  if (!complete) return paid > 0n ? [{ ...settle, ordinary: true }] : [];
  return residue >= T_RESIDUE_MIN_RAW ? [{ ...flush, ordinary: true, minAmountRaw: T_RESIDUE_MIN_RAW }] : [];
}
