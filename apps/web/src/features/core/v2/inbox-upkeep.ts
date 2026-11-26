/**
 * SH-RC7-SITE-INBOX (rc7 open item 11): the box page's public inbox controls and the payee's in-kind claim. Every
 * control is read first and dry-run before it is shown (never a dead button): the inbox coin's live state over the
 * source's RPC decides whether a refresh or an observation would change anything (`inboxUpkeepV21`), then the call
 * itself runs as an `eth_call`; a revert hides it. The launch router's sweep (KF-5) shows only when its dry run moves
 * P. The wallet is asked only on a press, through the shared sender (`submitWrite` and its guard). Nothing here
 * chooses a recipient: the contracts fix every destination.
 */
import { BaseError, ContractFunctionRevertedError, createPublicClient, decodeErrorResult, decodeFunctionResult, encodeFunctionData, http, parseAbi, type Address, type Hex } from 'viem';
import { submitWrite } from '@squarehole/chain/write';
import type { Eip1193Request } from '@squarehole/chain/write/wallet';
import { claimRoyaltyInKindCallV21, inboxUpkeepV21, launchRouterV2Abi, observeRoyaltyCoinCallV21, readInboxCoinLiveV21, refreshRoyaltyOrderCallV21, rolesOfV2, royaltyRouterV2Abi, routerSweepCallV2, type InboxLiveReaderV21 } from '../../../../../../packages/chain/src/core/v2';
import type { WriteCallV2, WriteTargetV2 } from '../../../../../../packages/chain/src/core/v2/write-calls-v2';
import { actionIO, identity, type HolderReceiptV2 } from './actions-v2';
import type { SendIO } from './m3-actions';
import type { V2Snapshot, V2Source } from './indexer-v2';
import { TESTNET } from '../../data-source/testnet';
import { pageClient } from '../../create/v2/view-client';

/** The inbox's and the launch router's errors a dry run can end with (the implementation's, beyond the interface ABI). */
const ERRORS = parseAbi(['error NoOrder()', 'error WaitForSale()', 'error NotPayee()', 'error MissingPayee()', 'error NothingToFlush()',
  'error TokenNotTaken(address token)', 'error TransferRefused(address token)', 'error NothingToSweep()', 'error NotGraduated()']);

/** The shared sender's target for this box: its coordinator, receiver and token, its inbox (role 8) and launch router (role 6). */
export function inboxTargetV2(source: V2Source, view: V2Snapshot): WriteTargetV2 {
  const roles = rolesOfV2(view.record).contracts;
  if (!roles.coordinator || !roles.receiver) throw new Error('Box roles unavailable');
  return { chainId: source.manifest.chainId, token: view.token, coordinator: roles.coordinator, receiver: roles.receiver, p: view.record.q,
    ...(roles.royaltyRouter ? { royaltyRouter: roles.royaltyRouter } : {}), ...(roles.launchRouter ? { launchRouter: roles.launchRouter } : {}) };
}

/** The name of the contract error a revert carries; null for anything else (an RPC that did not answer, a bare revert). */
export function revertNameOf(error: unknown): string | null {
  if (!(error instanceof BaseError)) return null;
  const decoded = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
  if (decoded instanceof ContractFunctionRevertedError && decoded.data?.errorName) return decoded.data.errorName;
  const raw = error.walk((cause) => typeof (cause as { data?: unknown }).data === 'string' && /^0x[0-9a-fA-F]{8}/.test((cause as { data: string }).data)) as { data?: Hex } | null;
  if (!raw?.data) return null;
  try { return decodeErrorResult({ abi: ERRORS, data: raw.data }).errorName; } catch { return null; }
}

export interface InboxIO extends SendIO {
  /** Live reads for one coin, pinned to one block (`readInboxCoinLiveV21`). */
  readonly live: InboxLiveReaderV21;
  /** The call's dry run at the latest block (`eth_call`, from `account` when given); its return data, or a revert thrown. */
  dry(call: WriteCallV2, account?: Address): Promise<Hex>;
  receipt(hash: Hex): Promise<HolderReceiptV2>;
}

