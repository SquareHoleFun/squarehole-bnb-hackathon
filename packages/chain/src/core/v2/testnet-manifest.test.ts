/**
 * SH-258: the release manifest of BNB Chain testnet (chain 97, network `bnb-testnet`): the v1 envelope with no core v1
 * version (no box 0 on 97) and the v2 release in `releases`, its fee holders the deployer's custody doubles. The
 * fixture (test/fixtures/bnb-testnet/core-manifest-97.json) has obviously fake addresses (0x97000…); SH-260 writes the
 * real file.
 */
import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import fixture from '../../../test/fixtures/bnb-testnet/core-manifest-97.json' with { type: 'json' };
import { coreDeploymentState, parseCoreManifestV2 } from './manifest-v2';
import { parseCoreManifest } from '../../config/core-manifest';
import { checkTestnetReleaseOnChain } from './testnet-release-check';
import { synthManifestV2Json } from './test-support/synth-v2';

type Json = Record<string, unknown>;
const copy = (): Json => JSON.parse(JSON.stringify(fixture)) as Json;
const release = (m: Json) => (m.releases as Json[])[0] as Json;
const safes = (m: Json) => release(m).safes as Record<'fit' | 'platform', Json>;

describe('the chain-97 manifest', () => {
  it('parses: network bnb-testnet, no core v1 version, one v2 release', () => {
    const m = parseCoreManifestV2(copy());
    expect([m.chainId, m.network, m.versions.length, m.releases.length]).toEqual([97, 'bnb-testnet', 0, 1]);
    expect(m.releases[0]?.registry.address).toBe('0x9700000000000000000000000000000000000017');
    expect(coreDeploymentState(copy())).toMatchObject({ status: 'deployed', manifest: { chainId: 97 } });
    const { releases, ...envelope } = copy();
    void releases;
    expect(parseCoreManifest(envelope)).toMatchObject({ status: 'deployed', chainId: 97 });
    expect(parseCoreManifest({ schema: 'squarehole.core-deployment/v1', status: 'awaiting-broadcast', chainId: 97, network: 'bnb-testnet' })).toMatchObject({ status: 'awaiting-broadcast' });
  });

  it('refuses a core v1 version on 97 (no box 0 on BNB Chain testnet)', () => {
    const m = copy();
    m.versions = (synthManifestV2Json().versions as unknown[]).slice(0, 1);
    expect(() => parseCoreManifestV2(m)).toThrow(/chain 97 has no core v1 version/);
  });

  it('binds network and chain: bnb-testnet is exactly 97', () => {
    expect(() => parseCoreManifestV2({ ...copy(), network: 'sepolia' })).toThrow(/network bnb-testnet is exactly chain 97/);
    expect(() => parseCoreManifestV2({ ...copy(), network: 'local' })).toThrow(/network bnb-testnet is exactly chain 97/);
    expect(() => parseCoreManifestV2({ ...copy(), chainId: 11_155_111 })).toThrow(/network bnb-testnet is exactly chain 97/);
    expect(() => parseCoreManifestV2({ ...copy(), chainId: 56, network: 'bnb-testnet' })).toThrow(/chainId/);
  });

  it('every other chain still needs core v1 version 1', () => {
    const local = synthManifestV2Json();
    expect(() => parseCoreManifestV2({ ...local, versions: [] })).toThrow(/versions: Too small/);
  });

  it('the custody doubles: two different accounts, the platform one the chain\'s; no Safe owner rules on 97', () => {
    // The fixture's fee holders are 1-of-1 with one owner: accepted on 97 ...
    expect(safes(copy()).fit.threshold).toBe('1');
    expect(() => parseCoreManifestV2(copy())).not.toThrow();
    // ... while FIT is 2-of-3 everywhere else (unchanged rule).
    const local = synthManifestV2Json();
    const fit = ((local.releases as Json[])[0]?.safes as Record<string, Json>).fit as Json;
    fit.owners = (fit.owners as string[]).slice(0, 1);
    fit.threshold = '1';
    expect(() => parseCoreManifestV2(local)).toThrow(/safes.fit: owner\/threshold mismatch/);

    const same = copy();
    safes(same).fit = { ...safes(same).platform };
    expect(() => parseCoreManifestV2(same)).toThrow(/distinct accounts required/);
    const other = copy();
    safes(other).platform = { ...safes(other).platform, address: '0x97000000000000000000000000000000000000ff' };
    expect(() => parseCoreManifestV2(other)).toThrow(/platform differs from box 0/);
  });
});

describe('checkTestnetReleaseOnChain', () => {
  const manifest = parseCoreManifestV2(copy());
  const hashes = new Map<string, Hex>();
  const add = (e: { address: string; codeHash: string }) => hashes.set(e.address.toLowerCase(), e.codeHash as Hex);
  for (const e of Object.values(manifest.chain)) add(e);
  const r = manifest.releases[0];
  if (!r) throw new Error('fixture without a release');
  for (const e of [r.factory, r.registry, r.listingRegistry, r.feeModuleDirectory, ...Object.values(r.implementations), r.safes.fit, r.safes.platform]) if (e) add(e);

  const reads = (o: { chainId?: number; missing?: string; registry?: string } = {}) => ({
    chainId: async () => o.chainId ?? 97,
    blockHash: async () => manifest.evidence.block.hash,
    codeHash: async (address: Address) => (address.toLowerCase() === o.missing ? ('0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470' as Hex) : (hashes.get(address.toLowerCase()) ?? ('0x00' as Hex))),
    call: async (_address: Address, view: string) => (view === 'registry' ? (o.registry ?? r.registry.address) : r.listingRegistry.address),
  });

  it('passes when every address has the manifest\'s code and the factory names its registries', async () => {
    await expect(checkTestnetReleaseOnChain(manifest, reads())).resolves.toEqual([]);
  });

  it('names a wrong chain, a missing code and a wrong registry', async () => {
    await expect(checkTestnetReleaseOnChain(manifest, reads({ chainId: 11_155_111 }))).resolves.toEqual(['the RPC is chain 11155111, not BNB Chain testnet (97)']);
    const missing = await checkTestnetReleaseOnChain(manifest, reads({ missing: r.implementations.hook.address.toLowerCase() }));
    expect(missing).toEqual([expect.stringMatching(/^releases\.0\.implementations\.hook 0x97.*: code hash 0xc5d2/)]);
    const wrong = await checkTestnetReleaseOnChain(manifest, reads({ registry: '0x97000000000000000000000000000000000000ee' }));
    expect(wrong).toEqual([expect.stringMatching(/factory\.registry\(\) is 0x97000000000000000000000000000000000000ee/)]);
  });
});
