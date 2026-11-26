/**
 * SH-256: after a fresh document in the same tab (a reload, a restored tab, the way back from the Examples page) the
 * Launch form is the WHOLE draft as it was (the shared part AND the v2 choices, its template and a loaded marker), so
 * the spec Create sends is the same; or a clean start. Never the names and items with the money choices at their
 * defaults (the owner's box of 2 November). Each test "reloads" as reveal-ack.test.tsx does: the pending save is
 * written, the in-memory draft is forgotten and read back from sessionStorage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formOf, tokenFormOf, artOf, COVER, COLLECTION_COVER, PAGE, NOW, OWNER, inputOf } from '../test-support/fixtures';
import { EMPTY_DRAFT, clearDraft, currentDraft, flushDraft, resetDraftForTests, updateDraft } from '../draft';
import { DEMO_LISTINGS } from './listings';
import { DEFAULT_V2, buildSpecV2, v2Issues, type V2Choices } from './model';
import { INSIDE, alchemistPick, pickFor } from './recipes';
import { newShop } from './shop';
import { encodeBoxSpecV2 } from './spec-types';
import { clearV2, currentV2Choices, currentV2Loaded, currentV2Template, setV2Loaded, setV2Template, updateV2 } from './v2-draft';
import type { LoadedInfo } from './load-settings';
import { EMPTY_MONEY, moneyJson } from './v2-stored';

const KEY = 'sh.create.draft.v2';
const ART_KEY = 'sh.create.art.v2';
const COVER_KEY = 'sh.create.cover.v2';
const KEYS = [KEY, ART_KEY, COVER_KEY, 'sh.create.collection-cover.v2', 'sh.create.page.v2'];
const LINK = DEMO_LISTINGS.find((listing) => listing.symbol === 'LINK')?.token as string;
const USDC = DEMO_LISTINGS.find((listing) => listing.symbol === 'USDC')?.token as string;
const stored = () => JSON.parse(window.sessionStorage.getItem(KEY) ?? 'null') as Record<string, unknown> | null;

/** A reload: the pending save written (the page does so when hidden), memory forgotten, storage read again. */
function reload() {
  flushDraft();
  resetDraftForTests();
}

/** Every field away from its default: a listed non-ETH coin, buyers to items with an in-vault rule, sellers to holders, 1%, 90 days. */
const COLLECTION_V2: V2Choices = Object.freeze<V2Choices>({
  ...DEFAULT_V2,
  pricing: LINK,
  buyers: pickFor('items', INSIDE.burn),
  sellers: pickFor('holders'),
  pickFeeBps: 100,
  deadlineDays: 90,
});
/** A token box with a coin pile in another coin, with the 5% leave-behind, and The Alchemist on the buyers' side. */
const PILE_V2: V2Choices = Object.freeze<V2Choices>({
  ...DEFAULT_V2,
  pricing: LINK,
  buyers: alchemistPick(7),
  sellers: pickFor('holders-t'),
  pickFeeBps: 500,
  deadlineDays: 180,
  pile: { asset: USDC, seed: '1000.25', leaveBehindBps: 500 },
});
const SHOP_V2: V2Choices = Object.freeze<V2Choices>({
  ...DEFAULT_V2,
  pricing: USDC,
  buyers: pickFor('grow'),
  sellers: pickFor('shop', undefined, 4),
  shop: { ...newShop(), seed: '5000', prices: ['1', '2', '3', '4'], pickBps: 15_000, curator: 'address', curatorAddress: OWNER, collections: [{ address: OWNER, tier: 2, ids: '1-10' }] },
});

function seedCollection(v2: V2Choices = COLLECTION_V2) {
  updateDraft((draft) => ({ ...draft, form: formOf({ rights: true, description: 'Payouts to the items outside the box.' }), art: artOf(12), cover: COVER, collectionCover: COLLECTION_COVER, page: PAGE }));
  updateV2(() => v2);
}

