/**
 * Providers over a mocked transport (the scripted fake chain): the domain contracts they must satisfy, and the degraded
 * modes that the anvil integration suite cannot easily produce (RPC outage, index unavailable, stale clock, sold-out
 * range, a reverting quote, hostile token text, a USD policy).
 */
import { AccountQueryError, FeedQueryError, IdentityError, verifyMarketCap, type FeedQuery, type PairId } from '@squarehole/domain';
import { HttpRequestError } from 'viem';
import { describe, expect, it } from 'vitest';
import { createChainConfig } from '../config/config';
import { ChainDataError, ChainUnavailableError } from '../errors';
import { ALICE, BOB, LOCAL_QUOTER, LOCAL_STATE_VIEW, buildScenario, type Scenario } from '../test-support/scenario';
import { createChainProviders, type ChainProviders } from './create';
import type { UsdPricePolicy } from './usd';

const QUERY: FeedQuery = { search: '', sort: 'market_cap', type: 'all', lifecycle: 'all', limit: 100 };
type Deployed = Extract<ChainProviders, { status: 'deployed' }>;

function providersFor(scenario: Scenario, options: { now?: () => number; usd?: UsdPricePolicy; staleAfterMs?: number | null; lens?: boolean } = {}): Deployed {
  const config = createChainConfig({
    chainId: 31_337,
    manifest: scenario.manifestJson,
    rpcUrls: ['http://127.0.0.1:8551'],
    staleAfterMs: options.staleAfterMs ?? null,
    localLens: options.lens === false ? {} : { v4Quoter: LOCAL_QUOTER, stateView: LOCAL_STATE_VIEW },
  });
  const providers = createChainProviders(config, { transport: scenario.chain.transport(), snapshotReuseMs: 0, now: options.now, usd: options.usd });
  if (providers.status !== 'deployed') throw new Error('deployed');
  return providers;
}

