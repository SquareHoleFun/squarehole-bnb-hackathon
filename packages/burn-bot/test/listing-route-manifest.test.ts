import { describe, expect, it } from 'vitest';
import { listingRouteManifest } from '../src/listing-route-manifest';
import { listingRoute } from '../src/listing-routes';

// F164: the committed pins themselves. listing-routes.test.ts and listing-route-replay.test.ts mock this manifest
// (vi.mock), so nothing else runs a reviewed entry through the real checks. Empty today; it guards each future entry.
describe('F164 committed listing-route pins', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(listingRouteManifest)).toBe(true);
  });

  it('passes every committed entry through listingRoute() without the mock', () => {
    for (const [key, entry] of Object.entries(listingRouteManifest)) {
      expect(Number.isSafeInteger(Number(entry.listingId)), key).toBe(true);
      expect(listingRoute(BigInt(entry.chainId), entry.registry, Number(entry.listingId), entry.p), key).toBe(entry);
    }
  });
});