/** The spec Create would send from the stores as they are now (the Overview's rows are read from the same input). */
const specNow = () => {
  const draft = currentDraft();
  return encodeBoxSpecV2(buildSpecV2({ ...inputOf({ form: draft.form, art: draft.art, cover: draft.cover, collectionCover: draft.collectionCover, page: draft.page }), owner: OWNER, nowMs: NOW, v2: currentV2Choices(), listings: DEMO_LISTINGS }));
};

/** The clean start: nothing restored in either store. */
function expectCleanStart() {
  expect(currentDraft()).toBe(EMPTY_DRAFT);
  expect(currentV2Choices()).toBe(DEFAULT_V2);
  expect(currentV2Template()).toBeNull();
  expect(currentV2Loaded()).toBeNull();
}

beforeEach(() => {
  window.sessionStorage.clear();
  resetDraftForTests();
  clearV2();
});
afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  resetDraftForTests();
});

describe('SH-256: the v2 choices are saved with the shared draft and come back with it', () => {
  it('a collection: every choice, the template and the spec Create sends are the same after a reload', () => {
    seedCollection();
    setV2Template('collection-burn');
    const before = specNow();
    reload();
    expect(currentDraft().restored).toBe(true);
    expect(currentDraft().form.description).toBe('Payouts to the items outside the box.');
    expect(currentV2Choices()).toEqual(COLLECTION_V2);
    expect(currentV2Template()).toBe('collection-burn');
    expect(currentV2Loaded()).toBeNull();
    expect(specNow()).toBe(before);
  });

  it('a token box with a pile in another coin and The Alchemist; a shop with its own settings: each comes back whole', () => {
    updateDraft((draft) => ({ ...draft, form: tokenFormOf({ rights: true }), cover: COVER }));
    for (const v2 of [PILE_V2, SHOP_V2]) {
      updateV2(() => v2);
      const before = specNow();
      reload();
      expect(currentV2Choices()).toEqual(v2);
      expect(specNow()).toBe(before);
    }
  });

  it('a choice is written at once (no typing delay), in the draft’s own key: no new key', () => {
    seedCollection();
    updateV2((v2) => ({ ...v2, pickFeeBps: 500 }));
    expect((stored()?.v2 as { v2: V2Choices }).v2.pickFeeBps).toBe(500);
    expect(Object.keys(window.sessionStorage).sort()).toEqual([...KEYS].sort());
  });

  it('a choice made before anything is typed is kept too; Start over leaves nothing stored', () => {
    updateV2((v2) => ({ ...v2, sellers: pickFor('keep') }));
    reload();
    expect(choiceSellers()).toEqual(pickFor('keep'));
    clearDraft();
    clearV2();
    expect(Object.keys(window.sessionStorage)).toEqual([]);
    reload();
    expectCleanStart();
  });

  it('a stored price coin that is no longer listed comes back as stored, and Create is refused until one is chosen', () => {
    const gone = '0xde00c00000000000000000000000000000000099';
    seedCollection({ ...COLLECTION_V2, pricing: gone });
    reload();
    expect(currentV2Choices().pricing).toBe(gone);
    const draft = currentDraft();
    const issues = v2Issues({ ...inputOf({ form: draft.form, art: draft.art, cover: draft.cover, collectionCover: draft.collectionCover }), owner: OWNER, nowMs: NOW, v2: currentV2Choices(), listings: DEMO_LISTINGS });
    expect(issues.map((issue) => issue.message)).toContain('Choose a current price coin.');
  });
});

const choiceSellers = () => currentV2Choices().sellers;

