/** Controlled RPC answers for M253 tests. No chain, private key or wallet balance is used. */
import { decodeFunctionData, encodeFunctionResult, erc20Abi, type Abi, type Hex } from 'viem';
import { coordinatorV2Abi, holderLedgerV2Abi, hookV2Abi, receiverV2Abi } from '../../../../../../../packages/chain/src/core/v2';
import { sendFeeRpcAnswer } from '@squarehole/chain/write/test-support';

export interface RpcCall { method: string; params?: readonly unknown[] }
export type BatchState = 'open' | 'awaiting_funding' | 'settling' | 'settled';
/** A mined, successful receipt for `hash` at `block` (what viem's waitForTransactionReceipt reads first). */
export function successReceipt(hash: Hex, block: bigint, to: Hex = `0x${'0'.repeat(40)}`) {
  const quantity = (n: bigint) => `0x${n.toString(16)}`;
  return { transactionHash: hash, blockHash: `0x${'b'.repeat(64)}`, blockNumber: quantity(block), transactionIndex: '0x0', from: `0x${'0'.repeat(40)}`, to,
    cumulativeGasUsed: '0x30d40', gasUsed: '0x30d40', effectiveGasPrice: '0x1', contractAddress: null, logs: [], logsBloom: `0x${'0'.repeat(512)}`, status: '0x1', type: '0x2' };
}
export interface M2RpcOptions {
  readonly state?: BatchState; readonly payout?: 'available' | 'paused' | 'offline'; readonly credit?: bigint; readonly receiptBlock?: bigint;
  /** The failure hand-in (F128): the wallet's T, the pot and coins still counted, and the quote for the coins. */
  readonly coinsT?: bigint; readonly pot?: bigint; readonly tLeft?: bigint; readonly quoteP?: bigint;
}
export function m2RpcFixture(options: M2RpcOptions = {}) {
  const state = options.state ?? 'settled'; const credit = options.credit ?? 60000001n;
  // T's allowance for the coordinator: a sent approval raises it (the test wallet sets `chain.allowanceT`).
  const chain = { allowanceT: 0n };
  const abi: Abi = [...hookV2Abi, ...receiverV2Abi, ...holderLedgerV2Abi, ...coordinatorV2Abi, ...erc20Abi];
  const calls: RpcCall[] = [];
  const request = async (call: RpcCall): Promise<unknown> => {
    calls.push(call);
    if (call.method === 'eth_chainId') return '0x7a69';
    if (call.method === 'eth_estimateGas') return '0x30d40';
    // A sent claim is mined at once, a few blocks after the published snapshot.
    if (call.method === 'eth_getTransactionReceipt') return successReceipt(call.params?.[0] as Hex, options.receiptBlock ?? 200n);
    // SH-SEND-FEES: the sender's fee and funds reads.
    const feeAnswer = sendFeeRpcAnswer(call.method);
    if (feeAnswer !== undefined) return feeAnswer;
    if (call.method !== 'eth_call') throw new Error(`Unexpected RPC: ${call.method}`);
    const tx = call.params?.[0] as { data: Hex };
    const { functionName } = decodeFunctionData({ abi, data: tx.data });
    if (functionName === 'claim' && options.payout === 'paused') throw Object.assign(new Error('execution reverted'), { code: 3 });
    if (functionName === 'claim' && options.payout === 'offline') throw Object.assign(new Error('unavailable'), { code: -32001 });
    const values: Record<string, unknown> = {
      tradeBatch: { tradeUnits: 100n, protocolUnits: 5n, netP: 150000000n, closed: state !== 'open' },
      holderBatchClosed: state === 'settling' || state === 'settled',
      holderBatchPaid: state === 'settling' || state === 'settled' ? 100000000n : 0n,
      batchState: [state === 'settled', 3n, 0n, state === 'settled' ? 20000000n : 0n],
      claimable: state === 'settled' ? credit : 0n, failed: true, claim: credit,
      balanceOf: options.coinsT ?? 0n, allowance: chain.allowanceT, approve: true, quoteClaim: options.quoteP ?? 0n, claimState: [options.pot ?? 0n, options.tLeft ?? 0n],
    };
    if (!(functionName in values)) throw new Error(`Unexpected read: ${functionName}`);
    return encodeFunctionResult({ abi, functionName, result: values[functionName] });
  };
  return { calls, request, chain };
}
