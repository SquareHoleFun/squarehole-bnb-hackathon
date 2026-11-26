import { pairIdFromRoute, type PairId, type PairRouteResult } from '@squarehole/domain';

/**
 * Resolves `/pair/:chainId/:address` with the domain's `pairIdFromRoute` (ADR-0003): a typed result that never
 * throws on untrusted params and never guesses or repairs an identity. The data source knows one chain (31337 for the
 * demo and the local chain, 11155111 for Sepolia), so another chain id is a `chain_mismatch`, not a lookup.
 */
export function resolvePairRoute(chainId: string | undefined, address: string | undefined, expectedChainId?: number): PairRouteResult {
  if (chainId === undefined) return { ok: false, reason: 'malformed_chain_id' };
  if (address === undefined) return { ok: false, reason: 'malformed_address' };
  return pairIdFromRoute(chainId, address, expectedChainId === undefined ? {} : { expectedChainId });
}

/** Canonical lowercase pairId for the route, or null when it is malformed or on another chain. */
export function parsePairRoute(chainId: string | undefined, address: string | undefined, expectedChainId?: number): PairId | null {
  const result = resolvePairRoute(chainId, address, expectedChainId);
  return result.ok ? result.pairId : null;
}
