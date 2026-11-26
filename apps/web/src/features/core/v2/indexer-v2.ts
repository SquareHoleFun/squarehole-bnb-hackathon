/** Browser boundary for CQ11-E3's /v2 views. Money is parsed only from decimal strings. */
import { SEPOLIA_PUBLIC_RPC_URLS } from '@squarehole/chain';
import { formatUnits, type Address } from '@squarehole/domain';
import { getAddress, type Hex } from 'viem';
import { readShopConfigV2, type ShopConfigV2 } from './shop-wait';
import { decodeBoxSpecV2, parseCoreManifestV2, rolesOfV2, type BoxRecordV2, type BoxSpecV2, type DeployedCoreManifestV2, type ReleaseV2 } from '../../../../../../packages/chain/src/core/v2';
import { feeChoiceV2, type FeeChoiceV2 } from '../../../../../../packages/indexer/src/core/v2/views-v2';
import { manifestNetworkOf, type CoreBuild } from '../core-build';
import type { Fetcher } from '../core-client';
import { withDeadline } from '../deadline';
import type { DataSourceId } from '../../data-source';
import type { BoxRowV2 } from '../../../../../../packages/indexer/src/core/core-row';
import { parseLinksV2, type ShownLinks } from './box-links';
import { parseM2, type M2Snapshot } from './m2-data';
import { parseM3, parseVaultItems, type M3Snapshot, type VaultInventoryV2 } from './m3-data';
import { parseStatisticsV2, type StatisticsV2 } from './stats-v2';
import { usdPricesOf, type UsdPricesV2 } from './usd-v2';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

export const object = (v: unknown): Record<string, unknown> => { if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('Expected an object'); return v as Record<string, unknown>; };
export const raw = (v: unknown): bigint => { if (typeof v !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(v)) throw new Error('Expected a raw decimal string'); return BigInt(v); };
export const address = (v: unknown): Address => { if (typeof v !== 'string') throw new Error('Expected an address'); return getAddress(v) as Address; };
export const hash = (v: unknown): Hex => { if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error('Expected a hash'); return v as Hex; };
const integer = (v: unknown, max: number): number => { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > max) throw new Error('Invalid integer'); return v; };
const bool = (v: unknown): boolean => { if (typeof v !== 'boolean') throw new Error('Expected a boolean'); return v; };
const array = (v: unknown): unknown[] => { if (!Array.isArray(v)) throw new Error('Expected an array'); return v; };
const amounts = (v: unknown): Readonly<Record<string, bigint>> => Object.fromEntries(Object.entries(object(v)).map(([k, n]) => [address(k).toLowerCase(), raw(n)]));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export interface V2Source {
  readonly network: 'local' | 'sepolia'; readonly manifest: DeployedCoreManifestV2; readonly origin: string; readonly rpc: string;
  /** Where its boxes' pictures are fetched by raw CID (box-pictures.ts); none when the build names none. */
  readonly art?: readonly string[];
  /**
   * SH-ARWEAVE-PICTURES-WEB: its boxes' logo and cover are kept on Arweave (Create publishes them there; pages look
   * them up there, pictures/arweave-*.ts); off when the build says nothing.
   */
  readonly arweave?: boolean;
}
export function sourceV2(id: DataSourceId, build: CoreBuild): V2Source | null {
  if (DEMO_BUILD && id === 'demo') return null;
  const network = id === 'local' ? 'local' : 'sepolia';
  const candidates = build.manifests.filter((m) => object(m).network === manifestNetworkOf(network) && Array.isArray(object(m).releases));
  if (candidates.length === 0) return null;
  if (candidates.length !== 1) throw new Error('Ambiguous v2 deployment');
  const manifest = parseCoreManifestV2(candidates[0]);
  const origin = build.indexers[network];
  if (!origin) throw new Error('V2 indexer unavailable');
  const rpc = network === 'local' ? build.localRpcUrl : SEPOLIA_PUBLIC_RPC_URLS[0];
  if (!rpc) throw new Error('V2 RPC unavailable');
  return { network, manifest, origin, rpc, art: build.artGateways?.[network] ?? [], arweave: build.arweave?.[network] === true };
}
const OWED_KEYS = ['fitOwed', 'platformOwed', 'poolHeldP', 'growHeldP', 'creatorP', 'buyBackP', 'itemsHeldP', 'royaltyHeldP', 'tBurnPending'] as const;
type Owed = Readonly<Record<typeof OWED_KEYS[number], bigint>>;
/** v2.1 step 1: an eat box's receiver at the snapshot hash. `burned`: its creation snapshot recorded a checked burn. */
export interface EatV2 { readonly pendingP: bigint; readonly eatenP: bigint; readonly burned: boolean }
/** v2.1 step 3: fees for the pile, waiting in the receiver and moved into the pile so far (both in P, the pile's coin). */
export interface PileFeesV2 { readonly pendingP: bigint; readonly movedP: bigint }
/** v2.1 step 2: one holder batch paid in T, as its settled tranches add up (`payInTViewV21`). */
export interface HolderBatchTV2 { readonly fundingT: bigint; readonly holderT: bigint; readonly residueT: bigint; readonly paidT: bigint; readonly flushedT: bigint }
/** v2.1 step 2: what fees paid in T bought and where it is; `money` is read at the snapshot hash. */
export interface PayInTV2 {
  readonly history: null | { readonly boughtT: bigint; readonly holdersFundedT: bigint; readonly itemsFundedT: bigint; readonly holdersPaidT: bigint; readonly itemsPaidT: bigint; readonly batches: Readonly<Record<string, HolderBatchTV2>> };
  readonly money: null | { readonly pendingP: bigint; readonly holderBalanceT: bigint; readonly itemBalanceT: bigint; readonly burnPendingT: bigint };
}
/**
 * v2.1 step 7 (ShopT, a shop's sellers only): the shop's fee reads at the snapshot hash and the indexer's history of them.
 * Both are null when unpublished; both are null too when they disagree with each other or with the spec's ceiling,
 * so a figure is never shown from an inconsistent publication.
 */
