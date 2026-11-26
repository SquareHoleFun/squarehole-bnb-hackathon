/** SH-SEP-MANIFEST: the Sepolia releases writer's output, on the fork plan fixture, loads through the poster's loader. */
import { describe, expect, it } from 'vitest';
import { buildSepoliaRelease } from '../../chain/src/core/v2/sepolia-release';
import { forkPlan, forkRun, forkV1Manifest, forkVerifyOutput } from '../../chain/src/core/v2/test-support/sepolia-release-fixture';
import { loadManifest } from '../src/config';

describe('SH-SEP-MANIFEST manifest for the CoW poster', () => {
  it('loads the written Sepolia manifest with its v2 release and refuses another chain', () => {
    const plan = forkPlan();
    const { json } = buildSepoliaRelease({ v1Manifest: forkV1Manifest(plan), plan, run: forkRun(plan), verifyOutput: forkVerifyOutput(plan), registry: plan.registry });
    const manifest = loadManifest(JSON.parse(JSON.stringify(json)), 11155111);
    expect(manifest.releases).toHaveLength(1);
    expect(manifest.releases[0]?.implementations.receiver.address.toLowerCase()).toBe(plan.implementations[5].toLowerCase());
    expect(() => loadManifest(JSON.parse(JSON.stringify(json)), 31337)).toThrow('manifest chain mismatch');
  });
});
