/** Shop pending intervals resolve into the original sellers batches, never newly invented holder units. */
import type { Address } from 'viem';
import type { CoreEventV2 } from './events-v2';
interface Point { readonly p: bigint; readonly refund: bigint }
interface Batch { readonly start: bigint; readonly end: bigint; readonly closed: boolean }
export interface ShopFeeProjectionV21 {
  readonly fundedP: bigint; readonly consumedP: bigint; readonly refundedP: bigint;
  readonly spentP: bigint; readonly boughtT: bigint;
  readonly points: readonly Point[]; readonly batches: Readonly<Record<string, Batch>>;
}
export function projectShopFeesV21(events: readonly CoreEventV2[], boxId: bigint, receiver: Address, previous?: ShopFeeProjectionV21) {
  let state = previous ?? { fundedP: 0n, consumedP: 0n, refundedP: 0n, spentP: 0n, boughtT: 0n, points: [], batches: {} };
  const projected: CoreEventV2[] = [];
  const raw = (v: unknown) => { if (typeof v !== 'bigint' || v < 0n) throw new Error('shop raw amount'); return v; };
  const check = (ok: boolean) => { if (!ok) throw new Error('shop fee conservation'); };
  for (const e of events) {
    projected.push(e);
    if (e.boxId !== boxId || e.source !== 'receiver' || e.address.toLowerCase() !== receiver.toLowerCase()) continue;
    const a = e.args;
    if (e.name === 'ShopBatchQueued') {
      const start = raw(a.startP), end = raw(a.endP), id = raw(a.batchId);
      check(id > 0n && id % 2n === 0n && start === state.fundedP && end > start && !state.batches[String(id)]);
      state = { ...state, fundedP: end, batches: { ...state.batches, [String(id)]: { start, end, closed: false } } };
    } else if (e.name === 'ShopPendingConsumed') {
      const p = raw(a.consumedP), refund = raw(a.refundedP);
      check(p > state.consumedP && p <= state.fundedP && refund >= state.refundedP && refund - state.refundedP <= p - state.consumedP);
      state = { ...state, consumedP: p, refundedP: refund, points: [...state.points, { p, refund }] };
      const at = (value: bigint): bigint => {
        if (value === 0n) return 0n;
        let start: Point = { p: 0n, refund: 0n };
        for (const end of state.points) {
          if (end.p >= value) return start.refund + (value - start.p) * (end.refund - start.refund) / (end.p - start.p);
          start = end;
        }
        throw new Error('unresolved shop prefix');
      };
      const batches = { ...state.batches };
      for (const [id, batch] of Object.entries(batches)) if (!batch.closed && batch.end <= p) {
        batches[id] = { ...batch, closed: true };
        projected.push({ ...e, name: 'HolderBatchFunded', args: { batchId: BigInt(id), netP: at(batch.end) - at(batch.start) } });
      }
      state = { ...state, batches };
    } else if (e.name === 'ShopFunded') {
      check(a.sellers === true);
      state = { ...state, spentP: state.spentP + raw(a.spentP), boughtT: state.boughtT + raw(a.boughtT) };
    }
  }
  check(state.spentP + state.refundedP <= state.consumedP);
  return { state, events: projected };
}
