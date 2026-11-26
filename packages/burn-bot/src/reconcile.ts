import { requireThat, uint } from './schema';

export interface AssetReconciliation {
  opening: bigint; receipts: bigint; swapOutputs: bigint; consumedInputs: bigint; returns: bigint;
  funds: bigint; burns: bigint; transfers: bigint; unrelatedIn: bigint; unrelatedOut: bigint;
  closing: bigint; reserved: bigint; liabilities: bigint;
}
/** Confirmed effects only; executor funding and subsequent aggregate FIT burns use separate asset rows. */
export function reconcileAsset(a: AssetReconciliation): bigint {
  for (const value of Object.values(a)) uint.parse(value);
  const expected = a.opening + a.receipts + a.swapOutputs + a.unrelatedIn
    - a.consumedInputs - a.returns - a.funds - a.burns - a.transfers - a.unrelatedOut;
  requireThat(expected >= 0n && expected === a.closing, 'asset conservation mismatch');
  // Reservations may already be part of a liability, so never add the two and double count it.
  requireThat(a.reserved <= a.closing && a.liabilities <= a.closing, 'unbacked reservation/liability');
  return expected;
}
