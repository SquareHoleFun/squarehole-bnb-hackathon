import { describe, expect, it } from 'vitest';
import { createChainProviders } from '../providers/create';
import { classifyQuote } from '../providers/model';
import { localManifestJson, syntheticSepoliaManifestJson } from '../test-support/fixtures';
import { SEPOLIA_CANONICAL_QUOTES, SEPOLIA_PUBLIC_RPC_URLS, SEPOLIA_UNISWAP_V4, viemChain } from './chains';
import { createChainConfig } from './config';
import { parseDeploymentManifest, selectManifestModule } from './manifest';

describe('createChainConfig: supported chains only (no mainnet anywhere)', () => {
  it.each([1, 5, 8453, 0, -1, 31_338])('refuses chain %s', (chainId) => {
    expect(() => createChainConfig({ chainId })).toThrow(expect.objectContaining({ code: 'unsupported_chain' }));
  });

  it('viem chain objects exist only for 31337 and 11155111', () => {
    expect(viemChain(31_337, ['http://127.0.0.1:8551']).id).toBe(31_337);
    expect(viemChain(11_155_111, [...SEPOLIA_PUBLIC_RPC_URLS]).id).toBe(11_155_111);
  });
});

describe('not deployed yet (honest state, no providers)', () => {
  it('Sepolia without deployments/11155111.json is not_deployed and yields no providers', () => {
    const config = createChainConfig({ chainId: 11_155_111, manifest: null });
    expect(config.deployment.status).toBe('not_deployed');
    // The v2 rehearsal is on Sepolia but the pair registry this manifest describes is not.
    expect(config.deployment.status === 'not_deployed' && config.deployment.reason).toContain('pair registry is not deployed on Sepolia: packages/contracts/deployments/11155111.json does not exist');
    // Shown on every registry page under Sepolia and shipped in every bundle: it never names the rehearsal's neutral
    // contracts as the launch's (F30 Q2), nor dates them.
    const reason = config.deployment.status === 'not_deployed' ? config.deployment.reason : '';
    expect(reason).not.toMatch(/misfit|stonk|sorter|2026-09-30/i);
    expect(config.uniswap).toBeNull();
    const providers = createChainProviders(config);
    expect(providers.status).toBe('not_deployed');
    expect('feed' in providers).toBe(false);
  });

  it('the local chain without a manifest points at local-e2e.sh', () => {
    const config = createChainConfig({ chainId: 31_337 });
    expect(config.deployment.status === 'not_deployed' && config.deployment.reason).toContain('local-e2e.sh');
  });
});

describe('deployed configs', () => {
  it('local: manifest PoolManager, anvil URL, latest-block snapshots, no explorer, no staleness clock', () => {
    const config = createChainConfig({ chainId: 31_337, manifest: localManifestJson() });
    expect(config.deployment.status).toBe('deployed');
    expect(config.uniswap).toEqual({ poolManager: '0x5FbDB2315678afecb367f032d93F642f64180aa3', stateView: null, v4Quoter: null });
    expect(config.rpcUrls).toEqual(['http://127.0.0.1:8545']);
    expect(config.snapshotTag).toBe('latest');
    expect(config.staleAfterMs).toBeNull();
    expect(config.explorers).toEqual([]);
    expect(config.multicall3).toBeNull();
    expect(config.platformLaunchKey).toBe('FIT');
  });

  it('local lens contracts can be supplied (the integration suite deploys StateView and V4Quoter)', () => {
    const config = createChainConfig({
      chainId: 31_337,
      manifest: localManifestJson(),
      rpcUrls: ['http://127.0.0.1:8551'],
      localLens: { stateView: '0x0000000000000000000000000000000000000abc', v4Quoter: '0x0000000000000000000000000000000000000def' },
    });
    expect(config.uniswap?.stateView).toBe('0x0000000000000000000000000000000000000abc');
    expect(config.uniswap?.v4Quoter).toBe('0x0000000000000000000000000000000000000def');
  });

  it('Sepolia: canonical Uniswap v4 addresses, keyless public RPC fallback list, safe-block snapshots, explorers', () => {
    const config = createChainConfig({ chainId: 11_155_111, manifest: syntheticSepoliaManifestJson() });
    expect(config.uniswap).toEqual(SEPOLIA_UNISWAP_V4);
    expect(config.rpcUrls).toEqual(SEPOLIA_PUBLIC_RPC_URLS);
    expect(config.snapshotTag).toBe('safe');
    expect(config.staleAfterMs).toBe(15 * 60_000);
    expect(config.explorers.map((explorer) => explorer.origin)).toEqual(['https://sepolia.etherscan.io', 'https://eth-sepolia.blockscout.com']);
    expect(config.multicall3).toBe('0xcA11bde05977b3631167028862bE2a173976CA11');
  });

  it('refuses a manifest for another chain', () => {
    expect(() => createChainConfig({ chainId: 11_155_111, manifest: localManifestJson() })).toThrow(expect.objectContaining({ code: 'manifest_chain_mismatch' }));
  });

  it('refuses a Sepolia manifest with a non-canonical PoolManager', () => {
    const manifest = syntheticSepoliaManifestJson();
    ((manifest.contracts as Record<string, Record<string, unknown>>).poolManager as Record<string, unknown>).address = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
    expect(() => createChainConfig({ chainId: 11_155_111, manifest })).toThrow(expect.objectContaining({ code: 'non_canonical_pool_manager' }));
  });
});