export interface ShopFeesV2 {
  /** The ceiling's multiple of the seed (2, 4 or 8), from the spec's `ShopDestParams`. */
  readonly preset: 2 | 4 | 8;
  /**
   * `money.shopFees` (readShopFeeStateV21): the sellers' P waiting in the receiver, the live budget, the fixed ceiling,
   * the T fees bought into the shop so far, and the week's decision (`feesWanted`, the live ceiling applies too).
   */
  readonly money: null | { readonly pendingP: bigint; readonly budgetT: bigint; readonly ceilingT: bigint; readonly feesT: bigint; readonly feesWanted: boolean };
  /** `shopFees` (projectShopFeesV21), cumulative from events: P queued for the shop and resolved, P spent on T, T bought. */
  readonly history: null | { readonly queuedP: bigint; readonly resolvedP: bigint; readonly spentP: bigint; readonly boughtT: bigint };
}
/** v2.1 step 8: one fee module side (choice 10) at the snapshot hash: its immutable action snapshot and the P waiting for it. */
export interface ModuleSideV2 { readonly module: Address; readonly codeHash: Hex; readonly pendingP: bigint }
export interface FeeModulesV2 { readonly buyers: ModuleSideV2; readonly sellers: ModuleSideV2 }
/**
 * v2.1 step 8 (`alchemistGrowthV21`): on a coin pile with a module side, the P its conversions spent and the pile coin
 * they delivered, each in its own units, from authenticated events; never seed, gifts or same-coin moves. RC5-B:
 * `dustToDepthP`, the P of steps too small to convert that moved as P claims to the box's own hook for its pool depth
 * (`DustToDepth`), apart from both; null in a publication without it (unavailable, never zero). An older publication's
 * `dustP` (P paid to the FIT Safe before RC5) is never read as depth.
 */
