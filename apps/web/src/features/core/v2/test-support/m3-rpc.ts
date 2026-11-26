/** Controlled RPC answers for M3-53 tests: item credit, owners and pile custody. No chain, key or wallet balance. */
import { decodeFunctionData, encodeFunctionResult, erc20Abi, toFunctionSelector, type Abi, type AbiFunction, type Address, type Hex } from 'viem';
import { boxCollectionAbi, poolManagerAbi } from '@squarehole/chain/abi';
import { coordinatorV2Abi, itemLedgerV2Abi, pileVaultV2Abi, receiverItemsV2Abi, receiverPayInTV21Abi, receiverV2Abi, vaultItemsV2Abi } from '../../../../../../../packages/chain/src/core/v2';
import { successReceipt, type RpcCall } from './m2-rpc';
import { sendFeeRpcAnswer } from '@squarehole/chain/write/test-support';

export interface M3RpcOptions {
  /** Each item's current owner; any other id is still in the vault. */
  readonly owners?: Readonly<Record<string, Address>>;
  /** Each item's [outside share, stash]; any other id has none. */
  readonly credits?: Readonly<Record<string, readonly [bigint, bigint]>>;
  /** v2.1 step 2: each item's [outside share, stash] in the box token (itemCreditT; claimT pays it). */
  readonly creditsT?: Readonly<Record<string, readonly [bigint, bigint]>>;
  readonly vault?: Address;
  /** False: the ledger is one funding record behind (a claim waits for a sync). */
  readonly synced?: boolean;
  readonly graduated?: boolean;
  readonly failed?: boolean;
  /** The owner-only claim simulation: paid, refused (a paused coin) or unanswered. */
  readonly payout?: 'available' | 'paused' | 'offline';
  readonly backing?: bigint;
  readonly pile?: { readonly asset: Address; readonly seeder: Address; readonly seed: bigint; readonly balance: bigint; readonly supply: bigint; readonly leaveBehindBps?: bigint };
  readonly coinsT?: bigint;
  readonly allowanceT?: bigint;
  readonly symbol?: string;
  readonly receiptBlock?: bigint;
  /**
   * The creator's fee claim (F128): the receiver's payee and what it owes in P; `next`, when given, is what the payee's
   * own claimCreator pays now (FINAL-OC01: lazy royalties, the four-part bound), read at each call; `refuse` reverts it.
   */
  readonly creator?: { readonly payee: Address; readonly owed: bigint; readonly next?: () => bigint; readonly refuse?: () => boolean };
  /** The failure hand-in's quote for the coins (F128). */
  readonly quoteP?: bigint;
}

const CREATOR = receiverV2Abi.filter((item) => item.type === 'function' && ['creatorPayee', 'creatorOwed', 'claimCreator'].includes(item.name));
const ABI = [...itemLedgerV2Abi, ...pileVaultV2Abi, ...receiverItemsV2Abi, ...vaultItemsV2Abi, ...coordinatorV2Abi, ...boxCollectionAbi, ...poolManagerAbi, ...erc20Abi, ...CREATOR, ...receiverPayInTV21Abi] as Abi;
const functions = ABI.filter((item): item is AbiFunction => item.type === 'function');
const reverted = (message: string) => Object.assign(new Error(`execution reverted: ${message}`), { code: 3 });

