/**
 * CQ11 / F119: one fee choice per side. M3 adds "To items" with its in-vault rule (R43-M3A). Core v2.1 adds eating the
 * price coin (step 1), holders and items paid in the box token (step 2), fees into the coin pile (step 3) and, on a
 * shop's sellers' side, fees into the shop up to a ceiling fixed at creation (step 7, `ShopT`, R48A-D). Each choice's
 * wire is the one the factory's choice decoder (BoxFactoryV2Parts `_choice`) and the chain package's reader
 * (`feeChoiceV2`) read: one branch, no split, an empty second branch and canonical parameters. Of the fee module
 * directory's actions (`Dest.Module`), only The Alchemist is offered (step 8), by the id of a row the page resolved
 * (alchemist.ts), encoded by the chain package's `alchemistSideV21`; any other module is no choice here.
 */
import type { SiteListing } from './listings';
import { buyBackBurnLabel } from './fee-words';
import { encodeAbiParameters, type Hex } from 'viem';
import { eatLabelV21 } from '../../../../../../packages/chain/src/core/v2/eat-v21';
import { alchemistSideV21 } from '../../../../../../packages/chain/src/core/v2/alchemist-v21';
import { Dest, Leg, Split, emptyBranch, type SideV2 } from './spec-types';
export type FeeSide = 'buyers' | 'sellers';
export type FeeChoice = 'keep' | 'burn' | 'grow' | 'holders' | 'items' | 'eat' | 'holders-t' | 'items-t' | 'pile' | 'shop' | 'alchemist';
/** The choices with a fixed wire of their own; The Alchemist's names a directory row. */
export type WiredChoice = Exclude<FeeChoice, 'alchemist'>;
/** What a holder or item payout is paid in: the price coin P, or the box token T, which the fees buy first. */
export type PayoutCoin = 'P' | 'T';
/**
 * S1 `ItemsDestParams.insidePolicy`: what an item still in the vault does with its share. Keep=1, BuyBackBurn=2, and
 * v2.1 step 5's Depth=3 (the share in P goes to the box's own pool, through Grow's path). The same uint8 for P and T.
 */
export type InsidePolicy = 1 | 2 | 3;
export const INSIDE = Object.freeze({ keep: 1, burn: 2, depth: 3 } as const);
/** Keep is the authoring default (Q1), written explicitly; missing bytes never mean Keep. */
export const DEFAULT_INSIDE: InsidePolicy = INSIDE.keep;
export const INSIDE_LABEL: Readonly<Record<InsidePolicy, string>> = { 1: 'Keep', 2: 'Burn', 3: 'Grow the pool' };
/**
 * v2.1 step 7 (R48C, S1 `ShopDestParams.ceilingPreset`): fees fill the shop up to this many times its seed, fixed at
 * creation (a saturating `seedT * preset`, fees counted), then go to holders in P. Only 2, 4 and 8 are admitted.
 */
export type CeilingPreset = 2 | 4 | 8;
export const CEILING_PRESETS: readonly CeilingPreset[] = Object.freeze([2, 4, 8]);
/** The Junkyard's ceiling (R47E), and the first one offered. */
export const DEFAULT_CEILING: CeilingPreset = 2;
export interface BranchPick {
  readonly leg: number; readonly dest: number; readonly to: string | null; readonly inside?: InsidePolicy; readonly ceiling?: CeilingPreset;
  /** The Alchemist (step 8): the directory id of the row the page resolved for this box's coins (a uint32). */
  readonly module?: number;
}
/** Unknown legacy picks are refused, never silently translated. */
export type SplitPick = { readonly kind: 'none' } | { readonly kind: 'share'; readonly bps: number } | { readonly kind: 'cap'; readonly preset: number } | { readonly kind: 'rule'; readonly plugIn: string };
export interface SidePick { readonly a: BranchPick; readonly b: BranchPick; readonly split: SplitPick }
export interface RecipeCtx { readonly pricing: SiteListing; readonly listings: readonly SiteListing[]; readonly ticker?: string }
export const branch = (leg: number, dest: number, to: string | null = null): BranchPick => ({ leg, dest, to });
export const CHOICES = ['keep', 'burn', 'grow', 'holders', 'items', 'eat', 'holders-t', 'items-t', 'pile', 'shop'] as const satisfies readonly WiredChoice[];
/**
 * The Fees step's buttons, in order: To holders and To items are one button each, their coin a second option. Into the
 * shop is offered on a shop's sellers' side only, The Alchemist on a pile in another coin once a row resolved (FeesStep).
 */