export interface AlchemistV2 { readonly inputP: bigint; readonly receivedAsset: bigint; readonly dustToDepthP: bigint | null }
const modulesOf = (input: unknown): FeeModulesV2 => {
  const m = object(input);
  const side = (v: unknown): ModuleSideV2 => { const s = object(v); return { module: address(s.module), codeHash: hash(s.codeHash), pendingP: raw(s.pendingP) }; };
  return { buyers: side(m.buyers), sellers: side(m.sellers) };
};
const alchemistOf = (input: unknown): AlchemistV2 => { const a = object(input); return { inputP: raw(a.inputP), receivedAsset: raw(a.receivedAsset), dustToDepthP: a.dustToDepthP === undefined ? null : raw(a.dustToDepthP) }; };
/** ShopT's ceiling multiple from the spec (`ShopDestParams(uint8 ceilingPreset)`, a 32-byte word); null for any other side. */
export function shopCeilingPresetV2(spec: Pick<BoxSpecV2, 'sellers'>): 2 | 4 | 8 | null {
  if (feeChoiceV2(spec.sellers) !== 'shop') return null;
  const preset = Number(BigInt(spec.sellers.a.destParams));
  return preset === 2 || preset === 4 || preset === 8 ? preset : null;
}
const MAX_UINT256 = (1n << 256n) - 1n;
function shopFeesOf(historyInput: unknown, moneyInput: unknown, spec: BoxSpecV2, shopConfig: ShopConfigV2 | null): ShopFeesV2 {
  const preset = shopCeilingPresetV2(spec);
  if (preset === null) throw new Error('Invalid shop fee choice');
  let money: ShopFeesV2['money'] = null; let history: ShopFeesV2['history'] = null;
  if (moneyInput != null) {
    const m = object(moneyInput);
    money = { pendingP: raw(m.pendingP), budgetT: raw(m.budgetT), ceilingT: raw(m.ceilingT), feesT: raw(m.feesT), feesWanted: bool(m.feesWanted) };
  }
  if (historyInput != null) {
    const h = object(historyInput);
    history = { queuedP: raw(h.fundedP), resolvedP: raw(h.consumedP), spentP: raw(h.spentP), boughtT: raw(h.boughtT) };
    if (history.resolvedP > history.queuedP || history.spentP > history.resolvedP) throw new Error('Invalid shop fee history');
  }
  // ShopVaultV2.ceilingT is the saturating seed times the preset; the reads and the events agree at one block hash.
  // SH-300: a shop configuration that does not decode (the snapshot's one decode) leaves the fee figures unavailable,
  // never the whole box.
  if (!shopConfig) return { preset, money: null, history: null };
  const seed = shopConfig.seedT;
  const ceiling = seed > MAX_UINT256 / BigInt(preset) ? MAX_UINT256 : seed * BigInt(preset);
  const agree = (money === null || money.ceilingT === ceiling) && (money === null || history === null || (money.pendingP === history.queuedP - history.resolvedP && money.feesT === history.boughtT));
  return agree ? { preset, money, history } : { preset, money: null, history: null };
}
/**
 * RC6 (F138): one sellable-list coin of the box's income inbox, read at the snapshot hash: its raw lot at the box's
 * frozen list version, the inbox's raw balance, when its thirty-day wait started (0: no unsold balance observed) and
 * whether its CoW order is registered. COW-2 (SH-RC6-RR-OFFCHAIN): `belowOneLot`, positive custody below a positive
 * lot, which registers no order and waits for an observation to start its clock; derived in bigint when an older
 * publication lacks it.
 */
export interface InboxCoinV2 {
  readonly coin: Address; readonly lot: bigint; readonly balance: bigint; readonly oldestUnsoldAt: bigint; readonly registered: boolean; readonly belowOneLot: boolean;
  /** SH-RC7-SITE-INBOX: the coin's history as the indexer publishes it; absent in an older publication (unknown, never zero). */
  readonly history?: InboxHistoryV2;
}
/**
 * SH-RC7-SITE-INBOX (INDEXER-INBOX request 1): one inbox coin's history (`money.royalty.coins[]`, SH-RC6-INDEXER-INBOX):
 * its last `OrderRefreshed` and its last CoW `Trade` with this inbox as owner (null: none seen), and four cumulative
 * totals in the coin's raw units: taken in kind (`InKindClaimed`), funded into the receiver (`RoyaltyFunded`; gifts and
 * sale proceeds alike, no proof of a sale), and on the ETH row the native `Flushed` totals (ETH sent on, and of it
 * unwrapped from WETH; apart from funding, never added to it). Every amount and time from a decimal string.
 */
export interface InboxHistoryV2 {
  readonly lastRefresh: null | { readonly balance: bigint; readonly oldestUnsoldAt: bigint; readonly at: bigint };
  readonly lastSale: null | { readonly buyToken: Address; readonly sellAmount: bigint; readonly buyAmount: bigint; readonly feeAmount: bigint; readonly orderUid: Hex; readonly at: bigint; readonly txHash: Hex };
  readonly inKindClaimed: bigint; readonly funded: bigint; readonly flushed: bigint; readonly unwrapped: bigint;
}
const HISTORY_KEYS = ['lastRefresh', 'lastSale', 'inKindClaimed', 'funded', 'flushed', 'unwrapped'] as const;
/** An older publication carries none of the history keys; one that carries any carries all, each well formed. */
function historyOf(c: Record<string, unknown>): InboxHistoryV2 | undefined {
  if (HISTORY_KEYS.every((key) => c[key] === undefined)) return undefined;
  const refresh = c.lastRefresh === null ? null : object(c.lastRefresh);
  const sale = c.lastSale === null ? null : object(c.lastSale);
  if (sale && (typeof sale.orderUid !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(sale.orderUid))) throw new Error('Invalid order uid');
  return {
    lastRefresh: refresh && { balance: raw(refresh.balance), oldestUnsoldAt: raw(refresh.oldestUnsoldAt), at: raw(refresh.at) },
    lastSale: sale && { buyToken: address(sale.buyToken), sellAmount: raw(sale.sellAmount), buyAmount: raw(sale.buyAmount), feeAmount: raw(sale.feeAmount),
      orderUid: sale.orderUid as Hex, at: raw(sale.at), txHash: hash(object(sale.ref).txHash) },
    inKindClaimed: raw(c.inKindClaimed), funded: raw(c.funded), flushed: raw(c.flushed), unwrapped: raw(c.unwrapped),
  };
}
/**
 * The box's income inbox (role 8) at the snapshot hash: the current creator payee, raw balances of ETH (the zero
 * address), WETH, P and T, and the frozen sellable list's coins when published (`complete` false: some coin unread).
 */
