import type { ExternalDestination, PairRecord } from '@squarehole/domain';
import { describe, expect, it } from 'vitest';
import fixture from '../../providers/src/fixtures/feed.json';
import { reviewedProvider, vetExternalHref } from './allowlist';
import { createDemoExternalLinkProvider } from './demo-links';
import {
  LINK_REGISTRY_V1,
  LINK_REJECTED_REASON,
  MISMATCH_REASON,
  NOT_TESTED_REASON,
  NO_ROUTE_REASON,
  createReviewedExternalLinkProvider,
  renderableHref,
  type LinkRegistry,
  type RegistryRoute,
} from './registry';

const pairs = fixture.items as unknown as PairRecord[];
const orchard = pairs.find((pair) => pair.name === 'ORCHARD') as PairRecord;
const SEPOLIA = 11155111;
/** ORCHARD's identity moved to Sepolia, for adapter tests only (no such pair exists). */
const onSepolia: PairRecord = {
  ...orchard,
  pairId: `${SEPOLIA}:0x0000000000000000000000000000000000000066`,
  chainId: SEPOLIA,
  token: { ...orchard.token, chainId: SEPOLIA },
  quote: { ...orchard.quote, chainId: SEPOLIA },
};
const T = onSepolia.token.address;
const Q = onSepolia.quote.address;

/** TEST-ONLY registry: an evidence record that does not exist, to exercise the `available` path. */
function testRegistry(overrides: Partial<RegistryRoute> = {}): LinkRegistry {
  return {
    version: 'test-only',
    routes: [
      {
        id: 'TEST-UNI',
        chainId: SEPOLIA,
        kind: 'execution',
        providerId: 'uniswap-web',
        pathTemplate: '/swap?chain=sepolia&inputCurrency={Q}&outputCurrency={T}',
        state: 'available',
        evidence: { record: 'TEST-ONLY-EVIDENCE', validatedAt: '2026-09-26T00:00:00Z' },
        reason: '',
        ...overrides,
      },
    ],
  };
}

const execution = (registry: LinkRegistry, pair: PairRecord = onSepolia): ExternalDestination => {
  const found = createReviewedExternalLinkProvider(registry).destinations(pair).find((d) => d.kind === 'execution');
  if (!found) throw new Error('no execution destination');
  return found;
};

describe('LINK_REGISTRY_V1', () => {
  it('has no available route: nothing has passed a recorded external test (EXT-05)', () => {
    expect(LINK_REGISTRY_V1.routes.length).toBeGreaterThan(0);
    for (const route of LINK_REGISTRY_V1.routes) {
      expect(route.state, route.id).not.toBe('available');
      expect(route.evidence, route.id).toBeNull();
      expect(route.reason.length, route.id).toBeGreaterThan(10);
    }
  });

  it('has no entry for the demo chain 31337 (EXT-08)', () => {
    expect(LINK_REGISTRY_V1.routes.filter((route) => route.chainId === 31337)).toEqual([]);
  });

  it('every template, filled with an exact identity, passes the allowlist and uses only {T}/{Q}', () => {
    for (const route of LINK_REGISTRY_V1.routes) {
      if (route.pathTemplate === null) continue;
      expect(route.pathTemplate.replace(/\{[TQ]\}/g, ''), route.id).not.toMatch(/[{}]/);
      const provider = reviewedProvider(route.providerId);
      expect(provider?.kind, route.id).toBe(route.kind);
      const href = `${provider?.origin ?? ''}${route.pathTemplate.replace('{T}', T).replace('{Q}', Q)}`;
      expect(vetExternalHref(href, route.kind).ok, route.id).toBe(true);
    }
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(LINK_REGISTRY_V1)).toBe(true);
    expect(Object.isFrozen(LINK_REGISTRY_V1.routes)).toBe(true);
    expect(LINK_REGISTRY_V1.routes.every((route) => Object.isFrozen(route))).toBe(true);
  });
});