describe('SH-256: a stored draft without a whole v2 part starts clean, never as a mix', () => {
  /** A draft as today's live version writes it: the shared part only. */
  function storeLive() {
    seedCollection();
    reload();
    const live = stored() as Record<string, unknown>;
    delete live.v2;
    window.sessionStorage.setItem(KEY, JSON.stringify(live));
  }

  it('a draft saved by the version before (no v2 part) starts clean; its art (the salts) stays stored until the first change', () => {
    storeLive();
    const art = window.sessionStorage.getItem(ART_KEY);
    resetDraftForTests();
    expectCleanStart();
    expect(window.sessionStorage.getItem(ART_KEY)).toBe(art);
    // The same again on the next reload, until the creator changes something; then the old draft's keys are gone whole.
    resetDraftForTests();
    expectCleanStart();
    updateDraft((draft) => ({ ...draft, form: { ...draft.form, name: 'New' } }));
    expect(window.sessionStorage.getItem(ART_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(COVER_KEY)).toBeNull();
    reload();
    expect(currentDraft().form.name).toBe('New');
    expect(currentDraft().art).toBeNull();
    expect(currentDraft().cover).toBeNull();
    expect(currentV2Choices()).toEqual(DEFAULT_V2);
  });

  it('a first change of the choices alone also clears the old draft before it is written', () => {
    storeLive();
    resetDraftForTests();
    updateV2((v2) => ({ ...v2, pickFeeBps: 100 }));
    reload();
    expect(currentDraft().art).toBeNull();
    expect(currentDraft().form.description).toBe('');
    expect(currentV2Choices().pickFeeBps).toBe(100);
  });

  const corrupt: readonly (readonly [string, (part: Record<string, unknown>, v2: Record<string, unknown>) => void])[] = [
    ['an unknown fee choice', (_, v2) => { v2.buyers = { a: { leg: 9, dest: 9, to: null }, b: { leg: 0, dest: 0, to: null }, split: { kind: 'none' } }; }],
    ['a split pick', (_, v2) => { v2.sellers = { ...pickFor('burn'), split: { kind: 'share', bps: 5000 } }; }],
    ['an in-vault rule on a side that has none', (_, v2) => { v2.sellers = { ...pickFor('holders'), a: { ...pickFor('holders').a, inside: 2 } }; }],
    ['an in-vault rule that does not exist', (_, v2) => { v2.buyers = { ...pickFor('items'), a: { ...pickFor('items').a, inside: 4 } }; }],
    ['a pick fee outside the presets', (_, v2) => { v2.pickFeeBps = 300; }],
    ['a pick fee as text', (_, v2) => { v2.pickFeeBps = '100'; }],
    ['a deadline outside the presets', (_, v2) => { v2.deadlineDays = 45; }],
    ['a price coin that is no address', (_, v2) => { v2.pricing = 'ETH'; }],
    ['a pile with a leave-behind that is not offered', (_, v2) => { v2.pile = { asset: USDC, seed: '1', leaveBehindBps: 250 }; }],
    ['a pile seed as a number', (_, v2) => { v2.pile = { asset: USDC, seed: 1000 }; }],
    ['a pile and a shop together', (_, v2) => { v2.pile = { asset: USDC, seed: '1' }; v2.shop = newShop(); }],
    ['a shop with a pick multiple that is not offered', (_, v2) => { v2.shop = { ...newShop(), pickBps: 17_500 }; }],
    ['an unknown field', (_, v2) => { v2.extra = true; }],
    ['an unknown template', (part) => { part.template = 'nope'; }],
    ['a loaded marker that is not one', (part) => { part.loaded = { items: 'all' }; }],
    ['no choices at all', (part) => { delete part.v2; }],
  ];
  for (const [what, spoil] of corrupt) {
    it(`a stored v2 part with ${what} starts clean`, () => {
      seedCollection();
      reload();
      const value = stored() as Record<string, unknown>;
      const part = value.v2 as Record<string, unknown>;
      spoil(part, part.v2 as Record<string, unknown>);
      window.sessionStorage.setItem(KEY, JSON.stringify(value));
      resetDraftForTests();
      expectCleanStart();
    });
  }

  it('storage that throws: the draft and its choices still work in memory', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
    seedCollection();
    expect(currentV2Choices()).toEqual(COLLECTION_V2);
    expect(currentDraft().form.name).toBe('Paper Moons');
  });
});

