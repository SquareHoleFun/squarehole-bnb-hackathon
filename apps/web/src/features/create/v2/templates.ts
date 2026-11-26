/**
 * "Start from a template" (F128): generic recipes as a first choice on Basics, named by what the box does (founder,
 * 2026-10-11: "I wanted to abstract from the examples like Link Marine to generalised templates"). Each tile has its
 * icon (brand/template-icons.tsx), a 1-3 word name and one short line in the Fees step's own words. Choosing one fills
 * only the recipe's fields: what is in the box, the fee choice of both sides, the coin pile add-on and a shop. It never
 * picks the price coin (its own picker on Basics), a name, a ticker or anything else, and the creator can still change
 * everything. Blank ("No recipe") puts only the recipe's fields back to their defaults.
 *
 * Only what the flow can build. Shop (SH-V21-FE13): the Contents step's shop with its settings' defaults (shop.ts) and
 * holders paid on both sides, as a shop with a budget for its items is usually run. The named example boxes this row
 * showed before (Link Marines, Gold Rush, …) live on as test data only (test-support/example-configurations.ts).
 */
import type { TemplateIconId } from '../../brand/template-icons';
import { DEFAULT_FORM, type CreateForm } from '../create-model';
import { DEFAULT_V2, newPile, type V2Choices } from './model';
import { INSIDE, alchemistPick, pickFor, type SidePick } from './recipes';
import { newShop } from './shop';

/** What a template sets: the contents, both sides' fee choice and, for a token, whether it carries a coin pile. */
export interface Recipe {
  readonly contents: 'token' | 'collection';
  readonly buyers: SidePick;
  readonly sellers: SidePick;
  /** A coin pile (token boxes only, M3): switched on, its seed coin and amount left to the creator. */
  readonly pile?: true;
  /** A shop (M2, the Contents step's third choice): its settings' defaults, the seed, prices and collections left to the creator. */
  readonly shop?: true;
  /**
   * The Alchemist on the buyers' side (with `pile`): the pile is in another coin than the price coin, one an Alchemist
   * row resolves for, and the buyers' fees take that row (`buyers` is the fallback, never used while the tile shows).
   */
  readonly alchemist?: true;
}

export interface Template {
  readonly id: TemplateIconId;
  readonly name: string;
  /** One short line: what is in the box, then the fee choice, in the Fees step's words. */
  readonly line: string;
  readonly recipe: Recipe | null;
}

const both = (pick: SidePick): Pick<Recipe, 'buyers' | 'sellers'> => ({ buyers: pick, sellers: pick });

export const BLANK_TEMPLATE: Template = Object.freeze({ id: 'blank', name: 'Blank', line: 'No recipe', recipe: null });

/**
 * The recipes, then Blank. "Grow the pool" is the Fees step's own choice (the one form of "grow" the wording rule
 * allows, F23). The creator's and the holders' recipes are named by where the fees go, "To the creator" and "To holders"
 * (founder R47J, SH-V21-FE14, replacing the 2026-10-11 names): no template name is an exception to the wording rule.
 */
export const TEMPLATES: readonly Template[] = Object.freeze([
  { id: 'liquidity', name: 'Liquidity token', line: 'Token · Grow the pool', recipe: { contents: 'token', ...both(pickFor('grow')) } },
  { id: 'burn', name: 'Burn', line: 'Token · Buy back and burn', recipe: { contents: 'token', ...both(pickFor('burn')) } },
  { id: 'creator', name: 'To the creator', line: 'Token · Keep', recipe: { contents: 'token', ...both(pickFor('keep')) } },
  { id: 'holders', name: 'To holders', line: 'Token · To holders', recipe: { contents: 'token', ...both(pickFor('holders')) } },
  { id: 'collection', name: 'Collection', line: 'NFTs · To items · Keep', recipe: { contents: 'collection', ...both(pickFor('items', INSIDE.keep)) } },
  { id: 'collection-burn', name: 'Collection that burns', line: 'NFTs · To items · Buy back and burn', recipe: { contents: 'collection', ...both(pickFor('items', INSIDE.burn)) } },
  { id: 'pile', name: 'Coin pile', line: 'Token · Coin pile', recipe: { contents: 'token', ...both(pickFor('burn')), pile: true } },
  // ALCH-TEMPLATE (founder 2026-10-23): a pile in another coin fed by the buyers' fees through The Alchemist. The inbox's
  // money is booked as buyers' fees, so only this side receives it; the sellers keep the Coin pile's Burn.
  { id: 'alchemist-pile', name: 'Alchemist coin pile', line: 'Coin pile · The Alchemist', recipe: { contents: 'token', ...both(pickFor('burn')), pile: true, alchemist: true } },
  { id: 'shop', name: 'Shop', line: 'Shop · To holders', recipe: { contents: 'token', ...both(pickFor('holders')), shop: true } },
  BLANK_TEMPLATE,
] satisfies readonly Template[]);


/**
 * What choosing `template` changes in the draft, given the current choices: the recipe's contents, fee choices, coin
 * pile and shop (each kept as typed when one is already there, else a new one: a pile in the current price coin, a
 * shop with its defaults), or for Blank their defaults. Everything else (the price coin, names, art, royalty, deadline,
 * opening) stays as it is.
 */
export function templateDraft(template: Template, current: Pick<V2Choices, 'pricing' | 'pile'> & Partial<Pick<V2Choices, 'shop'>> & { readonly alchemist?: AlchemistOffer | null }): { readonly form: Pick<CreateForm, 'contents'>; readonly v2: Pick<V2Choices, 'buyers' | 'sellers' | 'pile' | 'shop'> } {
  const recipe = template.recipe;
  if (recipe === null) return { form: { contents: DEFAULT_FORM.contents }, v2: { buyers: DEFAULT_V2.buyers, sellers: DEFAULT_V2.sellers, pile: null, shop: null } };
  const offer = recipe.alchemist ? current.alchemist ?? null : null;
  // The Alchemist's pile is in the offered coin: a pile already typed in it stays, any other starts again in that coin.
  const pile = offer ? (current.pile && current.pile.asset.toLowerCase() === offer.coin.toLowerCase() ? current.pile : newPile(offer.coin))
    : recipe.pile ? (current.pile ?? newPile(current.pricing)) : null;
  return {
    form: { contents: recipe.contents },
    v2: { buyers: offer ? alchemistPick(offer.row) : recipe.buyers, sellers: recipe.sellers, pile, shop: recipe.shop ? (current.shop ?? newShop()) : null },
  };
}

/** A pile coin an Alchemist row resolves for with the current price coin, and that row (alchemist.ts `useAlchemistPiles`). */
export interface AlchemistOffer {
  readonly coin: string;
  readonly row: number;
}

/** The row's tiles: The Alchemist's only while a row resolves for some listed pile coin (hidden otherwise, never disabled). */
export const offeredTemplates = (alchemist: AlchemistOffer | null): readonly Template[] =>
  alchemist ? TEMPLATES : TEMPLATES.filter((template) => !template.recipe?.alchemist);
