import type { PairRecord } from '@squarehole/domain';
import { describe, expect, it } from 'vitest';
import fixture from '../../providers/src/fixtures/feed.json';
import { DEMO_ROUTE_REASON, createDemoExternalLinkProvider, routeSummary } from './demo-links';

const pairs = fixture.items as unknown as PairRecord[];
const orchard = pairs.find((pair) => pair.name === 'ORCHARD') as PairRecord;
const links = createDemoExternalLinkProvider();

describe('demo ExternalLinkProvider (FEED-08, FEED-09, EXT-08)', () => {
  it('returns one execution, one discovery and one explorer destination per pair', () => {
    const kinds = links.destinations(orchard).map((destination) => destination.kind);
    expect(kinds).toEqual(['execution', 'discovery', 'explorer']);
  });

  it.each(pairs.map((pair) => [pair.name, pair] as const))('%s: every destination is unverified with href null', (_name, pair) => {
    for (const destination of links.destinations(pair)) {
      expect(destination.state).toBe('unverified');
      expect(destination.href).toBeNull();
      expect(destination.reason).toBe(DEMO_ROUTE_REASON);
      expect(destination.validatedAt).toBeUndefined();
    }
  });

  it('keeps the exact chain and T identity of the pair, never a lookalike', () => {
    for (const destination of links.destinations(orchard)) {
      expect(destination.chainId).toBe(31337);
      expect(destination.assetAddress).toBe(orchard.token.address);
    }
  });

  it('never constructs a URL, even from hostile creator metadata', () => {
    const hostile: PairRecord = {
      ...orchard,
      name: 'https://evil.example/trade?token=0x1',
      symbol: 'javascript:alert(1)',
      slug: '//evil.example',
    };
    const serialised = JSON.stringify(links.destinations(hostile));
    expect(serialised).not.toMatch(/https?:|\/\/|javascript:|data:/i);
    expect(serialised).not.toContain('evil');
  });

  it('refuses a pair whose token identity is on another chain (EXT-03)', () => {
    const mismatched: PairRecord = { ...orchard, token: { ...orchard.token, chainId: 1 } };
    for (const destination of links.destinations(mismatched)) {
      expect(destination.state).toBe('unavailable');
      expect(destination.href).toBeNull();
    }
  });

  it('never reports an available route for demo data, whatever the record claims (FEED-09)', () => {
    const claimsAvailable: PairRecord = { ...orchard, routeState: 'available' };
    expect(links.destinations(claimsAvailable).every((destination) => destination.state === 'unverified')).toBe(true);
  });

  it('returns frozen destinations', () => {
    const destinations = links.destinations(orchard);
    expect(Object.isFrozen(destinations)).toBe(true);
    expect(destinations.every((destination) => Object.isFrozen(destination))).toBe(true);
  });
});

describe('routeSummary', () => {
  it('is "unverified" when nothing is available and something is unverified', () => {
    expect(routeSummary(links.destinations(orchard))).toBe('unverified');
  });

  it('is "unavailable" when every destination is unavailable, or there are none', () => {
    const mismatched: PairRecord = { ...orchard, token: { ...orchard.token, chainId: 1 } };
    expect(routeSummary(links.destinations(mismatched))).toBe('unavailable');
    expect(routeSummary([])).toBe('unavailable');
  });

  it('is "available" only when an execution destination is available with an href', () => {
    const base = links.destinations(orchard);
    const [first] = base;
    if (!first) throw new Error('no execution destination');
    const execution = { ...first, state: 'available' as const, href: 'https://venue.example/' };
    expect(routeSummary([execution, ...base.slice(1)])).toBe('available');
    expect(routeSummary([{ ...execution, href: null }, ...base.slice(1)])).toBe('unverified');
  });
});
