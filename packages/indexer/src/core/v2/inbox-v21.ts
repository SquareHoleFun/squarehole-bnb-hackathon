import type { Address, Hex } from 'viem';
import type { LogRef } from '../../events';
import type { CoreEventV2 } from './events-v2';

export interface InboxRefreshV21 { readonly balance: bigint; readonly oldestUnsoldAt: bigint; readonly at: bigint; readonly ref: LogRef }
export interface InboxSaleV21 {
  readonly buyToken: Address; readonly sellAmount: bigint; readonly buyAmount: bigint;
  readonly feeAmount: bigint; readonly orderUid: Hex; readonly at: bigint; readonly ref: LogRef;
}
export interface InboxHistoryV21 {
  readonly refreshes: Readonly<Record<string, InboxRefreshV21>>;
  readonly sales: Readonly<Record<string, InboxSaleV21>>;
  readonly flushed: bigint;
  readonly unwrapped: bigint;
}
/** Only explicit Trade receipts prove sales. A balance or clock change alone proves neither. */
export function inboxHistoryV21(events: readonly CoreEventV2[], boxId: bigint, at: bigint, previous?: InboxHistoryV21): InboxHistoryV21 {
  let { refreshes, sales, flushed, unwrapped } = previous ?? { refreshes: {}, sales: {}, flushed: 0n, unwrapped: 0n };
  for (const e of events) {
    if (e.boxId !== boxId) continue;
    const a = e.args;
    if (e.source === 'royaltyRouter' && e.name === 'OrderRefreshed') {
      refreshes = { ...refreshes, [String(a.id).toLowerCase()]: { balance: a.balance as bigint, oldestUnsoldAt: a.oldestUnsoldAt as bigint, at, ref: e.ref } };
    } else if (e.source === 'royaltyRouter' && e.name === 'Flushed') {
      flushed += a.ethSent as bigint; unwrapped += a.wethUnwrapped as bigint;
    } else if (e.source === 'cowSettlement' && e.name === 'Trade') {
      sales = { ...sales, [String(a.sellToken).toLowerCase()]: { buyToken: a.buyToken as Address, sellAmount: a.sellAmount as bigint,
        buyAmount: a.buyAmount as bigint, feeAmount: a.feeAmount as bigint, orderUid: a.orderUid as Hex, at, ref: e.ref } };
    }
  }
  return { refreshes, sales, flushed, unwrapped };
}
