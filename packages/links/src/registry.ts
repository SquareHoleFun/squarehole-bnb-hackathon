/**
 * Versioned registry of reviewed external routes (SH-013; 04-EXTERNAL-TRADING "Link adapters and trust").
 *
 * - A route is a reviewed URL shape for one chain, destination kind and provider. The origin comes from the provider
 *   allowlist; the path template may only use `{T}` (the pair's ERC-20 T address) and `{Q}` (its registered quote),
 *   both taken from the exact on-chain identity and never from creator metadata (EXT-03, EXT-07).
 * - Every route starts `unverified`. `available` only takes effect with an EXT-05 evidence record; a state flag alone
 *   never builds a link. No route in `LINK_REGISTRY_V1` is available: none has passed a recorded external test.
 * - The built href must still pass `vetExternalHref`, or the destination becomes `unavailable`.
 */
import { isAddress, isIsoTimestamp, sameAddress, type ExternalDestination, type ExternalLinkProvider, type PairRecord, type RouteState } from '@squarehole/domain';
import { reviewedProvider, vetExternalHref, type DestinationKind } from './allowlist';

export interface RouteEvidence {
  /** Evidence record id (e.g. a docs/evidence entry for an EXT-05 route test). */
  readonly record: string;
  readonly validatedAt: string;
}

export interface RegistryRoute {
  /** Template id from the route research (e.g. `SEP-UNI-SWAP-BUY`). */
  readonly id: string;
  readonly chainId: number;
  readonly kind: DestinationKind;
  readonly providerId: string;
  /** Path + query appended to the provider origin, or null when no reviewed shape exists for this identity. */
  readonly pathTemplate: string | null;
  readonly state: RouteState;
  readonly evidence: RouteEvidence | null;
  /** Honest user-facing reason shown while the route is not available (EXT-06). */
  readonly reason: string;
}

export interface LinkRegistry {
  readonly version: string;
  readonly routes: readonly RegistryRoute[];
}

export const DESTINATION_KINDS: readonly DestinationKind[] = Object.freeze(['execution', 'discovery', 'explorer']);

export const NOT_TESTED_REASON = 'Not verified: no recorded external transaction test for this route yet (EXT-05).';
export const NO_ROUTE_REASON = 'No reviewed destination exists for this chain.';
export const LINK_REJECTED_REASON = 'The built link failed the provider allowlist, so it is not offered.';
export const MISMATCH_REASON = 'The token identity is not on the pair’s chain, so no destination is offered.';

const MAINNET = 1;
const SEPOLIA = 11_155_111;

/**
 * Registry v1: shapes from docs/research/sh-018-external-routes.md (chain 1) and sepolia-infrastructure.md §4.2
 * (chain 11155111). All unverified or unavailable; the demo chain 31337 has no entries (see demo-links.ts).
 */
export const LINK_REGISTRY_V1: LinkRegistry = deepFreeze({
  version: 'links-v1 (2026-09-26)',
  routes: [
    {
      id: 'UNI-SWAP-BUY',
      chainId: MAINNET,
      kind: 'execution',
      providerId: 'uniswap-web',
      pathTemplate: '/swap?chain=mainnet&inputCurrency={Q}&outputCurrency={T}',
      state: 'unverified',
      evidence: null,
      reason: NOT_TESTED_REASON,
    },
    {
      id: 'DS-PAIR',
      chainId: MAINNET,
      kind: 'discovery',
      providerId: 'dexscreener',
      pathTemplate: null,
      state: 'unavailable',
      evidence: null,
      reason: 'DEX Screener pages need the pool id, which pair records do not carry yet; nothing is guessed.',
    },
    {
      id: 'ES-TOKEN',
      chainId: MAINNET,
      kind: 'explorer',
      providerId: 'etherscan',
      pathTemplate: '/token/{T}',
      state: 'unverified',
      evidence: null,
      reason: 'Explorer path shape not yet checked in a browser.',
    },
    {
      id: 'SEP-UNI-SWAP-BUY',
      chainId: SEPOLIA,
      kind: 'execution',
      providerId: 'uniswap-web',
      pathTemplate: '/swap?chain=sepolia&inputCurrency={Q}&outputCurrency={T}',
      state: 'unverified',
      evidence: null,
      reason: `${NOT_TESTED_REASON} The Uniswap app also needs Testnet mode on (Settings → Advanced).`,
    },
    {
      id: 'SEP-DS',
      chainId: SEPOLIA,
      kind: 'discovery',
      providerId: 'dexscreener',
      pathTemplate: null,
      state: 'unavailable',
      evidence: null,
      reason: 'DEX Screener returned no Sepolia data, so there is no market-information page on this testnet.',
    },
    {
      id: 'SEP-ES-TOKEN',
      chainId: SEPOLIA,
      kind: 'explorer',
      providerId: 'etherscan-sepolia',
      pathTemplate: '/token/{T}',
      state: 'unverified',
      evidence: null,
      reason: 'Explorer link waits for the pair’s contracts to be listed in a deployment manifest.',
    },
  ],
});

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const PLACEHOLDER = /\{([^}]*)\}/g;

