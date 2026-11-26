/**
 * Read-only pair detail from chain state and the log index (SH-012 contract; 05-ECONOMICS "Burn mechanics"). Supply
 * concepts stay separate; the gallery is empty because no reviewed metadata source exists for chain launches (their
 * tokenURIs are creator-hosted and untrusted; none are fetched here); activity comes only from indexed logs.
 */
import {
  DRAFT_FEE_TERMS,
  validatePairDetail,
  type ActivityAmount,
  type PairActivity,
  type PairDetail,
  type RewardTotal,
} from '@squarehole/domain';
import { LOCAL_CHAIN_ID } from '../config/chains';
import { conversionTotals } from '../indexer/metrics';
import type { IndexedLog } from '../indexer/store';
import { isoFromSeconds, type ChainContext } from './context';
import type { SnapshotEntry } from './snapshot';

/** Validator bound on activity rows; the launch row is always kept, then the newest rows. */
export const MAX_ACTIVITY_ROWS = 1000;

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function activityRows(ctx: ChainContext, entry: SnapshotEntry, blockNumber: bigint): { rows: PairActivity[]; truncated: boolean } {
  const { pair, token, quote } = entry;
  const local = ctx.config.chainId === LOCAL_CHAIN_ID;
  const t = (amount: bigint): ActivityAmount => ({ asset: token, amountRaw: amount.toString() });
  const q = (amount: bigint): ActivityAmount => ({ asset: quote, amountRaw: amount.toString() });
  const row = (kind: PairActivity['kind'], log: IndexedLog, amounts: ActivityAmount[]): PairActivity | null => {
    const at = ctx.indexer.blockTimestamp(BigInt(log.blockNumber));
    if (at === null) return null;
    // Chain 31337 is the local demo chain: no transaction hash is shown there (FEED-09 / EXT-08, no explorer exists).
    return { kind, at: isoFromSeconds(at), block: log.blockNumber, txHash: local ? null : log.txHash, amounts };
  };
  // The R = T converter's own pool swaps are reward conversions, already listed once as their ClaimConverted claim row
  // (same rule as the protocol share of turnover, indexer/metrics.ts): never also an "observed external trade".
  const converter = pair.converter?.toLowerCase() ?? null;
  const rows: PairActivity[] = [];
  for (const log of ctx.indexer.logsOf(pair.pairId, blockNumber, ['PairCreated', 'FeeTBurned', 'Claimed', 'ClaimConverted', 'ClaimPaidInQSoldOut', 'Swap'])) {
    let next: PairActivity | null = null;
    if (log.event === 'PairCreated' && log.role === 'registry') next = row('launch', log, [t(pair.initialSupply)]);
    else if (log.event === 'FeeTBurned' && log.role === 'collector') next = row('burn', log, [t(BigInt(String(log.args.amount)))]);
    else if (log.event === 'Claimed' && log.role === 'ledger' && pair.rewardSide === 'Q') next = row('claim', log, [q(BigInt(String(log.args.amount)))]);
    else if (log.event === 'ClaimConverted' && log.role === 'converter') next = row('claim', log, [q(BigInt(String(log.args.qIn))), t(BigInt(String(log.args.tOut)))]);
    else if (log.event === 'ClaimPaidInQSoldOut' && log.role === 'converter') next = row('claim', log, [q(BigInt(String(log.args.qOut)))]);
    else if (log.event === 'Swap' && log.role === 'pool_manager' && (converter === null || String(log.args.sender).toLowerCase() !== converter)) {
      const amount0 = BigInt(String(log.args.amount0));
      const amount1 = BigInt(String(log.args.amount1));
      const [tLeg, qLeg] = pair.tIsCurrency0 ? [amount0, amount1] : [amount1, amount0];
      next = row('swap_observation', log, [q(abs(qLeg)), t(abs(tLeg))]);
    }
    if (next) rows.push(next);
  }
  const launch = rows.findIndex((candidate) => candidate.kind === 'launch');
  if (launch > 0) rows.unshift(...rows.splice(launch, 1));
  if (rows.length <= MAX_ACTIVITY_ROWS) return { rows, truncated: false };
  const [first, ...rest] = rows;
  return { rows: [...(first ? [first] : []), ...rest.slice(-(MAX_ACTIVITY_ROWS - 1))], truncated: true };
}

export async function buildPairDetail(ctx: ChainContext, entry: SnapshotEntry): Promise<PairDetail> {
  const { pair, record, state, token, quote } = entry;
  const blockNumber = state.block.number;
  const local = ctx.config.chainId === LOCAL_CHAIN_ID;
  const baseURI = await ctx.reader.baseURI(pair, blockNumber);
  const totals = entry.indexed ? conversionTotals(ctx.indexer, pair, blockNumber) : null;
  const rewards: RewardTotal[] = [
    { asset: quote, paidRaw: state.ledger.totalClaimed.toString(), accruedRaw: state.ledger.totalHolderQReceived.toString() },
  ];
  if (pair.rewardSide === 'T') rewards.push({ asset: token, paidRaw: totals ? totals.tPaidRaw.toString() : null, accruedRaw: null });
  const activity = entry.indexed ? activityRows(ctx, entry, blockNumber) : { rows: [], truncated: false };
  const unit = pair.fractionsPerNft * 10n ** 18n;
  const detail: PairDetail = {
    pairId: pair.pairId,
    description: '',
    artwork: { state: 'unavailable', reason: baseURI === '' ? 'not_uploaded' : 'not_loaded' },
    // The local chain is the demo chain (D07): its records are demo_not_deployed by rule. A testnet launch from the
    // manifest's registry is not a production-approved factory (G08): unverified.
    canonicalStatus: local ? 'demo_not_deployed' : 'unverified',
    showcase: false,
    supply: {
      currentRaw: record.totalSupplyRaw,
      initialCapRaw: pair.initialSupply.toString(),
      // On chain the initial supply is a registry fact; on the demo chain the validator requires the demo label,
      // and the identity it checks (initial = current + fee-burned) holds exactly on chain as well.
      initialCapBasis: local ? 'demo_derived_total_plus_burned' : 'onchain_initial_supply',
      feeBurnedRaw: record.burnedRaw,
      wholeUnitCapacity: pair.mirror ? { count: (state.totalSupply / unit).toString(), basis: 'floor_current_supply_over_unit' } : null,
      activeNftCount: state.activeNftCount === null ? null : Number(state.activeNftCount),
      circulatingRaw: record.circulatingSupplyRaw,
      exclusionBasis: record.circulatingSupplyRaw === null ? 'unavailable' : 'ledger_eligible_supply',
    },
    ...(pair.mirror ? { nft: { mirrorAddress: pair.mirror, unitRaw: unit.toString(), gallery: [] } } : {}),
    priceHistory: { state: 'unavailable', reason: 'unpriced' },
    rewards,
    activity: activity.rows,
    feeTerms: { ...DRAFT_FEE_TERMS, qProtocolShare: { ...DRAFT_FEE_TERMS.qProtocolShare } },
    provenance: record.provenance,
  };
  return validatePairDetail(detail, record, { asOf: record.provenance.asOf, mode: local ? 'demo' : 'live' });
}
