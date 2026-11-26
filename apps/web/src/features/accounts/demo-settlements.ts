/**
 * Demo settlement ledger (SH-015 part 2; ECO-05, ECO-07). The mock account provider serves a fixed fixture, so a claim
 * that the mock executor "finalizes" would otherwise still read as claimable and could be claimed again. This ledger
 * plays the chain's part for the demo: a finalized claim consumes the whole claimable entitlement once, appends a
 * settled history entry, and (for R=T or a T payout) credits the paid T to the owner's position.
 *
 * DEMO ONLY and in memory: it lives for this browser tab (a reload restarts the demo) and never leaves the page. In
 * Stage C the chain records the settlement and the account provider simply re-reads it; this module is not used there.
 * Blocks and times follow the demo block clock (block n = genesis + 12 s x n), so history stays ordered.
 */
import {
  canonicalPairId,
  formatIsoUtc,
  isRawAmount,
  parseIsoTimestamp,
  sameAddress,
  splitWholeUnits,
  type AccountClaims,
  type AccountPositions,
  type AccountProvider,
  type Address,
  type AssetIdentity,
  type AssetKind,
  type ClaimView,
  type PairId,
  type Position,
  type Provenance,
  type RawAmount,
  type TxHash,
} from '@squarehole/domain';
import { DEMO_BLOCK_CLOCK } from '@squarehole/providers';

export interface DemoTokenCredit {
  readonly type: AssetKind;
  /** NFT pairs: the fixed NFT unit, so the credited balance splits into whole NFTs and a fraction. */
  readonly nftUnitRaw: RawAmount | null;
}

export interface DemoSettlement {
  readonly owner: Address;
  readonly pairId: PairId;
  /** The whole claimable Q entitlement at request time (a claim settles all of it; there is no user amount). */
  readonly qConsumedRaw: RawAmount;
  readonly payoutRaw: RawAmount;
  readonly payoutAsset: AssetIdentity;
  /** Present when the payout is the pair's own T (R=T conversion): it is added to the owner's position. */
  readonly tokenCredit: DemoTokenCredit | null;
  /** Block of the finalized demo transaction. */
  readonly block: string;
  readonly hash: TxHash;
}

export interface DemoSettlementLedger {
  /** Records a finalized demo claim; false when the same owner, pair and hash were already recorded. */
  record(settlement: DemoSettlement): boolean;
  forOwner(owner: Address): readonly DemoSettlement[];
}

const GENESIS_MS = parseIsoTimestamp(DEMO_BLOCK_CLOCK.genesis);
const BLOCK_MS = DEMO_BLOCK_CLOCK.blockSeconds * 1000;
/** Keeps block-to-time conversion inside safe integers (a presentation timestamp, not an amount). */
const MAX_DEMO_BLOCK = 10n ** 9n;

/** ISO time of a demo block, or null for a malformed or out-of-range block number. */
export function demoBlockTime(block: string): string | null {
  if (!isRawAmount(block) || BigInt(block) > MAX_DEMO_BLOCK) return null;
  return formatIsoUtc(GENESIS_MS + Number(block) * BLOCK_MS);
}

const keyOf = (settlement: Pick<DemoSettlement, 'owner' | 'pairId' | 'hash'>): string =>
  `${settlement.owner.toLowerCase()}|${canonicalPairId(settlement.pairId)}|${settlement.hash.toLowerCase()}`;

export function createDemoSettlementLedger(): DemoSettlementLedger {
  const recorded = new Map<string, DemoSettlement>();
  return {
    record(settlement) {
      const key = keyOf(settlement);
      if (recorded.has(key) || !isRawAmount(settlement.qConsumedRaw) || BigInt(settlement.qConsumedRaw) === 0n) return false;
      if (demoBlockTime(settlement.block) === null) return false;
      recorded.set(key, Object.freeze({ ...settlement }));
      return true;
    },
    forOwner(owner) {
      return [...recorded.values()].filter((settlement) => sameAddress(settlement.owner, owner));
    },
  };
}

const samePairId = (a: string, b: string): boolean => canonicalPairId(a) === canonicalPairId(b);
const maxBlock = (a: string, b: string): string => (BigInt(b) > BigInt(a) ? b : a);

/** The newest settlement block, when it is after `asOfBlock`: the read moves to that block. */
function readBlockAfter(asOfBlock: string, settlements: readonly DemoSettlement[]): string | null {
  if (!isRawAmount(asOfBlock) || settlements.length === 0) return null;
  const newest = settlements.reduce((block, settlement) => maxBlock(block, settlement.block), asOfBlock);
  return newest === asOfBlock ? null : newest;
}

function advancedProvenance(provenance: Provenance, block: string): Provenance {
  return {
    ...provenance,
    asOf: demoBlockTime(block) ?? provenance.asOf,
    blockNumber: block,
    source: `${provenance.source} + claims settled in this tab`,
  };
}