describe('ChainFeedProvider', () => {
  it('serves a validated snapshot at one block: platform pin by manifest identity, metrics with their bases', async () => {
    const scenario = buildScenario();
    const { feed } = providersFor(scenario);
    const snapshot = await feed.readFeed(QUERY);
    expect(snapshot.platform?.pairId).toBe(scenario.fit.appPairId);
    expect(snapshot.items.map((item) => item.pairId)).toEqual([scenario.misfits.appPairId]);
    expect(snapshot.provenance).toMatchObject({ state: 'fresh', blockNumber: '40', coverage: 'canonical_markets' });
    const fit = snapshot.platform;
    expect(fit).toMatchObject({
      totalSupplyRaw: (10n ** 27n - 10n ** 21n).toString(),
      circulatingSupplyRaw: (5_000_000n * 10n ** 18n).toString(),
      burnedRaw: (10n ** 21n).toString(),
      holders: 1,
      priceUsd: null,
      marketCapUsd: null,
      turnover24hUsd: null,
      lifecycle: 'amm',
      routeState: 'unverified',
    });
    const market = await feed.readMarket(scenario.fit.appPairId as PairId);
    expect(market?.turnover24hQ).toMatchObject({ available: true, totalRaw: (2n * 10n ** 17n).toString(), protocolRaw: '0', swaps: 1 });
    expect(market?.supply).toMatchObject({ burnReconciled: true, burnEventsRaw: (10n ** 21n).toString() });
    expect(market?.usd).toMatchObject({ policy: 'none', priceUsd: null });
    const misfits = await feed.readMarket(scenario.misfits.appPairId as PairId);
    expect(misfits?.turnover24hQ).toMatchObject({ available: true, totalRaw: (32n * 10n ** 14n).toString(), protocolRaw: (10n ** 14n).toString(), swaps: 2 });
    expect(misfits?.poolStateSource).toBe('state_view');
  });

  it('reads the pool through PoolManager extsload when no StateView is configured, with the same price', async () => {
    const scenario = buildScenario();
    const viaView = await providersFor(scenario).feed.readMarket(scenario.fit.appPairId as PairId);
    const viaExtsload = await providersFor(buildScenario(), { lens: false }).feed.readMarket(scenario.fit.appPairId as PairId);
    expect(viaExtsload?.poolStateSource).toBe('pool_manager_extsload');
    expect(viaExtsload?.priceQPerT).toEqual(viaView?.priceQPerT);
  });

  it('pages with snapshot-bound cursors and refuses a snapshot it no longer holds', async () => {
    const scenario = buildScenario();
    const { feed } = providersFor(scenario);
    const first = await feed.readFeed({ ...QUERY, sort: 'new', limit: 1, type: 'all' });
    expect(first.items).toHaveLength(1);
    await expect(feed.readFeed({ ...QUERY, snapshotId: 'nope' })).rejects.toBeInstanceOf(FeedQueryError);
    const head = await feed.latestSnapshot();
    expect(head.snapshotId).toMatch(/^31337-40-[0-9a-f]{8}$/);
  });

  it('when the index cannot be read it falls back to direct registry reads and marks everything partial (no zero metrics)', async () => {
    const scenario = buildScenario();
    scenario.chain.failures.set('eth_getLogs', Number.POSITIVE_INFINITY);
    const { feed } = providersFor(scenario);
    const snapshot = await feed.readFeed(QUERY);
    expect(snapshot.provenance.state).toBe('partial');
    expect(snapshot.platform?.holders).toBeNull();
    expect(feed.lastSnapshotInfo()?.pairSource).toBe('registry_direct');
    const market = await feed.readMarket(scenario.fit.appPairId as PairId);
    expect(market?.turnover24hQ).toEqual({ available: false, reason: 'not_indexed' });
    expect(market?.holders).toEqual({ available: false, reason: 'not_indexed' });
    // State reads still come from the contracts.
    expect(snapshot.platform?.totalSupplyRaw).toBe((10n ** 27n - 10n ** 21n).toString());
  });

  it('serves the last good snapshot as stale during an RPC outage, and fails (never empty) without one', async () => {
    const scenario = buildScenario();
    const { feed } = providersFor(scenario);
    const good = await feed.readFeed(QUERY);
    scenario.chain.failures.set('eth_getBlockByNumber', Number.POSITIVE_INFINITY);
    const stale = await feed.readFeed(QUERY);
    expect(stale.snapshotId).toBe(good.snapshotId);
    expect(stale.provenance.state).toBe('stale');
    expect(stale.platform?.provenance.state).toBe('stale');

    const cold = buildScenario();
    cold.chain.failures.set('eth_getBlockByNumber', Number.POSITIVE_INFINITY);
    await expect(providersFor(cold).feed.readFeed(QUERY)).rejects.toBeInstanceOf(ChainUnavailableError);
  });

  it('marks a snapshot stale by the wall clock when its block is too old', async () => {
    const scenario = buildScenario();
    const blockTime = Number(scenario.chain.timestampOf(40n)) * 1000;
    const { feed } = providersFor(scenario, { staleAfterMs: 60_000, now: () => blockTime + 61_000 });
    expect((await feed.readFeed(QUERY)).provenance.state).toBe('stale');
  });

  it('refuses an RPC that serves another chain', async () => {
    const scenario = buildScenario();
    scenario.chain.chainId = 11_155_111;
    await expect(providersFor(scenario).feed.readFeed(QUERY)).rejects.toBeInstanceOf(ChainDataError);
  });

  it('replaces hostile on-chain token text with an address-derived label', async () => {
    const scenario = buildScenario();
    scenario.state.names[scenario.misfits.contracts.token.address.toLowerCase()] = { name: 'Totally‮ safe', symbol: 'SAFE COIN' };
    const { feed } = providersFor(scenario);
    const record = await feed.readPair(scenario.misfits.appPairId as PairId);
    expect(record?.name).toBe('Unnamed launch 0x9409…68D8');
    expect(record?.symbol).toBe('TOKEN-940999');
    expect((await feed.readMarket(scenario.misfits.appPairId as PairId))?.textReplaced).toBe(true);
  });

  it('applies a disclosed USD policy exactly (and only then fills USD fields)', async () => {
    const scenario = buildScenario();
    const policy: UsdPricePolicy = { id: 'test-fixed', disclosure: 'Test-only fixed price', quote: async () => ({ usdPerUnit: '2000', source: 'test', asOf: '2026-09-26T00:00:00Z' }) };
    const { feed } = providersFor(scenario, { usd: policy });
    const record = await feed.readPair(scenario.fit.appPairId as PairId);
    expect(record?.priceUsd).not.toBeNull();
    expect(record && verifyMarketCap(record)).toBe('match');
    expect(record?.turnover24hUsd).toBe('400');
  });

  it('reads pair detail with separate supply concepts and activity from the index', async () => {
    const scenario = buildScenario();
    const { feed } = providersFor(scenario);
    const detail = await feed.readPairDetail(scenario.misfits.appPairId as PairId);
    expect(detail?.supply).toMatchObject({ activeNftCount: 3, wholeUnitCapacity: { count: '1000', basis: 'floor_current_supply_over_unit' }, exclusionBasis: 'ledger_eligible_supply' });
    // The block-25 buy is an observed external trade; the block-28 conversion (the converter's own pool swap plus its
    // ClaimConverted, one transaction) is ONE reward-claim row, never also an external trade (03-FEED protocol tagging).
    expect(detail?.activity.map((row) => row.kind)).toEqual(['launch', 'swap_observation', 'claim']);
    expect(detail?.activity.filter((row) => row.block === '28')).toEqual([
      expect.objectContaining({ kind: 'claim', amounts: [expect.objectContaining({ amountRaw: (10n ** 14n).toString() }), expect.objectContaining({ amountRaw: (90_000n * 10n ** 18n).toString() })] }),
    ]);
    expect(detail?.activity.find((row) => row.kind === 'swap_observation')?.block).toBe('25');
    expect(detail?.rewards[1]).toMatchObject({ paidRaw: (90_000n * 10n ** 18n).toString(), accruedRaw: null });
    expect(await feed.readPairDetail('31337:0x0000000000000000000000000000000000000001')).toBeNull();
    expect(await feed.readPairDetail(`11155111:${scenario.misfits.contracts.token.address.toLowerCase()}` as PairId)).toBeNull();
    await expect(feed.readPairDetail('not-a-pair' as PairId)).rejects.toBeInstanceOf(IdentityError);
  });
});

