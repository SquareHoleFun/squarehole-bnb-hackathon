/**
 * Builds one feed snapshot: every launched pair read at ONE block (the config's snapshot tag), with state from the
 * contracts and display metrics from the log index at that same block. Pairs whose reads fail are left out and the
 * snapshot says `partial`; a failure of every read is an error, never an empty feed.
 */
import {
  computeMarketCapUsd,
  decimalToString,
  parseDecimal,
  validatePairRecord,
  type AssetIdentity,
  type PairId,
  type PairRecord,
  type Provenance,
} from '@squarehole/domain';
import type { Hex } from 'viem';
import { LOCAL_CHAIN_ID } from '../config/chains';
import { ChainUnavailableError, isAbortError, throwIfAborted } from '../errors';
import type { SyncResult } from '../indexer/indexer';
import { burnedFromEvents, holderCount, turnover24h } from '../indexer/metrics';
import { displayQPerT, mulFloor, rational, rawQPerRawT, toSignificantDecimal, type Rational } from '../reads/pool-math';
import type { AssetMeta, BlockRef, PairChainState } from '../reads/reader';
import type { RegistryPair } from '../reads/registry-pair';
import { isoFromSeconds, type ChainContext } from './context';
import { NOT_AUDITED_DISCLOSURE, classifyQuote, displayQuoteSymbol, displayText, type ChainPairMarket, type Metric } from './model';
import { NO_USD_REASON } from './usd';

export interface SnapshotEntry {
  readonly pair: RegistryPair;
  readonly record: PairRecord;
  readonly market: ChainPairMarket;
  readonly state: PairChainState;
  readonly token: AssetIdentity;
  readonly quote: AssetIdentity;
  readonly launchedAtSeconds: bigint;
  readonly launchTxHash: Hex | null;
  /**
   * Whether index-derived figures (activity, holders, turnover, burn events, launch tx) may be used: this read's own
   * index sync completed AND the index covers the block. A failed sync can leave orphaned logs in the index.
   */
  readonly indexed: boolean;
}

export interface ChainSnapshot {
  readonly snapshotId: string;
  readonly block: BlockRef;
  readonly asOf: string;
  readonly records: readonly PairRecord[];
  readonly entries: ReadonlyMap<string, SnapshotEntry>;
  readonly rewardAssets: readonly AssetIdentity[];
  readonly provenance: Provenance;
  readonly sync: SyncResult | null;
  readonly syncError: string | null;
  readonly pairSource: 'log_index' | 'registry_direct';
  readonly missingPairs: readonly { readonly pairId: PairId; readonly reason: string }[];
}

