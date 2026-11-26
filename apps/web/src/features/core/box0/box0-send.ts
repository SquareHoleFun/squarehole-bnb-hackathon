/**
 * Box 0's checked sends (SH-BOX0-ACTIONS). Each runs only after the holder's click: the wallet's chain and account, fresh
 * chain reads for the contract's own guard, a simulation and an estimate, the wallet checked again, then ONE
 * allowlisted call through `submitWrite` (protocol `core-v1-box0`), and its receipt. Nothing here reads the wallet
 * before the click; the panel creates the IO only then.
 */
import { box0Calls, drawLimitFor, drawValueFor, type Box0Call, type Box0Target } from '@squarehole/chain';
// SH-BOX0-EXITS adds the ways out of a stopped draw: cancel-draw, hand-back and take (by number). There is no stop step:
// the page never sends enterTerminal (F142, desk R61-STOP "hide").
import { boxTicketsAbi, boxVaultAbi } from '@squarehole/chain/abi';
import { InsufficientGasFundsError, NotSendableError, WalletRejectedError, WalletRequestError, createChainReader, createHttpRequest, submitWrite, type SendFeeReader } from '@squarehole/chain/write';
import type { Eip1193Request } from '@squarehole/chain/write/wallet';
import { BaseError, ExecutionRevertedError, createPublicClient, decodeEventLog, erc20Abi, http, type Abi, type Address, type Hex } from 'viem';
import { gasFundsLine } from '../../tx/gas-words';
import { DRAW, PHASE, REVEAL_GRACE, TAKE_DELAY } from './box0-model';

/** The box 0 roles a send needs: the allowlist's, plus the vault (its quote). */
export interface Box0Roles extends Box0Target {
  readonly vault: Address;
}

export type Box0Step =
  | { readonly kind: 'approve-fit'; readonly amount: bigint }
  /** `value`: the ETH the drawer confirmed (the plan's, as the page showed it), sent exactly (SH-BOX0-DRAW-VALUE). */
  | { readonly kind: 'draw'; readonly limit: bigint; readonly value: bigint }
  | { readonly kind: 'open-draw'; readonly ticket: bigint }
  | { readonly kind: 'open'; readonly tokenId: bigint }
  | { readonly kind: 'approve-service'; readonly tokenId: bigint }
  | { readonly kind: 'claim'; readonly ids: readonly bigint[] }
  | { readonly kind: 'cancel-draw'; readonly ticket: bigint }
  | { readonly kind: 'hand-back'; readonly tokenId: bigint; readonly min: bigint }
  | { readonly kind: 'take'; readonly itemId: bigint; readonly poolIndex: bigint; readonly limit: bigint };

export type Box0Read = 'phase' | 'status' | 'quoteTake' | 'quoteHandBack' | 'allowance' | 'balanceOf' | 'drawTicket' | 'ownerOf' | 'isHidden';

export interface Box0Log {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
}

export interface Box0IO {
  chainId(): Promise<number>;
  readonly request: Eip1193Request;
  read(to: Address, fn: Box0Read, args?: readonly unknown[]): Promise<unknown>;
  /** The latest block: its time, and its base fee (null: none, or not a canonical quantity; never read as 0). */
  block(): Promise<{ readonly timestamp: bigint; readonly baseFee: bigint | null }>;
  simulate(call: Box0Call, account: Address): Promise<void>;
  estimate(call: Box0Call, account: Address): Promise<bigint>;
  receipt(hash: Hex): Promise<{ readonly status: 'success' | 'reverted'; readonly logs: readonly Box0Log[] }>;
  readonly submit: typeof submitWrite;
  /** SH-SEND-FEES: the box RPC's fee and balance reads the send carries. */
  readonly feeReader: SendFeeReader;
}

/** A draw's deadline: 30 minutes after the latest block. */
const DRAW_DEADLINE_SECONDS = 1_800n;
const GAS_MARGIN_FLOOR = 300_000n;

/**
 * The gas limit sent: the estimate plus the larger of a fifth and 300,000. The vault's and the collection's observers
 * refuse a call that leaves them less than their cap (ObserverGasTooLow), so a draw or an open keeps a wide margin.
 */
