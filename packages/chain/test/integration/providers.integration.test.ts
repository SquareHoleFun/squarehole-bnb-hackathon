/**
 * Integration: the chain providers against a real local deployment (anvil, port 8551) after the SH-B2 end-to-end
 * trades. Every provider value is compared with on-chain truth read independently (direct contract calls, raw logs,
 * cast), including a conversion executed with the provider's own minTOut and a reorg (anvil snapshot/revert).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { shLimit } from '../../../../vitest.timeouts.mjs';
import { createPublicClient, getAddress, hexToBigInt, http, keccak256, encodeAbiParameters, parseAbiItem, type Address, type Hex, type PublicClient } from 'viem';
import {
  createChainConfig,
  createChainProviders,
  deployedManifest,
  rawQPerRawT,
  displayQPerT,
  toSignificantDecimal,
  type ChainProviders,
  type DeploymentManifest,
} from '../../src/index';
import {
  dn404MirrorAbi,
  feeCollectorAbi,
  rewardLedgerAbi,
  squareHoleRegistryAbi,
  squareHoleTokenAbi,
  stateViewAbi,
  v4QuoterAbi,
  squareHoleHookAbi,
} from '../../src/abi';
import { castCall, castSend, rpc, startLocalStack, type LocalStack } from './local-stack';

type Deployed = Extract<ChainProviders, { status: 'deployed' }>;

const FEED_QUERY = { search: '', sort: 'market_cap', type: 'all', lifecycle: 'all', limit: 100 } as const;
const SWAP_EVENT = parseAbiItem('event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)');
const CLAIM_CONVERTED = parseAbiItem('event ClaimConverted(address indexed token, address indexed holder, uint256 qIn, uint256 tOut)');

let stack: LocalStack;
let providers: Deployed;
let extsloadProviders: Deployed;
let truth: PublicClient;
let manifest: DeploymentManifest;
const actors: Record<string, Address> = {};

function deployed(value: ChainProviders): Deployed {
  if (value.status !== 'deployed') throw new Error('expected a deployed chain');
  return value;
}

async function registryPair(token: Address) {
  return truth.readContract({ address: manifest.contracts.registry.address, abi: squareHoleRegistryAbi, functionName: 'pairOfToken', args: [token] });
}

beforeAll(async () => {
  stack = await startLocalStack();
  const config = createChainConfig({
    chainId: 31_337,
    manifest: stack.manifest,
    rpcUrls: [stack.rpcUrl],
    localLens: { stateView: stack.stateView, v4Quoter: stack.v4Quoter },
  });
  manifest = deployedManifest(config);
  providers = deployed(createChainProviders(config, { snapshotReuseMs: 0 }));
  extsloadProviders = deployed(createChainProviders(createChainConfig({ chainId: 31_337, manifest: stack.manifest, rpcUrls: [stack.rpcUrl] }), { snapshotReuseMs: 0 }));
  truth = createPublicClient({ transport: http(stack.rpcUrl) });
  for (const [name, index] of Object.entries({ deployer: 0, alice: 1, bob: 2, carol: 3, dave: 4, creator: 5, keeper: 6 })) actors[name] = stack.address(index);
}, shLimit(900_000));

const report: Record<string, unknown> = {};

afterAll(async () => {
  const path = process.env.SH_CHAIN_IT_REPORT;
  if (path && stack) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, JSON.stringify({ rpc: stack.rpcUrl, stateView: stack.stateView, v4Quoter: stack.v4Quoter, commands: stack.log, ...report }, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value), 2));
  }
  await stack?.stop();
});

describe('feed provider vs on-chain truth', () => {
  it('lists every registry pair once, pins FIT (manifest identity) and reads everything at one block', async () => {
    const snapshot = await providers.feed.readFeed(FEED_QUERY);
    const head = await truth.getBlock({ blockTag: 'latest' });
    const count = await truth.readContract({ address: manifest.contracts.registry.address, abi: squareHoleRegistryAbi, functionName: 'pairCount' });
    expect(count).toBe(3n);
    expect(snapshot.platform?.pairId).toBe(manifest.launches.FIT?.appPairId);
    expect(snapshot.platform?.isPlatform).toBe(true);
    expect(snapshot.items.map((item) => item.name).sort()).toEqual(['E2E Tether pair (local test)', 'The Misfits']);
    expect(snapshot.totalMatches).toBe(2);
    expect(snapshot.provenance).toMatchObject({ state: 'fresh', blockNumber: head.number.toString(), blockHash: head.hash, coverage: 'canonical_markets' });
    for (const record of [snapshot.platform, ...snapshot.items]) {
      expect(record?.provenance.blockNumber).toBe(head.number.toString());
      expect(record?.lifecycle).toBe('amm');
      expect(record?.routeState).toBe('unverified');
      // No USD source is adopted (ADR-0012): every USD field is null, never a fabricated number.
      expect([record?.priceUsd, record?.marketCapUsd, record?.turnover24hUsd]).toEqual([null, null, null]);
    }
    // Reward filter options: R = Q organic pairs only (FIT is the platform item; The Misfits pays T).
    expect(snapshot.rewardAssets.map((asset) => asset.symbol)).toEqual(['USDT-TEST']);
    report.feed = { snapshotId: snapshot.snapshotId, provenance: snapshot.provenance, platform: snapshot.platform, items: snapshot.items };
  });

  it('supply, circulating (ledger-eligible) and burned supply equal the contracts', async () => {
    const snapshot = await providers.feed.readFeed(FEED_QUERY);
    for (const record of [snapshot.platform, ...snapshot.items]) {
      if (!record) throw new Error('missing record');
      const token = record.token.address as Address;
      const pair = await registryPair(token);
      const [supply, eligible, burnedByCollector] = await Promise.all([
        truth.readContract({ address: token, abi: squareHoleTokenAbi, functionName: 'totalSupply' }),
        truth.readContract({ address: pair.ledger, abi: rewardLedgerAbi, functionName: 'eligibleSupply' }),
        truth.readContract({ address: pair.collector, abi: feeCollectorAbi, functionName: 'totalTBurned' }),
      ]);
      expect(record.totalSupplyRaw).toBe(supply.toString());
      expect(record.circulatingSupplyRaw).toBe(eligible.toString());
      expect(record.burnedRaw).toBe((pair.initialSupply - supply).toString());
      expect(record.burnedRaw).toBe(burnedByCollector.toString());
      const market = await providers.feed.readMarket(record.pairId);
      expect(market?.supply).toMatchObject({ burnReconciled: true, burnEventsRaw: burnedByCollector.toString() });
    }
  });

  it('prices from sqrtPriceX96 exactly (StateView and PoolManager extsload agree), market cap and FDV in Q', async () => {
    for (const key of ['FIT', 'THE_MISFITS'] as const) {
      const launch = manifest.launches[key];
      if (!launch) throw new Error(`manifest launch ${key}`);
      const token = launch.contracts.token.address;
      const [sqrtPriceX96] = await truth.readContract({ address: stack.stateView, abi: stateViewAbi, functionName: 'getSlot0', args: [launch.poolId] });
      const tIsCurrency0 = token.toLowerCase() < launch.quote.toLowerCase();
      const square = sqrtPriceX96 * sqrtPriceX96;
      const q192 = 2n ** 192n;
      const [supply, eligible] = await Promise.all([
        truth.readContract({ address: token, abi: squareHoleTokenAbi, functionName: 'totalSupply' }),
        truth.readContract({ address: launch.contracts.rewardLedger.address, abi: rewardLedgerAbi, functionName: 'eligibleSupply' }),
      ]);
      const market = await providers.feed.readMarket(launch.appPairId as `${number}:0x${string}`);
      const viaExtsload = await extsloadProviders.feed.readMarket(launch.appPairId as `${number}:0x${string}`);
      if (!market?.priceQPerT.available || !viaExtsload?.priceQPerT.available) throw new Error('unpriced');
      report[`market_${key}`] = market;
      expect(market.poolStateSource).toBe('state_view');
      expect(viaExtsload.poolStateSource).toBe('pool_manager_extsload');
      expect(viaExtsload.priceQPerT).toEqual(market.priceQPerT);
      const expected = displayQPerT(rawQPerRawT(sqrtPriceX96, tIsCurrency0), 18, 18);
      expect(market.priceQPerT.display).toBe(toSignificantDecimal(expected, 18));
      // Exact rational check without the helper: price × den == num relation against sqrtPriceX96.
      const num = BigInt(market.priceQPerT.num);
      const den = BigInt(market.priceQPerT.den);
      expect(tIsCurrency0 ? num * q192 === den * square : num * square === den * q192).toBe(true);
      const mcap = tIsCurrency0 ? (eligible * square) / q192 : (eligible * q192) / square;
      const fdv = tIsCurrency0 ? (supply * square) / q192 : (supply * q192) / square;
      expect(market.marketCapQRaw).toMatchObject({ available: true, value: mcap.toString() });
      expect(market.fdvQRaw).toMatchObject({ available: true, value: fdv.toString() });
      // Sanity against an executable quote: a small buy pays more than the mid price (3% fee + price impact).
      const qIsCurrency0 = !tIsCurrency0;
      const lpFee = await truth.readContract({ address: manifest.contracts.hook.address, abi: squareHoleHookAbi, functionName: 'LP_FEE' });
      const { result } = await truth.simulateContract({
        address: stack.v4Quoter,
        abi: v4QuoterAbi,
        functionName: 'quoteExactInputSingle',
        args: [{ poolKey: { currency0: qIsCurrency0 ? launch.quote : token, currency1: qIsCurrency0 ? token : launch.quote, fee: lpFee, tickSpacing: launch.tickSpacing, hooks: manifest.contracts.hook.address }, zeroForOne: qIsCurrency0, exactAmount: 10n ** 12n, hookData: '0x' }],
      });
      const tOut = result[0];
      // qIn / tOut >= mid price  <=>  qIn × den >= tOut × num (display units, both 18 decimals here).
      expect(10n ** 12n * den >= tOut * num).toBe(true);
      expect(10n ** 12n * den * 100n <= tOut * num * 104n).toBe(true);
    }
  });

  it('24h turnover counts each canonical-pool swap once by its Q leg and tags converter swaps as protocol', async () => {
    for (const key of ['FIT', 'THE_MISFITS'] as const) {
      const launch = manifest.launches[key];
      if (!launch) throw new Error(key);
      const logs = await truth.getLogs({ address: manifest.contracts.poolManager.address, event: SWAP_EVENT, args: { id: launch.poolId }, fromBlock: 0n, toBlock: 'latest' });
      const tIsCurrency0 = launch.contracts.token.address.toLowerCase() < launch.quote.toLowerCase();
      const abs = (value: bigint) => (value < 0n ? -value : value);
      const total = logs.reduce((sum, log) => sum + abs((tIsCurrency0 ? log.args.amount1 : log.args.amount0) ?? 0n), 0n);
      const protocol = logs
        .filter((log) => log.args.sender?.toLowerCase() === manifest.contracts.claimConverter?.address.toLowerCase())
        .reduce((sum, log) => sum + abs((tIsCurrency0 ? log.args.amount1 : log.args.amount0) ?? 0n), 0n);
      const market = await providers.feed.readMarket(launch.appPairId as `${number}:0x${string}`);
      expect(market?.turnover24hQ).toMatchObject({ available: true, totalRaw: total.toString(), protocolRaw: protocol.toString(), swaps: logs.length });
      if (key === 'THE_MISFITS') expect(protocol > 0n).toBe(true);
      if (key === 'FIT') expect(protocol).toBe(0n);
    }
  });

  it('holder count = accounts with a positive eligible balance, and those balances add up to the ledger’s eligible supply', async () => {
    const snapshot = await providers.feed.readFeed(FEED_QUERY);
    for (const record of [snapshot.platform, ...snapshot.items]) {
      if (!record) throw new Error('record');
      const pair = await registryPair(record.token.address as Address);
      const eligible = await truth.readContract({ address: pair.ledger, abi: rewardLedgerAbi, functionName: 'eligibleSupply' });
      let sum = 0n;
      let count = 0;
      for (let index = 0; index < 10; index += 1) {
        const account = stack.address(index);
        const [balance, excluded] = await Promise.all([
          truth.readContract({ address: pair.token, abi: squareHoleTokenAbi, functionName: 'balanceOf', args: [account] }),
          truth.readContract({ address: pair.ledger, abi: rewardLedgerAbi, functionName: 'isExcluded', args: [account] }),
        ]);
        if (balance > 0n && !excluded) {
          count += 1;
          sum += balance;
        }
      }
      // Only anvil accounts trade in the local run, so they are every eligible holder iff their balances sum to it.
      expect(sum).toBe(eligible);
      expect(record.holders).toBe(count);
    }
  });
});

describe('pair detail vs on-chain truth', () => {
  it('The Misfits: supply concepts, observed NFT count, rewards in their own units and activity from logs', async () => {
    const launch = manifest.launches.THE_MISFITS;
    if (!launch) throw new Error('THE_MISFITS');
    const pairId = launch.appPairId as `${number}:0x${string}`;
    const detail = await providers.feed.readPairDetail(pairId);
    if (!detail) throw new Error('no detail');
    const token = launch.contracts.token.address;
    const [supply, nfts, claimed, received] = await Promise.all([
      truth.readContract({ address: token, abi: squareHoleTokenAbi, functionName: 'totalSupply' }),
      truth.readContract({ address: launch.contracts.mirror.address, abi: dn404MirrorAbi, functionName: 'totalSupply' }),
      truth.readContract({ address: launch.contracts.rewardLedger.address, abi: rewardLedgerAbi, functionName: 'totalClaimed' }),
      truth.readContract({ address: launch.contracts.rewardLedger.address, abi: rewardLedgerAbi, functionName: 'totalHolderQReceived' }),
    ]);
    const unit = BigInt(launch.fractionsPerNft) * 10n ** 18n;
    expect(detail.supply).toMatchObject({
      currentRaw: supply.toString(),
      initialCapRaw: launch.initialSupply,
      feeBurnedRaw: (BigInt(launch.initialSupply) - supply).toString(),
      wholeUnitCapacity: { count: (supply / unit).toString(), basis: 'floor_current_supply_over_unit' },
      activeNftCount: Number(nfts),
      exclusionBasis: 'ledger_eligible_supply',
    });
    expect(detail.canonicalStatus).toBe('demo_not_deployed');
    expect(detail.nft).toEqual({ mirrorAddress: launch.contracts.mirror.address, unitRaw: unit.toString(), gallery: [] });
    expect(detail.artwork).toEqual({ state: 'unavailable', reason: 'not_uploaded' });
    const converted = await truth.getLogs({ address: manifest.contracts.claimConverter?.address, event: CLAIM_CONVERTED, args: { token }, fromBlock: 0n, toBlock: 'latest' });
    const tPaid = converted.reduce((sum, log) => sum + (log.args.tOut ?? 0n), 0n);
    expect(detail.rewards).toEqual([
      { asset: expect.objectContaining({ address: getAddress(launch.quote) }), paidRaw: claimed.toString(), accruedRaw: received.toString() },
      { asset: expect.objectContaining({ address: getAddress(token) }), paidRaw: tPaid.toString(), accruedRaw: null },
    ]);
    const swaps = await truth.getLogs({ address: manifest.contracts.poolManager.address, event: SWAP_EVENT, args: { id: launch.poolId }, fromBlock: 0n, toBlock: 'latest' });
    const kinds = detail.activity.map((row) => row.kind);
    expect(kinds[0]).toBe('launch');
    // The converter's own conversion swaps are listed once, as their claim row, never as observed external trades.
    const converter = (manifest.contracts.claimConverter?.address ?? '').toLowerCase();
    const external = swaps.filter((log) => (log.args.sender ?? '').toLowerCase() !== converter);
    expect(swaps.length - external.length).toBe(converted.length);
    expect(kinds.filter((kind) => kind === 'swap_observation')).toHaveLength(external.length);
    expect(kinds.filter((kind) => kind === 'claim')).toHaveLength(converted.length);
    expect(kinds.filter((kind) => kind === 'burn')).toHaveLength(1);
    // Local demo chain: no transaction hashes (no explorer, FEED-09).
    expect(detail.activity.every((row) => row.txHash === null)).toBe(true);
    report.misfitsDetail = { supply: detail.supply, rewards: detail.rewards, activityKinds: kinds };
  });
});

describe('account provider vs on-chain truth', () => {
  it('positions: balances, whole NFTs and the exact NFT ids the mirror assigns', async () => {
    const positions = await providers.accounts.listPositions(actors.alice as `0x${string}`);
    const misfits = manifest.launches.THE_MISFITS;
    if (!misfits) throw new Error('THE_MISFITS');
    const head = await truth.getBlockNumber();
    expect(positions.asOfBlock).toBe(head.toString());
    for (const position of positions.positions) {
      const token = position.pairId.split(':')[1] as Address;
      const balance = await truth.readContract({ address: token, abi: squareHoleTokenAbi, functionName: 'balanceOf', args: [actors.alice as Address] });
      expect(position.balanceRaw).toBe(balance.toString());
    }
    const nftPosition = positions.positions.find((position) => position.pairId === misfits.appPairId);
    if (!nftPosition) throw new Error('alice holds The Misfits');
    const count = await truth.readContract({ address: misfits.contracts.mirror.address, abi: dn404MirrorAbi, functionName: 'balanceOf', args: [actors.alice as Address] });
    expect(nftPosition.nftTokenIds).toHaveLength(Number(count));
    for (const id of nftPosition.nftTokenIds) {
      const owner = await truth.readContract({ address: misfits.contracts.mirror.address, abi: dn404MirrorAbi, functionName: 'ownerOf', args: [BigInt(id)] });
      expect(owner).toBe(actors.alice);
    }
    const unit = BigInt(misfits.fractionsPerNft) * 10n ** 18n;
    expect(nftPosition.wholeNftCount).toBe((BigInt(nftPosition.balanceRaw) / unit).toString());
  });

  it('claims: claimable from the ledger, claimed from its events, an R = T estimate from V4Quoter equal to the converter eth_call', async () => {
    const claims = await providers.accounts.listClaims(actors.bob as `0x${string}`);
    const misfits = manifest.launches.THE_MISFITS;
    const fit = manifest.launches.FIT;
    if (!misfits || !fit) throw new Error('launches');
    for (const claim of claims.claims) {
      const pair = await registryPair(claim.pairId.split(':')[1] as Address);
      const claimable = await truth.readContract({ address: pair.ledger, abi: rewardLedgerAbi, functionName: 'claimable', args: [actors.bob as Address] });
      expect(claim.claimableQRaw).toBe(claimable.toString());
      expect(BigInt(claim.earnedQRaw)).toBe(BigInt(claim.claimableQRaw) + BigInt(claim.claimedQRaw));
      expect(claim.pendingHarvestQRaw).toBe('0');
    }
    report.bobClaims = claims;
    const fitClaim = claims.claims.find((claim) => claim.pairId === fit.appPairId);
    expect(fitClaim?.history).toHaveLength(1);
    expect(fitClaim?.claimedQRaw).toBe(fitClaim?.history[0]?.qConsumedRaw);

    const misfitsClaim = claims.claims.find((claim) => claim.pairId === misfits.appPairId);
    if (!misfitsClaim?.convertibleEstimate) throw new Error('bob has an unconverted R = T entitlement with a quote');
    const estimate = misfitsClaim.convertibleEstimate;
    expect(estimate.source).toBe('v4_quoter_eth_call');
    expect(estimate.toleranceBps).toBe(100);
    expect(estimate.minPayoutRaw).toBe(((BigInt(estimate.payoutRaw) * 9900n) / 10000n).toString());
    expect(misfitsClaim.directSourceFallbackAvailable).toBe(false);
    // Independent truth: the holder's own whole-entitlement conversion simulated by eth_call from bob.
    const deadline = String(Math.floor(Date.parse(estimate.deadline) / 1000));
    const simulated = castCall(stack, manifest.contracts.claimConverter?.address as string, 'claimAsT(bytes32,uint256,uint256)(uint256,uint256)', [misfits.pairId, '0', deadline], actors.bob);
    const [qIn, tOut] = simulated.split('\n').map((line) => BigInt(line.split(' ')[0] as string));
    expect(qIn?.toString()).toBe(misfitsClaim.claimableQRaw);
    expect(tOut?.toString()).toBe(estimate.payoutRaw);
  });

  it('a conversion signed with the provider’s minTOut and deadline settles, and the claim view follows the chain', async () => {
    const misfits = manifest.launches.THE_MISFITS;
    if (!misfits) throw new Error('THE_MISFITS');
    const pairId = misfits.appPairId as `${number}:0x${string}`;
    const before = await providers.accounts.readClaim(pairId, actors.bob as `0x${string}`);
    const estimate = before.convertibleEstimate;
    if (!estimate) throw new Error('estimate');
    const deadline = String(Math.floor(Date.parse(estimate.deadline) / 1000));
    const tx = castSend(stack, 2, manifest.contracts.claimConverter?.address as string, 'claimAsT(bytes32,uint256,uint256)', [misfits.pairId, estimate.minPayoutRaw, deadline]);
    const receipt = await truth.getTransactionReceipt({ hash: tx });
    expect(receipt.status).toBe('success');
    const after = await providers.accounts.readClaim(pairId, actors.bob as `0x${string}`);
    const claimable = await truth.readContract({ address: misfits.contracts.rewardLedger.address, abi: rewardLedgerAbi, functionName: 'claimable', args: [actors.bob as Address] });
    expect(after.claimableQRaw).toBe(claimable.toString());
    expect(after.history).toHaveLength(before.history.length + 1);
    const last = after.history.at(-1);
    expect(last?.qConsumedRaw).toBe(before.claimableQRaw);
    expect(BigInt(last?.payoutRaw ?? '0') >= BigInt(estimate.minPayoutRaw)).toBe(true);
    expect(last?.payoutAsset.address).toBe(getAddress(misfits.contracts.token.address));
    expect(after.claimedQRaw).toBe((BigInt(before.claimedQRaw) + BigInt(before.claimableQRaw)).toString());
    report.conversion = { tx, minTOut: estimate.minPayoutRaw, quoted: estimate.payoutRaw, paid: last?.payoutRaw, qConsumed: last?.qConsumedRaw, claimableAfter: after.claimableQRaw };
  });
});

describe('asset registry provider', () => {
  it('lists the admitted quotes with active templates by exact address; unknown addresses are null', async () => {
    const quotes = await providers.registry.listSupportedQuotes(31_337);
    expect(quotes.map((entry) => entry.asset.address).sort()).toEqual(
      [manifest.contracts.WETH?.address, manifest.contracts.USDC?.address, manifest.contracts.USDT?.address, manifest.launches.FIT?.contracts.token.address]
        .map((address) => getAddress(address as string))
        .sort(),
    );
    expect(quotes.every((entry) => entry.admission === 'supported_demo')).toBe(true);
    const usdt = quotes.find((entry) => entry.asset.symbol === 'USDT-TEST');
    expect(usdt).toMatchObject({ asset: { decimals: 6, issuerStatus: 'mock' }, issuerFamily: 'Square Hole testnet mock (USDT-TEST)' });
    expect(await providers.registry.readAsset(31_337, '0x000000000000000000000000000000000000dEaD')).toBeNull();
    expect(await providers.registry.readAsset(11_155_111, manifest.contracts.WETH?.address as `0x${string}`)).toBeNull();
    expect(await providers.registry.listSupportedQuotes(11_155_111)).toEqual([]);
    const templates = await providers.registry.listTemplates();
    expect(templates.find((template) => template.quote === getAddress(manifest.contracts.WETH?.address as string))?.maxCollectionUnits).toBe(10_000n);
  });
});

describe('indexer: reorg handling (anvil snapshot / revert)', () => {
  it('a reverted block range is detected by hash, rewound and re-indexed; metrics return to the canonical chain', async () => {
    const fit = manifest.launches.FIT;
    if (!fit) throw new Error('FIT');
    const pairId = fit.appPairId as `${number}:0x${string}`;
    const holdersBefore = (await providers.feed.readPair(pairId))?.holders;
    const snapshotId = await rpc<Hex>(stack.rpcUrl, 'evm_snapshot');
    const fresh = '0x00000000000000000000000000000000000c0ffe';
    castSend(stack, 4, fit.contracts.token.address, 'transfer(address,uint256)', [fresh, '1']);
    const forked = await providers.feed.readPair(pairId);
    expect(forked?.holders).toBe((holdersBefore ?? 0) + 1);
    const orphanHead = forked?.provenance.blockHash;
    expect(await rpc<boolean>(stack.rpcUrl, 'evm_revert', [snapshotId])).toBe(true);
    await rpc(stack.rpcUrl, 'anvil_mine', ['0x3']);
    const canonical = await providers.feed.readPair(pairId);
    expect(canonical?.holders).toBe(holdersBefore);
    expect(canonical?.provenance.blockHash).not.toBe(orphanHead);
    const info = providers.feed.lastSnapshotInfo();
    report.reorg = { holdersBefore, holdersOnFork: forked?.holders, holdersAfter: canonical?.holders, orphanHead, canonicalHead: canonical?.provenance.blockHash, reorgs: info?.sync?.reorgs };
    expect(info?.sync?.reorgs.length).toBeGreaterThanOrEqual(1);
    expect(info?.sync?.reorgs[0]?.logsRemoved).toBeGreaterThanOrEqual(1);
    // Nothing from the orphaned transfer survives in the index.
    const state = providers.indexer.snapshotState();
    const leftovers = Object.values(state?.logs ?? {}).filter((log) => String(log.args.to).toLowerCase() === fresh);
    expect(leftovers).toEqual([]);
    const truthBalance = await truth.readContract({ address: fit.contracts.token.address, abi: squareHoleTokenAbi, functionName: 'balanceOf', args: [fresh] });
    expect(truthBalance).toBe(0n);
  });
});

describe('indexer: a chain that gets shorter (evm_revert without new blocks)', () => {
  it('the stored head no longer exists: handled as a reorg, the snapshot stays on the log index and orphaned logs are gone', async () => {
    const fit = manifest.launches.FIT;
    if (!fit) throw new Error('FIT');
    const pairId = fit.appPairId as `${number}:0x${string}`;
    const holdersBefore = (await providers.feed.readPair(pairId))?.holders;
    // cacheTime 0: viem caches getBlockNumber for its polling interval (4 s), which would report an older head.
    const headBefore = await truth.getBlockNumber({ cacheTime: 0 });
    const snapshotId = await rpc<Hex>(stack.rpcUrl, 'evm_snapshot');
    const fresh = '0x00000000000000000000000000000000000c0ff1';
    castSend(stack, 4, fit.contracts.token.address, 'transfer(address,uint256)', [fresh, '1']);
    const forked = await providers.feed.readPair(pairId);
    expect(forked?.holders).toBe((holdersBefore ?? 0) + 1);
    expect(BigInt(forked?.provenance.blockNumber ?? '0')).toBeGreaterThan(headBefore);
    // Revert and read at once: the chain tip is now BELOW the indexed head (no block at the stored head number).
    expect(await rpc<boolean>(stack.rpcUrl, 'evm_revert', [snapshotId])).toBe(true);
    expect(await truth.getBlockNumber({ cacheTime: 0 })).toBe(headBefore);
    const after = await providers.feed.readPair(pairId);
    const info = providers.feed.lastSnapshotInfo();
    report.shrunkHead = { headBefore: headBefore.toString(), forkHead: forked?.provenance.blockNumber, afterHead: after?.provenance.blockNumber, pairSource: info?.pairSource, reorgs: info?.sync?.reorgs };
    expect(after?.provenance.blockNumber).toBe(headBefore.toString());
    expect(after?.holders).toBe(holdersBefore);
    expect(info?.pairSource).toBe('log_index');
    expect(info?.sync?.reorgs.length).toBeGreaterThanOrEqual(1);
    const leftovers = Object.values(providers.indexer.snapshotState()?.logs ?? {}).filter((log) => String(log.args.to).toLowerCase() === fresh);
    expect(leftovers).toEqual([]);
  });
});

describe('manifest identities', () => {
  it('the on-chain pair id is keccak256(abi.encode(chainId, token)) for every launch', () => {
    for (const launch of Object.values(manifest.launches)) {
      expect(launch.pairId).toBe(keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }], [31_337n, launch.contracts.token.address])));
      expect(hexToBigInt(launch.poolId) > 0n).toBe(true);
    }
  });
});
