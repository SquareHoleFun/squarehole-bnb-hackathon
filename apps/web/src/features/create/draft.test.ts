/**
 * The draft (box creation flow § 6 "Draft restored"): kept per tab, restored after a reload, checked field by field
 * because storage is untrusted, and a downloaded reveal file belongs to the art it was made from. The art, the logo,
 * the collection cover and the collection page's pictures are written only when they change; typing is saved shortly
 * after the last change. A v1 draft is mapped once into v2 ("v1 draft found"). The raise is never stored (F74 U5).
 */
import { sha256Hex } from '@squarehole/artwork';
import { CapExcess, QStream, TStream } from '@squarehole/box-spec';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toBase64 } from './art-files';
import { DEFAULT_FORM, type ArtState } from './create-model';
import { EMPTY_DRAFT, SAVE_DELAY_MS, clearDraft, currentDraft, flushDraft, parseStoredDraft, resetDraftForTests, updateDraft } from './draft';
import { COLLECTION_COVER, COVER, PAGE, artOf, formOf } from './test-support/fixtures';
import { glbOf } from './test-support/models';

const KEY = 'sh.create.draft.v2';
const ART_KEY = 'sh.create.art.v2';
const COVER_KEY = 'sh.create.cover.v2';
const COLLECTION_COVER_KEY = 'sh.create.collection-cover.v2';
const PAGE_KEY = 'sh.create.page.v2';

beforeEach(() => {
  window.sessionStorage.clear();
  resetDraftForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  resetDraftForTests();
});