export function gasLimitForBox0(estimate: bigint): bigint {
  const margin = estimate / 5n > GAS_MARGIN_FLOOR ? estimate / 5n : GAS_MARGIN_FLOOR;
  // SH-258 round 3: the full limit; one above 16,777,216 is refused at the sender's guard, never clipped to fit.
  return estimate + margin;
}

const ABIS: Readonly<Record<Box0Read, Abi>> = {
  phase: boxTicketsAbi,
  status: boxTicketsAbi,
  drawTicket: boxTicketsAbi,
  ownerOf: boxTicketsAbi,
  quoteTake: boxVaultAbi,
  quoteHandBack: boxVaultAbi,
  isHidden: boxVaultAbi,
  allowance: erc20Abi,
  balanceOf: erc20Abi,
};

/**
 * A JSON-RPC quantity in its canonical form (the execution API's `uint`): "0x0", or "0x" and up to 64 lowercase hex
 * digits without a leading zero.
 */
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/;

/**
 * SH-BOX0-DRAW-VALUE fix round 1 (F1): a quantity from the node's own JSON answer, as a bigint, or null for anything that
 * is not a string in the canonical form (absent, null, `true`, a JSON number, whitespace, "0x", "0x01", "0X1"). viem's
 * block formatter turns several of those into numbers (`true` → 1n, " " → 0n), so the raw answer is read instead.
 */
export function quantityOf(raw: unknown): bigint | null {
  return typeof raw === 'string' && QUANTITY.test(raw) ? BigInt(raw) : null;
}

/** The node gave no latest block, or one whose time is not a canonical quantity: no step is prepared on it. */
class BlockUnreadError extends Error {
  constructor() {
    super('Nothing confirmed. Try again.');
    this.name = 'BlockUnreadError';
  }
}

/** The default IO: the box's RPC for reads, the connected wallet for the one send. */
export function box0IO(rpcUrl: string, request: Eip1193Request): Box0IO {
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 0 }) });
  return {
    chainId: () => client.getChainId(),
    request,
    read: (to, fn, args = []) => client.readContract({ address: to, abi: ABIS[fn], functionName: fn, args } as never),
    block: async () => {
      // Fix round 1 (F1): the node's own answer through the same transport, not viem's formatted block. One read gives
      // the block's time, which every step needs, and its base fee, which only a draw needs.
      const raw: unknown = await client.request({ method: 'eth_getBlockByNumber', params: ['latest', false] });
      const fields = typeof raw === 'object' && raw !== null ? (raw as { timestamp?: unknown; baseFeePerGas?: unknown }) : {};
      const timestamp = quantityOf(fields.timestamp);
      if (timestamp === null) throw new BlockUnreadError();
      // A missing or malformed base fee is null, never a number; a draw refuses it (`drawBlock`), the other steps ignore it.
      return { timestamp, baseFee: quantityOf(fields.baseFeePerGas) };
    },
    simulate: async (call, account) => {
      await client.call({ to: call.to, data: call.data, value: call.value, account });
    },
    estimate: (call, account) => client.estimateGas({ to: call.to, data: call.data, value: call.value, account }),
    receipt: async (hash) => {
      const r = await client.waitForTransactionReceipt({ hash });
      return { status: r.status, logs: r.logs.map((log) => ({ address: log.address, topics: log.topics as Hex[], data: log.data })) };
    },
    submit: submitWrite,
    feeReader: createChainReader(createHttpRequest(rpcUrl)),
  };
}

/** The wallet sent the transaction, but its receipt was not read (a timeout, the RPC down): it may still be mined. */
export class Box0UnconfirmedError extends Error {
  constructor() {
    super('Sent, but not confirmed. Check your wallet before trying again.');
    this.name = 'Box0UnconfirmedError';
  }
}

/** SH-BOX0-DRAW-VALUE: the latest block's base fee could not be read as a fee. No draw is prepared or sent on it. */
export class FeeUnavailableError extends Error {
  constructor() {
    super('Network fee unavailable. Try again.');
    this.name = 'FeeUnavailableError';
  }
}

