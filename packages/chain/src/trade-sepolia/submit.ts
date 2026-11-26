import type { TxHash } from '@squarehole/domain';
import { internalSendChecked } from '../write/executor';
import { createChainReader } from '../write/rpc';
import { assertTradeWriteSepolia, type TradeSubmitOptions } from './guard';
import { requireTrade, type TradePlan } from './trade';

const submittedTrades = new WeakSet<TradePlan>();

/** F156: snapshot the call, verify the prepared trade authority, then use the sole wallet sender. */
export async function submitTradeWriteSepolia(options: TradeSubmitOptions): Promise<TxHash> {
  const { wallet, rpc, chainId, plan, from, gasLimit } = options;
  const call = await assertTradeWriteSepolia({ wallet, rpc, chainId, plan, from, gasLimit, call: { ...options.call } });
  if (call === plan.call) {
    requireTrade(!submittedTrades.has(plan), 'trade_already_submitted');
    submittedTrades.add(plan); // Before any wallet await; failed/rejected sends also require a fresh plan.
  }
  // SH-SEND-FEES: the fee and the funds check read the build's RPC, the one the guard just checked.
  return internalSendChecked(wallet, plan.from, plan.chainId, call, call.value, gasLimit, { feeReader: createChainReader(rpc) });
}

// Coin actions share the existing sole sender and never widen ordinary write authority.
import { assertCoinWriteSepolia, type CoinSubmitOptions } from './coin-guard';
import type { CoinPlan } from './coins';
const submittedCoins = new WeakSet<CoinPlan>();
export async function submitCoinWriteSepolia(options: CoinSubmitOptions): Promise<TxHash> {
  const { wallet, rpc, chainId, plan, from, gasLimit } = options;
  const call = await assertCoinWriteSepolia({ wallet, rpc, chainId, plan, from, gasLimit, call: { ...options.call } });
  if (call === plan.call) {
    requireTrade(!submittedCoins.has(plan), 'coin_already_submitted');
    submittedCoins.add(plan);
  }
  // SH-SEND-FEES: the fee and the funds check read the build's RPC, the one the guard just checked.
  return internalSendChecked(wallet, plan.from, plan.chainId, call, call.value, gasLimit, { feeReader: createChainReader(rpc) });
}
