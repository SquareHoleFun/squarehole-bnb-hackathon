/**
 * Pair detail presentation model (SH-012). Amounts stay raw decimal strings until `formatTokenAmount`/`formatUnits`
 * (bigint inside, truncating, never overstating). Unavailable values stay `null` and render as "Not available"
 * (FEED-06). Supply concepts are separate rows and are never added together (FEED-07; 05 "Burn mechanics").
 */
import {
  DEMO_CHAIN_ID,
  formatTokenAmount,
  formatUnits,
  parseRawAmount,
  sameAddress,
  type ActivityAmount,
  type AssetIdentity,
  type CanonicalStatus,
  type FeeTerms,
  type PairActivityKind,
  type PairDetail,
  type PairRecord,
  type RawAmount,
} from '@squarehole/domain';
import { AMOUNT_DIGITS } from '../accounts/amounts';
import { UNSET_SYMBOL, displaySymbol, formatAsOf } from '../feed/format';

/**
 * `chainSource` (SH-C): the pair comes from a chain data source (a real deployment), not the demo fixtures. The domain
 * still labels chain 31337 as the demo chain (D07), so the wording, not the data, says which one is on screen.
 */
export function networkLabel(chainId: number, chainSource = false): string {
  if (chainId === DEMO_CHAIN_ID) return chainSource ? `Local chain ${chainId} (anvil)` : `Local chain ${chainId}`;
  return chainSource && chainId === 11_155_111 ? `Sepolia ${chainId}` : `Chain ${chainId}`;
}

export const CANONICAL_STATUS_TEXT: Readonly<Record<CanonicalStatus, string>> = {
  demo_not_deployed: 'Not an approved factory',
  unverified: 'Unverified contract',
  approved_factory: 'Approved factory launch',
};

/** The status chip: a launch on the local chain is deployed there, but by no approved factory (G08). */
export function canonicalStatusText(status: CanonicalStatus, chainSource = false): string {
  return chainSource && status === 'demo_not_deployed' ? 'Local test deployment · not an approved factory' : CANONICAL_STATUS_TEXT[status];
}

/** "3" for 300 bps, "2.5" for 250 bps: exact, without floating point. */
function bpsAsPercent(bps: number): string {
  return formatUnits(BigInt(bps), 2);
}

/** One-line fee terms readout (D02, D03): "Draft policy: 3% target · native T fees burned · realized Q split 1/3 protocol : 2/3 holders". */
export function feeTermsText(terms: FeeTerms): string {
  const { num, den } = terms.qProtocolShare;
  const status = terms.status === 'draft' ? 'Draft policy' : 'Approved policy';
  return `${status}: ${bpsAsPercent(terms.headlineFeeTargetBps)}% target · native T fees burned · realized Q split ${num}/${den} protocol : ${den - num}/${den} holders`;
}

/** Unit label after an amount; the unset root ticker (D06) reads as plain "T". */
export function amountSymbol(symbol: string): string {
  return symbol === UNSET_SYMBOL ? 'T' : symbol;
}

/** "1,500 ROUND", or null when the raw value or decimals are malformed (never a guessed number). */
export function formatAssetAmount(raw: RawAmount | null, asset: Pick<AssetIdentity, 'decimals' | 'symbol'>, maxFractionDigits?: number): string | null {
  if (raw === null) return null;
  try {
    return `${formatTokenAmount(raw, asset.decimals, { maxFractionDigits })} ${amountSymbol(asset.symbol)}`;
  } catch {
    return null;
  }
}

/** A whole-number count ("260,000"), or null for null or malformed input. */
function formatCount(count: string | number | null): string | null {
  if (count === null) return null;
  try {
    return formatTokenAmount(typeof count === 'number' ? BigInt(count) : count, 0);
  } catch {
    return null;
  }
}

