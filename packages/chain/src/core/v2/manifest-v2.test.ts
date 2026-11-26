/**
 * M1-52 red tests: v2 releases in the manifest beside v1 (core-v2-m1-tickets.md § 2, M1-52 Goal). The v1 manifest
 * (`squarehole.core-deployment/v1`, config/core-manifest.ts) is not edited: a v2 manifest is a deployed v1 manifest with
 * a `releases` list, each release named by its contracts and code hashes (file map § 11's singletons and every
 * implementation the release's clones are checked against). There is no listing or box field: listings come from the
 * listing registry's events and boxes from the registry's (BC-073's rule, ADR-0017 § 3).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCoreManifest } from '../../config/core-manifest';
import { ChainConfigError } from '../../errors';
import { PLATFORM_SAFE_MAINNET } from '@squarehole/box-spec';
import { labelAddress } from '../test-support';
import { coreDeploymentState, custodyPolicy, parseCoreManifestV2, releaseOfRegistry } from './manifest-v2';
import { V2, synthManifestV2Json } from './test-support/synth-v2';

const reason = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ChainConfigError) return error.message;
    throw error;
  }
  return 'accepted';
};

describe('M1-52 v2 releases beside v1 in the manifest', () => {
  it('M1-52 a deployed v1 manifest with a v2 release parses, and v1 stays as v1 parses it', () => {
    const json = synthManifestV2Json();
    const manifest = parseCoreManifestV2(json);
    expect(manifest.versions.map((v) => v.version)).toEqual([1]);
    expect(manifest.releases).toHaveLength(1);
    const release = manifest.releases[0];
    expect(release?.version).toBe(2);
    expect(release?.registry.address).toBe(V2.registry);
    expect(release?.listingRegistry.address).toBe(V2.listingRegistry);
    expect(Object.keys(release?.implementations ?? {}).sort()).toEqual(
      ['collection', 'coordinator', 'hook', 'hookExtension', 'launchRouter', 'receiver', 'royaltyRouter', 'tickets', 'token', 'vault'].sort(),
    );
    const v1 = Object.fromEntries(Object.entries(json).filter(([key]) => key !== 'releases'));
    expect(parseCoreManifest(v1)).toMatchObject({ status: 'deployed', versions: [{ version: 1 }] });
    expect(releaseOfRegistry(manifest, V2.registry.toLowerCase() as `0x${string}`)?.version).toBe(2);
    expect(releaseOfRegistry(manifest, manifest.versions[0]?.registry.address ?? V2.registry)).toBeNull();
  });

  it('M1-52 no per-listing or per-box field, no template gate, no unknown field', () => {
    const json = synthManifestV2Json();
    const release = (json.releases as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(reason(() => parseCoreManifestV2({ ...json, releases: [{ ...release, listings: [] }] }))).toMatch(/listings/);
    expect(reason(() => parseCoreManifestV2({ ...json, releases: [{ ...release, boxes: [] }] }))).toMatch(/boxes/);
    expect(reason(() => parseCoreManifestV2({ ...json, releases: [{ ...release, supportedTemplates: [] }] }))).toMatch(/supportedTemplates/);
    expect(reason(() => parseCoreManifestV2({ ...json, extra: 1 }))).not.toBe('accepted');
  });

  it('M1-52 a release with a missing implementation, a second release of one version or a late start block is refused', () => {
    const json = synthManifestV2Json();
    const release = (json.releases as Record<string, unknown>[])[0] as Record<string, unknown>;
    const impls = Object.fromEntries(Object.entries(release.implementations as Record<string, unknown>).filter(([key]) => key !== 'token'));
    expect(reason(() => parseCoreManifestV2({ ...json, releases: [{ ...release, implementations: impls }] }))).toMatch(/token/);
    expect(reason(() => parseCoreManifestV2({ ...json, releases: [release, release] }))).toMatch(/twice/);
    expect(reason(() => parseCoreManifestV2({ ...json, releases: [{ ...release, startBlock: '99999999' }] }))).toMatch(/startBlock/);
    expect(reason(() => parseCoreManifestV2({ ...json, releases: [] }))).toMatch(/release/);
  });

  it('H1 refuses retired release fields instead of discovering fictional deployments', () => {
    const json = synthManifestV2Json();
    const release = (json.releases as Record<string, unknown>[])[0] as Record<string, unknown>;
    for (const field of ['ethInHelper', 'converterDeployer', 'platformCap', 'executor']) {
      expect(reason(() => parseCoreManifestV2({ ...json, releases: [{ ...release, [field]: release.factory }] }))).toMatch(new RegExp(field));
    }
  });

  it('H1 requires all three deployment Safe pins', () => {
    const json = synthManifestV2Json();
    const release = (json.releases as Record<string, unknown>[])[0] as Record<string, unknown>;
    const withoutSafes = Object.fromEntries(Object.entries(release).filter(([key]) => key !== 'safes'));
    expect(reason(() => parseCoreManifestV2({ ...json, releases: [withoutSafes] }))).toMatch(/safes/);
  });
});


describe('INT-FIX5: current deployment boundaries', () => {
  it('validates a combined deployment before handing v1 readers their projection', () => {
    const json = synthManifestV2Json();
    const { releases, ...v1 } = json;
    expect(coreDeploymentState(json)).toEqual({ status: 'deployed', manifest: parseCoreManifest(v1) });
    expect(coreDeploymentState(v1)).toEqual({ status: 'deployed', manifest: parseCoreManifest(v1) });
    const release = (releases as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(coreDeploymentState({ ...json, releases: [{ ...release, safes: undefined }] }).status).toBe('invalid');
    expect(coreDeploymentState({ ...json, releases: [] }).status).toBe('invalid');
    expect(coreDeploymentState(null).status).toBe('none');
    expect(coreDeploymentState({ schema: 'squarehole.core-deployment/v1', status: 'awaiting-broadcast', chainId: 11155111, network: 'sepolia' }).status).toBe('awaiting-broadcast');
  });

  it('keeps box 0 platform identity, Safe owners and retired implementations strict', () => {
    const json = synthManifestV2Json();
    const release = (json.releases as Record<string, unknown>[])[0] as Record<string, unknown>;
    const safes = release.safes as Record<string, Record<string, unknown>>;
    const changePlatform = (fields: Record<string, unknown>) => ({ ...json, releases: [{ ...release, safes: { ...safes, platform: { ...safes.platform, ...fields } } }] });
    expect(reason(() => parseCoreManifestV2(changePlatform({ address: V2.factory })))).toMatch(/platform differs from box 0/);
    expect(reason(() => parseCoreManifestV2(changePlatform({ threshold: '2' })))).toMatch(/owner\/threshold mismatch/);
    for (const key of ['receiverExtension', 'sampler', 'swapModule', 'converter', 'converterExtension']) {
      expect(reason(() => parseCoreManifestV2({ ...json, releases: [{ ...release, implementations: { ...release.implementations as object, [key]: release.factory } }] }))).toContain(key);
    }
  });

  it('accepts the Safe block emitted by DeployCoreV2, including its separate platform version', () => {
    const emitted = JSON.parse(readFileSync(new URL('../../../../contracts/script/sepolia-v2/release-manifest.rc5.local.json', import.meta.url), 'utf8')) as {
      safes: { platform: { address: string; codeHash: string; version: string } };
    };
    const json = synthManifestV2Json();
    const chain = json.chain as Record<string, unknown>;
    const releases = json.releases as Record<string, unknown>[];
    const parsed = parseCoreManifestV2({
      ...json, chain: { ...chain, platformSafe: { address: emitted.safes.platform.address, codeHash: emitted.safes.platform.codeHash } },
      releases: releases.map(release => ({ ...release, safes: emitted.safes })),
    });
    expect(parsed.releases[0]?.safes.platform.version).toBe(emitted.safes.platform.version);
    expect(parsed.releases[0]?.safes.platform.controlTransferProof).toBe('pending');
    // A simulation release description is not a deployed chain manifest.
    expect(() => parseCoreManifestV2(emitted)).toThrow(ChainConfigError);
  });

  it('names the nine deployed clone slots plus the shared hook extension', () => {
    const script = readFileSync(new URL('../../../../contracts/script/sepolia-v2/CoreV2Deployment.sol', import.meta.url), 'utf8');
    const slots = [...script.matchAll(/r\.implementations\[(\d+)\] =/g)].map(m => m[1]);
    expect(slots).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8']);
    expect(script).toContain('BoxHookV2Extension.sol:BoxHookV2Extension');
    expect(Object.keys(parseCoreManifestV2(synthManifestV2Json()).releases[0]?.implementations ?? {}).sort()).toEqual(
      ['coordinator', 'token', 'hook', 'vault', 'collection', 'receiver', 'launchRouter', 'tickets', 'royaltyRouter', 'hookExtension'].sort(),
    );
  });
});


describe('SH-188 (F151 R68-SAFE): the platform Safe is 2-of-3 on chain 1, 1-of-1 elsewhere', () => {
  const founder = labelAddress('owner:founder');
  const bot = labelAddress('owner:bot');
  const backup = labelAddress('owner:backup');
  const second = labelAddress('owner:second');
  const third = labelAddress('owner:third');
  const roles = { founder, bot, backup };
  type Change = { platform?: Record<string, unknown>; fit?: Record<string, unknown>; owners?: unknown; chain?: 'mainnet' | 'sepolia' | 'local' };
  /** The synthetic release on chain 1 (mainnet's platform Safe address), the founder last as Safe lists him after step 6. */
  function release(change: Change = {}): Record<string, unknown> {
    const json = synthManifestV2Json();
    const r = (json.releases as Record<string, unknown>[])[0] as Record<string, unknown>;
    const safes = r.safes as Record<string, Record<string, unknown>>;
    const net = change.chain ?? 'mainnet';
    const onMainnet = net === 'mainnet';
    const platformAddress = onMainnet ? PLATFORM_SAFE_MAINNET : V2.platformSafe;
    const chain = { ...(json.chain as Record<string, unknown>), platformSafe: { ...(json.chain as Record<string, Record<string, unknown>>).platformSafe, address: platformAddress } };
    const platform = { ...safes.platform, address: platformAddress, ...(onMainnet ? { owners: [third, second, founder], threshold: '2' } : {}), ...change.platform };
    const owners = 'owners' in change ? change.owners : onMainnet ? roles : undefined;
    const next = { ...r, safes: { fit: { ...safes.fit, ...change.fit }, platform }, ...(owners === undefined ? {} : { owners }) };
    return { ...json, chainId: onMainnet ? 1 : net === 'sepolia' ? 11_155_111 : 31_337, network: net, chain, releases: [next] };
  }

  it('the policy: FIT 2-of-3 everywhere; the platform 2-of-3 on chain 1 only', () => {
    expect(custodyPolicy(1)).toEqual({ fit: { threshold: '2', count: 3 }, platform: { threshold: '2', count: 3 } });
    for (const chainId of [11_155_111, 31_337]) expect(custodyPolicy(chainId).platform).toEqual({ threshold: '1', count: 1 });
  });

  it('accepts the 2-of-3 platform Safe on chain 1 with the founder first, between or last', () => {
    for (const order of [[founder, second, third], [second, founder, third], [third, second, founder]]) {
      const parsed = parseCoreManifestV2(release({ platform: { owners: order } }));
      expect(parsed.chainId).toBe(1);
      expect(parsed.releases[0]?.safes.platform.threshold).toBe('2');
      expect(parsed.releases[0]?.owners).toEqual(roles);
    }
  });

  it('the founder may also pick the backup as one of the two new owners', () => {
    expect(parseCoreManifestV2(release({ platform: { owners: [backup, second, founder] } })).releases).toHaveLength(1);
  });

  it('refuses a wrong threshold on chain 1: the 1-of-1 Safe, threshold 1 with three owners, threshold 3', () => {
    expect(reason(() => parseCoreManifestV2(release({ platform: { owners: [founder], threshold: '1' } })))).toMatch(/safes\.platform: owner\/threshold mismatch \(3 owners at threshold 2 on chain 1\)/);
    expect(reason(() => parseCoreManifestV2(release({ platform: { threshold: '1' } })))).toMatch(/safes\.platform: owner\/threshold mismatch/);
    expect(reason(() => parseCoreManifestV2(release({ platform: { threshold: '3' } })))).toMatch(/safes\.platform: owner\/threshold mismatch/);
  });

  it('refuses a wrong owner count on chain 1: one, two, four or a repeated owner', () => {
    for (const owners of [[founder], [second, founder], [third, second, founder, labelAddress('owner:fourth')], [second, second, founder]]) {
      expect(reason(() => parseCoreManifestV2(release({ platform: { owners } })))).toMatch(/safes\.platform: owner\/threshold mismatch/);
    }
  });

  it('fails closed on chain 1 without the owner roles, with partial roles, or roles naming one account twice', () => {
    expect(reason(() => parseCoreManifestV2(release({ owners: undefined })))).toMatch(/releases\.0\.owners: the founder, bot and backup roles are required on chain 1/);
    expect(reason(() => parseCoreManifestV2(release({ owners: { founder, bot } })))).toMatch(/owners\.backup/);
    expect(reason(() => parseCoreManifestV2(release({ owners: { ...roles, second } })))).toMatch(/owners/);
    expect(reason(() => parseCoreManifestV2(release({ owners: { founder, bot, backup: bot } })))).toMatch(/three accounts/);
  });

  it('refuses the bot as a platform owner, a platform Safe without the founder, and FIT owners other than the roles', () => {
    expect(reason(() => parseCoreManifestV2(release({ platform: { owners: [bot, second, founder] } })))).toMatch(/the bot is never a platform owner/);
    expect(reason(() => parseCoreManifestV2(release({ platform: { owners: [third, second, backup] } })))).toMatch(/the founder is not an owner/);
    expect(reason(() => parseCoreManifestV2(release({ fit: { owners: [founder, bot, second] } })))).toMatch(/safes\.fit: owners are not the bot, the founder and the backup/);
    expect(reason(() => parseCoreManifestV2(release({ fit: { threshold: '1' } })))).toMatch(/safes\.fit: owner\/threshold mismatch/);
  });

  it('Sepolia and local stay 1-of-1, with or without the roles; a 2-of-3 platform Safe there is refused', () => {
    for (const chain of ['sepolia', 'local'] as const) {
      expect(parseCoreManifestV2(release({ chain })).releases[0]?.safes.platform.threshold).toBe('1');
      expect(parseCoreManifestV2(release({ chain, owners: roles })).releases[0]?.owners).toEqual(roles);
      expect(reason(() => parseCoreManifestV2(release({ chain, platform: { owners: [third, second, founder], threshold: '2' } })))).toMatch(/owner\/threshold mismatch \(1 owners at threshold 1/);
      expect(reason(() => parseCoreManifestV2(release({ chain, owners: { founder: second, bot, backup } })))).toMatch(/safes\.fit: owners are not/);
      expect(reason(() => parseCoreManifestV2(release({ chain, platform: { owners: [bot] }, owners: roles })))).toMatch(/the founder is not an owner/);
    }
  });

  it("Sepolia's committed release keeps its 1-of-1 platform Safe and parses unchanged", () => {
    const committed = JSON.parse(readFileSync(new URL('../../../../contracts/deployments/core-v1/11155111.json', import.meta.url), 'utf8')) as unknown;
    const parsed = parseCoreManifestV2(committed);
    expect(parsed.chainId).toBe(11_155_111);
    for (const r of parsed.releases) {
      expect(r.safes.platform.threshold).toBe('1');
      expect(r.safes.platform.owners).toHaveLength(1);
      expect(r.owners).toBeUndefined();
    }
  });
});
