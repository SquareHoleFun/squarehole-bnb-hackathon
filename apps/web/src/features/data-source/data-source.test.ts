/**
 * Data source choice (SH-C): options per build, the effective source, guarded storage, and the lazy chain session
 * (one runtime load, delegation to the chain providers, a failed load that stays a failure and can be retried).
 */
import type { AccountClaims, FeedSnapshot } from '@squarehole/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LAUNCH_HINTS } from '../fit-pair/market-names';
import type { ChainRuntime } from './chain-runtime';
import { NO_CHAIN_RUNTIME, createChainSession } from './chain-session';
import {
  CORE_SEPOLIA_AWAITING,
  DATA_LABELS,
  DATA_SOURCE_KEY,
  PRODUCTION_CORE_AWAITING,
  PRODUCTION_NOT_DEPLOYED,
  LOCAL_NOT_CONFIGURED,
  SEPOLIA_CORE_HINT,
  SEPOLIA_HINT,
  SEPOLIA_MARKET_ONLY_HINT,
  SEPOLIA_NOT_DEPLOYED,
  clearDataSource,
  dataSourceOptions,
  effectiveDataSource,
  parseStoredDataSource,
  readLastDataSourceChange,
  readStoredDataSource,
  resetDataSourceForTests,
  saveDataSource,
} from './data-source';
import { dataSourceValue } from './data-source-context';

const NONE = { localManifest: null, sepoliaManifest: null, localRpcUrl: 'http://127.0.0.1:8560' };
const LOCAL = { ...NONE, localManifest: { schema: 'squarehole.deployment/v1' } };

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  resetDataSourceForTests();
});

