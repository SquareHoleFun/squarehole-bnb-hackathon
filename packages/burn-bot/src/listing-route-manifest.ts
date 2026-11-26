import type { Address } from 'viem';

/** Public deployment pins, changed only by code review. No runtime/config/env override. */
export interface ListingRoute {
  readonly chainId: string;
  readonly registry: Address;
  readonly listingId: string;
  readonly p: Address;
  readonly weth: Address;
  /** Reviewed Uniswap v3 factory deployment, never a pool's self-reported factory. */
  readonly factory: Address;
  readonly routeId: string;
  readonly routeVersion: string;
  readonly pools: readonly Address[];
  readonly path: readonly Address[];
  /** uint24 fee tiers serialized as decimal strings, in pool/path order. */
  readonly fees: readonly string[];
}

/**
 * Key: decimal chainId:lowercase registry:decimal listingId:lowercase P.
 * No deployment routes were supplied with SH-MN-07-ROUTE. Add only reviewed real
 * pools/factory and the matching bot route id/version here; toy pins live in tests.
 * Missing entries give the keeper zero credit. Existing unsupported bot routes
 * remain usable, but cannot establish keeper credit.
 */
export const listingRouteManifest: Readonly<Record<string, ListingRoute>> = Object.freeze({});
