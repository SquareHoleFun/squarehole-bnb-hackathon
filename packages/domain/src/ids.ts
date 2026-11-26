/**
 * Canonical identities (ADR-0003 "Semantics fixed before M1"): addresses compare case-insensitively and their
 * canonical form is lowercase; `pairId = ${chainId}:${address}` is an opaque launch-record identity.
 */
import { IdentityError } from './errors';
import type { Address, PairId } from './types';

/** Local demo chain (D07). Production chain is Ethereum mainnet (ADR-0002) and is not configured here. */
export const DEMO_CHAIN_ID = 31337;
/** Fixed demo clock: the fixture snapshot `asOf`. Inject it; never read the wall clock in domain logic. */
export const DEMO_NOW = '2026-09-25T12:00:00Z';

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const CHAIN_ID_PATTERN = /^[1-9][0-9]*$/;
const PAIR_ID_PATTERN = /^([1-9][0-9]*):(0x[0-9a-fA-F]{40})$/;

export function isAddress(value: unknown): value is Address {
  return typeof value === 'string' && ADDRESS_PATTERN.test(value);
}

/** ADR-0008: the zero address is never an asset, root or account identity. */
export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

export function isZeroAddress(value: unknown): boolean {
  return isAddress(value) && /^0x0{40}$/.test(value);
}

/** Lowercase canonical form. Throws `IdentityError('malformed_address')`. */
export function canonicalAddress(value: string): Address {
  if (!isAddress(value)) {
    throw new IdentityError('malformed_address', 'Expected a 0x-prefixed 20-byte hex address');
  }
  return value.toLowerCase() as Address;
}

/** Exact identity comparison. Malformed values never match anything (including themselves). */
export function sameAddress(a: string, b: string): boolean {
  return isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase();
}

export function isChainId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

export function isDemoChain(chainId: number): boolean {
  return chainId === DEMO_CHAIN_ID;
}

/** Strict decimal chain id (no sign, no leading zeros, safe integer). Returns null when malformed. */
function parseChainIdText(value: string): number | null {
  if (!CHAIN_ID_PATTERN.test(value)) return null;
  const chainId = Number(value);
  return isChainId(chainId) ? chainId : null;
}

export function formatPairId(chainId: number, address: string): PairId {
  if (!isChainId(chainId)) {
    throw new IdentityError('malformed_chain_id', 'Chain id must be a positive safe integer');
  }
  return `${chainId}:${canonicalAddress(address)}`;
}

export interface ParsedPairId {
  chainId: number;
  address: Address;
  pairId: PairId;
}

function tryParsePairId(value: unknown): ParsedPairId | null {
  if (typeof value !== 'string') return null;
  const match = PAIR_ID_PATTERN.exec(value);
  if (!match) return null;
  const [, chainText = '', addressText = ''] = match;
  const chainId = parseChainIdText(chainText);
  if (chainId === null) return null;
  const address = addressText.toLowerCase() as Address;
  return { chainId, address, pairId: `${chainId}:${address}` };
}

/** Strict pair id check (positive safe chain id without leading zeros, 20-byte address in any case). */
export function isPairId(value: unknown): value is PairId {
  return tryParsePairId(value) !== null;
}

/** Parses and canonicalises (lowercase address). Throws `IdentityError('malformed_pair_id')`. */
export function parsePairId(value: string): ParsedPairId {
  const parsed = tryParsePairId(value);
  if (!parsed) {
    throw new IdentityError('malformed_pair_id', 'Expected "<chainId>:<0x address>"');
  }
  return parsed;
}

export function canonicalPairId(value: string): PairId {
  return parsePairId(value).pairId;
}

/** Canonical detail route `/pair/<chainId>/<lowercase address>` (ADR-0003 Routes). */
export function pairRoute(pair: PairId | { pairId: PairId }): string {
  const { chainId, address } = parsePairId(typeof pair === 'string' ? pair : pair.pairId);
  return `/pair/${chainId}/${address}`;
}

export type PairRouteFailure = 'malformed_chain_id' | 'malformed_address' | 'chain_mismatch';
export type PairRouteResult =
  | { ok: true; pairId: PairId; chainId: number; address: Address }
  | { ok: false; reason: PairRouteFailure };

/**
 * Resolves `/pair/:chainId/:address` params. Route params are untrusted, so failures are returned as typed
 * reasons (not thrown) for the UI to render "invalid link" vs "wrong network". `expectedChainId` defaults to the
 * demo chain; a production build passes its configured chain.
 */
export function pairIdFromRoute(
  chainIdParam: string,
  addressParam: string,
  options: { expectedChainId?: number } = {},
): PairRouteResult {
  const chainId = parseChainIdText(chainIdParam);
  if (chainId === null) return { ok: false, reason: 'malformed_chain_id' };
  if (!isAddress(addressParam)) return { ok: false, reason: 'malformed_address' };
  const expectedChainId = options.expectedChainId ?? DEMO_CHAIN_ID;
  if (chainId !== expectedChainId) return { ok: false, reason: 'chain_mismatch' };
  const address = canonicalAddress(addressParam);
  return { ok: true, pairId: `${chainId}:${address}`, chainId, address };
}
