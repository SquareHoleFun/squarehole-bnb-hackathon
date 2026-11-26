/**
 * M2-52 JSON boundary. Flow history is never treated as a wallet credit or a spendable budget.
 * F127: v2 payouts are claim-only with no tip, so a published payment with a nonzero tip is refused.
 */
import type { M2MoneyV2 } from '../../../../../../packages/indexer/src/core/v2/m2-reads-v2';
import type { M2ViewV2 } from '../../../../../../packages/indexer/src/core/v2/m2-views-v2';
import { address, hash, object, raw } from './indexer-v2';
export interface M2Snapshot { readonly history: M2ViewV2 | null; readonly money: M2MoneyV2 | null }
const bool = (v: unknown): boolean => { if (typeof v !== 'boolean') throw new Error('Invalid M2 flag'); return v; };
const count = (v: unknown, max = 10000): number => { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > max) throw new Error('Invalid M2 count'); return v; };
const optional = (v: unknown) => v === null ? null : raw(v);
const entries = <T>(v: unknown, decode: (value: Record<string, unknown>) => T): Record<string, T> => Object.fromEntries(Object.entries(object(v)).map(([key, value]) => [key, decode(object(value))]));
export function parseM2(historyInput: unknown, moneyInput: unknown, blockHash: string): M2Snapshot {
  let history: M2ViewV2 | null = null; let money: M2MoneyV2 | null = null;
  if (historyInput != null) {
    const h = object(historyInput); const s = h.shop === null ? null : object(h.shop); const starter = h.starter === null ? null : object(h.starter);
    const batches = entries(h.batches, b => ({ fundingP: optional(b.fundingP), complete: bool(b.complete), holderP: optional(b.holderP), residueP: optional(b.residueP), paidP: raw(b.paidP), tipsP: raw(b.tipsP), flushedP: raw(b.flushedP),
      payments: entries(b.payments, p => ({ to: address(p.to), grossP: raw(p.grossP), tipP: raw(p.tipP), receivedP: raw(p.receivedP) })) }));
    for (const [id, b] of Object.entries(batches)) {
      if (raw(id) === 0n || b.tipsP !== 0n || (b.complete && (b.fundingP === null || b.holderP === null || b.residueP === null || b.holderP + b.residueP !== b.fundingP || b.paidP > b.holderP || b.flushedP > b.residueP))) throw new Error('Invalid M2 funding');
      for (const [holder, p] of Object.entries(b.payments)) { address(holder); if (p.tipP !== 0n || p.receivedP !== p.grossP) throw new Error('Invalid M2 payment'); }
    }
    // v2.1 step 7: `feesT`, the T fees bought into the shop (FeesFunded's total), absent in snapshots from before it.
    history = { failed: bool(h.failed), batches, shop: s ? { ...(s.feesT === undefined ? {} : { feesT: raw(s.feesT) }), seedFundedT: raw(s.seedFundedT), givenT: raw(s.givenT), pickedT: raw(s.pickedT), burnedT: raw(s.burnedT), failed: bool(s.failed), openedAt: optional(s.openedAt), curator: address(s.curator), pendingCurator: s.pendingCurator === null ? null : address(s.pendingCurator),
      collections: entries(s.collections, c => ({ tier: count(c.tier, 3), activeAt: raw(c.activeAt) })), starters: entries(s.starters, i => ({ collection: address(i.collection), id: raw(i.id), returned: bool(i.returned) })) } : null,
      starter: starter ? { count: count(starter.count), setHash: hash(starter.setHash), loaded: count(starter.loaded), remainingHash: hash(starter.remainingHash), notified: bool(starter.notified) } : null };
  }
  if (moneyInput != null) {
    const m = object(moneyInput); const s = m.shop === null ? null : object(m.shop); const p = m.starter === null ? null : object(m.starter);
    if (hash(m.hash).toLowerCase() !== blockHash.toLowerCase()) throw new Error('M2 money from a different block');
    money = { hash: hash(m.hash), holderBalanceP: optional(m.holderBalanceP), shop: s ? { budgetT: raw(s.budgetT), failedT: raw(s.failedT), seedReady: bool(s.seedReady), inside: raw(s.inside), collectionSize: raw(s.collectionSize), curator: address(s.curator), pendingCurator: address(s.pendingCurator), nextAdditionAt: raw(s.nextAdditionAt) } : null,
      starter: p ? { loaded: count(p.loaded), remainingHash: hash(p.remainingHash), notified: bool(p.notified) } : null };
    if (history?.starter && money.starter && money.starter.loaded > history.starter.count) throw new Error('Invalid M2 loading progress');
  }
  return { history, money };
}
