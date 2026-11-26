/**
 * SH-TA-33: a JSON-RPC double for the items panel's view calls (the vault, the collection and the box token), so the real
 * `vaultItemsIO` and its viem clients run in unit tests. Each read is answered by name; an answer may throw to fail that
 * one read as a node would (an RPC error, or a revert with its ABI-encoded data). No chain, key or wallet.
 */
import { decodeFunctionData, encodeFunctionResult, erc20Abi, toFunctionSelector, type Abi, type AbiFunction, type Hex } from 'viem';
import { boxCollectionAbi } from '@squarehole/chain/abi';
import { vaultV2Abi } from '../../../../../../../packages/chain/src/core/v2';
import type { RpcCall } from './m2-rpc';
import { rpcFetch } from './rpc-fetch';
import { sendFeeRpcAnswer } from '@squarehole/chain/write/test-support';

const functions = ([...vaultV2Abi, ...boxCollectionAbi, ...erc20Abi] as Abi).filter((item): item is AbiFunction => item.type === 'function');

export type VaultRpcAnswers = Readonly<Record<string, (args: readonly unknown[]) => unknown>>;

/** A `fetch` answering the panel's reads from `answers`, and the reads it was asked, in order (name and arguments). */
export function vaultRpcFetch(answers: VaultRpcAnswers) {
  const asked: { readonly name: string; readonly args: readonly unknown[] }[] = [];
  const fetch = rpcFetch(async ({ method, params }: RpcCall) => {
    if (method === 'eth_chainId') return '0x7a69';
    // SH-235: the chain's head, which the coin reads are named by (vault-items.ts `coins`).
    if (method === 'eth_blockNumber') return '0x64';
    if (method === 'eth_getTransactionCount') return '0x0';
    // SH-SEND-FEES: the sender's fee and funds reads.
    const feeAnswer = sendFeeRpcAnswer(method);
    if (feeAnswer !== undefined) return feeAnswer;
    if (method !== 'eth_call') throw new Error(`Unexpected RPC: ${method}`);
    const data = (params?.[0] as { data: Hex }).data;
    const item = functions.find((f) => toFunctionSelector(f) === data.slice(0, 10));
    if (!item) throw new Error(`Unexpected call: ${data.slice(0, 10)}`);
    const { args = [] } = decodeFunctionData({ abi: [item], data });
    asked.push({ name: item.name, args });
    const answer = answers[item.name];
    if (!answer) throw new Error(`Unexpected read: ${item.name}`);
    return encodeFunctionResult({ abi: [item], functionName: item.name, result: answer(args) as never });
  });
  return { fetch, asked };
}

/** A node's answer to a call that reverted, with the revert's ABI-encoded data when it has any. */
export const revertWith = (data?: Hex) => Object.assign(new Error('execution reverted'), { code: 3, ...(data ? { data } : {}) });
/** A node that could not answer (its upstream timed out): an RPC error, not a revert. */
export const nodeUnavailable = () => Object.assign(new Error('upstream request timed out'), { code: -32603 });