describe('SH-256 (E5): no loaded setup comes back after a fresh document; inside one document its lock stays', () => {
  const TOKEN_SETUP: LoadedInfo = Object.freeze({ pileFollowsPrice: true, items: 0, hidden: false, note: 'The file’s price coin is not listed here: priced in ETH.' });
  /** As CreateV2Flow `loadSetup` installs one: both stores cleared, the draft, the choices, then the marker. */
  function load(info: LoadedInfo, collection = false) {
    clearDraft(); clearV2();
    updateDraft(() => ({ ...EMPTY_DRAFT, form: collection ? formOf() : tokenFormOf(), art: collection ? artOf(12) : null, cover: COVER, collectionCover: collection ? COLLECTION_COVER : null, page: collection ? PAGE : EMPTY_DRAFT.page }));
    updateV2(() => (collection ? COLLECTION_V2 : PILE_V2));
    setV2Loaded(info);
  }

  it('a loaded token setup: locked in its document; after a reload a clean start of both stores, unlocked', () => {
    load(TOKEN_SETUP);
    updateDraft((draft) => ({ ...draft, form: { ...draft.form, description: 'changed', name: 'Mine' }, cover: null }));
    expect(currentDraft().form.description).toBe(tokenFormOf().description);
    expect(currentDraft().form.name).toBe('Mine');
    expect(currentDraft().cover).toEqual(COVER);
    reload();
    expectCleanStart();
    updateDraft((draft) => ({ ...draft, form: { ...draft.form, description: 'free' } }));
    expect(currentDraft().form.description).toBe('free');
  });

  it('a loaded collection: a clean start of both stores after a reload', () => {
    load({ pileFollowsPrice: false, items: 12, hidden: false, note: null }, true);
    reload();
    expectCleanStart();
  });

  it('a stored marker edited to look like another setup (items 0, a changed deadline): still a clean start', () => {
    load({ pileFollowsPrice: false, items: 12, hidden: false, note: null }, true);
    flushDraft();
    const value = stored() as Record<string, unknown>;
    const part = value.v2 as Record<string, unknown>;
    part.loaded = { pileFollowsPrice: false, items: 0, hidden: false, note: null };
    (part.v2 as Record<string, unknown>).deadlineDays = 90;
    window.sessionStorage.setItem(KEY, JSON.stringify(value));
    resetDraftForTests();
    expectCleanStart();
  });

  it('Start over after a loaded setup: nothing stored, nothing locked', () => {
    load(TOKEN_SETUP);
    clearDraft(); clearV2();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    reload();
    expectCleanStart();
    updateDraft((draft) => ({ ...draft, form: { ...draft.form, description: 'free' } }));
    expect(currentDraft().form.description).toBe('free');
  });
});

describe('SH-256 (E6): a document back from the back/forward cache reads storage again', () => {
  const pageshow = (persisted: boolean) => {
    const event = new Event('pageshow');
    Object.defineProperty(event, 'persisted', { value: persisted });
    window.dispatchEvent(event);
  };
  it('its in-memory draft (A) is dropped for the stored one (B, written by the next document), so A never writes over B', () => {
    // Document A's draft, in memory and stored.
    seedCollection();
    flushDraft();
    const a = Object.fromEntries(KEYS.map((key) => [key, window.sessionStorage.getItem(key)]));
    // Document B, opened from the Examples page in the same tab, changes the art and the name, and stores them.
    resetDraftForTests();
    updateDraft((draft) => ({ ...draft, form: { ...draft.form, name: 'Second' }, art: artOf(11) }));
    flushDraft();
    const b = Object.fromEntries(KEYS.map((key) => [key, window.sessionStorage.getItem(key)]));
    // Back to A: its memory is A's (as the cache kept it), the storage B's.
    for (const [key, value] of Object.entries(a)) if (value === null) window.sessionStorage.removeItem(key); else window.sessionStorage.setItem(key, value);
    resetDraftForTests();
    expect(currentDraft().form.name).toBe('Paper Moons');
    for (const [key, value] of Object.entries(b)) if (value === null) window.sessionStorage.removeItem(key); else window.sessionStorage.setItem(key, value);
    pageshow(false);
    expect(currentDraft().form.name).toBe('Paper Moons');
    pageshow(true);
    expect(currentDraft().form.name).toBe('Second');
    expect(currentDraft().art?.items).toHaveLength(11);
    // A fee change now writes B's draft with it: a reload gives that one whole.
    updateV2((v2) => ({ ...v2, pickFeeBps: 500 }));
    reload();
    expect(currentDraft().form.name).toBe('Second');
    expect(currentDraft().art?.items).toHaveLength(11);
    expect(currentV2Choices().pickFeeBps).toBe(500);
  });
});