export interface InboxV2 {
  readonly router: Address; readonly payee: Address; readonly balances: Readonly<Record<string, bigint>>;
  readonly listVersion: bigint | null; readonly coins: readonly InboxCoinV2[]; readonly complete: boolean;
}
function inboxOf(input: unknown): InboxV2 {
  const r = object(input);
  const coins = r.coins == null ? [] : array(r.coins).map((item) => {
    const c = object(item);
    const lot = raw(c.lot); const balance = raw(c.balance);
    const history = historyOf(c);
    return { coin: address(c.coin), lot, balance, oldestUnsoldAt: raw(c.oldestUnsoldAt), registered: bool(c.registered),
      belowOneLot: c.belowOneLot == null ? lot > 0n && balance > 0n && balance < lot : bool(c.belowOneLot), ...(history ? { history } : {}) };
  });
  return { router: address(r.router), payee: address(r.payee), balances: amounts(r.balances),
    listVersion: r.listVersion == null ? null : raw(r.listVersion), coins, complete: r.coins != null && r.complete !== false };
}
/** The burn selector a checked listing records (`burn(uint256)`); zero locks. */
const BURN_SELECTOR = /^0x42966c68$/i;
export interface V2Snapshot {
  readonly m2?: M2Snapshot;
  /** Every-item payouts or a coin pile (M3-52), when the box has either. */
  readonly m3?: M3Snapshot;
  /**
   * SH-235: the collection vault's inventory, apart from M3 (a box whose fees do not pay its items has no `m3`). Absent
   * when the server does not publish it (or publishes it malformed): the Items card then works as before.
   */
  readonly vaultItems?: VaultInventoryV2;
  readonly claimRow?: BoxRowV2;
  readonly record: BoxRecordV2; readonly spec: BoxSpecV2; readonly release: ReleaseV2;
  /**
   * SH-300: a shop box's configuration, decoded once here for every reader (the shop's fee figures, its panel, its
   * actions); null for any other box, and for a shop whose configuration does not decode (then nothing shows a wait).
   */
  readonly shopConfig: ShopConfigV2 | null;
  readonly token: Address; readonly decimals: number;
  readonly block: bigint; readonly blockHash: Hex; readonly timestamp: bigint;
  readonly stale: boolean; readonly verified: boolean;
  /** False while the indexer has not audited the box yet (`verified: null`, a new box until its next audit). */
  readonly audited: boolean;
  readonly gate: { readonly open: boolean; readonly deadline: bigint; readonly effectiveOpenAt: bigint };
  readonly graduated: boolean; readonly closedAt: bigint;
  readonly failed: { readonly cause: string; readonly at: bigint } | null;
  readonly choices: { readonly buyers: FeeChoiceV2 | null; readonly sellers: FeeChoiceV2 | null };
  /** RC5-C: two fixed Safes; royalties and other income wait in the box's own inbox (null: inbox unread). */
  readonly money: null | { readonly owed: Owed; readonly safes: Readonly<Record<'fit' | 'platform', Address>>; readonly creatorPayee: Address; readonly creatorOwed: bigint; readonly creatorHeld: bigint; readonly inbox: InboxV2 | null };
  readonly buyBack: { readonly pSpent: bigint; readonly tBought: bigint; readonly tBurned: bigint };
  /**
   * The failure claim at the snapshot: the live pot, the coins still counted and the creator's no-buyer remainder (its
   * `quoteClaim(0)`: the failure-time amount plus inbox P added since, INBOX af2).
   * RC5-A (F136): claims never close and nothing is swept, so the view has no FIT sweep figure; an older publication's
   * `sweptToFit` is not read.
   * RC6 (R2-4a): `initialT`, the coins counted at failure (`PotFixed.tLeft`), tells a box nobody bought (0) from one
   * whose last holder has claimed (`tLeft` 0 too); null in an older publication without it, never inferred.
   * RC6-RR-INBOX: `inboxP`, the inbox's P at the money hash that the next claim first moves into the pot; a no-buyer box's
   * `pot` (claimState) already counts it. Null when unknown (an older publication, or a read the chain refused).
   */
  readonly closing: null | { readonly pot: bigint; readonly initialT: bigint | null; readonly tLeft: bigint; readonly creatorEntitlement: bigint; readonly inboxP?: bigint | null };
  /** v2.1, only on boxes with that choice: null when the money read is unavailable. */
  readonly eat?: EatV2 | null;
  readonly pileFees?: PileFeesV2 | null;
  readonly payInT?: PayInTV2;
  /** v2.1 step 7: a shop whose sellers chose Into the shop. */
  readonly shopFees?: ShopFeesV2;
  /** v2.1 step 8, only on boxes with a module side: null when the money read is unavailable. */
  readonly modules?: FeeModulesV2 | null;
  /** v2.1 step 8, a coin pile with a module side: null when unpublished (unavailable, never zero). */
  readonly alchemist?: AlchemistV2 | null;
  readonly safePayments: readonly { readonly kind: string; readonly safe: Address; readonly token: Address; readonly amount: bigint; readonly txHash: Hex }[];
  /**
   * SH-TA-29: the indexer's market statistics (SH-TA-28): price, market cap, raise progress, supply, burned, holders,
   * 24 h volume, trades and hourly candles; null when the publication has none (unknown, never zero).
   */
  readonly statistics?: StatisticsV2 | null;
  /**
   * LINKS-WEB: the Website, X and Telegram the box's creator signed (box-links-v2.md § 4, `links`); null when there are
   * none, and null for any value that is not well formed (never an error: the box shows without them).
   */
  readonly links: ShownLinks | null;
  /**
   * SH-ARWEAVE-PICTURES-WEB: the indexer's Arweave copy of the logo and of the cover (`pictureCopies.{logo,cover}.arweaveId`,
   * SH-ARWEAVE-PICTURES-SRV), each optional; only a hint, since the page checks the bytes against the spec's hash.
   */
  readonly pictureCopies?: { readonly logo?: string; readonly cover?: string };
  /** SH-266: Atlas USD prices of the price coin and the pile coin, as the indexer read them; absent when none is fresh. */
  readonly prices?: UsdPricesV2;
  /**
   * SH-BOX-LIFE-VIEW: the box's own pool position as the indexer publishes it (`position`: the launch curve's ticks and
   * liquidity until graduation, then the full range) and the pool's price (`pool`); null when unpublished or before the
   * pool exists. The page draws the launch curve from the curve's ticks. Display only, like `links`: a value that is not
   * well formed is null, never an error, so the box shows without its curve ("Curve unavailable") and the rest of the feed
   * is untouched.
   */
  readonly position?: PositionV2 | null;
  readonly pool?: { readonly sqrtPriceX96: bigint; readonly tick: number } | null;
  /**
   * SH-255: each side's fees so far in the price coin (`fees.buyersP`, `fees.sellersP`), the base of the 15 parts. Display
   * only, like `position`: null when unpublished or not well formed (unknown, never zero).
   */
  readonly feesP?: { readonly buyers: bigint; readonly sellers: bigint } | null;
  /** SH-255: what the two Safes were paid so far, per coin (`safePaid.fit`, `safePaid.platform`, lower-case keys); null as above. */
  readonly safePaid?: { readonly fit: Readonly<Record<string, bigint>>; readonly platform: Readonly<Record<string, bigint>> } | null;
}
export interface PositionV2 { readonly kind: 'curve' | 'full_range'; readonly tickLower: number; readonly tickUpper: number; readonly liquidity: bigint }
const TICK_LIMIT = 887_272;
const tickOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && Math.abs(v) <= TICK_LIMIT ? v : null);
const rawOrNull = (v: unknown): bigint | null => (typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) ? BigInt(v) : null);
const recordOrNull = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
/**
 * `position` as published (views-v2.ts `BoxViewV2.position`): a curve or the full range, two ticks in v4's bounds, the
 * lower below the upper, and the liquidity as a decimal string. Absent, null or anything else is null.
 */