/** The inbox IO over the source's RPC; `request` is the connected wallet's (only a press uses it). */
export function inboxIO(source: V2Source, request: Eip1193Request = async () => { throw new Error('No wallet'); }): InboxIO {
  const client = pageClient(source.rpc, source.manifest.chainId, () => createPublicClient({ transport: http(source.rpc, { retryCount: 0 }), ccipRead: false }));
  return { ...actionIO(source.rpc, request), submit: submitWrite,
    receipt: (hash) => client.waitForTransactionReceipt({ hash }),
    live: {
      block: async () => { const block = await client.getBlock(); return { number: block.number, timestamp: block.timestamp }; },
      call: async (to, data, blockNumber) => (await client.call({ to, data, blockNumber })).data ?? '0x',
      storage: async (address, slot, blockNumber) => (await client.getStorageAt({ address, slot, blockNumber })) ?? '0x',
    },
    dry: async (call, account) => (await client.call({ to: call.to, data: call.data, ...(account ? { account } : {}) })).data ?? '0x',
  };
}

/** One coin's public control: what it does, what it would offer, and the call the press sends. */
export type InboxControlV2 =
  | { readonly kind: 'refresh'; readonly lots: bigint; readonly call: WriteCallV2 }
  | { readonly kind: 'observe'; readonly reason: 'sale' | 'clock'; readonly call: WriteCallV2 };

/**
 * The control a coin of this box's inbox offers now, or null: nothing would change, the box failed (R53-E), or the call's
 * dry run refused. A read the RPC could not answer throws (the page shows no control and asks again on the next read).
 */
export async function readInboxControlV2(io: Pick<InboxIO, 'live' | 'dry'>, target: WriteTargetV2, coin: Address): Promise<InboxControlV2 | null> {
  if (!target.royaltyRouter) return null;
  const live = await readInboxCoinLiveV21(io.live, target.royaltyRouter, target.coordinator, coin);
  const upkeep = inboxUpkeepV21(live);
  if (!upkeep) return null;
  const control: InboxControlV2 = upkeep.kind === 'refresh'
    ? { kind: 'refresh', lots: upkeep.offered / live.lot, call: refreshRoyaltyOrderCallV21(target, coin) }
    : { kind: 'observe', reason: upkeep.reason, call: observeRoyaltyCoinCallV21(target, coin) };
  try { await io.dry(control.call); } catch (error) { if (isRevert(error) || revertNameOf(error) !== null) return null; throw error; }
  return control;
}

/** A plain execution revert (code 3 or "execution reverted"), with or without decodable data. */
function isRevert(error: unknown): boolean {
  for (let e: unknown = error, i = 0; i < 10 && e && typeof e === 'object'; ++i) {
    const x = e as { code?: unknown; message?: unknown; details?: unknown; cause?: unknown };
    if (x.code === 3 || [x.message, x.details].some((text) => typeof text === 'string' && /execution reverted/i.test(text))) return true;
    e = x.cause;
  }
  return false;
}

/** KF-5: the launch tax a public sweep would move now (its dry run's return), or null when it would refuse or move nothing. */
export async function readLaunchTaxV2(io: Pick<InboxIO, 'dry'>, target: WriteTargetV2): Promise<bigint | null> {
  if (!target.launchRouter) return null;
  const call = routerSweepCallV2(target);
  let data: Hex;
  try { data = await io.dry(call); } catch (error) { if (isRevert(error)) return null; throw error; }
  const amount = decodeFunctionResult({ abi: launchRouterV2Abi, functionName: 'sweep', data });
  return amount > 0n ? amount : null;
}

/**
 * The payee's in-kind claim of one coin, as its dry run from the payee answers: the amount it would take, or why not.
 * `paid` is the coin the payee receives: the asked coin, or WETH for the zero address (SH-V21-RC7-INT release review
 * IDX-SITE-1: `claimInKind(address(0))` wraps the inbox's ETH and pays WETH, the ETH and any WETH already held).
 */
export type InKindAnswerV2 = { readonly kind: 'ready'; readonly amount: bigint; readonly call: WriteCallV2; readonly paid: Address }
  | { readonly kind: 'refused'; readonly reason: InKindRefusal; /** SH-258 round 3: the wait's earliest end (unix seconds), where read. */ readonly notBefore?: bigint };
