// @vitest-environment node
/**
 * SH-300: with two v2 releases a box trades through its OWN release's registry (before: a deployment of two releases
 * named none, so every box page lost its buy and sell box). Kept in the trade folder (F156: no trade import outside it).
 */
import { describe, expect, it } from 'vitest';
import realManifest from '../../../../../packages/contracts/deployments/core-v1/97.json' with { type: 'json' };
import { parseCoreManifestV2 } from '../../../../../packages/chain/src/core/v2';
import type { V2Source } from '../core/v2/indexer-v2';
import { SECOND, firstRelease97, twoReleaseManifest97 } from '../core/v2/test-support/two-releases-97';
import { SEPOLIA_CHAIN, testnetDeploymentOf } from './trade-target';
import { required } from '../core/v2/test-support/required';

const sourceOf = (raw: unknown): V2Source => ({ network: 'sepolia', manifest: parseCoreManifestV2(raw), origin: 'https://index.bnb.test', rpc: 'https://rpc.bnb.test' });
// Today's live release alone (the committed file's FIRST release), so the suite reads the same before and after the
// real file gains its second release.
const one = sourceOf({ ...(realManifest as unknown as Record<string, unknown>), releases: [(realManifest as unknown as { releases: unknown[] }).releases[0]] });
const two = sourceOf(twoReleaseManifest97);
const FIRST = firstRelease97 as unknown as { registry: { address: string } };

describe('a box trades with its own release\'s registry', () => {
  const record = { chainId: SEPOLIA_CHAIN, status: 'deployed', poolSwapTest: '0x00000000000000000000000000000000000000a5', poolManager: one.manifest.chain.poolManager.address, poolSwapTestCodeHash: `0x${'11'.repeat(32)}` };
  it('a box of the second release: its registry; of the first: the first\'s', () => {
    expect(testnetDeploymentOf(record, two, required(two.manifest.releases[1]))?.boxRegistry).toBe(SECOND.registry);
    expect(testnetDeploymentOf(record, two, required(two.manifest.releases[0]))?.boxRegistry).toBe(FIRST.registry.address);
  });
  it('one release: the box\'s release, which is that one', () => {
    expect(one.manifest.releases.length).toBe(1);
    expect(testnetDeploymentOf(record, one, required(one.manifest.releases[0]))?.boxRegistry).toBe(FIRST.registry.address);
  });
  it('a release that is not this manifest\'s: no deployment (never a guess), with one release or two', () => {
    const elsewhere = { registry: { address: '0x00000000000000000000000000000000000000ee' } } as never;
    expect(testnetDeploymentOf(record, two, elsewhere)).toBeNull();
    expect(testnetDeploymentOf(record, one, elsewhere)).toBeNull();
  });
});