export function positionOf(input: unknown): PositionV2 | null {
  const p = recordOrNull(input);
  if (!p || (p.kind !== 'curve' && p.kind !== 'full_range')) return null;
  const tickLower = tickOrNull(p.tickLower); const tickUpper = tickOrNull(p.tickUpper); const liquidity = rawOrNull(p.liquidity);
  if (tickLower === null || tickUpper === null || liquidity === null || tickLower >= tickUpper) return null;
  return { kind: p.kind, tickLower, tickUpper, liquidity };
}
/**
 * `pool` as published (`LiveStateV2.pool`): the pool's √price (Q64.96, a positive decimal string) and its tick in v4's
 * bounds. Absent, null or anything else is null.
 */
export function poolOf(input: unknown): V2Snapshot['pool'] {
  const p = recordOrNull(input);
  const sqrtPriceX96 = p ? rawOrNull(p.sqrtPriceX96) : null; const tick = p ? tickOrNull(p.tick) : null;
  return sqrtPriceX96 === null || sqrtPriceX96 === 0n || tick === null ? null : { sqrtPriceX96, tick };
}
const ARWEAVE_ID = /^[A-Za-z0-9_-]{43}$/;
/**
 * `pictureCopies` as the indexer may publish it: `{ logo?: { arweaveId }, cover?: { arweaveId } }`. It is optional and
 * only a hint, so anything else is ignored rather than refusing the box (an older indexer has no such field).
 */