export const MENU = ['keep', 'burn', 'grow', 'holders', 'items', 'eat', 'pile', 'shop', 'alchemist'] as const satisfies readonly FeeChoice[];
export const CHOICE_LABEL: Readonly<Record<FeeChoice, string>> = {
  keep: 'Keep', burn: 'Burn', grow: 'Grow the pool', holders: 'To holders', items: 'To items',
  eat: 'Eat the price coin', 'holders-t': 'To holders', 'items-t': 'To items', pile: 'To the pile', shop: 'Into the shop', alchemist: 'The Alchemist',
};
/**
 * Each choice's (leg, destination): BuyT/Eat buys and burns T; AsPaid/Eat eats P itself (v2.1 step 1); AsPaid/BudgetOrPile
 * moves P into a coin pile in P (step 3); BuyT/BudgetOrPile buys T into the shop's budget (step 7, ShopT).
 */
const WIRE: Readonly<Record<WiredChoice, readonly [number, number]>> = {
  keep: [Leg.AsPaid, Dest.Creator], burn: [Leg.BuyT, Dest.Eat], grow: [Leg.AsPaid, Dest.Depth], holders: [Leg.AsPaid, Dest.Holders],
  items: [Leg.AsPaid, Dest.Items], eat: [Leg.AsPaid, Dest.Eat], 'holders-t': [Leg.BuyT, Dest.Holders], 'items-t': [Leg.BuyT, Dest.Items],
  pile: [Leg.AsPaid, Dest.BudgetOrPile], shop: [Leg.BuyT, Dest.BudgetOrPile],
};
const isShopWire = (leg: number, dest: number): boolean => leg === Leg.BuyT && dest === Dest.BudgetOrPile;
export const pickFor = (choice: WiredChoice, inside: InsidePolicy = DEFAULT_INSIDE, ceiling: CeilingPreset = DEFAULT_CEILING): SidePick => {
  const [leg, dest] = WIRE[choice];
  const a = dest === Dest.Items ? { ...branch(leg, dest), inside } : isShopWire(leg, dest) ? { ...branch(leg, dest), ceiling } : branch(leg, dest);
  return { a, b: branch(0, 0), split: { kind: 'none' } };
};
/** The Alchemist by the directory row the page resolved (AsPaid / Module, the row's uint32 id). */
export const alchemistPick = (id: number): SidePick => ({ a: { ...branch(Leg.AsPaid, Dest.Module), module: id }, b: branch(0, 0), split: { kind: 'none' } });
const isModuleId = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
/** The directory id of an Alchemist pick; null for every other pick (and for a module pick without an id). */
export const moduleIdOf = (pick: SidePick): number | null => (pick.a.leg === Leg.AsPaid && pick.a.dest === Dest.Module && isModuleId(pick.a.module) ? pick.a.module : null);
const isInside = (value: unknown): value is InsidePolicy => value === 1 || value === 2 || value === 3;
export const isCeiling = (value: unknown): value is CeilingPreset => value === 2 || value === 4 || value === 8;
/** The in-vault rule of an items pick (in P or in T); null for every other pick. */
export const insideOf = (pick: SidePick): InsidePolicy | null => (pick.a.dest === Dest.Items && isInside(pick.a.inside) ? pick.a.inside : null);
/** The ceiling preset of an Into the shop pick; null for every other pick (and for a shop pick without an admitted preset). */
export const ceilingOf = (pick: SidePick): CeilingPreset | null => (isShopWire(pick.a.leg, pick.a.dest) && isCeiling(pick.a.ceiling) ? pick.a.ceiling : null);
export function choiceOf(pick: SidePick): FeeChoice | null {
  if (pick.split.kind !== 'none' || pick.a.to !== null || pick.b.leg !== 0 || pick.b.dest !== 0 || pick.b.to !== null) return null;
  const { leg, dest } = pick.a;
  if (dest === Dest.Items && insideOf(pick) === null) return null;
  // A shop pick carries its ceiling; missing or another preset is no choice, never a silent default.
  if (isShopWire(leg, dest) && ceilingOf(pick) === null) return null;
  // A module pick names the row the page resolved; without one it is no choice (the directory's other actions).
  if (dest === Dest.Module) return moduleIdOf(pick) === null ? null : 'alchemist';
  return CHOICES.find((choice) => WIRE[choice][0] === leg && WIRE[choice][1] === dest) ?? null;
}
/** The coin a holder or item payout is paid in; null for every other choice. */
export const payoutCoinOf = (choice: FeeChoice | null): PayoutCoin | null =>
  choice === 'holders' || choice === 'items' ? 'P' : choice === 'holders-t' || choice === 'items-t' ? 'T' : null;
