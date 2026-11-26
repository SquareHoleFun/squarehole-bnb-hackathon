/** Rightful claims and closure only. Every call is simulated and every receipt checked. */
import { createPublicClient, encodeFunctionData, erc20Abi, http, type Abi, type Address, type Hex, type TransactionReceipt } from 'viem';
import { coordinatorV2Abi, holderLedgerV2Abi, rolesOfV2 } from '../../../../../../packages/chain/src/core/v2';
import type { WriteTargetV2 } from '../../../../../../packages/chain/src/core/v2/write-calls-v2';
import { createChainReader, createHttpRequest, submitWrite, type SendFeeReader } from '@squarehole/chain/write';
import type { Eip1193Request } from '@squarehole/chain/write/wallet';
import type { CloseCall } from './v2-frozen';
import type { V2Snapshot, V2Source } from './indexer-v2';
import { m2RpcReaderV2, readHolderClaimV2 } from '../../../../../../packages/indexer/src/core/v2/m2-reads-v2';
import { pageClient } from '../../create/v2/view-client';
export type ActionTarget = WriteTargetV2;
/** The box page's actions. The creator's fees are not one: they go through `sendCreatorFeesV2` on the next-payment basis (FINAL-OC01). */
export type ActionV2 = { readonly kind: 'close'; readonly call: CloseCall } | { readonly kind: 'claim' | 'approve'; readonly amount: bigint } | { readonly kind: 'no-buyers' };
export interface ActionIO {
  read(to: Address, fn: string, args?: readonly unknown[]): Promise<unknown>;
  chainId(): Promise<number>;
  /** SH-235: with `block`, at that block (a read not older than a just-confirmed approval); else at the latest. */
  simulate(to: Address, data: Hex, account: Address, block?: bigint): Promise<void>;
  estimate(to: Address, data: Hex, account: Address, block?: bigint): Promise<bigint>;
  receipt(hash: Hex): Promise<boolean>;
  request: Eip1193Request;
  /** SH-SEND-FEES: the source RPC's fee and balance reads every send carries (never the wallet's). */
  readonly feeReader: SendFeeReader;
}
/** SH-SEND-FEES: a send's fee and funds reads over the source's RPC (`internalSendChecked`). */
export const feeReaderOf = (rpc: string): SendFeeReader => createChainReader(createHttpRequest(rpc));
const functions: Readonly<Record<string, Abi>> = { failed: coordinatorV2Abi, graduated: coordinatorV2Abi, claimState: coordinatorV2Abi, quoteClaim: coordinatorV2Abi, balanceOf: erc20Abi, allowance: erc20Abi };
export function actionIO(rpc: string, request: Eip1193Request): ActionIO {
  const client = createPublicClient({ transport: http(rpc, { retryCount: 0 }) });
  return {
    read: (to, fn, args = []) => client.readContract({ address: to, abi: functions[fn] ?? [], functionName: fn, args }),
    chainId: () => client.getChainId(), request, feeReader: feeReaderOf(rpc),
    simulate: async (to, data, account, block) => { await client.call({ to, data, account, ...(block !== undefined ? { blockNumber: block } : {}) }); },
    estimate: (to, data, account, block) => client.estimateGas({ to, data, account, ...(block !== undefined ? { blockNumber: block } : {}) }),
    receipt: async (hash) => (await client.waitForTransactionReceipt({ hash })).status === 'success',
  };
}
/**
 * RR2-LIM-2: a failed box's claim and close first sweep the inbox's P, under INBOX_SWEEP_GAS. In rc6 a sweep that became
 * due between the estimate and inclusion (P reaching the inbox) cost up to about 1.5M more gas on Amsterdam (1,512,077
 * cold), beyond a fifth of a 3.4M estimate, and the later stipend check reverted GasTooLow. Since rc7 the coordinator
 * admits the sweep only with INBOX_SWEEP_RESERVE_GAS (4,000,000) left beyond its allowance (SH-RC7-CLAIM-RESERVE), so a
 * claim's estimate is already about 7.42M and still mines when P reaches the inbox later. Other late changes are outside
 * that reserve (P reaching the launch router after a failure's estimate: failure sweeps the router first), so a send to
 * the coordinator keeps the larger of a fifth and 1,600,000 (INBOX_SWEEP_GAS / 2); above EIP-7825's 16,777,216 the send is refused.
 */
