/** Step 2 projection: separate assets while retaining the original receipt/lifecycle sequence. */
import type { Address } from 'viem';
import type { BoxSpecV2 } from './chain-v2';
import { itemPoliciesV2 } from './chain-v2';
import type { CoreEventV2 } from './events-v2';
export const holderBatchInTV21 = (spec: BoxSpecV2, id: bigint): boolean => {
  const a = (id % 2n === 1n ? spec.buyers : spec.sellers).a;
  return a.leg === 2 && a.dest === 6;
};
const itemInT = (spec: BoxSpecV2, side: unknown) => (side === 1 ? spec.buyers : spec.sellers).a.leg === 2;
/** P reducers still see every item receipt, including zero-P T receipts referenced by lifecycle records. */
export function priceEventsV21(events: readonly CoreEventV2[], spec: BoxSpecV2): readonly CoreEventV2[] {
  return events.flatMap(e => {
    if ((e.source === 'holderLedger' || e.name === 'HolderBatchFunded') && typeof e.args.batchId === 'bigint'
      && holderBatchInTV21(spec, e.args.batchId)) return [];
    if (e.source === 'receiver' && e.name === 'ItemFunded' && itemInT(spec, e.args.side)) {
      return [{ ...e, args: { ...e.args, choiceP: 0n, ledgerP: 0n } }];
    }
    return [e];
  });
}
export interface RewardBatchV21 { readonly fundingT: bigint; readonly holderT: bigint; readonly residueT: bigint; readonly paidT: bigint; readonly flushedT: bigint }
export interface PayInTViewV21 {
  readonly itemsDepth?: Readonly<Record<string, { readonly choiceP: bigint; readonly depthP: bigint; readonly queuedP: bigint; readonly spentP: bigint; readonly tipsP: bigint }>>;
  readonly spentP: bigint; readonly boughtT: bigint; readonly tipsP: bigint;
  readonly holdersFundedT: bigint; readonly itemsFundedT: bigint; readonly insideBurnT: bigint; readonly burnedT: bigint;
  readonly holdersPaidT: bigint; readonly holderResidueT: bigint; readonly itemsPaidT: bigint; readonly itemResidueT: bigint;
  readonly batches: Readonly<Record<string, RewardBatchV21>>;
  readonly paidByItemT: Readonly<Record<string, bigint>>;
}
export function payInTViewV21(events: readonly CoreEventV2[], boxId: bigint, receiver: Address, spec?: BoxSpecV2, previous?: PayInTViewV21): PayInTViewV21 {
  let v: PayInTViewV21 = previous ?? { spentP: 0n, boughtT: 0n, tipsP: 0n, holdersFundedT: 0n, itemsFundedT: 0n, insideBurnT: 0n, burnedT: 0n,
    holdersPaidT: 0n, holderResidueT: 0n, itemsPaidT: 0n, itemResidueT: 0n, batches: {}, paidByItemT: {} };
  const raw = (a: unknown): bigint => { if (typeof a !== 'bigint' || a < 0n) throw new Error('invalid T credit amount'); return a; };
  const check = (ok: boolean) => { if (!ok) throw new Error('T credit conservation'); };
  for (const e of events) {
    if (e.boxId !== boxId) continue;
    const a = e.args;
    if (e.source === 'receiver' && e.address.toLowerCase() === receiver.toLowerCase()) {
      if (e.name === 'RewardsBought') {
        const bought = raw(a.boughtT), ledger = raw(a.ledgerT), burn = raw(a.burnT);
        check((a.choice === 7 || a.choice === 8) && ledger + burn === bought && (a.choice !== 7 || burn === 0n));
        v = { ...v, spentP: v.spentP + raw(a.spentP), boughtT: v.boughtT + bought, tipsP: v.tipsP + raw(a.tipP),
          holdersFundedT: v.holdersFundedT + (a.choice === 7 ? ledger : 0n), itemsFundedT: v.itemsFundedT + (a.choice === 8 ? ledger : 0n), insideBurnT: v.insideBurnT + burn };
        if (a.choice === 8 && spec && itemPoliciesV2(spec)[a.side === 1 ? 'buyers' : 'sellers'] === 3) {
          const key = String(a.side), d = v.itemsDepth?.[key];
          check(!!d && burn === 0n && (a.side === 1 || a.side === 2));
          if (d) v = { ...v, itemsDepth: { ...v.itemsDepth, [key]: { ...d, spentP: d.spentP + raw(a.spentP), tipsP: d.tipsP + raw(a.tipP) } } };
        }
      } else if (e.name === 'ItemsDepthFunded') {
        check(!!spec && (a.side === 1 || a.side === 2) && [1, 2, 3, 4].includes(a.source as number));
        if (!spec) throw new Error('T credit conservation: missing spec');
        check(itemInT(spec, a.side) && itemPoliciesV2(spec)[a.side === 1 ? 'buyers' : 'sellers'] === 3);
        const choiceP = raw(a.choiceP), depthP = raw(a.depthP), queuedP = raw(a.rewardsP);
        check(choiceP === depthP + queuedP && (a.source !== 3 && a.source !== 4 || queuedP === 0n));
        const key = String(a.side), d = v.itemsDepth?.[key] ?? { choiceP: 0n, depthP: 0n, queuedP: 0n, spentP: 0n, tipsP: 0n };
        const next = { ...d, choiceP: d.choiceP + (a.source === 4 ? 0n : choiceP), depthP: d.depthP + depthP,
          queuedP: d.queuedP + (a.source === 4 ? -depthP : queuedP) };
        check(next.queuedP >= next.spentP + next.tipsP);
        v = { ...v, itemsDepth: { ...v.itemsDepth, [key]: next } };
      } else if (e.name === 'RewardTBurned') v = { ...v, burnedT: v.burnedT + raw(a.amountT) };
    } else if (e.source === 'holderLedger' && spec && typeof a.batchId === 'bigint' && holderBatchInTV21(spec, a.batchId)) {
      const id = String(a.batchId); let b = v.batches[id];
      if (e.name === 'BatchSettled') {
        check(raw(a.holderP) + raw(a.residueP) === raw(a.fundingP));
        // Each T settlement reports one immutable purchased tranche of the original batch.
        b = { fundingT: (b?.fundingT ?? 0n) + raw(a.fundingP), holderT: (b?.holderT ?? 0n) + raw(a.holderP),
          residueT: (b?.residueT ?? 0n) + raw(a.residueP), paidT: b?.paidT ?? 0n, flushedT: b?.flushedT ?? 0n };
      } else if (e.name === 'HolderPaid') {
        check(!!b && a.tipP === 0n);
        if (b) { b = { ...b, paidT: b.paidT + raw(a.grossP) }; v = { ...v, holdersPaidT: v.holdersPaidT + raw(a.grossP) }; }
      } else if (e.name === 'ResidueFlushed') {
        check(!!b);
        if (b) { b = { ...b, flushedT: b.flushedT + raw(a.amountP) }; v = { ...v, holderResidueT: v.holderResidueT + raw(a.amountP) }; }
      }
      if (b) { check(b.paidT <= b.holderT && b.flushedT <= b.residueT); v = { ...v, batches: { ...v.batches, [id]: b } }; }
    } else if (e.source === 'itemLedger' && e.name === 'ItemPaidT') {
      const amount = raw(a.amountT), id = String(a.id);
      v = { ...v, itemsPaidT: v.itemsPaidT + amount, paidByItemT: { ...v.paidByItemT, [id]: (v.paidByItemT[id] ?? 0n) + amount } };
    } else if (e.source === 'itemLedger' && e.name === 'ResidueTFlushed') v = { ...v, itemResidueT: v.itemResidueT + raw(a.amountT) };
  }
  // A burn event precedes its RewardsBought in the same transaction; check after the complete log batch.
  check(v.burnedT <= v.insideBurnT && v.holdersPaidT + v.holderResidueT <= v.holdersFundedT && v.itemsPaidT + v.itemResidueT <= v.itemsFundedT);
  check(Object.values(v.batches).reduce((sum, b) => sum + b.fundingT, 0n) <= v.holdersFundedT);
  for (const d of Object.values(v.itemsDepth ?? {})) check(d.choiceP === d.depthP + d.queuedP && d.queuedP >= d.spentP + d.tipsP);
  return v;
}
