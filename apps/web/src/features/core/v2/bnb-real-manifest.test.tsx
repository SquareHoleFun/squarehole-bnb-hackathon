/**
 * SH-258 fix round, finding 1: the release manifest of BNB Chain testnet (the real deployment,
 * packages/contracts/deployments/core-v1/97.json) has no core v1 version (`versions: []`, no box 0). Before the fix the
 * box page's Safes panel mounted FIT's burn log, which called `coreVersion1` while rendering and threw.
 */
import { cleanup, render, renderHook, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../../../app-providers';
import realManifest from '../../../../../../packages/contracts/deployments/core-v1/97.json' with { type: 'json' };
import { parseCoreManifestV2 } from '../../../../../../packages/chain/src/core/v2';
import { coreSourceFor } from '../core-build';
import { parseSnapshotV2 } from './indexer-v2';
import { publishedV2 } from './test-support/published-v2';
import { SafesV2 } from './SafesV2';

const rpc = vi.hoisted(() => ({ getChainId: vi.fn(), readContract: vi.fn(), getBlock: vi.fn() }));
vi.mock('viem', async (original) => ({ ...await original<typeof import('viem')>(), createPublicClient: () => rpc }));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });

describe('the real chain-97 manifest', () => {
  it('parses: chain 97, bnb-testnet, no core v1 version; its first release is the live one Create uses (SH-300: a second may follow)', () => {
    const manifest = parseCoreManifestV2(realManifest);
    expect([manifest.chainId, manifest.network, manifest.versions.length]).toEqual([97, 'bnb-testnet', 0]);
    expect(manifest.releases.length).toBeGreaterThanOrEqual(1);
    expect([manifest.releases[0]?.factory.address, manifest.releases[0]?.registry.address, manifest.releases[0]?.startBlock]).toEqual(['0xb954a0db33a6351e76e519b4830489531c39d4f0', '0xf77ef448bbc61d559ee8f657ce3a0b59f1af0daf', '144754031']);
  });

  it('the box page’s Safes panel renders on it, without FIT’s burn log', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const { source, body } = await publishedV2();
    const view = parseSnapshotV2(body, source);
    rpc.getChainId.mockResolvedValue(97);
    rpc.getBlock.mockResolvedValue({ hash: view.blockHash });
    rpc.readContract.mockResolvedValue([]);
    const bnbSource = { ...source, manifest: parseCoreManifestV2(realManifest) };
    render(<AppProviders><SafesV2 source={bnbSource} view={view} coin="BNB" /></AppProviders>);
    expect(screen.getByRole('heading', { name: 'Safe payouts', hidden: true })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'FIT executor burns', hidden: true })).toBeNull();
  });

  it('the build’s core source under SH_TESTNET=bnb is ready, with no box 0 version', async () => {
    vi.stubEnv('SH_TESTNET', 'bnb');
    vi.resetModules();
    const build = await import('../core-build');
    const core = build.coreSourceFor('sepolia', { manifests: [realManifest], localRpcUrl: '', indexers: { local: null, sepolia: null } }, 'https://bsc-testnet-rpc.publicnode.com');
    expect(core).toMatchObject({ status: 'ready', network: 'sepolia', chainId: 97, version1: null });
    // The default build does not read a chain-97 manifest for its test network.
    expect(coreSourceFor('sepolia', { manifests: [realManifest], localRpcUrl: '', indexers: { local: null, sepolia: null } }, '').status).toBe('none');
  });

  it('re-read finding 3: without a core v1 version no v1 feed, box or wallet is asked (no /v1/ request at all)', async () => {
    vi.stubEnv('SH_TESTNET', 'bnb');
    vi.resetModules();
    const [build, core] = await Promise.all([import('../core-build'), import('../useCore')]);
    const source = build.coreSourceFor('sepolia', { manifests: [realManifest], localRpcUrl: '', indexers: { local: null, sepolia: 'https://index.example.org' } }, 'https://bsc-testnet-rpc.publicnode.com');
    const fetcher = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const feed = renderHook(() => core.useCoreFeed(source, fetcher), { wrapper });
    const wallet = renderHook(() => core.useCoreWallet(source, '0x00000000000000000000000000000000000000a1', fetcher), { wrapper });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect([feed.result.current, wallet.result.current]).toEqual([null, null]);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
