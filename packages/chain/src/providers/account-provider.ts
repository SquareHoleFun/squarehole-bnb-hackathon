/**
 * `AccountProvider` over RPC (03-FEED "AccountProvider verifies balances and claims against contracts"; ADR-0008
 * claim contract). Everything is read at ONE block (the newest), so a claim view is consistent with the balances.
 *
 * - claimable: `RewardLedger.claimable(account)` (earned and allocated, floored; never includes pending fees).
 * - claimed + history: the ledger's `Claimed` events of the account (joined with the converter's settlement event for
 *   R = T), from the log index or, if it is behind, a targeted log query by account topic.
 * - earned = claimable + claimed. pendingHarvest = 0: fees are realised as claims at every swap (ADR-0011 §2), so no
 *   unrecognised fee is attributable to an account.
 * - R = T convertible estimate: an eth_call quote of converting the whole claimable Q (V4Quoter where it exists), with
 *   minTOut = floor(quote × (10,000 − 100) / 10,000) and a deadline 20 minutes after the read.
 * - The sold-out direct-Q fallback is REPORTED when the pool range is sold out; it is never selected for the user.
 */
import {
  AccountQueryError,
  canonicalAddress,
  canonicalPairId,
  formatIsoUtc,
  minPayoutRaw,
  parsePairId,
  splitWholeUnits,
  validateAccountClaims,
  validateAccountPositions,
  type AccountClaims,
  type AccountPositions,
  type AccountProvider,
  type Address as DomainAddress,
  type AssetIdentity,
  type ClaimHistoryEntry,
  type ClaimView,
  type ConvertibleEstimate,
  type PairId,
  type PairRecord,
  type Position,
  type Provenance,
} from '@squarehole/domain';
import { getAddress, pad, type Address, type Hex } from 'viem';
import { LOCAL_CHAIN_ID } from '../config/chains';
import { isAbortError, throwIfAborted } from '../errors';
import { EVENT_TOPICS, decodeApprovedLog } from '../indexer/events';
import { createAdaptiveRange, fetchLogsAdaptive, type AdaptiveRange } from '../indexer/log-fetch';
import { claimRecordsFromLogs, type ClaimRecord } from '../indexer/metrics';
import type { IndexedLog } from '../indexer/store';
import { exactRateForQuote } from '../reads/pool-math';
import type { AccountPairState, BlockRef, ConversionQuote } from '../reads/reader';
import type { RegistryPair } from '../reads/registry-pair';
import { isoFromSeconds, type ChainContext } from './context';
import { CHAIN_CLAIM_TOLERANCE_BPS, displayText } from './model';
import { quoteIdentity } from './snapshot';

export interface ChainAccountProvider extends AccountProvider {
  readonly chainId: number;
  /** Why an R = T pair has no estimate at the last read (quote reverted, sold out, …), for the UI's explanation. */
  lastQuoteNotes(): ReadonlyMap<string, string>;
}

interface PairAccountRead {
  readonly pair: RegistryPair;
  readonly record: PairRecord;
  readonly token: AssetIdentity;
  readonly quote: AssetIdentity;
  readonly account: AccountPairState;
  readonly soldOut: boolean | null;
  readonly claims: readonly ClaimRecord[];
  readonly claimTimes: ReadonlyMap<bigint, bigint>;
}

interface AccountRead {
  readonly owner: Address;
  readonly block: BlockRef;
  readonly readAt: number;
  readonly provenance: Provenance;
  readonly pairs: readonly PairAccountRead[];
}

