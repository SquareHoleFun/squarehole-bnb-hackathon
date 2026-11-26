/**
 * External links for the v2 FIT pair page (T19; F37 (2), F38 (1): "show the contract address and links out"): the
 * native ETH / FIT pool on Uniswap, its DEX Screener page and FIT on Etherscan. The app never trades; these are
 * links out, and the contract address with its copy button is the primary identity.
 *
 * - Shapes: docs/research/sh-018-external-routes.md (`DS-PAIR` is the v4 pool id, lowercase; `ES-TOKEN`) and
 *   docs/v2/route-proof.md item 4 ("Links must say `inputCurrency=ETH`": FIT's quote is native ETH, v4's currency0).
 * - Explorer links are built for the exact FIT address on Ethereum and Sepolia. Execution (Uniswap) and discovery
 *   (DEX Screener) links need a passing route-evidence record for this exact chain, FIT and native ETH (EXT-05,
 *   MKT-02), and DEX Screener's, which names one pool, for this exact pool id too; none is shipped (and the app has
 *   no evidence loader yet), so they stay `unverified` with their reason. Every href passes `vetExternalHref`.
 * - The demo and the local chain 31337 build no URL at all (EXT-08).
 * - Only the chain id, the FIT address and the pool id are read; names and symbols never are.
 */
import { isAddress, type Address, type ExternalDestination } from '@squarehole/domain';
import { reviewedProvider, vetExternalHref, type DestinationKind } from './allowlist';
import { LOCAL_CHAIN_LINK_REASON, SEPOLIA_DISCOVERY_REASON, UNISWAP_TESTNET_MODE_WARNING } from './chain-links';
import { NOT_TESTED_REASON, NO_ROUTE_REASON } from './registry';
import { passingEvidenceFor, type RouteEvidenceRecord } from './route-evidence';

/** Native ETH as a v4 currency (currency0 of the FIT pool): the address route-evidence records name as the quote. */
export const NATIVE_ETH_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

export const FIT_DEMO_LINK_REASON = 'Demo: FIT is not deployed anywhere, so no link is built. Nothing on this page is a real contract.';

const MAINNET = 1;
const SEPOLIA = 11_155_111;
const POOL_ID = /^0x[0-9a-fA-F]{64}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

interface FitRoute {
  readonly routeId: string;
  readonly chainId: number;
  readonly kind: DestinationKind;
  readonly providerId: string;
  /** Path + query after the provider origin; `{T}` = FIT, `{POOL}` = the v4 pool id in lowercase. Null: no shape. */
  readonly pathTemplate: string | null;
  readonly reason: string;
  /** Shown with the destination, also when it is a link. */
  readonly warning?: string;
}

export const FIT_LINK_ROUTES_V1: readonly FitRoute[] = Object.freeze(
  [
    {
      routeId: 'FIT-UNI-ETH',
      chainId: MAINNET,
      kind: 'execution',
      providerId: 'uniswap-web',
      pathTemplate: '/swap?chain=mainnet&inputCurrency=ETH&outputCurrency={T}',
      reason: NOT_TESTED_REASON,
    },
    { routeId: 'FIT-DS-POOL', chainId: MAINNET, kind: 'discovery', providerId: 'dexscreener', pathTemplate: '/ethereum/{POOL}', reason: NOT_TESTED_REASON },
    { routeId: 'FIT-ES-TOKEN', chainId: MAINNET, kind: 'explorer', providerId: 'etherscan', pathTemplate: '/token/{T}', reason: 'Explorer page of the exact token address.' },
    {
      routeId: 'FIT-SEP-UNI-ETH',
      chainId: SEPOLIA,
      kind: 'execution',
      providerId: 'uniswap-web',
      pathTemplate: '/swap?chain=sepolia&inputCurrency=ETH&outputCurrency={T}',
      // The Testnet-mode caveat is the destination's `warning`, shown under the reason: not repeated in it.
      reason: NOT_TESTED_REASON,
      warning: UNISWAP_TESTNET_MODE_WARNING,
    },
    { routeId: 'FIT-SEP-DS', chainId: SEPOLIA, kind: 'discovery', providerId: 'dexscreener', pathTemplate: null, reason: SEPOLIA_DISCOVERY_REASON },
    { routeId: 'FIT-SEP-ES-TOKEN', chainId: SEPOLIA, kind: 'explorer', providerId: 'etherscan-sepolia', pathTemplate: '/token/{T}', reason: 'Explorer page of the exact token address.' },
  ].map((route) => Object.freeze(route as FitRoute)),
);

export interface FitLinkTarget {
  readonly chainId: number;
  /** FIT, the contract address people copy. */
  readonly token: string;
  /** The ETH/FIT v4 pool id (bytes32). */
  readonly poolId: string;
  /** Demo fixture: never a link. */
  readonly demo: boolean;
}

export interface FitDestination extends ExternalDestination {
  readonly routeId: string | null;
  /** A caveat that stays with the destination (Uniswap's Testnet mode on Sepolia). */
  readonly warning: string | null;
}

const KIND_ORDER: readonly DestinationKind[] = ['execution', 'discovery', 'explorer'];
const DEMO_PROVIDERS: Readonly<Record<DestinationKind, string>> = { execution: 'Uniswap', discovery: 'DEX Screener', explorer: 'Etherscan' };