/**
 * SH-BOX0-DRAW-VALUE: a block's base fee as a draw needs it, a nonnegative whole number of wei. An explicit 0 is a fee
 * (a local chain). A missing one (null: no EIP-1559 fee) or a malformed one is refused, never read as 0.
 */
export function baseFeeOf(value: unknown): bigint {
  if (typeof value !== 'bigint' || value < 0n) throw new FeeUnavailableError();
  return value;
}

/** SH-BOX0-DRAW-VALUE: the ETH the drawer confirmed no longer covers the round at the fee now. Nothing was sent. */
export class DrawValueRoseError extends Error {
  constructor() {
    super('The network fee rose. Check the new amount and confirm again.');
    this.name = 'DrawValueRoseError';
  }
}

/** The step of a draw's ETH: 0.0001 ETH, the four decimals the page shows it with. */
const DRAW_VALUE_STEP = 10n ** 14n;

/**
 * SH-BOX0-DRAW-VALUE: the ETH a draw sends at `baseFee`, and the amount its confirmation shows. `drawValueFor` rounded UP
 * to 0.0001 ETH, so the page's four decimals are exactly the amount the wallet is asked for. Never below the round's
 * basis; never above DRAW_VALUE_CAP (0.12 ETH, a whole number of steps). The unused part comes back in the same call to
 * a wallet that accepts ETH; when the wallet refuses it, the round's pot keeps all of it (`DrandWords.payRound`).
 */
export function drawValueAt(baseFee: bigint): bigint {
  const value = drawValueFor(baseFee);
  return ((value + DRAW_VALUE_STEP - 1n) / DRAW_VALUE_STEP) * DRAW_VALUE_STEP;
}

const refused = (error: unknown): boolean => error instanceof BaseError && error.walk((cause) => cause instanceof ExecutionRevertedError) !== null;

/**
 * One plain line for a failed step (review of SH-BOX0-ACTIONS): the page never shows a library's message (addresses,
 * calldata, request bodies). Our own guards' lines pass through; a refusal by the chain, a declined request and a
 * send whose outcome is unknown each get their own line.
 */
export function box0ErrorText(error: unknown): string {
  if (error instanceof NotSendableError) return 'Not sent. Nothing reached your wallet.';
  if (error instanceof WalletRejectedError) return 'Declined in your wallet. Nothing was sent.';
  if (error instanceof Box0UnconfirmedError) return error.message;
  if (error instanceof InsufficientGasFundsError) return gasFundsLine(error.chainId);
  if (error instanceof WalletRequestError) return 'Not confirmed. Check your wallet before trying again.';
  if (refused(error)) return 'The box refused this now. Nothing was sent.';
  if (error instanceof Error && error.message && !(error instanceof BaseError)) return error.message;
  return 'Nothing confirmed. Try again.';
}

/** The wallet is on the box's network and still on `account`: checked before the reads and again right before sending. */
async function identity(roles: Box0Roles, account: Address, io: Pick<Box0IO, 'chainId' | 'request'>): Promise<void> {
  const [network, walletNetwork, accounts] = await Promise.all([io.chainId(), io.request({ method: 'eth_chainId' }), io.request({ method: 'eth_accounts' })]);
  if (network !== roles.chainId || typeof walletNetwork !== 'string' || BigInt(walletNetwork) !== BigInt(roles.chainId)) throw new Error('Wrong network');
  if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || accounts[0].toLowerCase() !== account.toLowerCase()) throw new Error('Wallet changed; confirm again');
}

const sameAddress = (a: unknown, b: Address): boolean => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

async function quoteOne(roles: Box0Roles, io: Box0IO): Promise<bigint> {
  const quote = await io.read(roles.vault, 'quoteTake', [1n]);
  if (!Array.isArray(quote) || typeof quote[0] !== 'bigint' || typeof quote[1] !== 'bigint') throw new Error('No draw quote now');
  return quote[0] + quote[1];
}