describe('ChainFeedProvider: stale and rewound data is never shown as fresh (Stage C review)', () => {
  const HOUR = 3_600_000;

  function sepoliaWithClock(scenario: Scenario, now: () => number): Deployed {
    const config = createChainConfig({ chainId: 11_155_111, manifest: scenario.manifestJson });
    const providers = createChainProviders(config, { transport: scenario.chain.transport(), snapshotReuseMs: 0, now });
    if (providers.status !== 'deployed') throw new Error('deployed');
    return providers;
  }

  for (const sepolia of [false, true]) {
    it(`during an RPC outage readPair, readPairDetail and readMarket report the held snapshot as stale, like readFeed (${sepolia ? 'Sepolia 11155111' : 'local 31337'})`, async () => {
      const scenario = buildScenario({ sepolia });
      let now = Number(scenario.chain.timestampOf(sepolia ? 48n : 40n)) * 1000;
      const clock = () => now;
      const { feed } = sepolia ? sepoliaWithClock(scenario, clock) : providersFor(scenario, { now: clock });
      const fit = scenario.fit.appPairId as PairId;
      const good = await feed.readFeed(QUERY);
      expect(good.provenance.state).toBe('fresh');
      expect((await feed.readPair(fit))?.provenance.state).toBe('fresh');
      expect((await feed.readMarket(fit))?.provenance.state).toBe('fresh');

      // Every chain read fails from now on, and the wall clock moves 3 hours ahead.
      scenario.chain.failures.set('eth_getBlockByNumber', Number.POSITIVE_INFINITY);
      scenario.chain.failures.set('eth_call', Number.POSITIVE_INFINITY);
      now += 3 * HOUR;
      expect((await feed.readFeed(QUERY)).provenance.state).toBe('stale');
      expect((await feed.readPair(fit))?.provenance.state).toBe('stale');
      // FIT is a token pair: its detail makes no chain read of its own, so only the snapshot can say it is stale.
      expect((await feed.readPairDetail(fit))?.provenance.state).toBe('stale');
      const market = await feed.readMarket(fit);
      expect(market?.provenance.state).toBe('stale');
      expect(market?.block.number).toBe(good.provenance.blockNumber);
      // A page pinned to the snapshot (feed pages, the feed's market figures) is told the same.
      expect((await feed.readFeed({ ...QUERY, snapshotId: good.snapshotId })).provenance.state).toBe('stale');
      expect((await feed.readMarket(fit, { snapshotId: good.snapshotId }))?.provenance.state).toBe('stale');

      scenario.chain.failures.clear();
      const recovered = await feed.readFeed(QUERY);
      // Local anvil has no wall-clock rule: a successful read is fresh again. Sepolia's block is now 3 h old: the
      // 15-minute rule keeps it stale.
      expect(recovered.provenance.state).toBe(sepolia ? 'stale' : 'fresh');
      expect((await feed.readPair(fit))?.provenance.state).toBe(sepolia ? 'stale' : 'fresh');
    });
  }

  it('re-applies the wall-clock rule when a held snapshot is served again (Sepolia 15 minutes)', async () => {
    const scenario = buildScenario({ sepolia: true });
    let now = Number(scenario.chain.timestampOf(48n)) * 1000;
    const config = createChainConfig({ chainId: 11_155_111, manifest: scenario.manifestJson });
    const providers = createChainProviders(config, { transport: scenario.chain.transport(), snapshotReuseMs: 60 * HOUR, now: () => now });
    if (providers.status !== 'deployed') throw new Error('deployed');
    const fit = scenario.fit.appPairId as PairId;
    expect((await providers.feed.readPair(fit))?.provenance.state).toBe('fresh');
    now += 16 * 60_000;
    // Reused without a chain read (reuse window), but no longer fresh by the clock.
    expect((await providers.feed.readPair(fit))?.provenance.state).toBe('stale');
    expect((await providers.feed.readMarket(fit))?.provenance.state).toBe('stale');
  });

  it('a snapshot whose index sync failed does not use the index: no turnover, holders, burns or activity from orphaned logs', async () => {
    const scenario = buildScenario();
    const { feed } = providersFor(scenario);
    const misfits = scenario.misfits.appPairId as PairId;
    await feed.readFeed(QUERY); // indexed to block 40
    expect((await feed.readMarket(misfits))?.turnover24hQ).toMatchObject({ available: true, swaps: 2 });

    // The chain moves to a fork from block 25 (the Misfits swaps at 25 and 28 no longer exist), head 35, and the RPC
    // fails the re-read of the stored head in the same sync.
    scenario.chain.reorg(25n, 'fork');
    scenario.chain.head = 35n;
    const request = scenario.chain.request.bind(scenario.chain);
    scenario.chain.request = async (args) => {
      if (args.method === 'eth_getBlockByNumber' && (args.params as unknown[] | undefined)?.[0] === '0x28') throw new Error('fake transport failure for block 40');
      return request(args);
    };

    const snapshot = await feed.readFeed(QUERY);
    expect(feed.lastSnapshotInfo()?.pairSource).toBe('registry_direct');
    expect(snapshot.provenance).toMatchObject({ state: 'partial', blockNumber: '35' });
    const record = await feed.readPair(misfits);
    expect(record?.provenance.state).toBe('partial');
    expect(record?.holders).toBeNull();
    const market = await feed.readMarket(misfits);
    expect(market?.turnover24hQ).toEqual({ available: false, reason: 'not_indexed' });
    expect(market?.holders).toEqual({ available: false, reason: 'not_indexed' });
    expect(market?.supply.burnEventsRaw).toBeNull();
    expect(market?.provenance.state).toBe('partial');
    const detail = await feed.readPairDetail(misfits);
    expect(detail?.activity).toEqual([]);
    expect(detail?.rewards.find((reward) => reward.asset.address === record?.token.address)?.paidRaw).toBeNull();
  });

  it('a chain that rewinds below the indexed head (evm_revert, anvil restart) is re-indexed from the surviving ancestor', async () => {
    const scenario = buildScenario();
    const { feed } = providersFor(scenario);
    const misfits = scenario.misfits.appPairId as PairId;
    await feed.readFeed(QUERY); // indexed to block 40
    scenario.chain.reorg(25n, 'fork');
    scenario.chain.head = 35n;

    const snapshot = await feed.readFeed(QUERY);
    const info = feed.lastSnapshotInfo();
    expect(info?.pairSource).toBe('log_index');
    expect(info?.sync?.reorgs).toHaveLength(1);
    expect(info?.sync?.complete).toBe(true);
    expect(snapshot.provenance).toMatchObject({ state: 'fresh', blockNumber: '35' });
    const market = await feed.readMarket(misfits);
    expect(market?.turnover24hQ).toMatchObject({ available: true, swaps: 0, totalRaw: '0' });
    expect((await feed.readPairDetail(misfits))?.activity.map((row) => row.kind)).toEqual(['launch']);
  });
});

