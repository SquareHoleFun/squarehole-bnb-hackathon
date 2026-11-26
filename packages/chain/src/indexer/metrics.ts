/**
 * Display metrics derived from the log index (never entitlements). Each metric states its basis; when the index does
 * not cover the needed blocks, or the replay contradicts on-chain state, the metric is UNAVAILABLE with a reason,
 * never a zero (03-FEED FEED-06).
 */
import type { Address } from 'viem';
import { ChainDataError } from '../errors';
import type { RegistryPair } from '../reads/registry-pair';
import type { LogIndexer } from './indexer';
import type { IndexedLog } from './store';

export const TURNOVER_WINDOW_SECONDS = 86_400n;
const ZERO = '0x0000000000000000000000000000000000000000';

export type Unavailable<Reason extends string = string> = { readonly available: false; readonly reason: Reason };

export type HolderCount =
  | { readonly available: true; readonly count: number; readonly basis: 'transfer_replay_positive_eligible_balances' }
  | Unavailable<'not_indexed' | 'replay_mismatch'>;

/**
 * Economic owners with a positive ELIGIBLE balance (ERC-20 Transfer replay from the token's creation), excluding the
 * ledger's excluded roles (pool manager reserves, hook, collector, ledger, treasury, converter, launcher, T, mirror).
 * NFT holders are not added again: they are the same balances (FEED-07, 03-FEED "Holder counts").
 * The replay must reproduce the on-chain total supply exactly, or the count is not shown.
 */
export function holderCount(indexer: LogIndexer, pair: RegistryPair, blockNumber: bigint, totalSupply: bigint, excluded: readonly Address[]): HolderCount {
  if (!indexer.covers(blockNumber)) return { available: false, reason: 'not_indexed' };
  const balances = new Map<string, bigint>();
  let minted = 0n;
  let burned = 0n;
  for (const log of indexer.logsOf(pair.pairId, blockNumber, ['Transfer'])) {
    if (log.role !== 'token') continue;
    const from = String(log.args.from).toLowerCase();
    const to = String(log.args.to).toLowerCase();
    const amount = BigInt(String(log.args.amount));
    if (from === ZERO) minted += amount;
    else balances.set(from, (balances.get(from) ?? 0n) - amount);
    if (to === ZERO) burned += amount;
    else balances.set(to, (balances.get(to) ?? 0n) + amount);
  }
  if (minted - burned !== totalSupply || [...balances.values()].some((balance) => balance < 0n)) {
    return { available: false, reason: 'replay_mismatch' };
  }
  const skip = new Set(excluded.map((account) => account.toLowerCase()));
  let count = 0;
  for (const [account, balance] of balances) if (balance > 0n && !skip.has(account)) count += 1;
  return { available: true, count, basis: 'transfer_replay_positive_eligible_balances' };
}

export type Turnover =
  | {
      readonly available: true;
      readonly basis: 'canonical_pool_swaps_q_leg_rolling_24h';
      /** Q-leg notional, raw Q, of every swap in the window (gross input on buys, output on sells), each counted once. */
      readonly totalQRaw: bigint;
      /** Swaps sent by the R = T claim converter (protocol-generated conversions), tagged separately (03-FEED). */
      readonly protocolQRaw: bigint;
      readonly otherQRaw: bigint;
      readonly swaps: number;
      readonly windowStart: bigint;
      readonly windowEnd: bigint;
    }
  | Unavailable<'not_indexed' | 'missing_block_time'>;

/** Rolling 24h window ending at the snapshot block's timestamp: (end − 86,400 s, end]. */
export function turnover24h(indexer: LogIndexer, pair: RegistryPair, blockNumber: bigint, blockTimestamp: bigint): Turnover {
  if (!indexer.covers(blockNumber)) return { available: false, reason: 'not_indexed' };
  const windowStart = blockTimestamp - TURNOVER_WINDOW_SECONDS;
  let total = 0n;
  let protocol = 0n;
  let swaps = 0;
  const converter = pair.converter?.toLowerCase() ?? null;
  for (const log of indexer.logsOf(pair.pairId, blockNumber, ['Swap'])) {
    const at = indexer.blockTimestamp(BigInt(log.blockNumber));
    if (at === null) return { available: false, reason: 'missing_block_time' };
    if (at <= windowStart || at > blockTimestamp) continue;
    const raw = BigInt(String(pair.tIsCurrency0 ? log.args.amount1 : log.args.amount0));
    const notional = raw < 0n ? -raw : raw;
    total += notional;
    swaps += 1;
    if (converter !== null && String(log.args.sender).toLowerCase() === converter) protocol += notional;
  }
  return {
    available: true,
    basis: 'canonical_pool_swaps_q_leg_rolling_24h',
    totalQRaw: total,
    protocolQRaw: protocol,
    otherQRaw: total - protocol,
    swaps,
    windowStart,
    windowEnd: blockTimestamp,
  };
}

