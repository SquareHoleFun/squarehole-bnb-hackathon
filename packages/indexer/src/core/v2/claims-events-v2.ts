import type { Address, Hex } from 'viem';
import type { CoreEventV2 } from './events-v2';

/** Recent means the last 7,200 canonical blocks, inclusive of the read block. */
export const CLAIMS_RECENT_BLOCKS = 7_200n;
export interface ClaimPaymentV2 {
  readonly kind: 'holder' | 'item' | 'creator' | 'failure' | 'no_buyer';
  readonly wallet: Address; readonly to: Address; readonly roleAddress: Address;
  readonly asset: Address | null;
  readonly amountP: bigint; readonly grossP: bigint; readonly tipP: bigint;
  readonly batchId: bigint | null; readonly itemId: bigint | null; readonly coinsT: bigint | null;
  readonly block: bigint; readonly hash: Hex; readonly txHash: Hex; readonly logIndex: number;
}
const lower = (value: unknown) => String(value).toLowerCase() as Address;

/** Copy-on-write: canonical parent snapshots own receipts, so ordinary rollback/rebuild removes orphans. */
export function claimPaymentsV2(previous: readonly ClaimPaymentV2[], events: readonly CoreEventV2[], block: bigint, boxId: bigint): readonly ClaimPaymentV2[] {
  const payments = new Map(previous.filter(p => p.block <= block && p.block > block - CLAIMS_RECENT_BLOCKS).map(p => [`${p.hash}:${p.logIndex}`, p]));
  for (const e of events) {
    if (e.boxId !== boxId) continue;
    const key = `${e.source}.${e.name}`; const a = e.args;
    const kind = key === 'holderLedger.HolderPaid' ? 'holder' : key === 'itemLedger.ItemPaid' ? 'item'
      : key === 'receiver.CreatorClaimed' ? 'creator' : key === 'coordinator.Claimed' ? a.t === 0n ? 'no_buyer' : 'failure' : null;
    if (!kind) continue;
    const grossP = (a.grossP ?? a.amount ?? a.p) as bigint; const tipP = (a.tipP ?? 0n) as bigint;
    if (grossP < 0n || tipP !== 0n) throw new Error('invalid claim payment amounts');
    // An empty creator claim pays nothing; a zero-P failure hand-in still consumes T and is a real claim.
    if (grossP === 0n && kind !== 'failure' && kind !== 'no_buyer') continue;
    payments.set(`${e.ref.blockHash}:${e.ref.logIndex}`, {
      kind, wallet: lower(a.holder ?? a.owner ?? a.payee), to: lower(a.to), roleAddress: lower(e.address),
      asset: kind === 'creator' ? lower(a.token) : null, amountP: grossP - tipP, grossP, tipP,
      batchId: kind === 'holder' ? a.batchId as bigint : null, itemId: kind === 'item' ? a.id as bigint : null,
      coinsT: kind === 'failure' || kind === 'no_buyer' ? a.t as bigint : null,
      block: e.ref.blockNumber, hash: e.ref.blockHash, txHash: e.ref.txHash, logIndex: e.ref.logIndex,
    });
  }
  return [...payments.values()];
}