async function drawing(roles: Box0Roles, io: Box0IO): Promise<void> {
  const phase = Number(await io.read(roles.tickets, 'phase'));
  if (phase !== PHASE.AwaitingWord && phase !== PHASE.Drawing) throw new Error('The box is not drawing now');
}

/**
 * SH-BOX0-DRAW-VALUE: the latest block for a draw, its base fee read as a fee. A missing or malformed one (null from the
 * block reader) is refused; a block that could not be read fails as any read does.
 */
async function drawBlock(io: Box0IO): Promise<{ readonly timestamp: bigint; readonly baseFee: bigint }> {
  const block = await io.block();
  return { timestamp: block.timestamp, baseFee: baseFeeOf(block.baseFee) };
}

const asBig = (v: unknown): bigint => (typeof v === 'bigint' ? v : typeof v === 'number' ? BigInt(v) : 0n);

async function ticketTimes(roles: Box0Roles, io: Box0IO): Promise<{ readonly wordAcceptedAt: bigint; readonly terminalAt: bigint }> {
  const status = (await io.read(roles.tickets, 'status')) as { wordAcceptedAt?: unknown; terminalAt?: unknown } | null;
  return { wordAcceptedAt: asBig(status?.wordAcceptedAt), terminalAt: asBig(status?.terminalAt) };
}

async function wordAcceptedAt(roles: Box0Roles, io: Box0IO): Promise<bigint> {
  return (await ticketTimes(roles, io)).wordAcceptedAt;
}

async function stopped(roles: Box0Roles, io: Box0IO): Promise<void> {
  if (Number(await io.read(roles.tickets, 'phase')) !== PHASE.Terminal) throw new Error('Draws have not stopped');
}

/** The FIT one ticket's release pays now (`quoteHandBack(1)`: principal less its fee, 0 after graduation). */
async function refundOne(roles: Box0Roles, io: Box0IO): Promise<bigint> {
  const quote = await io.read(roles.vault, 'quoteHandBack', [1n]);
  if (!Array.isArray(quote) || typeof quote[0] !== 'bigint' || typeof quote[1] !== 'bigint') throw new Error('No amount now');
  return quote[0] - quote[1];
}

export interface DrawPlan {
  /** The chain's quote for one: principal + 1% draw fee. */
  readonly quote: bigint;
  /** The most the draw may take: the quote plus 1%. */
  readonly limit: bigint;
  readonly needsApproval: boolean;
  /** The wallet holds less FIT than the price the draw takes now (the quote; the limit only bounds a price move). */
  readonly short: boolean;
  /**
   * ETH sent with the draw for its drand round: the amount the confirmation shows, and exactly the one sent once
   * confirmed (`drawValueAt`, SH-BOX0-DRAW-VALUE). All but the round's top-up comes back in the same transaction.
   */
  readonly value: bigint;
}

/** What a draw would take now, read after the click (no wallet request). No draw without a base fee read as a fee. */
export async function prepareDraw(roles: Box0Roles, account: Address, io: Box0IO): Promise<DrawPlan> {
  await drawing(roles, io);
  const quote = await quoteOne(roles, io);
  const limit = drawLimitFor(quote);
  const [allowance, balance, block] = await Promise.all([io.read(roles.token, 'allowance', [account, roles.tickets]), io.read(roles.token, 'balanceOf', [account]), drawBlock(io)]);
  if (typeof allowance !== 'bigint' || typeof balance !== 'bigint') throw new Error('FIT balance unavailable');
  return { quote, limit, needsApproval: allowance < limit, short: balance < quote, value: drawValueAt(block.baseFee) };
}

export interface TakePlan {
  readonly quote: bigint;
  readonly limit: bigint;
  readonly needsApproval: boolean;
  readonly short: boolean;
}

/** Terminal mode and the 3 days after the stop have passed (`takeByNumber`'s TooEarly). */
async function takeOpen(roles: Box0Roles, io: Box0IO): Promise<bigint> {
  await stopped(roles, io);
  const [{ terminalAt }, { timestamp }] = await Promise.all([ticketTimes(roles, io), io.block()]);
  if (terminalAt === 0n || timestamp < terminalAt + TAKE_DELAY) throw new Error('Not yet: taking opens 3 days after draws stopped');
  return timestamp;
}

