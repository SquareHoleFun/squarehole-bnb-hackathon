/**
 * Which core v1 deployment a source reads (S10a § 2.3): Sepolia's committed manifest (box 0's deployed version since
 * 2026-10-21) is the Sepolia source's; a placeholder reads as "Core v1 is not on Sepolia yet" and never yields an
 * address; a deployed local twin manifest is the local source's.
 */
import { CORE_ARWEAVE, CORE_MANIFESTS } from 'virtual:squarehole-deployments';
import { describe, expect, it } from 'vitest';
import { CORE_NOT_LOCAL, CORE_NOT_ON_SEPOLIA, coreAvailability, coreSourceFor, localCoreWalletChainId, localV2WalletChainId, type CoreBuild } from './core-build';
import { synthManifestV2 } from '../../../../../packages/chain/src/core/v2/test-support/synth-v2';
import { sourceV2 } from './v2/indexer-v2';

const entry = (n: number) => ({ address: `0x${n.toString(16).padStart(40, '0')}`, codeHash: `0x${n.toString(16).padStart(64, '0')}` });
const IMPLS = ['coordinator', 'hook', 'hookExtension', 'launchRouter', 'receiver', 'receiverExtension', 'collection', 'vault', 'tickets', 'royaltyRouter', 'itemStream'];
export const LOCAL_CORE_MANIFEST = {
  schema: 'squarehole.core-deployment/v1',
  status: 'deployed',
  chainId: 11_155_111,
  network: 'local',
  chain: { poolManager: entry(1), weth: entry(2), randomness: entry(3), platformSafe: entry(4) },
  versions: [{ version: 1, factory: entry(5), registry: entry(6), startBlock: '100', implementations: Object.fromEntries(IMPLS.map((k, i) => [k, entry(10 + i)])), versionCodeHash: entry(30).codeHash, supportedTemplates: [entry(31).codeHash] }],
  evidence: { block: { number: '200', hash: entry(32).codeHash }, finality: 'confirmed' },
  gitCommit: null,
};

const build = (manifests: readonly unknown[]): CoreBuild => ({ manifests, localRpcUrl: 'http://127.0.0.1:8562', indexers: { local: 'http://127.0.0.1:5398', sepolia: null } });

/**
 * SH-ARWEAVE-PICTURES-WEB fix round 2 (F3): the unit-test build never turns Arweave on, even when the shell that runs
 * the tests exports SH_ARWEAVE_PICTURES=1 (vite.config.ts clears it under Vitest; the plugin refuses it there too).
 */
describe('Arweave in the unit-test build', () => {
  it('is off for every source, whatever the invoking environment exports', () => {
    expect(CORE_ARWEAVE).toEqual({ local: false, sepolia: false });
  });
});

