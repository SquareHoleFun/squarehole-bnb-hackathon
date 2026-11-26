/**
 * EIP-1193 boundary types and error helpers (write side). Wallets and RPC endpoints are untrusted input (AGENTS.md
 * "Security boundaries"): every value they return is validated before use, and error objects are read defensively.
 */
import type { Address, TxHash } from '@squarehole/domain';
import { getAddress, isAddress } from 'viem';

export interface Eip1193RequestArguments {
  readonly method: string;
  readonly params?: readonly unknown[] | Record<string, unknown>;
}

export type Eip1193Request = (args: Eip1193RequestArguments) => Promise<unknown>;

export interface Eip1193Provider {
  request: Eip1193Request;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** EIP-1193 / EIP-1474 codes the write side reacts to. */
export const RPC_CODES = Object.freeze({
  userRejected: 4001,
  unauthorized: 4100,
  unsupportedMethod: 4200,
  disconnected: 4900,
  chainDisconnected: 4901,
  unrecognizedChain: 4902,
  requestPending: -32002,
  executionReverted: 3,
});

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const QUANTITY = /^0x(0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const DATA = /^0x([0-9a-fA-F]{2})*$/;

export const isTxHashValue = (value: unknown): value is TxHash => typeof value === 'string' && HASH.test(value);
export const isAddressValue = (value: unknown): value is Address => typeof value === 'string' && ADDRESS.test(value);
export const isHexData = (value: unknown): value is `0x${string}` => typeof value === 'string' && DATA.test(value);

/** JSON-RPC quantity (`0x…`, no leading zeros except `0x0`) to bigint. Throws on anything else. */
export function quantity(value: unknown, what: string): bigint {
  if (typeof value !== 'string' || !QUANTITY.test(value)) throw new RpcShapeError(`${what} is not a JSON-RPC quantity`);
  return BigInt(value);
}

export const toQuantity = (value: bigint): `0x${string}` => {
  if (value < 0n) throw new RangeError('quantities are unsigned');
  return `0x${value.toString(16)}`;
};

/** Chain id from `eth_chainId` / `chainChanged` (hex quantity; some wallets send a decimal string or number). */
export function parseChainId(value: unknown): number | null {
  let id: bigint | null = null;
  if (typeof value === 'string' && QUANTITY.test(value)) id = BigInt(value);
  else if (typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value)) id = BigInt(value);
  else if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) id = BigInt(value);
  if (id === null || id < 1n || id > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(id);
}

/**
 * Valid, distinct, lowercase-compared accounts from `eth_accounts` / `accountsChanged`; malformed entries dropped.
 * SH-254: an address in mixed case whose checksum is wrong (a wallet's own mistake) is passed on in its checksummed
 * form, so no caller meets an address that the strict check refuses (viem's encoding threw on one, in every Create
 * page); addresses that pass (checksummed, or all in one case) are passed on as they came.
 */
/** viem's strict check as a plain answer (its type guard would narrow the other branch away). */
const passesChecksum = (value: string): boolean => isAddress(value);

export function parseAccounts(value: unknown): Address[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const accounts: Address[] = [];
  for (const entry of value) {
    if (!isAddressValue(entry) || seen.has(entry.toLowerCase())) continue;
    seen.add(entry.toLowerCase());
    accounts.push(passesChecksum(entry) ? entry : (getAddress(entry.toLowerCase()) as Address));
  }
  return accounts;
}

/** A response that does not have the documented JSON-RPC shape. */
export class RpcShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcShapeError';
  }
}

/** `code` of an EIP-1193 / JSON-RPC error object (also nested under `cause` / `error`), or null. */
export function rpcErrorCode(error: unknown): number | null {
  for (const candidate of errorChain(error)) {
    const code = (candidate as { code?: unknown }).code;
    if (typeof code === 'number' && Number.isInteger(code)) return code;
  }
  return null;
}

export function isUserRejection(error: unknown): boolean {
  return rpcErrorCode(error) === RPC_CODES.userRejected;
}

/** A short, single-line message from an error (never an object dump); untrusted text is trimmed and capped. */
export function errorMessage(error: unknown, fallback = 'The request failed'): string {
  for (const candidate of errorChain(error)) {
    const message = (candidate as { shortMessage?: unknown; message?: unknown }).shortMessage ?? (candidate as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim().length > 0) return cleanText(message, 200);
  }
  return fallback;
}

/** Removes control/bidi characters and collapses whitespace; caps the length. */
export function cleanText(value: string, max: number): string {
  let cleaned = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff;
    cleaned += control ? ' ' : char;
  }
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return [...cleaned].length > max ? `${[...cleaned].slice(0, max - 1).join('')}…` : cleaned;
}

/** The error, then its `cause`, `error` and `data` wrappers (depth-limited: hostile objects can nest forever). */
export function errorChain(error: unknown): object[] {
  const chain: object[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && typeof current === 'object' && current !== null; depth += 1) {
    if (chain.includes(current)) break;
    chain.push(current);
    const next = (current as { cause?: unknown; error?: unknown }).cause ?? (current as { error?: unknown }).error;
    current = next;
  }
  return chain;
}