describe('SH-256 (E10): no valid draft is dropped by a storage text limit', () => {
  it('a pile seed with spaces around it is stored trimmed and comes back; the Overview reads the same amount', () => {
    updateDraft((draft) => ({ ...draft, form: tokenFormOf({ rights: true }), cover: COVER }));
    updateV2(() => ({ ...PILE_V2, pile: { asset: USDC, seed: `${' '.repeat(120)}1000.25${' '.repeat(120)}`, leaveBehindBps: 500 } }));
    const before = specNow();
    reload();
    expect(currentV2Choices().pile).toEqual({ asset: USDC, seed: '1000.25', leaveBehindBps: 500 });
    expect(specNow()).toBe(before);
  });
  it('5,000 starter ids of 20 digits in one shop row come back', () => {
    const ids = Array.from({ length: 5_000 }, (_, i) => (10n ** 19n + BigInt(i)).toString()).join(', ');
    updateDraft((draft) => ({ ...draft, form: tokenFormOf({ rights: true }), cover: COVER }));
    updateV2(() => ({ ...SHOP_V2, shop: { ...(SHOP_V2.shop as NonNullable<V2Choices['shop']>), collections: [{ address: OWNER, tier: 1, ids }] } }));
    reload();
    expect(currentV2Choices().shop?.collections[0]?.ids).toBe(ids);
  });
  it('a curator address that is not in use (the curator is not "another address") is not stored', () => {
    updateDraft((draft) => ({ ...draft, form: tokenFormOf({ rights: true }), cover: COVER }));
    const typed = `0x${'ab'.repeat(20)}`;
    updateV2(() => ({ ...SHOP_V2, shop: { ...(SHOP_V2.shop as NonNullable<V2Choices['shop']>), curator: 'none', curatorAddress: typed } }));
    expect(JSON.stringify(stored())).not.toContain('ab'.repeat(20));
    reload();
    expect(currentV2Choices().shop).toMatchObject({ curator: 'none', curatorAddress: '' });
  });
});

it('SH-256: the stored choices never hold a bigint or a number for an amount (decimal text only)', () => {
  updateDraft((draft) => ({ ...draft, form: tokenFormOf() }));
  updateV2(() => PILE_V2);
  const part = (stored()?.v2 as { v2: { pile: { seed: unknown } } }).v2;
  expect(part.pile.seed).toBe('1000.25');
});

it('SH-256: the stored defaults are the literal the browser specs seed (e2e/box-helpers.ts STORED_V2_DEFAULTS, STORED_NO_PARTS)', () => {
  const burn = { a: { leg: 2, dest: 1, to: null }, b: { leg: 0, dest: 0, to: null }, split: { kind: 'none' } };
  expect(JSON.parse(JSON.stringify(moneyJson(EMPTY_MONEY)))).toEqual({
    v2: { pricing: '0x0000000000000000000000000000000000000000', buyers: burn, sellers: burn, pickFeeBps: 2500, deadlineDays: 30, pile: null, shop: null },
    template: null, loaded: null,
  });
  updateV2(() => ({ ...DEFAULT_V2 }));
  expect((stored() as { parts: unknown }).parts).toEqual({ art: null, cover: null, collectionCover: null, page: null });
});
