/**
 * Vault snapshot and metrics (v2 docs/03 definitions; UI-03 "S, E, K, A, r, pool reserves, QUSD and valuation basis
 * shown distinctly"; SH-V2-T03). All vault quantities come from ONE block. r, L and K stay exact rationals. USD
 * values are priced estimates with a source, never amounts, and a valuation always names its supply basis.
 *
 * Labels use plain, safe wording (F23 legal): no yield, return or earn framing.
 */
import { computeMarketCapUsd, formatTokenAmount, formatUsdCompact } from '../amounts';
import { CoreModelError } from '../errors';
import type { GuardIssue } from '../guards';
import { isDemoChain } from '../ids';
import type { DecimalAmount } from '../types';
import { formatAmount, formatRatio, ratio, sameAsset, subAmounts, type Amount, type AssetRef, type Ratio } from './amounts';
import { CORE_CHAIN_IDS, parseCollectionId, type AssetId, type ChainId, type CollectionId, type MarketId } from './ids';
import type { PolicyRef } from './policy';

export type Finality = 'pending' | 'confirmed' | 'finalized';

export interface BlockRef {
  readonly chainId: ChainId;
  readonly number: bigint;
  readonly hash: `0x${string}`;
  readonly finality: Finality;
}

const FINALITY_RANK: Readonly<Record<Finality, number>> = { pending: 0, confirmed: 1, finalized: 2 };

export function meetsFinality(actual: Finality, required: Finality): boolean {
  return FINALITY_RANK[actual] >= FINALITY_RANK[required];
}

/** Everything a quote or a metric row needs, read at one block (v2 docs/07 "Amount types and snapshot semantics"). */
export interface VaultSnapshot {
  readonly at: BlockRef;
  /** Where the numbers came from (RPC, indexer, fixture). */
  readonly source: string;
  readonly vaultPolicy: PolicyRef;
  readonly fit: AssetRef;
  readonly collection: CollectionId;
  /** N: eligible Misfits (the edition: 4,200 since F35; v2's examples use 10,000). */
  readonly collectionCount: bigint;
  /** n: Misfits inside the vault. */
  readonly insideCount: bigint;
  readonly initialSupply: Amount;
  /** S: FIT totalSupply. */
  readonly totalSupply: Amount;
  /** E: FIT held by the conversion escrow. */
  readonly escrowFit: Amount;
}

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/** Binding problems: every amount is the snapshot's FIT, one chain, mock data on the demo chain only. */
export function snapshotIssues(snapshot: VaultSnapshot): GuardIssue[] {
  const issues: GuardIssue[] = [];
  const add = (path: (string | number)[], message: string): void => {
    issues.push({ path, message });
  };
  const { fit, at } = snapshot;
  for (const key of ['initialSupply', 'totalSupply', 'escrowFit'] as const) {
    if (!sameAsset(snapshot[key].asset, fit)) add([key], `must be an amount of ${fit.id}`);
  }
  if (fit.standard === 'native') add(['fit'], 'FIT is a token, not the native asset');
  if (fit.standard === 'mock') {
    if (!isDemoChain(at.chainId)) add(['at', 'chainId'], `mock data is only valid on the demo chain ${CORE_CHAIN_IDS.localDemo}`);
  } else if (fit.chainId !== at.chainId) {
    add(['at', 'chainId'], 'the block must be on the FIT chain');
  }
  if (parseCollectionId(snapshot.collection).chainId !== at.chainId) add(['collection'], 'the collection must be on the snapshot chain');
  if (at.number < 0n) add(['at', 'number'], 'block number must be non-negative');
  if (!HASH_PATTERN.test(at.hash)) add(['at', 'hash'], 'block hash must be 32 bytes');
  if (snapshot.collectionCount <= 0n) add(['collectionCount'], 'N must be positive');
  if (snapshot.insideCount < 0n) add(['insideCount'], 'n must be non-negative');
  return issues;
}

