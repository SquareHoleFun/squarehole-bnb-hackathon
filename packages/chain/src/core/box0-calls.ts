/**
 * Box 0's site actions after graduation (SH-BOX0-ACTIONS; core v1, packages/contracts/src/box): the only calls the box 0
 * panel may ask a wallet to send, and the check `submitWrite` runs again right before the request.
 *
 *   FIT.approve(tickets, limit)                 the FIT one draw takes (the tickets contract pulls it from the caller only)
 *   tickets.draw(limit, deadline) + value       one draw; `value` pays its drand round's posting, the rest comes back
 *   tickets.openDraw(ticket, 0 | caller, ∅)     the drawer's own draw, without its reveal (the contract's 30-day fallback)
 *   tickets.open(tokenId, ∅)                    the holder's numbered placeholder, without its reveal (the same fallback)
 *   tickets.approve(service, tokenId)           one placeholder for the reveal service's signer (only when one is named)
 *   stream.claim(ids, caller)                   the caller's per-Misfit share, paid to the caller
 *
 * The ways out of a stopped draw (SH-BOX0-EXITS; terminal mode, BoxTickets.sol). `enterTerminal` is not on this list
 * (F142, desk R61-STOP "hide"): the site never sends it; these show only once someone else has.
 *
 *   tickets.cancelDraw(ticket)                  a requested draw's FIT back to its drawer, fee-free (terminal only)
 *   tickets.handBack(ids, min, deadline)        placeholders without a number for their FIT (terminal, no word)
 *   tickets.takeByNumber(item, index, max, deadline, ∅)   one hidden item by its number (terminal + TAKE_DELAY)
 *
 * ∅ is the empty reveal: the site never holds a reveal record (box0-reveal-service.md). Nothing here takes a
 * placeholder on the curve, moves an item, settles or posts a round. `handBack` is the same function the curve uses;
 * the page offers it only in terminal mode, and the sender re-reads that before every send.
 */
import { decodeFunctionData, encodeFunctionData, erc20Abi, isAddress, zeroAddress, type Abi, type Address, type Hex } from 'viem';
import { boxItemStreamAbi, boxTicketsAbi } from '../abi';
import { NotSendableError } from '../write/calls';

export interface Box0Target {
  readonly chainId: number;
  /** T (FIT on mainnet), role 1. */
  readonly token: Address;
  /** The placeholders add-on, role 7. */
  readonly tickets: Address;
  /** The per-Misfit stream, role 10. */
  readonly stream: Address;
  /** The reveal service's signer, named by the build; null: no service approval is offered. */
  readonly service: Address | null;
  /**
   * SH-BOX0-DRAW-VALUE: the ETH the drawer confirmed for a draw (the amount the page showed). A draw carries exactly
   * this; no other call uses it.
   */
  readonly drawValue?: bigint;
}

export interface Box0Call {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
}

/** `DrandWords.BOUNTY_GAS`: a drawn round's pot, in gas at the draw block's base fee. */
export const DRAW_BOUNTY_GAS = 600_000n;
/** The highest base-fee basis a draw's value is sent for (the page refuses a draw above it). */
export const DRAW_FEE_CEILING = 200_000_000_000n;
/** The most ETH a draw may carry (600,000 × 200 gwei = 0.12 ETH; all but the round's top-up comes back). */
export const DRAW_VALUE_CAP = DRAW_BOUNTY_GAS * DRAW_FEE_CEILING;
/** Items booked in one claim (about 30,000 gas each). */
export const MAX_CLAIM_IDS = 50;
/** Placeholders in one hand-back. */
export const MAX_HAND_BACK_IDS = 50;
const ONE_GWEI = 1_000_000_000n;

/** `ItemReveal` with no record: accepted by the contract only from the fallback time, by the holder or drawer. */
export const EMPTY_REVEAL = Object.freeze({
  traitsPacked: 0n,
  imageHash: `0x${'00'.repeat(32)}` as Hex,
  avatarHash: `0x${'00'.repeat(32)}` as Hex,
  modelHash: `0x${'00'.repeat(32)}` as Hex,
  salt: `0x${'00'.repeat(32)}` as Hex,
  proof: Object.freeze([]) as readonly Hex[],
});

/**
 * A draw's value at `baseFee`: the round's target (600,000 × the base fee of the including block) at twice today's base
 * fee plus 1 gwei, so a few blocks of rising fees still reach it. The contract keeps only the round's shortfall and sends
 * the rest back in the same call (`DrandWords.payRound`).
 */
