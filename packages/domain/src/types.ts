/**
 * Shared domain contract. Ported from square-hole-handoff/reference/domain.ts.
 * Extensions are marked "ADR-0003" (see docs/decisions/0003-feed-contract-extensions.md).
 * Not a generated ABI and not a production contract interface.
 */
export type Address = `0x${string}`;
export type TxHash = `0x${string}`;
/** Unsigned decimal integer string, validated before bigint conversion. */
export type RawAmount = string;
/** Non-negative decimal string (e.g. USD "600000.00"). Never parsed through Number. */
export type DecimalAmount = string;
export type RewardSide = 'T' | 'Q';
export type AssetKind = 'token' | 'nft_collection';
export type Lifecycle = 'curve' | 'graduating' | 'amm' | 'unlaunched';
export type DataState = 'mock' | 'fresh' | 'stale' | 'partial' | 'unavailable';
export type RouteState = 'unverified' | 'available' | 'unavailable';
export type FeedSort = 'market_cap' | 'new' | 'turnover';
export type Coverage = 'demo' | 'canonical_markets' | 'partial' | 'declared_venues';

export interface AssetIdentity {
  chainId: number;
  address: Address;
  symbol: string;
  decimals: number;
  issuerStatus: 'mock' | 'verified' | 'unverified';
  underlyingAddress?: Address;
  wrapperVersion?: string;
}

export interface Provenance {
  state: DataState;
  asOf: string;
  blockNumber?: string;
  blockHash?: TxHash;
  source: string;
  coverage: Coverage;
}

/** Canonical pair id: `${chainId}:${lowercase or checksummed pair address}`. */
export type PairId = `${number}:${Address}`;

export interface PairRecord {
  pairId: PairId;
  chainId: number;
  /** ADR-0003: present in feed.schema.json, absent from reference/domain.ts. Display only, never identity. */
  slug?: string;
  name: string;
  symbol: string;
  type: AssetKind;
  isPlatform: boolean;
  launchedAt: string;
  lifecycle: Lifecycle;
  token: AssetIdentity;
  quote: AssetIdentity;
  mirrorAddress?: Address;
  nftUnitRaw?: RawAmount;
  rewardSide: RewardSide;
  totalSupplyRaw: RawAmount;
  circulatingSupplyRaw: RawAmount | null;
  burnedRaw: RawAmount;
  priceUsd: DecimalAmount | null;
  marketCapUsd: DecimalAmount | null;
  turnover24hUsd: DecimalAmount | null;
  holders: number | null;
  routeState: RouteState;
  provenance: Provenance;
}

export interface FeedQuery {
  search: string;
  sort: FeedSort;
  type: 'all' | AssetKind;
  /** ADR-0003: docs/03 requires a lifecycle filter; reference/domain.ts omitted it. */
  lifecycle: 'all' | Lifecycle;
  /** ADR-0003: filter by payout side (e.g. "pays in its own token"). */
  rewardSide?: RewardSide;
  /** Exact reward-asset address (the selected payout asset: T when R=T, Q when R=Q). */
  rewardAddress?: Address;
  cursor?: string;
  snapshotId?: string;
  limit: number;
}

export interface FeedSnapshot {
  snapshotId: string;
  /** Platform pin, outside filtered organic results, ranks and counts (FEED-01). */
  platform: PairRecord | null;
  /** ADR-0003: whether the pinned platform item itself matches the current search/filters. */
  platformMatchesQuery: boolean;
  items: PairRecord[];
  nextCursor: string | null;
  /** ADR-0003: organic matches in the whole snapshot for this query (platform excluded). */
  totalMatches: number;
  /** ADR-0003: reward assets available for the reward filter, derived from the whole snapshot. */
  rewardAssets: AssetIdentity[];
  provenance: Provenance;
}

export interface FeeReceipt {
  receiptId: string;
  pairId: PairId;
  nativeFeeTRaw: RawAmount;
  nativeFeeQRaw: RawAmount;
  earningCheckpoint: { blockNumber: string; txHash: TxHash; logIndex: number };
}

