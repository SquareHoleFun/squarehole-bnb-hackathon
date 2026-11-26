/**
 * External links for chain-backed pairs (Stage C, ADR-0012) on the two chains the app reads: the local anvil chain
 * 31337 and Sepolia 11155111. There is no mainnet entry here.
 *
 * - Explorer destinations are `available` ONLY on Sepolia, only on the allowlisted explorer origins
 *   (sepolia.etherscan.io, eth-sepolia.blockscout.com), and only for the pair's exact token address; every href must
 *   pass `vetExternalHref`. A local chain has no public explorer.
 * - Execution and discovery destinations stay `unverified` with `href: null`, unless a passing route-evidence record
 *   (route-evidence.ts; none is shipped) names this exact chain, token and quote AND the route has a reviewed URL
 *   shape. Sepolia's Uniswap execution route always carries the Testnet-mode warning: with Testnet mode off, a
 *   `chain=sepolia` link silently opens Ethereum mainnet with the same token addresses (research § 4.3).
 * - Only `chainId`, `token.address` and `quote.address` of the pair are read; names, symbols and slugs never are.
 */
import { isAddress, sameAddress, type ExternalDestination, type ExternalLinkProvider, type PairRecord } from '@squarehole/domain';
import { reviewedProvider, vetExternalHref, type DestinationKind } from './allowlist';
import { NOT_TESTED_REASON } from './registry';
import { passingEvidenceFor, type RouteEvidenceRecord } from './route-evidence';

export const CHAIN_LINK_CHAIN_IDS = Object.freeze([31_337, 11_155_111] as const);

export const UNISWAP_TESTNET_MODE_WARNING =
  'Turn on Testnet mode in the Uniswap app first (Settings → Advanced → Testnet mode). With Testnet mode off, a Sepolia link silently opens Ethereum mainnet with the same token addresses.';

export const LOCAL_CHAIN_LINK_REASON = 'Local test chain 31337: there is no external venue, listing or public explorer, so no link is built.';
export const SEPOLIA_DISCOVERY_REASON =
  'Not verified: DEX Screener returned no Sepolia data in the route research (B-DISC-01) and no discovery test is recorded; no link is built.';
export const NO_CHAIN_ROUTE_REASON = 'No reviewed destination exists for this chain.';

interface ChainRoute {
  readonly routeId: string;
  readonly chainId: number;
  readonly kind: DestinationKind;
  readonly providerId: string;
  /** Reviewed path shape (only `{T}` / `{Q}`), or null when none exists. */
  readonly pathTemplate: string | null;
  readonly reason: string;
  /** Always shown with this route, also when available. */
  readonly warning?: string;
}

/** Route shapes from docs/research/sepolia-infrastructure.md § 4.2 and § 5.1. */
export const CHAIN_LINK_ROUTES_V1: readonly ChainRoute[] = Object.freeze([
  {
    routeId: 'SEP-UNI-SWAP-BUY',
    chainId: 11_155_111,
    kind: 'execution',
    providerId: 'uniswap-web',
    pathTemplate: '/swap?chain=sepolia&inputCurrency={Q}&outputCurrency={T}',
    reason: `${NOT_TESTED_REASON} ${UNISWAP_TESTNET_MODE_WARNING}`,
    warning: UNISWAP_TESTNET_MODE_WARNING,
  },
  { routeId: 'SEP-DS', chainId: 11_155_111, kind: 'discovery', providerId: 'dexscreener', pathTemplate: null, reason: SEPOLIA_DISCOVERY_REASON },
  { routeId: 'SEP-ES-TOKEN', chainId: 11_155_111, kind: 'explorer', providerId: 'etherscan-sepolia', pathTemplate: '/token/{T}', reason: 'Explorer page of the exact token address.' },
  { routeId: 'SEP-BS-TOKEN', chainId: 11_155_111, kind: 'explorer', providerId: 'blockscout-sepolia', pathTemplate: '/token/{T}', reason: 'Explorer page of the exact token address.' },
].map((route) => Object.freeze(route as ChainRoute)));

function fill(template: string, pair: PairRecord): string | null {
  if (!template.startsWith('/') || template.startsWith('//')) return null;
  let invalid = false;
  const path = template.replace(/\{([^}]*)\}/g, (_match, name: string) => {
    const value = name === 'T' ? pair.token.address : name === 'Q' ? pair.quote.address : null;
    if (value === null || !isAddress(value)) {
      invalid = true;
      return '';
    }
    return value;
  });
  return invalid ? null : path;
}

function build(route: ChainRoute, pair: PairRecord): { href: string } | null {
  const provider = reviewedProvider(route.providerId);
  if (!provider || provider.kind !== route.kind || route.pathTemplate === null) return null;
  const path = fill(route.pathTemplate, pair);
  const vetted = path === null ? null : vetExternalHref(`${provider.origin}${path}`, route.kind);
  return vetted?.ok && vetted.provider.id === provider.id ? { href: vetted.href } : null;
}