export function m3RpcFixture(options: M3RpcOptions = {}) {
  const calls: RpcCall[] = [];
  const credit = (id: bigint) => options.credits?.[id.toString()] ?? [0n, 0n];
  const creditT = (id: bigint) => options.creditsT?.[id.toString()] ?? [0n, 0n];
  /** PileVaultV2.quoteRedeem (v2.1 step 3): the whole balance for the whole supply, else two floors with the leave-behind. */
  const redeemQuote = (tIn: bigint) => {
    const pile = options.pile;
    if (!pile) return 0n;
    if (tIn === pile.supply) return pile.balance;
    return ((pile.balance * tIn) / pile.supply) * (10_000n - (pile.leaveBehindBps ?? 0n)) / 10_000n;
  };
  const request = async (call: RpcCall): Promise<unknown> => {
    calls.push(call);
    if (call.method === 'eth_chainId') return '0x7a69';
    if (call.method === 'eth_estimateGas') return '0x30d40';
    if (call.method === 'eth_getTransactionReceipt') return successReceipt(call.params?.[0] as Hex, options.receiptBlock ?? 200n);
    // SH-SEND-FEES: the sender's fee and funds reads.
    const feeAnswer = sendFeeRpcAnswer(call.method);
    if (feeAnswer !== undefined) return feeAnswer;
    if (call.method !== 'eth_call') throw new Error(`Unexpected RPC: ${call.method}`);
    const tx = call.params?.[0] as { data: Hex };
    const item = functions.find((f) => toFunctionSelector(f) === tx.data.slice(0, 10));
    if (!item) throw new Error(`Unexpected call: ${tx.data.slice(0, 10)}`);
    const { args = [] } = decodeFunctionData({ abi: [item], data: tx.data });
    const a = args as readonly unknown[];
    const pile = options.pile;
    const answers: Record<string, () => unknown> = {
      fundingCursor: () => (options.synced === false ? 2n : 3n), lifecycleCursor: () => 4n, itemFundingCount: () => 3n, itemLifecycleCount: () => 4n,
      itemCredit: () => credit(a[0] as bigint),
      claim: () => {
        if (options.payout === 'paused') throw reverted('PayoutFailed');
        if (options.payout === 'offline') throw Object.assign(new Error('unavailable'), { code: -32001 });
        const [outside, stash] = credit((a[0] as readonly bigint[])[0] ?? 0n); return outside + stash;
      },
      sync: () => undefined,
      itemCreditT: () => creditT(a[0] as bigint),
      claimT: () => {
        if (options.payout === 'paused') throw reverted('PayoutFailed');
        const [outside, stash] = creditT((a[0] as readonly bigint[])[0] ?? 0n); return outside + stash;
      },
      rewardsPendingP: () => 0n, rewardsPendingByKind: () => [0n, 0n, 0n], rewardBurnPendingT: () => 0n,
      ownerOf: () => options.owners?.[(a[0] as bigint).toString()] ?? options.vault ?? `0x${'0'.repeat(39)}3`,
      balanceOf: () => (a.length === 2 ? options.backing ?? 10n ** 30n : options.coinsT ?? 0n),
      allowance: () => options.allowanceT ?? 0n, approve: () => true, symbol: () => options.symbol ?? 'USDC',
      failed: () => options.failed ?? false, graduated: () => options.graduated ?? true,
      totalSupply: () => pile?.supply ?? 0n, asset: () => pile?.asset, seeder: () => pile?.seeder, seedAmount: () => pile?.seed,
      quoteRedeem: () => redeemQuote(a[0] as bigint), leaveBehindBps: () => Number(pile?.leaveBehindBps ?? 0n),
      redeem: () => redeemQuote(a[0] as bigint), returnSeed: () => pile?.seed ?? 0n,
      quoteClaim: () => options.quoteP ?? 1n,
      creatorPayee: () => options.creator?.payee ?? `0x${'0'.repeat(39)}c`, creatorOwed: () => [options.creator?.owed ?? 0n, 0n],
      claimCreator: () => {
        if (options.creator?.refuse?.()) throw reverted('PayoutFailed');
        return options.creator?.next?.() ?? options.creator?.owed ?? 0n;
      },
    };
    const answer = answers[item.name];
    if (!answer) throw new Error(`Unexpected read: ${item.name}`);
    const result = answer();
    return item.outputs.length === 0 ? '0x' : encodeFunctionResult({ abi: [item], functionName: item.name, result: result as never });
  };
  return { calls, request };
}