export interface ClaimView {
  owner: Address;
  pairId: PairId;
  /** Must equal the pair's immutable `rewardSide` (ECO-04; enforced by `claimViewIssues`). */
  rewardSide: RewardSide;
  /** ADR-0008: lifetime earned Q = `claimableQRaw + claimedQRaw` (enforced). Not "what you can claim now". */
  earnedQRaw: RawAmount;
  /** Q not yet harvested/recognised. NOT claimable; always labelled separately (03-FEED, 05-ECONOMICS). */
  pendingHarvestQRaw: RawAmount;
  /** R=Q: equals `claimableQRaw`. R=T: `convertibleEstimate.payoutRaw`, or null without a current quote. */
  estimatedPayoutRaw: RawAmount | null;
  payoutAsset: AssetIdentity;
  estimateAsOf?: string;
  conversionAvailable: boolean;
  directSourceFallbackAvailable: boolean;
  provenance: Provenance;
  /** ADR-0008: earned and unclaimed Q, on-chain-backed (floor of the exact entitlement; never overstated). */
  claimableQRaw: RawAmount;
  /** ADR-0008: cumulative Q consumed by settled claims (Q units, whatever the payout asset was). */
  claimedQRaw: RawAmount;
  /** ADR-0008: R=T only. Null for R=Q, when conversion is unavailable, or when the quote has expired. */
  convertibleEstimate: ConvertibleEstimate | null;
  /** ADR-0008: block the entitlement was read at (decimal string). */
  asOfBlock: string;
  /** ADR-0008: settled and reverted claim attempts, oldest first. */
  history: ClaimHistoryEntry[];
  /**
   * ADR-0008: the published emergency settlement (R=T only) when conversion is unavailable: the earned Q is paid
   * directly. Present exactly when `directSourceFallbackAvailable` is true; always labelled as a fallback.
   */
  directSourceFallback: DirectSourceFallback | null;
}

/** ADR-0003 (SH-004): identity and time of the newest snapshot a provider can serve. */
export interface SnapshotHead {
  snapshotId: string;
  asOf: string;
}

export interface FeedProvider {
  readFeed(query: FeedQuery, signal?: AbortSignal): Promise<FeedSnapshot>;
  readPair(pairId: PairId, signal?: AbortSignal): Promise<PairRecord | null>;
  /**
   * ADR-0003 (SH-004), optional: newest snapshot head, so the UI can offer "Ranking updated" (03-FEED) without
   * reordering the rows on screen. Reads that pass the old `FeedQuery.snapshotId` keep the old stable ordering.
   */
  latestSnapshot?(signal?: AbortSignal): Promise<SnapshotHead>;
  /**
   * ADR-0008 (SH-012), optional: read-only pair detail. `null` for an unknown pair id (including the same address
   * on another chain); a malformed id rejects with `IdentityError`.
   */
  readPairDetail?(pairId: PairId, signal?: AbortSignal): Promise<PairDetail | null>;
}

export interface AccountProvider {
  readClaim(pairId: PairId, account: Address, signal?: AbortSignal): Promise<ClaimView>;
  /** ADR-0008 (SH-014): current economic holdings (positive balances only). A read failure is never an empty list. */
  listPositions(account: Address, signal?: AbortSignal): Promise<AccountPositions>;
  /** ADR-0008 (SH-014): claims with any earned, claimed or pending-harvest Q, including zero-balance past holdings (ECO-05). */
  listClaims(account: Address, signal?: AbortSignal): Promise<AccountClaims>;
}

export interface ExternalDestination {
  kind: 'execution' | 'discovery' | 'explorer';
  provider: string;
  state: RouteState;
  href: string | null;
  chainId: number;
  assetAddress: Address;
  reason?: string;
  validatedAt?: string;
}