function destinationFor(route: ChainRoute, pair: PairRecord, evidence: readonly RouteEvidenceRecord[]): ExternalDestination {
  const provider = reviewedProvider(route.providerId);
  const base = { kind: route.kind, provider: provider?.name ?? route.providerId, chainId: pair.chainId, assetAddress: pair.token.address, href: null };
  if (route.kind === 'explorer') {
    const built = build(route, pair);
    return built
      ? { ...base, state: 'available', href: built.href, reason: route.reason }
      : { ...base, state: 'unavailable', reason: 'The explorer link failed the provider allowlist, so it is not offered.' };
  }
  const record = passingEvidenceFor(evidence, route, { token: pair.token.address, quote: pair.quote.address });
  const built = record ? build(route, pair) : null;
  if (record && built) {
    return { ...base, state: 'available', href: built.href, validatedAt: record.testedAt, reason: route.warning ?? `Verified by ${record.evidenceRecord}.` };
  }
  return { ...base, state: 'unverified', reason: route.reason };
}

function localDestinations(pair: PairRecord): ExternalDestination[] {
  const base = { chainId: pair.chainId, assetAddress: pair.token.address, href: null };
  return [
    { ...base, kind: 'execution', provider: 'External venue (none on a local chain)', state: 'unverified', reason: LOCAL_CHAIN_LINK_REASON },
    { ...base, kind: 'discovery', provider: 'Discovery site (none on a local chain)', state: 'unverified', reason: LOCAL_CHAIN_LINK_REASON },
    { ...base, kind: 'explorer', provider: 'Block explorer (none on a local chain)', state: 'unavailable', reason: LOCAL_CHAIN_LINK_REASON },
  ];
}

export interface ChainLinkProviderOptions {
  /** Parsed route-evidence records (see `loadRouteEvidence`). None exist yet. */
  readonly evidence?: readonly RouteEvidenceRecord[];
}

export function createChainExternalLinkProvider(options: ChainLinkProviderOptions = {}): ExternalLinkProvider {
  const evidence = Object.freeze([...(options.evidence ?? [])]);
  return Object.freeze({
    destinations(pair: PairRecord): readonly ExternalDestination[] {
      const base = { chainId: pair.chainId, assetAddress: pair.token.address, href: null };
      // Exact identity (EXT-03): the token and quote must live on the pair's chain.
      if (pair.token.chainId !== pair.chainId || pair.quote.chainId !== pair.chainId) {
        return Object.freeze(
          (['execution', 'discovery', 'explorer'] as const).map((kind) =>
            Object.freeze({ ...base, kind, provider: 'None', state: 'unavailable' as const, reason: 'The token identity is not on the pair’s chain, so no destination is offered.' }),
          ),
        );
      }
      if (pair.chainId === 31_337) return Object.freeze(localDestinations(pair).map((destination) => Object.freeze(destination)));
      const routes = CHAIN_LINK_ROUTES_V1.filter((route) => route.chainId === pair.chainId);
      if (routes.length === 0) {
        return Object.freeze(
          (['execution', 'discovery', 'explorer'] as const).map((kind) => Object.freeze({ ...base, kind, provider: 'None reviewed', state: 'unavailable' as const, reason: NO_CHAIN_ROUTE_REASON })),
        );
      }
      return Object.freeze(routes.map((route) => Object.freeze(destinationFor(route, pair, evidence))));
    },
  });
}

/** The test networks' explorers and the one chain each serves (SH-258: BscScan's testnet is chain 97). */
export const TESTNET_EXPLORER_CHAINS = Object.freeze({ 'etherscan-sepolia': 11_155_111, 'blockscout-sepolia': 11_155_111, 'bscscan-testnet': 97 } as const);
export type TestnetExplorerId = keyof typeof TESTNET_EXPLORER_CHAINS;
export const isTestnetExplorerId = (value: unknown): value is TestnetExplorerId => typeof value === 'string' && Object.hasOwn(TESTNET_EXPLORER_CHAINS, value);

/**
 * Explorer href for an exact address or transaction hash on a test network (activity rows, contract lists): Sepolia's
 * explorers on 11155111, BscScan's testnet on 97. Null on any other chain than the explorer's, for anything that is not
 * exactly a 20-byte address / 32-byte hash, or if the allowlist refuses it.
 */
export function sepoliaExplorerHref(
  explorer: TestnetExplorerId,
  target: { readonly chainId: number; readonly address?: string; readonly txHash?: string },
): string | null {
  if (!isTestnetExplorerId(explorer) || target.chainId !== TESTNET_EXPLORER_CHAINS[explorer]) return null;
  const provider = reviewedProvider(explorer);
  if (!provider || provider.kind !== 'explorer') return null;
  let path: string;
  if (target.address !== undefined && target.txHash === undefined && isAddress(target.address) && !sameAddress(target.address, '0x0000000000000000000000000000000000000000')) {
    path = `/address/${target.address}`;
  } else if (target.txHash !== undefined && target.address === undefined && /^0x[0-9a-fA-F]{64}$/.test(target.txHash)) {
    path = `/tx/${target.txHash}`;
  } else {
    return null;
  }
  const vetted = vetExternalHref(`${provider.origin}${path}`, 'explorer');
  return vetted.ok ? vetted.href : null;
}