export interface SupplyRow {
  readonly id: 'current' | 'initial' | 'burned' | 'capacity' | 'active' | 'circulating';
  readonly label: string;
  /** Formatted value with its unit, or null = "Not available". */
  readonly value: string | null;
  /** How the value was obtained (basis/rule), always shown. */
  readonly basis: string;
}

const INITIAL_CAP_BASIS: Readonly<Record<PairDetail['supply']['initialCapBasis'], string>> = {
  demo_derived_total_plus_burned: 'Current supply + fee-burned.',
  onchain_initial_supply: 'Economic supply at launch, read from the chain.',
};

/** Local chain source: the same identity, but computed from chain reads (it equals the registry's initial supply). */
const LOCAL_INITIAL_CAP_BASIS = 'Current supply + fee-burned, both read from the local chain; this equals the initial supply the registry recorded.';

// ADR-0012: chain-backed pairs state the ledger's eligible supply (excluded protocol roles removed).
const EXCLUSION_BASIS: Readonly<Record<PairDetail['supply']['exclusionBasis'], string>> = {
  demo_fixture_declared: 'Current supply minus the holdings declared as excluded. Market cap uses this figure.',
  ledger_eligible_supply:
    'Current supply minus the balances of the launch’s excluded protocol roles (pool reserves, hook, fee collector, fee-credit ledger, treasury), read from the fee-credit ledger.',
  unavailable: 'Circulation cannot be established, so market cap is not computed from it.',
};

/** The separate supply concepts. NFT rows appear only for collections; a token has no NFT capacity or count. */
export function supplyRows(detail: PairDetail, pair: PairRecord, chainSource = false): SupplyRow[] {
  const { supply } = detail;
  const t = (raw: RawAmount | null) => formatAssetAmount(raw, pair.token);
  const rows: SupplyRow[] = [
    { id: 'current', label: 'Current economic supply', value: t(supply.currentRaw), basis: 'Post-burn total supply of the token.' },
    {
      id: 'initial',
      label: 'Initial supply cap',
      value: t(supply.initialCapRaw),
      basis: chainSource && supply.initialCapBasis === 'demo_derived_total_plus_burned' ? LOCAL_INITIAL_CAP_BASIS : INITIAL_CAP_BASIS[supply.initialCapBasis],
    },
    {
      id: 'burned',
      label: 'Fee-burned',
      value: t(supply.feeBurnedRaw),
      basis: 'Native fee tokens burned, which lowered total supply. NFT representation changes are not counted.',
    },
    {
      id: 'circulating',
      label: 'Circulating',
      value: t(supply.circulatingRaw),
      basis: EXCLUSION_BASIS[supply.exclusionBasis],
    },
  ];
  if (pair.type === 'nft_collection') {
    const capacity = formatCount(supply.wholeUnitCapacity?.count ?? null);
    const active = formatCount(supply.activeNftCount);
    rows.push(
      {
        id: 'capacity',
        label: 'Whole-NFT capacity',
        value: capacity === null ? null : `${capacity} NFTs at most`,
        basis: 'Current supply ÷ one NFT unit, rounded down. A maximum, not the number of NFTs that exist.',
      },
      {
        id: 'active',
        label: 'Active NFTs',
        value: active === null ? null : `${active} NFTs`,
        basis: chainSource
          ? 'NFTs that exist, counted by the mirror contract. Never derived from supply.'
          : 'NFTs observed on the mirror contract. Never derived from supply.',
      },
    );
  }
  return rows;
}

export interface FractionModel {
  /** Fractions (displayed T units) per NFT, e.g. "1" or "1,000,000". */
  readonly perNft: string;
  readonly symbol: string;
  /** Example balance of 3¼ NFT units, and its split. */
  readonly example: { readonly balance: string; readonly whole: string; readonly fraction: string };
}