export function drawValueFor(baseFee: bigint): bigint {
  if (baseFee < 0n) throw new RangeError('base fee must not be negative');
  const basis = 2n * baseFee + ONE_GWEI;
  if (basis > DRAW_FEE_CEILING) throw new RangeError('Network fees are too high for a draw now.');
  return DRAW_BOUNTY_GAS * basis;
}

/** The most FIT a draw may take: the quote (principal + 1% draw fee) plus 1%, rounded up. */
export function drawLimitFor(quote: bigint): bigint {
  if (quote <= 0n) throw new RangeError('no draw quote');
  return quote + (quote + 99n) / 100n;
}

/** The least FIT a hand-back accepts: the quote less 1%, rounded down (never zero: a quote is at least 1 raw). */
export function handBackMinFor(quote: bigint): bigint {
  if (quote <= 0n) throw new RangeError('no hand-back quote');
  return quote - quote / 100n;
}

const TICKETS_FUNCTIONS = ['draw', 'open', 'openDraw', 'approve', 'cancelDraw', 'handBack', 'takeByNumber'];
const ticketsAbi: Abi = boxTicketsAbi.filter((item) => item.type === 'function' && TICKETS_FUNCTIONS.includes(item.name));
const streamAbi: Abi = boxItemStreamAbi.filter((item) => item.type === 'function' && item.name === 'claim');
const tokenAbi: Abi = erc20Abi.filter((item) => item.type === 'function' && item.name === 'approve');

export const box0Calls = Object.freeze({
  approveFit(target: Box0Target, amount: bigint): Box0Call {
    return { to: target.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [target.tickets, amount] }), value: 0n };
  },
  draw(target: Box0Target, limit: bigint, deadline: bigint, value: bigint): Box0Call {
    return { to: target.tickets, data: encodeFunctionData({ abi: boxTicketsAbi, functionName: 'draw', args: [limit, deadline] }), value };
  },
  openDraw(target: Box0Target, ticketId: bigint): Box0Call {
    return { to: target.tickets, data: encodeFunctionData({ abi: boxTicketsAbi, functionName: 'openDraw', args: [ticketId, zeroAddress, EMPTY_REVEAL] }), value: 0n };
  },
  open(target: Box0Target, tokenId: bigint): Box0Call {
    return { to: target.tickets, data: encodeFunctionData({ abi: boxTicketsAbi, functionName: 'open', args: [tokenId, EMPTY_REVEAL] }), value: 0n };
  },
  approveService(target: Box0Target, tokenId: bigint): Box0Call {
    if (!target.service) throw new NotSendableError('this build names no reveal service');
    return { to: target.tickets, data: encodeFunctionData({ abi: boxTicketsAbi, functionName: 'approve', args: [target.service, tokenId] }), value: 0n };
  },
  claim(target: Box0Target, ids: readonly bigint[], to: Address): Box0Call {
    return { to: target.stream, data: encodeFunctionData({ abi: boxItemStreamAbi, functionName: 'claim', args: [ids, to] }), value: 0n };
  },
  cancelDraw(target: Box0Target, ticketId: bigint): Box0Call {
    return { to: target.tickets, data: encodeFunctionData({ abi: boxTicketsAbi, functionName: 'cancelDraw', args: [ticketId] }), value: 0n };
  },
  handBack(target: Box0Target, tokenIds: readonly bigint[], minTokenOut: bigint, deadline: bigint): Box0Call {
    if (tokenIds.length === 0 || minTokenOut <= 0n) throw new NotSendableError('a hand-back names a placeholder and a floor');
    return { to: target.tickets, data: encodeFunctionData({ abi: boxTicketsAbi, functionName: 'handBack', args: [tokenIds, minTokenOut, deadline] }), value: 0n };
  },
  takeByNumber(target: Box0Target, itemId: bigint, poolIndex: bigint, maxTokenIn: bigint, deadline: bigint): Box0Call {
    return { to: target.tickets, data: encodeFunctionData({ abi: boxTicketsAbi, functionName: 'takeByNumber', args: [itemId, poolIndex, maxTokenIn, deadline, EMPTY_REVEAL] }), value: 0n };
  },
});

const same = (a: unknown, b: Address | null): boolean => typeof a === 'string' && b !== null && a.toLowerCase() === b.toLowerCase();

function isEmptyReveal(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  const zero = EMPTY_REVEAL.imageHash;
  return r.traitsPacked === 0n && [r.imageHash, r.avatarHash, r.modelHash, r.salt].every((h) => typeof h === 'string' && h.toLowerCase() === zero) && Array.isArray(r.proof) && r.proof.length === 0;
}

