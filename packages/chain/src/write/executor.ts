/**
 * The real transaction executor behind the app's transaction flow (06-ARCHITECTURE state machine; UI-08; ECO-07).
 * Framework-free: it reports domain `TxEvent`s through `emit` and never decides UI copy.
 *
 *   simulateWrite   preparing: `eth_call` + `eth_estimateGas` from the account against the configured RPC, the revert
 *                   decoded from the ABIs (simulation_failed), plus a network-fee estimate (unavailable, never zero,
 *                   when the fee reads fail).
 *   submitWrite     awaiting_signature: the wallet must still be on the request's chain with the request's account,
 *                   the call must pass `assertSendableCall`, then ONE `eth_sendTransaction` carrying the app's EIP-1559
 *                   fee (SH-SEND-FEES: `sendFeesOf`, read from the app's RPC, never the wallet's own pick), after a
 *                   check that the account holds gasLimit × maxFeePerGas + value. 4001 = rejected.
 *   TxTracker       submitted → pending (seen by the RPC) → confirmed_unfinalized (receipt, 1 confirmation, after the
 *                   writer's receipt check) → finalized (the chain's `finalized` tag, or N confirmations on anvil, the
 *                   block still canonical, and the writer's check re-run at that block). A receipt that disappears or
 *                   moves to another block is a reorg (back to pending). A consumed nonce without our receipt is a
 *                   replacement (speed-up or cancel, found by scanning blocks for the same sender and nonce). No receipt
 *                   before the timeout is `timed_out`; repeated read failures are `unknown`; both offer "re-check by
 *                   hash". A hash alone is never success.
 */
import type { Address, TxEvent, TxHash } from '@squarehole/domain';
import { assertSendableBox0Call, type Box0Call, type Box0Target } from '../core/box0-calls';
import { assertSendableCallV2, type WriteCallV2, type WriteTargetV2 } from '../core/v2/write-calls-v2';
import { assertSendableCreateStepV2, createStepsV2, type CreateSendPlanV2 } from '../core/v2/create-send-v2';
import { EIP7825_TX_GAS_CAP, type WriteChain } from './chains';
import { assertSendableSetCreate, type SetCreatePlanV2, assertSendableSetCallV2, type SetCallV2, type SetTargetV2 } from '../core/set-v2/tx';
import { NotSendableError, assertSendableCall, type WriteCall } from './calls';
import type { WriteDeployment } from './deployment';
import { errorMessage, isTxHashValue, isUserRejection, parseAccounts, parseChainId, toQuantity, type Eip1193Request } from './eip1193';
import type { WriteVerifier } from './prepared';
import { decodeRevert, revertDataOf, revertReason, type DecodedRevert } from './revert';
import { RpcRequestError, type ChainReader, type RpcTransaction, type TxReceipt } from './rpc';

// ---------------------------------------------------------------------------------------------------------------
// Fees (SH-SEND-FEES)
// ---------------------------------------------------------------------------------------------------------------

/**
 * The least tip (maxPriorityFeePerGas) a send offers: 0.01 gwei. An RPC may suggest 0 on a quiet chain, and a send
 * with no tip can wait in the pool indefinitely. Sepolia on 2026-11-02 suggested 0.000472652 gwei (publicnode and
 * Tenderly agreed), so the floor is about 21 times that; it adds at most 0.000168 SepETH to one send at the
 * per-transaction gas cap (16,777,216 × 0.01 gwei), a third of a percent of the 0.05 SepETH alpha starter. On mainnet a
 * suggestion below 0.01 gwei is unusual, so the floor binds only when the RPC answers about zero.
 */
export const MIN_PRIORITY_FEE_WEI = 10_000_000n;

/** The EIP-1559 fee fields every app send carries. */
export interface SendFees {
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
}

/**
 * The most tip a send offers, per chain (review wf_c1aec23f-2c4): an absolute ceiling and a multiple of the latest base
 * fee, whichever is lower, never below `MIN_PRIORITY_FEE_WEI`. The tip is paid in full, and a Privy made wallet signs
 * without a window, so one RPC answer must not set it alone. Sepolia: 2 gwei, or twice the base fee (base fee 16 wei
 * on 2026-11-02, so the floor). Every other chain: 5 gwei, or twice the base fee.
 */
export interface TipCap {
  readonly ceilingWei: bigint;
  /** null: no cap by the base fee (a chain whose base fee is 0 and whose price is its tip). */
  readonly baseMultiple: bigint | null;
  /**
   * SH-258: the chain's own asked price is the floor: the tip is never below the RPC's suggestion nor below
   * `eth_gasPrice` above the base fee, plus a tenth of headroom (BNB Chain testnet: base fee 0, price 0.1 gwei; a
   * send at 0.01 gwei waits in the pool and no validator takes it, measured on 25 November 2026).
   */
  readonly chainPriceFloor?: boolean;
}
export const TIP_CAPS: Readonly<Record<number, TipCap>> = Object.freeze({
  11155111: Object.freeze({ ceilingWei: 2_000_000_000n, baseMultiple: 2n }),
  97: Object.freeze({ ceilingWei: 5_000_000_000n, baseMultiple: null, chainPriceFloor: true }),
});
export const DEFAULT_TIP_CAP: TipCap = Object.freeze({ ceilingWei: 5_000_000_000n, baseMultiple: 2n });

const policyOf = (chainId: number): TipCap => TIP_CAPS[chainId] ?? DEFAULT_TIP_CAP;

