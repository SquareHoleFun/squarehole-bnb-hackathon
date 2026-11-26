/** Wallet compatibility: legacy amountP fields are raw units of the row's explicit asset. */
import type { Address } from 'viem';
import type { BoxRowV2 } from '../core-row';
import type { LiveStateV2 } from './views-v2';
import type { CoreEventV2 } from './events-v2';
import { claimPaymentsV2, type ClaimPaymentV2 } from './claims-events-v2';
import { holderBatchInTV21 } from './pay-in-t-v21';
import type { readHolderClaimV2 } from './m2-reads-v2';
import type { readItemClaimV2 } from './m3-reads-v2';

export function rewardWalletCandidatesV21(row: BoxRowV2, state: LiveStateV2, wallet: Address) {
  const out: { kind: 'holder' | 'item'; id: bigint }[] = [];
  // Keep settled T batches after partial int128 claims; only the canonical remaining credit removes a row.
  if (row.contracts.holderLedger) for (const id of Object.keys(state.view.payInT?.batches ?? {})) out.push({ kind: 'holder', id: BigInt(id) });
  if (row.contracts.itemLedger && [row.spec.buyers, row.spec.sellers].some(s => s.a.leg === 2 && s.a.dest === 8)) {
    for (const [id, owner] of Object.entries(state.view.m3?.items?.owners ?? {})) if (owner === wallet) out.push({ kind: 'item', id: BigInt(id) });
  }
  return out;
}
/** P item credit exists only on a box with a P Items side; a box whose every Items side pays T never credits P. */
export const itemPCandidatesV21 = (row: BoxRowV2): boolean => [row.spec.buyers, row.spec.sellers].some(s => s.a.dest === 8 && s.a.leg !== 2);
/**
 * A T holder row needs a positive canonical credit. The ledger exposes no per-holder staged tranche, so an open
 * tranche is never a 'pending' row for every wallet; a holder's staged amount appears once its tranche completes.
 */
export function holderWalletQuoteV21(value: Awaited<ReturnType<typeof readHolderClaimV2>>, inT?: boolean) {
  if (!inT) return value;
  if (!value.t) throw new Error('missing holder T quote');
  return { ...value, claimableP: value.t.creditT > 0n ? value.t.claimableT : 0n, payout: value.t.payout };
}
export function itemWalletQuoteV21(value: Awaited<ReturnType<typeof readItemClaimV2>>, inT?: boolean) {
  if (!inT) return value;
  if (!value.t) throw new Error('missing item T quote');
  return { ...value, claimableP: value.t.claimableT, outsideP: value.t.outsideT, stashP: value.t.stashT, payout: value.t.payout };
}
/** Existing receipt retention/reorg logic remains the owner; only the denomination and new event are adapted. */
export function rewardClaimPaymentsV21(previous: readonly ClaimPaymentV2[], events: readonly CoreEventV2[], block: bigint, row: BoxRowV2) {
  const itemKeys = new Set(events.filter(e => e.boxId === row.boxId && e.source === 'itemLedger' && e.name === 'ItemPaidT')
    .map(e => `${e.ref.blockHash}:${e.ref.logIndex}`));
  const normalized = events.map(e => e.source === 'itemLedger' && e.name === 'ItemPaidT'
    ? { ...e, name: 'ItemPaid', args: { ...e.args, grossP: e.args.amountT, tipP: 0n } } : e);
  return claimPaymentsV2(previous, normalized, block, row.boxId).map(p =>
    (p.kind === 'holder' && p.batchId !== null && holderBatchInTV21(row.spec, p.batchId)) || itemKeys.has(`${p.hash}:${p.logIndex}`)
      ? { ...p, asset: row.contracts.token as Address } : p);
}