describe('createReviewedExternalLinkProvider', () => {
  it('v1 on Sepolia: execution and explorer unverified, discovery unavailable, never an href', () => {
    const destinations = createReviewedExternalLinkProvider().destinations(onSepolia);
    expect(destinations.map((d) => [d.kind, d.state, d.href])).toEqual([
      ['execution', 'unverified', null],
      ['discovery', 'unavailable', null],
      ['explorer', 'unverified', null],
    ]);
    expect(destinations[0]?.provider).toBe('Uniswap web app');
    expect(destinations[0]?.reason).toContain(NOT_TESTED_REASON);
    expect(destinations[1]?.reason).toMatch(/no Sepolia data/);
  });

  it('a chain without reviewed routes gets honest unavailable destinations (EXT-06)', () => {
    for (const destination of createReviewedExternalLinkProvider().destinations(orchard)) {
      expect(destination).toMatchObject({ state: 'unavailable', href: null, reason: NO_ROUTE_REASON, chainId: 31337 });
    }
  });

  it('builds the link for an evidenced route from the exact T and Q addresses only', () => {
    const destination = execution(testRegistry());
    expect(destination).toMatchObject({ state: 'available', provider: 'Uniswap web app', validatedAt: '2026-09-26T00:00:00Z' });
    expect(destination.href).toBe(`https://app.uniswap.org/swap?chain=sepolia&inputCurrency=${Q}&outputCurrency=${T}`);
  });

  it('never consumes creator metadata or the record’s routeState (EXT-07)', () => {
    const hostile: PairRecord = {
      ...onSepolia,
      name: 'https://evil.example/trade',
      symbol: 'javascript:alert(1)',
      slug: '//evil.example',
      routeState: 'unavailable',
    };
    expect(execution(testRegistry(), hostile)).toEqual(execution(testRegistry()));
    expect(JSON.stringify(createReviewedExternalLinkProvider(testRegistry()).destinations(hostile))).not.toContain('evil');
  });

  it('a state flag alone never enables a route: available without evidence stays unverified', () => {
    expect(execution(testRegistry({ evidence: null }))).toMatchObject({ state: 'unverified', href: null, reason: NOT_TESTED_REASON });
    expect(execution(testRegistry({ evidence: { record: ' ', validatedAt: '2026-09-26T00:00:00Z' } })).state).toBe('unverified');
    expect(execution(testRegistry({ evidence: { record: 'X', validatedAt: 'yesterday' } })).state).toBe('unverified');
  });

  it('a template that escapes the origin or names an unknown placeholder is refused', () => {
    for (const pathTemplate of ['//evil.example/{T}', 'evil.example/{T}', '/swap?x={name}', '/swap?next=https://evil.example&t={T}', '/swap?connect=1&t={T}']) {
      expect(execution(testRegistry({ pathTemplate })), pathTemplate).toMatchObject({ state: 'unavailable', href: null, reason: LINK_REJECTED_REASON });
    }
  });

  it('a provider of the wrong kind or an unknown provider is no route', () => {
    expect(execution(testRegistry({ providerId: 'etherscan-sepolia' }))).toMatchObject({ state: 'unavailable', reason: NO_ROUTE_REASON });
    expect(execution(testRegistry({ providerId: 'lookalike-dex' }))).toMatchObject({ state: 'unavailable', reason: NO_ROUTE_REASON });
  });

  it('refuses a pair whose T or Q identity is on another chain (EXT-03)', () => {
    for (const pair of [
      { ...onSepolia, token: { ...onSepolia.token, chainId: 1 } },
      { ...onSepolia, quote: { ...onSepolia.quote, chainId: 1 } },
    ]) {
      expect(execution(testRegistry(), pair)).toMatchObject({ state: 'unavailable', href: null, reason: MISMATCH_REASON });
    }
  });
});

describe('renderableHref (render-boundary guard)', () => {
  const available = execution(testRegistry());

  it('returns the vetted href and host for an available, allowlisted, identity-matching destination', () => {
    expect(renderableHref(available, onSepolia)).toEqual({ href: available.href, host: 'app.uniswap.org' });
  });

  it('is null for every demo destination (EXT-08)', () => {
    for (const pair of pairs) {
      for (const destination of createDemoExternalLinkProvider().destinations(pair)) expect(renderableHref(destination, pair)).toBeNull();
    }
  });

  it('is null when anything is off: state, href, chain, asset, origin', () => {
    const cases: ExternalDestination[] = [
      { ...available, state: 'unverified' },
      { ...available, href: null },
      { ...available, chainId: 1 },
      { ...available, assetAddress: '0x00000000000000000000000000000000000003eb' },
      { ...available, href: 'https://app.uniswap.org.evil.example/swap' },
      { ...available, href: 'javascript:alert(1)' },
      { ...available, kind: 'explorer' },
    ];
    for (const destination of cases) expect(renderableHref(destination, onSepolia), JSON.stringify(destination)).toBeNull();
  });
});
