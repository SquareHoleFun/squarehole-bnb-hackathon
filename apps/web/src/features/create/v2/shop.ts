/**
 * A shop on the Contents step (box type SHOP, M2; F83 J2/J3, F91 R17L, F132): four fixed give tiers in the box's own
 * coin T, the pick multiple, the weekly limits for the whole shop and for each collection, how long a new entry waits,
 * the curator and the starting collections with their tiers. Field 30 is `abi.encode(ShopConfigV2)`, encoded with the
 * chain package's own parameters (`shopConfigV2Parameters`), so the chain package's `shopConfigV2` reads it back.
 *
 * Only the presets the factory accepts are offered: ShopVaultV2.initialize and the generated validator's `checkShop`
 * take exactly these (shop.test.ts checks both, and box-spec.v2.json's `shop` entry). The budget is T only: the seed,
 * what picks pay in and, when the sellers' side chooses Into the shop (v2.1 step 7, recipes.ts), fees up to a ceiling
 * fixed at Create. The seed is pulled from the creator after Create, before the box opens, so
 * it comes from the creator's first buy; a nonzero seed needs the starter set's loader (add-on 8).
 *
 * SH-SHOP-CREATE: the starter set is the creator's own items of the starting collections, typed as ids per collection
 * ("1, 2, 5-9"): none, or 10 to 10,000 in all (IStarterSetLoaderV2). Add-on 8 commits their ordered hash and count;
 * after Create each item is approved to the shop and the loader pulls it (ShopVaultV2 `loadStarter`: the creator must
 * own it then). The curator may be none: ShopConfigV2's zero curator, a fixed list nobody can add to.
 */
import { ISSUANCE } from '@squarehole/box-spec';
import { formatUnits, type Address } from '@squarehole/domain';
import { encodeAbiParameters, getAddress, isAddress, keccak256, zeroHash, type Hex } from 'viem';
import { shopConfigV2Parameters } from '../../../../../../packages/chain/src/core/v2';
import { parseEthText } from '../create-model';
import { CONTROL, MESSAGES } from '../reason-copy';
import type { AddOnV2 } from './spec-types';

export const SHOP_PICK_BPS = Object.freeze([12_500, 15_000, 20_000, 30_000] as const);
export const SHOP_WEEKLY_BPS = Object.freeze([500, 1_000] as const);
export const SHOP_COLLECTION_BPS = Object.freeze([100, 250, 500] as const);
export const SHOP_LIST_DELAY_DAYS = Object.freeze([7, 14, 30] as const);
export const SHOP_TIER_COUNT = 4;
export const SHOP_MAX_COLLECTIONS = 64;
export type ShopPickBps = (typeof SHOP_PICK_BPS)[number];
export type ShopWeeklyBps = (typeof SHOP_WEEKLY_BPS)[number];
export type ShopCollectionBps = (typeof SHOP_COLLECTION_BPS)[number];
export type ShopListDelayDays = (typeof SHOP_LIST_DELAY_DAYS)[number];
/** A collection's give tier, 0 to 3 on the wire (shown as Tier 1 to Tier 4). */
export type ShopTier = 0 | 1 | 2 | 3;
export const SHOP_TIERS: readonly ShopTier[] = Object.freeze([0, 1, 2, 3]);
/** T's fixed issuance (raw): no seed or give price can be more than every coin the box has. */
export const T_SUPPLY = ISSUANCE;
const DAY = 86_400;

/** IStarterSetLoaderV2: a starter set is empty, or holds 10 to 10,000 items. */
export const SHOP_STARTER_MIN = 10;
export const SHOP_STARTER_MAX = 10_000;

/** One starting collection: its address as typed, its tier and the creator's starter ids in it, as typed. */
export interface ShopRow {
  readonly address: string;
  readonly tier: ShopTier;
  /** Starter item ids of this collection ("1, 2, 5-9"); empty or absent: none. */
  readonly ids?: string;
}

/** The curator: 'creator' (the connected wallet, the default), 'address' (`curatorAddress`, a Safe say) or 'none' (zero: a fixed list). */
export type ShopCurator = 'creator' | 'address' | 'none';