export type InKindRefusal = 'price-coin' | 'wait' | 'wait-unstarted' | 'wait-unread' | 'empty' | 'not-payee' | 'refused';
/** The page's words for each refusal. */
export const IN_KIND_WORDS: Readonly<Record<InKindRefusal, string>> = {
  'price-coin': 'The price coin goes to the box, not in kind.',
  // SH-258: without the sale list (BNB Chain testnet) the contract's 30-day wait still holds; no sale is mentioned.
  wait: TESTNET.switches.cowSales ? 'Not yet: a coin on the sale list waits 30 days without a sale.' : 'Not yet: a listed coin waits 30 days in the inbox before the payee can take it.',
  // SH-258 round 3 (no sale list): the inbox has not recorded this coin yet, so its 30 days have not begun.
  'wait-unstarted': 'Not yet: this coin’s 30-day wait has not started.',
  // Round 3b: the reads that tell the wait apart failed: said so, never "none held".
  'wait-unread': 'Not yet; the inbox could not be read just now. Try again.',
  empty: 'The inbox holds none of this coin.',
  'not-payee': 'Only the creator’s payee can take coins.',
  refused: 'This coin cannot be taken now.',
};
const REFUSALS: Readonly<Record<string, InKindRefusal>> = { TokenNotTaken: 'price-coin', WaitForSale: 'wait', NothingToFlush: 'empty', NotPayee: 'not-payee', MissingPayee: 'not-payee' };

/** P, and WETH in a box priced in ETH, always go to the box (the inbox's `TokenNotTaken`), so they are refused before any read. */
export function priceCoinOf(target: Pick<WriteTargetV2, 'p'>, weth: Address, token: Address): boolean {
  const p = target.p.toLowerCase();
  return token.toLowerCase() === p || (BigInt(p) === 0n && token.toLowerCase() === weth.toLowerCase());
}

export async function readInKindV2(io: Pick<InboxIO, 'dry'>, target: WriteTargetV2, weth: Address, payee: Address, token: Address): Promise<InKindAnswerV2> {
  if (priceCoinOf(target, weth, token)) return { kind: 'refused', reason: 'price-coin' };
  const call = claimRoyaltyInKindCallV21(target, token);
  let data: Hex;
  try { data = await io.dry(call, payee); } catch (error) {
    const name = revertNameOf(error);
    if (name === 'WaitForSale' && !TESTNET.switches.cowSales) return waitOf(io, call.to, BigInt(token) === 0n ? weth : token, weth, payee);
    if (name !== null) return { kind: 'refused', reason: REFUSALS[name] ?? 'refused' };
    if (isRevert(error)) return { kind: 'refused', reason: 'refused' };
    throw error;
  }
  const amount = decodeFunctionResult({ abi: royaltyRouterV2Abi, functionName: 'claimInKind', data });
  const paid = BigInt(token) === 0n ? weth : token;
  return amount > 0n ? { kind: 'ready', amount, call, paid } : { kind: 'refused', reason: 'empty' };
}