export interface VaultMetrics {
  readonly snapshot: VaultSnapshot;
  readonly S: Amount;
  readonly E: Amount;
  /** A = S − E: all FIT outside the conversion escrow (wallets, pools, treasuries and reward balances count). */
  readonly A: Amount;
  /** Initial supply − S: FIT removed by true burns. */
  readonly burned: Amount;
  readonly N: bigint;
  readonly n: bigint;
  readonly m: bigint;
  /** r = A / n, exact; null when n = 0 (undefined, v2 docs/03). */
  readonly r: Ratio | null;
  /** L = m × r: the idealized obligation to outside Misfits. */
  readonly L: Ratio | null;
  /** K = E − L: permanently stuck surplus. Analytical, never a spendable balance. */
  readonly K: Ratio | null;
}

function violation(message: string): CoreModelError {
  return new CoreModelError('invariant_violation', message);
}

/** Exact v2 metrics. Throws `invalid_snapshot` for binding problems and `invariant_violation` for broken identities. */
export function vaultMetrics(snapshot: VaultSnapshot): VaultMetrics {
  const issues = snapshotIssues(snapshot);
  if (issues.length > 0) {
    throw new CoreModelError('invalid_snapshot', `Invalid vault snapshot: ${issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const { totalSupply: S, escrowFit: E, initialSupply, collectionCount: N, insideCount: n } = snapshot;
  if (S.raw > initialSupply.raw) throw violation('S is above the initial supply (no mint after initialization)');
  if (E.raw > S.raw) throw violation('E is above S');
  if (n > N) throw violation('n is above N');
  const A = subAmounts(S, E);
  const m = N - n;
  if (n > 0n && E.raw * n < m * A.raw) throw violation('escrow solvency E × n ≥ m × A does not hold');
  const burned = subAmounts(initialSupply, S);
  if (n === 0n) return Object.freeze({ snapshot, S, E, A, burned, N, n, m, r: null, L: null, K: null });
  const r = ratio(A.raw, n);
  const L = ratio(m * A.raw, n);
  const K = ratio(E.raw * n - m * A.raw, n);
  return Object.freeze({ snapshot, S, E, A, burned, N, n, m, r, L, K });
}

// --- Market data: pool reserves, prices and valuation ------------------------------------------------------------

export interface PoolReserves {
  readonly market: MarketId;
  readonly at: BlockRef;
  readonly fit: Amount;
  readonly q: Amount;
}

/** A USD price per whole unit of one asset, with its source; or an explicit gap. Never zero for "unknown". */
export type UsdPrice =
  | { readonly state: 'observed'; readonly asset: AssetId; readonly usdPerUnit: DecimalAmount; readonly source: string; readonly asOf: string }
  | { readonly state: 'unavailable'; readonly asset: AssetId; readonly reason: string };

/**
 * v2 docs/06 "Valuation semantics": `total_supply` = price × S (includes the escrow; the MVP sort basis, G12);
 * `outside_escrow` = price × (S − E).
 */
export type ValuationBasis = 'total_supply' | 'outside_escrow';

export interface Valuation {
  readonly basis: ValuationBasis;
  readonly supply: Amount;
  readonly price: UsdPrice;
  /** Exact USD, or null when the price is unavailable. */
  readonly usd: DecimalAmount | null;
}

export function valuationOf(metrics: VaultMetrics, basis: ValuationBasis, fitUsd: UsdPrice): Valuation {
  if (fitUsd.asset !== metrics.S.asset.id) throw new CoreModelError('asset_binding', `The valuation needs a price for ${metrics.S.asset.id}`);
  const supply = basis === 'total_supply' ? metrics.S : metrics.A;
  const usd = fitUsd.state === 'observed' ? computeMarketCapUsd(fitUsd.usdPerUnit, supply.raw, supply.asset.decimals) : null;
  return Object.freeze({ basis, supply, price: fitUsd, usd });
}

// --- Metric rows (presentation model for UI-03) -------------------------------------------------------------------

export type MetricKey = 'S' | 'E' | 'A' | 'r' | 'K' | 'n' | 'm' | 'burned' | 'pool_fit' | 'pool_q' | 'q_usd' | 'valuation';

export interface MetricRow {
  readonly key: MetricKey;
  /** Short symbol shown next to the label (v2 docs/03 names). */
  readonly symbol: string;
  readonly label: string;
  /** Display text: truncated, never overstated; "Unavailable…" or "Not defined…" instead of a fake zero. */
  readonly value: string;
  /** False when the display is rounded or estimated. */
  readonly exact: boolean;
  readonly note?: string;
}

const NOT_DEFINED = 'Not defined (no Misfit in the vault)';
const countText = (value: bigint): string => formatTokenAmount(value, 0);

export function vaultMetricRows(metrics: VaultMetrics): MetricRow[] {
  const fit = metrics.S.asset;
  const rational = (value: Ratio | null): Pick<MetricRow, 'value' | 'exact'> =>
    value === null ? { value: NOT_DEFINED, exact: true } : { value: formatRatio(value, fit), exact: value.den === 1n };
  return [
    { key: 'S', symbol: 'S', label: 'FIT total supply', value: formatAmount(metrics.S), exact: true },
    { key: 'E', symbol: 'E', label: 'FIT locked in the vault escrow', value: formatAmount(metrics.E), exact: true },
    { key: 'A', symbol: 'A = S − E', label: 'FIT outside the escrow', value: formatAmount(metrics.A), exact: true, note: 'Wallets, pools and treasuries all count.' },
    { key: 'r', symbol: 'r = A ÷ n', label: 'FIT per Misfit now', ...rational(metrics.r), note: 'The same for every Misfit. Rarity does not change it.' },
    { key: 'K', symbol: 'K', label: 'Stuck surplus in the escrow', ...rational(metrics.K), note: 'It stays in the escrow for good. Nobody can spend it.' },
    { key: 'n', symbol: 'n', label: 'Misfits in the vault', value: countText(metrics.n), exact: true },
    { key: 'm', symbol: 'm = N − n', label: 'Misfits outside the vault', value: countText(metrics.m), exact: true },
    { key: 'burned', symbol: 'burned', label: 'FIT burned since launch', value: formatAmount(metrics.burned), exact: true },
  ];
}

const unavailable = (reason: string): Pick<MetricRow, 'value' | 'exact'> => ({ value: `Unavailable (${reason})`, exact: true });

export interface MarketRowsInput {
  readonly reserves: PoolReserves | null;
  readonly qUsd: UsdPrice;
  readonly valuation: Valuation;
}

export function marketMetricRows({ reserves, qUsd, valuation }: MarketRowsInput): MetricRow[] {
  const qSymbol = reserves?.q.asset.symbol ?? 'Q';
  const noReserves = unavailable('no pool reading');
  const basisLabel =
    valuation.basis === 'total_supply' ? 'Valuation, total supply basis (includes the escrow)' : 'Valuation, FIT outside the escrow';
  return [
    { key: 'pool_fit', symbol: 'pool FIT', label: 'FIT in the pool', ...(reserves ? { value: formatAmount(reserves.fit), exact: true } : noReserves) },
    { key: 'pool_q', symbol: `pool ${qSymbol}`, label: `${qSymbol} in the pool`, ...(reserves ? { value: formatAmount(reserves.q), exact: true } : noReserves) },
    {
      key: 'q_usd',
      symbol: `${qSymbol}/USD`,
      label: `${qSymbol} price in USD`,
      ...(qUsd.state === 'observed' ? { value: formatUsdCompact(qUsd.usdPerUnit), exact: false, note: `Source: ${qUsd.source}, ${qUsd.asOf}` } : unavailable(qUsd.reason)),
    },
    {
      key: 'valuation',
      symbol: valuation.basis === 'total_supply' ? 'price × S' : 'price × A',
      label: basisLabel,
      ...(valuation.usd !== null && valuation.price.state === 'observed'
        ? { value: formatUsdCompact(valuation.usd), exact: false, note: `Price source: ${valuation.price.source}, ${valuation.price.asOf}` }
        : unavailable(valuation.price.state === 'unavailable' ? valuation.price.reason : 'no price')),
    },
  ];
}