export const COORDINATOR_SWEEP_MARGIN = 1_600_000n;
export const EIP7825_GAS_CAP = 16_777_216n;
export function coordinatorGasLimit(estimate: bigint): bigint {
  const margin = estimate / 5n > COORDINATOR_SWEEP_MARGIN ? estimate / 5n : COORDINATOR_SWEEP_MARGIN;
  // SH-258 round 3: the full limit; one above 16,777,216 is refused at the sender's guard, never clipped to fit.
  return estimate + margin;
}
/**
 * A shop's sends (sell-back `give`, `pick`, `addCollection`): a fifth of the estimate or 150,000, whichever is more, as
 * the create flow keeps (creation-plan.ts `createGasLimit`). SH-258 fix round (measured by the shop lane on chain 97):
 * a sell-back used 382,847 gas on a 371,383 limit (its estimate plus a fifth) when the next block fell into a later
 * second.
 */
export const ACTION_GAS_MARGIN_MIN = 150_000n;
export const actionGasLimit = (estimate: bigint): bigint => estimate + (estimate / 5n > ACTION_GAS_MARGIN_MIN ? estimate / 5n : ACTION_GAS_MARGIN_MIN);
/**
 * The site's gas limit for a checked send: the coordinator's margin above, a shop's `actionGasLimit`, else the estimate
 * plus a fifth.
 */
export const gasLimitFor = (to: Address, coordinator: Address, estimate: bigint, shop?: Address | null) =>
  to.toLowerCase() === coordinator.toLowerCase() ? coordinatorGasLimit(estimate)
    : shop && to.toLowerCase() === shop.toLowerCase() ? actionGasLimit(estimate) : estimate + estimate / 5n;
/** The wallet is on the box’s network and still on `account`; checked before reads and again right before sending. */
export async function identity(target: ActionTarget, account: Address, io: Pick<ActionIO, 'chainId' | 'request'>) {
  const [network, walletNetwork, accounts] = await Promise.all([io.chainId(), io.request({ method: 'eth_chainId' }), io.request({ method: 'eth_accounts' })]);
  if (network !== target.chainId || typeof walletNetwork !== 'string' || BigInt(walletNetwork) !== BigInt(target.chainId)) throw new Error('Wrong network');
  if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || accounts[0].toLowerCase() !== account.toLowerCase()) throw new Error('Wallet changed; confirm again');
}
export async function sendActionV2(target: ActionTarget, account: Address, action: ActionV2, io: ActionIO): Promise<Hex> {
  await identity(target, account, io);
  let to = target.coordinator;
  let data: Hex;
  if (action.kind === 'close') data = encodeFunctionData({ abi: coordinatorV2Abi, functionName: action.call });
  else if (action.kind === 'no-buyers') {
    // The coordinator alone checks the fixed creator entitlement and caller. Never derive it from a zero tLeft.
    data = encodeFunctionData({ abi: coordinatorV2Abi, functionName: 'claim', args: [0n, account] });
  } else if (action.kind === 'claim' || action.kind === 'approve') {
    const amount = action.amount;
    if (typeof amount !== 'bigint' || amount <= 0n) throw new Error('Enter coins to claim');
    const [failed, balance, state] = await Promise.all([io.read(target.coordinator, 'failed'), io.read(target.token, 'balanceOf', [account]), io.read(target.coordinator, 'claimState')]);
    if (failed !== true || typeof balance !== 'bigint' || !Array.isArray(state) || typeof state[1] !== 'bigint' || amount > balance || amount > state[1]) throw new Error('Claim exceeds your eligible coins');
    if (action.kind === 'approve') { to = target.token; data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [target.coordinator, amount] }); }
    else {
      const allowance = await io.read(target.token, 'allowance', [account, target.coordinator]);
      if (typeof allowance !== 'bigint' || allowance < amount) throw new Error('Approve these coins first');
      // A refused quote stops the claim. SH-RC7 item 29: the coordinator quotes the final share at its pot plus the
      // inbox's readable P, so it refuses only an inbox it cannot read, whose claim refuses too (RC6 R1-3's route is gone).
      await io.read(target.coordinator, 'quoteClaim', [amount]);
      data = encodeFunctionData({ abi: coordinatorV2Abi, functionName: 'claim', args: [amount, account] });
    }
  } else throw new Error('Unknown action');
  await io.simulate(to, data, account);
  const gas = await io.estimate(to, data, account);
  await identity(target, account, io);
  const sent = await submitWrite({ protocol: 'core-v2', target, call: { to, data, value: 0n }, wallet: io.request, from: account,
    gasLimit: gasLimitFor(to, target.coordinator, gas), feeReader: io.feeReader });
  if (!await io.receipt(sent)) throw new Error('Transaction reverted; nothing confirmed');
  return sent;
}

