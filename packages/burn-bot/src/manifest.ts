import { validateManifest } from './builders';
import { contentHash } from './journal';
import { requireThat } from './schema';
import type { Manifest } from './types';

/** Journal encoding uses strings even for the router ABI's bounded, discrete uint24 fee tiers. */
export function manifestFromWire(input: unknown): Manifest {
  const m = input as Manifest;
  requireThat(m && Array.isArray(m.routes), 'missing historical manifest');
  return validateManifest({ ...m, routes: m.routes.map(r => r.kind === 'v3' ? { ...r,
    fees: r.fees.map(fee => {
      requireThat(typeof fee === 'string' && /^[1-9][0-9]{0,5}$/.test(fee), 'invalid historical route fee tier');
      return parseInt(fee, 10);
    }),
  } : r) });
}

/** Configuration migration only: never changes deployment, prior asset metadata or a box's beneficiary/P. */
export function validateMigration(previous: Manifest, input: unknown): Manifest {
  const next = validateManifest(input);
  requireThat(next.policyVersion !== previous.policyVersion, 'new manifest policy version required');
  requireThat(contentHash({ ...previous, policyVersion: next.policyVersion, boxes: next.boxes,
    routes: next.routes, assetDecimals: next.assetDecimals, limits: next.limits }) === contentHash(next),
  'manifest deployment identity changed');
  for (const box of previous.boxes) {
    requireThat(next.boxes.some(b => contentHash(b) === contentHash(box)), 'existing box identity must be preserved');
  }
  for (const [asset, decimals] of Object.entries(previous.assetDecimals)) {
    requireThat(next.assetDecimals[asset as keyof typeof next.assetDecimals] === decimals, 'existing asset decimals must be preserved');
  }
  for (const route of next.routes) {
    const old = previous.routes.find(r => r.id === route.id || (r.tokenIn === route.tokenIn && r.tokenOut === route.tokenOut));
    if (!old) continue;
    requireThat(old.id === route.id && old.tokenIn === route.tokenIn && old.tokenOut === route.tokenOut, 'route identity changed');
    requireThat(contentHash(old) === contentHash(route)
      || old.version !== route.version, 'changed route requires a new version');
  }
  return next;
}
