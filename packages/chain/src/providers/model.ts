/**
 * The chain read model: what the domain `PairRecord` cannot carry (it is USD-only and schema-strict) but the chain
 * knows exactly: the pool mid price in Q, market cap and FDV in Q units, turnover in Q, holder and burn bases, and the
 * disclosures that belong to a pair's quote. Every value states its basis; unavailable values say why.
 */
import { DEMO_CLAIM_TOLERANCE_BPS, LAUNCH_TEXT_RULES, textIssue, type AssetIdentity, type DecimalAmount, type Provenance, type RawAmount } from '@squarehole/domain';
import type { Address } from 'viem';
import { LOCAL_CHAIN_ID, SEPOLIA_CANONICAL_QUOTES, SEPOLIA_TESTNET_CHAIN_ID } from '../config/chains';
import type { DeploymentManifest } from '../config/manifest';

/**
 * Documented tolerance of the R = T conversion minimum (ADR-0012): minTOut = floor(quote × (10,000 − 100) / 10,000),
 * i.e. 1% below an eth_call quote of the same conversion. It equals the domain's fixed draft tolerance (the claim
 * validator requires exactly this value) and the SH-B2 local run (quote − 1%); it is not a user setting.
 */
export const CHAIN_CLAIM_TOLERANCE_BPS: number = DEMO_CLAIM_TOLERANCE_BPS;

export type QuoteKind = 'local_mock' | 'testnet_mock_usdt' | 'canonical_testnet' | 'square_hole_launch' | 'other';

export interface QuoteClass {
  readonly kind: QuoteKind;
  readonly issuerStatus: AssetIdentity['issuerStatus'];
  /** Display grouping only; never authority. */
  readonly family: string | null;
  readonly disclosures: readonly string[];
}

export const USDT_TEST_DISCLOSURES = Object.freeze([
  'USDT-TEST is Square Hole’s own testnet mock of USDT, not a Tether token, and has no value.',
  'Its owner (the testnet deployer key) can pause it, blacklist senders and destroy a blacklisted account’s balance, including the shared Uniswap v4 PoolManager’s: that would leave every USDT-TEST pool and holder claim unbacked.',
  'USDT-TEST supply comes only from a capped public faucet (up to 10,000 per call, once per hour per address, 1,000,000,000 in total); it can run dry and is never refilled.',
]);

export const TESTNET_KEY_DISCLOSURE =
  'On this testnet a single deployer key is the registry admin, the treasury of every launch and the USDT-TEST owner (ADR-0011 §9).';

export const NOT_AUDITED_DISCLOSURE = 'Square Hole contracts are not audited. Test deployment only: test tokens have no value.';

const same = (a: string | undefined, b: string): boolean => a !== undefined && a.toLowerCase() === b.toLowerCase();

/**
 * Classifies a quote asset by EXACT address against the deployment manifest (never by symbol). "Canonical" is decided
 * by the address itself: only Sepolia's canonical WETH9 / Circle USDC (research § 2.1) are called canonical, whatever
 * a manifest entry is keyed or labelled; any other WETH / USDC entry is an unclassified asset.
 */
export function classifyQuote(manifest: DeploymentManifest, address: Address): QuoteClass {
  const { contracts } = manifest;
  if (same(contracts.USDT?.address, address) && contracts.USDT?.contract.startsWith('MockTetherUSD')) {
    return { kind: 'testnet_mock_usdt', issuerStatus: 'mock', family: 'Square Hole testnet mock (USDT-TEST)', disclosures: [...USDT_TEST_DISCLOSURES, TESTNET_KEY_DISCLOSURE] };
  }
  for (const [label, entry, canonical] of [
    ['WETH', contracts.WETH, SEPOLIA_CANONICAL_QUOTES.WETH9],
    ['USDC', contracts.USDC, SEPOLIA_CANONICAL_QUOTES.USDC],
  ] as const) {
    if (!entry || !same(entry.address, address)) continue;
    if (/LOCAL mock/i.test(entry.contract)) return { kind: 'local_mock', issuerStatus: 'mock', family: `Local test stand-in (${label})`, disclosures: [] };
    // SH-258: Sepolia's WETH9 and USDC are Sepolia's identities: compared on Sepolia's own chain id, never the slot's.
    if (manifest.chainId !== SEPOLIA_TESTNET_CHAIN_ID || !same(canonical, address)) continue;
    return {
      kind: 'canonical_testnet',
      issuerStatus: 'unverified',
      family: label === 'WETH' ? 'Canonical WETH9 (testnet)' : 'Circle USDC (testnet)',
      disclosures: [],
    };
  }
  for (const launch of Object.values(manifest.launches)) {
    if (same(launch.contracts.token.address, address)) {
      return { kind: 'square_hole_launch', issuerStatus: 'unverified', family: 'Square Hole launch token', disclosures: [] };
    }
  }
  return { kind: 'other', issuerStatus: manifest.chainId === LOCAL_CHAIN_ID ? 'mock' : 'unverified', family: null, disclosures: [] };
}

