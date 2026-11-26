/**
 * Demo external-link adapter (FEED-08, EXT-08). Demo fixtures on local chain 31337 have no reviewed venue, listing or
 * explorer, so every destination is `unverified` with `href: null`. This module never builds a URL: not from fixture
 * addresses, not from creator metadata (name, symbol, slug), and not from `PairRecord.routeState`. Other chains use
 * the registry adapter (registry.ts, SH-013), whose links must pass the origin allowlist (EXT-02, EXT-07).
 */
import type { ExternalDestination, ExternalLinkProvider, PairRecord, RouteState } from '@squarehole/domain';

export const DEMO_ROUTE_REASON = 'Demo fixture on local chain 31337: no reviewed route exists, so no link is built.';
export const IDENTITY_MISMATCH_REASON = 'The token identity is not on the pair’s chain, so no destination is offered.';

/** Display names only; none of them is a link target. */
const DESTINATIONS: readonly (readonly [ExternalDestination['kind'], string])[] = [
  ['execution', 'External venue (not selected)'],
  ['discovery', 'DEX Screener'],
  ['explorer', 'Block explorer'],
];

function destinationsFor(pair: PairRecord): readonly ExternalDestination[] {
  // Exact identity (EXT-03): the traded asset must live on the pair's chain.
  const sameChain = pair.token.chainId === pair.chainId;
  return Object.freeze(
    DESTINATIONS.map(([kind, provider]) =>
      Object.freeze({
        kind,
        provider,
        state: sameChain ? ('unverified' as const) : ('unavailable' as const),
        href: null,
        chainId: pair.chainId,
        assetAddress: pair.token.address,
        reason: sameChain ? DEMO_ROUTE_REASON : IDENTITY_MISMATCH_REASON,
      }),
    ),
  );
}

export function createDemoExternalLinkProvider(): ExternalLinkProvider {
  return Object.freeze({ destinations: destinationsFor });
}

/**
 * One status for a row: `available` only when an execution destination is available AND has an href;
 * `unverified` when anything is still unverified; otherwise `unavailable`.
 */
export function routeSummary(destinations: readonly ExternalDestination[]): RouteState {
  const executable = destinations.some((d) => d.kind === 'execution' && d.state === 'available' && d.href !== null);
  if (executable) return 'available';
  if (destinations.some((d) => d.state === 'unverified' || d.state === 'available')) return 'unverified';
  return 'unavailable';
}