describe('manifest validation', () => {
  it('parses the finalized local manifest', () => {
    const manifest = parseDeploymentManifest(localManifestJson());
    expect(manifest.launches.THE_MISFITS?.kind).toBe('collection');
    expect(manifest.launches.FIT?.rewardSide).toBe('Q');
  });

  it.each([
    ['a simulated dry run', (m: Record<string, unknown>) => void (m.status = 'simulated')],
    ['a pending-broadcast plan', (m: Record<string, unknown>) => void (m.status = 'pending-broadcast')],
    ['another schema', (m: Record<string, unknown>) => void (m.schema = 'squarehole.deployment/v2')],
    ['a wrong app pair id', (m: Record<string, unknown>) => void (((m.launches as Record<string, Record<string, unknown>>).FIT as Record<string, unknown>).appPairId = '31337:0x0')],
    ['a token launch with a mirror', (m: Record<string, unknown>) => void ((((m.launches as Record<string, Record<string, unknown>>).FIT as Record<string, Record<string, Record<string, unknown>>>).contracts as Record<string, Record<string, unknown>>).mirror = { address: '0x0000000000000000000000000000000000000001', codehash: `0x${'00'.repeat(32)}`, contract: 'x' })],
    ['an amount as a JSON number', (m: Record<string, unknown>) => void (((m.launches as Record<string, Record<string, unknown>>).FIT as Record<string, unknown>).initialSupply = 1e27)],
    ['a malformed registry address', (m: Record<string, unknown>) => void (((m.contracts as Record<string, Record<string, unknown>>).registry as Record<string, unknown>).address = '0x1234')],
  ])('refuses %s', (_label, mutate) => {
    const manifest = localManifestJson();
    mutate(manifest);
    expect(() => parseDeploymentManifest(manifest)).toThrow(expect.objectContaining({ code: 'invalid_manifest' }));
  });

  it('selects deployments/<chainId>.json from a bundler module map, never a dry run or a plan', () => {
    const modules = {
      '../../packages/contracts/deployments/dry-run/11155111.json': { status: 'simulated' },
      '../../packages/contracts/deployments/pending/31337.json': { status: 'pending-broadcast' },
      '../../packages/contracts/deployments/31337.json': { status: 'deployed' },
    };
    expect(selectManifestModule(31_337, modules)).toEqual({ status: 'deployed' });
    expect(selectManifestModule(11_155_111, modules)).toBeNull();
  });
});

describe('RPC URLs: keyless http(s) only, https on Sepolia', () => {
  it.each([
    ['plain http on Sepolia', 11_155_111, 'http://ethereum-sepolia-rpc.publicnode.com'],
    ['a query string (credential-shaped parameter)', 11_155_111, 'https://rpc.example/?auth=abc'],
    ['credentials', 11_155_111, 'https://user:secret@rpc.example'],
    ['a fragment', 31_337, 'http://127.0.0.1:8551/#x'],
    ['a websocket', 31_337, 'ws://127.0.0.1:8551'],
    ['not a URL', 31_337, 'localhost:8551'],
  ])('refuses %s', (_label, chainId, url) => {
    expect(() => createChainConfig({ chainId, rpcUrls: [url] })).toThrow(expect.objectContaining({ code: 'invalid_rpc_url' }));
  });

  it('refuses an empty RPC list', () => {
    expect(() => createChainConfig({ chainId: 31_337, rpcUrls: [] })).toThrow(expect.objectContaining({ code: 'no_rpc_url' }));
  });
});

describe('quote classes come from exact addresses, not manifest keys (SH-C review)', () => {
  const OTHER = '0x000000000000000000000000000000000000bEEF';

  it('Sepolia: "Canonical WETH9 / Circle USDC" only for the canonical addresses themselves', () => {
    const canonical = parseDeploymentManifest(syntheticSepoliaManifestJson());
    expect(classifyQuote(canonical, SEPOLIA_CANONICAL_QUOTES.WETH9)).toMatchObject({ kind: 'canonical_testnet', family: 'Canonical WETH9 (testnet)' });
    expect(classifyQuote(canonical, SEPOLIA_CANONICAL_QUOTES.USDC)).toMatchObject({ kind: 'canonical_testnet', family: 'Circle USDC (testnet)' });

    // A manifest whose WETH / USDC entries name other contracts: they are not called canonical.
    const json = syntheticSepoliaManifestJson();
    const contracts = json.contracts as Record<string, Record<string, unknown>>;
    (contracts.WETH as Record<string, unknown>).address = OTHER;
    (contracts.USDC as Record<string, unknown>).address = '0x000000000000000000000000000000000000cafE';
    const wrong = parseDeploymentManifest(json);
    expect(classifyQuote(wrong, OTHER)).toMatchObject({ kind: 'other', family: null, issuerStatus: 'unverified' });
    expect(classifyQuote(wrong, '0x000000000000000000000000000000000000cafE')).toMatchObject({ kind: 'other', family: null });
  });

  it('local: the manifest’s LOCAL mocks are local stand-ins; nothing on 31337 is called canonical', () => {
    const local = parseDeploymentManifest(localManifestJson());
    const weth = (local.contracts.WETH?.address ?? '') as `0x${string}`;
    expect(classifyQuote(local, weth)).toMatchObject({ kind: 'local_mock', issuerStatus: 'mock' });
    const json = localManifestJson();
    const contracts = json.contracts as Record<string, Record<string, unknown>>;
    (contracts.WETH as Record<string, unknown>).contract = 'WETH9';
    expect(classifyQuote(parseDeploymentManifest(json), weth)).toMatchObject({ kind: 'other', family: null, issuerStatus: 'mock' });
  });
});