export interface ShopChoice {
  /** The seed in T, as typed (18 decimals). */
  readonly seed: string;
  /** The four give prices in T, cheapest first, as typed. */
  readonly prices: readonly [string, string, string, string];
  readonly pickBps: ShopPickBps;
  readonly weeklyBps: ShopWeeklyBps;
  readonly collectionBps: ShopCollectionBps;
  readonly listDelayDays: ShopListDelayDays;
  readonly curator: ShopCurator;
  readonly curatorAddress: string;
  readonly collections: readonly ShopRow[];
}

/**
 * A new shop: picks at 2x, gives capped at 10% of the budget a week and 2.5% per collection, new entries after 7 days
 * (the Junkyard's settings, F83 J2/J3, F91 R17L), the creator as curator, one empty collection row and nothing typed.
 */
export const newShop = (): ShopChoice => ({
  seed: '',
  prices: ['', '', '', ''],
  pickBps: 20_000,
  weeklyBps: 1_000,
  collectionBps: 250,
  listDelayDays: 7,
  curator: 'creator',
  curatorAddress: '',
  collections: [{ address: '', tier: 0, ids: '' }],
});

/** "2x", "1.25x": a pick multiple in words. */
export const pickText = (bps: number): string => `${formatUnits(BigInt(bps), 4)}x`;
/** "10%", "2.5%": a limit in words. */
export const bpsPercent = (bps: number): string => `${formatUnits(BigInt(bps), 2)}%`;

/** A typed amount of T in raw units: null when it is not a plain number with at most 18 places or is above the supply. */
export function tOf(text: string): bigint | null {
  const raw = parseEthText(text, 18);
  return raw === null || raw > T_SUPPLY ? null : raw;
}

/** ShopVaultV2 `collectionTerms`: a pick costs the give price times the multiple, rounded up (FullMath.mulDivRoundingUp). */
export const pickPriceOf = (giveT: bigint, pickBps: number): bigint => (giveT * BigInt(pickBps) + 9_999n) / 10_000n;

/**
 * An address as typed: checksummed when it is one, else null (an empty row, a typo, a name). SH-254: a typed address
 * in mixed case must pass its checksum (a mistyped digit then shows, instead of being repaired into another address
 * for good); all in lower case or all in upper case stays accepted. A wallet's own answer is repaired at the wallet's
 * edge instead (packages/chain eip1193.ts `parseAccounts`): a person's typing is checked.
 */
export function addressOf(text: string): Address | null {
  const trimmed = text.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return null;
  const hex = trimmed.slice(2);
  const oneCase = hex === hex.toLowerCase() || hex === hex.toUpperCase();
  return oneCase || isAddress(trimmed, { strict: true }) ? (getAddress(trimmed.toLowerCase()) as Address) : null;
}

const ZERO = '0x0000000000000000000000000000000000000000' as Address;

/** IShopVaultV2 `ShopConfigV2`, member by member (raw T; listDelay in seconds; tiers 0 to 3). */
export interface ShopConfig {
  readonly seedT: bigint;
  readonly givePricesT: readonly [bigint, bigint, bigint, bigint];
  readonly pickBps: number;
  readonly weeklyBps: number;
  readonly collectionBps: number;
  readonly listDelay: number;
  readonly curator: Address;
  readonly collections: readonly Address[];
  readonly tiers: readonly number[];
}

/**
 * The curator these choices name: the connected wallet for 'creator', zero for 'none' (a fixed list), the typed address
 * otherwise; null when neither is known.
 */
export const curatorOf = (shop: Pick<ShopChoice, 'curator' | 'curatorAddress'>, owner: Address | null): Address | null =>
  shop.curator === 'creator' ? owner : shop.curator === 'none' ? ZERO : addressOf(shop.curatorAddress);

/**
 * The config these choices build: always encodable, so the hash and the preview never throw. A field that does not
 * parse builds as zero (an amount, an address) and v2Issues refuses it, as the pile's seed does.
 */