function fill(template: string, target: FitLinkTarget): string | null {
  if (!template.startsWith('/') || template.startsWith('//')) return null;
  let invalid = false;
  const path = template.replace(/\{([^}]*)\}/g, (_match, name: string) => {
    if (name === 'T' && isAddress(target.token)) return target.token;
    if (name === 'POOL' && POOL_ID.test(target.poolId)) return target.poolId.toLowerCase();
    invalid = true;
    return '';
  });
  return invalid ? null : path;
}

function build(route: FitRoute, target: FitLinkTarget): string | null {
  const provider = reviewedProvider(route.providerId);
  if (!provider || provider.kind !== route.kind || route.pathTemplate === null) return null;
  const path = fill(route.pathTemplate, target);
  const vetted = path === null ? null : vetExternalHref(`${provider.origin}${path}`, route.kind);
  return vetted?.ok && vetted.provider.id === provider.id ? vetted.href : null;
}

function destinationFor(route: FitRoute, target: FitLinkTarget, evidence: readonly RouteEvidenceRecord[]): FitDestination {
  const provider = reviewedProvider(route.providerId);
  const base = {
    kind: route.kind,
    provider: provider?.name ?? route.providerId,
    chainId: target.chainId,
    assetAddress: target.token as Address,
    href: null,
    routeId: route.routeId,
    warning: route.warning ?? null,
  };
  if (route.pathTemplate === null) return { ...base, state: 'unavailable', reason: route.reason };
  if (route.kind === 'explorer') {
    const href = build(route, target);
    return href ? { ...base, state: 'available', href, reason: route.reason } : { ...base, state: 'unavailable', reason: 'The explorer link failed the provider allowlist, so it is not offered.' };
  }
  // A pool-addressed link (`{POOL}`, DEX Screener) needs evidence for this exact pool; Uniswap routes by itself.
  const poolAddressed = route.pathTemplate.includes('{POOL}');
  const record = passingEvidenceFor(evidence, route, { token: target.token, quote: NATIVE_ETH_ADDRESS, ...(poolAddressed ? { poolId: target.poolId } : {}) });
  const href = record ? build(route, target) : null;
  if (record && href) return { ...base, state: 'available', href, validatedAt: record.testedAt, reason: `Verified by ${record.evidenceRecord}.` };
  return { ...base, state: 'unverified', reason: route.reason };
}

/**
 * The three destinations of the FIT pair page, in order: execution (Uniswap), discovery (DEX Screener), explorer
 * (Etherscan). Total: never throws on a malformed identity; it answers `unavailable` instead.
 */
export function fitMarketDestinations(target: FitLinkTarget, evidence: readonly RouteEvidenceRecord[] = []): readonly FitDestination[] {
  const unbuilt = (kind: DestinationKind, state: 'unverified' | 'unavailable', reason: string): FitDestination =>
    Object.freeze({ kind, provider: DEMO_PROVIDERS[kind], state, href: null, chainId: target.chainId, assetAddress: target.token as Address, reason, routeId: null, warning: null });
  if (target.demo) return Object.freeze(KIND_ORDER.map((kind) => unbuilt(kind, 'unverified', FIT_DEMO_LINK_REASON)));
  if (!isAddress(target.token) || !POOL_ID.test(target.poolId)) {
    return Object.freeze(KIND_ORDER.map((kind) => unbuilt(kind, 'unavailable', 'The FIT identity is malformed, so no destination is offered.')));
  }
  if (target.chainId === 31_337) return Object.freeze(KIND_ORDER.map((kind) => unbuilt(kind, kind === 'explorer' ? 'unavailable' : 'unverified', LOCAL_CHAIN_LINK_REASON)));
  const routes = FIT_LINK_ROUTES_V1.filter((route) => route.chainId === target.chainId);
  if (routes.length === 0) return Object.freeze(KIND_ORDER.map((kind) => unbuilt(kind, 'unavailable', NO_ROUTE_REASON)));
  return Object.freeze(KIND_ORDER.map((kind) => {
    const route = routes.find((candidate) => candidate.kind === kind);
    return route ? Object.freeze(destinationFor(route, target, evidence)) : unbuilt(kind, 'unavailable', NO_ROUTE_REASON);
  }));
}

/**
 * Explorer page of an exact address or transaction on Ethereum or Sepolia (trade rows, contract lists); null anywhere
 * else, for anything that is not exactly a 20-byte address or a 32-byte hash, or when the allowlist refuses it.
 */
export function fitExplorerHref(chainId: number, target: { readonly address?: string; readonly txHash?: string }): string | null {
  const providerId = chainId === MAINNET ? 'etherscan' : chainId === SEPOLIA ? 'etherscan-sepolia' : null;
  const provider = providerId ? reviewedProvider(providerId) : null;
  if (!provider) return null;
  let path: string;
  if (target.address !== undefined && target.txHash === undefined && isAddress(target.address)) path = `/address/${target.address}`;
  else if (target.txHash !== undefined && target.address === undefined && TX_HASH.test(target.txHash)) path = `/tx/${target.txHash}`;
  else return null;
  const vetted = vetExternalHref(`${provider.origin}${path}`, 'explorer');
  return vetted.ok ? vetted.href : null;
}