/** The highest tip a send on `chainId` offers at this base fee. */
export function tipCapOf(chainId: number, baseFeePerGas: bigint): bigint {
  const policy = policyOf(chainId);
  const byBase = policy.baseMultiple === null ? policy.ceilingWei : baseFeePerGas * policy.baseMultiple;
  const cap = byBase < policy.ceilingWei ? byBase : policy.ceilingWei;
  return cap > MIN_PRIORITY_FEE_WEI ? cap : MIN_PRIORITY_FEE_WEI;
}

/** Whether a send on `chainId` reads `eth_gasPrice` for its floor (SH-258). */
export const readsGasPrice = (chainId: number): boolean => policyOf(chainId).chainPriceFloor === true;

/**
 * The send fee: the RPC's tip, at least `MIN_PRIORITY_FEE_WEI` and at most `tipCapOf`, over twice the latest base fee
 * (room for about six full blocks of rises). Where the chain's price is the floor (`chainPriceFloor`, BNB Chain
 * testnet) the tip is at least the larger of the suggestion and `gasPrice` less the base fee, plus a tenth.
 */
export function sendFeesOf(baseFeePerGas: bigint, suggestedTip: bigint, chainId: number, gasPrice: bigint | null = null): SendFees {
  const cap = tipCapOf(chainId, baseFeePerGas);
  const floored = suggestedTip > MIN_PRIORITY_FEE_WEI ? suggestedTip : MIN_PRIORITY_FEE_WEI;
  if (policyOf(chainId).chainPriceFloor === true) {
    // SH-258 fix round 3: the chain's raw price is required (never guessed) and compared with the ceiling first; both
    // fields are at least that price; the tenth of headroom only where it fits under the ceiling.
    const price = checkedPrice(gasPrice, policyOf(chainId).ceilingWei);
    const asked = suggestedTip > price ? suggestedTip : price;
    const padded = asked + asked / 10n;
    return Object.freeze({ maxPriorityFeePerGas: padded > cap ? cap : padded, maxFeePerGas: baseFeePerGas * 2n + (padded > cap ? cap : padded) });
  }
  const maxPriorityFeePerGas = floored > cap ? cap : floored;
  return Object.freeze({ maxPriorityFeePerGas, maxFeePerGas: baseFeePerGas * 2n + maxPriorityFeePerGas });
}

/**
 * SH-258: a chain whose price floors the fee gave no usable price (`no_price`: no answer, or zero), asks more than the
 * site's ceiling (`above_ceiling`), or rose above the fee already set before the wallet was asked (`rose`). The message
 * is the page's sentence.
 */
export class NetworkPriceError extends Error {
  override readonly name = 'NetworkPriceError';
  constructor(readonly kind: 'no_price' | 'above_ceiling' | 'rose', readonly price: bigint | null) {
    super(kind === 'no_price' ? 'The network gave no usable gas price; nothing was sent. Try again.'
      : kind === 'above_ceiling' ? `The network asks ${gweiText(price ?? 0n)} gwei for gas, above the ${gweiText(TIP_CAPS[97]?.ceilingWei ?? 0n)} gwei this site offers; nothing was sent.`
      : `The network's gas price rose to ${gweiText(price ?? 0n)} gwei; nothing was sent. Press again to read the price again.`);
  }
}

/** Gwei to the last wei, trailing zeros trimmed ("0.1", "5", "5.000000001"). */
function gweiText(wei: bigint): string {
  const whole = wei / 1_000_000_000n;
  const part = (wei % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return part ? `${whole}.${part}` : String(whole);
}

/**
 * SH-258 round 3b: a caller that does work of its own after the shared check (a reveal's journal write, a vault's nonce
 * reads) checks the request's two fee fields again here, immediately before its real provider request. On a chain
 * whose price floors the fee only; elsewhere nothing is read.
 */
export async function checkRequestPrice(feeReader: Pick<SendFeeReader, 'gasPrice'>, chainId: number, tx: unknown): Promise<void> {
  if (!readsGasPrice(chainId)) return;
  const fresh = checkedPrice(feeReader.gasPrice ? await feeReader.gasPrice().catch(() => null) : null, policyOf(chainId).ceilingWei);
  // Round 4: both fields must be RPC hex quantities ("0x", no leading zeros); anything else is a fee-shape refusal.
  const field = (name: string): bigint => {
    const value = typeof tx === 'object' && tx !== null ? (tx as Record<string, unknown>)[name] : undefined;
    if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) throw new PreSendRefusalError('The network fee is not a valid EIP-1559 fee; nothing was sent.', chainId);
    return BigInt(value);
  };
  const [priority, max] = [field('maxPriorityFeePerGas'), field('maxFeePerGas')];
  if (priority < fresh || max < fresh) throw new NetworkPriceError('rose', fresh);
}

/** The raw price, refused when missing, zero or above `ceiling`. */
function checkedPrice(gasPrice: bigint | null, ceiling: bigint): bigint {
  if (gasPrice === null || gasPrice <= 0n) throw new NetworkPriceError('no_price', null);
  if (gasPrice > ceiling) throw new NetworkPriceError('above_ceiling', gasPrice);
  return gasPrice;
}

/** The app's own RPC reads a send's fee and funds check need (never the wallet's: its provider may not answer them). */
export type SendFeeReader = Pick<ChainReader, 'getBlock' | 'maxPriorityFeePerGas' | 'getBalance' | 'gasPrice'>;