export function shopConfigOf(shop: ShopChoice, owner: Address | null): ShopConfig {
  const price = (i: number) => tOf(shop.prices[i] ?? '') ?? 0n;
  return {
    seedT: tOf(shop.seed) ?? 0n,
    givePricesT: [price(0), price(1), price(2), price(3)],
    pickBps: shop.pickBps,
    weeklyBps: shop.weeklyBps,
    collectionBps: shop.collectionBps,
    listDelay: shop.listDelayDays * DAY,
    curator: curatorOf(shop, owner) ?? ZERO,
    collections: shop.collections.map((row) => addressOf(row.address) ?? ZERO),
    tiers: shop.collections.map((row) => row.tier),
  };
}

/** Field 30 of a shop: abi.encode(ShopConfigV2), the chain package's own encoding. */
export const shopParamsOf = (config: ShopConfig): Hex =>
  encodeAbiParameters(shopConfigV2Parameters, [{
    seedT: config.seedT,
    givePricesT: [...config.givePricesT] as [bigint, bigint, bigint, bigint],
    pickBps: config.pickBps,
    weeklyBps: config.weeklyBps,
    collectionBps: config.collectionBps,
    listDelay: config.listDelay,
    curator: config.curator,
    collections: [...config.collections],
    tiers: [...config.tiers],
  }]);

/** One starter item: a starting collection, an id in it and that collection's tier (IStarterSetLoaderV2's terms). */
export interface StarterItem {
  readonly collection: Address;
  readonly id: bigint;
  readonly tier: ShopTier;
}

const UINT256_MAX = (1n << 256n) - 1n;
const ID_TEXT = /^(0|[1-9][0-9]{0,77})$/;

/**
 * Typed starter ids, in typed order: decimal ids and ranges "5-9" (low end first), in comma groups, each holding ids
 * separated by spaces or new lines; [] for a field blank throughout. 'format' when a part is no id (or a range runs
 * down) or a comma group is empty or blank (",", "1-9,", "1,,2", "1, ,2"), 'many' past SHOP_STARTER_MAX.
 */
export function idsOf(text: string): readonly bigint[] | 'format' | 'many' {
  if (text.trim() === '') return [];
  const groups = text.split(',');
  if (groups.some((group) => group.trim() === '')) return 'format';
  const parts = groups.flatMap((group) => group.replace(/\s*-\s*/g, '-').trim().split(/\s+/));
  const ids: bigint[] = [];
  const id = (part: string): bigint | null => {
    if (!ID_TEXT.test(part)) return null;
    const value = BigInt(part);
    return value <= UINT256_MAX ? value : null;
  };
  for (const part of parts) {
    const range = /^([^-]+)-([^-]+)$/.exec(part);
    const low = id(range ? range[1] ?? '' : part);
    const high = range ? id(range[2] ?? '') : low;
    if (low === null || high === null || high < low) return 'format';
    if (BigInt(ids.length) + (high - low) + 1n > BigInt(SHOP_STARTER_MAX)) return 'many';
    for (let value = low; value <= high; value += 1n) ids.push(value);
  }
  return ids;
}

let lastStarters: { readonly key: string; readonly items: readonly StarterItem[] | null } | null = null;

/**
 * The starter set the rows name, in row order and then typed order (the order add-on 8 commits): null when a row with
 * ids has no collection address, or its ids do not parse or pass the maximum. Rebuilt only when the rows change.
 */
export function starterItemsOf(shop: Pick<ShopChoice, 'collections'>): readonly StarterItem[] | null {
  const key = shop.collections.map((row) => `${row.address}\u0000${row.tier}\u0000${row.ids ?? ''}`).join('\u0001');
  if (lastStarters?.key === key) return lastStarters.items;
  let items: StarterItem[] | null = [];
  for (const row of shop.collections) {
    const ids = idsOf(row.ids ?? '');
    if (typeof ids !== 'string' && ids.length === 0) continue;
    const collection = addressOf(row.address);
    if (collection === null || typeof ids === 'string' || items.length + ids.length > SHOP_STARTER_MAX) { items = null; break; }
    for (const id of ids) items.push({ collection, id, tier: row.tier });
  }
  lastStarters = { key, items };
  return items;
}

