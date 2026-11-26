/**
 * SH-256: the v2 flow's own part of the draft (its choices, the template it started from and a loaded setup's marker),
 * stored with the shared draft in the same key (draft.ts `sh.create.draft.v2`, field `v2`), so a fresh document gets
 * back the WHOLE draft or none of it: never the names and items with the money choices at their defaults.
 *
 * Storage is untrusted: every field is checked on the way back and rebuilt by the page's own makers (a fee choice by
 * `pickFor` or `alchemistPick`, exactly as stored or not at all); anything off, a missing part (a draft saved before
 * this part existed) or a loaded setup gives null, and draft.ts starts clean. A loaded setup never comes back: its
 * item files live in memory only and its locked fields cannot be checked against its file again (SH-256 E5).
 */
import type { LoadedInfo } from './load-settings';
import { DEADLINE_DAYS_V2, DEFAULT_V2, LEAVE_BEHIND_PRESETS, PICK_FEE_PRESETS, type PileChoice, type V2Choices } from './model';
import { alchemistPick, ceilingOf, choiceOf, insideOf, moduleIdOf, pickFor, type SidePick } from './recipes';
import { SHOP_COLLECTION_BPS, SHOP_LIST_DELAY_DAYS, SHOP_MAX_COLLECTIONS, SHOP_PICK_BPS, SHOP_STARTER_MAX, SHOP_TIERS, SHOP_WEEKLY_BPS, type ShopChoice, type ShopCurator, type ShopRow } from './shop';
import { TEMPLATES } from './templates';

/** The v2 flow's part of the draft. */
export interface DraftMoney {
  readonly v2: V2Choices;
  /** The template this visit started from (F128), or null. */
  readonly template: string | null;
  /** TA-27: the loaded setup's marker, or null; while one is loaded the shared draft is locked (load-settings `lockedDraft`). */
  readonly loaded: LoadedInfo | null;
}

export const EMPTY_MONEY: DraftMoney = Object.freeze({ v2: DEFAULT_V2, template: null, loaded: null });

/** A row's starter ids as typed: up to 10,000 ids of up to 78 digits, each with its separator (shop.ts `idsOf`). */
const MAX_IDS_TEXT = SHOP_STARTER_MAX * 80;

type Json = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const isAddress = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
const hasOnly = (value: Json, keys: readonly string[]): boolean => Object.keys(value).every((key) => keys.includes(key));
const oneOf = <T>(list: readonly T[], value: unknown): value is T => list.includes(value as T);

/** One JSON text per value, whatever its key order: a stored pick is kept only when it is exactly the one rebuilt. */
const canonical = (value: unknown): string => JSON.stringify(value, (_key, entry: unknown) =>
  isRecord(entry) ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]])) : entry);

/** A side's fee choice, rebuilt by the Fees step's own makers; null unless the stored pick is exactly that one. */
function readPick(value: unknown): SidePick | null {
  if (!isRecord(value) || !isRecord(value.a) || !isRecord(value.b) || !isRecord(value.split)) return null;
  const stored = value as unknown as SidePick;
  const choice = choiceOf(stored);
  if (choice === null) return null;
  const module = moduleIdOf(stored);
  const pick = choice === 'alchemist' ? (module === null ? null : alchemistPick(module)) : pickFor(choice, insideOf(stored) ?? undefined, ceilingOf(stored) ?? undefined);
  return pick !== null && canonical(pick) === canonical(value) ? pick : null;
}

/** The coin pile as typed (its seed stays text: parsed to raw units only through model `pileSeedOf`); undefined when off. */
function readPile(value: unknown): PileChoice | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !hasOnly(value, ['asset', 'seed', 'leaveBehindBps']) || !isAddress(value.asset) || !isText(value.seed, 100)) return undefined;
  if (value.leaveBehindBps === undefined) return { asset: value.asset, seed: value.seed };
  return oneOf(LEAVE_BEHIND_PRESETS, value.leaveBehindBps) ? { asset: value.asset, seed: value.seed, leaveBehindBps: value.leaveBehindBps } : undefined;
}

function readRow(value: unknown): ShopRow | null {
  if (!isRecord(value) || !hasOnly(value, ['address', 'tier', 'ids']) || !isText(value.address, 100) || !oneOf(SHOP_TIERS, value.tier)) return null;
  if (value.ids === undefined) return { address: value.address, tier: value.tier };
  return isText(value.ids, MAX_IDS_TEXT) ? { address: value.address, tier: value.tier, ids: value.ids } : null;
}