export function createChainAccountProvider(ctx: ChainContext): ChainAccountProvider {
  const targetedRange: AdaptiveRange = createAdaptiveRange(ctx.config.logs.initialRange, ctx.config.logs.minRange, ctx.config.logs.maxRange);
  const quoteNotes = new Map<string, string>();

  async function claimLogs(pair: RegistryPair, owner: Address, block: BlockRef, indexed: boolean, signal?: AbortSignal): Promise<IndexedLog[]> {
    if (indexed) return ctx.indexer.logsOf(pair.pairId, block.number, ['Claimed', 'ClaimConverted', 'ClaimPaidInQSoldOut']);
    // Targeted fallback: the account's own claim events by indexed topic (bounded, adaptive ranges).
    const accountTopic = pad(owner.toLowerCase() as Hex, { size: 32 });
    const raw = [
      ...(await fetchLogsAdaptive(
        ctx.client,
        { address: pair.ledger, topics: [EVENT_TOPICS.ledger.Claimed as Hex, accountTopic] },
        pair.createdAtBlock,
        block.number,
        targetedRange,
        signal,
      )),
      ...(pair.converter
        ? await fetchLogsAdaptive(
            ctx.client,
            {
              address: pair.converter,
              topics: [
                [EVENT_TOPICS.converter.ClaimConverted as Hex, EVENT_TOPICS.converter.ClaimPaidInQSoldOut as Hex],
                pad(pair.token.toLowerCase() as Hex, { size: 32 }),
                accountTopic,
              ],
            },
            pair.createdAtBlock,
            block.number,
            targetedRange,
            signal,
          )
        : []),
    ];
    return raw.flatMap((log) => {
      const role = log.address.toLowerCase() === pair.ledger.toLowerCase() ? 'ledger' : 'converter';
      const decoded = decodeApprovedLog(role, log);
      if (!decoded) return [];
      return [
        {
          key: `${ctx.config.chainId}:${log.blockHash}:${log.transactionHash}:${log.logIndex}`,
          blockNumber: log.blockNumber.toString(),
          blockHash: log.blockHash,
          txHash: log.transactionHash,
          logIndex: log.logIndex,
          address: log.address.toLowerCase(),
          role,
          pairId: pair.pairId,
          event: decoded.event,
          args: decoded.args,
        } satisfies IndexedLog,
      ];
    });
  }

  async function readOnePair(pair: RegistryPair, owner: Address, block: BlockRef, indexed: boolean, provenance: Provenance, signal?: AbortSignal): Promise<PairAccountRead> {
    const [account, totalSupply, quoteMeta, names, logs, launchedAt] = await Promise.all([
      ctx.reader.accountPairState(pair, owner, block.number),
      ctx.reader.totalSupply(pair.token, block.number),
      ctx.reader.assetMeta(pair.quote, block.number),
      ctx.reader.tokenNames(pair.token, block.number),
      claimLogs(pair, owner, block, indexed, signal),
      ctx.indexer.blockTimestamp(pair.createdAtBlock) ?? ctx.reader.block(pair.createdAtBlock).then((header) => header.timestamp),
    ]);
    const soldOut = await ctx.reader.isSoldOut(pair, block.number);
    const claims = claimRecordsFromLogs(pair, owner, logs);
    const claimTimes = new Map<bigint, bigint>();
    for (const claim of claims) {
      if (claimTimes.has(claim.blockNumber)) continue;
      claimTimes.set(claim.blockNumber, ctx.indexer.blockTimestamp(claim.blockNumber) ?? (await ctx.reader.block(claim.blockNumber)).timestamp);
    }
    const text = displayText(names.name, names.symbol, pair.token);
    const token: AssetIdentity = {
      chainId: ctx.config.chainId,
      address: pair.token,
      symbol: text.symbol,
      decimals: 18,
      issuerStatus: ctx.config.chainId === LOCAL_CHAIN_ID ? 'mock' : 'unverified',
    };
    const quote = quoteIdentity(ctx, quoteMeta);
    // Internal record for the domain validators only (fields the account view does not read are honest nulls).
    const record: PairRecord = {
      pairId: pair.pairId,
      chainId: ctx.config.chainId,
      name: text.name,
      symbol: text.symbol,
      type: pair.kind,
      isPlatform: false,
      launchedAt: isoFromSeconds(launchedAt),
      lifecycle: 'amm',
      token,
      quote,
      ...(pair.mirror ? { mirrorAddress: pair.mirror, nftUnitRaw: (pair.fractionsPerNft * 10n ** 18n).toString() } : {}),
      rewardSide: pair.rewardSide,
      totalSupplyRaw: totalSupply.toString(),
      circulatingSupplyRaw: null,
      burnedRaw: (pair.initialSupply - totalSupply).toString(),
      priceUsd: null,
      marketCapUsd: null,
      turnover24hUsd: null,
      holders: null,
      routeState: 'unverified',
      provenance,
    };
    return { pair, record, token, quote, account, soldOut, claims, claimTimes };
  }

  async function readAccount(ownerInput: string, signal?: AbortSignal, only?: PairId): Promise<AccountRead> {
    const owner = getAddress(canonicalAddress(ownerInput));
    throwIfAborted(signal);
    await ctx.ensureChain();
    const block = await ctx.reader.block(ctx.config.accountTag);
    const readAt = Math.max(ctx.now(), Number(block.timestamp) * 1000);
    let indexed = false;
    try {
      indexed = (await ctx.indexer.sync(block, signal)).complete;
    } catch (error) {
      if (isAbortError(error)) throw error;
    }
    throwIfAborted(signal);
    const all = indexed ? ctx.indexer.pairsAt(block.number) : await ctx.reader.registryPairs(block.number);
    const pairs = only === undefined ? all : all.filter((pair) => pair.pairId === canonicalPairId(only));
    if (only !== undefined && pairs.length === 0) throw new AccountQueryError('unknown_pair', 'The pair is not in this chain’s registry');
    const provenance: Provenance = {
      state: indexed ? 'fresh' : 'partial',
      asOf: isoFromSeconds(block.timestamp),
      blockNumber: block.number.toString(),
      blockHash: block.hash,
      source: `${ctx.sourceLabel}; ${indexed ? `claim history from the log index (${ctx.indexer.storeKind})` : 'claim history from targeted log queries'}`,
      coverage: 'canonical_markets',
    };
    const reads = await Promise.all(pairs.map((pair) => readOnePair(pair, owner, block, indexed, provenance, signal)));
    return { owner, block, readAt, provenance, pairs: reads };
  }

  function position(read: PairAccountRead): Position | null {
    const { pair, account } = read;
    if (account.balance === 0n) return null;
    if (!pair.mirror) return { pairId: pair.pairId, balanceRaw: account.balance.toString(), wholeNftCount: null, fractionalRaw: null, nftTokenIds: [] };
    const { whole, fraction } = splitWholeUnits(account.balance, pair.fractionsPerNft * 10n ** 18n);
    return {
      pairId: pair.pairId,
      balanceRaw: account.balance.toString(),
      wholeNftCount: whole.toString(),
      fractionalRaw: fraction.toString(),
      nftTokenIds: [...account.nftIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((id) => id.toString()),
    };
  }

  async function claimView(read: PairAccountRead, snapshot: AccountRead): Promise<ClaimView> {
    const { pair, account, quote, token, claims, claimTimes } = read;
    const claimable = account.claimable;
    const claimed = claims.reduce((sum, claim) => sum + claim.qConsumed, 0n);
    const history: ClaimHistoryEntry[] = claims.map((claim) => ({
      at: isoFromSeconds(claimTimes.get(claim.blockNumber) ?? 0n),
      block: claim.blockNumber.toString(),
      qConsumedRaw: claim.qConsumed.toString(),
      payoutRaw: claim.payout.toString(),
      payoutAsset: claim.payoutAsset === 'T' ? token : quote,
      outcome: 'settled',
      ...(claim.route === 'sold_out_q_fallback' ? { reason: 'Paid in Q by the sold-out fallback (not the T payout)' } : {}),
    }));
    const base = {
      owner: snapshot.owner as DomainAddress,
      pairId: pair.pairId,
      rewardSide: pair.rewardSide,
      earnedQRaw: (claimable + claimed).toString(),
      pendingHarvestQRaw: '0',
      provenance: snapshot.provenance,
      claimableQRaw: claimable.toString(),
      claimedQRaw: claimed.toString(),
      asOfBlock: snapshot.block.number.toString(),
      history,
    };
    if (pair.rewardSide === 'Q') {
      return {
        ...base,
        estimatedPayoutRaw: claimable.toString(),
        payoutAsset: quote,
        conversionAvailable: false,
        directSourceFallbackAvailable: false,
        convertibleEstimate: null,
        directSourceFallback: null,
      };
    }
    const soldOut = read.soldOut === true;
    const fallback = soldOut && claimable > 0n;
    let estimate: ConvertibleEstimate | null = null;
    quoteNotes.delete(pair.pairId);
    if (soldOut) quoteNotes.set(pair.pairId, 'sold_out: no conversion can fill; the labelled direct-Q fallback is available');
    else if (claimable > 0n) {
      const deadlineSeconds = BigInt(Math.floor(snapshot.readAt / 1000)) + BigInt(Math.floor(ctx.quoteTtlMs / 1000));
      const result: ConversionQuote = await ctx.reader.quoteConversion(pair, snapshot.owner, claimable, snapshot.block.number, deadlineSeconds);
      if (result.ok) {
        estimate = {
          payoutRaw: result.tOut.toString(),
          tPerQ: exactRateForQuote(claimable, result.tOut, quote.decimals, token.decimals),
          source: result.source,
          asOfBlock: snapshot.block.number.toString(),
          deadline: formatIsoUtc(Number(deadlineSeconds) * 1000),
          minPayoutRaw: minPayoutRaw(result.tOut, CHAIN_CLAIM_TOLERANCE_BPS).toString(),
          toleranceBps: CHAIN_CLAIM_TOLERANCE_BPS,
        };
      } else {
        quoteNotes.set(pair.pairId, result.reason);
      }
    }
    return {
      ...base,
      estimatedPayoutRaw: estimate ? estimate.payoutRaw : null,
      payoutAsset: token,
      ...(estimate ? { estimateAsOf: isoFromSeconds(snapshot.block.timestamp) } : {}),
      conversionAvailable: !soldOut,
      directSourceFallbackAvailable: fallback,
      convertibleEstimate: estimate,
      directSourceFallback: fallback ? { label: 'emergency_direct_source_q', payoutAsset: quote, payoutRaw: claimable.toString() } : null,
    };
  }

  const lookup = (read: AccountRead): Map<string, PairRecord> => new Map(read.pairs.map((entry) => [entry.pair.pairId, entry.record]));

  return {
    chainId: ctx.config.chainId,

    lastQuoteNotes: () => new Map(quoteNotes),

    async listPositions(account: DomainAddress, signal?: AbortSignal): Promise<AccountPositions> {
      const read = await readAccount(account, signal);
      const positions = read.pairs.map(position).filter((entry): entry is Position => entry !== null);
      return validateAccountPositions(
        { owner: read.owner, asOfBlock: read.block.number.toString(), positions, provenance: read.provenance },
        lookup(read),
      );
    },

    async listClaims(account: DomainAddress, signal?: AbortSignal): Promise<AccountClaims> {
      const read = await readAccount(account, signal);
      const relevant = read.pairs.filter((entry) => entry.account.claimable > 0n || entry.claims.length > 0);
      const claims = await Promise.all(relevant.map((entry) => claimView(entry, read)));
      return validateAccountClaims(
        { owner: read.owner, asOfBlock: read.block.number.toString(), claims, provenance: read.provenance },
        lookup(read),
        { asOf: formatIsoUtc(read.readAt) },
      );
    },

    async readClaim(pairId: PairId, account: DomainAddress, signal?: AbortSignal): Promise<ClaimView> {
      const parsed = parsePairId(pairId);
      if (parsed.chainId !== ctx.config.chainId) throw new AccountQueryError('unknown_pair', 'The pair is on another chain');
      const read = await readAccount(account, signal, parsed.pairId);
      const entry = read.pairs[0] as PairAccountRead;
      const claims = await claimView(entry, read);
      const [validated] = validateAccountClaims(
        { owner: read.owner, asOfBlock: read.block.number.toString(), claims: [claims], provenance: read.provenance },
        lookup(read),
        { asOf: formatIsoUtc(read.readAt) },
      ).claims;
      return validated as ClaimView;
    },
  };
}