describe('the draft', () => {
  it('starts empty, keeps changes and restores them after a reload, marked restored', () => {
    expect(currentDraft()).toBe(EMPTY_DRAFT);
    const links = { website: 'https://moons.example', x: '@moons', telegram: '' };
    updateDraft((draft) => ({
      ...draft,
      form: formOf({ firstIn: '0.05', specials: [{ label: 'Gold', count: '3' }], links, qStream: QStream.CREATOR_IN_T, tStream: TStream.CREATOR_IN_Q, capPerEpoch: 4n * 10n ** 18n, capExcess: CapExcess.POOL_DEPTH, rights: true }),
      art: artOf(10),
      cover: COVER,
      collectionCover: COLLECTION_COVER,
      page: PAGE,
    }));
    expect(window.sessionStorage.getItem(COLLECTION_COVER_KEY)).toBe(COLLECTION_COVER.data);
    // F74 U5: the raise is the version's, never stored with the choices.
    expect(Object.keys(JSON.parse(window.sessionStorage.getItem(KEY) ?? '{}').form)).not.toContain('raise');
    resetDraftForTests();
    const restored = currentDraft();
    expect(restored.restored).toBe(true);
    expect(restored.form).toMatchObject({ name: 'Paper Moons', contents: 'collection', firstIn: '0.05', specials: [{ label: 'Gold', count: '3' }], links, qStream: 6, tStream: 6, capPerEpoch: 4n * 10n ** 18n, capExcess: 3, rights: true });
    expect(restored.art?.items).toHaveLength(10);
    expect(restored.art?.salts).toEqual(artOf(10).salts);
    expect(restored.cover).toEqual(COVER);
    expect(restored.collectionCover).toEqual(COLLECTION_COVER);
    expect(restored.page).toEqual(PAGE);
  });

  it('SH-EX-O1: a loaded setup’s own hidden picture comes back after a reload; a draft saved before has the neutral one', () => {
    const own = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#F4E9D8"/></svg>';
    updateDraft((draft) => ({ ...draft, form: formOf({ artMode: 'hidden', hiddenSvg: own }) }));
    flushDraft();
    resetDraftForTests();
    expect(currentDraft().form.hiddenSvg).toBe(own);
    const stored = JSON.parse(window.sessionStorage.getItem(KEY) ?? '{}') as { form: Record<string, unknown> };
    expect(stored.form.hiddenSvg).toBe(own);
    const before: Record<string, unknown> = { ...stored.form };
    delete before.hiddenSvg;
    expect(parseStoredDraft(JSON.stringify({ ...stored, form: before }))?.form.hiddenSvg).toBe(DEFAULT_FORM.hiddenSvg);
    // Storage is untrusted: more than the add-on's 4,096 characters, or no text, drops the draft.
    expect(parseStoredDraft(JSON.stringify({ ...stored, form: { ...before, hiddenSvg: 'x'.repeat(4_097) } }))).toBeNull();
    expect(parseStoredDraft(JSON.stringify({ ...stored, form: { ...before, hiddenSvg: 7 } }))).toBeNull();
  });

  it('F74 U1: a Demo draft with holder payouts is kept (the page names it where they are not offered)', () => {
    updateDraft((draft) => ({ ...draft, form: formOf({ qStream: QStream.HOLDERS_IN_T, tStream: TStream.PAY_HOLDERS_T, capExcess: CapExcess.HOLDERS }) }));
    flushDraft();
    resetDraftForTests();
    expect(currentDraft().form).toMatchObject({ qStream: QStream.HOLDERS_IN_T, tStream: TStream.PAY_HOLDERS_T, capExcess: CapExcess.HOLDERS });
  });

  it('SH-256: a v1 draft found starts clean: no mapping, its three keys and the five v2 keys go', () => {
    // Every v2 key holds something first (H5): the choices, the art, the logo, the collection cover and the page.
    updateDraft((draft) => ({ ...draft, form: formOf(), art: artOf(10), cover: COVER, collectionCover: COLLECTION_COVER, page: PAGE }));
    flushDraft();
    for (const key of [KEY, ART_KEY, COVER_KEY, COLLECTION_COVER_KEY, PAGE_KEY]) expect(window.sessionStorage.getItem(key), key).not.toBeNull();
    window.sessionStorage.setItem('sh.create.draft.v1', JSON.stringify({ form: { name: 'Paper Moons', fee: 'to-creator' }, cover: null, revealSaved: false }));
    window.sessionStorage.setItem('sh.create.art.v1', JSON.stringify(artOf(10)));
    window.sessionStorage.setItem('sh.create.cover.v1', COVER.data);
    resetDraftForTests();
    expect(currentDraft()).toBe(EMPTY_DRAFT);
    for (const key of ['sh.create.draft.v1', 'sh.create.art.v1', 'sh.create.cover.v1', KEY, ART_KEY, COVER_KEY, COLLECTION_COVER_KEY, PAGE_KEY]) expect(window.sessionStorage.getItem(key), key).toBeNull();
    resetDraftForTests();
    expect(currentDraft()).toBe(EMPTY_DRAFT);
  });

  it('a new art voids a saved reveal file’s acknowledgement; clearing starts over', () => {
    const ack = { format: 2, root: `0x${'ab'.repeat(32)}` as const };
    updateDraft((draft) => ({ ...draft, art: artOf(10) }));
    updateDraft((draft) => ({ ...draft, revealSavedFor: ack }));
    expect(currentDraft().revealSavedFor).toEqual(ack);
    updateDraft((draft) => ({ ...draft, form: { ...draft.form, name: 'X' } }));
    expect(currentDraft().revealSavedFor).toEqual(ack);
    updateDraft((draft) => ({ ...draft, art: artOf(11) }));
    expect(currentDraft().revealSavedFor).toBeNull();
    updateDraft((draft) => ({ ...draft, page: PAGE, collectionCover: COLLECTION_COVER }));
    expect(window.sessionStorage.getItem(PAGE_KEY)).not.toBeNull();
    clearDraft();
    expect(currentDraft()).toBe(EMPTY_DRAFT);
    for (const key of [KEY, ART_KEY, COVER_KEY, COLLECTION_COVER_KEY, PAGE_KEY]) expect(window.sessionStorage.getItem(key), key).toBeNull();
  });

  it('writes the art and the cover only when they change; typing is saved after a pause or when the page is hidden', () => {
    vi.useFakeTimers();
    try {
      updateDraft((draft) => ({ ...draft, form: formOf(), art: artOf(10), cover: COVER }));
      expect(window.sessionStorage.getItem(COVER_KEY)).toBe(COVER.data);
      const setItem = vi.spyOn(Storage.prototype, 'setItem');
      for (const name of ['P', 'Pa', 'Pap']) updateDraft((draft) => ({ ...draft, form: { ...draft.form, name } }));
      expect(setItem).not.toHaveBeenCalled();
      vi.advanceTimersByTime(SAVE_DELAY_MS);
      // One write, of the choices only: the art (10 items here, up to 10,000) is not serialised again.
      expect(setItem.mock.calls.map(([key]) => key)).toEqual([KEY]);
      updateDraft((draft) => ({ ...draft, form: { ...draft.form, name: 'Paper' } }));
      window.dispatchEvent(new Event('pagehide'));
      expect(setItem.mock.calls.map(([key]) => key)).toEqual([KEY, KEY]);
      flushDraft();
      resetDraftForTests();
      expect(currentDraft().form.name).toBe('Paper');
      expect(currentDraft().art?.items).toHaveLength(10);
      expect(currentDraft().cover).toEqual(COVER);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a draft saved with a share-of-the-raise cap (before F74 U2) comes back with the cap off, marked so once', () => {
    // Before F74 U2 a draft stored the cap as a share of the raise (capBps) and had no capPerEpoch.
    const older = (capBps: number) => {
      const form: Record<string, unknown> = { ...DEFAULT_FORM, qStream: QStream.TO_CREATOR, capBps };
      delete form.capPerEpoch;
      return JSON.stringify({ form, cover: null, revealSaved: false });
    };
    const reset = parseStoredDraft(older(2500));
    expect(reset?.form.capPerEpoch).toBe(0n);
    expect(reset?.capReset).toBe(true);
    // Off before as well: nothing was reset.
    expect(parseStoredDraft(older(0))?.capReset).toBe(false);
    const today = JSON.stringify({ form: { ...DEFAULT_FORM, capPerEpoch: (4n * 10n ** 18n).toString() }, cover: null, revealSaved: false });
    expect(parseStoredDraft(today)?.capReset).toBe(false);
    // Any change ends the notice with "Draft restored".
    expect(EMPTY_DRAFT.capReset).toBe(false);
  });

  it('drops a stored draft with anything out of place (untrusted storage)', () => {
    const good = JSON.stringify({ form: { ...DEFAULT_FORM, capPerEpoch: DEFAULT_FORM.capPerEpoch.toString() }, cover: null, revealSaved: false });
    expect(parseStoredDraft(good)?.form).toEqual(DEFAULT_FORM);
    const bad = (patch: Record<string, unknown>, part: 'form' | 'cover' | 'collectionCover' = 'form') => {
      const value = JSON.parse(good) as Record<string, Record<string, unknown> | null>;
      value[part] = part === 'form' ? { ...value.form, ...patch } : patch;
      return parseStoredDraft(JSON.stringify(value), { coverData: COVER.data, collectionCoverData: COLLECTION_COVER.data });
    };
    // F74 U5: a stored raise (an older draft) is ignored, whatever it says.
    expect(bad({ raise: 'lots' })?.form).toEqual(DEFAULT_FORM);
    expect(bad({ deadlineDays: 45 })).toBeNull();
    // F74 U1: holder kinds are kept (the Demo offers them); values no network offers, BP-13's pair and off presets are not.
    expect(bad({ qStream: QStream.HOLDERS_IN_T })?.form.qStream).toBe(QStream.HOLDERS_IN_T);
    expect(bad({ tStream: TStream.PAY_HOLDERS_T })?.form.tStream).toBe(TStream.PAY_HOLDERS_T);
    expect(bad({ capExcess: CapExcess.HOLDERS })?.form.capExcess).toBe(CapExcess.HOLDERS);
    expect(bad({ qStream: 8 })).toBeNull();
    expect(bad({ qStream: QStream.BURN_Q })).toBeNull();
    expect(bad({ qStream: QStream.BUYBACK_BURN_T, tStream: TStream.SELL_FOR_Q })).toBeNull();
    expect(bad({ capPerEpoch: '5000000000000000000' })).toBeNull();
    expect(bad({ capExcess: 4 })).toBeNull();
    // The collection cover (F74 U3): its bytes must be the ones its hash names, like the logo's.
    expect(bad({ sha256: COLLECTION_COVER.sha256, url: COLLECTION_COVER.url, bytes: COLLECTION_COVER.bytes }, 'collectionCover')?.collectionCover).toEqual(COLLECTION_COVER);
    expect(bad({ sha256: COVER.sha256, url: null, bytes: COVER.bytes }, 'collectionCover')).toBeNull();
    expect(bad({ contents: 'existing' })).toBeNull();
    expect(bad({ links: { website: 'x'.repeat(500), x: '', telegram: '' } })).toBeNull();
    expect(bad({ rights: 'yes' })).toBeNull();
    expect(bad({ royaltyBps: 300 })).toBeNull();
    // A preset by its id; a draft saved before F80 named it by blocks (1 = Now, 25, 300, 7,200) and keeps it; no other.
    expect(bad({ open: { kind: 'preset', id: 'now' } })?.form.open).toEqual({ kind: 'preset', id: 'now' });
    expect(bad({ open: { kind: 'preset', id: '2h' } })).toBeNull();
    expect(bad({ open: { kind: 'preset', blocks: 1 } })?.form.open).toEqual({ kind: 'preset', id: 'now' });
    expect(bad({ open: { kind: 'preset', blocks: 300 } })?.form.open).toEqual({ kind: 'preset', id: '1h' });
    expect(bad({ open: { kind: 'preset', blocks: 7_200 } })?.form.open).toEqual({ kind: 'preset', id: '24h' });
    expect(bad({ open: { kind: 'preset', blocks: 2 } })).toBeNull();
    expect(bad({ open: { kind: 'preset', blocks: 0 } })).toBeNull();
    // A picked time is UTC; one saved before F80 was this browser's local time: the same moment, written in UTC.
    expect(bad({ open: { kind: 'time', utc: '2026-10-03T13:00' } })?.form.open).toEqual({ kind: 'time', utc: '2026-10-03T13:00' });
    const local = new Date(2026, 9, 3, 20, 30);
    const localText = `2026-10-03T20:30`;
    expect(bad({ open: { kind: 'time', at: localText } })?.form.open).toEqual({ kind: 'time', utc: local.toISOString().slice(0, 16) });
    expect(bad({ open: { kind: 'time', at: 'soon' } })?.form.open).toEqual({ kind: 'time', utc: 'soon' });
    expect(bad({ open: { kind: 'time', utc: 'x'.repeat(41) } })).toBeNull();
    expect(bad({ name: 'x'.repeat(5_000) })).toBeNull();
    expect(bad({ qIndex: 7 })).toBeNull();
    expect(bad({ sha256: 'nope', url: null, bytes: 1 }, 'cover')).toBeNull();
    expect(bad({ sha256: COVER.sha256, url: 'javascript:alert(1)', bytes: COVER.bytes }, 'cover')).toBeNull();
    expect(bad({ sha256: COVER.sha256, url: null, bytes: COVER.bytes }, 'cover')?.cover).toEqual(COVER);
    // The cover's bytes must be the ones its hash names.
    const withCover = JSON.stringify({ ...JSON.parse(good), cover: { sha256: COVER.sha256, url: null, bytes: COVER.bytes } });
    expect(parseStoredDraft(withCover, { coverData: toBase64(new TextEncoder().encode('other bytes')) })).toBeNull();
    expect(parseStoredDraft(withCover, { coverData: 'not base64!' })).toBeNull();
    // No stored bytes (storage was full): no cover, the page asks for it again.
    expect(parseStoredDraft(withCover)?.cover).toBeNull();
    const art = (patch: Record<string, unknown>) => parseStoredDraft(good, { art: JSON.stringify({ ...artOf(10), ...patch }) });
    expect(art({})?.art?.items).toHaveLength(10);
    expect(art({ salts: ['0x00'] })).toBeNull();
    expect(art({ thumbs: ['data:image/svg+xml;base64,PHN2Zz4='] })).toBeNull();
    expect(art({ problems: ['a', 'b', 'c', 'd'] })).toBeNull();
    // SH-AI-PLAN: art dealt from a plan keeps saying so after a reload (its table is sorted: the same commitment).
    expect(art({ planned: true })?.art?.planned).toBe(true);
    expect(art({})?.art?.planned).toBeUndefined();
    expect(art({ planned: 'yes' })).toBeNull();
    expect(art({ planned: false })).toBeNull();
    expect(parseStoredDraft(good, { art: '{oops' })).toBeNull();
    // The page's pictures: each must be the bytes its hash names; at most 4 teasers.
    expect(parseStoredDraft(good, { page: JSON.stringify(PAGE) })?.page).toEqual(PAGE);
    expect(parseStoredDraft(good, { page: JSON.stringify({ ...PAGE, banner: { ...PAGE.banner, data: COVER.data } }) })).toBeNull();
    expect(parseStoredDraft(good, { page: JSON.stringify({ banner: null, teasers: [...PAGE.teasers, ...PAGE.teasers] }) })).toBeNull();
    expect(parseStoredDraft(good, { page: JSON.stringify({ banner: { ...PAGE.banner, url: 'javascript:alert(1)' }, teasers: [] }) })).toBeNull();
    expect(parseStoredDraft('{oops')).toBeNull();
    expect(parseStoredDraft(null)).toBeNull();
  });

  // R74-ART (SH-CREATE-ITEM-MODELS): each item's model hash and size are part of the stored art; never its bytes.
  it('keeps each item’s model hash and size across a reload (never the model’s bytes); a 2D draft is stored as before', () => {
    const models = (art: ArtState): ArtState => ({ ...art, items: art.items.map((item) => ({ ...item, modelSha256: sha256Hex(glbOf(item.id)), modelBytes: glbOf(item.id).byteLength })) });
    const art = models(artOf(10));
    updateDraft((draft) => ({ ...draft, form: formOf(), art }));
    const stored = window.sessionStorage.getItem(ART_KEY) ?? '';
    expect(stored).not.toContain('glTF');
    resetDraftForTests();
    const restored = currentDraft().art;
    expect(restored?.items.map((item) => item.modelSha256)).toEqual(art.items.map((item) => item.modelSha256));
    expect(restored?.items.map((item) => item.modelBytes)).toEqual(art.items.map((item) => item.modelBytes));
    expect(restored?.totalBytes).toBe(10 * 1_000 + art.items.reduce((sum, item) => sum + (item.modelBytes ?? 0), 0));
    // A 2D draft's stored art has no model fields at all, as before.
    window.sessionStorage.clear(); resetDraftForTests();
    updateDraft((draft) => ({ ...draft, form: formOf(), art: artOf(10) }));
    expect(window.sessionStorage.getItem(ART_KEY)).toBe(JSON.stringify(artOf(10)));
    resetDraftForTests();
    expect(currentDraft().art?.items.some((item) => 'modelSha256' in item)).toBe(false);
  });

  it('drops stored model data that is out of place: a bad hash, a size over one block, half a model, or models on some items only', () => {
    const good = JSON.stringify({ form: { ...DEFAULT_FORM, capPerEpoch: DEFAULT_FORM.capPerEpoch.toString() }, cover: null });
    const withModels = (patch: (item: ArtState['items'][number]) => Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      parseStoredDraft(good, { art: JSON.stringify({ ...artOf(10), items: artOf(10).items.map((item) => ({ ...item, ...patch(item) })), ...extra }) });
    const model = (item: ArtState['items'][number]) => ({ modelSha256: sha256Hex(glbOf(item.id)), modelBytes: glbOf(item.id).byteLength });
    expect(withModels(model)?.art?.items[0]?.modelSha256).toBe(sha256Hex(glbOf(1)));
    expect(withModels((item) => ({ ...model(item), modelSha256: 'nope' }))).toBeNull();
    expect(withModels((item) => ({ ...model(item), modelSha256: `0x${'0'.repeat(64)}` }))).toBeNull();
    expect(withModels((item) => ({ ...model(item), modelSha256: sha256Hex(glbOf(item.id)).toUpperCase().replace('0X', '0x') }))).toBeNull();
    expect(withModels((item) => ({ ...model(item), modelBytes: 1_048_577 }))).toBeNull();
    expect(withModels((item) => ({ ...model(item), modelBytes: 0 }))).toBeNull();
    expect(withModels((item) => ({ modelSha256: model(item).modelSha256 }))).toBeNull();
    expect(withModels((item) => (item.id === 3 ? {} : model(item)))).toBeNull();
    // Art with problems (a missing model named, say) is kept as read: the page shows its problems again.
    expect(withModels((item) => (item.id === 3 ? {} : model(item)), { problems: ['Missing models for ids 3: add a model for every picture, or none.'] })?.art?.problems).toHaveLength(1);
  });

  // SH-256 (E3): before, the choices came back without the art that did not fit; now the draft is whole or a clean start.
  it('art too large for storage: the draft stays in memory, a reload starts clean; storage that throws works in memory', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new Error('QuotaExceededError');
    });
    updateDraft((draft) => ({ ...draft, form: formOf(), art: artOf(10) }));
    expect(setItem.mock.calls.map(([key]) => key)).toEqual([ART_KEY, KEY]);
    expect(currentDraft().art?.items).toHaveLength(10);
    resetDraftForTests();
    expect(currentDraft()).toBe(EMPTY_DRAFT);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    updateDraft((draft) => ({ ...draft, form: formOf({ name: 'In memory' }) }));
    expect(currentDraft().form.name).toBe('In memory');
  });
  it('SH-256 H2: a choices save with the same art does not serialise the art again', () => {
    const art = artOf(10);
    updateDraft((draft) => ({ ...draft, form: formOf(), art }));
    const stringify = vi.spyOn(JSON, 'stringify');
    updateDraft((draft) => ({ ...draft, form: { ...draft.form, name: 'P' } }));
    flushDraft();
    updateDraft((draft) => ({ ...draft, form: { ...draft.form, name: 'Pa' } }));
    flushDraft();
    expect(stringify.mock.calls.filter(([value]) => value === art)).toHaveLength(0);
    expect(stringify.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  describe('SH-256 (E3): whole means all five keys', () => {
    const seed = () => {
      updateDraft((draft) => ({ ...draft, form: formOf(), art: artOf(10), cover: COVER, collectionCover: COLLECTION_COVER, page: PAGE }));
      flushDraft();
    };
    it('a draft with every part comes back whole', () => {
      seed();
      resetDraftForTests();
      expect(currentDraft()).toMatchObject({ restored: true, art: artOf(10), cover: COVER, collectionCover: COLLECTION_COVER, page: PAGE });
    });
    for (const key of [ART_KEY, COVER_KEY, COLLECTION_COVER_KEY, PAGE_KEY]) {
      it(`its part under ${key} missing: a clean start`, () => {
        seed();
        window.sessionStorage.removeItem(key);
        resetDraftForTests();
        expect(currentDraft()).toBe(EMPTY_DRAFT);
      });
    }
    it('another valid art, or another valid page, beside the choices: a clean start', () => {
      seed();
      window.sessionStorage.setItem(ART_KEY, JSON.stringify(artOf(11)));
      resetDraftForTests();
      expect(currentDraft()).toBe(EMPTY_DRAFT);
      window.sessionStorage.clear(); resetDraftForTests();
      seed();
      window.sessionStorage.setItem(PAGE_KEY, JSON.stringify({ banner: null, teasers: PAGE.teasers }));
      resetDraftForTests();
      expect(currentDraft()).toBe(EMPTY_DRAFT);
    });
    it('an older choices key beside a newer art (its write did not fit): a clean start', () => {
      seed();
      const older = window.sessionStorage.getItem(KEY) ?? '';
      updateDraft((draft) => ({ ...draft, art: artOf(12) }));
      window.sessionStorage.setItem(KEY, older);
      resetDraftForTests();
      expect(currentDraft()).toBe(EMPTY_DRAFT);
    });
    it('a logo that did not fit: a clean start after a reload', () => {
      const real = Storage.prototype.setItem;
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
        if (key === COVER_KEY) throw new Error('QuotaExceededError');
        real.call(this, key, value);
      });
      seed();
      expect(window.sessionStorage.getItem(COVER_KEY)).toBeNull();
      resetDraftForTests();
      expect(currentDraft()).toBe(EMPTY_DRAFT);
    });
  });
});