export interface ExternalLinkProvider {
  destinations(pair: PairRecord): readonly ExternalDestination[];
}

// No TradingProvider, buildSwapTransaction, general swap endpoint, or execution widget.
// Creation and claim transaction adapters must be generated from reviewed contracts.

// ---------------------------------------------------------------------------------------------------------------
// M2/M3 contract (ADR-0008). Additive: nothing above was removed or renamed. The transaction state machine types
// live next to their reducer in tx-state.ts.
// ---------------------------------------------------------------------------------------------------------------

/** Unsigned decimal integer string for a count derived from raw amounts (e.g. whole NFT units). Never a JS number. */
export type UnitCount = string;

/** BURN_NATIVE_T_ROUTE_Q_V1 terms as shown to users (values come from policy.ts; validators require equality). */
export interface FeeTerms {
  policyId: 'BURN_NATIVE_T_ROUTE_Q_V1';
  status: 'draft' | 'approved';
  headlineFeeTargetBps: number;
  qProtocolShare: { num: number; den: number };
}

// --- Pair detail (SH-012) ---------------------------------------------------------------------------------------

export type ArtworkUnavailableReason = 'not_uploaded' | 'failed_validation' | 'not_loaded';
/** Presentation only; never identity (AGENTS.md: images are not authority). `artId` names a reviewed local asset. */
export type ArtworkRef = { state: 'ok'; artId: string } | { state: 'unavailable'; reason: ArtworkUnavailableReason };

/**
 * `demo_not_deployed`: fixture data, nothing deployed (every demo record). `approved_factory`: a launch record from
 * the approved factory (live only, after G08). `unverified`: an address that is not from the approved factory.
 */
export type CanonicalStatus = 'demo_not_deployed' | 'unverified' | 'approved_factory';

export type InitialCapBasis = 'demo_derived_total_plus_burned' | 'onchain_initial_supply';
/**
 * `ledger_eligible_supply` (ADR-0012, chain data): current supply minus the balances of the launch ledger's immutable
 * excluded roles (pool reserves in the PoolManager, hook, collector, ledger, treasury, converter, launcher, T, mirror;
 * ADR-0010 "Exclusions"), read from `RewardLedger.eligibleSupply()`.
 */
export type SupplyExclusionBasis = 'demo_fixture_declared' | 'ledger_eligible_supply' | 'unavailable';

/** Separate supply concepts (05-ECONOMICS "Burn mechanics"; FEED-07). NFT and fungible supply are never summed. */
export interface PairSupply {
  /** Current post-burn economic T supply (= `PairRecord.totalSupplyRaw`). */
  currentRaw: RawAmount;
  /** Initial economic cap; in demo derived as current + fee-burned and labelled by `initialCapBasis`. */
  initialCapRaw: RawAmount;
  initialCapBasis: InitialCapBasis;
  /** Genuine fee-origin T burns that reduced totalSupply (= `PairRecord.burnedRaw`). NFT sync burns excluded (ECO-11). */
  feeBurnedRaw: RawAmount;
  /** NFT pairs only: floor(current / unit). A maximum whole-unit CAPACITY, never an active NFT count. */
  wholeUnitCapacity: { count: UnitCount; basis: 'floor_current_supply_over_unit' } | null;
  /** Materialized NFTs observed on the mirror. `null` = unavailable; never derived from supply. */
  activeNftCount: number | null;
  /** Circulating economic T (= `PairRecord.circulatingSupplyRaw`); null when circulation cannot be established. */
  circulatingRaw: RawAmount | null;
  /** The published exclusion rule behind `circulatingRaw` ('unavailable' exactly when it is null). */
  exclusionBasis: SupplyExclusionBasis;
}

export interface NftAttribute {
  trait: string;
  value: string;
}

export interface NftGalleryItem {
  /** uint256 token id as a decimal string. */
  tokenId: UnitCount;
  artId: string | null;
  name: string;
  attributes: NftAttribute[];
}