/** What a take by number would take now, read after the click (no wallet request): the draw's price and limit. */
export async function prepareTake(roles: Box0Roles, account: Address, io: Box0IO): Promise<TakePlan> {
  await takeOpen(roles, io);
  const quote = await quoteOne(roles, io);
  const limit = drawLimitFor(quote);
  const [allowance, balance] = await Promise.all([io.read(roles.token, 'allowance', [account, roles.tickets]), io.read(roles.token, 'balanceOf', [account])]);
  if (typeof allowance !== 'bigint' || typeof balance !== 'bigint') throw new Error('FIT balance unavailable');
  return { quote, limit, needsApproval: allowance < limit, short: balance < quote };
}

/** Builds the step's call after the contract's own guards, re-read now. */
async function prepared(roles: Box0Roles, account: Address, step: Box0Step, io: Box0IO): Promise<Box0Call> {
  switch (step.kind) {
    case 'approve-fit':
      if (step.amount <= 0n) throw new Error('Nothing to approve');
      return box0Calls.approveFit(roles, step.amount);
    case 'draw': {
      await drawing(roles, io);
      const quote = await quoteOne(roles, io);
      if (quote > step.limit) throw new Error('The price moved; check the new price');
      const [allowance, balance, block] = await Promise.all([io.read(roles.token, 'allowance', [account, roles.tickets]), io.read(roles.token, 'balanceOf', [account]), drawBlock(io)]);
      if (typeof allowance !== 'bigint' || allowance < step.limit) throw new Error('Approve FIT first');
      // The contract pulls the quote at inclusion; a balance between the quote and the limit is enough.
      if (typeof balance !== 'bigint' || balance < quote) throw new Error('Not enough FIT');
      // SH-BOX0-DRAW-VALUE: exactly the confirmed ETH, in the call and in the guard's target (`sendBox0`). A fee that now
      // needs more stops here, before the wallet: the page shows the new amount for a new confirmation. A fee that needs
      // less still sends the confirmed amount; the contract sends the rest back.
      if (drawValueFor(block.baseFee) > step.value) throw new DrawValueRoseError();
      return box0Calls.draw(roles, step.limit, block.timestamp + DRAW_DEADLINE_SECONDS, step.value);
    }
    case 'open-draw': {
      const d = (await io.read(roles.tickets, 'drawTicket', [step.ticket])) as { drawer?: unknown; status?: unknown; revealFallbackAt?: unknown } | null;
      if (!d || !sameAddress(d.drawer, account)) throw new Error('Not your draw');
      if (Number(d.status) !== DRAW.Settled || typeof d.revealFallbackAt !== 'bigint') throw new Error('This draw has no number yet');
      const { timestamp } = await io.block();
      if (timestamp < d.revealFallbackAt) throw new Error('Not yet: the service opens it with its picture');
      return box0Calls.openDraw(roles, step.ticket);
    }
    case 'open': {
      if (!sameAddress(await io.read(roles.tickets, 'ownerOf', [step.tokenId]), account)) throw new Error('This placeholder is not yours');
      const at = await wordAcceptedAt(roles, io);
      const { timestamp } = await io.block();
      if (at === 0n || timestamp < at + REVEAL_GRACE) throw new Error('Not yet: the service opens it with its picture');
      return box0Calls.open(roles, step.tokenId);
    }
    case 'approve-service': {
      if (!roles.service) throw new Error('This site names no reveal service');
      if (!sameAddress(await io.read(roles.tickets, 'ownerOf', [step.tokenId]), account)) throw new Error('This placeholder is not yours');
      // An approval given before the numbers were fixed does not count (BoxPlaceholderToken eras).
      if ((await wordAcceptedAt(roles, io)) === 0n) throw new Error('Wait for the numbers first');
      return box0Calls.approveService(roles, step.tokenId);
    }
    case 'claim':
      return box0Calls.claim(roles, step.ids, account);
    case 'cancel-draw': {
      await stopped(roles, io);
      const d = (await io.read(roles.tickets, 'drawTicket', [step.ticket])) as { drawer?: unknown; status?: unknown } | null;
      if (!d || !sameAddress(d.drawer, account)) throw new Error('Not your draw');
      if (Number(d.status) !== DRAW.Requested) throw new Error('This draw has no FIT to give back');
      return box0Calls.cancelDraw(roles, step.ticket);
    }
    case 'hand-back': {
      await stopped(roles, io);
      if ((await wordAcceptedAt(roles, io)) !== 0n) throw new Error('This placeholder has a number: open it instead');
      if (!sameAddress(await io.read(roles.tickets, 'ownerOf', [step.tokenId]), account)) throw new Error('This placeholder is not yours');
      const [refund, { timestamp }] = await Promise.all([refundOne(roles, io), io.block()]);
      if (refund < step.min) throw new Error('The amount moved; check again');
      return box0Calls.handBack(roles, [step.tokenId], step.min, timestamp + DRAW_DEADLINE_SECONDS);
    }
    case 'take': {
      const timestamp = await takeOpen(roles, io);
      const quote = await quoteOne(roles, io);
      if (quote > step.limit) throw new Error('The price moved; check the new price');
      const [allowance, balance, hidden] = await Promise.all([io.read(roles.token, 'allowance', [account, roles.tickets]), io.read(roles.token, 'balanceOf', [account]), io.read(roles.vault, 'isHidden', [step.itemId])]);
      if (typeof allowance !== 'bigint' || allowance < step.limit) throw new Error('Approve FIT first');
      if (typeof balance !== 'bigint' || balance < quote) throw new Error('Not enough FIT');
      if (hidden !== true) throw new Error('That one was just taken; try again');
      return box0Calls.takeByNumber(roles, step.itemId, step.poolIndex, step.limit, timestamp + DRAW_DEADLINE_SECONDS);
    }
    default:
      // A step this page does not send (F142: there is no stop step) never reaches the simulation or the wallet.
      throw new NotSendableError('not a box 0 step');
  }
}

