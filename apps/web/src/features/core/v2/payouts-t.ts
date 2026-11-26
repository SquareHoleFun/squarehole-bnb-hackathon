/**
 * v2.1 step 2 in the claim views: holder batches and item credits paid in the box token T. A holder batch belongs to
 * one fee side, so it is paid in one coin (`holderBatchInTV21`: P or T by that side's choice); an item can hold credit in
 * both coins, claimed separately (claim in P, claimT in T). Amounts always come from the shared readers' `t` quotes at
 * the displayed hash (`readHolderClaimV2`, `readItemClaimV2`); the history only narrows which batches to read. Pure data.
 */
import { holderBatchInTV21 } from '../../../../../../packages/indexer/src/core/v2/pay-in-t-v21';
import type { M2ViewV2 } from '../../../../../../packages/indexer/src/core/v2/m2-views-v2';
import type { V2Snapshot } from './indexer-v2';

type Spec = Pick<V2Snapshot['spec'], 'buyers' | 'sellers'>;

/** Whether holder batch `batch` pays in T (its side chose To holders in the box token). */
export const batchInT = (spec: Spec, batch: bigint): boolean => batch > 0n && holderBatchInTV21(spec as Parameters<typeof holderBatchInTV21>[0], batch);
/** Whether a side pays items in T (BuyT / Items). */
export const itemsInT = (spec: Spec): boolean => [spec.buyers, spec.sellers].some((side) => side.a.leg === 2 && side.a.dest === 8);
/** Whether a side pays items in P (AsPaid / Items). */
export const itemsInP = (spec: Spec): boolean => [spec.buyers, spec.sellers].some((side) => side.a.leg === 1 && side.a.dest === 8);

/**
 * The holder history the read plan narrows with: the P batches (`m2.history`) and the T batches with settled tranches
 * (`payInT.history`). A T batch has no per-holder payment record, so it stays a candidate until all its credit is paid.
 */
export function holderHistoryOf(view: Pick<V2Snapshot, 'm2' | 'payInT'>): M2ViewV2 | null | undefined {
  const history = view.m2?.history; const t = view.payInT?.history;
  if (!t) return history;
  const tBatches = Object.fromEntries(Object.entries(t.batches).map(([id, b]) => [id, { fundingP: b.fundingT, complete: true, holderP: b.holderT, residueP: b.residueT, paidP: b.paidT, tipsP: 0n, flushedP: b.flushedT, payments: {} }]));
  return history ? { ...history, batches: { ...history.batches, ...tBatches } } : { failed: false, batches: tBatches, shop: null, starter: null };
}

/** The coin a claim view names an amount in: the price coin P, or the box token T (18 decimals). */
export type PayoutAsset = 'P' | 'T';
