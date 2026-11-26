import { SET_MAX_COUNT, SET_MAX_PAGE, SET_MIN_COUNT, SET_RETURN_FEE_BPS } from './spec';

export interface SetQuoteSnapshot {
  readonly supply: bigint;
  readonly escrow: bigint;
  readonly inside: bigint;
  readonly count: bigint;
}
export interface SetPickQuote { readonly principal: bigint; readonly fee: bigint; readonly tokenIn: bigint }
export interface SetReturnQuote { readonly principal: bigint; readonly fee: bigint; readonly tokenOut: bigint }
export type SetQuoteRefusal = 'uint256' | 'snapshot' | 'quantity' | 'last item' | 'fee preset' | 'below unit' | 'escrow' | 'supply floor' | 'slippage' | 'deadline';
export class SetQuoteError extends Error {
  // Explicit field, not a parameter property (Node's type stripping refuses them).
  readonly reason: SetQuoteRefusal;
  constructor(reason: SetQuoteRefusal) { super(`Set quote refused: ${reason}`); this.reason = reason; }
}
const MAX = (1n << 256n) - 1n;
const BPS = 10000n;
function refuse(reason: SetQuoteRefusal): never { throw new SetQuoteError(reason); }
function uint(value: bigint): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > MAX) refuse('uint256');
  return value;
}
const ceil = (a: bigint, b: bigint): bigint => a / b + (a % b === 0n ? 0n : 1n);
function available(s: SetQuoteSnapshot, k: bigint): bigint {
  const { supply, escrow, inside, count } = s;
  for (const value of [supply, escrow, inside, count, k]) uint(value);
  if (escrow > supply || inside === 0n || inside > count || count < BigInt(SET_MIN_COUNT) || count > BigInt(SET_MAX_COUNT)) refuse('snapshot');
  if (k === 0n || k > BigInt(SET_MAX_PAGE)) refuse('quantity');
  return supply - escrow;
}
function floor(supply: bigint, fee: bigint, escrow: bigint, inside: bigint): void {
  if (supply < fee || supply - fee < escrow + inside) refuse('supply floor');
}
/** One pre-operation snapshot; includes the burned fee and post-conversion E+n refusal. No custody/gate promise. */
export function quoteSetPick(s: SetQuoteSnapshot, k: bigint, pickFeeBps: bigint): SetPickQuote {
  const a = available(s, k);
  if (k > s.inside) refuse('quantity');
  if (k === s.inside) refuse('last item');
  if (![100n, 500n, 2500n].includes(pickFeeBps)) refuse('fee preset');
  const principal = uint(ceil(a * k, s.inside));
  if (principal < k) refuse('below unit');
  const fee = uint(ceil(principal * pickFeeBps, BPS));
  const tokenIn = uint(principal + fee);
  floor(s.supply, fee, s.escrow + principal, s.inside - k);
  return { principal, fee, tokenIn };
}
/** Return rights belong to current owners of previously picked members; this helper checks arithmetic only. */
export function quoteSetReturn(s: SetQuoteSnapshot, k: bigint): SetReturnQuote {
  const a = available(s, k);
  if (k > s.count - s.inside) refuse('quantity');
  const principal = uint(a * k / s.inside);
  if (principal < k) refuse('below unit');
  if (principal > s.escrow) refuse('escrow');
  const fee = uint(ceil(principal * BigInt(SET_RETURN_FEE_BPS), BPS));
  floor(s.supply, fee, s.escrow - principal, s.inside + k);
  return { principal, fee, tokenOut: principal - fee };
}
function slippage(bps: bigint): bigint {
  if (uint(bps) > BPS) refuse('slippage');
  return bps;
}
/** Ceiling of total pick input plus slippage; throws instead of wrapping an ABI uint256. */
export function maxIn(tokenIn: bigint, slippageBps: bigint): bigint {
  return uint(ceil(uint(tokenIn) * (BPS + slippage(slippageBps)), BPS));
}
/** Floor of net return output less slippage. */
export function minOut(tokenOut: bigint, slippageBps: bigint): bigint {
  return uint(tokenOut) * (BPS - slippage(slippageBps)) / BPS;
}
/** Explicit chain timestamp and positive lifetime in seconds. Execution accepts equality at the deadline. */
export function deadlineFrom(timestamp: bigint, seconds: bigint): bigint {
  uint(timestamp); uint(seconds);
  if (seconds === 0n) refuse('deadline');
  return uint(timestamp + seconds);
}
