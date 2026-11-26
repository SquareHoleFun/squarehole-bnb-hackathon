import type { Address } from 'viem';
import type { ActivityPage } from '../core/core-gateway';
import { transactionTradersV2, type TraderTransferV2 } from '../core/v2/traders-v2';

/** Only legacy null traders need their transaction's transfers read; existing TaxedBuy attribution wins. */
export function missingTraders(items: ActivityPage['items']) {
  return items.filter(item => item.kind === 'trade' && item.trader === null);
}

export function withTradersV2(items: ActivityPage['items'], transfers: readonly TraderTransferV2[], contracts: readonly string[]): ActivityPage['items'] {
  const traders = transactionTradersV2(transfers, contracts);
  return items.map(item => item.kind !== 'trade' ? item : { ...item,
    trader: item.trader ? item.trader.toLowerCase() as Address : traders.get(item.txHash.toLowerCase())?.[item.side] ?? null });
}