/** The draw ticket the receipt's own `DrawRequested` names (from the tickets contract, for this drawer). */
function ticketOf(roles: Box0Roles, account: Address, logs: readonly Box0Log[]): bigint | undefined {
  for (const log of logs) {
    if (!sameAddress(log.address, roles.tickets)) continue;
    try {
      const event = decodeEventLog({ abi: boxTicketsAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      if (event.eventName === 'DrawRequested' && sameAddress(event.args.drawer, account)) return event.args.ticketId;
    } catch {
      // Another event of the tickets contract.
    }
  }
  return undefined;
}

/** The guard's target for `step`: a draw names exactly its confirmed ETH (SH-BOX0-DRAW-VALUE); no other step does. */
const guardTarget = (roles: Box0Roles, step: Box0Step): Box0Target => (step.kind === 'draw' ? { ...roles, drawValue: step.value } : roles);

export async function sendBox0(roles: Box0Roles, account: Address, step: Box0Step, io: Box0IO): Promise<{ readonly hash: Hex; readonly ticketId?: bigint }> {
  await identity(roles, account, io);
  const call = await prepared(roles, account, step, io);
  await io.simulate(call, account);
  const estimate = await io.estimate(call, account);
  await identity(roles, account, io);
  const hash = await io.submit({ protocol: 'core-v1-box0', target: guardTarget(roles, step), call, wallet: io.request, from: account, gasLimit: gasLimitForBox0(estimate), feeReader: io.feeReader });
  let receipt: Awaited<ReturnType<Box0IO['receipt']>>;
  try {
    receipt = await io.receipt(hash);
  } catch {
    throw new Box0UnconfirmedError();
  }
  if (receipt.status !== 'success') throw new Error('Transaction reverted; nothing confirmed');
  const ticketId = step.kind === 'draw' ? ticketOf(roles, account, receipt.logs) : undefined;
  return ticketId === undefined ? { hash } : { hash, ticketId };
}
