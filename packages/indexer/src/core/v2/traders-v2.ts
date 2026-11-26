import type { Address } from 'viem';

const lower = (a: string): string => a.toLowerCase();
const ZERO = /^0x0{40}$/;
export interface TraderTransferV2 { readonly txHash: string; readonly from: string; readonly to: string; readonly amount: bigint }

/** Whole-transaction T movement, including transfers after the swap and router hand-offs. */
export function transactionTradersV2(transfers: readonly TraderTransferV2[], contracts: readonly string[]) {
  const netByTx = new Map<string, Map<string, bigint>>();
  for (const e of transfers) {
    const tx = lower(e.txHash);
    const net = netByTx.get(tx) ?? new Map<string, bigint>();
    netByTx.set(tx, net);
    const from = lower(e.from); const to = lower(e.to); const amount = e.amount;
    net.set(from, (net.get(from) ?? 0n) - amount);
    net.set(to, (net.get(to) ?? 0n) + amount);
  }
  const excluded = new Set(contracts.map(lower));
  const traders = new Map<string, { buy: Address | null; sell: Address | null }>();
  for (const [tx, net] of netByTx) {
    let buy: Address | null = null; let sell: Address | null = null;
    let gain = 0n; let loss = 0n;
    for (const [account, change] of net) {
      if (ZERO.test(account) || excluded.has(account)) continue;
      // Equal movements resolve by address, independent of RPC log order.
      if (change > 0n && (change > gain || (change === gain && buy !== null && account < buy))) { buy = account as Address; gain = change; }
      if (change < 0n && (change < loss || (change === loss && sell !== null && account < sell))) { sell = account as Address; loss = change; }
    }
    traders.set(tx, { buy, sell });
  }
  return traders;
}