export function snapshotIdOf(chainId: number, block: BlockRef): string {
  return `${chainId}-${block.number}-${block.hash.slice(2, 10)}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
}

/** The config's wall-clock rule (Sepolia: 15 minutes; local anvil: never), evaluated NOW for a block. */
export function isStale(ctx: ChainContext, block: Pick<BlockRef, 'timestamp'>): boolean {
  const limit = ctx.config.staleAfterMs;
  return limit !== null && ctx.now() - Number(block.timestamp) * 1000 > limit;
}

function tokenIdentity(chainId: number, pair: RegistryPair, symbol: string): AssetIdentity {
  return { chainId, address: pair.token, symbol, decimals: 18, issuerStatus: chainId === LOCAL_CHAIN_ID ? 'mock' : 'unverified' };
}

export function quoteIdentity(ctx: ChainContext, meta: AssetMeta): AssetIdentity {
  const quoteClass = classifyQuote(ctx.manifest, meta.address);
  return {
    chainId: ctx.config.chainId,
    address: meta.address,
    symbol: displayQuoteSymbol(meta.symbol, meta.address),
    decimals: meta.decimals,
    issuerStatus: quoteClass.issuerStatus,
  };
}

async function blockTime(ctx: ChainContext, number: bigint, indexed: boolean): Promise<bigint> {
  return (indexed ? ctx.indexer.blockTimestamp(number) : null) ?? (await ctx.reader.block(number)).timestamp;
}

/** USD view through the policy (null with a reason unless a disclosed source answers). */
async function usdView(
  ctx: ChainContext,
  quote: AssetIdentity,
  block: BlockRef,
  displayPrice: Rational | null,
  eligible: bigint,
  turnoverQRaw: bigint | null,
): Promise<{ priceUsd: string | null; marketCapUsd: string | null; turnover24hUsd: string | null; reason: string | null }> {
  let usd: Awaited<ReturnType<typeof ctx.usd.quote>>;
  try {
    usd = await ctx.usd.quote(quote, block.timestamp);
  } catch (error) {
    if (isAbortError(error)) throw error;
    return { priceUsd: null, marketCapUsd: null, turnover24hUsd: null, reason: `The USD source (${ctx.usd.id}) failed: USD is unavailable.` };
  }
  if (!usd) return { priceUsd: null, marketCapUsd: null, turnover24hUsd: null, reason: NO_USD_REASON };
  const perQ = parseDecimal(usd.usdPerUnit);
  const priceUsd = displayPrice ? toSignificantDecimal(rational(perQ.units * displayPrice.num, 10n ** BigInt(perQ.scale) * displayPrice.den), 18) : null;
  const marketCapUsd = priceUsd === null ? null : computeMarketCapUsd(priceUsd, eligible, 18);
  const turnover24hUsd = turnoverQRaw === null ? null : decimalToString({ units: perQ.units * turnoverQRaw, scale: perQ.scale + quote.decimals });
  return { priceUsd, marketCapUsd, turnover24hUsd, reason: null };
}

/**
 * Reads one pair at `block` and assembles its record and market view. `synced` is whether the caller's index sync
 * for this read completed: only then are index-derived figures used (never from a failed sync's leftovers).
 */
export async function buildEntry(ctx: ChainContext, pair: RegistryPair, block: BlockRef, platformToken: string | null, synced: boolean): Promise<SnapshotEntry> {
  const chainId = ctx.config.chainId;
  const indexed = synced && ctx.indexer.covers(block.number);
  const [state, quoteMeta, launchedAtSeconds] = await Promise.all([
    ctx.reader.pairState(pair, block),
    ctx.reader.assetMeta(pair.quote, block.number),
    blockTime(ctx, pair.createdAtBlock, indexed),
  ]);
  const quoteClass = classifyQuote(ctx.manifest, pair.quote);
  const quote = quoteIdentity(ctx, quoteMeta);
  const text = displayText(state.name, state.symbol, pair.token);
  const token = tokenIdentity(chainId, pair, text.symbol);

  let price: Metric<{ display: string; num: string; den: string; basis: 'pool_mid_price_slot0' }>;
  let rawPrice: Rational | null = null;
  let displayPrice: Rational | null = null;
  try {
    rawPrice = rawQPerRawT(state.slot0.sqrtPriceX96, pair.tIsCurrency0);
    displayPrice = displayQPerT(rawPrice, 18, quote.decimals);
    price = { available: true, display: toSignificantDecimal(displayPrice, 18), num: displayPrice.num.toString(), den: displayPrice.den.toString(), basis: 'pool_mid_price_slot0' };
  } catch {
    price = { available: false, reason: 'pool_not_initialised' };
  }
  const notIndexed = { available: false, reason: 'not_indexed' } as const;
  const holders = indexed ? holderCount(ctx.indexer, pair, block.number, state.totalSupply, state.ledger.excludedAccounts) : notIndexed;
  const turnover = indexed ? turnover24h(ctx.indexer, pair, block.number, block.timestamp) : notIndexed;
  const burnedRaw = pair.initialSupply - state.totalSupply;
  const burnEvents = indexed ? burnedFromEvents(ctx.indexer, pair, block.number) : null;
  const burnReconciled = state.collector.totalTBurned === burnedRaw && (burnEvents === null || burnEvents === burnedRaw);
  const usd = await usdView(ctx, quote, block, displayPrice, state.eligibleSupply, turnover.available ? turnover.totalQRaw : null);

  const partial = !indexed || !holders.available || !turnover.available || !burnReconciled || price.available === false;
  const provenance: Provenance = {
    state: isStale(ctx, block) ? 'stale' : partial ? 'partial' : 'fresh',
    asOf: isoFromSeconds(block.timestamp),
    blockNumber: block.number.toString(),
    blockHash: block.hash,
    source: ctx.sourceLabel,
    coverage: 'canonical_markets',
  };

  const record = validatePairRecord({
    pairId: pair.pairId,
    chainId,
    name: text.name,
    symbol: text.symbol,
    type: pair.kind,
    isPlatform: platformToken !== null && platformToken === pair.token.toLowerCase(),
    launchedAt: isoFromSeconds(launchedAtSeconds),
    // Path A is single-phase: the protocol-owned range IS the market from block one (ADR-0006, ADR-0011).
    lifecycle: 'amm',
    token,
    quote,
    ...(pair.mirror ? { mirrorAddress: pair.mirror, nftUnitRaw: (pair.fractionsPerNft * 10n ** 18n).toString() } : {}),
    rewardSide: pair.rewardSide,
    totalSupplyRaw: state.totalSupply.toString(),
    circulatingSupplyRaw: state.eligibleSupply.toString(),
    burnedRaw: burnedRaw.toString(),
    priceUsd: usd.priceUsd,
    marketCapUsd: usd.marketCapUsd,
    turnover24hUsd: usd.turnover24hUsd,
    holders: holders.available ? holders.count : null,
    // No route has a recorded EXT-05 test: every chain pair stays unverified (links: chain-links.ts).
    routeState: 'unverified',
    provenance,
  });

  const market: ChainPairMarket = {
    pairId: pair.pairId,
    chainId,
    block: { number: block.number.toString(), hash: block.hash, timestamp: block.timestamp.toString() },
    quote: { ...quote, kind: quoteClass.kind, family: quoteClass.family },
    priceQPerT: price,
    marketCapQRaw: rawPrice ? { available: true, value: mulFloor(state.eligibleSupply, rawPrice).toString(), basis: 'mid_price_x_ledger_eligible_supply' } : { available: false, reason: 'unpriced' },
    fdvQRaw: rawPrice ? { available: true, value: mulFloor(state.totalSupply, rawPrice).toString(), basis: 'mid_price_x_current_supply' } : { available: false, reason: 'unpriced' },
    turnover24hQ: turnover.available
      ? {
          available: true,
          totalRaw: turnover.totalQRaw.toString(),
          protocolRaw: turnover.protocolQRaw.toString(),
          otherRaw: turnover.otherQRaw.toString(),
          swaps: turnover.swaps,
          windowStart: isoFromSeconds(turnover.windowStart),
          windowEnd: isoFromSeconds(turnover.windowEnd),
          basis: turnover.basis,
        }
      : { available: false, reason: turnover.reason },
    holders: holders.available ? { available: true, count: holders.count, basis: holders.basis } : { available: false, reason: holders.reason },
    supply: {
      initialRaw: pair.initialSupply.toString(),
      currentRaw: state.totalSupply.toString(),
      eligibleRaw: state.eligibleSupply.toString(),
      burnedRaw: burnedRaw.toString(),
      burnBasis: 'initial_minus_current_supply',
      collectorBurnedRaw: state.collector.totalTBurned.toString(),
      burnEventsRaw: burnEvents === null ? null : burnEvents.toString(),
      burnReconciled,
    },
    usd: { policy: ctx.usd.id, priceUsd: usd.priceUsd, reason: usd.reason },
    soldOut: state.soldOut,
    lpFeePips: state.lpFeePips,
    poolStateSource: state.poolStateSource,
    textReplaced: text.replaced,
    disclosures: [NOT_AUDITED_DISCLOSURE, ...quoteClass.disclosures],
    provenance,
  };

  const launchLog = indexed ? ctx.indexer.logsOf(pair.pairId, block.number, ['PairCreated'])[0] : undefined;
  return {
    pair,
    record,
    market,
    state,
    token,
    quote,
    launchedAtSeconds,
    launchTxHash: launchLog ? launchLog.txHash : null,
    indexed,
  };
}

function rewardAssetsOf(records: readonly PairRecord[]): AssetIdentity[] {
  const byKey = new Map<string, AssetIdentity>();
  for (const record of records) {
    if (record.isPlatform || record.rewardSide !== 'Q') continue;
    const key = `${record.quote.chainId}:${record.quote.address.toLowerCase()}`;
    if (!byKey.has(key)) byKey.set(key, record.quote);
  }
  return [...byKey.values()].sort((a, b) =>
    a.symbol === b.symbol ? (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1) : a.symbol < b.symbol ? -1 : 1,
  );
}

/** Reads the whole feed at the config's snapshot tag. */
export async function buildSnapshot(ctx: ChainContext, signal?: AbortSignal): Promise<ChainSnapshot> {
  throwIfAborted(signal);
  await ctx.ensureChain();
  let block: BlockRef;
  let tagFallback = false;
  try {
    block = await ctx.reader.block(ctx.config.snapshotTag);
  } catch (error) {
    if (isAbortError(error) || ctx.config.snapshotTag === 'latest') throw error;
    block = await ctx.reader.block('latest');
    tagFallback = true;
  }
  let sync: SyncResult | null = null;
  let syncError: string | null = null;
  try {
    sync = await ctx.indexer.sync(block, signal);
  } catch (error) {
    if (isAbortError(error)) throw error;
    syncError = errorText(error);
  }
  throwIfAborted(signal);
  const fromIndex = sync?.complete === true;
  const pairs = fromIndex ? ctx.indexer.pairsAt(block.number) : await ctx.reader.registryPairs(block.number);
  const platformLaunch = ctx.manifest.launches[ctx.config.platformLaunchKey];
  const platformToken = platformLaunch ? platformLaunch.contracts.token.address.toLowerCase() : null;

  const settled = await Promise.allSettled(pairs.map((pair) => buildEntry(ctx, pair, block, platformToken, fromIndex)));
  throwIfAborted(signal);
  const entries = new Map<string, SnapshotEntry>();
  const missingPairs: { pairId: PairId; reason: string }[] = [];
  settled.forEach((result, index) => {
    const pair = pairs[index] as RegistryPair;
    if (result.status === 'fulfilled') entries.set(pair.pairId, result.value);
    else missingPairs.push({ pairId: pair.pairId, reason: errorText(result.reason) });
  });
  if (pairs.length > 0 && entries.size === 0) {
    throw new ChainUnavailableError(`No pair could be read at block ${block.number}: ${missingPairs[0]?.reason ?? ''}`);
  }
  const records = [...entries.values()].map((entry) => entry.record);
  const anyPartial = records.some((record) => record.provenance.state !== 'fresh');
  const provenance: Provenance = {
    state: isStale(ctx, block) ? 'stale' : missingPairs.length > 0 || !fromIndex || anyPartial || tagFallback ? 'partial' : 'fresh',
    asOf: isoFromSeconds(block.timestamp),
    blockNumber: block.number.toString(),
    blockHash: block.hash,
    source: `${ctx.sourceLabel}; ${fromIndex ? `log index (${ctx.indexer.storeKind})` : 'direct registry reads (log index unavailable)'}${
      tagFallback ? `; the RPC did not serve the '${ctx.config.snapshotTag}' block, so this snapshot is at 'latest' (unconfirmed)` : ''
    }`,
    coverage: 'canonical_markets',
  };
  return {
    snapshotId: snapshotIdOf(ctx.config.chainId, block),
    block,
    asOf: provenance.asOf,
    records,
    entries,
    rewardAssets: rewardAssetsOf(records),
    provenance,
    sync,
    syncError,
    pairSource: fromIndex ? 'log_index' : 'registry_direct',
    missingPairs,
  };
}