export interface PairNftDetail {
  mirrorAddress: Address;
  unitRaw: RawAmount;
  /** A sample of NFTs for display; its length is not an NFT count. */
  gallery: NftGalleryItem[];
}

export type PriceHistoryUnavailableReason = 'demo_no_history' | 'unpriced' | 'not_indexed';
/** A `null` price is an explicit gap (no observation), never zero (FEED-10). */
export interface PricePoint {
  t: string;
  priceUsd: DecimalAmount | null;
}
export type PriceHistory =
  | { state: 'unavailable'; reason: PriceHistoryUnavailableReason }
  | { state: 'observed'; unit: 'usd_per_t'; points: PricePoint[] };

/** Per payout asset, in that asset's own units. Rows are never summed across assets (03-FEED). `null` = unavailable. */
export interface RewardTotal {
  asset: AssetIdentity;
  paidRaw: RawAmount | null;
  accruedRaw: RawAmount | null;
}

export type PairActivityKind = 'launch' | 'burn' | 'claim' | 'swap_observation';
export interface ActivityAmount {
  asset: AssetIdentity;
  amountRaw: RawAmount;
}
/** Demo activity carries `txHash: null` (no fake explorer links, FEED-09/EXT-08). */
export interface PairActivity {
  kind: PairActivityKind;
  at: string;
  block: string;
  txHash: TxHash | null;
  amounts: ActivityAmount[];
}

export interface PairDetail {
  pairId: PairId;
  description: string;
  artwork: ArtworkRef;
  canonicalStatus: CanonicalStatus;
  /** Intended showcase launch (C14: ORCHARD). Never implies deployment or issuer endorsement. */
  showcase: boolean;
  supply: PairSupply;
  /** Present exactly for `nft_collection` pairs. */
  nft?: PairNftDetail;
  priceHistory: PriceHistory;
  rewards: RewardTotal[];
  /** Oldest first. */
  activity: PairActivity[];
  feeTerms: FeeTerms;
  provenance: Provenance;
}

// --- Accounts and claims (SH-014, SH-015) -----------------------------------------------------------------------

/** One economic balance, shown once, with its whole-collectible representation beneath (01-PRODUCT Portfolio). */
export interface Position {
  pairId: PairId;
  balanceRaw: RawAmount;
  /** NFT pairs: floor(balance / unit). Token pairs: null. */
  wholeNftCount: UnitCount | null;
  /** NFT pairs: balance mod unit (not ownership of a particular NFT). Token pairs: null. */
  fractionalRaw: RawAmount | null;
  /** NFT ids held (at most `wholeNftCount`; fewer for skip-NFT accounts). Empty for token pairs. */
  nftTokenIds: UnitCount[];
}

export interface AccountPositions {
  owner: Address;
  asOfBlock: string;
  positions: Position[];
  provenance: Provenance;
}

export interface AccountClaims {
  owner: Address;
  asOfBlock: string;
  claims: ClaimView[];
  provenance: Provenance;
}

/**
 * R=T only: estimated T for converting the whole claimable Q entitlement. Not a trade: no user amount, no target, no
 * calldata. `minPayoutRaw = floor(payoutRaw x (10000 - toleranceBps) / 10000)` with the fixed draft tolerance.
 */
export interface ConvertibleEstimate {
  payoutRaw: RawAmount;
  /** T per Q in display units (decimal string). */
  tPerQ: DecimalAmount;
  /**
   * `demo_quote`: mock. ADR-0012 (chain data): `v4_quoter_eth_call` = the canonical Uniswap V4Quoter simulating the
   * conversion's exact-input swap; `converter_eth_call` = an eth_call of the holder's own whole-entitlement
   * `claimAsT` where no V4Quoter exists (local chain). Both are reads; nothing is signed.
   */
  source: 'demo_quote' | 'v4_quoter_eth_call' | 'converter_eth_call';
  asOfBlock: string;
  deadline: string;
  minPayoutRaw: RawAmount;
  toleranceBps: number;
}

