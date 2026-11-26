import type { Address, Hex } from 'viem';
import { shopConfigV2, starterCommitmentV2, type BoxSpecV2 } from './chain-v2';
import type { CoreEventV2 } from './events-v2';

export interface HolderBatchViewV2 {
  readonly fundingP: bigint | null;
  readonly complete: boolean;
  readonly holderP: bigint | null;
  readonly residueP: bigint | null;
  readonly paidP: bigint;
  readonly tipsP: bigint;
  readonly flushedP: bigint;
  /** Confirmed payments only. Credits must be read from claimable at a block hash. */
  readonly payments: Readonly<Record<string, { readonly to: string; readonly grossP: bigint; readonly tipP: bigint; readonly receivedP: bigint }>>;
}
export interface ShopViewV2 {
  /** Absent only in snapshots written before v2.1 shop fees. */
  readonly feesT?: bigint;
  readonly seedFundedT: bigint; readonly givenT: bigint; readonly pickedT: bigint; readonly burnedT: bigint;
  readonly failed: boolean; readonly openedAt: bigint | null;
  readonly curator: string; readonly pendingCurator: string | null;
  readonly collections: Readonly<Record<string, { readonly tier: number; readonly activeAt: bigint }>>;
  readonly starters: Readonly<Record<string, { readonly collection: string; readonly id: bigint; readonly returned: boolean }>>;
}
export interface M2ViewV2 {
  readonly failed: boolean;
  readonly batches: Readonly<Record<string, HolderBatchViewV2>>;
  /** Flow history, not a spendable budget. Silent changes are read from the shop. */
  readonly shop: ShopViewV2 | null;
  readonly starter: { readonly count: number; readonly setHash: Hex; readonly loaded: number; readonly remainingHash: Hex; readonly notified: boolean } | null;
}
const emptyBatch = (): HolderBatchViewV2 => ({ fundingP: null, complete: false, holderP: null, residueP: null, paidP: 0n, tipsP: 0n, flushedP: 0n, payments: {} });
const lower = (a: unknown) => (a as Address).toLowerCase();
const ensure = (ok: boolean, why: string) => { if (!ok) throw new Error(`M2 conservation: ${why}`); };

/** Copy-on-write snapshots: replay starts at the canonical parent; never mutate an orphan's parent. */
export function m2ViewV2(events: readonly CoreEventV2[], boxId: bigint, spec: BoxSpecV2, previous?: M2ViewV2): M2ViewV2 {
  const config = spec.boxType === 4 ? shopConfigV2(spec.contentsParams) : null;
  const commitment = spec.boxType === 4 ? starterCommitmentV2(spec) : null;
  let failed = previous?.failed ?? false;
  const batches = { ...previous?.batches };
  let shop = previous?.shop ?? (config ? { feesT: 0n, seedFundedT: 0n, givenT: 0n, pickedT: 0n, burnedT: 0n, failed: false, openedAt: null,
    curator: lower(config.curator), pendingCurator: null, collections: {}, starters: {} } : null);
  let starter = previous?.starter ?? (commitment ? { ...commitment, loaded: 0, remainingHash: commitment.setHash, notified: false } : null);
  for (const e of events) {
    if (e.boxId !== boxId) continue;
    const a = e.args; const key = `${e.source}.${e.name}`;
    if (key === 'coordinator.BoxFailed') failed = true;
    if (key === 'receiver.HolderBatchFunded' || e.source === 'holderLedger') {
      const id = String(a.batchId); let b = batches[id] ?? emptyBatch();
      if (e.name === 'HolderBatchFunded') {
        ensure(b.fundingP === null, 'batch funded twice'); b = { ...b, fundingP: a.netP as bigint };
      } else if (e.name === 'BatchSettled') {
        const holderP = a.holderP as bigint; const residueP = a.residueP as bigint;
        ensure(!b.complete && b.fundingP === a.fundingP && holderP + residueP === b.fundingP, 'settlement differs from net funding');
        b = { ...b, complete: true, holderP, residueP };
      } else if (e.name === 'HolderPaid') {
        const grossP = a.grossP as bigint; const tipP = a.tipP as bigint; const holder = lower(a.holder);
        ensure(tipP === 0n, 'F127 holder claim tip must be zero');
        ensure(b.complete && !b.payments[holder] && b.paidP + grossP <= (b.holderP ?? 0n), 'claim exceeds settled holder funding');
        b = { ...b, paidP: b.paidP + grossP, tipsP: b.tipsP + tipP, payments: { ...b.payments, [holder]: { to: lower(a.to), grossP, tipP, receivedP: grossP - tipP } } };
      } else if (e.name === 'ResidueFlushed') {
        const amount = a.amountP as bigint;
        ensure(b.complete && b.flushedP + amount <= (b.residueP ?? 0n), 'flush exceeds proved residue');
        b = { ...b, flushedP: b.flushedP + amount };
      }
      batches[id] = b;
    }
    if (starter && key === 'starterSetLoader.StarterProgress') {
      const loaded = a.loaded as number;
      ensure(loaded >= starter.loaded && loaded <= starter.count, 'invalid starter progress');
      starter = { ...starter, loaded, remainingHash: a.remainingHash as Hex };
    }
    if (starter && key === 'coordinator.StarterSetLoaded') starter = { ...starter, notified: true };
    if (!shop || e.source !== 'vault') continue;
    if (e.name === 'SeedFunded') shop = { ...shop, seedFundedT: shop.seedFundedT + (a.amountT as bigint) };
    else if (e.name === 'FeesFunded') {
      ensure(a.totalT === (shop.feesT ?? 0n) + (a.amountT as bigint), 'shop fee total');
      shop = { ...shop, feesT: a.totalT as bigint };
    }
    else if (e.name === 'Given') shop = { ...shop, givenT: shop.givenT + (a.amountT as bigint) };
    else if (e.name === 'Picked') shop = { ...shop, pickedT: shop.pickedT + (a.amountT as bigint) };
    else if (e.name === 'FailedTBurned') shop = { ...shop, burnedT: shop.burnedT + (a.amount as bigint) };
    else if (e.name === 'FailureEntered') shop = { ...shop, failed: true };
    else if (e.name === 'GateOpened') shop = { ...shop, openedAt: a.timestamp as bigint };
    else if (e.name === 'CuratorProposed') shop = { ...shop, pendingCurator: lower(a.next) };
    else if (e.name === 'CuratorChanged') shop = { ...shop, curator: lower(a.curator), pendingCurator: null };
    else if (e.name === 'CollectionAdded') shop = { ...shop, collections: { ...shop.collections, [lower(a.collection)]: { tier: a.tier as number, activeAt: a.activeAt as bigint } } };
    else if (e.name === 'StarterLoaded') shop = { ...shop, starters: { ...shop.starters, [String(a.index)]: { collection: lower(a.collection), id: a.id as bigint, returned: false } } };
    else if (e.name === 'StarterReturned') {
      const item = shop.starters[String(a.index)];
      ensure(!!item && item.collection === lower(a.collection) && item.id === a.id && !item.returned, 'starter return does not match custody');
      if (item) shop = { ...shop, starters: { ...shop.starters, [String(a.index)]: { ...item, returned: true } } };
    }
  }
  return { failed, batches, shop, starter };
}