function decodeWith(abi: Abi, data: Hex) {
  const decoded = decodeFunctionData({ abi, data });
  if (encodeFunctionData({ abi, functionName: decoded.functionName, args: decoded.args } as never).toLowerCase() !== data.toLowerCase()) throw new Error('noncanonical');
  return decoded;
}

/** Rechecks the prepared roles, selector, target, value and caller-bound arguments right before the wallet request. */
export function assertSendableBox0Call(call: Box0Call, target: Box0Target, from: Address): void {
  const roles = [target.token, target.tickets, target.stream, ...(target.service ? [target.service] : [])];
  if (![...roles, from].every((a) => isAddress(a) && a !== zeroAddress) || new Set(roles.map((a) => a.toLowerCase())).size !== roles.length) {
    throw new NotSendableError('invalid box 0 role or caller address');
  }
  if (typeof call.value !== 'bigint' || call.value < 0n) throw new NotSendableError('invalid value');
  const abi = same(call.to, target.token) ? tokenAbi : same(call.to, target.tickets) ? ticketsAbi : same(call.to, target.stream) ? streamAbi : null;
  if (abi === null) throw new NotSendableError('box 0 action must target the token, the tickets or the stream');
  let decoded: { functionName: string; args?: readonly unknown[] };
  try {
    decoded = decodeWith(abi, call.data);
  } catch {
    throw new NotSendableError('calldata is not a canonical box 0 action');
  }
  const args = decoded.args ?? [];
  const positive = (v: unknown): boolean => typeof v === 'bigint' && v > 0n;
  const natural = (v: unknown): boolean => typeof v === 'bigint' && v >= 0n;
  if (decoded.functionName !== 'draw' && call.value !== 0n) throw new NotSendableError('only a draw carries value');
  if (abi === tokenAbi) {
    if (!same(args[0], target.tickets) || !positive(args[1])) throw new NotSendableError('FIT approval must name the tickets and a positive amount');
    return;
  }
  if (abi === streamAbi) {
    const ids = args[0];
    // No id: pays what is already booked to the caller (items sold since, or a share booked by a transfer).
    if (!Array.isArray(ids) || ids.length > MAX_CLAIM_IDS || !ids.every(positive) || new Set(ids.map(String)).size !== ids.length) {
      throw new NotSendableError(`a claim names at most ${MAX_CLAIM_IDS} distinct items`);
    }
    if (!same(args[1], from)) throw new NotSendableError('a claim pays the caller');
    return;
  }
  switch (decoded.functionName) {
    case 'draw':
      if (!positive(args[0]) || !positive(args[1])) throw new NotSendableError('a draw needs a FIT limit and a deadline');
      if (call.value > DRAW_VALUE_CAP) throw new NotSendableError('a draw carries at most the capped round payment');
      // SH-BOX0-DRAW-VALUE: exactly the ETH its drawer confirmed, never an amount worked out again at sending.
      if (typeof target.drawValue !== 'bigint' || call.value !== target.drawValue) throw new NotSendableError('a draw carries exactly its confirmed round payment');
      return;
    case 'openDraw':
      if (!positive(args[0]) || !(same(args[1], zeroAddress) || same(args[1], from)) || !isEmptyReveal(args[2])) {
        throw new NotSendableError('a draw opens to its drawer, without a record');
      }
      return;
    case 'open':
      if (!positive(args[0]) || !isEmptyReveal(args[1])) throw new NotSendableError('a placeholder opens without a record');
      return;
    case 'cancelDraw':
      if (!positive(args[0])) throw new NotSendableError('a cancel names one draw');
      return;
    case 'handBack': {
      const ids = args[0];
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_HAND_BACK_IDS || !ids.every(positive) || new Set(ids.map(String)).size !== ids.length) {
        throw new NotSendableError(`a hand-back names 1 to ${MAX_HAND_BACK_IDS} distinct placeholders`);
      }
      if (!positive(args[1]) || !positive(args[2])) throw new NotSendableError('a hand-back needs a floor and a deadline');
      return;
    }
    case 'takeByNumber':
      if (!natural(args[0]) || !natural(args[1]) || !positive(args[2]) || !positive(args[3]) || !isEmptyReveal(args[4])) {
        throw new NotSendableError('a take names one item, a FIT limit and a deadline, without a record');
      }
      return;
    case 'approve':
      if (!target.service || !same(args[0], target.service) || !positive(args[1])) throw new NotSendableError('a placeholder approval names the reveal service and one placeholder');
      return;
    default:
      throw new NotSendableError('function is not a box 0 action');
  }
}