describe('ChainAccountProvider', () => {
  it('lists positions with NFT ids and claims with history, earned = claimable + claimed', async () => {
    const scenario = buildScenario();
    const { accounts } = providersFor(scenario);
    const positions = await accounts.listPositions(ALICE);
    expect(positions.positions.map((position) => [position.pairId, position.wholeNftCount, position.nftTokenIds])).toEqual([
      [scenario.fit.appPairId, null, []],
      [scenario.misfits.appPairId, '3', ['1', '2', '3']],
    ]);
    const claims = await accounts.listClaims(ALICE);
    const fit = claims.claims.find((claim) => claim.pairId === scenario.fit.appPairId);
    expect(fit).toMatchObject({ claimableQRaw: (10n ** 15n).toString(), claimedQRaw: (2n * 10n ** 15n).toString(), earnedQRaw: (3n * 10n ** 15n).toString(), pendingHarvestQRaw: '0' });
    const misfits = claims.claims.find((claim) => claim.pairId === scenario.misfits.appPairId);
    expect(misfits?.history).toEqual([expect.objectContaining({ qConsumedRaw: (10n ** 14n).toString(), payoutRaw: (90_000n * 10n ** 18n).toString(), outcome: 'settled' })]);
    expect(misfits?.convertibleEstimate).toMatchObject({ source: 'v4_quoter_eth_call', payoutRaw: (400_000n * 10n ** 18n).toString(), toleranceBps: 100 });
    expect(misfits?.convertibleEstimate?.minPayoutRaw).toBe(((400_000n * 10n ** 18n * 9_900n) / 10_000n).toString());
  });

  it('an account with nothing gets empty lists (from successful reads), never a failure disguised as empty', async () => {
    const scenario = buildScenario();
    const { accounts } = providersFor(scenario);
    expect((await accounts.listPositions(BOB)).positions).toEqual([]);
    expect((await accounts.listClaims(BOB)).claims).toEqual([]);
    scenario.chain.failures.set('eth_call', Number.POSITIVE_INFINITY);
    await expect(accounts.listPositions(BOB)).rejects.toBeInstanceOf(ChainUnavailableError);
  });

  it('reports the sold-out direct-Q fallback without selecting it', async () => {
    const scenario = buildScenario();
    scenario.state.soldOut = true;
    const { accounts } = providersFor(scenario);
    const claim = await accounts.readClaim(scenario.misfits.appPairId as PairId, ALICE);
    expect(claim).toMatchObject({
      conversionAvailable: false,
      convertibleEstimate: null,
      estimatedPayoutRaw: null,
      directSourceFallbackAvailable: true,
      directSourceFallback: { label: 'emergency_direct_source_q', payoutRaw: (5n * 10n ** 14n).toString() },
    });
    expect(accounts.lastQuoteNotes().get(scenario.misfits.appPairId)).toContain('sold_out');
  });

  it('a reverting quote leaves the claim without an estimate (conversion still available) and says why', async () => {
    const scenario = buildScenario();
    scenario.state.quoteReverts = true;
    const { accounts } = providersFor(scenario);
    const claim = await accounts.readClaim(scenario.misfits.appPairId as PairId, ALICE);
    expect(claim).toMatchObject({ conversionAvailable: true, convertibleEstimate: null, estimatedPayoutRaw: null, directSourceFallbackAvailable: false });
    expect(accounts.lastQuoteNotes().get(scenario.misfits.appPairId)).toBe('quote_reverted');
  });

  it('an RPC failure during the conversion quote is "unavailable", never reported as a reverted quote', async () => {
    for (const failure of [new Error('fake transport failure for the quoter'), new HttpRequestError({ url: 'http://127.0.0.1:8551', status: 503, details: 'Service Unavailable' })]) {
      const scenario = buildScenario();
      const request = scenario.chain.request.bind(scenario.chain);
      scenario.chain.request = async (args) => {
        const params = args.params as [{ to?: string }] | undefined;
        if (args.method === 'eth_call' && params?.[0]?.to?.toLowerCase() === LOCAL_QUOTER.toLowerCase()) throw failure;
        return request(args);
      };
      const { accounts } = providersFor(scenario);
      await expect(accounts.readClaim(scenario.misfits.appPairId as PairId, ALICE)).rejects.toBeInstanceOf(ChainUnavailableError);
      expect(accounts.lastQuoteNotes().get(scenario.misfits.appPairId)).not.toBe('quote_reverted');
    }
  });

  it('refuses unknown pairs and malformed accounts with typed errors', async () => {
    const scenario = buildScenario();
    const { accounts } = providersFor(scenario);
    await expect(accounts.readClaim('31337:0x0000000000000000000000000000000000000001', ALICE)).rejects.toBeInstanceOf(AccountQueryError);
    await expect(accounts.readClaim(`11155111:${scenario.fit.contracts.token.address.toLowerCase()}` as PairId, ALICE)).rejects.toBeInstanceOf(AccountQueryError);
    await expect(accounts.listClaims('0x1234' as `0x${string}`)).rejects.toBeInstanceOf(IdentityError);
  });
});