describe('core v1 sources', () => {
  it('this build embeds Sepolia\'s deployed manifest (box 0, 2026-10-21): the Sepolia source reads its registry', () => {
    expect(CORE_MANIFESTS).toHaveLength(1);
    const sepolia = coreSourceFor('sepolia', build(CORE_MANIFESTS), 'https://rpc.example');
    expect(sepolia).toMatchObject({ status: 'ready', network: 'sepolia', chainId: 11_155_111, rpcUrl: 'https://rpc.example', indexerOrigin: null });
    if (sepolia.status !== 'ready') throw new Error(sepolia.reason);
    expect(sepolia.version1?.registry.address).toBe('0xa94936CD8994FA94FA31bc1fC992586f2468bfcb');
    expect(coreAvailability(CORE_MANIFESTS)).toEqual({ sepolia: 'deployed', local: false });
    expect(coreSourceFor('local', build(CORE_MANIFESTS), 'https://rpc.example')).toEqual({ status: 'none', reason: CORE_NOT_LOCAL });
    expect(coreSourceFor('demo', build(CORE_MANIFESTS), 'https://rpc.example').status).toBe('none');
  });

  it('a Sepolia placeholder (before a broadcast): the site says core v1 is not on Sepolia yet and names no address', () => {
    const placeholder = { schema: 'squarehole.core-deployment/v1', status: 'awaiting-broadcast', chainId: 11_155_111, network: 'sepolia' };
    const sepolia = coreSourceFor('sepolia', build([placeholder]), 'https://rpc.example');
    expect(sepolia).toEqual({ status: 'awaiting-broadcast', reason: CORE_NOT_ON_SEPOLIA });
    expect(JSON.stringify(sepolia)).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(coreAvailability([placeholder])).toEqual({ sepolia: 'awaiting-broadcast', local: false });
  });

  it('a deployed local twin is the local source\'s: its own RPC and indexer, chain id from the manifest', () => {
    const local = coreSourceFor('local', build([...CORE_MANIFESTS, LOCAL_CORE_MANIFEST]), 'https://rpc.example');
    expect(local).toMatchObject({ status: 'ready', network: 'local', chainId: 11_155_111, rpcUrl: 'http://127.0.0.1:8562', indexerOrigin: 'http://127.0.0.1:5398' });
    expect(coreAvailability([LOCAL_CORE_MANIFEST])).toEqual({ sepolia: 'none', local: true });
  });

  it('an invalid or doubled manifest is reported, never chosen between', () => {
    expect(coreSourceFor('local', build([{ ...LOCAL_CORE_MANIFEST, boxes: [] }]), 'x').status).toBe('invalid');
    expect(coreSourceFor('local', build([LOCAL_CORE_MANIFEST, LOCAL_CORE_MANIFEST]), 'x').status).toBe('invalid');
  });

  it('routes one validated combined deployment to both readers and source availability', () => {
    const manifest = synthManifestV2();
    const input = build([manifest]);
    expect(sourceV2('local', input)?.manifest).toEqual(manifest);
    const v1 = coreSourceFor('local', input, 'https://rpc.example');
    expect(v1.status).toBe('ready');
    if (v1.status !== 'ready') throw new Error(v1.reason);
    const { releases: _releases, ...projection } = manifest;
    void _releases;
    expect(v1.manifest).toEqual(projection);
    expect(coreAvailability([manifest]).local).toBe(true);
    expect(coreAvailability([{ ...manifest, network: 'sepolia', chainId: 11155111 }]).sepolia).toBe('deployed');
  });

  it.each([{ releases: [] }, { releases: null }, { releases: [{ version: 2 }] }])('rejects malformed releases instead of silently stripping them: %j', ({ releases }) => {
    const manifest = { ...synthManifestV2(), releases };
    expect(coreSourceFor('local', build([manifest]), 'x').status).toBe('invalid');
    expect(coreAvailability([manifest]).local).toBe(false);
  });

  it('still refuses duplicate and unknown fields on a combined manifest', () => {
    const manifest = synthManifestV2();
    const { releases: _releases, ...v1 } = manifest;
    void _releases;
    for (const manifests of [[manifest, v1], [{ ...manifest, boxes: [] }]]) {
      expect(coreSourceFor('local', build(manifests), 'x').status).toBe('invalid');
      expect(coreAvailability(manifests).local).toBe(false);
    }
  });
});

describe('the wallet chain of a local core v2 deployment (SH-V21-EXAMPLES-E2E-FIX2 O-2)', () => {
  it('is its manifest’s chain; a core v1 twin, an invalid or missing local manifest give none', () => {
    const manifest = synthManifestV2();
    expect(localV2WalletChainId([manifest])).toBe(manifest.chainId);
    expect(localV2WalletChainId([{ ...manifest, chainId: 11_155_111 }])).toBe(11_155_111);
    expect(localV2WalletChainId([LOCAL_CORE_MANIFEST])).toBeNull();
    expect(localV2WalletChainId([{ ...manifest, releases: [] }])).toBeNull();
    expect(localV2WalletChainId([manifest, manifest])).toBeNull();
    expect(localV2WalletChainId(CORE_MANIFESTS)).toBeNull();
  });
});

describe('the wallet chain of the local core twin (SH-BOX0-ACTIONS: box 0 draws, opens and claims there)', () => {
  it('is the v2 deployment’s chain, else a deployed core v1 twin’s; nothing for an invalid, undeployed or missing manifest', () => {
    const manifest = synthManifestV2();
    expect(localCoreWalletChainId([manifest])).toBe(manifest.chainId);
    expect(localCoreWalletChainId([LOCAL_CORE_MANIFEST])).toBe(11_155_111);
    expect(localCoreWalletChainId([{ ...LOCAL_CORE_MANIFEST, status: 'awaiting-broadcast' }])).toBeNull();
    expect(localCoreWalletChainId([{ ...LOCAL_CORE_MANIFEST, network: 'sepolia' }])).toBeNull();
    expect(localCoreWalletChainId([LOCAL_CORE_MANIFEST, LOCAL_CORE_MANIFEST])).toBeNull();
    expect(localCoreWalletChainId([])).toBeNull();
  });
});
