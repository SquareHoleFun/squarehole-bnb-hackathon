/**
 * SH-300: a deployment may carry more than one v2 release (BNB Chain testnet: the live release first, then a second one
 * whose card shop also takes a ten-minute wait). Two rules, in one place:
 * - Create always uses the FIRST release (`createReleaseOf`): a visitor's new box is made by `releases[0]` whatever else
 *   the file lists, and its keeper serves that release.
 * - A box belongs to the release whose BoxRegistryV2 registered it (`releaseOfRegistry`): its pages, checks and trades use
 *   that release, never the first by default.
 */
import type { Address } from 'viem';
import type { DeployedCoreManifestV2, ReleaseV2 } from '../../../../../../packages/chain/src/core/v2';

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The release Create uses: the first one, or undefined when the manifest names none. */
export function createReleaseOf(manifest: Pick<DeployedCoreManifestV2, 'releases'>): ReleaseV2 | undefined {
  return manifest.releases[0];
}

/** The release whose registry is `registry`, or undefined (not one of this manifest's). */
export function releaseOfRegistry(manifest: Pick<DeployedCoreManifestV2, 'releases'>, registry: Address | string): ReleaseV2 | undefined {
  return manifest.releases.find((release) => same(release.registry.address, registry));
}