/** Sum of the collector's FeeTBurned events (null when the index does not cover the block). */
export function burnedFromEvents(indexer: LogIndexer, pair: RegistryPair, blockNumber: bigint): bigint | null {
  if (!indexer.covers(blockNumber)) return null;
  return indexer
    .logsOf(pair.pairId, blockNumber, ['FeeTBurned'])
    .filter((log) => log.role === 'collector')
    .reduce((sum, log) => sum + BigInt(String(log.args.amount)), 0n);
}

export interface ConversionTotals {
  /** T paid to holders by R = T conversions (ClaimConverted.tOut). */
  readonly tPaidRaw: bigint;
  /** Q paid directly by the sold-out fallback (ClaimPaidInQSoldOut.qOut). */
  readonly qFallbackPaidRaw: bigint;
}

export function conversionTotals(indexer: LogIndexer, pair: RegistryPair, blockNumber: bigint): ConversionTotals | null {
  if (!indexer.covers(blockNumber)) return null;
  let tPaid = 0n;
  let qFallback = 0n;
  for (const log of indexer.logsOf(pair.pairId, blockNumber, ['ClaimConverted', 'ClaimPaidInQSoldOut'])) {
    if (log.role !== 'converter') continue;
    if (log.event === 'ClaimConverted') tPaid += BigInt(String(log.args.tOut));
    else qFallback += BigInt(String(log.args.qOut));
  }
  return { tPaidRaw: tPaid, qFallbackPaidRaw: qFallback };
}

export interface ClaimRecord {
  readonly blockNumber: bigint;
  readonly txHash: string;
  readonly logIndex: number;
  /** Q entitlement consumed (ledger Claimed.amount). */
  readonly qConsumed: bigint;
  readonly payoutAsset: 'Q' | 'T';
  readonly payout: bigint;
  readonly route: 'claim_q' | 'convert_to_t' | 'sold_out_q_fallback';
}

/**
 * Settled claims of `account` from the ledger's Claimed events, each joined with the converter event of the same
 * transaction for R = T launches (the payout T, or the labelled Q fallback). Reverted attempts leave no log and are
 * not listed.
 */
export function claimRecordsFromLogs(pair: RegistryPair, account: Address, logs: readonly IndexedLog[]): ClaimRecord[] {
  const who = account.toLowerCase();
  const converterEvents = logs.filter(
    (log) => log.role === 'converter' && String(log.args.holder).toLowerCase() === who && String(log.args.token).toLowerCase() === pair.token.toLowerCase(),
  );
  const out: ClaimRecord[] = [];
  for (const log of logs) {
    if (log.role !== 'ledger' || log.event !== 'Claimed' || String(log.args.account).toLowerCase() !== who) continue;
    const amount = BigInt(String(log.args.amount));
    const recipient = String(log.args.recipient).toLowerCase();
    if (pair.rewardSide === 'Q' || recipient === who) {
      out.push({ blockNumber: BigInt(log.blockNumber), txHash: log.txHash, logIndex: log.logIndex, qConsumed: amount, payoutAsset: 'Q', payout: amount, route: 'claim_q' });
      continue;
    }
    const match = converterEvents.find((event) => event.txHash.toLowerCase() === log.txHash.toLowerCase() && event.logIndex > log.logIndex);
    if (!match) {
      throw new ChainDataError('inconsistent_state', `Claimed event without its converter settlement in ${log.txHash}`);
    }
    if (match.event === 'ClaimConverted') {
      if (BigInt(String(match.args.qIn)) !== amount) throw new ChainDataError('inconsistent_state', `converter qIn differs from the ledger's consumed amount in ${log.txHash}`);
      out.push({ blockNumber: BigInt(log.blockNumber), txHash: log.txHash, logIndex: log.logIndex, qConsumed: amount, payoutAsset: 'T', payout: BigInt(String(match.args.tOut)), route: 'convert_to_t' });
    } else {
      out.push({ blockNumber: BigInt(log.blockNumber), txHash: log.txHash, logIndex: log.logIndex, qConsumed: amount, payoutAsset: 'Q', payout: BigInt(String(match.args.qOut)), route: 'sold_out_q_fallback' });
    }
  }
  return out;
}