const commitments = new WeakMap<readonly StarterItem[], { readonly setHash: Hex; readonly count: number }>();

/**
 * IStarterSetLoaderV2's ordered commitment: h[i] = keccak256(abi.encode(collection, id, tier, h[i+1])), h[N] = 0; its
 * set hash is h[0] and its count N (zero hash and zero count for no items).
 */
export function starterCommitmentOf(items: readonly StarterItem[]): { readonly setHash: Hex; readonly count: number } {
  const known = commitments.get(items);
  if (known) return known;
  let next: Hex = zeroHash;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i] as StarterItem;
    next = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'bytes32' }], [item.collection, item.id, item.tier, next]));
  }
  const commitment = { setHash: next, count: items.length };
  commitments.set(items, commitment);
  return commitment;
}

/** Add-on 8's params: abi.encode(bytes32 setHash, uint32 count). */
export const starterParamsOf = (items: readonly StarterItem[]): Hex => {
  const { setHash, count } = starterCommitmentOf(items);
  return encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint32' }], [setHash, count]);
};

/**
 * A shop's add-ons: 7, the collection list (no params), and 8, the starter set: its items' commitment, or a zero hash
 * and a zero count without items (the seed still needs the set's loader, which opens the box once the seed has
 * arrived). Starter ids that do not parse build as no items; the page's checks refuse them (`shopIssues`).
 */
export const shopAddOnsOf = (shop: Pick<ShopChoice, 'collections'>): readonly AddOnV2[] => [
  { id: 7, params: '0x' as Hex },
  { id: 8, params: starterParamsOf(starterItemsOf(shop) ?? []) },
];