describe('data source options', () => {
  it('always offers the sample data; the local chain needs a manifest in the build; Sepolia says "not deployed yet"', () => {
    const none = dataSourceOptions(NONE);
    // F130: the sample data's one name, in Settings only; no Demo, mock or test word in its title or hint.
    expect([none[0]?.title, none[0]?.hint]).toEqual(['Sample data', 'Sample boxes and accounts at a fixed time. Nothing is read from a chain, and its wallet signs nothing.']);
    expect(`${none[0]?.title} ${none[0]?.hint}`).not.toMatch(/demo|mock|test/i);
    expect(none.map((option) => [option.id, option.available, option.chainId])).toEqual([
      ['demo', true, 31337],
      ['local', false, 31337],
      ['sepolia', false, 11_155_111],
    ]);
    expect(none[1]?.unavailableReason).toBe(LOCAL_NOT_CONFIGURED);
    expect(none[2]?.unavailableReason).toBe(SEPOLIA_NOT_DEPLOYED);
    expect(dataSourceOptions(LOCAL).map((option) => option.available)).toEqual([true, true, false]);
    expect(dataSourceOptions({ ...NONE, sepoliaManifest: {} }).map((option) => option.available)).toEqual([true, false, true]);
  });

  it('core v1 (S10a § 2.3): Sepolia awaiting the broadcast says "Core v1 is not on Sepolia yet"; a deployed one is offered; a local core chain makes the local source available', () => {
    const awaiting = dataSourceOptions({ ...NONE, coreSepolia: 'awaiting-broadcast' });
    expect(awaiting[2]).toMatchObject({ available: false, unavailableReason: CORE_SEPOLIA_AWAITING });
    expect(CORE_SEPOLIA_AWAITING).toMatch(/^Core v1 is not on Sepolia yet/);
    expect(CORE_SEPOLIA_AWAITING).not.toMatch(/demo/i);
    expect(dataSourceOptions({ ...NONE, coreSepolia: 'deployed' })[2]).toMatchObject({ available: true, hint: SEPOLIA_CORE_HINT });
    expect(dataSourceOptions({ ...NONE, coreLocal: true }).map((option) => option.available)).toEqual([true, true, false]);
    // Without a core manifest at all, the earlier wording stays.
    expect(dataSourceOptions({ ...NONE, coreSepolia: 'none' })[2]?.unavailableReason).toBe(SEPOLIA_NOT_DEPLOYED);
  });

  it('offers Sepolia with only the v2 market record (the full v2 deployment), saying the pair registry is not there', async () => {
    const market = { schema: 'squarehole.fit-market/v1', chainId: 11_155_111 };
    const options = dataSourceOptions({ ...NONE, sepoliaMarket: market });
    expect(options.map((option) => option.available)).toEqual([true, false, true]);
    expect(options[2]).toMatchObject({ unavailableReason: null, hint: SEPOLIA_MARKET_ONLY_HINT });
    expect(SEPOLIA_MARKET_ONLY_HINT).toContain('The pair registry is not deployed on Sepolia');
    // Text that ships in every bundle: it never names the neutral contracts as the launch's (F30 Q2).
    expect(SEPOLIA_MARKET_ONLY_HINT).not.toMatch(LAUNCH_HINTS);
    expect(SEPOLIA_MARKET_ONLY_HINT).not.toContain('/misfits');
    expect(dataSourceOptions({ ...NONE, sepoliaManifest: {}, sepoliaMarket: market })[2]?.hint).toBe(SEPOLIA_HINT);
    expect(effectiveDataSource('sepolia', options)).toBe('sepolia');
    // The registry's pages read through a chain session that cannot load without its manifest: they say why.
    const value = dataSourceValue('sepolia', 'sepolia', { ...NONE, sepoliaMarket: market });
    expect(value.chain).not.toBeNull();
    await expect(value.chain?.load()).rejects.toThrow(/pair registry is not deployed on Sepolia/);
  });

  it('shows a stored choice only when the build can serve it, else the demo', () => {
    expect(effectiveDataSource(null, dataSourceOptions(LOCAL))).toBe('demo');
    expect(effectiveDataSource('local', dataSourceOptions(LOCAL))).toBe('local');
    expect(effectiveDataSource('local', dataSourceOptions(NONE))).toBe('demo');
    expect(effectiveDataSource('sepolia', dataSourceOptions(LOCAL))).toBe('demo');
  });

  it('the local source as core v1\'s Sepolia twin (S10a review): its own title, hint and labels, read only, never "anvil 31337"', () => {
    const twin = { ...NONE, coreLocal: true, coreLocalRpcUrl: 'http://127.0.0.1:8562' };
    const option = dataSourceOptions(twin)[1];
    expect(option).toMatchObject({ title: 'Local chain (Sepolia twin)', available: true });
    expect(option?.hint).toBe('Reads core v1 on a local twin of Sepolia (http://127.0.0.1:8562). Read only: it never asks your wallet. Test tokens only; not audited.');
    expect(option?.hint).not.toMatch(/31337|8560|browser wallet/);
    const value = dataSourceValue('local', 'local', twin, () => Promise.reject(new Error('unused')));
    expect([value.badge.lead + value.badge.rest, value.dataLabel, value.coreTwin]).toEqual(['Local chain · Sepolia twin', 'Local chain (Sepolia twin)', true]);
    // With the first handoff's local deployment in the build as well, the local source is that one (as before).
    const both = dataSourceValue('local', 'local', { ...LOCAL, coreLocal: true }, () => Promise.reject(new Error('unused')));
    expect([both.dataLabel, both.coreTwin, both.option.title]).toEqual(['Local chain 31337', false, 'Local chain (anvil 31337)']);
    // A core v1 twin keeps 31337 as the wallet's chain; nothing there asks a wallet.
    expect([value.chainId, value.walletChainId]).toEqual([31337, 31337]);
  });

  it('O-2: on the local twin carrying a core v2 deployment, the wallet is checked against that deployment’s chain', () => {
    const twin = { ...NONE, coreLocal: true, coreLocalRpcUrl: 'http://127.0.0.1:8576', coreLocalWalletChainId: 11_155_111 };
    const value = dataSourceValue('local', 'local', twin, () => Promise.reject(new Error('unused')));
    expect([value.chainId, value.walletChainId, value.coreTwin]).toEqual([31337, 11_155_111, true]);
    // The first handoff's local deployment, the sample data and Sepolia keep their own chain for the wallet.
    expect(dataSourceValue('local', 'local', { ...LOCAL, coreLocal: true, coreLocalWalletChainId: 11_155_111 }, () => Promise.reject(new Error('unused'))).walletChainId).toBe(31337);
    expect(dataSourceValue('demo', null, { ...twin }).walletChainId).toBe(31337);
  });

  it('labels each source: badge, data label, wallet kind inputs', () => {
    // F130: the sample data has no badge; on a page it is named by its chain, "Sample data" only in Settings.
    const demo = dataSourceValue('demo', null, LOCAL);
    expect([demo.badge.lead + demo.badge.rest + demo.badge.short, demo.dataLabel, demo.isDemo, demo.chain]).toEqual(['', 'Local chain 31337', true, null]);
    expect(DATA_LABELS.demo).toBe('Sample data');
    const local = dataSourceValue('local', 'local', LOCAL, () => Promise.reject(new Error('unused')));
    expect([local.badge.lead + local.badge.rest, local.dataLabel, local.isDemo, local.chainId]).toEqual(['Local chain 31337', 'Local chain 31337', false, 31337]);
    expect(local.chain).not.toBeNull();
    const sepolia = dataSourceValue('sepolia', 'sepolia', { ...NONE, sepoliaManifest: {} }, () => Promise.reject(new Error('unused')));
    expect([sepolia.badge.lead + sepolia.badge.rest, sepolia.chainId]).toEqual(['Testnet · Sepolia', 11_155_111]);
  });
});