const CURATORS: readonly ShopCurator[] = ['creator', 'address', 'none'];
const SHOP_KEYS = ['seed', 'prices', 'pickBps', 'weeklyBps', 'collectionBps', 'listDelayDays', 'curator', 'curatorAddress', 'collections'];

/** A shop as typed, its presets only the ones the page offers (shop.ts); undefined when anything is off. */
function readShop(value: unknown): ShopChoice | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !hasOnly(value, SHOP_KEYS) || !isText(value.seed, 100) || !isText(value.curatorAddress, 100) || !oneOf(CURATORS, value.curator)) return undefined;
  const { prices, collections } = value;
  if (!Array.isArray(prices) || prices.length !== 4 || !prices.every((price) => isText(price, 100))) return undefined;
  if (!oneOf(SHOP_PICK_BPS, value.pickBps) || !oneOf(SHOP_WEEKLY_BPS, value.weeklyBps) || !oneOf(SHOP_COLLECTION_BPS, value.collectionBps) || !oneOf(SHOP_LIST_DELAY_DAYS, value.listDelayDays)) return undefined;
  if (!Array.isArray(collections) || collections.length > SHOP_MAX_COLLECTIONS) return undefined;
  const rows = collections.map(readRow);
  if (rows.some((row) => row === null)) return undefined;
  return {
    seed: value.seed, prices: [prices[0], prices[1], prices[2], prices[3]] as [string, string, string, string],
    pickBps: value.pickBps, weeklyBps: value.weeklyBps, collectionBps: value.collectionBps, listDelayDays: value.listDelayDays,
    curator: value.curator, curatorAddress: value.curatorAddress, collections: rows as ShopRow[],
  };
}

const V2_KEYS = ['pricing', 'buyers', 'sellers', 'pickFeeBps', 'deadlineDays', 'pile', 'shop'];

/** The choices; null when any field is off. The price coin is any address: one no longer listed is the page's to refuse (v2Issues). */
function readChoices(value: unknown): V2Choices | null {
  if (!isRecord(value) || !hasOnly(value, V2_KEYS) || !isAddress(value.pricing)) return null;
  if (!oneOf(PICK_FEE_PRESETS, value.pickFeeBps) || !oneOf(DEADLINE_DAYS_V2, value.deadlineDays)) return null;
  const buyers = readPick(value.buyers);
  const sellers = readPick(value.sellers);
  const pile = readPile(value.pile);
  const shop = readShop(value.shop);
  // A shop is never together with a pile (model.ts `V2Choices.shop`).
  if (!buyers || !sellers || pile === undefined || shop === undefined || (pile !== null && shop !== null)) return null;
  return { pricing: value.pricing, buyers, sellers, pickFeeBps: value.pickFeeBps, deadlineDays: value.deadlineDays, pile, shop };
}

/**
 * The part as stored (no bigint in it: amounts are the typed text). SH-256 E10: amounts and addresses are stored trimmed
 * (their parsers trim them: the same draft), and a curator address that is not in use is not stored.
 */
export function moneyJson(money: DraftMoney): unknown {
  const { pile, shop } = money.v2;
  const v2: V2Choices = {
    ...money.v2,
    pile: pile ? { ...pile, asset: pile.asset.trim(), seed: pile.seed.trim() } : null,
    shop: shop ? {
      ...shop, seed: shop.seed.trim(), prices: shop.prices.map((price) => price.trim()) as unknown as ShopChoice['prices'],
      curatorAddress: shop.curator === 'address' ? shop.curatorAddress.trim() : '',
      collections: shop.collections.map((row) => ({ ...row, address: row.address.trim() })),
    } : null,
  };
  return { v2, template: money.template, loaded: money.loaded };
}

/** The stored part; null when it is missing or off, or when it carries a loaded setup (E5: those start clean). */
export function readMoney(value: unknown): DraftMoney | null {
  if (!isRecord(value) || !hasOnly(value, ['v2', 'template', 'loaded']) || value.loaded !== null) return null;
  const v2 = readChoices(value.v2);
  const { template } = value;
  if (v2 === null) return null;
  if (template !== null && !TEMPLATES.some((entry) => entry.id === template)) return null;
  return { v2, template: template as string | null, loaded: null };
}