const WAIT_VIEWS = parseAbi(['function heldBalance(address token) view returns (uint256)', 'function oldestUnsoldAt(address coin) view returns (uint256)']);
const AGGREGATE3 = parseAbi(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']);
/** The contract's in-kind wait (BoxRoyaltyRouterV2 `IN_KIND_WAIT`). */
const IN_KIND_WAIT_SECONDS = 30n * 86_400n;
/**
 * SH-258 round 3 (no sale list): the wait refusal told apart by the inbox's own reads: none of the coin held (the
 * contract checks the wait before the amount); held but its clock not started (no observation recorded); or waiting
 * since the recorded observation (a later one can move it on, so "not before"). A failed read keeps the plain wait.
 */
async function waitOf(io: Pick<InboxIO, 'dry'>, router: Address, coin: Address, weth: Address, payee: Address): Promise<InKindAnswerV2> {
  try {
    // Round 3b: one eth_call through Multicall3, so the balances and the clock are read at one block. The wrapped coin
    // counts the inbox's native coin too (the claim wraps it first).
    const wrapped = coin.toLowerCase() === weth.toLowerCase();
    const reads: [Address, `0x${string}`][] = [
      [router, encodeFunctionData({ abi: WAIT_VIEWS, functionName: 'heldBalance', args: [coin] })],
      [router, encodeFunctionData({ abi: WAIT_VIEWS, functionName: 'oldestUnsoldAt', args: [coin] })],
      ...(wrapped ? [[router, encodeFunctionData({ abi: WAIT_VIEWS, functionName: 'heldBalance', args: ['0x0000000000000000000000000000000000000000'] })] as [Address, `0x${string}`]] : []),
    ];
    const data = await io.dry({ to: TESTNET.multicall3, data: encodeFunctionData({ abi: AGGREGATE3, functionName: 'aggregate3', args: [reads.map(([target, callData]) => ({ target, allowFailure: false, callData }))] }), value: 0n }, payee);
    const rows = decodeFunctionResult({ abi: AGGREGATE3, functionName: 'aggregate3', data });
    const value = (index: number): bigint => decodeFunctionResult({ abi: WAIT_VIEWS, functionName: 'heldBalance', data: rows[index]?.returnData ?? '0x' });
    const held = value(0) + (wrapped ? value(2) : 0n);
    const oldest = value(1);
    if (held === 0n) return { kind: 'refused', reason: 'empty' };
    if (oldest === 0n) return { kind: 'refused', reason: 'wait-unstarted' };
    return { kind: 'refused', reason: 'wait', notBefore: oldest + IN_KIND_WAIT_SECONDS };
  } catch { return { kind: 'refused', reason: 'wait-unread' }; }
}

/**
 * Each press's least gas limit, our keeper's floors for the same calls (`packages/keeper/src/gas.ts`, `V2_GAS_FLOORS`):
 * a refresh or an observation may wrap ETH and approve through the inbox's 2.7M TOKEN_GAS stipend, which an estimate
 * of a cheaper state can leave out; the in-kind claim makes two such calls in turn (the approval's clearing, then the
 * transfer); the router sweep settles at most four parts. A higher estimate plus a fifth wins; the EIP-7825 cap clips.
 */
export const INBOX_GAS_FLOORS: Readonly<Record<string, bigint>> = { refreshOrder: 5_000_000n, observe: 5_000_000n, claimInKind: 6_000_000n, sweep: 2_000_000n };
const SELECTORS: Readonly<Record<string, string>> = Object.fromEntries((['refreshOrder', 'observe', 'claimInKind'] as const).map((fn) => [
  encodeFunctionData({ abi: royaltyRouterV2Abi, functionName: fn, args: ['0x0000000000000000000000000000000000000001'] } as never).slice(0, 10), fn]));
const SWEEP = encodeFunctionData({ abi: launchRouterV2Abi, functionName: 'sweep' });
export function inboxGasLimit(call: WriteCallV2, estimate: bigint): bigint {
  const name = call.data === SWEEP ? 'sweep' : SELECTORS[call.data.slice(0, 10)];
  const floor = (name && INBOX_GAS_FLOORS[name]) || 0n;
  const padded = estimate + estimate / 5n;
  // SH-258 round 3: the full limit; one above 16,777,216 is refused at the sender's guard, never clipped to fit.
  return padded > floor ? padded : floor;
}

/** One press: the wallet checked, the call simulated and estimated from the caller, the wallet re-checked, the shared sender (its guard), and this receipt's success. */
export async function sendInboxCallV2(target: WriteTargetV2, account: Address, call: WriteCallV2, io: SendIO): Promise<HolderReceiptV2> {
  await identity(target, account, io);
  await io.simulate(call.to, call.data, account);
  const estimate = await io.estimate(call.to, call.data, account);
  await identity(target, account, io);
  const sent = await io.submit({ protocol: 'core-v2', target, call, wallet: io.request, from: account, gasLimit: inboxGasLimit(call, estimate), feeReader: io.feeReader });
  const receipt = await io.receipt(sent);
  if (receipt.status !== 'success' || receipt.transactionHash !== sent) throw new Error('Not confirmed');
  return receipt;
}
