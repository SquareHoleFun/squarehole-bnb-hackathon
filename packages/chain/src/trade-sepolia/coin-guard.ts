import type { Address } from 'viem';
import { EIP7825_TX_GAS_CAP } from '../write/chains';
import type { Eip1193Request } from '../write/eip1193';
import { createChainReader } from '../write/rpc';
import { sameCall } from './guard';
import { SEPOLIA_COIN_DEPLOYMENT } from './coin-deployment';
import { assertPreparedCoinPlan, checkCoinCode, readFaucet, requireFaucet, type CoinPlan } from './coins';
import { checkHelperCode, isTradeChain, readTradeContract, requireTrade, sameAddress, type TradeCall } from './trade';
export interface CoinSubmitOptions {
  readonly wallet: Eip1193Request;
  readonly rpc: Eip1193Request;
  readonly chainId: number;
  readonly plan: CoinPlan;
  readonly call: TradeCall;
  readonly from: Address;
  readonly gasLimit: bigint;
}
export async function assertCoinWriteSepolia(o: CoinSubmitOptions): Promise<TradeCall> {
  const { plan, call, rpc, gasLimit, chainId, from } = o;
  requireTrade(isTradeChain(chainId) && isTradeChain(plan.chainId), 'chain_not_allowed');
  requireTrade(plan.chainId === plan.deployment.chainId, 'deployment_chain_mismatch');
  requireTrade(plan.chainId !== 11155111 || plan.deployment === SEPOLIA_COIN_DEPLOYMENT, 'deployment_not_pinned');
  assertPreparedCoinPlan(plan);
  requireTrade(chainId === plan.chainId, 'plan_chain_mismatch');
  requireTrade(typeof from === 'string' && sameAddress(from, plan.from), 'account_mismatch');
  const isAction = plan.call !== null && sameCall(call, plan.call);
  const isReset = plan.revoke !== null && sameCall(call, plan.revoke);
  const canonical = isAction ? plan.call : isReset ? plan.revoke : plan.approvals.find(a => sameCall(call, a));
  requireTrade(canonical, 'call_not_allowed');
  requireTrade(typeof gasLimit === 'bigint' && gasLimit > 0n && gasLimit <= EIP7825_TX_GAS_CAP && (!isAction || gasLimit >= plan.gasLimit), 'invalid_gas_limit');
  const reader = createChainReader(rpc);
  requireTrade(await reader.chainId() === plan.chainId, 'rpc_chain_mismatch');
  const latest = await reader.getBlock('latest');
  requireTrade(latest, 'block_unavailable');
  if (plan.kind === 'pair') {
    await checkHelperCode(rpc, plan.deployment, latest.number);
    await checkCoinCode(rpc, plan.deployment.pairHelper, latest.number);
    requireTrade(sameAddress(await readTradeContract(rpc, plan.deployment.pairHelper.address, 'manager', latest.number), plan.deployment.poolManager), 'helper_manager_mismatch');
  }
  if (!isReset) {
    const original = await reader.getBlock(plan.blockNumber);
    requireTrade(original && original.hash === plan.blockHash && latest.number >= plan.blockNumber
      && latest.timestamp >= plan.blockTimestamp && latest.timestamp < plan.deadline, 'stale_read');
    await checkCoinCode(rpc, plan.deployment.teth, latest.number);
    if (plan.kind === 'faucet') requireFaucet(await readFaucet(rpc, plan.deployment.teth.address, plan.from, latest.number), latest.timestamp);
  }
  return canonical;
}
