/**
 * SH-RC7-SITE-INBOX: controlled RPC answers for a box's income inbox and launch router, for the unit tests and the
 * browser spec. The inbox's views and its coins' allowances, the inbox's recorded `CoinState` words in storage, and
 * dry runs of `refreshOrder`, `observe`, `claimInKind` and the launch router's `sweep()`, each answering or reverting
 * with the contract's own error. No chain, key or wallet is used.
 */
import { decodeFunctionData, encodeErrorResult, encodeFunctionResult, erc20Abi, parseAbi, toHex, zeroAddress, type Abi, type Address, type Hex } from 'viem';
import { coordinatorV2Abi, inboxCoinSlotsV21, launchRouterV2Abi, royaltyRouterV2Abi } from '../../../../../../../packages/chain/src/core/v2';
import { successReceipt, type RpcCall } from './m2-rpc';
import { sendFeeRpcAnswer } from '@squarehole/chain/write/test-support';

/** The inbox's and the launch router's errors a dry run can end with. */
export const INBOX_ERRORS = parseAbi(['error NoOrder()', 'error WaitForSale()', 'error NotPayee()', 'error MissingPayee()', 'error NothingToFlush()',
  'error TokenNotTaken(address token)', 'error TransferRefused(address token)', 'error NothingToSweep()', 'error NotGraduated()']);
export type InboxErrorName = (typeof INBOX_ERRORS)[number]['name'];

export interface InboxRpcCoin {
  readonly lot: bigint; readonly held: bigint; readonly allowance?: bigint; readonly approved?: bigint; readonly hour?: bigint; readonly spent?: bigint;
  readonly registered?: boolean; readonly oldestUnsoldAt?: bigint;
  /** What `claimInKind(coin)` answers for the payee: its amount, or the inbox's error. */
  readonly inKind?: bigint | InboxErrorName;
  /** `refreshOrder(coin)` and `observe(coin)` revert with this error instead of answering (the chain changed since the read). */
  readonly refuse?: InboxErrorName;
}
export interface InboxRpcWorld {
  readonly router: Address; readonly coordinator: Address; readonly launchRouter: Address; readonly weth: Address; readonly relayer: Address;
  readonly payee: Address; readonly failed?: boolean; readonly now: bigint; readonly block?: bigint; readonly eth?: bigint;
  /** Keys are lowercase coin addresses. */
  readonly coins: Readonly<Record<string, InboxRpcCoin>>;
  /** What the launch router's `sweep()` answers: the amount, or its error. */
  readonly sweep?: bigint | InboxErrorName;
}
/** A revert as a node answers it: JSON-RPC code 3 with the error's ABI-encoded data. */
export class RevertError extends Error {
  readonly code = 3;
  readonly data: Hex;
  constructor(name: InboxErrorName, args: readonly unknown[] = []) { super('execution reverted'); this.data = encodeErrorResult({ abi: INBOX_ERRORS, errorName: name, args } as never); }
}
const revert = (name: InboxErrorName) => new RevertError(name, ['TokenNotTaken', 'TransferRefused'].includes(name) ? [zeroAddress] : []);
const same = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();

export function inboxRpcFixture(initial: InboxRpcWorld) {
  const state = { world: initial };
  const calls: RpcCall[] = [];
  const router: Abi = [...royaltyRouterV2Abi];
  const request = async (call: RpcCall): Promise<unknown> => {
    calls.push(call);
    const w = state.world;
    const block = w.block ?? 500n;
    if (call.method === 'eth_chainId') return '0x7a69';
    if (call.method === 'eth_blockNumber') return toHex(block);
    if (call.method === 'eth_getBlockByNumber') return { number: toHex(block), hash: `0x${'5'.repeat(64)}`, parentHash: `0x${'4'.repeat(64)}`, timestamp: toHex(w.now), transactions: [], gasLimit: '0x1c9c380', gasUsed: '0x0', baseFeePerGas: '0x1' };
    if (call.method === 'eth_estimateGas') return '0x30d40';
    if (call.method === 'eth_getTransactionReceipt') return successReceipt(call.params?.[0] as Hex, block + 1n);
    if (call.method === 'eth_getStorageAt') {
      const [address, slot] = call.params as [Address, Hex];
      if (!same(address, w.router)) throw new Error(`Unexpected storage read at ${address}`);
      for (const [coin, c] of Object.entries(w.coins)) {
        const slots = inboxCoinSlotsV21(coin as Address);
        if (slot === slots.hour) return toHex(c.hour ?? w.now / 3_600n, { size: 32 });
        if (slot === slots.spent) return toHex(c.spent ?? 0n, { size: 32 });
        if (slot === slots.approved) return toHex(c.approved ?? c.allowance ?? 0n, { size: 32 });
      }
      return toHex(0n, { size: 32 });
    }
    // SH-SEND-FEES: the sender's fee and funds reads.
    const feeAnswer = sendFeeRpcAnswer(call.method);
    if (feeAnswer !== undefined) return feeAnswer;
    if (call.method !== 'eth_call') throw new Error(`Unexpected RPC: ${call.method}`);
    const tx = call.params?.[0] as { to: Address; data: Hex; from?: Address };
    const coinOf = (address: unknown) => (typeof address === 'string' ? w.coins[address.toLowerCase()] : undefined);
    if (same(tx.to, w.coordinator)) return encodeFunctionResult({ abi: coordinatorV2Abi, functionName: 'failed', result: w.failed === true });
    if (same(tx.to, w.launchRouter)) {
      decodeFunctionData({ abi: launchRouterV2Abi, data: tx.data });
      if (typeof w.sweep !== 'bigint') throw revert(w.sweep ?? 'NothingToSweep');
      return encodeFunctionResult({ abi: launchRouterV2Abi, functionName: 'sweep', result: w.sweep });
    }
    const asCoin = coinOf(tx.to);
    if (asCoin) return encodeFunctionResult({ abi: erc20Abi, functionName: 'allowance', result: asCoin.allowance ?? 0n });
    if (!same(tx.to, w.router)) throw new Error(`Unexpected call to ${tx.to}`);
    const { functionName, args = [] } = decodeFunctionData({ abi: router, data: tx.data });
    const coin = coinOf(args[0]);
    const answer = (result: unknown) => encodeFunctionResult({ abi: router, functionName, result } as never);
    switch (functionName) {
      case 'weth': return answer(w.weth);
      case 'vaultRelayer': return answer(w.relayer);
      case 'lotSize': return answer(coin?.lot ?? 0n);
      case 'heldBalance': return answer(same(args[0] as string, zeroAddress) ? w.eth ?? 0n : coin?.held ?? 0n);
      case 'orderRegistered': return answer(coin?.registered === true);
      case 'oldestUnsoldAt': return answer(coin?.oldestUnsoldAt ?? 0n);
      case 'refreshOrder':
      case 'observe':
        if (!coin || coin.lot === 0n) throw revert('NoOrder');
        if (coin.refuse) throw revert(coin.refuse);
        return '0x';
      case 'claimInKind': {
        if (!same(tx.from, w.payee)) throw revert('NotPayee');
        const result = coin?.inKind ?? 'NothingToFlush';
        if (typeof result !== 'bigint') throw revert(result);
        return answer(result);
      }
      default: throw new Error(`Unexpected read: ${functionName}`);
    }
  };
  return { calls, request, state };
}