export interface ClaimHistoryEntry {
  at: string;
  block: string;
  /** Q entitlement consumed; '0' for a reverted attempt (ECO-07). */
  qConsumedRaw: RawAmount;
  payoutRaw: RawAmount;
  payoutAsset: AssetIdentity;
  outcome: 'settled' | 'reverted';
  reason?: string;
}

export interface DirectSourceFallback {
  label: 'emergency_direct_source_q';
  payoutAsset: AssetIdentity;
  payoutRaw: RawAmount;
}

// --- Asset registry (M2 step 1; G06) ----------------------------------------------------------------------------

/** ADR-0012: `supported_testnet` = admitted by a testnet registry template (Sepolia only); not a G06 admission. */
export type AssetAdmission = 'supported_demo' | 'supported_testnet' | 'rejected';
interface AssetRegistryEntryBase {
  /** Exact identity; `AssetIdentity` semantics are unchanged. */
  asset: AssetIdentity;
  /** Display grouping only (e.g. "Demo stablecoin"); never authority. */
  issuerFamily?: string;
  provenance: Provenance;
}
export type AssetRegistryEntry =
  | (AssetRegistryEntryBase & { admission: 'supported_demo' | 'supported_testnet' })
  | (AssetRegistryEntryBase & { admission: 'rejected'; rejection: { gate: 'G06'; reason: string } });

export interface AssetRegistryProvider {
  /** Admitted quote assets for the chain (empty for an unsupported chain). */
  listSupportedQuotes(chainId: number, signal?: AbortSignal): Promise<AssetRegistryEntry[]>;
  /** Exact chain + address lookup. Unknown addresses return null and never become approved. */
  readAsset(chainId: number, address: Address, signal?: AbortSignal): Promise<AssetRegistryEntry | null>;
}

// --- Launch draft and templates (SH-009) ------------------------------------------------------------------------

/**
 * Mirrors square-hole-handoff/schemas/launch.schema.json with three ADR-0008 deviations: `nftUnitRaw` exists only for
 * `nft_collection` drafts, the optional `description` (01-PRODUCT Step 2) is added, and the optional `collectionSize`
 * (F08 / ADR-0009, ADR-0008 addendum) is added. Not deployment authorization.
 */
export interface LaunchDraft {
  schemaVersion: '1.0';
  mode: 'demo' | 'live';
  chainId: number;
  assetType: AssetKind;
  name: string;
  symbol: string;
  description?: string;
  quoteAddress: Address;
  rewardSide: RewardSide;
  feePolicyId: 'BURN_NATIVE_T_ROUTE_Q_V1';
  feePolicyStatus: 'draft' | 'approved';
  headlineFeeTargetBps: number;
  qProtocolShareNumerator: number;
  qProtocolShareDenominator: number;
  /** nft_collection only: `r × 10^18` with r = fractions per NFT, a power of ten from 1 to 10^9 (ADR-0009). */
  nftUnitRaw?: RawAmount;
  /**
   * nft_collection only: collection size N in whole NFTs, with N × r ≤ 10^9 (F08; ADR-0008 addendum). The wizard always
   * writes it; pre-F08 drafts such as the handoff fixture omit it.
   */
  collectionSize?: RawAmount;
  metadataManifestHash: TxHash | null;
  rootTokenAddress: Address | null;
  rootNFTAddress: Address | null;
  externalRouteState: RouteState;
  productionAuthorized: boolean;
}

/** Step 3 review readout for a protocol-owned template. No field is creator-editable. */
export interface LaunchTemplate {
  templateId: string;
  label: string;
  approved: false;
  assetKinds: AssetKind[];
  supplyCap: string;
  curve: string;
  /** Demo denomination for nft_collection (01-PRODUCT: one displayed T = one NFT-equivalent unit, 18 decimals). */
  nftUnitRaw: RawAmount;
  adminPowers: string[];
  feeTerms: FeeTerms;
}