/** A symbol-like label derived from the address, used when on-chain text fails the display rules. */
export function addressLabel(address: Address): string {
  return `TOKEN-${address.slice(2, 8).toUpperCase()}`;
}

/**
 * On-chain name/symbol are untrusted creator text (AGENTS.md: names are not authority). Text that fails the launch
 * text rules (control characters, bidi overrides, surrounding whitespace, length) is NOT shown; an address-derived
 * label is shown instead and the record says so.
 */
export function displayText(name: string, symbol: string, token: Address): { name: string; symbol: string; replaced: boolean } {
  const nameOk = textIssue(name, LAUNCH_TEXT_RULES.name) === null;
  const symbolOk = textIssue(symbol, LAUNCH_TEXT_RULES.symbol) === null;
  return {
    name: nameOk ? name : `Unnamed launch ${token.slice(0, 6)}…${token.slice(-4)}`,
    symbol: symbolOk ? symbol : addressLabel(token),
    replaced: !nameOk || !symbolOk,
  };
}

export function displayQuoteSymbol(symbol: string, address: Address): string {
  return textIssue(symbol, LAUNCH_TEXT_RULES.symbol) === null ? symbol : addressLabel(address);
}

export type Metric<T> = ({ readonly available: true } & T) | { readonly available: false; readonly reason: string };

/** Chain-derived market view of one pair at one block (Q units; USD only through a disclosed policy). */
export interface ChainPairMarket {
  readonly pairId: string;
  readonly chainId: number;
  readonly block: { readonly number: string; readonly hash: string; readonly timestamp: string };
  readonly quote: AssetIdentity & { readonly kind: QuoteKind; readonly family: string | null };
  /** Pool mid price from slot0 (not an execution quote; excludes the 3% LP fee). */
  readonly priceQPerT: Metric<{ readonly display: DecimalAmount; readonly num: string; readonly den: string; readonly basis: 'pool_mid_price_slot0' }>;
  /** floor(price × ledger-eligible supply) in raw Q (market cap on the published exclusion rule, ADR-0010). */
  readonly marketCapQRaw: Metric<{ readonly value: RawAmount; readonly basis: 'mid_price_x_ledger_eligible_supply' }>;
  /** floor(price × current post-burn supply) in raw Q: labelled FDV, never shown as market cap. */
  readonly fdvQRaw: Metric<{ readonly value: RawAmount; readonly basis: 'mid_price_x_current_supply' }>;
  readonly turnover24hQ: Metric<{
    readonly totalRaw: RawAmount;
    readonly protocolRaw: RawAmount;
    readonly otherRaw: RawAmount;
    readonly swaps: number;
    readonly windowStart: string;
    readonly windowEnd: string;
    readonly basis: 'canonical_pool_swaps_q_leg_rolling_24h';
  }>;
  readonly holders: Metric<{ readonly count: number; readonly basis: 'transfer_replay_positive_eligible_balances' }>;
  readonly supply: {
    readonly initialRaw: RawAmount;
    readonly currentRaw: RawAmount;
    readonly eligibleRaw: RawAmount;
    readonly burnedRaw: RawAmount;
    readonly burnBasis: 'initial_minus_current_supply';
    /** The collector's lifetime burn counter; equals burnedRaw when the books reconcile. */
    readonly collectorBurnedRaw: RawAmount;
    /** Σ FeeTBurned events from the index, or null when the index does not cover the block. */
    readonly burnEventsRaw: RawAmount | null;
    readonly burnReconciled: boolean;
  };
  readonly usd: { readonly policy: string; readonly priceUsd: DecimalAmount | null; readonly reason: string | null };
  /** R = T only: the pool range is sold out (the labelled direct-Q fallback applies; never selected automatically). */
  readonly soldOut: boolean | null;
  readonly lpFeePips: number;
  readonly poolStateSource: 'state_view' | 'pool_manager_extsload';
  readonly textReplaced: boolean;
  readonly disclosures: readonly string[];
  /**
   * The pair record's provenance (same block): `stale` when the snapshot is served from memory during an RPC outage or
   * is older than the chain's wall-clock rule, `partial` when index-derived figures are unavailable. Consumers show it.
   */
  readonly provenance: Provenance;
}
