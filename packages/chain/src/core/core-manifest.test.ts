/**
 * The core v1 manifest (S10a § 2.3; BC-073: no per-box setting): the parser accepts `deployed` and `awaiting-broadcast`
 * only and refuses any per-box field; Sepolia's committed file is box 0's deployed version (written from chain reads after
 * the broadcast); the read-only writer builds a manifest from chain reads that the parser accepts, and refuses what it
 * cannot observe.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOX_0_MISFITS, PLATFORM_SAFE_MAINNET } from '@squarehole/box-spec';
import { keccak256, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { coreManifestState, coreVersion1, parseCoreManifest, type DeployedCoreManifest } from '../config/core-manifest';
import { ChainConfigError } from '../errors';
import { isWriteChainId, writeChain } from '../write/chains';
import { readCoreManifest, EMPTY_CODE_HASH, type CoreReads } from './core-manifest-writer';
import { coreDeploymentState, parseCoreManifestV2 } from './v2/manifest-v2';
import { labelAddress, labelHash, registryLogs, syntheticBox } from './test-support';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEPOLIA_FILE = resolve(HERE, '../../../contracts/deployments/core-v1/11155111.json');
const MAINNET_FILE = resolve(HERE, '../../../contracts/deployments/core-v1/1.json');

const entry = (label: string) => ({ address: labelAddress(label), codeHash: labelHash(`code:${label}`) });
const IMPLS = ['coordinator', 'hook', 'hookExtension', 'launchRouter', 'receiver', 'receiverExtension', 'collection', 'vault', 'tickets', 'royaltyRouter', 'itemStream'] as const;

function deployedManifest(): Record<string, unknown> {
  return {
    schema: 'squarehole.core-deployment/v1',
    status: 'deployed',
    chainId: 11_155_111,
    network: 'sepolia',
    chain: { poolManager: entry('pm'), weth: entry('weth'), randomness: entry('drand'), platformSafe: entry('safe') },
    versions: [
      {
        version: 1,
        factory: entry('factory'),
        registry: entry('registry'),
        startBlock: '9000000',
        implementations: Object.fromEntries(IMPLS.map((k) => [k, entry(`impl:${k}`)])),
        versionCodeHash: labelHash('version'),
        supportedTemplates: [labelHash('template-0')],
      },
    ],
    evidence: { block: { number: '9000100', hash: labelHash('evidence') }, finality: 'finalized' },
    gitCommit: 'a'.repeat(40),
  };
}

const reason = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ChainConfigError) return error.message;
    throw error;
  }
  return 'accepted';
};

describe('squarehole.core-deployment/v1', () => {
  it('Sepolia\'s committed file is box 0\'s deployed version, written from finalized chain reads after the broadcast (2026-10-21), with core v2 rc8 as its one release (SH-TA-10)', () => {
    const file = JSON.parse(readFileSync(SEPOLIA_FILE, 'utf8')) as Record<string, unknown>;
    // The v1 envelope is unchanged by the release entry: the strict v1 parser reads the file without `releases`.
    const { releases: _releases, ...json } = file;
    void _releases;
    const parsed = parseCoreManifest(json) as DeployedCoreManifest;
    expect(parsed).toMatchObject({ status: 'deployed', chainId: 11_155_111, network: 'sepolia', evidence: { finality: 'finalized' } });
    // docs/runbooks/sepolia-core-v1.md Step 2's identities (the testnet deployer at nonce 13, the platform Safe).
    const v1 = coreVersion1(parsed);
    expect(v1.factory.address).toBe('0x93118f6F6E059B69Cba1Ce3F9ac9Ab8E7B0bc087');
    expect(v1.registry.address).toBe('0xa94936CD8994FA94FA31bc1fC992586f2468bfcb');
    expect(v1.startBlock).toBe('11960339');
    expect(v1.versionCodeHash).toBe('0xb7c58a7f40ead74e614ca6a76f199447c9246c28f5d01c73acb17931b19c3319');
    expect(v1.supportedTemplates).toEqual(['0xf4b0c60866afb9c087dd51ff9c9ec0f599aa3c9d1329acdf8137fda2f58545da']);
    expect(parsed.chain.randomness.address).toBe('0x4FE27aE2810DAdA5F2f0f425F6623FdbE6A321fb');
    expect(parsed.chain.platformSafe.address).toBe('0x9432380a67745b453886698F9539aC035DF80B34');
    expect(coreManifestState(json)).toEqual({ status: 'deployed', manifest: parsed });
    expect(coreManifestState(null)).toEqual({ status: 'none' });
    // The rewrite after the v2 receipts (SH-TA-10): evidence block at or after the release's last receipt (11973638).
    expect(BigInt(parsed.evidence.block.number)).toBeGreaterThanOrEqual(11_973_638n);
    expect(coreDeploymentState(file)).toEqual({ status: 'deployed', manifest: parsed });
    const v2 = parseCoreManifestV2(file);
    expect(v2.releases.length).toBe(1);
    expect(v2.releases[0]).toMatchObject({
      version: 2,
      factory: { address: '0xFAe1E6CFF43CAdcBE01885BdD0AA6218263de393' },
      registry: { address: '0x5D2866EF084d801aE734D3A2A6E4F7179898737C' },
      listingRegistry: { address: '0x84Dc1E9Cd7da248f85133E5e03EF3A303a51072D' },
      feeModuleDirectory: { address: '0xF856948cEc46e79249Ba4E3Fdb9796CB5f182c93', codeHash: '0x846c54958a4a6e7564eed649a64ec755c61b6075398ce0b1d402e1b9709955fa' },
      // The parser keeps Safe addresses lowercase (it compares them with box 0's platform).
      safes: { platform: { address: '0x9432380a67745b453886698f9539ac035df80b34' }, fit: { address: '0x19a17f066b1920b1e7ac6d9176b7091a42c0446f' } },
      startBlock: '11973601',
    });
  });

  it('a placeholder (a chain core v1 is not on yet) names no address at all', () => {
    const placeholder = { schema: 'squarehole.core-deployment/v1', status: 'awaiting-broadcast', chainId: 11_155_111, network: 'sepolia', note: 'Core v1 is not on Sepolia yet.' };
    expect(parseCoreManifest(placeholder)).toMatchObject({ status: 'awaiting-broadcast', chainId: 11_155_111, network: 'sepolia' });
    expect(coreManifestState(placeholder)).toEqual({ status: 'awaiting-broadcast', chainId: 11_155_111, network: 'sepolia' });
  });

  it('accepts a deployed manifest and finds version 1', () => {
    const parsed = parseCoreManifest(deployedManifest()) as DeployedCoreManifest;
    expect(coreVersion1(parsed).registry.address).toBe(labelAddress('registry'));
  });

  it('accepts deployed and awaiting-broadcast only', () => {
    for (const status of ['simulated', 'pending-broadcast', 'dry-run', '']) {
      expect(reason(() => parseCoreManifest({ ...deployedManifest(), status }))).toMatch(/rejected/);
    }
    expect(reason(() => parseCoreManifest({ schema: 'squarehole.deployment/v1', status: 'awaiting-broadcast', chainId: 11_155_111, network: 'sepolia' }))).toMatch(/schema/);
  });

  it('BC-073: refuses every per-box field: boxes come only from the registry', () => {
    const base = deployedManifest();
    const v = (base.versions as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(reason(() => parseCoreManifest({ ...base, boxes: [{ token: labelAddress('t') }] }))).toMatch(/boxes|Unrecognized/i);
    expect(reason(() => parseCoreManifest({ ...base, box0: { token: labelAddress('t') } }))).toMatch(/box0|Unrecognized/i);
    expect(reason(() => parseCoreManifest({ ...base, versions: [{ ...v, box0Token: labelAddress('t') }] }))).toMatch(/box0Token|Unrecognized/i);
    expect(reason(() => parseCoreManifest({ ...base, versions: [{ ...v, poolId: labelHash('pool') }] }))).toMatch(/poolId|Unrecognized/i);
    expect(reason(() => parseCoreManifest({ schema: 'squarehole.core-deployment/v1', status: 'awaiting-broadcast', chainId: 11_155_111, network: 'sepolia', token: labelAddress('t') }))).toMatch(/token|Unrecognized/i);
  });

  it('refuses a chain-1 file that is not mainnet, the zero address, a start after the evidence and a missing version 1', () => {
    expect(reason(() => parseCoreManifest({ ...deployedManifest(), chainId: 1 }))).toMatch(/chainId/);
    const zero = deployedManifest();
    (zero.chain as Record<string, unknown>).weth = { address: '0x0000000000000000000000000000000000000000', codeHash: labelHash('x') };
    expect(reason(() => parseCoreManifest(zero))).toMatch(/zero address/);
    const late = deployedManifest();
    ((late.versions as Record<string, unknown>[])[0] as Record<string, unknown>).startBlock = '9000101';
    expect(reason(() => parseCoreManifest(late))).toMatch(/startBlock/);
    const v2only = deployedManifest();
    ((v2only.versions as Record<string, unknown>[])[0] as Record<string, unknown>).version = 2;
    expect(reason(() => parseCoreManifest(v2only))).toMatch(/version 1/);
    expect(reason(() => parseCoreManifest({ ...deployedManifest(), network: 'mainnet' }))).toMatch(/network/);
  });
});

describe('SH-188: chain 1 in the shared manifest, as data only', () => {
  const mainnetDeployed = (): Record<string, unknown> => ({
    ...deployedManifest(), chainId: 1, network: 'mainnet',
    chain: { ...(deployedManifest().chain as Record<string, unknown>), platformSafe: { address: PLATFORM_SAFE_MAINNET, codeHash: labelHash('code:safe') } },
  });

  it('the committed chain-1 file awaits the broadcast and names nothing else: every address is unknown', () => {
    const file = JSON.parse(readFileSync(MAINNET_FILE, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(file).sort()).toEqual(['chainId', 'network', 'note', 'schema', 'status']);
    expect(parseCoreManifest(file)).toMatchObject({ status: 'awaiting-broadcast', chainId: 1, network: 'mainnet' });
    expect(coreManifestState(file)).toEqual({ status: 'awaiting-broadcast', chainId: 1, network: 'mainnet' });
    expect(coreDeploymentState(file)).toEqual({ status: 'awaiting-broadcast', chainId: 1, network: 'mainnet' });
  });

  it('every consumer of the awaiting file refuses it: the v2 parser (CoW poster, indexer v2, site v2) finds no deployment', () => {
    const file = JSON.parse(readFileSync(MAINNET_FILE, 'utf8')) as Record<string, unknown>;
    expect(reason(() => parseCoreManifestV2(file))).toMatch(/core v1 is not deployed/);
    expect(reason(() => parseCoreManifestV2({ ...file, releases: [] }))).toMatch(/core v1 is not deployed/);
  });

  it('an awaiting chain-1 file with any address, or a placeholder in place of one, is refused', () => {
    const file = JSON.parse(readFileSync(MAINNET_FILE, 'utf8')) as Record<string, unknown>;
    expect(reason(() => parseCoreManifest({ ...file, chain: { platformSafe: { address: PLATFORM_SAFE_MAINNET, codeHash: labelHash('x') } } }))).toMatch(/chain|Unrecognized/i);
    expect(reason(() => parseCoreManifest({ ...file, versions: [] }))).toMatch(/versions|Unrecognized/i);
    const pending = mainnetDeployed();
    (pending.chain as Record<string, unknown>).weth = { address: 'unknown until deploy', codeHash: labelHash('x') };
    expect(reason(() => parseCoreManifest(pending))).toMatch(/weth/);
  });

  it('mainnet is exactly chain 1, both ways, in both states', () => {
    const awaiting = { schema: 'squarehole.core-deployment/v1', status: 'awaiting-broadcast' };
    expect(reason(() => parseCoreManifest({ ...awaiting, chainId: 1, network: 'sepolia' }))).toMatch(/network mainnet is exactly chain 1/);
    expect(reason(() => parseCoreManifest({ ...awaiting, chainId: 1, network: 'local' }))).toMatch(/network mainnet is exactly chain 1/);
    expect(reason(() => parseCoreManifest({ ...awaiting, chainId: 11_155_111, network: 'mainnet' }))).toMatch(/network mainnet is exactly chain 1/);
    expect(reason(() => parseCoreManifest({ ...awaiting, chainId: 31_337, network: 'mainnet' }))).toMatch(/network mainnet is exactly chain 1/);
    expect(reason(() => parseCoreManifest({ ...mainnetDeployed(), network: 'sepolia' }))).toMatch(/chainId|network/);
    expect(reason(() => parseCoreManifest({ ...awaiting, chainId: 10, network: 'mainnet' }))).toMatch(/chainId/);
  });

  it('a deployed chain-1 manifest parses only with the mainnet platform Safe', () => {
    expect(parseCoreManifest(mainnetDeployed())).toMatchObject({ status: 'deployed', chainId: 1, network: 'mainnet' });
    const other = mainnetDeployed();
    (other.chain as Record<string, unknown>).platformSafe = entry('safe');
    expect(reason(() => parseCoreManifest(other))).toMatch(/platform Safe is 0xdCE82e76456434d0f550b492Ff212A862221e6c5/);
  });

  it('nothing can send on chain 1: the write side still has no chain 1 (G08)', () => {
    expect(isWriteChainId(1)).toBe(false);
    expect(() => writeChain(1)).toThrow(/Chain 1 has no write configuration/);
  });
});

/** A chain where factory v1 and box 0 exist, read through `CoreReads`. */
function fakeChain(
  overrides: { boxCount?: bigint; registryFactory?: Address; noCode?: Address; chainId?: number; badLogs?: boolean; platform?: Address; specPlatform?: Address } = {},
): CoreReads {
  const factory = labelAddress('factory');
  const registry = labelAddress('registry');
  const platform = overrides.platform ?? labelAddress('safe');
  // Box 0's spec names the platform as marketplaceOwner (the deploy script refuses another: PlatformSafeMismatch).
  const spec = { ...BOX_0_MISFITS, marketplaceOwner: overrides.specPlatform ?? platform };
  const box = syntheticBox({ spec, creationBlock: 9_000_000n, templateId: labelHash('template-0') });
  const logs = registryLogs(box, { registry, blockNumber: 9_000_000n, blockHash: labelHash('b9000000') });
  const impls = Object.fromEntries(['coordinator', 'hook', 'launchRouter', 'receiver', 'collection', 'vault', 'tickets', 'royaltyRouter', 'itemStream'].map((k) => [k, labelAddress(`impl:${k}`)]));
  const views: Record<string, unknown> = {
    'factory.registry': registry,
    'factory.poolManager': labelAddress('pm'),
    'factory.weth': labelAddress('weth'),
    'factory.randomness': labelAddress('drand'),
    'factory.platformSafe': platform,
    'factory.implementations': impls,
    'factory.hookExtension': labelAddress('impl:hookExtension'),
    'factory.receiverExtension': labelAddress('impl:receiverExtension'),
    'factory.versionCodeHash': labelHash('version'),
    'factory.VERSION': 1,
    'registry.factory': overrides.registryFactory ?? factory,
    'registry.boxCount': overrides.boxCount ?? 1n,
    'registry.entry': [box.record.contracts[0], 9_000_000n, labelHash('template-0'), box.record.specHash, labelHash('record')],
  };
  return {
    chainId: async () => overrides.chainId ?? 11_155_111,
    block: async () => ({ number: 9_000_100n, hash: labelHash('evidence') }),
    call: async (_address, name, abi) => {
      const key = `${abi}.${name}`;
      if (!(key in views)) throw new Error(`no view ${key}`);
      return views[key];
    },
    codeHash: async (address) => (overrides.noCode && address === overrides.noCode ? EMPTY_CODE_HASH : keccak256(address as Hex)),
    registryLogs: async () => (overrides.badLogs ? [logs[0]] : logs),
  };
}

