import { describe, expect, it, vi } from 'vitest';
import { zeroAddress } from 'viem';
import { parseSetManifest, checkSetFactoryIdentity, setFactoryV2Abi } from './index';
import { core, hash, required, setManifestInput } from './test-support';

describe('E08A-MANIFEST / SET-07', () => {
  it('parses a separate local add-on without appending a v2.1 release', () => {
    const before = JSON.stringify(core);
    expect(parseSetManifest(setManifestInput(), core)).toEqual({
      ...setManifestInput(),
      poolManager: { ...core.chain.poolManager, address: core.chain.poolManager.address.toLowerCase() },
      platformSafe: { ...core.chain.platformSafe, address: core.chain.platformSafe.address.toLowerCase() },
    });
    expect(JSON.stringify(core)).toBe(before);
    expect(core.releases).toHaveLength(1);
  });
  it('rejects every v1 and v2.1 registry including case variants', () => {
    const second = { ...required(core.releases[0]), registry: { ...setManifestInput().factory } };
    const extended = { ...core, releases: [...core.releases, second] };
    for (const registry of [...extended.versions, ...extended.releases].map(r => r.registry)) {
      const upper = `0x${registry.address.slice(2).toUpperCase()}`;
      expect(() => parseSetManifest({ ...setManifestInput(), registry: { ...registry, address: upper } }, extended)).toThrow(/registry/);
    }
  });
  it('binds chain, PoolManager and platform Safe addresses and hashes to core', () => {
    expect(() => parseSetManifest({ ...setManifestInput(), chainId: 11155111 }, core)).toThrow(/chain/);
    for (const key of ['poolManager', 'platformSafe'] as const) {
      for (const field of ['address', 'codeHash'] as const) {
        const pin = { ...setManifestInput()[key], [field]: setManifestInput().factory[field] };
        expect(() => parseSetManifest({ ...setManifestInput(), [key]: pin }, core)).toThrow(new RegExp(key));
      }
    }
  });
  it('rejects mismatched networks, unknown fields, missing implementations and wrong domains', () => {
    for (const fields of [
      { network: 'sepolia' }, { release: hash('wrong') }, { templateId: hash('wrong') },
      { releases: [] }, { factory: { ...setManifestInput().factory, address: zeroAddress } },
      { startBlock: 51 }, { startBlock: '01' }, { implementations: {} },
    ]) expect(() => parseSetManifest({ ...setManifestInput(), ...fields }, core)).toThrow();
    expect(() => parseSetManifest(setManifestInput(), { ...core, network: 'sepolia' })).toThrow();
    expect(() => parseSetManifest(setManifestInput(), { ...core, unexpected: true })).toThrow();
  });
  it('startup checks read the pinned factory and refuse each mismatching identity or failed read', async () => {
    const manifest = parseSetManifest(setManifestInput(), core);
    const values = { versionCodeHash: manifest.versionCodeHash, RELEASE: manifest.release, TEMPLATE: manifest.templateId };
    const read = vi.fn(async (request: { functionName: keyof typeof values }) => values[request.functionName]);
    await checkSetFactoryIdentity(manifest, read);
    expect(read.mock.calls.map(([r]) => r)).toEqual(Object.keys(values).map(functionName => ({ address: manifest.factory.address, abi: setFactoryV2Abi, functionName })));
    for (const bad of Object.keys(values)) {
      await expect(checkSetFactoryIdentity(manifest, async r => r.functionName === bad ? hash('wrong') : values[r.functionName])).rejects.toThrow(bad);
    }
    await expect(checkSetFactoryIdentity(manifest, async () => { throw new Error('read failed'); })).rejects.toThrow('read failed');
  });
});

describe('E09B-af1 / Sepolia manifest boundary', () => {
  const sepoliaCore = { ...core, network: 'sepolia' as const, chainId: 11155111 as const };
  const sepoliaSet = () => ({ ...setManifestInput(), network: 'sepolia', chainId: 11155111 });

  it('accepts Sepolia with a deployed v1 core, with or without v2.1 releases', () => {
    const { releases, ...v1 } = sepoliaCore;
    expect(releases).toHaveLength(1);
    for (const deployed of [v1, sepoliaCore]) {
      const before = JSON.stringify(deployed);
      expect(parseSetManifest(sepoliaSet(), deployed)).toMatchObject({ network: 'sepolia', chainId: 11155111 });
      expect(JSON.stringify(deployed)).toBe(before);
    }
  });
  it('preserves the local twin with Sepolia chain id', () => {
    expect(parseSetManifest({ ...setManifestInput(), chainId: 11155111 }, { ...core, chainId: 11155111 }))
      .toMatchObject({ network: 'local', chainId: 11155111 });
  });
  it('requires the same network and chain, with Sepolia restricted to 11155111', () => {
    const twin = { ...core, chainId: 11155111 };
    for (const [manifest, deployed] of [
      [sepoliaSet(), twin],
      [{ ...setManifestInput(), chainId: 11155111 }, sepoliaCore],
      [{ ...sepoliaSet(), chainId: 31337 }, core],
      [{ ...sepoliaSet(), chainId: 31337 }, { ...sepoliaCore, chainId: 31337 }],
      [setManifestInput(), twin],
    ]) expect(() => parseSetManifest(manifest, deployed)).toThrow(/network|chainId|Sepolia/);
  });
  it('requires a deployed Sepolia core', () => {
    expect(() => parseSetManifest(sepoliaSet(), {
      schema: core.schema, network: 'sepolia', chainId: 11155111, status: 'awaiting-broadcast',
    })).toThrow(/deployed/);
  });
  it('still binds both chain pins and excludes every old registry on Sepolia', () => {
    for (const key of ['poolManager', 'platformSafe'] as const) {
      for (const field of ['address', 'codeHash'] as const) {
        const input = sepoliaSet();
        const pin = { ...input[key], [field]: input.factory[field] };
        expect(() => parseSetManifest({ ...input, [key]: pin }, sepoliaCore)).toThrow(key);
      }
    }
    const secondV1 = { ...required(core.versions[0]), version: 2, registry: setManifestInput().factory };
    const secondV2 = { ...required(core.releases[0]), registry: setManifestInput().listingRegistry };
    const extended = { ...sepoliaCore, versions: [...core.versions, secondV1], releases: [...core.releases, secondV2] };
    for (const { registry } of [...extended.versions, ...extended.releases]) {
      expect(() => parseSetManifest({ ...sepoliaSet(), registry: {
        ...registry, address: `0x${registry.address.slice(2).toUpperCase()}`,
      } }, extended)).toThrow(/registry belongs to v1\/v2.1/);
    }
  });
  it('refuses mainnet manifests even when paired with matching core labels', () => {
    const input = { ...setManifestInput(), network: 'mainnet', chainId: 1 };
    expect(() => parseSetManifest(input, core)).toThrow();
    expect(() => parseSetManifest(input, { ...core, network: 'mainnet', chainId: 1 })).toThrow();
  });
});