/**
 * SH-V2-FE6: the production site (`SH_BUILD=production`; here the build's `production` flag, as BUILD_DEPLOYMENTS
 * sets it from the bundle) offers Sepolia only: no Demo, no local chain, in every build input, and short reasons with
 * no Demo in them. There is no mainnet option (G08: no mainnet target exists).
 */
describe('data source options on the production site', () => {
  const PRODUCTION = { ...NONE, production: true };
  const market = { schema: 'squarehole.fit-market/v1', chainId: 11_155_111 };

  it('offers Sepolia only, whatever the build carries', () => {
    for (const build of [PRODUCTION, { ...LOCAL, production: true }, { ...PRODUCTION, coreLocal: true }, { ...PRODUCTION, sepoliaMarket: market }, { ...PRODUCTION, coreSepolia: 'deployed' as const }]) {
      expect(dataSourceOptions(build).map((option) => option.id)).toEqual(['sepolia']);
    }
    expect(dataSourceOptions({ ...PRODUCTION, coreSepolia: 'deployed' })[0]).toMatchObject({ available: true, hint: SEPOLIA_CORE_HINT, unavailableReason: null });
  });

  it('says why Sepolia is not available in a few words, never pointing at the Demo', () => {
    expect(dataSourceOptions(PRODUCTION)[0]).toMatchObject({ available: false, unavailableReason: PRODUCTION_NOT_DEPLOYED });
    expect(dataSourceOptions({ ...PRODUCTION, coreSepolia: 'awaiting-broadcast' })[0]).toMatchObject({ available: false, unavailableReason: PRODUCTION_CORE_AWAITING });
    for (const text of [PRODUCTION_NOT_DEPLOYED, PRODUCTION_CORE_AWAITING]) expect(text).not.toMatch(/demo|founder|packages\/|Stage/i);
  });

  it('shows Sepolia for every stored choice, even one it cannot serve (no Demo fallback)', () => {
    const options = dataSourceOptions(PRODUCTION);
    for (const stored of [null, 'demo', 'local', 'sepolia'] as const) expect(effectiveDataSource(stored, options)).toBe('sepolia');
    const value = dataSourceValue('sepolia', 'demo', PRODUCTION, NO_CHAIN_RUNTIME);
    expect([value.isDemo, value.badge.lead + value.badge.rest, value.dataLabel, value.chainId, value.coreTwin]).toEqual([false, 'Testnet · Sepolia', 'Sepolia testnet', 11_155_111, false]);
  });

  it('ships no pair registry runtime: a read through its chain session fails like an unavailable source', async () => {
    const session = createChainSession({ chainId: 11_155_111, manifest: null }, NO_CHAIN_RUNTIME);
    await expect(session.feedSources('default').provider.readFeed({ search: '', sort: 'new', type: 'all', lifecycle: 'all', limit: 10 })).rejects.toThrow('The pair registry is not part of this site.');
    expect(session.getState()).toEqual({ status: 'error', message: 'The pair registry is not part of this site.' });
  });
});