/** What every guarded send takes besides its call: the app's RPC, and the fee already shown to the person, if any. */
export interface SendFeeInput {
  readonly feeReader: SendFeeReader;
  /** The fee the person was shown (`simulateWrite`'s): sent as it is. Absent or null: read from `feeReader` now. */
  readonly fee?: SendFees | null;
}

/** The latest base fee and the RPC's tip, as `sendFeesOf` turns them into a send's fee. A failed read throws. */
export async function readSendFees(reader: Pick<SendFeeReader, 'getBlock' | 'maxPriorityFeePerGas' | 'gasPrice'>, chainId: number): Promise<SendFees> {
  const { maxFeePerGas, maxPriorityFeePerGas } = await readFeeEstimate(reader, chainId, 0n, 0n);
  return Object.freeze({ maxFeePerGas, maxPriorityFeePerGas });
}

/**
 * The fee a send would carry now, with what it is expected to cost (gas × (base fee + tip)) and the most it can cost
 * (gasLimit × maxFeePerGas). A failed read, or a block without a base fee, throws.
 */
export async function readFeeEstimate(reader: Pick<SendFeeReader, 'getBlock' | 'maxPriorityFeePerGas' | 'gasPrice'>, chainId: number, gasEstimate: bigint, gasLimit: bigint): Promise<FeeEstimate> {
  // SH-258: a chain whose price floors the fee (BNB Chain testnet) is asked its gas price as well; a reader without the
  // method falls back to the tip suggestion (which answers the same price there).
  // A reader without the method gives null, which `sendFeesOf` refuses on such a chain (never a guess).
  // A failed price read is no usable price (NetworkPriceError), never the transport's own error.
  const price = readsGasPrice(chainId) && reader.gasPrice ? reader.gasPrice().catch(() => null) : Promise.resolve(null);
  const [block, tip, gasPrice] = await Promise.all([reader.getBlock('latest'), reader.maxPriorityFeePerGas(), price]);
  if (block === null || block.baseFeePerGas === null) throw new Error('the latest block has no base fee');
  return feeEstimateOf(block.baseFeePerGas, sendFeesOf(block.baseFeePerGas, tip, chainId, gasPrice), gasEstimate, gasLimit);
}