// M2 consumes the canonical reader. The shared submitter remains the sole wallet send boundary.
export type HolderClaimV2 = Awaited<ReturnType<typeof readHolderClaimV2>> & { readonly grows?: true };

/**
 * A batch paid in T (v2.1 step 2) as the claim rule reads it: its T quote in the legacy P-named fields (as the claims
 * index's `holderWalletQuoteV21` does), any credit claimable now ("settled": each purchased tranche settles as it comes),
 * and `grows`, since later tranches add credit after a claim. A P batch is returned as read.
 */
export function holderCreditOf(read: Awaited<ReturnType<typeof readHolderClaimV2>>): HolderClaimV2 {
  const t = read.t;
  if (!t) return read;
  const claimable = t.claimableT;
  return { ...read, status: claimable !== null && claimable > 0n ? 'settled' : read.status, claimableP: claimable, payout: t.payout, grows: true };
}
export type HolderReceiptV2 = Pick<TransactionReceipt, 'transactionHash' | 'blockNumber' | 'blockHash' | 'status'>;
export interface HolderActionIO extends Pick<ActionIO, 'chainId' | 'request' | 'simulate' | 'estimate' | 'feeReader'> {
  claim(batch: bigint, holder: Address): Promise<HolderClaimV2>;
  /** The mined receipt; its block number is what holder-claims.ts compares later reads against. */
  receipt(hash: Hex): Promise<HolderReceiptV2>;
  /** Test/integration seam; production always delegates to submitWrite's narrow allowlist. */
  submit: typeof submitWrite;
}
export function holderActionIO(source: V2Source, view: V2Snapshot, request: Eip1193Request): HolderActionIO {
  const client = pageClient(source.rpc, source.manifest.chainId, () => createPublicClient({ transport: http(source.rpc, { retryCount: 0 }) }));
  return { ...actionIO(source.rpc, request), submit: submitWrite,
    receipt: hash => client.waitForTransactionReceipt({ hash }),
    claim: async (batchId, holder) => {
      if (!view.claimRow || !view.verified || view.stale) throw new Error('Current verified fee share unavailable');
      if (await client.getChainId() !== source.manifest.chainId) throw new Error('Wrong network');
      return holderCreditOf(await readHolderClaimV2(m2RpcReaderV2(client), view.claimRow, { batchId, holder }, view.blockHash));
    } };
}
export async function sendHolderClaimV2(source: V2Source, view: V2Snapshot, account: Address, batch: bigint, expectedP: bigint, io: HolderActionIO): Promise<HolderReceiptV2> {
  const roles = rolesOfV2(view.record).contracts; const ledger = roles.holderLedger;
  if (view.stale || !view.verified || !ledger || batch <= 0n || expectedP <= 0n) throw new Error('Refresh your fee share before claiming');
  const target = { chainId: source.manifest.chainId, coordinator: roles.coordinator as Address, receiver: roles.receiver as Address, token: view.token, p: view.record.q, holderLedger: ledger };
  await identity(target, account, io);
  const credit = await io.claim(batch, account);
  if (credit.hash !== view.blockHash || credit.batchId !== batch || credit.holder.toLowerCase() !== account.toLowerCase() || credit.status !== 'settled' || credit.payout !== 'available' || credit.claimableP !== expectedP) throw new Error('Fee share changed or payout unavailable. Refresh and try again.');
  const data = encodeFunctionData({ abi: holderLedgerV2Abi, functionName: 'claim', args: [batch, account] });
  await io.simulate(ledger, data, account);
  const estimate = await io.estimate(ledger, data, account);
  await identity(target, account, io);
  const sent = await io.submit({ protocol: 'core-v2', target, call: { to: ledger, data, value: 0n }, wallet: io.request, from: account, gasLimit: estimate + estimate / 5n, feeReader: io.feeReader });
  const receipt = await io.receipt(sent);
  if (receipt.status !== 'success' || receipt.transactionHash !== sent) throw new Error('Holder claim not confirmed');
  return receipt;
}