/** SH-255: `fees` as the picture reads it; null for anything not well formed (display only, never an error). */
export function feesPOf(input: unknown): V2Snapshot['feesP'] {
  try { const f = object(input); return { buyers: raw(f.buyersP), sellers: raw(f.sellersP) }; } catch { return null; }
}
/** SH-255: `safePaid` as the picture reads it; null for anything not well formed. */
export function safePaidOf(input: unknown): V2Snapshot['safePaid'] {
  try {
    const paid = object(input);
    const coins = (v: unknown) => Object.fromEntries(Object.entries(object(v)).map(([coin, amount]) => [address(coin).toLowerCase(), raw(amount)]));
    return { fit: coins(paid.fit), platform: coins(paid.platform) };
  } catch { return null; }
}
export function pictureCopiesOf(input: unknown): V2Snapshot['pictureCopies'] {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const idOf = (entry: unknown): string | undefined => {
    const id = entry !== null && typeof entry === 'object' ? (entry as { arweaveId?: unknown }).arweaveId : undefined;
    return typeof id === 'string' && ARWEAVE_ID.test(id) ? id : undefined;
  };
  const logo = idOf((input as { logo?: unknown }).logo);
  const cover = idOf((input as { cover?: unknown }).cover);
  return logo === undefined && cover === undefined ? undefined : { ...(logo ? { logo } : {}), ...(cover ? { cover } : {}) };
}
export function parseSnapshotV2(input: unknown, source: V2Source): V2Snapshot {
  const v = object(input); const row = object(v.row); const r = object(row.record); const asOf = object(v.asOf);
  if (v.schema !== 'sh.core-box.v2' || v.chainId !== source.manifest.chainId || row.chainId !== v.chainId || row.protocol !== 2) throw new Error('Wrong v2 chain or schema');
  const registry = address(row.registry);
  const release = source.manifest.releases.find((r) => same(r.registry.address, registry));
  if (!release) throw new Error('Unknown v2 registry');
  const record: BoxRecordV2 = {
    boxId: raw(r.boxId), templateId: hash(r.templateId), specHash: hash(r.specHash), creator: address(r.creator), pricingListingId: integer(r.pricingListingId, 0xffffffff),
    q: address(r.q), raise: raw(r.raise), poolManager: address(r.poolManager), poolId: hash(r.poolId), creationBlock: raw(r.creationBlock), openAt: raw(r.openAt), randomness: address(r.randomness),
    contracts: array(r.contracts).map(address), codeHashes: array(r.codeHashes).map(hash),
  };
  if (record.contracts.length !== 24 || record.codeHashes.length !== 24) throw new Error('Invalid v2 roles');
  const roles = rolesOfV2(record); const token = address(v.token);
  if (!roles.contracts.token || !same(token, roles.contracts.token) || !same(record.poolManager, source.manifest.chain.poolManager.address)) throw new Error('Wrong box identity');
  if (typeof row.encodedSpec !== 'string' || !/^0x(?:[a-fA-F0-9]{2})*$/.test(row.encodedSpec)) throw new Error('Invalid spec bytes');
  const spec = decodeBoxSpecV2(row.encodedSpec as Hex, record);
  const shopConfig = spec.boxType === 4 ? readShopConfigV2(spec.contentsParams) : null;
  if (spec.format !== 2 || spec.version !== 2 || spec.gradLayout !== 3) throw new Error('Not a CQ11 spec');
  const choices = { buyers: feeChoiceV2(spec.buyers), sellers: feeChoiceV2(spec.sellers) };
  if (!choices.buyers || !choices.sellers) throw new Error('Invalid fee choice');
  const gate = object(v.gate); const back = object(v.buyBack);
  const block = raw(asOf.block); const blockHash = hash(asOf.hash);
  let money: V2Snapshot['money'] = null;
  if (v.money !== null && v.money !== undefined) {
    const m = object(v.money); const owed = object(m.owed); const safes = object(m.safes); const values = object(m.values);
    if (raw(m.block) !== block || !same(hash(m.hash), blockHash)) throw new Error('Money from a different block');
    money = { owed: Object.fromEntries(OWED_KEYS.map((k) => [k, raw(owed[k])])) as Owed, safes: { fit: address(safes.fit), platform: address(safes.platform) }, creatorPayee: address(values['receiver.creatorPayee']), creatorOwed: raw(values['receiver.creatorOwed']), creatorHeld: raw(values['receiver.creatorHeld']), inbox: m.royalty == null ? null : inboxOf(m.royalty) };
  }
  const has = (...wanted: readonly string[]) => wanted.includes(choices.buyers ?? '') || wanted.includes(choices.sellers ?? '');
  const hasM2 = spec.boxType === 4 || has('holders', 'holders-t');
  const m2 = hasM2 ? parseM2(v.m2, v.money == null ? null : object(v.money).m2, blockHash) : undefined;
  const hasM3 = spec.boxType === 5 || has('items', 'items-t');
  const m3 = hasM3 ? parseM3(v.m3, v.money == null ? null : object(v.money).m3, blockHash, spec) : undefined;
  // SH-235: read whatever the fees are; it belongs to the same asOf block as the rest of the card.
  const vaultItems = v.vaultItems === undefined ? null : parseVaultItems(v.vaultItems, spec);
  // The bounded M2/M3 readers take the authenticated row; only boxes with those parts need it.
  const origin = hasM2 || hasM3 ? object(row.origin) : null;
  const claimRow: BoxRowV2 | undefined = origin ? { ...record, ...roles, protocol: 2, chainId: source.manifest.chainId, registry, record, spec, encodedSpec: row.encodedSpec as Hex, release, marks: [], pDecimals: integer(row.pDecimals, 36),
    origin: { blockHash: hash(origin.blockHash), txHash: hash(origin.txHash), logIndex: integer(origin.logIndex, 0xffffffff) } } : undefined;
  const closing = v.closing === null ? null : object(v.closing);
  const failed = v.failed === null ? null : object(v.failed);
  if (failed && typeof failed.cause !== 'string') throw new Error('Invalid failure cause');
  const moneyJson = v.money == null ? null : object(v.money);
  const v21 = {
    ...(has('eat') ? { eat: moneyJson?.eat == null ? null : eatOf(moneyJson.eat) } : {}),
    ...(has('pile') ? { pileFees: moneyJson?.pileFees == null ? null : pileFeesOf(moneyJson.pileFees) } : {}),
    ...(has('holders-t', 'items-t') ? { payInT: payInTOf(v.payInT, moneyJson?.payInT) } : {}),
    ...(choices.sellers === 'shop' ? { shopFees: shopFeesOf(v.shopFees, moneyJson?.shopFees, spec, shopConfig) } : {}),
    ...(has('module') ? { modules: moneyJson?.modules == null ? null : modulesOf(moneyJson.modules) } : {}),
    ...(has('module') && spec.boxType === 5 ? { alchemist: v.alchemist == null ? null : alchemistOf(v.alchemist) } : {}),
  };
  return { ...(m2 ? { m2 } : {}), ...(m3 ? { m3 } : {}), ...(vaultItems ? { vaultItems } : {}), ...(claimRow ? { claimRow } : {}), ...v21, record, spec, release, shopConfig, token, decimals: integer(row.pDecimals, 36), block, blockHash, timestamp: raw(asOf.timestamp), stale: bool(v.stale), verified: v.verified === null ? false : bool(v.verified), audited: v.verified !== null,
    gate: { open: bool(gate.open), deadline: gate.deadline === null ? 0n : raw(gate.deadline), effectiveOpenAt: gate.effectiveOpenAt === null ? 0n : raw(gate.effectiveOpenAt) },
    statistics: parseStatisticsV2(v.statistics), links: parseLinksV2(v.links), position: positionOf(v.position), pool: poolOf(v.pool),
    feesP: feesPOf(v.fees), safePaid: safePaidOf(v.safePaid),
    ...(pictureCopiesOf(v.pictureCopies) ? { pictureCopies: pictureCopiesOf(v.pictureCopies) } : {}),
    ...(usdPricesOf(v.prices) ? { prices: usdPricesOf(v.prices) } : {}),
    graduated: bool(v.graduated), closedAt: raw(v.closedAt), failed: failed ? { cause: failed.cause as string, at: raw(failed.at) } : null, choices, money,
    buyBack: { pSpent: raw(back.pSpent), tBought: raw(back.tBought), tBurned: raw(back.tBurned) },
    closing: closing && money ? { pot: raw(closing.pot), initialT: closing.initialT == null ? null : raw(closing.initialT), tLeft: raw(closing.tLeft), creatorEntitlement: raw(closing.creatorEntitlement),
      inboxP: closing.inboxP == null ? null : raw(closing.inboxP) } : null,
    safePayments: array(v.safePayments).map((item) => { const p = object(item); const ref = object(p.ref); if (!['fit', 'platform'].includes(String(p.kind))) throw new Error('Invalid Safe payment'); return { kind: p.kind as string, safe: address(p.safe), token: address(p.token), amount: raw(p.amount), txHash: hash(ref.txHash) }; }),
  };
}
function eatOf(input: unknown): EatV2 {
  const e = object(input);
  if (typeof e.burnSelector !== 'string' || !/^0x(?:00000000|42966c68)$/i.test(e.burnSelector)) throw new Error('Invalid burn selector');
  return { pendingP: raw(e.pendingP), eatenP: raw(e.eatenP), burned: BURN_SELECTOR.test(e.burnSelector) };
}
const pileFeesOf = (input: unknown): PileFeesV2 => { const f = object(input); return { pendingP: raw(f.pendingP), movedP: raw(f.movedP) }; };
function payInTOf(historyInput: unknown, moneyInput: unknown): PayInTV2 {
  let history: PayInTV2['history'] = null; let money: PayInTV2['money'] = null;
  if (historyInput != null) {
    const h = object(historyInput);
    const batches = Object.fromEntries(Object.entries(object(h.batches)).map(([id, value]) => {
      const b = object(value); const batch = { fundingT: raw(b.fundingT), holderT: raw(b.holderT), residueT: raw(b.residueT), paidT: raw(b.paidT), flushedT: raw(b.flushedT) };
      if (raw(id) === 0n || batch.holderT + batch.residueT !== batch.fundingT || batch.paidT > batch.holderT || batch.flushedT > batch.residueT) throw new Error('Invalid T batch');
      return [id, batch];
    }));
    history = { boughtT: raw(h.boughtT), holdersFundedT: raw(h.holdersFundedT), itemsFundedT: raw(h.itemsFundedT), holdersPaidT: raw(h.holdersPaidT), itemsPaidT: raw(h.itemsPaidT), batches };
  }
  if (moneyInput != null) {
    const m = object(moneyInput);
    money = { pendingP: raw(m.pendingP), holderBalanceT: raw(m.holderBalanceT), itemBalanceT: raw(m.itemBalanceT), burnPendingT: raw(m.burnPendingT) };
  }
  return { history, money };
}
/**
 * LINKS-WEB fix round 2 (F4): one read of the feed as the site polls it, numbered in the order reads start (one counter
 * for the page), so a box creator's save can tell a read that started after its POST completed (it holds the save)
 * from one already under way or cached. By default it never answers from the browser's HTTP cache (the feed is
 * `public, max-age=1`): a read that starts later is a request that reaches the server later.
 */
