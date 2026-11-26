import { zeroAddress, type Address } from 'viem';
import { listingRouteManifest, type ListingRoute } from './listing-route-manifest';
import { requireThat } from './schema';
import type { Manifest } from './types';

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const address = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a) && !same(a, zeroAddress);
const uint = (s: string) => /^(0|[1-9][0-9]*)$/.test(s);
const keyOf = (chainId: string, registry: Address, listingId: string, p: Address) =>
  `${chainId}:${registry.toLowerCase()}:${listingId}:${p.toLowerCase()}`;
const matches = (chainId: bigint, p: Address) => Object.entries(listingRouteManifest)
  .filter(([, entry]) => entry.chainId === chainId.toString() && same(entry.p, p));

function checked(key: string, entry: ListingRoute): ListingRoute {
  requireThat(uint(entry.chainId) && BigInt(entry.chainId) > 0n && uint(entry.listingId)
    && BigInt(entry.listingId) < 1n << 32n && key === keyOf(entry.chainId, entry.registry, entry.listingId, entry.p), 'listing route key mismatch');
  requireThat([entry.registry, entry.p, entry.weth, entry.factory, ...entry.pools, ...entry.path].every(address), 'listing route address');
  requireThat(entry.pools.length >= 1 && entry.pools.length <= 3
    && entry.path.length === entry.pools.length + 1 && entry.fees.length === entry.pools.length, 'listing route hop bound');
  requireThat(new Set(entry.pools.map(a => a.toLowerCase())).size === entry.pools.length
    && new Set(entry.path.map(a => a.toLowerCase())).size === entry.path.length, 'listing route cycle');
  requireThat(same(entry.path[0] ?? '', entry.p) && same(entry.path.at(-1) ?? '', entry.weth), 'listing route endpoints');
  requireThat(entry.fees.every(fee => uint(fee) && BigInt(fee) < 1_000_000n), 'listing route fee');
  return entry;
}

/** Exact chain/registry/listing/P binding; ambiguous routes for one P fail closed in both consumers. */
export function listingRoute(chainId: bigint, registry: Address, listingId: number, p: Address): ListingRoute {
  const key = keyOf(chainId.toString(), registry, String(listingId), p);
  const entry = listingRouteManifest[key];
  requireThat(entry && matches(chainId, p).length === 1, 'listing route missing or ambiguous');
  return checked(key, entry);
}

/**
 * Every sale of a credited P must use the shared pin, including callers building
 * Safe calldata directly. Unpinned/unsupported assets retain the existing bot
 * policy and receive no keeper credit. Operator config cannot override a pin.
 */
export function pinnedSaleRoute(m: Manifest, route: Manifest['routes'][number]): ListingRoute | undefined {
  if (!same(route.tokenOut, zeroAddress) && !same(route.tokenOut, m.weth)) return undefined;
  const entries = matches(m.chainId, route.tokenIn);
  if (entries.length === 0) return undefined;
  const first = entries[0];
  requireThat(entries.length === 1 && first, 'listing route ambiguous');
  const pin = checked(...first);
  requireThat(same(pin.weth, m.weth) && route.kind === 'v3'
    && route.id === pin.routeId && route.version === pin.routeVersion
    && route.path.length === pin.path.length && route.path.every((p, i) => same(p, pin.path[i] ?? ''))
    && route.fees.length === pin.fees.length && route.fees.every((fee, i) => String(fee) === pin.fees[i]), 'listing route differs from bot sale');
  return pin;
}