/** The same payout (holders or items) in the other coin; every other choice is returned as it is. */
export function inCoin(choice: WiredChoice, coin: PayoutCoin): WiredChoice;
export function inCoin(choice: FeeChoice, coin: PayoutCoin): FeeChoice;
export function inCoin(choice: FeeChoice, coin: PayoutCoin): FeeChoice {
  if (choice === 'holders' || choice === 'holders-t') return coin === 'T' ? 'holders-t' : 'holders';
  if (choice === 'items' || choice === 'items-t') return coin === 'T' ? 'items-t' : 'items';
  return choice;
}
/** The selector a listing's checked burn records (`burn(uint256)`, IListingBurnV21); every other listing reads zero. */
export const CHECKED_BURN_SELECTOR: Hex = '0x42966c68';
const NO_BURN_SELECTOR: Hex = '0x00000000';
/**
 * Eating the price coin, named by what it does: "Burn LINK" when the listing records a checked burn, "Lock LINK"
 * otherwise (locked forever at a dead address). The chain package's own label (`eatLabelV21`).
 */
export const eatLabel = (pricing: Pick<SiteListing, 'symbol' | 'checkedBurn'>): string => eatLabelV21(pricing.symbol, pricing.checkedBurn === true ? CHECKED_BURN_SELECTOR : NO_BURN_SELECTOR);
/**
 * Whether Eat is offered for the price coin: only when the factory allows it (eat-check.ts asks its refusal() view,
 * V21-MONEY-01: a box coin without a checked burn is refused). Unknown is not offered.
 */
export const eatOffered = (pricing: Pick<SiteListing, 'eat'>): boolean => pricing.eat === 'allowed';
/** A choice's button and overview words; eating names the price coin. */
export const choiceLabel = (choice: FeeChoice, ctx: Pick<RecipeCtx, 'pricing' | 'ticker'>): string =>
  choice === 'burn' ? buyBackBurnLabel(ctx.ticker || 'the box coin') : choice === 'eat' ? eatLabel(ctx.pricing) : CHOICE_LABEL[choice];
const uint8 = (value: number) => encodeAbiParameters([{ type: 'uint8' }], [value]);
/** S1 `HoldersDestParams.currency`: P (1) for AsPaid, T (2) for BuyT. */
const HOLDERS_CURRENCY = Object.freeze({ [Leg.AsPaid]: 1, [Leg.BuyT]: 2 } as Readonly<Record<number, number>>);
export function sideOf(pick: SidePick): SideV2 {
  const moduleId = moduleIdOf(pick);
  // The Alchemist: the chain package's own encoding of the directory row (`alchemistSideV21`).
  if (moduleId !== null && choiceOf(pick) === 'alchemist') return alchemistSideV21(moduleId) as SideV2;
  const inside = insideOf(pick);
  const currency = HOLDERS_CURRENCY[pick.a.leg];
  const ceiling = ceilingOf(pick);
  // ShopT's destination params are the canonical ShopDestParams(uint8 ceilingPreset), as the chain package writes them.
  const destParams = pick.a.dest === Dest.Holders && currency !== undefined ? uint8(currency) : pick.a.dest === Dest.Items && inside !== null ? uint8(inside)
    : ceiling !== null ? uint8(ceiling) : '0x';
  return { a: { leg: pick.a.leg, dest: pick.a.dest, legParams: '0x', destParams }, b: emptyBranch(), split: pick.split.kind === 'none' ? Split.NoSplit : 0, splitParams: '0x' };
}
export interface RecipeIssue { readonly side: FeeSide; readonly subField: number; readonly reason: 'NOT_OFFERED'; readonly message: string }
export function recipeIssues(buyers: SidePick, sellers: SidePick): RecipeIssue[] {
  return ([['buyers', buyers], ['sellers', sellers]] as const).flatMap(([side, pick]) => choiceOf(pick) ? [] : [{ side, subField: side === 'buyers' ? 17001 : 18001, reason: 'NOT_OFFERED' as const, message: 'Choose a fee destination.' }]);
}
