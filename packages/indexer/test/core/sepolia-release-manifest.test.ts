/** SH-SEP-MANIFEST: the Sepolia releases writer's output, on the fork plan fixture, loads through the indexer's config. */
import { describe, expect, it } from 'vitest';
import { buildSepoliaRelease } from '../../../chain/src/core/v2/sepolia-release';
import { forkPlan, forkRun, forkV1Manifest, forkVerifyOutput } from '../../../chain/src/core/v2/test-support/sepolia-release-fixture';
import { loadCoreConfig } from '../../src/core/core-config';

describe('SH-SEP-MANIFEST manifest for the indexer', () => {
  it('loads the written Sepolia manifest as a v2 manifest on the public Sepolia RPCs', () => {
    const plan = forkPlan();
    const { json } = buildSepoliaRelease({ v1Manifest: forkV1Manifest(plan), plan, run: forkRun(plan), verifyOutput: forkVerifyOutput(plan), registry: plan.registry });
    const config = loadCoreConfig({ SH_CORE_MANIFEST: '/manifests/11155111.json' }, () => `${JSON.stringify(json, null, 2)}\n`);
    expect(config.manifest.network).toBe('sepolia');
    expect('releases' in config.manifest ? config.manifest.releases.map((r) => r.startBlock) : []).toEqual([String(BigInt(plan.observedBlock) + 40n)]);
    expect(config.httpUrls.length).toBeGreaterThan(0);
  });
});