/** A `FeeEstimate` for these fee fields at this base fee. */
export function feeEstimateOf(baseFeePerGas: bigint, fees: SendFees, gasEstimate: bigint, gasLimit: bigint): FeeEstimate {
  return Object.freeze({
    baseFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    maxFeePerGas: fees.maxFeePerGas,
    expectedFeeWei: gasEstimate * (baseFeePerGas + fees.maxPriorityFeePerGas),
    maxFeeWei: gasLimit * fees.maxFeePerGas,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------------------------------------------

export interface FeeEstimate {
  readonly baseFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly maxFeePerGas: bigint;
  /** gas × (base fee + tip): what the transaction is expected to cost now. */
  readonly expectedFeeWei: bigint;
  /** gasLimit × maxFeePerGas: the most it can cost at this estimate. */
  readonly maxFeeWei: bigint;
}

export interface Simulation {
  readonly gasEstimate: bigint;
  /** Estimate + 20%, capped at the chain's per-transaction gas cap (EIP-7825). */
  readonly gasLimit: bigint;
  /** Null when the fee could not be read (shown as unavailable, never as zero). */
  readonly fee: FeeEstimate | null;
  readonly atBlock: bigint;
}

export type SimulationResult =
  | { readonly ok: true; readonly simulation: Simulation }
  | { readonly ok: false; readonly reason: string; readonly revert: DecodedRevert | null };

/** SH-258 round 3: what is known when a limit is over the cap: the estimate plus its safety margin does not fit. */
const marginLine = (cap: bigint): string => `The gas estimate plus its safety margin does not fit in one transaction (${cap.toLocaleString('en-US')} gas); nothing was sent.`;

/** Why a read failed without revert data (the RPC, not the contract). */
const readFailure = (error: unknown, what: string): string => `${what} could not be read from the chain (${errorMessage(error)}); nothing was sent.`;

export async function simulateWrite(reader: ChainReader, chain: WriteChain, call: WriteCall, from: Address): Promise<SimulationResult> {
  let atBlock: bigint;
  try {
    atBlock = await reader.blockNumber();
  } catch (error) {
    return { ok: false, reason: readFailure(error, 'The latest block'), revert: null };
  }
  const request = { from, to: call.to, data: call.data, value: call.value };
  try {
    await reader.call(request, 'latest');
  } catch (error) {
    return simulationFailure(error, 'The simulation');
  }
  let gasEstimate: bigint;
  try {
    gasEstimate = await reader.estimateGas(request);
  } catch (error) {
    return simulationFailure(error, 'The gas estimate');
  }
  if (gasEstimate > chain.maxTxGas) {
    return { ok: false, reason: `The transaction needs about ${gasEstimate} gas, more than one transaction may use (${chain.maxTxGas}, EIP-7825).`, revert: null };
  }
  const gasLimit = gasEstimate + gasEstimate / 5n;
  // SH-258 round 3: the estimate fits but its safety margin does not: refused here, never clipped to fit.
  if (gasLimit > chain.maxTxGas) return { ok: false, reason: marginLine(chain.maxTxGas), revert: null };
  // The fee the send will carry (runChainWrite's floor for the press), so what is shown is what is sent.
  const fee: FeeEstimate | null = await readFeeEstimate(reader, chain.chainId, gasEstimate, gasLimit).catch(() => null);
  return { ok: true, simulation: Object.freeze({ gasEstimate, gasLimit, fee, atBlock }) };
}

function simulationFailure(error: unknown, what: string): SimulationResult {
  const data = revertDataOf(error);
  const decoded = data ? decodeRevert(data) : null;
  const reverted = data !== null || (error instanceof RpcRequestError && error.code === 3) || /revert/i.test(errorMessage(error, ''));
  if (!reverted) return { ok: false, reason: readFailure(error, what), revert: null };
  return { ok: false, reason: revertReason(decoded, `The contract reverted without a known reason (${errorMessage(error)}).`), revert: decoded };
}

// ---------------------------------------------------------------------------------------------------------------
// Submission (the only wallet transaction request in the app)
// ---------------------------------------------------------------------------------------------------------------

export class WalletRejectedError extends Error {
  constructor() {
    super('The request was declined in the wallet.');
    this.name = 'WalletRejectedError';
  }
}

/** The wallet moved to another chain or account before signing: nothing is sent. */
export class WalletContextChangedError extends Error {
  readonly change: 'chain' | 'account';
  readonly walletChainId: number | null;
  constructor(change: 'chain' | 'account', walletChainId: number | null) {
    super(change === 'chain' ? 'The wallet is on another network than this request.' : 'The wallet account is not the account this request was prepared for.');
    this.name = 'WalletContextChangedError';
    this.change = change;
    this.walletChainId = walletChainId;
  }
}

export class WalletRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletRequestError';
  }
}

/** SH-258 round 3b: the sender's own refusal before the provider was asked (a gas limit or fee it will not send). */
export class PreSendRefusalError extends WalletRequestError {
  override readonly name = 'PreSendRefusalError';
  constructor(message: string, readonly chainId: number) { super(message); }
}

/**
 * The page's line for a refusal that never reached the provider (a price or gas-limit refusal), else null. Round 4:
 * on chain 97 only (where the price is read); every other chain's pages keep their earlier lines.
 */
export function preSendRefusalText(error: unknown): string | null {
  if (error instanceof NetworkPriceError) return error.message;
  return error instanceof PreSendRefusalError && readsGasPrice(error.chainId) ? error.message : null;
}

/**
 * The account cannot pay the most this send may cost (gasLimit × maxFeePerGas + value): nothing was sent. A
 * `WalletRequestError` whose message names insufficient funds, so a page that only knows the wallet's own refusal
 * still reads it as one.
 */
export class InsufficientGasFundsError extends WalletRequestError {
  readonly need: bigint;
  readonly balance: bigint;
  /** The chain the send was for (a page names its coin: SepETH on Sepolia). */
  readonly chainId: number;
  constructor(need: bigint, balance: bigint, chainId: number) {
    super(`Insufficient funds for gas: the account holds ${balance} wei and this send may cost up to ${need} wei; nothing was sent.`);
    this.name = 'InsufficientGasFundsError';
    this.need = need;
    this.balance = balance;
    this.chainId = chainId;
  }
}

/** The most a send may cost the account: gasLimit × maxFeePerGas + value. */
export const sendCostCap = (gasLimit: bigint, fees: SendFees, value: bigint): bigint => gasLimit * fees.maxFeePerGas + value;

export interface SubmitOptions extends SendFeeInput {
  readonly wallet: Eip1193Request;
  readonly deployment: WriteDeployment;
  readonly call: WriteCall;
  readonly expectedLedger: Address | null;
  readonly from: Address;
  readonly gasLimit: bigint;
}

export interface SetSubmitOptionsV2 extends SendFeeInput {
  readonly protocol: 'set-v2';
  readonly wallet: Eip1193Request;
  readonly target: SetTargetV2;
  readonly call: SetCallV2;
  readonly from: Address;
  readonly gasLimit: bigint;
}

export interface CoreV2SubmitOptions extends SendFeeInput {
  readonly protocol: 'core-v2';
  readonly wallet: Eip1193Request;
  readonly target: WriteTargetV2;
  readonly call: WriteCallV2;
  readonly from: Address;
  readonly gasLimit: bigint;
}

/**
 * Box 0's site actions (SH-BOX0-ACTIONS; packages/chain/src/core/box0-calls.ts): only a draw may carry value, exactly
 * the target's confirmed `drawValue` (SH-BOX0-DRAW-VALUE), at most `DRAW_VALUE_CAP`.
 */
export interface CoreV1Box0SubmitOptions extends SendFeeInput {
  readonly protocol: 'core-v1-box0';
  readonly wallet: Eip1193Request;
  readonly target: Box0Target;
  readonly call: Box0Call;
  readonly from: Address;
  readonly gasLimit: bigint;
}

/** Sends the prepared write through the wallet. Resolves with the transaction hash (NOT a confirmation). */
export async function submitWrite(options: SubmitOptions | CoreV2SubmitOptions | CoreV1Box0SubmitOptions | SetSubmitOptionsV2): Promise<TxHash> {
  const { wallet, from, gasLimit } = options;
  // Snapshot the checked payload before awaiting the wallet, so it cannot drift during its context reads.
  const call = { ...options.call };
  let chainId: number;
  // Zero unless an allowlist below accepted a draw's value (box 0's, or a core v2 draw's bounty).
  let value = 0n;
  if ('protocol' in options && options.protocol === 'set-v2') {
    assertSendableSetCallV2(call, options.target, from);
    if (gasLimit <= 0n || gasLimit > EIP7825_TX_GAS_CAP) throw new WalletRequestError('Set gas limit exceeds the transaction cap or is missing.');
    chainId = options.target.chainId;
  } else if ('protocol' in options && options.protocol === 'core-v1-box0') {
    assertSendableBox0Call(call, options.target, from);
    chainId = options.target.chainId;
    value = call.value;
  } else if ('protocol' in options) {
    assertSendableCallV2(call, options.target, from);
    chainId = options.target.chainId;
    // The v2 guard admits a value only on a draw, and only the prepared bounty; every other v2 write is refused with one.
    value = call.value;
  } else {
    assertSendableCall(options.call, options.deployment, options.expectedLedger);
    chainId = options.deployment.chainId;
  }
  return internalSendChecked(wallet, from, chainId, call, value, gasLimit, options);
}

/**
 * TA-22: one step of a box's creation (packages/chain/src/core/v2/create-send-v2.ts): the price coin's approval to the
 * factory, createBox, a chunk, a shop's starter item approvals (each committed item to the created shop) and loader
 * pages (SH-STARTER-GUARD), a seed's approval and pull, the starter loader's completion. The step must be an exact
 * step of the plan the site prepared from the validated spec and pinned chain facts; only createBox and a native pile
 * seed carry value, exactly the spec's. Resolves with the transaction hash (NOT a confirmation).
 */
export interface CreateSubmitOptionsV2 extends SendFeeInput {
  readonly wallet: Eip1193Request;
  readonly plan: CreateSendPlanV2;
  readonly call: WriteCallV2;
  readonly from: Address;
  readonly gasLimit: bigint;
  /**
   * SH-192: called once, after every check, right before the wallet is asked to send the step (in the same turn as that
   * request, so nothing runs in between). Create records there that a send may be in flight; a check that stops the
   * step first never calls it. What it throws ends the step as a wallet error, like the request it precedes.
   */
  readonly onSendRequest?: () => void;
  /**
   * SH-218 rail 2: the Create switches' last check, required. Awaited for the factory payment approval and for createBox
   * only (classified from the plan's own steps, never from a label the caller gives), after the fee, balance and wallet
   * reads and right before `onSendRequest` and the send request, outside the wallet's error handling: what it throws is
   * thrown as it is, nothing is sent and the send is never marked uncertain. A created box's later steps (chunks,
   * starter items, seed, completion) never ask it.
   */
  readonly createOptionsCheck: (plan: CreateSendPlanV2) => Promise<void>;
}

/**
 * Whether `call` is one of the plan's steps up to and including createBox (the factory payment and createBox itself),
 * by exact target, value and bytes; every later step belongs to a created box. A plan in which no createBox is found
 * has no created box to finish: every step of it is asked.
 */
function opensBox(call: WriteCallV2, plan: CreateSendPlanV2): boolean {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const steps = createStepsV2(plan);
  const box = steps.findIndex((step) => step.kind === 'createBox');
  if (box < 0) return true;
  return steps.slice(0, box + 1).some((step) => same(step.to, call.to) && step.value === call.value && same(step.data, call.data));
}

export async function submitCreateWriteV2(options: CreateSubmitOptionsV2): Promise<TxHash> {
  // A caller without the switches' check cannot send any creation step (no optional bypass).
  if (typeof options.createOptionsCheck !== 'function') throw new NotSendableError('no Create options check; nothing was sent');
  const call = { ...options.call };
  assertSendableCreateStepV2(call, options.plan, options.from, options.plan.chainId);
  if (options.gasLimit <= 0n) throw new WalletRequestError('No gas limit for this step; nothing was sent.');
  const check = options.createOptionsCheck;
  const plan = options.plan;
  const beforeRequest = opensBox(call, plan) ? () => check(plan) : undefined;
  return internalSendChecked(options.wallet, options.from, options.plan.chainId, call, call.value, options.gasLimit, options, options.onSendRequest, beforeRequest);
}

export interface SetCreateSubmitOptionsV2 extends SendFeeInput {
  readonly wallet: Eip1193Request; readonly plan: SetCreatePlanV2; readonly call: SetCallV2;
  readonly from: Address; readonly gasLimit: bigint;
}
export async function submitSetCreateWrite(options: SetCreateSubmitOptionsV2): Promise<TxHash> {
  const call = {...options.call};
  assertSendableSetCreate(call, options.plan, options.from);
  if (options.gasLimit <= 0n || options.gasLimit > EIP7825_TX_GAS_CAP) throw new WalletRequestError('Set creation gas limit exceeds cap or is missing.');
  return internalSendChecked(options.wallet, options.from, options.plan.chainId, call, call.value, options.gasLimit, options);
}

/**
 * Internal: only the isolated Sepolia trade folder may import this primitive, after its guard passes.
 * Other callers use the guarded submission APIs above; do not re-export this from a public barrel.
 * The wallet must still be on `chainId` with `from`; then ONE `eth_sendTransaction` of the checked call.
 *
 * SH-SEND-FEES: the send carries maxFeePerGas and maxPriorityFeePerGas (hex quantities, no gasPrice), the shown fee
 * when one is given, else `readSendFees` from the app's RPC now. A wallet left to pick its own fee may pick a cap far
 * above the network's (Privy's did on 2026-11-02) and then refuse an account that cannot hold gasLimit × that cap.
 * Before the wallet is asked, the account's balance must cover gasLimit × maxFeePerGas + value
 * (`InsufficientGasFundsError` otherwise). A fee or balance that cannot be read stops the send (`RpcRequestError`).
 * `onSendRequest`, when given, runs right before the send request, after all of these checks.
 * `beforeRequest`, when given (SH-218 rail 2: creation's switches check), is awaited after the wallet reads and before
 * `onSendRequest`, outside the wallet's error handling: what it throws stops the send as it is.
 */
export async function internalSendChecked(wallet: Eip1193Request, from: Address, chainId: number, call: { readonly to: Address; readonly data: `0x${string}` }, value: bigint, gasLimit: bigint, fees: SendFeeInput, onSendRequest?: () => void, beforeRequest?: () => Promise<void>): Promise<TxHash> {
  let sendFees: SendFees;
  let balance: bigint;
  try {
    [sendFees, balance] = await Promise.all([
      (async () => fees.fee ?? readSendFees(fees.feeReader, chainId))(),
      (async () => fees.feeReader.getBalance(from, 'latest'))(),
    ]);
  } catch (error) {
    if (error instanceof NetworkPriceError) throw error;
    throw new RpcRequestError(`The network fee or the account's balance could not be read (${errorMessage(error)}); nothing was sent.`, null, undefined);
  }
  if (sendFees.maxPriorityFeePerGas <= 0n || sendFees.maxFeePerGas < sendFees.maxPriorityFeePerGas) throw new PreSendRefusalError('The network fee is not a valid EIP-1559 fee; nothing was sent.', chainId);
  // SH-258 fix round 2: the one wallet boundary of every path holds the per-transaction gas cap: a limit above it (an
  // estimate plus its margin that cannot fit) is refused here, never handed to the wallet.
  if (gasLimit <= 0n) throw new PreSendRefusalError('No valid gas estimate for this transaction; nothing was sent.', chainId);
  if (gasLimit > EIP7825_TX_GAS_CAP) throw new PreSendRefusalError(marginLine(EIP7825_TX_GAS_CAP), chainId);
  const need = sendCostCap(gasLimit, sendFees, value);
  if (balance < need) throw new InsufficientGasFundsError(need, balance, chainId);
  let walletChainId: number | null;
  let accounts: Address[];
  try {
    walletChainId = parseChainId(await wallet({ method: 'eth_chainId' }));
    accounts = parseAccounts(await wallet({ method: 'eth_accounts' }));
  } catch (error) {
    throw new WalletRequestError(`The wallet could not be read: ${errorMessage(error)}`);
  }
  if (walletChainId !== chainId) throw new WalletContextChangedError('chain', walletChainId);
  if (!accounts.some((account) => account.toLowerCase() === from.toLowerCase())) throw new WalletContextChangedError('account', walletChainId);
  if (beforeRequest) await beforeRequest();
  // SH-258 fix round 3: on a chain whose price floors the fee, both fields are checked against a fresh price at this
  // last point (after every estimate, simulation and wait of the caller and the checks above), a fee set earlier too
  // (reveals). A fee now under the price stops the send with the new price; nothing is raised past what was approved.
  if (readsGasPrice(chainId)) {
    const fresh = checkedPrice(fees.feeReader.gasPrice ? await fees.feeReader.gasPrice().catch(() => null) : null, policyOf(chainId).ceilingWei);
    if (sendFees.maxPriorityFeePerGas < fresh || sendFees.maxFeePerGas < fresh) throw new NetworkPriceError('rose', fresh);
  }
  let hash: unknown;
  try {
    // `chainId` names the checked chain in the transaction itself: a wallet switched between the check above and this
    // request (time of check / time of use) refuses it instead of signing it for another chain.
    onSendRequest?.();
    hash = await wallet({
      method: 'eth_sendTransaction',
      params: [{
        from, to: call.to, data: call.data, value: toQuantity(value), gas: toQuantity(gasLimit),
        maxFeePerGas: toQuantity(sendFees.maxFeePerGas), maxPriorityFeePerGas: toQuantity(sendFees.maxPriorityFeePerGas),
        chainId: toQuantity(BigInt(chainId)),
      }],
    });
  } catch (error) {
    if (isUserRejection(error)) throw new WalletRejectedError();
    throw new WalletRequestError(`The wallet returned an error: ${errorMessage(error)}`);
  }
  if (!isTxHashValue(hash)) throw new WalletRequestError('The wallet returned something that is not a transaction hash; nothing is tracked.');
  return hash;
}

// ---------------------------------------------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------------------------------------------

export type ReplacementKind = 'repriced' | 'cancelled' | 'replaced';

export interface ReplacementInfo {
  readonly hash: TxHash;
  /** repriced: same call with a new fee (speed-up); cancelled: an empty self-transfer; replaced: anything else. */
  readonly kind: ReplacementKind;
  readonly blockNumber: bigint | null;
}

export type TrackerEnd = 'finalized' | 'reverted' | 'replaced' | 'timed_out' | 'unknown' | 'stopped';

export interface TrackerOptions<R = unknown> {
  readonly reader: ChainReader;
  readonly chain: WriteChain;
  readonly hash: TxHash;
  readonly from: Address;
  /** The block the chain was at when the wallet returned the hash (replacement scans start here). */
  readonly startBlock: bigint;
  readonly verify: WriteVerifier<R> | null;
  readonly emit: (event: TxEvent) => void;
  readonly onResult?: (result: R) => void;
  readonly onReplacement?: (replacement: ReplacementInfo) => void;
  readonly onEnd?: (end: TrackerEnd) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Consecutive failed reads before `unknown` (default 5). */
  readonly maxReadFailures?: number;
  /** Blocks scanned backwards from the latest block for a replacement (default 256). */
  readonly replacementScanLimit?: number;
  /**
   * The account's pending nonce read just before the wallet request, and the call sent. Used only when the RPC never
   * showed our transaction (a speed-up can replace it before the first read): a mined transaction from the same account
   * at that nonce with the SAME call is then taken as its speed-up; anything else is left to the timeout.
   */
  readonly nonceHint?: bigint | null;
  readonly call?: { readonly to: Address; readonly data: `0x${string}` } | null;
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

/**
 * Follows one transaction hash until it is finalized, reverted, replaced, timed out or unknown. `recheck()` resumes a
 * timed-out or unknown transaction (late inclusion is still tracked); `stop()` ends it silently.
 */
export class TxTracker<R = unknown> {
  private readonly o: TrackerOptions<R>;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private controller = new AbortController();
  private phase: 'pending' | 'included' | 'ended' = 'pending';
  private seen = false;
  private nonce: bigint | null = null;
  /** Our transaction as the RPC first showed it (to classify a replacement: the node drops it once replaced). */
  private original: RpcTransaction | null = null;
  /** The nonce hint was checked once and matched no same-call speed-up (not rescanned every poll). */
  private hintSettled = false;
  private included: TxReceipt | null = null;
  private failures = 0;
  private startedAt: number;
  private running = false;
  private end: TrackerEnd | null = null;

  constructor(options: TrackerOptions<R>) {
    this.o = options;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.startedAt = this.now();
  }

  get ended(): TrackerEnd | null {
    return this.end;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop(this.controller.signal);
  }

  stop(): void {
    this.controller.abort();
    this.running = false;
    this.finish('stopped');
  }

  /** Re-reads the hash after `timed_out` / `unknown` and keeps tracking (another full wait). */
  recheck(): void {
    if (this.end !== 'timed_out' && this.end !== 'unknown') return;
    this.controller = new AbortController();
    this.end = null;
    this.phase = 'pending';
    this.failures = 0;
    this.startedAt = this.now();
    this.running = false;
    this.start();
  }

  private isEnded(): boolean {
    return this.phase === 'ended';
  }

  private finish(end: TrackerEnd): void {
    if (this.end !== null && end === 'stopped') return;
    this.phase = 'ended';
    this.end = end;
    this.running = false;
    this.o.onEnd?.(end);
  }

  private async loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.isEnded()) {
      try {
        if (this.phase === 'pending') await this.tickPending(signal);
        else if (this.phase === 'included') await this.tickIncluded(signal);
      } catch (error) {
        // A malformed response or a verifier that threw: one failed read.
        if (!signal.aborted) this.readFailed(error);
      }
      if (signal.aborted || this.isEnded()) break;
      await this.sleep(this.o.chain.pollIntervalMs, signal);
    }
  }

  private emit(event: TxEvent, signal: AbortSignal): void {
    if (!signal.aborted) this.o.emit(event);
  }

  private readFailed(error: unknown): void {
    this.failures += 1;
    if (this.phase === 'pending' && this.failures >= (this.o.maxReadFailures ?? 5)) {
      this.o.emit({ type: 'status_unknown', reason: `The chain could not be read (${errorMessage(error)}). The transaction may or may not be included.` });
      this.finish('unknown');
    }
  }

  private async tickPending(signal: AbortSignal): Promise<void> {
    const receipt = await this.o.reader.getReceipt(this.o.hash);
    if (signal.aborted) return;
    this.failures = 0;
    if (receipt !== null) {
      await this.onReceipt(receipt, signal);
      return;
    }
    if (!this.seen) {
      const tx = await this.o.reader.getTransaction(this.o.hash);
      if (signal.aborted) return;
      if (tx !== null) {
        if (tx.from.toLowerCase() !== this.o.from.toLowerCase()) {
          this.emit({ type: 'status_unknown', reason: 'The RPC reports this hash from another sender; it is not tracked.' }, signal);
          this.finish('unknown');
          return;
        }
        this.seen = true;
        this.nonce = tx.nonce;
        this.original = tx;
        this.emit({ type: 'broadcast' }, signal);
      }
    }
    const nonce = this.nonce ?? (this.hintSettled ? null : (this.o.nonceHint ?? null));
    if (nonce !== null) {
      const latestNonce = await this.o.reader.getTransactionCount(this.o.from, 'latest');
      if (signal.aborted) return;
      if (latestNonce > nonce) {
        // The nonce is used. Our own receipt may have landed between the two reads.
        const again = await this.o.reader.getReceipt(this.o.hash);
        if (signal.aborted) return;
        if (again !== null) {
          await this.onReceipt(again, signal);
          return;
        }
        const replacement = await this.findReplacement(nonce, signal);
        if (signal.aborted) return;
        if (this.nonce === null) {
          // Only a hint: accept nothing but a same-call speed-up; otherwise keep waiting (the timeout decides).
          if (replacement !== null && replacement.kind === 'repriced') this.replaced(replacement, signal);
          else this.hintSettled = true;
        } else if (replacement !== null) {
          this.replaced(replacement, signal);
        } else {
          this.emit({ type: 'status_unknown', reason: `Nonce ${nonce} was used by another transaction that could not be found in the recent blocks.` }, signal);
          this.finish('unknown');
        }
        if (this.isEnded()) return;
      }
    }
    if (this.now() - this.startedAt >= this.o.chain.receiptTimeoutMs) {
      this.emit({ type: 'timeout' }, signal);
      this.finish('timed_out');
    }
  }

  private replaced(replacement: ReplacementInfo, signal: AbortSignal): void {
    this.o.onReplacement?.(replacement);
    this.emit({ type: 'replaced', newHash: replacement.hash }, signal);
    this.finish('replaced');
  }

  private async onReceipt(receipt: TxReceipt, signal: AbortSignal): Promise<void> {
    if (receipt.from.toLowerCase() !== this.o.from.toLowerCase()) {
      this.emit({ type: 'status_unknown', reason: 'The receipt is from another sender; it is not tracked.' }, signal);
      this.finish('unknown');
      return;
    }
    if (receipt.status === 'reverted') {
      const reason = await this.replayReason(receipt);
      if (signal.aborted) return;
      this.emit({ type: 'reverted', reason }, signal);
      this.finish('reverted');
      return;
    }
    if (this.o.verify) {
      const outcome = await this.o.verify(receipt, this.o.reader, 'included');
      if (signal.aborted) return;
      if (!outcome.ok) {
        this.emit({ type: 'status_unknown', reason: `Included, but the result could not be verified: ${outcome.reason}` }, signal);
        this.finish('unknown');
        return;
      }
    }
    if (!this.seen) {
      this.seen = true;
      this.emit({ type: 'broadcast' }, signal);
    }
    this.included = receipt;
    this.phase = 'included';
    this.emit({ type: 'included', block: receipt.blockNumber.toString() }, signal);
  }

  private reorged(signal: AbortSignal): void {
    this.included = null;
    this.phase = 'pending';
    this.startedAt = this.now();
    this.emit({ type: 'reorged' }, signal);
  }

  private async tickIncluded(signal: AbortSignal): Promise<void> {
    const included = this.included;
    if (included === null) {
      this.phase = 'pending';
      return;
    }
    const receipt = await this.o.reader.getReceipt(this.o.hash);
    if (signal.aborted) return;
    if (receipt === null || receipt.blockHash !== included.blockHash) {
      // Gone, or moved to another block: back to pending; the next tick picks up the new receipt (if any).
      this.reorged(signal);
      return;
    }
    const { finality } = this.o.chain;
    let final: boolean;
    if (finality.kind === 'finalized_tag') {
      const finalized = await this.o.reader.getBlock('finalized');
      final = finalized !== null && finalized.number >= receipt.blockNumber;
    } else {
      const latest = await this.o.reader.blockNumber();
      final = latest >= receipt.blockNumber + BigInt(finality.confirmations);
    }
    if (signal.aborted || !final) return;
    const canonical = await this.o.reader.getBlock(receipt.blockNumber);
    if (signal.aborted) return;
    if (canonical === null || canonical.hash !== receipt.blockHash) {
      this.reorged(signal);
      return;
    }
    if (this.o.verify) {
      const outcome = await this.o.verify(receipt, this.o.reader, 'finalized');
      if (signal.aborted) return;
      if (!outcome.ok) {
        // The reducer only leaves confirmed_unfinalized by finality or a reorg: report it as unknown via pending.
        this.emit({ type: 'reorged' }, signal);
        this.emit({ type: 'status_unknown', reason: `Final, but the result did not verify: ${outcome.reason}` }, signal);
        this.finish('unknown');
        return;
      }
      this.o.onResult?.(outcome.result);
    }
    this.emit({ type: 'finalized' }, signal);
    this.finish('finalized');
  }

  /** Best effort: replays the call at the parent block to recover the reason (earlier transactions may differ). */
  private async replayReason(receipt: TxReceipt): Promise<string> {
    const tx: RpcTransaction | null = await this.o.reader.getTransaction(this.o.hash).catch(() => null);
    if (tx === null || tx.to === null) return 'Reverted on chain; the reason could not be read.';
    try {
      await this.o.reader.call({ from: tx.from, to: tx.to, data: tx.input, value: tx.value, gas: tx.gas }, receipt.blockNumber - 1n);
      return 'Reverted on chain. Replaying it before its block succeeded, so the reason depends on transactions earlier in the same block.';
    } catch (error) {
      const data = revertDataOf(error);
      return revertReason(data ? decodeRevert(data) : null, 'Reverted on chain; the reason could not be decoded.');
    }
  }

  private async findReplacement(nonce: bigint, signal: AbortSignal): Promise<ReplacementInfo | null> {
    const latest = await this.o.reader.blockNumber();
    const limit = BigInt(this.o.replacementScanLimit ?? 256);
    const floor = latest - limit + 1n > this.o.startBlock ? latest - limit + 1n : this.o.startBlock;
    const original = this.original ?? (this.o.call ? { to: this.o.call.to, input: this.o.call.data, value: 0n } : null);
    for (let n = latest; n >= floor && n >= 0n; n -= 1n) {
      if (signal.aborted) return null;
      const block = await this.o.reader.getBlock(n, true);
      if (block === null) continue;
      for (const tx of block.transactions) {
        if (typeof tx === 'string') continue;
        if (tx.from.toLowerCase() !== this.o.from.toLowerCase() || tx.nonce !== nonce || tx.hash.toLowerCase() === this.o.hash.toLowerCase()) continue;
        let kind: ReplacementKind = 'replaced';
        if (original !== null && tx.to?.toLowerCase() === original.to?.toLowerCase() && tx.input.toLowerCase() === original.input.toLowerCase() && tx.value === original.value) kind = 'repriced';
        else if (tx.to?.toLowerCase() === this.o.from.toLowerCase() && tx.input === '0x' && tx.value === 0n) kind = 'cancelled';
        return Object.freeze({ hash: tx.hash, kind, blockNumber: block.number });
      }
    }
    return null;
  }
}