export interface FeedReadV2 {
  /** This read's place in the order reads started (1, 2, …). */
  readonly read: number;
  readonly snapshots: readonly V2Snapshot[];
}
let feedReads = 0;
/** How many feed reads have started so far: every later read has a higher number. */
export const feedReadsStarted = (): number => feedReads;
const feedFetch: Fetcher = (url, init) => fetch(url, { cache: 'no-cache', ...(init?.signal ? { signal: init.signal } : {}) });
/**
 * SH-SITE-FIXES-10: a feed answer (headers and body) that has not come within this long counts as no answer: its
 * request is aborted and the read fails, so the query's retry asks again instead of waiting on it for the page's life.
 */
export const FEED_DEADLINE_MS = 8_000;
export async function readFeedV2(source: V2Source, fetcher: Fetcher = feedFetch): Promise<FeedReadV2> {
  const read = ++feedReads;
  return { read, snapshots: await loadFeedV2(source, fetcher) };
}
/** The one query key of a source's feed (useV2Feed and the card after Create share it, and its data shape). */
export const feedKeyV2 = (source: Pick<V2Source, 'network' | 'manifest' | 'origin'> | null) =>
  ['v2-feed', source?.network, source?.manifest.chainId, source?.origin] as const;
export async function loadFeedV2(source: V2Source, fetcher: Fetcher = fetch): Promise<readonly V2Snapshot[]> {
  const v = await withDeadline(FEED_DEADLINE_MS, undefined, async (deadline) => {
    const reply = await fetcher(`${source.origin}/v2/feed?chain=${source.manifest.chainId}`, { signal: deadline });
    if (!reply.ok) throw new Error('V2 feed unavailable');
    return object(await reply.json());
  });
  if (v.schema !== 'sh.core-feed.v2' || v.chainId !== source.manifest.chainId) throw new Error('Wrong v2 feed');
  return array(v.cards).map((card) => parseSnapshotV2(card, source));
}
/** P per whole coin, retaining 18 extra decimal places exactly like E3; no division when exhausted. */
/** The indexer audits every 32 blocks, so a new box is audited within two periods of its creation block. */
export const CHECKING_BLOCKS = 64n;
/**
 * "Checking": the indexer has not audited this box yet because it is new. An older box without an audit (one that
 * could not run, or threw) is Unverified, never Checking.
 */
export const checkingV2 = (view: Pick<V2Snapshot, 'audited' | 'block' | 'record'>): boolean =>
  !view.audited && view.block >= view.record.creationBlock && view.block - view.record.creationBlock <= CHECKING_BLOCKS;
export const claimPriceV2 = (pot: bigint, tLeft: bigint, decimals: number): string | null => tLeft > 0n ? formatUnits(pot * 10n ** 36n / tLeft, decimals + 18) : null;
