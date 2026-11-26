import type { Address } from 'viem';
import { EIP7825_TX_GAS_CAP } from '../write/chains';
import type { Eip1193Request } from '../write/eip1193';
import { createChainReader } from '../write/rpc';
import { assertPreparedPlan, checkHelperCode, isTradeChain, readTradeContract, requireTrade, sameAddress, SEPOLIA_TRADE_DEPLOYMENT, type TradeCall, type TradePlan } from './trade';

export interface TradeSubmitOptions {
  readonly wallet: Eip1193Request;
  readonly rpc: Eip1193Request;
  /** Build target chain, independent of the wallet and supplied plan. */
  readonly chainId: number;
  readonly plan: TradePlan;
  readonly call: TradeCall;
  readonly from: Address;
  readonly gasLimit: bigint;
}
export const sameCall = (a: TradeCall, b: TradeCall): boolean => typeof a.to === 'string' && typeof a.data === 'string'
  && typeof a.value === 'bigint' && a.to === b.to && a.data === b.data && a.value === b.value;

/** Checks the whole canonical calldata, not merely a selector. No alternate tuple, recipient or trailing data. */
export async function assertTradeWriteSepolia(o: TradeSubmitOptions): Promise<TradeCall> {
  const { plan, call, from, gasLimit, rpc, chainId } = o;
  requireTrade(isTradeChain(chainId) && isTradeChain(plan.chainId), 'chain_not_allowed');
  requireTrade(plan.chainId === plan.deployment.chainId, 'deployment_chain_mismatch');
  requireTrade(plan.chainId !== 11155111 || (plan.deployment.poolSwapTest === SEPOLIA_TRADE_DEPLOYMENT.poolSwapTest
    && plan.deployment.poolManager === SEPOLIA_TRADE_DEPLOYMENT.poolManager
    && plan.deployment.poolSwapTestCodeHash === SEPOLIA_TRADE_DEPLOYMENT.poolSwapTestCodeHash), 'deployment_not_pinned');
  assertPreparedPlan(plan);
  requireTrade(chainId === plan.chainId, 'plan_chain_mismatch');
  requireTrade(typeof from === 'string' && sameAddress(from, plan.from), 'account_mismatch');
  const isTrade = plan.call !== null && sameCall(call, plan.call);
  const isReset = plan.revoke !== null && sameCall(call, plan.revoke);
  const canonical = isTrade ? plan.call : isReset ? plan.revoke : plan.approvals.find(a => sameCall(call, a));
  requireTrade(canonical, 'call_not_allowed');
  requireTrade(typeof gasLimit === 'bigint' && gasLimit > 0n && gasLimit <= EIP7825_TX_GAS_CAP
    && (!isTrade || gasLimit >= plan.gasLimit), 'invalid_gas_limit');
  const reader = createChainReader(rpc);
  requireTrade(await reader.chainId() === plan.chainId, 'rpc_chain_mismatch');
  // A helper approval is authority to pull coins too: verify runtime and manager for it as well as for swaps.
  if (!(plan.phase === 2 && plan.side === 'buy')) await checkHelperCode(rpc, plan.deployment, 'latest');
  if (!isReset) {
    const [latest, original] = await Promise.all([reader.getBlock('latest'), reader.getBlock(plan.blockNumber)]);
    requireTrade(latest && original && original.hash === plan.blockHash && latest.number >= plan.blockNumber
      && latest.timestamp >= plan.blockTimestamp && latest.timestamp < plan.deadline, 'stale_read');
    requireTrade(await readTradeContract(rpc, plan.hook, 'phase', 'latest') === plan.phase, 'phase_changed');
  }
  return canonical;
}