/** One claim with the owner's settlements for its pair applied (whole entitlement consumed once). */
export function applySettlementsToClaim(claim: ClaimView, settlements: readonly DemoSettlement[]): ClaimView {
  const mine = settlements.filter((settlement) => sameAddress(settlement.owner, claim.owner) && samePairId(settlement.pairId, claim.pairId));
  let claimable = BigInt(claim.claimableQRaw);
  let claimed = BigInt(claim.claimedQRaw);
  const history = [...claim.history];
  for (const settlement of [...mine].sort((a, b) => (BigInt(a.block) < BigInt(b.block) ? -1 : BigInt(a.block) > BigInt(b.block) ? 1 : 0))) {
    const consumed = BigInt(settlement.qConsumedRaw) < claimable ? BigInt(settlement.qConsumedRaw) : claimable;
    const at = demoBlockTime(settlement.block);
    if (consumed === 0n || at === null) continue;
    claimable -= consumed;
    claimed += consumed;
    history.push({
      at,
      block: settlement.block,
      qConsumedRaw: consumed.toString(),
      payoutRaw: settlement.payoutRaw,
      payoutAsset: settlement.payoutAsset,
      outcome: 'settled',
    });
  }
  if (history.length === claim.history.length) return claim;
  const base: ClaimView = { ...claim, claimableQRaw: claimable.toString(), claimedQRaw: claimed.toString(), history };
  if (claim.rewardSide === 'Q') return { ...base, estimatedPayoutRaw: claimable.toString() };
  if (claimable > 0n) return base;
  // Nothing left to convert: no estimate and no emergency fallback (both describe a claimable entitlement).
  const { estimateAsOf: _dropped, ...rest } = base;
  void _dropped;
  return { ...rest, convertibleEstimate: null, estimatedPayoutRaw: null, directSourceFallbackAvailable: false, directSourceFallback: null };
}

export function applySettlementsToClaims(account: AccountClaims, settlements: readonly DemoSettlement[]): AccountClaims {
  const mine = settlements.filter((settlement) => sameAddress(settlement.owner, account.owner));
  const block = readBlockAfter(account.asOfBlock, mine);
  if (block === null) return account;
  const provenance = advancedProvenance(account.provenance, block);
  return {
    ...account,
    asOfBlock: block,
    provenance,
    claims: account.claims.map((claim) => ({ ...applySettlementsToClaim(claim, mine), asOfBlock: block, provenance })),
  };
}

function credited(position: Position | undefined, pairId: PairId, amount: bigint, credit: DemoTokenCredit): Position {
  const balance = BigInt(position?.balanceRaw ?? '0') + amount;
  const unit = credit.nftUnitRaw !== null && isRawAmount(credit.nftUnitRaw) ? BigInt(credit.nftUnitRaw) : 0n;
  if (credit.type === 'token' || unit === 0n) {
    return { pairId: position?.pairId ?? pairId, balanceRaw: balance.toString(), wholeNftCount: null, fractionalRaw: null, nftTokenIds: [] };
  }
  const { whole, fraction } = splitWholeUnits(balance, unit);
  // Ids of newly materialised NFTs are not known to the demo; fewer ids than whole units is allowed (skip-NFT rules).
  return {
    pairId: position?.pairId ?? pairId,
    balanceRaw: balance.toString(),
    wholeNftCount: whole.toString(),
    fractionalRaw: fraction.toString(),
    nftTokenIds: [...(position?.nftTokenIds ?? [])],
  };
}

export function applySettlementsToPositions(account: AccountPositions, settlements: readonly DemoSettlement[]): AccountPositions {
  const mine = settlements.filter((settlement) => sameAddress(settlement.owner, account.owner));
  const block = readBlockAfter(account.asOfBlock, mine);
  if (block === null) return account;
  const positions = [...account.positions];
  for (const settlement of mine) {
    const amount = BigInt(settlement.payoutRaw);
    if (settlement.tokenCredit === null || amount === 0n) continue;
    const index = positions.findIndex((position) => samePairId(position.pairId, settlement.pairId));
    const next = credited(index >= 0 ? positions[index] : undefined, settlement.pairId, amount, settlement.tokenCredit);
    if (index >= 0) positions[index] = next;
    else positions.push(next);
  }
  return { ...account, asOfBlock: block, provenance: advancedProvenance(account.provenance, block), positions };
}

/** The provider's reads with this tab's demo settlements applied (the "demo chain" after the claim finalized). */
export function withDemoSettlements(provider: AccountProvider, ledger: DemoSettlementLedger): AccountProvider {
  return {
    async readClaim(pairId, account, signal) {
      const claims = await provider.readClaim(pairId, account, signal);
      const wrapped = applySettlementsToClaims(
        { owner: claims.owner, asOfBlock: claims.asOfBlock, claims: [claims], provenance: claims.provenance },
        ledger.forOwner(claims.owner),
      );
      return wrapped.claims[0] ?? claims;
    },
    async listPositions(account, signal) {
      const positions = await provider.listPositions(account, signal);
      return applySettlementsToPositions(positions, ledger.forOwner(positions.owner));
    },
    async listClaims(account, signal) {
      const claims = await provider.listClaims(account, signal);
      return applySettlementsToClaims(claims, ledger.forOwner(claims.owner));
    },
  };
}
