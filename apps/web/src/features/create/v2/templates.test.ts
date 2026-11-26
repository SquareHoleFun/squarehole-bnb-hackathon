/** F128 templates (templates.ts): the generic recipes and Blank, their icons and lines, and what a choice fills. */
import { describe, expect, it } from 'vitest';
import { TEMPLATE_ICONS } from '../../brand/template-icons';
import { DEFAULT_FORM } from '../create-model';
import { NATIVE_TOKEN } from './listings';
import { DEFAULT_V2, newPile } from './model';
import { newShop } from './shop';
import { INSIDE, choiceOf, insideOf, moduleIdOf } from './recipes';
import { appCopyFraming } from '../../legal/wording';
import { BLANK_TEMPLATE, TEMPLATES, offeredTemplates, templateDraft } from './templates';
import { EXCEPTED_TEMPLATE_NAMES, withoutTemplateNames } from './test-support/template-wording';

const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const byName = (name: string) => {
  const found = TEMPLATES.find((t) => t.name === name);
  if (!found) throw new Error(name);
  return found;
};

describe('F128 templates: generic recipes (founder 2026-10-11)', () => {
  it('lists the nine, named by what the box does, then Blank; no named example box (SH-V21-FE13 adds Shop, ALCH-TEMPLATE Alchemist coin pile)', () => {
    expect(TEMPLATES.map((t) => t.name)).toEqual(['Liquidity token', 'Burn', 'To the creator', 'To holders', 'Collection', 'Collection that burns', 'Coin pile', 'Alchemist coin pile', 'Shop', 'Blank']);
    expect(TEMPLATES.at(-1)).toBe(BLANK_TEMPLATE);
    for (const t of TEMPLATES) expect(t.name.split(' ').length, t.name).toBeLessThanOrEqual(3);
    expect(TEMPLATES.map((t) => t.name).join(' ')).not.toMatch(/Link Marines|Gold Rush|GPU Poor|Next Stop|Dragon|Junkyard|TRASH|Alchemist’s|LEAD|PEPE|XAUT|token only/i);
  });

  it('R47J: the creator’s and the holders’ templates say where the fees go; every name follows the wording rule with no exception', () => {
    expect(TEMPLATES.find((t) => t.id === 'creator')?.name).toBe('To the creator');
    expect(TEMPLATES.find((t) => t.id === 'holders')?.name).toBe('To holders');
    // ALCH-TEMPLATE fix round 1: The Alchemist's template is "Alchemist coin pile", so the audits except no name.
    expect(appCopyFraming(TEMPLATES.map((t) => t.name))).toEqual([]);
    expect(EXCEPTED_TEMPLATE_NAMES).toEqual([]);
    expect(appCopyFraming(['Growing coin pile'].map(withoutTemplateNames))).toEqual(['Growing coin pile']);
    // Nothing is excepted: the old names, and any "grow" framing, fail like any other copy.
    for (const text of ['Creator earns', 'Holders earn', 'Holders earnToken · To holders', 'Creator earns more', 'Your pile keeps growing', 'Alchemist coin pileCoin pile · The Alchemist']) expect(withoutTemplateNames(text), text).toBe(text);
    expect(appCopyFraming(['Creator earns', 'Holders earn', 'Your pile keeps growing'].map(withoutTemplateNames))).toEqual(['Creator earns', 'Holders earn', 'Your pile keeps growing']);
  });

  it('every tile has its own icon, and one short line in the Fees step’s words', () => {
    for (const t of TEMPLATES) expect(TEMPLATE_ICONS[t.id], t.id).toBeDefined();
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
    expect(TEMPLATES.map((t) => t.line)).toEqual(['Token · Grow the pool', 'Token · Buy back and burn', 'Token · Keep', 'Token · To holders', 'NFTs · To items · Keep', 'NFTs · To items · Buy back and burn', 'Token · Coin pile', 'Coin pile · The Alchemist', 'Shop · To holders', 'No recipe']);
    for (const t of TEMPLATES) expect(t.line, t.id).not.toMatch(/[.!?]$|\bjust\b|\bonly\b/i);
  });

  it('each recipe: what is in the box, both sides’ fee choice, the coin pile, a shop', () => {
    const recipes = TEMPLATES.slice(0, -1).map((t) => {
      const recipe = t.recipe;
      if (!recipe) throw new Error(t.id);
      return [t.name, recipe.contents, choiceOf(recipe.buyers), choiceOf(recipe.sellers), insideOf(recipe.buyers), recipe.pile === true, recipe.shop === true];
    });
    expect(recipes).toEqual([
      ['Liquidity token', 'token', 'grow', 'grow', null, false, false],
      ['Burn', 'token', 'burn', 'burn', null, false, false],
      ['To the creator', 'token', 'keep', 'keep', null, false, false],
      ['To holders', 'token', 'holders', 'holders', null, false, false],
      ['Collection', 'collection', 'items', 'items', INSIDE.keep, false, false],
      ['Collection that burns', 'collection', 'items', 'items', INSIDE.burn, false, false],
      ['Coin pile', 'token', 'burn', 'burn', null, true, false],
      ['Alchemist coin pile', 'token', 'burn', 'burn', null, true, false],
      ['Shop', 'token', 'holders', 'holders', null, false, true],
    ]);
  });

  it('a choice fills only the recipe: never the price coin, a name, a ticker or anything else', () => {
    const current = { ...DEFAULT_V2, pricing: USDC, pile: null };
    for (const t of TEMPLATES) {
      const { form, v2 } = templateDraft(t, current);
      expect(Object.keys(form), t.id).toEqual(['contents']);
      expect(Object.keys(v2).sort(), t.id).toEqual(['buyers', 'pile', 'sellers', 'shop']);
      expect(v2, t.id).not.toHaveProperty('pricing');
    }
    expect(templateDraft(byName('Collection'), current)).toEqual({ form: { contents: 'collection' }, v2: { buyers: byName('Collection').recipe?.buyers, sellers: byName('Collection').recipe?.sellers, pile: null, shop: null } });
  });

  it('Coin pile starts a pile in the current price coin with no seed, and keeps a pile the creator already set up', () => {
    expect(templateDraft(byName('Coin pile'), { pricing: USDC, pile: null }).v2.pile).toEqual(newPile(USDC));
    const typed = { asset: NATIVE_TOKEN, seed: '250' };
    expect(templateDraft(byName('Coin pile'), { pricing: USDC, pile: typed }).v2.pile).toBe(typed);
    // Every other recipe has no pile (a collection cannot carry one).
    for (const name of ['Liquidity token', 'Burn', 'Collection']) expect(templateDraft(byName(name), { pricing: USDC, pile: typed }).v2.pile, name).toBeNull();
  });

  it('Shop starts a shop with its defaults and no pile, keeps a shop the creator already set up, and every other recipe has none', () => {
    const typed = { asset: NATIVE_TOKEN, seed: '250' };
    expect(templateDraft(byName('Shop'), { pricing: USDC, pile: typed }).v2).toMatchObject({ pile: null, shop: newShop() });
    expect(templateDraft(byName('Shop'), { pricing: USDC, pile: null }).form).toEqual({ contents: 'token' });
    const own = { ...newShop(), seed: '1000', prices: ['1', '2', '4', '8'] as const };
    expect(templateDraft(byName('Shop'), { pricing: USDC, pile: null, shop: own }).v2.shop).toBe(own);
    for (const name of ['Liquidity token', 'Coin pile', 'Collection']) expect(templateDraft(byName(name), { pricing: USDC, pile: null, shop: own }).v2.shop, name).toBeNull();
  });

  it('Blank puts the recipe’s fields back to their defaults', () => {
    expect(templateDraft(BLANK_TEMPLATE, { pricing: USDC, pile: { asset: USDC, seed: '1' }, shop: newShop() })).toEqual({
      form: { contents: DEFAULT_FORM.contents },
      v2: { buyers: DEFAULT_V2.buyers, sellers: DEFAULT_V2.sellers, pile: null, shop: null },
    });
  });

  describe('ALCH-TEMPLATE Alchemist coin pile (founder 2026-10-23; renamed in fix round 1)', () => {
    const PEPE = '0x00000000000000000000000000000000000000fe';
    const XAUT = '0x00000000000000000000000000000000000000a0';
    const alchemistPile = byName('Alchemist coin pile');
    it('a pile in the offered coin, The Alchemist’s row on the buyers’ side, Burn on the sellers’ side', () => {
      const { form, v2 } = templateDraft(alchemistPile, { pricing: PEPE, pile: null, alchemist: { coin: XAUT, row: 3 } });
      expect(form).toEqual({ contents: 'token' });
      expect(v2.pile).toEqual(newPile(XAUT));
      expect(choiceOf(v2.buyers)).toBe('alchemist');
      expect(moduleIdOf(v2.buyers)).toBe(3);
      expect(choiceOf(v2.sellers)).toBe('burn');
      expect(v2.shop).toBeNull();
    });
    it('keeps a pile already typed in the offered coin; a pile in another coin starts again in the offered one', () => {
      const typed = { asset: XAUT, seed: '2', leaveBehindBps: 500 as const };
      expect(templateDraft(alchemistPile, { pricing: PEPE, pile: typed, alchemist: { coin: XAUT, row: 3 } }).v2.pile).toBe(typed);
      expect(templateDraft(alchemistPile, { pricing: PEPE, pile: { asset: PEPE, seed: '5' }, alchemist: { coin: XAUT, row: 3 } }).v2.pile).toEqual(newPile(XAUT));
    });
    it('shows only while a row resolves for a listed pile coin: hidden otherwise, never disabled', () => {
      expect(offeredTemplates(null).map((t) => t.id)).not.toContain('alchemist-pile');
      expect(offeredTemplates(null)).toHaveLength(TEMPLATES.length - 1);
      expect(offeredTemplates({ coin: XAUT, row: 1 })).toBe(TEMPLATES);
      // Without an offer the draft never names a module row (the tile is not shown then; this is the fallback).
      expect(choiceOf(templateDraft(alchemistPile, { pricing: PEPE, pile: null }).v2.buyers)).toBe('burn');
    });
  });
});