/** A shop's add-ons without starter items. */
export const SHOP_ADD_ONS: readonly AddOnV2[] = Object.freeze([
  { id: 7, params: '0x' as Hex },
  { id: 8, params: encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint32' }], [zeroHash, 0]) },
]);

/** The cheapest give among the tiers the starting collections use (the F132 seed rule's minimum); null without one. */
export function cheapestListedGive(config: ShopConfig): bigint | null {
  let cheapest: bigint | null = null;
  for (const tier of config.tiers) {
    const price = config.givePricesT[tier];
    if (price !== undefined && (cheapest === null || price < cheapest)) cheapest = price;
  }
  return cheapest;
}

/** What the chain said about a typed collection: an ERC-721 contract, another contract, no contract, or not asked yet. */
export type CollectionCheck = 'erc721' | 'not-erc721' | 'no-code';
/** What the chain said about a starter item: the creator owns it (ShopVaultV2 pulls it only from the creator), or not. */
export type StarterCheck = 'yours' | 'not-yours';
/** A starter item's key in the chain's answers: its collection (lower case) and id. */
export const starterKey = (item: Pick<StarterItem, 'collection' | 'id'>): string => `${item.collection.toLowerCase()}:${item.id}`;

export const SHOP_CONTROL = Object.freeze({
  seed: 'create-v2-shop-seed',
  tiers: 'create-v2-shop-tiers',
  tier: (i: number) => `create-v2-shop-tier-${i}`,
  pick: 'create-v2-shop-pick',
  weekly: 'create-v2-shop-weekly',
  perCollection: 'create-v2-shop-per-collection',
  delay: 'create-v2-shop-delay',
  curator: 'create-v2-shop-curator',
  curatorAddress: 'create-v2-shop-curator-address',
  /** The Overview's curator row (the wallet the creator connects names the curator). */
  curatorRow: 'create-v2-shop-curator-row',
  collections: 'create-v2-shop-collections',
  collection: (i: number) => `create-v2-shop-collection-${i}`,
  /** A collection's starter ids. */
  starters: (i: number) => `create-v2-shop-collection-${i}-ids`,
  /** The Overview's starter items row (their owner, the wallet the creator connects, is checked there). */
  startersRow: 'create-v2-shop-starters-row',
});

export interface ShopIssue {
  readonly step: 'v2-contents' | 'v2-opening' | 'v2-overview';
  readonly control: string;
  readonly message: string;
}

export interface ShopIssueContext {
  readonly owner: Address | null;
  /** The ticker as typed (Basics); "T" until there is one. */
  readonly ticker: string;
  /** The creator's first buy in the price coin's raw units (null: not a number), and that coin's symbol. */
  readonly firstIn: bigint | null;
  readonly priceSymbol: string;
  /** The chain's answer per typed collection (lower-case address); absent: not asked (the Demo) or not answered yet. */
  readonly checks?: ReadonlyMap<string, CollectionCheck | 'unknown'>;
  /** The chain's answer per starter item for `owner` (`starterKey`); absent: not asked (the Demo, or no wallet yet). */
  readonly starterChecks?: ReadonlyMap<string, StarterCheck | 'unknown'>;
}

const tText = (raw: bigint, ticker: string) => `${formatUnits(raw, 18)} ${ticker}`;
/** How many starter items the connected wallet does not hold: on the Overview, and when a Create or Continue press stops. */
export const startersMissingLine = (missing: number): string => `Not in your wallet: ${missing} starter ${missing === 1 ? 'item' : 'items'}`;
const AMOUNT_LINE = 'Use a number like 1000, up to 18 decimals';
export const IDS_LINE = 'Use ids like 1, 2, 5-9';

/** Every check of a shop, by step, in the order its fields appear. */
export function shopIssues(shop: ShopChoice, ctx: ShopIssueContext): ShopIssue[] {
  const ticker = ctx.ticker || 'T';
  const issues: ShopIssue[] = [];
  const contents = (control: string, message: string) => issues.push({ step: 'v2-contents', control, message });
  const supply = `At most ${tText(T_SUPPLY, ticker)}`;
  // The four give tiers: plain numbers, above zero, each above the one before, none above the supply.
  const prices: (bigint | null)[] = shop.prices.map((text) => tOf(text));
  shop.prices.forEach((text, i) => {
    const raw = parseEthText(text, 18);
    const price = prices[i] ?? null;
    const before = i > 0 ? prices[i - 1] ?? null : null;
    if (raw === null) contents(SHOP_CONTROL.tier(i), AMOUNT_LINE);
    else if (price === null) contents(SHOP_CONTROL.tier(i), supply);
    else if (price === 0n) contents(SHOP_CONTROL.tier(i), 'More than 0');
    else if (before !== null && before > 0n && price <= before) contents(SHOP_CONTROL.tier(i), `Above tier ${i}`);
  });
  // The seed: two of the cheapest give among the listed tiers (F132: seedT / 2 >= minInitialGiveT).
  const seedRaw = parseEthText(shop.seed, 18);
  const seed = tOf(shop.seed);
  const config = shopConfigOf(shop, ctx.owner);
  const cheapest = cheapestListedGive(config);
  if (seedRaw === null) contents(SHOP_CONTROL.seed, AMOUNT_LINE);
  else if (seed === null) contents(SHOP_CONTROL.seed, supply);
  else if (cheapest !== null && cheapest > 0n && seed / 2n < cheapest) contents(SHOP_CONTROL.seed, `At least ${tText(2n * cheapest, ticker)}: twice the cheapest listed give`);
  else if (seed === 0n) contents(SHOP_CONTROL.seed, 'More than 0');
  // The presets (a choice saved from another flow could carry another value; the chips offer only these).
  if (!(SHOP_PICK_BPS as readonly number[]).includes(shop.pickBps)) contents(SHOP_CONTROL.pick, MESSAGES.pickOption);
  if (!(SHOP_WEEKLY_BPS as readonly number[]).includes(shop.weeklyBps)) contents(SHOP_CONTROL.weekly, MESSAGES.pickOption);
  if (!(SHOP_COLLECTION_BPS as readonly number[]).includes(shop.collectionBps)) contents(SHOP_CONTROL.perCollection, MESSAGES.pickOption);
  if (!(SHOP_LIST_DELAY_DAYS as readonly number[]).includes(shop.listDelayDays)) contents(SHOP_CONTROL.delay, MESSAGES.pickOption);
  // The curator: the connected wallet (named on the Overview, where the wallet is connected), a typed address, or none.
  if (shop.curator === 'address' && addressOf(shop.curatorAddress) === null) contents(SHOP_CONTROL.curatorAddress, 'Use an address like 0x12…, 42 characters');
  else if (shop.curator === 'address' && addressOf(shop.curatorAddress) === ZERO) contents(SHOP_CONTROL.curatorAddress, 'Not the zero address');
  if (shop.curator === 'creator' && ctx.owner === null) issues.push({ step: 'v2-overview', control: SHOP_CONTROL.curatorRow, message: 'Connect a wallet: you are the curator.' });
  // The starting collections: 1 to 64, each an ERC-721 contract, none twice.
  if (shop.collections.length === 0) contents(SHOP_CONTROL.collections, 'Add a collection');
  if (shop.collections.length > SHOP_MAX_COLLECTIONS) contents(SHOP_CONTROL.collections, `At most ${SHOP_MAX_COLLECTIONS} collections`);
  const seen = new Set<string>();
  shop.collections.forEach((row, i) => {
    const address = addressOf(row.address);
    const key = address?.toLowerCase() ?? '';
    const check = ctx.checks?.get(key);
    if (address === null || address === ZERO) contents(SHOP_CONTROL.collection(i), 'Use a collection address like 0x12…, 42 characters');
    else if (seen.has(key)) contents(SHOP_CONTROL.collection(i), 'Listed twice');
    else if (check === 'no-code') contents(SHOP_CONTROL.collection(i), 'No contract at this address');
    else if (check === 'not-erc721') contents(SHOP_CONTROL.collection(i), 'Not an ERC-721 collection');
    else if (check === 'unknown') contents(SHOP_CONTROL.collection(i), 'Checking this collection');
    if (address !== null) seen.add(key);
  });
  // The starter items: ids of each collection, none twice; none in all, or 10 to 10,000 (IStarterSetLoaderV2).
  let total = 0;
  let many = false;
  let unread = false;
  shop.collections.forEach((row, i) => {
    const ids = idsOf(row.ids ?? '');
    if (ids === 'format') { contents(SHOP_CONTROL.starters(i), IDS_LINE); unread = true; }
    else if (ids === 'many') many = true;
    else {
      if (new Set(ids.map(String)).size !== ids.length) contents(SHOP_CONTROL.starters(i), 'Listed twice');
      total += ids.length;
    }
  });
  if (many || total > SHOP_STARTER_MAX) contents(SHOP_CONTROL.collections, `At most ${SHOP_STARTER_MAX.toLocaleString('en-US')} starter items`);
  else if (!unread && total > 0 && total < SHOP_STARTER_MIN) contents(SHOP_CONTROL.collections, `At least ${SHOP_STARTER_MIN} starter items, or none`);
  // Each is pulled from the creator after Create, so the wallet the creator connects must hold every one.
  const starters = starterItemsOf(shop);
  if (starters !== null && starters.length > 0) {
    const row = (message: string) => issues.push({ step: 'v2-overview', control: SHOP_CONTROL.startersRow, message });
    if (ctx.owner === null) row('Connect the wallet that holds the starter items.');
    else if (ctx.starterChecks) {
      const answers = starters.map((item) => ctx.starterChecks?.get(starterKey(item)));
      const missing = answers.filter((answer) => answer === 'not-yours').length;
      if (answers.some((answer) => answer === undefined || answer === 'unknown')) row('Checking the starter items');
      else if (missing > 0) row(startersMissingLine(missing));
    }
  }
  // The seed is pulled from the creator before the box opens: only the first buy gives the creator T by then.
  if (ctx.firstIn === 0n) issues.push({ step: 'v2-opening', control: CONTROL.firstIn, message: `A shop needs your ${ctx.priceSymbol} at start: the seed comes from it.` });
  return issues;
}