describe('stored choice (guarded localStorage)', () => {
  it('saves, reads back and clears a validated choice', () => {
    expect(readStoredDataSource()).toBeNull();
    expect(saveDataSource('local')).toBe('saved');
    expect(window.localStorage.getItem(DATA_SOURCE_KEY)).toBe('{"source":"local"}');
    expect(readStoredDataSource()).toBe('local');
    expect(readLastDataSourceChange()).toEqual({ id: 'local', result: 'saved' });
    expect(clearDataSource()).toBe('saved');
    expect(readStoredDataSource()).toBeNull();
  });

  it('ignores anything that is not a known source', () => {
    for (const raw of ['', 'local', '{"source":"mainnet"}', '{"source":1}', '[]', 'null']) expect(parseStoredDataSource(raw)).toBeNull();
    expect(parseStoredDataSource('{"source":"sepolia"}')).toBe('sepolia');
  });

  it('blocked storage: the choice applies in this tab and is reported as not saved', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(saveDataSource('local')).toBe('not_saved');
    expect(readStoredDataSource()).toBe('local');
    expect(readLastDataSourceChange()).toEqual({ id: 'local', result: 'not_saved' });
  });

  it('a throwing getItem reads as "no choice"', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(readStoredDataSource()).toBeNull();
  });
});

describe('chain session (lazy runtime)', () => {
  const snapshot = { snapshotId: '31337-9-abc' } as unknown as FeedSnapshot;
  const claims = { owner: '0x1' } as unknown as AccountClaims;
  function fakeRuntime(): ChainRuntime {
    return {
      chainId: 31337,
      providers: {
        feed: { readFeed: vi.fn(async () => snapshot), readPair: vi.fn(), latestSnapshot: vi.fn(), readPairDetail: vi.fn(), readMarket: vi.fn() },
        accounts: { readClaim: vi.fn(), listPositions: vi.fn(), listClaims: vi.fn(async () => claims) },
        registry: { listSupportedQuotes: vi.fn(async () => []), readAsset: vi.fn(async () => null) },
      },
    } as unknown as ChainRuntime;
  }

  it('loads the runtime once, on the first read, and delegates to the chain providers', async () => {
    const runtime = fakeRuntime();
    const loader = vi.fn(async () => runtime);
    const session = createChainSession({ chainId: 31337, manifest: {}, rpcUrls: ['http://127.0.0.1:8560'] }, loader);
    expect(loader).not.toHaveBeenCalled();
    expect(session.getState()).toEqual({ status: 'idle' });
    const source = session.feedSources('default');
    expect(source.mode).toBe('live');
    expect(session.feedSources('stale')).toBe(source);
    const [feed, list] = await Promise.all([
      source.provider.readFeed({ search: '', sort: 'new', type: 'all', lifecycle: 'all', limit: 10 }),
      session.accountSources.sourceFor('default').provider.listClaims('0x0000000000000000000000000000000000000001'),
    ]);
    expect(feed).toBe(snapshot);
    expect(list).toBe(claims);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(session.getState()).toEqual({ status: 'ready', runtime });
    expect(session.accountSources.settlements).toBeNull();
  });

  it('a failed load is a failed read (never an empty feed) and a later read tries again', async () => {
    const runtime = fakeRuntime();
    const loader = vi.fn().mockRejectedValueOnce(new Error('Deployment manifest rejected')).mockResolvedValueOnce(runtime);
    const session = createChainSession({ chainId: 31337, manifest: {} }, loader);
    const listener = vi.fn();
    session.subscribe(listener);
    await expect(session.registry.listSupportedQuotes(31337)).rejects.toThrow('Deployment manifest rejected');
    expect(session.getState()).toEqual({ status: 'error', message: 'Deployment manifest rejected' });
    await expect(session.registry.listSupportedQuotes(31337)).resolves.toEqual([]);
    expect(session.getState().status).toBe('ready');
    expect(listener).toHaveBeenCalled();
  });

  it('builds no external link for the local chain (no venue, no explorer)', () => {
    const session = createChainSession({ chainId: 31337, manifest: {} }, vi.fn());
    const pair = { chainId: 31337, token: { address: '0x0000000000000000000000000000000000000010' }, quote: { address: '0x0000000000000000000000000000000000000020' } };
    const destinations = session.links.destinations(pair as never);
    expect(destinations.every((destination) => destination.href === null)).toBe(true);
  });
});