describe('ChainAssetRegistryProvider', () => {
  it('admits exactly the quotes with an active latest template, by exact address', async () => {
    const scenario = buildScenario();
    const { registry } = providersFor(scenario);
    const quotes = await registry.listSupportedQuotes(31_337);
    expect(quotes).toEqual([
      expect.objectContaining({ admission: 'supported_demo', asset: expect.objectContaining({ address: scenario.fit.quote, symbol: 'WETH', issuerStatus: 'mock' }) }),
    ]);
    expect(await registry.readAsset(31_337, scenario.fit.quote.toLowerCase() as `0x${string}`)).toMatchObject({ admission: 'supported_demo' });
    expect(await registry.readAsset(31_337, '0x000000000000000000000000000000000000dEaD')).toBeNull();
    expect(await registry.listSupportedQuotes(1)).toEqual([]);
  });
});

describe('Sepolia configuration (synthetic manifest on the fake chain; nothing is deployed on Sepolia)', () => {
  function sepoliaProviders(scenario: Scenario): Deployed {
    const config = createChainConfig({ chainId: 11_155_111, manifest: scenario.manifestJson });
    const blockTime = Number(scenario.chain.timestampOf(48n)) * 1000;
    const providers = createChainProviders(config, { transport: scenario.chain.transport(), snapshotReuseMs: 0, now: () => blockTime });
    if (providers.status !== 'deployed') throw new Error('deployed');
    return providers;
  }

  it('snapshots the safe block, batches reads through Multicall3 and reads the canonical StateView', async () => {
    const scenario = buildScenario({ sepolia: true });
    const { feed } = sepoliaProviders(scenario);
    const snapshot = await feed.readFeed(QUERY);
    expect(snapshot.provenance).toMatchObject({ state: 'fresh', blockNumber: '48' });
    expect(snapshot.platform?.pairId).toBe(scenario.fit.appPairId);
    const calls = scenario.chain.calls.filter((method) => method === 'eth_call').length;
    // Two pairs need well over 30 contract reads; Multicall3 folds them into a handful of eth_calls.
    expect(calls).toBeLessThan(12);
    expect((await feed.readMarket(scenario.fit.appPairId as PairId))?.poolStateSource).toBe('state_view');
  });

  it('labels testnet data honestly: unverified launch status, on-chain initial supply, real transaction hashes, testnet admission', async () => {
    const scenario = buildScenario({ sepolia: true });
    const { feed, registry } = sepoliaProviders(scenario);
    const detail = await feed.readPairDetail(scenario.misfits.appPairId as PairId);
    expect(detail?.canonicalStatus).toBe('unverified');
    expect(detail?.supply.initialCapBasis).toBe('onchain_initial_supply');
    expect(detail?.activity.every((row) => row.txHash !== null)).toBe(true);
    const record = await feed.readPair(scenario.misfits.appPairId as PairId);
    expect(record?.token.issuerStatus).toBe('unverified');
    expect(record?.quote).toMatchObject({ address: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', issuerStatus: 'unverified' });
    expect(await registry.listSupportedQuotes(11_155_111)).toEqual([
      expect.objectContaining({ admission: 'supported_testnet', issuerFamily: 'Canonical WETH9 (testnet)' }),
    ]);
  });

  it('falls back to the latest block (partial, and says so) when the node does not serve the safe tag', async () => {
    const scenario = buildScenario({ sepolia: true });
    scenario.chain.supportsSafe = false;
    const { feed } = sepoliaProviders(scenario);
    const snapshot = await feed.readFeed(QUERY);
    expect(snapshot.provenance.blockNumber).toBe('80');
    expect(snapshot.provenance.state).toBe('partial');
    expect(snapshot.provenance.source).toContain("did not serve the 'safe' block");
  });
});