describe('the read-only manifest writer', () => {
  const factory = labelAddress('factory');

  it('builds what the parser accepts: observed code hashes at one block, the start at box 0\'s creation block', async () => {
    const manifest = await readCoreManifest(fakeChain(), factory, { network: 'sepolia', gitCommit: null });
    expect(manifest.status).toBe('deployed');
    expect(manifest.evidence).toEqual({ block: { number: '9000100', hash: labelHash('evidence') }, finality: 'finalized' });
    const v1 = coreVersion1(manifest);
    expect(v1.startBlock).toBe('9000000');
    expect(v1.supportedTemplates).toEqual([labelHash('template-0')]);
    expect(v1.registry.codeHash).toBe(keccak256(labelAddress('registry') as Hex));
    expect(Object.keys(v1.implementations).sort()).toEqual([...IMPLS].sort());
    expect(parseCoreManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
  });

  it('refuses before box 0 exists, a registry of another factory, a contract without code, another chain', async () => {
    await expect(readCoreManifest(fakeChain({ boxCount: 0n }), factory, { network: 'sepolia', gitCommit: null })).rejects.toThrow(/no box yet/);
    await expect(readCoreManifest(fakeChain({ registryFactory: labelAddress('other') }), factory, { network: 'sepolia', gitCommit: null })).rejects.toThrow(/names factory/);
    await expect(readCoreManifest(fakeChain({ noCode: labelAddress('weth') }), factory, { network: 'sepolia', gitCommit: null })).rejects.toThrow(/no code/);
    await expect(readCoreManifest(fakeChain({ chainId: 1 }), factory, { network: 'sepolia', gitCommit: null })).rejects.toThrow(/a Sepolia manifest needs chain 11155111/);
    await expect(readCoreManifest(fakeChain({ chainId: 1 }), factory, { network: 'local', gitCommit: null })).rejects.toThrow(/a mainnet manifest is exactly chain 1/);
    await expect(readCoreManifest(fakeChain({ chainId: 10 }), factory, { network: 'sepolia', gitCommit: null })).rejects.toThrow(/chain 10 has no core manifest/);
    await expect(readCoreManifest(fakeChain({ badLogs: true }), factory, { network: 'sepolia', gitCommit: null })).rejects.toThrow(/not decoded/);
  });

  it('a local twin may have no Safe code at the platform address; Sepolia may not', async () => {
    const local = await readCoreManifest(fakeChain({ noCode: labelAddress('safe') }), factory, { network: 'local', gitCommit: null });
    expect(local.chain.platformSafe.codeHash).toBe(EMPTY_CODE_HASH);
    expect(local.evidence.finality).toBe('confirmed');
    await expect(readCoreManifest(fakeChain({ noCode: labelAddress('safe') }), factory, { network: 'sepolia', gitCommit: null })).rejects.toThrow(/no code/);
  });

  describe('SH-188: a mainnet manifest from finalized reads of chain 1', () => {
    const mainnet = { platform: PLATFORM_SAFE_MAINNET as Address, chainId: 1 };

    it('is written for chain 1 with the mainnet platform Safe, at the finalized block, and the parser accepts it', async () => {
      const manifest = await readCoreManifest(fakeChain(mainnet), factory, { network: 'mainnet', gitCommit: null });
      expect(manifest).toMatchObject({ status: 'deployed', chainId: 1, network: 'mainnet', evidence: { finality: 'finalized' } });
      expect(manifest.chain.platformSafe.address).toBe(PLATFORM_SAFE_MAINNET);
      expect(parseCoreManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
    });

    it('refuses another platform, a platform without code, --platform-eoa, latest-block reads and another chain', async () => {
      await expect(readCoreManifest(fakeChain({ chainId: 1 }), factory, { network: 'mainnet', gitCommit: null })).rejects.toThrow(/is not the mainnet platform Safe/);
      await expect(readCoreManifest(fakeChain({ ...mainnet, noCode: PLATFORM_SAFE_MAINNET }), factory, { network: 'mainnet', gitCommit: null })).rejects.toThrow(/no code/);
      await expect(readCoreManifest(fakeChain({ ...mainnet, noCode: PLATFORM_SAFE_MAINNET }), factory, { network: 'mainnet', gitCommit: null, platformEoa: true })).rejects.toThrow(/Sepolia only/);
      await expect(readCoreManifest(fakeChain(mainnet), factory, { network: 'mainnet', gitCommit: null, finality: 'confirmed' })).rejects.toThrow(/finalized block only/);
      await expect(readCoreManifest(fakeChain({ platform: PLATFORM_SAFE_MAINNET }), factory, { network: 'mainnet', gitCommit: null })).rejects.toThrow(/exactly chain 1/);
    });
  });

  describe("Sepolia's platform without code: the runbook's Z3 (review of sh-open-at-final, finding 2)", () => {
    // Z3's default, the testnet deployer (an EOA); or the mainnet Safe's address, which has no code on Sepolia.
    const eoa = labelAddress('testnet-deployer');

    it('is refused without --platform-eoa, and the refusal names it', async () => {
      await expect(readCoreManifest(fakeChain({ platform: eoa, noCode: eoa }), factory, { network: 'sepolia', gitCommit: null })).rejects.toThrow(
        /has no code at block 9000100.*--platform-eoa/,
      );
    });

    it('is written with --platform-eoa: the empty-code hash recorded, everything else as before', async () => {
      const manifest = await readCoreManifest(fakeChain({ platform: eoa, noCode: eoa }), factory, { network: 'sepolia', gitCommit: null, platformEoa: true });
      expect(manifest.network).toBe('sepolia');
      expect(manifest.chain.platformSafe).toEqual({ address: eoa, codeHash: EMPTY_CODE_HASH });
      expect(manifest.evidence.finality).toBe('finalized');
      expect(parseCoreManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
    });

    it('--platform-eoa takes only an address without code that box 0\'s spec names as its platform', async () => {
      await expect(readCoreManifest(fakeChain({ platform: eoa }), factory, { network: 'sepolia', gitCommit: null, platformEoa: true })).rejects.toThrow(
        /has code.*drop --platform-eoa/,
      );
      await expect(
        readCoreManifest(fakeChain({ platform: eoa, noCode: eoa, specPlatform: labelAddress('other') }), factory, { network: 'sepolia', gitCommit: null, platformEoa: true }),
      ).rejects.toThrow(/box 0's spec names/);
      // Every other address still needs code.
      await expect(
        readCoreManifest(fakeChain({ platform: eoa, noCode: labelAddress('weth') }), factory, { network: 'sepolia', gitCommit: null, platformEoa: true }),
      ).rejects.toThrow(/no code/);
    });
  });
});