/** `{T}`/`{Q}` filled from exact addresses; null for any other placeholder or a template that could leave the origin. */
function fillTemplate(template: string, pair: PairRecord): string | null {
  if (!template.startsWith('/') || template.startsWith('//')) return null;
  let invalid = false;
  const path = template.replace(PLACEHOLDER, (_match, name: string) => {
    const address = name === 'T' ? pair.token.address : name === 'Q' ? pair.quote.address : null;
    if (address === null || !isAddress(address)) {
      invalid = true;
      return '';
    }
    return address;
  });
  return invalid ? null : path;
}

function hasEvidence(route: RegistryRoute): boolean {
  return route.evidence !== null && route.evidence.record.trim() !== '' && isIsoTimestamp(route.evidence.validatedAt);
}

function destination(pair: PairRecord, kind: DestinationKind, route: RegistryRoute | undefined): ExternalDestination {
  const base = { kind, chainId: pair.chainId, assetAddress: pair.token.address, href: null };
  if (pair.token.chainId !== pair.chainId || pair.quote.chainId !== pair.chainId) {
    return { ...base, provider: route ? (reviewedProvider(route.providerId)?.name ?? route.providerId) : 'None', state: 'unavailable', reason: MISMATCH_REASON };
  }
  const provider = route ? reviewedProvider(route.providerId) : null;
  if (!route || !provider || provider.kind !== kind) {
    return { ...base, provider: 'None reviewed', state: 'unavailable', reason: NO_ROUTE_REASON };
  }
  if (route.state === 'unavailable') return { ...base, provider: provider.name, state: 'unavailable', reason: route.reason };
  if (route.state !== 'available' || !hasEvidence(route) || route.pathTemplate === null) {
    return { ...base, provider: provider.name, state: 'unverified', reason: route.state === 'available' ? NOT_TESTED_REASON : route.reason };
  }
  const path = fillTemplate(route.pathTemplate, pair);
  const vetted = path === null ? null : vetExternalHref(`${provider.origin}${path}`, kind);
  if (!vetted?.ok || vetted.provider.id !== provider.id) {
    return { ...base, provider: provider.name, state: 'unavailable', reason: LINK_REJECTED_REASON };
  }
  return { ...base, provider: provider.name, state: 'available', href: vetted.href, validatedAt: route.evidence?.validatedAt };
}

/**
 * Link provider over a reviewed registry: one execution, one discovery and one explorer destination per pair. It reads
 * only the pair's chain id and the T/Q addresses; name, symbol, slug and `routeState` are never consulted.
 */
export function createReviewedExternalLinkProvider(registry: LinkRegistry = LINK_REGISTRY_V1): ExternalLinkProvider {
  return Object.freeze({
    destinations(pair: PairRecord): readonly ExternalDestination[] {
      return Object.freeze(
        DESTINATION_KINDS.map((kind) =>
          Object.freeze(destination(pair, kind, registry.routes.find((route) => route.chainId === pair.chainId && route.kind === kind))),
        ),
      );
    },
  });
}

/**
 * The href the UI may render for a destination, or null. Defence in depth at the render boundary: even a destination
 * from another adapter is only a link when it is `available`, names this pair's exact chain and T address, and its
 * href passes the allowlist for its kind (EXT-02, EXT-03, EXT-08).
 */
export function renderableHref(destinationValue: ExternalDestination, pair: Pick<PairRecord, 'chainId' | 'token'>): { href: string; host: string } | null {
  if (destinationValue.state !== 'available' || destinationValue.href === null) return null;
  if (destinationValue.chainId !== pair.chainId || pair.token.chainId !== pair.chainId) return null;
  if (!sameAddress(destinationValue.assetAddress, pair.token.address)) return null;
  const vetted = vetExternalHref(destinationValue.href, destinationValue.kind);
  return vetted.ok ? { href: vetted.href, host: vetted.host } : null;
}