/** 1 NFT = r fractions (ADR-0009: unit = r × 10^decimals). Null for tokens or an unusable unit. */
export function fractionModel(detail: PairDetail, pair: PairRecord): FractionModel | null {
  if (pair.type !== 'nft_collection' || !detail.nft) return null;
  try {
    const unit = parseRawAmount(detail.nft.unitRaw);
    if (unit === 0n) return null;
    const decimals = pair.token.decimals;
    return {
      perNft: formatTokenAmount(unit, decimals, { maxFractionDigits: decimals }),
      symbol: amountSymbol(pair.token.symbol),
      example: {
        balance: formatTokenAmount((unit * 13n) / 4n, decimals, { maxFractionDigits: decimals }),
        whole: '3',
        fraction: formatTokenAmount(unit / 4n, decimals, { maxFractionDigits: decimals }),
      },
    };
  } catch {
    return null;
  }
}

export interface RewardRow {
  readonly symbol: string;
  readonly role: string;
  readonly paid: string | null;
  readonly accrued: string | null;
}

/** One row per asset, in that asset's own units; rows are never summed (03-FEED, REFERENCE_OVERRIDES). */
export function rewardRows(detail: PairDetail, pair: PairRecord): RewardRow[] {
  return detail.rewards.map((row) => {
    const isT = sameAddress(row.asset.address, pair.token.address);
    const role = isT
      ? 'Paid out in the pair’s own token, bought with holders’ credited entitlement'
      : pair.rewardSide === 'Q'
        ? 'Credited and paid in the paired asset'
        : 'Credited entitlement, settled in the pair’s own token when claimed';
    return {
      symbol: displaySymbol(row.asset.symbol),
      role,
      // The account figures on the same card (claimable, claimed) truncate to 6 decimals; so do these.
      paid: formatAssetAmount(row.paidRaw, row.asset, AMOUNT_DIGITS),
      accrued: formatAssetAmount(row.accruedRaw, row.asset, AMOUNT_DIGITS),
    };
  });
}

const ACTIVITY_LABELS: Readonly<Record<PairActivityKind, string>> = {
  launch: 'Launch',
  burn: 'Fee burn',
  claim: 'Fee-share claim',
  swap_observation: 'Observed external trade',
};

export interface ActivityRow {
  readonly key: string;
  readonly kind: PairActivityKind;
  readonly label: string;
  readonly at: string;
  readonly when: string;
  readonly block: string;
  readonly amounts: string;
}

function amountsText(amounts: readonly ActivityAmount[]): string {
  const parts = amounts.map((amount) => formatAssetAmount(amount.amountRaw, amount.asset) ?? 'Not available');
  return parts.length > 0 ? parts.join(' · ') : '—';
}

/** Newest first. Demo rows have no transaction hash, so there is nothing to link to (FEED-09, EXT-08). */
export function activityRows(detail: PairDetail): ActivityRow[] {
  return detail.activity
    .map((row, index) => ({
      key: `${row.block}-${index}`,
      kind: row.kind,
      label: ACTIVITY_LABELS[row.kind],
      at: row.at,
      when: formatAsOf(row.at) ?? row.at,
      block: row.block,
      amounts: amountsText(row.amounts),
    }))
    .reverse();
}

/** Stock-like quote wrappers (G06): show the accounting wrapper and its underlying, never a 1:1 price claim. */
export function isWrapperQuote(pair: PairRecord): boolean {
  return pair.quote.underlyingAddress !== undefined;
}

/** "Holder fee share paid in AAPLx-DEMO" (R=Q) or "Holder fee share paid in FRAME, converted from credited WETH-DEMO" (R=T). */
export function payoutText(pair: PairRecord): string {
  const quote = displaySymbol(pair.quote.symbol);
  if (pair.rewardSide === 'Q') return `Holder fee share paid in ${quote}`;
  return `Holder fee share paid in ${amountSymbol(pair.token.symbol)}, converted from credited ${quote}`;
}

/** Internal route for the wallet lane's claim flow. The pair id travels as a query value, never as a URL. */
export function claimHref(pairId: string): string {
  return `/rewards?${new URLSearchParams({ pair: pairId }).toString()}`;
}
