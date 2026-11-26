/**
 * TA-27 Load settings: a BoxSpec file this page downloads loads back as its whole setup (every example configuration
 * rebuilds the same spec), item pictures are checked against the setup, only the five choices and the creator’s own
 * links (the collection page's link among them) change afterwards, and a new price coin carries what depends on it or
 * refuses what the setup cannot keep.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '@squarehole/artwork';
import { AddOnId, decodeCollectionMetadataParams, decodePlaceholdersParams, encodeCollectionMetadataParams } from '@squarehole/box-spec';
import { afterEach, describe, expect, it } from 'vitest';
import { shopConfigV2, starterCommitmentV2 } from '../../../../../../packages/chain/src/core/v2';
import { required } from '../../core/v2/test-support/required';
import { makePng } from '../../../../../../packages/artwork/src/test-support/images';
import { readArt, toBase64, type ArtEnvironment } from '../art-files';
import { DEFAULT_FORM, ZERO32, commitArt, effectivePageLink, revealList, type ArtState, type CoverState, type PageState } from '../create-model';
import { EMPTY_DRAFT } from '../draft';
import { forgetItemFiles, keepItemFiles } from '../item-files';
import { CONTROL } from '../reason-copy';
import { NOW, OWNER, formOf, inputOf } from '../test-support/fixtures';
import { CONFIGURATIONS } from './test-support/example-configurations';
import { inputV2Of } from './test-support/v2-fixtures';
import { DEMO_LISTINGS, NATIVE_TOKEN, RAISE_ETH, type SiteListing } from './listings';
import { DEFAULT_V2, boxSpecFile, buildSpecV2, recipeCtx, type BuildV2Input, type V2Choices } from './model';
import { committedModels, committedPictures } from './pictures';
import { NOT_A_GLB, glbOf } from '../test-support/models';
import { INSIDE, choiceOf, pickFor } from './recipes';
import { SHOP_CONTROL, starterItemsOf, type CollectionCheck, type ShopChoice } from './shop';
import { BoxTypeV2, ListingClass, ListingKind, encodeBoxSpecV2, specHashV2, type BoxSpecV2 } from './spec-types';
import {
  EDITABLE_FORM, LOAD_WORDS, UNASKED, finishLoad, itemsProblem, lockedDraft, lockedFormPatch, lockedIssue, lockedV2Patch, pickOfSide, readSettingsFile, rebuildProblem, repriceLoaded, setupOf, withStarters,
  type LoadedDraft, type LoadedInfo, type LoadedSetup,
} from './load-settings';
import { sideOf } from './recipes';
import { decodeMetadataTable } from '../../boxes/spec-record';

const digest = async (bytes: Uint8Array) => sha256Hex(bytes);
const noThumb = async () => null;
const coin = (symbol: string): SiteListing => {
  const found = DEMO_LISTINGS.find((listing) => listing.symbol === symbol);
  if (!found) throw new Error(symbol);
  return found;
};
const png = (width: number, height = width) => makePng({ width, height, decodable: true });
const pictureOf = (bytes: Uint8Array): CoverState => ({ sha256: sha256Hex(bytes), url: null, bytes: bytes.byteLength, data: toBase64(bytes) });
const LOGO = pictureOf(png(300));
const COLLECTION_COVER = pictureOf(png(301));
const PAGE_PICTURES: PageState = { banner: pictureOf(png(800, 200)), teasers: [pictureOf(png(302)), pictureOf(png(303))] };

let salt = 0;
const env: ArtEnvironment = {
  digest,
  thumbnail: async () => null,
  encodeCover: async (file) => ({ bytes: new Uint8Array(await file.arrayBuffer()) }),
  salt: () => sha256Hex(new TextEncoder().encode(`salt-${(salt += 1)}`)),
};
/** Ten item pictures (each its own bytes; a box holds 10 at least) and a traits file, as a creator would add them. */
const TEN = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const pictureFiles = (order: readonly number[] = TEN, offset = 40) => order.map((n, i) => new File([png(offset + n).slice().buffer], `${i + 1}.png`, { type: 'image/png' }));
const TRAITS = new File([['id,Colour', ...TEN.map((id) => `${id},${id % 2 ? 'Red' : 'Teal'}`)].join('\n')], 'traits.csv', { type: 'text/csv' });
const itemFiles = (order: readonly number[] = TEN) => [...pictureFiles(order), TRAITS];
const read = async (files: File[]): Promise<{ readonly art: ArtState; readonly files: Map<string, Blob> }> => {
  const kept = new Map<string, Blob>();
  const art = await readArt(files, { env, onItemFile: (sha256, file) => kept.set(sha256, file) });
  return { art, files: kept };
};

/** The page's own "Download BoxSpec" file for `input` (model.ts `boxSpecFile`, with every committed picture and model). */
async function downloaded(input: BuildV2Input): Promise<{ readonly spec: BoxSpecV2; readonly text: string }> {
  const spec = buildSpecV2(input);
  const { pictures, missing } = await committedPictures(spec, { cover: input.cover, collectionCover: input.collectionCover ?? null, page: input.page, art: input.art }, digest);
  const { models } = await committedModels(spec, { art: input.art });
  const open = input.form.contents === 'collection' && input.form.artMode === 'open' && input.art && input.commitment;
  const file = boxSpecFile(spec, recipeCtx(input), { pictures: missing.length === 0 ? pictures : pictures, models, revealList: open ? revealList(input.art as ArtState, input.commitment?.packed ?? []) : null });
  return { spec, text: file.parts.join('') };
}

async function collectionInput(v2: Partial<V2Choices> = {}, hidden = false): Promise<BuildV2Input> {
  const { art, files } = await read(itemFiles());
  keepItemFiles(files);
  const form = formOf({ name: 'Paper Moons', ticker: 'MOON', description: 'Moons, folded.', artMode: hidden ? 'hidden' : 'open', royaltyBps: 250, rights: true, pageLink: 'https://moons.example', pageLinkEdited: true, specials: [{ label: 'Gold', count: '1' }] });
  return {
    ...inputOf({ form, art, cover: LOGO, collectionCover: COLLECTION_COVER, page: PAGE_PICTURES }),
    v2: { ...DEFAULT_V2, pricing: coin('LINK').token, buyers: pickFor('items', INSIDE.keep), sellers: pickFor('burn'), pickFeeBps: 100, deadlineDays: 90, ...v2 },
    listings: DEMO_LISTINGS,
  };
}

async function load(text: string): Promise<LoadedSetup> {
  const file = await readSettingsFile(text, digest);
  if (!file.ok) throw new Error(file.error);
  const setup = await setupOf(file.value, DEMO_LISTINGS, noThumb);
  if (!setup.ok) throw new Error(setup.error);
  return setup.value;
}
type ShopChecks = ReadonlyMap<string, CollectionCheck | 'unknown'> | typeof UNASKED;
/** The last step of a load, as the page runs it: fresh salts from `env`, and a shop's collections as the chain answered. */
const finish = (setup: LoadedSetup, art: ArtState | null, listings: readonly SiteListing[] = DEMO_LISTINGS, shopChecks?: ShopChecks) =>
  finishLoad(setup, art, listings, NATIVE_TOKEN, NOW, { salt: env.salt, shopChecks });
const finished = (setup: LoadedSetup, art: ArtState | null, listings: readonly SiteListing[] = DEMO_LISTINGS, shopChecks?: ShopChecks): LoadedDraft => {
  const result = finish(setup, art, listings, shopChecks);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
/** Every starting collection of a loaded shop answered as an ERC-721 by the chain. */
const allErc721 = (setup: LoadedSetup): ShopChecks => new Map((setup.v2.shop?.collections ?? []).map((row): [string, CollectionCheck] => [row.address.toLowerCase(), 'erc721']));
/** The collection page's link (add-on 6), or null without the add-on. */
const pageLinkOf = (spec: BoxSpecV2): string | null => {
  const addOn = spec.addOns.find((entry) => entry.id === AddOnId.CollectionMetadata);
  return addOn ? decodeCollectionMetadataParams(addOn.params).externalLink : null;
};
/** `spec` with only its collection page link changed (add-on 6's banner and teasers kept). */
const withPageLink = (spec: BoxSpecV2, link: string): BoxSpecV2 => ({
  ...spec,
  addOns: spec.addOns.map((addOn) => (addOn.id === AddOnId.CollectionMetadata ? { ...addOn, params: encodeCollectionMetadataParams({ ...decodeCollectionMetadataParams(addOn.params), externalLink: link }) } : addOn)),
});
/** The spec the page builds from a loaded draft, for the creator `OWNER`. */
const rebuilt = (draft: LoadedDraft, listings: readonly SiteListing[] = DEMO_LISTINGS) => buildSpecV2({
  form: draft.form, art: draft.art, commitment: commitArt(draft.art, draft.form.artMode), cover: draft.cover, collectionCover: draft.collectionCover, page: draft.page, owner: OWNER, nowMs: NOW, v2: draft.v2, listings,
});

afterEach(() => forgetItemFiles());

describe('loading a settings file', () => {
  it('loads a collection’s whole setup; its own item pictures rebuild the same spec with new salts and no page link', async () => {
    const input = await collectionInput();
    const { spec, text } = await downloaded(input);
    const setup = await load(text);
    expect(setup.info).toEqual({ pileFollowsPrice: false, items: 10, hidden: false, note: null });
    expect(setup.form).toMatchObject({ name: 'Paper Moons', ticker: 'MOON', description: 'Moons, folded.', contents: 'collection', royaltyBps: 250, pageLink: 'https://moons.example', specials: [{ label: 'Gold', count: '1' }] });
    expect(setup.cover?.sha256).toBe(LOGO.sha256);
    expect(setup.page.teasers.map((teaser) => teaser.sha256)).toEqual(PAGE_PICTURES.teasers.map((teaser) => teaser.sha256));
    const again = await read(itemFiles());
    // The rebuild check takes the file as it is, its collection page link included.
    expect(rebuildProblem(setup, again.art, DEMO_LISTINGS)).toBeNull();
    const draft = finished(setup, again.art);
    expect(draft.v2.pricing).toBe(coin('LINK').token);
    const built = rebuilt(draft);
    // A new box: new salts, so a new root and reveal list; the page link starts empty; every other field is the file's.
    expect(built.revealRoot).not.toBe(spec.revealRoot);
    expect({ ...built, revealRoot: spec.revealRoot, revealListId: spec.revealListId }).toEqual(withPageLink(spec, ''));
  });

  it('every example configuration (token, pile, shop, hidden art, each price coin) loads back to the same spec', async () => {
    // A collection's file as the page downloads it: every picture, and open art's reveal list.
    const items = await read(itemFiles());
    keepItemFiles(items.files);
    for (const config of CONFIGURATIONS) {
      const base = inputV2Of(config);
      const collection = base.form.contents === 'collection';
      const input = { ...base, cover: LOGO, collectionCover: collection ? COLLECTION_COVER : null, art: collection ? items.art : null, commitment: collection ? commitArt(items.art, base.form.artMode) : null };
      const { spec, text } = await downloaded(input);
      const setup = await load(text);
      const draft = finished(setup, collection ? (await read(itemFiles())).art : null, DEMO_LISTINGS, setup.v2.shop ? allErc721(setup) : undefined);
      // A new box: new salts, so only the root and open art's reveal list id are its own.
      expect(specHashV2({ ...rebuilt(draft), revealRoot: spec.revealRoot, revealListId: spec.revealListId }), config.id).toBe(specHashV2(spec));
    }
  });

  it('a shop’s curator is the creator, never the file’s address', async () => {
    const config = CONFIGURATIONS.find((entry) => entry.id === 'curio-corner');
    if (!config) throw new Error('curio-corner');
    const input = { ...inputV2Of(config), cover: LOGO, owner: '0x00000000000000000000000000000000000000c5' as const };
    const spec = buildSpecV2(input);
    expect(spec.boxType).toBe(BoxTypeV2.SHOP);
    const setup = await load(boxSpecFile(spec, recipeCtx(input), { pictures: [{ role: 'logo', sha256: LOGO.sha256, bytes: png(300) }] }).parts.join(''));
    expect(setup.v2.shop?.curatorAddress.toLowerCase()).toBe('0x00000000000000000000000000000000000000c5');
    expect(finished(setup, null, DEMO_LISTINGS, allErc721(setup)).v2.shop).toMatchObject({ curator: 'creator', curatorAddress: '' });
  });

  it('refuses a damaged file, a missing or changed picture, and a file that is not a settings file', async () => {
    const { text } = await downloaded(await collectionInput());
    const body = JSON.parse(text) as Record<string, unknown>;
    const check = async (value: unknown) => readSettingsFile(JSON.stringify(value), digest);
    expect(await readSettingsFile('not json', digest)).toEqual({ ok: false, error: LOAD_WORDS.notJson });
    expect(await check({ ...body, format: 'squarehole.boxspec/1' })).toEqual({ ok: false, error: LOAD_WORDS.notJson });
    expect(await check({ ...body, specHash: `0x${'1'.repeat(64)}` })).toEqual({ ok: false, error: LOAD_WORDS.damaged });
    const pictures = body.pictures as { role: string; sha256: string; base64: string }[];
    const changed = pictures.map((picture) => (picture.role === 'logo' ? { ...picture, base64: toBase64(png(299)) } : picture));
    expect(await check({ ...body, pictures: changed })).toEqual({ ok: false, error: LOAD_WORDS.picture('the logo') });
    const script = pictures.map((picture) => (picture.role === 'banner' ? { ...picture, base64: btoa('<svg onload="x()"/>') } : picture));
    expect(await check({ ...body, pictures: script })).toEqual({ ok: false, error: LOAD_WORDS.picture('the banner') });
    const read = await check({ ...body, pictures: pictures.filter((picture) => picture.role !== 'collection cover') });
    if (!read.ok) throw new Error(read.error);
    expect(await setupOf(read.value, DEMO_LISTINGS, noThumb)).toEqual({ ok: false, error: LOAD_WORDS.picture('the collection cover') });
  });

  it('item pictures must be the setup’s: the count, each item’s own picture and traits', async () => {
    const setup = await load((await downloaded(await collectionInput())).text);
    const fewer = await read(pictureFiles(TEN.slice(0, 9)));
    expect(finish(setup, fewer.art)).toEqual({ ok: false, error: LOAD_WORDS.itemCount(10, 9) });
    const swapped = await read(itemFiles([2, 1, ...TEN.slice(2)]));
    expect(finish(setup, swapped.art)).toEqual({ ok: false, error: LOAD_WORDS.itemsNotSetup });
    const untraited = await read(pictureFiles());
    expect(finish(setup, untraited.art)).toEqual({ ok: false, error: LOAD_WORDS.itemsNotSetup });
    const other = await read([...pictureFiles(TEN, 90), TRAITS]);
    expect(finish(setup, other.art)).toEqual({ ok: false, error: LOAD_WORDS.itemsNotSetup });
    expect(finish(setup, null)).toEqual({ ok: false, error: LOAD_WORDS.itemCount(10, 0) });
  });

  it('hidden art loads with its pictures checked as a set and new salts (its reveal file is made again)', async () => {
    const input = await collectionInput({}, true);
    const { spec, text } = await downloaded(input);
    expect(JSON.parse(text).revealList).toBeNull();
    const setup = await load(text);
    expect(setup.info.hidden).toBe(true);
    // Hidden art's file says no item's picture: any order of the same pictures with the same traits table is the setup.
    const draft = finished(setup, (await read(itemFiles())).art);
    const built = rebuilt(draft);
    expect(built.revealRoot).not.toBe(spec.revealRoot);
    expect({ ...built, revealRoot: spec.revealRoot }).toEqual(withPageLink(spec, ''));
    const other = await read([...pictureFiles(TEN, 90), TRAITS]);
    expect(finish(setup, other.art)).toEqual({ ok: false, error: LOAD_WORDS.itemsNotSetup });
  });

  // SH-AI-PLAN fix round 1: hidden art's table is sorted; a file saved before (first-seen order) loads, re-sorted.
  it('hidden art saved with the old first-seen table and with the sorted one both load; the new box commits the sorted table', async () => {
    const toned = new File([['id,Tone,Band', ...TEN.map((id) => `${id},${id % 2 ? 'Zinc' : 'Amber'},${id < 6 ? 'North' : 'East'}`)].join('\n')], 'traits.csv', { type: 'text/csv' });
    const base = await collectionInput({}, true);
    const { art, files } = await read([...pictureFiles(), toned]);
    keepItemFiles(files);
    const older = await downloaded({ ...base, art, commitment: commitArt(art, 'open') });
    const newer = await downloaded({ ...base, art, commitment: commitArt(art, 'hidden') });
    const names = (table: `0x${string}`) => decodeMetadataTable(table)?.traitTypes.map((type) => `${type.name}: ${type.values.join(' ')}`);
    expect(names(older.spec.metadataTable)).toEqual(['Tone: Zinc Amber', 'Band: North East']);
    expect(names(newer.spec.metadataTable)).toEqual(['Band: East North', 'Tone: Amber Zinc']);
    for (const [label, file] of [['older', older], ['newer', newer]] as const) {
      const setup = await load(file.text);
      const draft = finished(setup, (await read([...pictureFiles(), toned])).art);
      const built = rebuilt(draft);
      expect(built.metadataTable, label).toBe(newer.spec.metadataTable);
      expect(built.revealRoot, label).not.toBe(file.spec.revealRoot);
      expect({ ...built, revealRoot: newer.spec.revealRoot }, label).toEqual(withPageLink(newer.spec, ''));
    }
    // Other traits are still not the setup's, sorted or not.
    expect(finish(await load(older.text), (await read(itemFiles())).art)).toEqual({ ok: false, error: LOAD_WORDS.itemsNotSetup });
  });

  it('open art needs its whole reveal list: without it, or one entry short, the file is refused; its root and list id are checked', async () => {
    const { text } = await downloaded(await collectionInput());
    const body = JSON.parse(text) as { revealList: { items: { salt: string }[] } };
    const setupWith = async (revealList: unknown) => {
      const file = await readSettingsFile(JSON.stringify({ ...body, revealList }), digest);
      if (!file.ok) throw new Error(file.error);
      return setupOf(file.value, DEMO_LISTINGS, noThumb);
    };
    expect(await setupWith(null)).toEqual({ ok: false, error: LOAD_WORDS.revealList });
    expect(await setupWith({ ...body.revealList, items: body.revealList.items.slice(0, -1) })).toEqual({ ok: false, error: LOAD_WORDS.revealList });
    // With the whole list the page rebuilds the file's root and list id with its salts: items 1 and 2 swapped do not fit.
    const setup = await load(text);
    expect(finish(setup, (await read(itemFiles([2, 1, ...TEN.slice(2)]))).art)).toEqual({ ok: false, error: LOAD_WORDS.itemsNotSetup });
    const salts = body.revealList.items.map((item, i) => (i === 0 ? { ...item, salt: `0x${'5'.repeat(64)}` } : item));
    const tampered = await setupWith({ ...body.revealList, items: salts });
    if (!tampered.ok) throw new Error(tampered.error);
    expect(finish(tampered.value, (await read(itemFiles())).art)).toEqual({ ok: false, error: LOAD_WORDS.itemsNotSetup });
  });

  it('hidden art needs its item pictures in the file: a file without them is refused, never checked by count and traits alone', async () => {
    const { text } = await downloaded(await collectionInput({}, true));
    const body = JSON.parse(text) as { pictures: { role: string }[] };
    const file = await readSettingsFile(JSON.stringify({ ...body, pictures: body.pictures.filter((picture) => picture.role !== 'item') }), digest);
    if (!file.ok) throw new Error(file.error);
    expect(await setupOf(file.value, DEMO_LISTINGS, noThumb)).toEqual({ ok: false, error: LOAD_WORDS.picture('the item pictures') });
    // The item check itself never skips the set: unrelated pictures with the same count and traits do not fit.
    const setup = await load(text);
    const bare: LoadedSetup = { ...setup, file: { ...setup.file, pictures: setup.file.pictures.filter((picture) => picture.role !== 'item') } };
    expect(itemsProblem(bare, (await read([...pictureFiles(TEN, 90), TRAITS])).art, DEMO_LISTINGS)).toBe(LOAD_WORDS.itemsNotSetup);
  });

  it('fresh salts are made only after the pictures are verified: the art is read without them, the loaded art gets new ones', async () => {
    const setup = await load((await downloaded(await collectionInput())).text);
    const unsalted = (order: readonly number[] = TEN) => readArt(itemFiles(order), { env: { ...env, salt: () => ZERO32 } });
    let made = 0;
    const fresh = () => { made += 1; return sha256Hex(new TextEncoder().encode(`fresh-${made}`)); };
    expect(finishLoad(setup, await unsalted([2, 1, ...TEN.slice(2)]), DEMO_LISTINGS, NATIVE_TOKEN, NOW, { salt: fresh }).ok).toBe(false);
    expect(made).toBe(0);
    const result = finishLoad(setup, await unsalted(), DEMO_LISTINGS, NATIVE_TOKEN, NOW, { salt: fresh });
    if (!result.ok) throw new Error(result.error);
    expect(made).toBe(10);
    expect(result.value.art?.salts).toEqual(TEN.map((n) => sha256Hex(new TextEncoder().encode(`fresh-${n}`))));
  });

  it('a shop’s starting collections are checked on the chain before it loads: no contract, not an ERC-721 or no answer refuse it', async () => {
    const config = CONFIGURATIONS.find((entry) => entry.id === 'curio-corner');
    if (!config) throw new Error('curio-corner');
    const input = { ...inputV2Of(config, { pricing: NATIVE_TOKEN }), cover: LOGO };
    const setup = await load((await downloaded(input)).text);
    const [a1, b2] = ['0x00000000000000000000000000000000000000a1', '0x00000000000000000000000000000000000000b2'];
    const checks = (a: CollectionCheck | 'unknown', b?: CollectionCheck | 'unknown') => new Map(b ? [[a1, a], [b2, b]] : [[a1, a]]);
    expect(finish(setup, null, DEMO_LISTINGS, checks('no-code', 'erc721'))).toEqual({ ok: false, error: LOAD_WORDS.cannotKeep('No contract at this address') });
    expect(finish(setup, null, DEMO_LISTINGS, checks('erc721', 'not-erc721'))).toEqual({ ok: false, error: LOAD_WORDS.cannotKeep('Not an ERC-721 collection') });
    expect(finish(setup, null, DEMO_LISTINGS, checks('erc721', 'unknown'))).toEqual({ ok: false, error: LOAD_WORDS.shopUnchecked });
    expect(finish(setup, null, DEMO_LISTINGS, checks('erc721'))).toEqual({ ok: false, error: LOAD_WORDS.shopUnchecked });
    const ok = finish(setup, null, DEMO_LISTINGS, checks('erc721', 'erc721'));
    expect(ok.ok && ok.value.v2.shop).toMatchObject({ curator: 'creator', curatorAddress: '' });
  });

  it('a shop without its chain’s answers is refused; only the Demo, which has no chain to ask, loads one unchecked', async () => {
    const config = CONFIGURATIONS.find((entry) => entry.id === 'curio-corner');
    if (!config) throw new Error('curio-corner');
    const setup = await load((await downloaded({ ...inputV2Of(config, { pricing: NATIVE_TOKEN }), cover: LOGO })).text);
    expect(finish(setup, null)).toEqual({ ok: false, error: LOAD_WORDS.shopUnchecked });
    const demo = finish(setup, null, DEMO_LISTINGS, UNASKED);
    expect(demo.ok && demo.value.v2.shop).toMatchObject({ curator: 'creator', curatorAddress: '' });
    // A box that is no shop needs no answers.
    const token = CONFIGURATIONS.find((entry) => entry.id === 'rug-rugs');
    if (!token) throw new Error('rug-rugs');
    const plain = await load((await downloaded({ ...inputV2Of(token), cover: LOGO })).text);
    expect(finished(plain, null).v2.shop).toBeNull();
  });

  it('a file priced in a coin not listed here loads in the page’s coin, and says so', async () => {
    const input = await collectionInput();
    const setup = await load((await downloaded(input)).text);
    const withoutLink = DEMO_LISTINGS.filter((listing) => listing.symbol !== 'LINK');
    const draft = finished(setup, (await read(itemFiles())).art, withoutLink);
    expect(draft.v2.pricing).toBe(NATIVE_TOKEN);
    expect(draft.info.note).toBe('The file’s price coin is not listed here: priced in ETH.');
    expect(rebuilt(draft, withoutLink).raise).toBe(coin('ETH').raise);
  });

  it('reads each fee side back as the Fees step’s pick', () => {
    for (const pick of [pickFor('burn'), pickFor('keep'), pickFor('holders-t'), pickFor('items', INSIDE.depth), pickFor('shop', undefined, 8), pickFor('pile'), pickFor('eat')]) {
      expect(pickOfSide(sideOf(pick))).toEqual(pick);
    }
    expect(pickOfSide({ ...sideOf(pickFor('burn')), split: 2 })).toBeNull();
  });
});

/**
 * R74-ART (SH-CREATE-ITEM-MODELS, F2): a collection with a 3D model per item. Its file carries each model (typed GLBs,
 * their exact bytes) and the six-field reveal list; Load settings checks every model as the site's viewer does and by
 * its sha256, takes the numbered models with the pictures, and rebuilds the same spec. A 2D file loads as before.
 */
describe('loading a settings file with 3D models', () => {
  /** Ten models, one per item (`variant` makes other bytes for the same ids). */
  const modelFiles = (order: readonly number[] = TEN, variant = '') => order.map((n, i) => new File([glbOf(n, { variant }).slice().buffer], `${i + 1}.glb`, { type: 'model/gltf-binary' }));
  const itemsWithModels = (order: readonly number[] = TEN, models: readonly number[] = TEN) => [...pictureFiles(order), ...modelFiles(models), TRAITS];
  async function modelInput(hidden = false): Promise<BuildV2Input> {
    const base = await collectionInput({}, hidden);
    const { art, files } = await read(itemsWithModels());
    keepItemFiles(files);
    return { ...base, art, commitment: commitArt(art, hidden ? 'hidden' : 'open') };
  }
  type FileBody = Record<string, unknown> & { models: { type: string; sha256: string; base64: string }[]; revealList: { items: Record<string, string>[] } };

  it('the file carries each model once, typed, with its exact bytes; Load settings keeps the six reveal fields and rebuilds the spec', async () => {
    const input = await modelInput();
    const { spec, text } = await downloaded(input);
    const body = JSON.parse(text) as FileBody;
    expect(Object.keys(body)).toEqual(['format', 'demo', 'note', 'specHash', 'encoded', 'spec', 'pictures', 'models', 'revealList']);
    expect(body.models.map((model) => model.sha256)).toEqual(TEN.map((n) => sha256Hex(glbOf(n))).sort());
    for (const model of body.models) {
      expect(model.type).toBe('model/gltf-binary');
      expect(sha256Hex(Uint8Array.from(atob(model.base64), (c) => c.charCodeAt(0)))).toBe(model.sha256);
    }
    expect(body.revealList.items.map((entry) => entry.modelSha256)).toEqual(TEN.map((n) => sha256Hex(glbOf(n))));
    const setup = await load(text);
    expect(setup.info).toEqual({ pileFollowsPrice: false, items: 10, hidden: false, note: null, models: true });
    expect(setup.file.models.map((model) => model.sha256)).toEqual(body.models.map((model) => model.sha256));
    // All six fields of each entry, as the file has them.
    expect(setup.file.reveal?.[3]).toEqual({ id: 4, traitsPacked: BigInt(body.revealList.items[3]?.traitsPacked ?? ''), imageSha256: body.revealList.items[3]?.imageSha256,
      avatarSha256: ZERO32, modelSha256: sha256Hex(glbOf(4)), salt: body.revealList.items[3]?.salt });
    const again = await read(itemsWithModels());
    expect(rebuildProblem(setup, again.art, DEMO_LISTINGS)).toBeNull();
    expect(itemsProblem(setup, again.art, DEMO_LISTINGS)).toBeNull();
    const draft = finished(setup, again.art);
    // A new box: new salts, the same models in its leaves and list; every other field is the file's.
    expect(draft.art?.items.map((item) => item.modelSha256)).toEqual(TEN.map((n) => sha256Hex(glbOf(n))));
    const built = rebuilt(draft);
    expect(built.revealRoot).not.toBe(spec.revealRoot);
    expect({ ...built, revealRoot: spec.revealRoot, revealListId: spec.revealListId }).toEqual(withPageLink(spec, ''));
    expect(revealList(required(draft.art), commitArt(draft.art, 'open')?.packed ?? []).items.map((entry) => entry.modelSha256)).toEqual(TEN.map((n) => sha256Hex(glbOf(n))));
  });

  it('a 2D file has no models and loads as before; its pictures with models added are not the setup', async () => {
    const { text } = await downloaded(await collectionInput());
    expect(Object.keys(JSON.parse(text) as object)).not.toContain('models');
    const setup = await load(text);
    expect(setup.file.models).toEqual([]);
    expect(setup.info).toEqual({ pileFollowsPrice: false, items: 10, hidden: false, note: null });
    expect(finish(setup, (await read(itemsWithModels())).art)).toEqual({ ok: false, error: LOAD_WORDS.itemsNotSetupModels });
  });

  it('each id’s model must be the list’s: none, swapped, another model, or a missing one is refused, never loaded as zero', async () => {
    const setup = await load((await downloaded(await modelInput())).text);
    expect(finish(setup, (await read(itemFiles())).art)).toEqual({ ok: false, error: LOAD_WORDS.modelsNeeded });
    expect(finish(setup, (await read(itemsWithModels(TEN, [2, 1, ...TEN.slice(2)]))).art)).toEqual({ ok: false, error: LOAD_WORDS.itemsNotSetupModels });
    const other = await read([...pictureFiles(), ...modelFiles(TEN, 'other'), TRAITS]);
    expect(finish(setup, other.art)).toEqual({ ok: false, error: LOAD_WORDS.itemsNotSetupModels });
    // Swapped pictures or no traits, the models right: the same line, which names the models among what may differ.
    expect(finish(setup, (await read([...pictureFiles([2, 1, ...TEN.slice(2)]), ...modelFiles(), TRAITS])).art)).toEqual({ ok: false, error: LOAD_WORDS.itemsNotSetupModels });
    expect(finish(setup, (await read([...pictureFiles(), ...modelFiles()])).art)).toEqual({ ok: false, error: LOAD_WORDS.itemsNotSetupModels });
    // One model short: the reader names it, so the load says so.
    const short = await read([...pictureFiles(), ...modelFiles(TEN.slice(0, 9)), TRAITS]);
    expect(finish(setup, short.art)).toEqual({ ok: false, error: short.art.problems[0] });
    expect(short.art.problems[0]).toMatch(/^Missing models for ids 10/);
  });

  it('refuses a file whose models are missing, changed, not GLBs, load other files, are oversized, repeated or untyped', async () => {
    const { text } = await downloaded(await modelInput());
    const body = JSON.parse(text) as FileBody;
    const check = async (patch: Partial<FileBody>) => readSettingsFile(JSON.stringify({ ...body, ...patch }), digest);
    const refused = { ok: false, error: LOAD_WORDS.picture('the models') };
    const first = body.models[0] as FileBody['models'][number];
    const replace = (entry: FileBody['models'][number]) => ({ models: [entry, ...body.models.slice(1)] });
    // Changed bytes (the sha256 no longer theirs), bytes that are no GLB, a GLB that loads an outside file.
    expect(await check(replace({ ...first, base64: toBase64(glbOf(1, { variant: 'x' })) }))).toEqual(refused);
    expect(await check(replace({ ...first, sha256: sha256Hex(NOT_A_GLB), base64: toBase64(NOT_A_GLB) }))).toEqual(refused);
    const external = glbOf(1, { external: true });
    expect(await check(replace({ ...first, sha256: sha256Hex(external), base64: toBase64(external) }))).toEqual(refused);
    // Over one raw block: refused before it is decoded (a base64 string longer than one block's), or once it is.
    expect(await check(replace({ ...first, base64: 'A'.repeat(1_398_108) }))).toEqual(refused);
    const large = glbOf(1, { pad: 1_048_576 });
    expect(await check(replace({ ...first, sha256: sha256Hex(large), base64: toBase64(large) }))).toEqual(refused);
    expect(await check({ models: [first, ...body.models] })).toEqual(refused);
    expect(await check(replace({ ...first, type: 'image/png' }))).toEqual({ ok: false, error: LOAD_WORDS.notJson });
    expect(await check({ models: {} as never })).toEqual({ ok: false, error: LOAD_WORDS.notJson });
    // One model left out of the file, or a list entry naming a model the file does not carry.
    const fewer = await check({ models: body.models.slice(1) });
    if (!fewer.ok) throw new Error(fewer.error);
    expect(await setupOf(fewer.value, DEMO_LISTINGS, noThumb)).toEqual(refused);
    const noModels = await check({ models: undefined as never });
    if (!noModels.ok) throw new Error(noModels.error);
    expect(await setupOf(noModels.value, DEMO_LISTINGS, noThumb)).toEqual(refused);
    // A list naming an avatar (never built here), or one model on some items only: not a setup this page builds.
    const items = body.revealList.items;
    const avatar = await check({ revealList: { ...body.revealList, items: items.map((entry, i) => (i === 0 ? { ...entry, avatarSha256: `0x${'a'.repeat(64)}` } : entry)) } });
    if (!avatar.ok) throw new Error(avatar.error);
    expect(await setupOf(avatar.value, DEMO_LISTINGS, noThumb)).toEqual({ ok: false, error: LOAD_WORDS.notBuilt });
    const mixed = await check({ revealList: { ...body.revealList, items: items.map((entry, i) => (i === 0 ? { ...entry, modelSha256: ZERO32 } : entry)) } });
    if (!mixed.ok) throw new Error(mixed.error);
    expect(await setupOf(mixed.value, DEMO_LISTINGS, noThumb)).toEqual({ ok: false, error: LOAD_WORDS.notBuilt });
    // An entry without one of its six fields is no list this page wrote.
    const partial = Object.fromEntries(Object.entries(items[0] as Record<string, string>).filter(([key]) => key !== 'modelSha256'));
    expect(await check({ revealList: { ...body.revealList, items: [partial, ...items.slice(1)] } })).toEqual({ ok: false, error: LOAD_WORDS.notJson });
    expect(await check({ revealList: { ...body.revealList, items: items.map((entry, i) => (i === 0 ? { ...entry, traitsPacked: '1e3' } : entry)) } })).toEqual({ ok: false, error: LOAD_WORDS.notJson });
  });

  it('a tampered list model is caught even with the file’s own models: the root and list id are the spec’s', async () => {
    const { text } = await downloaded(await modelInput());
    const body = JSON.parse(text) as FileBody;
    // Ids 1 and 2 trade models in the list (the set of models is unchanged): the pictures and models read are the true ones.
    const items = body.revealList.items;
    const swapped = items.map((entry, i) => (i < 2 ? { ...entry, modelSha256: items[1 - i]?.modelSha256 ?? '' } : entry));
    const file = await readSettingsFile(JSON.stringify({ ...body, revealList: { ...body.revealList, items: swapped } }), digest);
    if (!file.ok) throw new Error(file.error);
    const setup = await setupOf(file.value, DEMO_LISTINGS, noThumb);
    if (!setup.ok) throw new Error(setup.error);
    expect(finish(setup.value, (await read(itemsWithModels())).art)).toEqual({ ok: false, error: LOAD_WORDS.itemsNotSetupModels });
    // Files that follow the tampered list instead do not rebuild the spec's root either.
    expect(finish(setup.value, (await read(itemsWithModels(TEN, [2, 1, ...TEN.slice(2)]))).art)).toEqual({ ok: false, error: LOAD_WORDS.itemsNotSetupModels });
  });

  it('hidden art with models: the file carries them as a set, the creator’s models must be exactly that set', async () => {
    const { spec, text } = await downloaded(await modelInput(true));
    const body = JSON.parse(text) as FileBody;
    expect(body.revealList).toBeNull();
    expect(body.models).toHaveLength(10);
    const setup = await load(text);
    expect(setup.info).toEqual({ pileFollowsPrice: false, items: 10, hidden: true, note: null, models: true });
    const draft = finished(setup, (await read(itemsWithModels())).art);
    expect({ ...rebuilt(draft), revealRoot: spec.revealRoot }).toEqual(withPageLink(spec, ''));
    expect(finish(setup, (await read(itemFiles())).art)).toEqual({ ok: false, error: LOAD_WORDS.modelsNeeded });
    expect(finish(setup, (await read([...pictureFiles(), ...modelFiles(TEN, 'other'), TRAITS])).art)).toEqual({ ok: false, error: LOAD_WORDS.itemsNotSetupModels });
  });
});

describe('SH-EX-O1: a hidden setup keeps its own hidden picture', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../');
  /** Frog Kiln's designed placeholder (examples/boxes/frog-kiln/art/hidden.svg): plain SVG text on one line. */
  const KIT_SVG = readFileSync(join(ROOT, 'examples/boxes/frog-kiln/art/hidden.svg'), 'utf8').trim();
  const hiddenSvgOf = (spec: BoxSpecV2): string | undefined => {
    const addOn = spec.addOns.find((entry) => entry.id === AddOnId.Placeholders);
    return addOn ? decodePlaceholdersParams(addOn.params).hiddenSvg : undefined;
  };
  /** A hidden collection whose file carries `hiddenSvg`, as the kit tooling would write a hidden kit's file. */
  const kitInput = async (hiddenSvg: string): Promise<BuildV2Input> => {
    const base = await collectionInput({}, true);
    return { ...base, form: { ...base.form, hiddenSvg } };
  };

  it('loads with the file’s own picture, and the new box commits it: the page rebuilds the file’s spec only with it', async () => {
    expect(KIT_SVG).not.toBe(DEFAULT_FORM.hiddenSvg);
    const { spec, text } = await downloaded(await kitInput(KIT_SVG));
    expect(hiddenSvgOf(spec)).toBe(KIT_SVG);
    const setup = await load(text);
    expect(setup.form.hiddenSvg).toBe(KIT_SVG);
    const items = await read(itemFiles());
    expect(rebuildProblem(setup, items.art, DEMO_LISTINGS)).toBeNull();
    // With the neutral picture (the page before SH-EX-O1) the page does not build the file's spec: its add-ons differ.
    expect(rebuildProblem({ ...setup, form: { ...setup.form, hiddenSvg: DEFAULT_FORM.hiddenSvg } }, items.art, DEMO_LISTINGS)).toBe('addOns');
    const draft = finished(setup, items.art);
    expect(draft.form.hiddenSvg).toBe(KIT_SVG);
    const built = rebuilt(draft);
    expect(hiddenSvgOf(built)).toBe(KIT_SVG);
    expect({ ...built, revealRoot: spec.revealRoot }).toEqual(withPageLink(spec, ''));
  });

  it('the picture stays as loaded whoever writes the draft; a new draft and Start over hold the neutral one', async () => {
    const setup = await load((await downloaded(await kitInput(KIT_SVG))).text);
    const draft = finished(setup, (await read(itemFiles())).art);
    expect(lockedFormPatch({ hiddenSvg: DEFAULT_FORM.hiddenSvg, name: 'Kiln Two' }, draft.info)).toEqual({ name: 'Kiln Two' });
    const before = { ...EMPTY_DRAFT, form: draft.form, art: draft.art, cover: draft.cover, collectionCover: draft.collectionCover, page: draft.page };
    const kept = lockedDraft(before, { ...before, form: { ...before.form, hiddenSvg: DEFAULT_FORM.hiddenSvg, ticker: 'KILN2' } });
    expect(kept.form).toEqual({ ...draft.form, ticker: 'KILN2' });
    expect(EMPTY_DRAFT.form.hiddenSvg).toBe(DEFAULT_FORM.hiddenSvg);
  });

  it('a file whose own picture breaks the add-on’s rule is refused in the page’s own words', async () => {
    const setup = await load((await downloaded(await kitInput(KIT_SVG.replace('><', '>\n<')))).text);
    expect(finish(setup, (await read(itemFiles())).art)).toEqual({ ok: false, error: LOAD_WORDS.cannotKeep('Plain SVG text only') });
    // Longer than the add-on's 4,096 characters: named as the field's length, not as a page bug.
    const long = await load((await downloaded(await kitInput(`${KIT_SVG}${' '.repeat(4_097 - KIT_SVG.length)}`))).text);
    expect(finish(long, (await read(itemFiles())).art)).toEqual({ ok: false, error: LOAD_WORDS.cannotKeep('Up to 4096 characters') });
  });
});

describe('a loaded setup keeps its fields', () => {
  const info: LoadedInfo = { pileFollowsPrice: false, items: 10, hidden: false, note: null };
  const MINE = Object.freeze({ website: 'https://mine.example', x: '@mine', telegram: 'https://t.me/mine_box' });
  it('only the name, ticker, links (the collection page’s too), opening and the creator’s own buy, rights and address change in the form', () => {
    expect(EDITABLE_FORM).toEqual(['name', 'ticker', 'links', 'pageLink', 'pageLinkEdited', 'open', 'firstIn', 'rights', 'ownerText']);
    const patch = { name: 'Mine', ticker: 'MINE', links: MINE, description: 'Other', contents: 'token' as const, artMode: 'hidden' as const, royaltyBps: 0, pageLink: 'https://mine.example/moons', pageLinkEdited: true, specials: [], open: { kind: 'preset' as const, id: '1h' } };
    expect(lockedFormPatch(patch, info)).toEqual({ name: 'Mine', ticker: 'MINE', links: MINE, pageLink: 'https://mine.example/moons', pageLinkEdited: true, open: { kind: 'preset', id: '1h' } });
    expect(lockedFormPatch(patch, null)).toEqual(patch);
  });
  it('the links are the creator’s: an issue on them never refuses a load; the logo, About, the rest of Contents and the deadline stay kept', () => {
    for (const control of [CONTROL.website, CONTROL.x, CONTROL.telegram]) expect(lockedIssue({ step: 'v2-basics', control }), control).toBe(false);
    expect(lockedIssue({ step: 'v2-contents', control: CONTROL.pageLink })).toBe(false);
    for (const control of [CONTROL.logo, CONTROL.about]) expect(lockedIssue({ step: 'v2-basics', control }), control).toBe(true);
    for (const control of [CONTROL.art, CONTROL.banner, CONTROL.royalty]) expect(lockedIssue({ step: 'v2-contents', control }), control).toBe(true);
    expect(lockedIssue({ step: 'v2-raise', control: CONTROL.deadline })).toBe(true);
  });
  it('the links and the collection page’s link load empty; the creator’s own change only that link in the spec', async () => {
    const input = await collectionInput();
    // The example's links are site metadata (not in its file); its collection page link is in the spec.
    const { spec, text } = await downloaded({ ...input, form: { ...input.form, links: { website: 'https://moons.example', x: '@moons', telegram: 'https://t.me/paper_moons' } } });
    expect(pageLinkOf(spec)).toBe('https://moons.example');
    const setup = await load(text);
    expect(setup.form.links).toEqual({ website: '', x: '', telegram: '' });
    const draft = finished(setup, (await read(itemFiles())).art);
    expect(draft.form).toMatchObject({ pageLink: '', pageLinkEdited: false });
    expect(effectivePageLink(draft.form)).toBe('');
    const before = rebuilt(draft);
    expect(pageLinkOf(before)).toBe('');
    // A new Website fills the page link, as on a new box; a change to a kept field is refused.
    const typed: LoadedDraft = { ...draft, form: { ...draft.form, ...lockedFormPatch({ links: MINE, description: 'Other', royaltyBps: 0 }, draft.info) } };
    expect(typed.form).toEqual({ ...draft.form, links: MINE });
    expect(rebuilt(typed)).toEqual(withPageLink(before, MINE.website));
    // The creator's own page link, typed on Contents: again only that field differs.
    const edited: LoadedDraft = { ...typed, form: { ...typed.form, ...lockedFormPatch({ pageLink: 'https://mine.example/moons', pageLinkEdited: true }, draft.info) } };
    expect(rebuilt(edited)).toEqual(withPageLink(before, 'https://mine.example/moons'));
  });
  it('only the fees change in the choices (the price coin through repriceLoaded)', () => {
    const patch: Partial<V2Choices> = { buyers: pickFor('keep'), sellers: pickFor('grow'), pickFeeBps: 500, pricing: coin('USDC').token, deadlineDays: 30, pile: null, shop: null };
    expect(lockedV2Patch(patch, info)).toEqual({ buyers: pickFor('keep'), sellers: pickFor('grow'), pickFeeBps: 500 });
    expect(lockedV2Patch(patch, null)).toEqual(patch);
  });
});

describe('changing a loaded setup’s price coin', () => {
  const pileV2 = (asset: string, seed: string, pricing = asset): V2Choices => ({ ...DEFAULT_V2, pricing, pile: { asset, seed, leaveBehindBps: 500 } });
  it('a pile in the price coin follows it, with its seed and leave-behind; the raise is the new listing’s', async () => {
    const input: BuildV2Input = { ...inputOf({ form: formOf({ contents: 'token', rights: true }), art: null, collectionCover: null, cover: LOGO }), v2: pileV2(coin('USDC').token, '1'), listings: DEMO_LISTINGS };
    const spec = buildSpecV2(input);
    const setup = await load(boxSpecFile(spec, recipeCtx(input), { pictures: [{ role: 'logo', sha256: LOGO.sha256, bytes: png(300) }] }).parts.join(''));
    expect(setup.info.pileFollowsPrice).toBe(true);
    const draft = finished(setup, null);
    const result = repriceLoaded(draft.v2, NATIVE_TOKEN, draft.info, DEMO_LISTINGS);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.v2.pile).toEqual({ asset: NATIVE_TOKEN, seed: '1', leaveBehindBps: 500 });
    const built = rebuilt({ ...draft, v2: result.value.v2 });
    expect(built.raise).toBe(coin('ETH').raise);
    expect(built.pricing.token).toBe(NATIVE_TOKEN);
    expect({ ...built, raise: spec.raise, pricing: spec.pricing, contentsParams: spec.contentsParams }).toEqual(spec);
  });
  it('refuses a seed the new coin cannot hold, and a pile in another coin becoming the price coin', () => {
    const follows: LoadedInfo = { pileFollowsPrice: true, items: 0, hidden: false, note: null };
    const wbtc = coin('WBTC');
    expect(repriceLoaded(pileV2(NATIVE_TOKEN, '0.000000001'), wbtc.token, follows, DEMO_LISTINGS)).toEqual({ ok: false, error: LOAD_WORDS.cannotKeep('its pile seed 0.000000001 needs more decimals than WBTC has (8).') });
    const other: LoadedInfo = { ...follows, pileFollowsPrice: false };
    const usdc = coin('USDC');
    expect(repriceLoaded(pileV2(usdc.token, '1000', NATIVE_TOKEN), usdc.token, other, DEMO_LISTINGS)).toEqual({ ok: false, error: LOAD_WORDS.cannotKeep('its pile is in USDC, so the price coin must be another coin.') });
    const kept = repriceLoaded(pileV2(usdc.token, '1000', NATIVE_TOKEN), coin('LINK').token, other, DEMO_LISTINGS);
    expect(kept.ok && kept.value.v2.pile?.asset).toBe(usdc.token);
  });
  it('names each fee choice the new coin does not offer, keeping the fees the creator’s to choose', () => {
    const refused = DEMO_LISTINGS.map((listing) => (listing.symbol === 'LINK' ? { ...listing, eat: 'refused' as const } : listing));
    const info: LoadedInfo = { pileFollowsPrice: false, items: 0, hidden: false, note: null };
    const result = repriceLoaded({ ...DEFAULT_V2, buyers: pickFor('eat') }, coin('LINK').token, info, refused);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.notes).toEqual(['Buyers’ fee: LINK cannot be eaten. Choose again.']);
    expect(choiceOf(result.value.v2.buyers)).toBe('eat');
  });
});

describe('SH-SHOP-CREATE: shop files with starter items, and no curator', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../');
  /**
   * The kits' settings files as committed: the Junkyard's on this line; the one-collection shop's from
   * sh-050-one-collection-shop (`examples/boxes/one-collection-shop/settings/`, 50,526 bytes, SHA-256 7cb893a1…8778),
   * copied here unchanged. Both are priced in Sepolia's ETH, listing 0, as the kit generator names it.
   */
  const JUNKYARD = 'examples/boxes/junkyard/settings/junkyard-boxspec-v2.json';
  const ONE_SHOP = 'apps/web/src/features/create/v2/test-support/one-collection-shop-boxspec-v2.json';
  const SEPOLIA_ETH: SiteListing = { id: 0, token: NATIVE_TOKEN, decimals: 18, class: ListingClass.NATIVE, kind: ListingKind.LISTED, raise: RAISE_ETH, symbol: 'ETH', name: 'Sepolia test Ether', powers: [], eat: 'allowed' };
  const KIT: readonly SiteListing[] = [SEPOLIA_ETH];
  /**
   * Their starter ids: the Junkyard's Sepolia stock, ids 1 and 2 of each of its five Test Junk collections
   * (`examples/boxes/junkyard/test-collections/catalog.json`); the one-collection shop's, Test Junk Bent Cans ids 3 to 12
   * (its registry row on sh-050).
   */
  const catalog = JSON.parse(readFileSync(join(ROOT, 'examples/boxes/junkyard/test-collections/catalog.json'), 'utf8')) as { collections: { items: { id: string }[] }[] };
  const JUNKYARD_IDS = catalog.collections.map((collection) => collection.items.map((item) => item.id).join(', '));
  const ONE_SHOP_IDS = ['3-12'];
  const salt = () => sha256Hex(new TextEncoder().encode('kit-salt'));

  async function loadFile(text: string): Promise<{ readonly spec: BoxSpecV2; readonly hash: string; readonly setup: LoadedSetup }> {
    const file = await readSettingsFile(text, digest);
    if (!file.ok) throw new Error(file.error);
    const setup = await setupOf(file.value, KIT, noThumb);
    if (!setup.ok) throw new Error(setup.error);
    return { spec: file.value.spec, hash: (JSON.parse(text) as { specHash: string }).specHash, setup: setup.value };
  }
  /** The last step of a load on a chain whose answers call each starting collection an ERC-721. */
  const finishKit = (setup: LoadedSetup) => finishLoad(setup, null, KIT, NATIVE_TOKEN, NOW, { salt, shopChecks: allErc721(setup) });
  /** What the page builds from a loaded draft for the creator `OWNER`. */
  const kitSpec = (draft: LoadedDraft) => buildSpecV2({ form: draft.form, art: null, commitment: null, cover: draft.cover, collectionCover: null, page: draft.page, owner: OWNER, nowMs: NOW, v2: draft.v2, listings: KIT });
  const typed = (setup: LoadedSetup, ids: readonly string[]): LoadedSetup => {
    const result = withStarters(setup, ids, KIT);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };

  it('the one-collection shop’s file asks for its ten starter ids, then rebuilds its exact spec with them and no curator', async () => {
    const { spec, hash, setup } = await loadFile(readFileSync(join(ROOT, ONE_SHOP), 'utf8'));
    expect(spec.boxType).toBe(BoxTypeV2.SHOP);
    expect(starterCommitmentV2(spec)?.count).toBe(10);
    expect(setup.starters).toBe(10);
    expect(setup.v2.shop).toMatchObject({ curator: 'none', curatorAddress: '', collections: [{ tier: 0, ids: '' }] });
    // Nothing loads before the ids: the file commits only their hash and count.
    expect(finishKit(setup)).toEqual({ ok: false, error: LOAD_WORDS.startersNotSetup });
    const draft = finishKit(typed(setup, ONE_SHOP_IDS));
    if (!draft.ok) throw new Error(draft.error);
    // "No curator" stays none; the ids are kept as loaded.
    expect(draft.value.v2.shop).toMatchObject({ curator: 'none', curatorAddress: '', collections: [{ address: shopConfigV2(spec.contentsParams).collections[0], tier: 0, ids: '3-12' }] });
    // The page rebuilds the file's exact spec for any creator: a shop names no owner, payee or curator in it.
    const built = kitSpec(draft.value);
    expect(encodeBoxSpecV2(built)).toBe(encodeBoxSpecV2(spec));
    expect(specHashV2(built)).toBe(hash);
    expect(shopConfigV2(built.contentsParams).curator).toBe('0x0000000000000000000000000000000000000000');
    expect(required(starterItemsOf(required(draft.value.v2.shop))).map((item) => item.id)).toEqual([3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n, 11n, 12n]);
  });

  it('the Junkyard’s file loads with its ten starter ids, two per Test Junk collection; its curator becomes the creator', async () => {
    const { spec, setup } = await loadFile(readFileSync(join(ROOT, JUNKYARD), 'utf8'));
    expect(JUNKYARD_IDS).toEqual(['1, 2', '1, 2', '1, 2', '1, 2', '1, 2']);
    expect(setup.starters).toBe(10);
    // The file names an address as curator (the kit's offline owner slot): TA-27 makes the connected creator the curator.
    expect(shopConfigV2(spec.contentsParams).curator).toBe('0x0000000000000000000000000000000000000001');
    const draft = finishKit(typed(setup, JUNKYARD_IDS));
    if (!draft.ok) throw new Error(draft.error);
    expect(draft.value.v2.shop).toMatchObject({ curator: 'creator', curatorAddress: '' });
    expect(draft.value.v2.shop?.collections.map((row) => row.ids)).toEqual(JUNKYARD_IDS);
    // Every field but the curator is the file's: the starter set (add-on 8) and the five starting collections included.
    const built = kitSpec(draft.value);
    expect(built.addOns).toEqual(spec.addOns);
    expect({ ...shopConfigV2(built.contentsParams), curator: null }).toEqual({ ...shopConfigV2(spec.contentsParams), curator: null });
    expect(shopConfigV2(built.contentsParams).curator).toBe(OWNER);
    const file = shopConfigV2(spec.contentsParams);
    expect(encodeBoxSpecV2({ ...built, contentsParams: spec.contentsParams })).toBe(encodeBoxSpecV2(spec));
    expect(file.collections).toHaveLength(5);
  });

  it('starter ids that are not the file’s are refused: one short, one more, another order, other ids, not ids', async () => {
    const one = (await loadFile(readFileSync(join(ROOT, ONE_SHOP), 'utf8'))).setup;
    for (const ids of [['3-11'], ['3-13'], ['12, 11, 10, 9, 8, 7, 6, 5, 4, 3'], ['4-13'], ['3-12, 3'], ['three'], [''], ['3-12', '1']]) {
      expect(withStarters(one, ids, KIT), ids.join(' | ')).toEqual({ ok: false, error: LOAD_WORDS.startersNotSetup });
    }
    const junkyard = (await loadFile(readFileSync(join(ROOT, JUNKYARD), 'utf8'))).setup;
    // The same ten ids in another collection order, or the right ids per collection swapped within one.
    for (const ids of [['1-4', '', '1, 2', '1, 2', '1, 2'], ['1, 2', '1, 2', '1, 2', '1, 2', '2, 1'], ['1, 2', '1, 2', '1, 2', '1, 2']]) {
      expect(withStarters(junkyard, ids, KIT), ids.join(' | ')).toEqual({ ok: false, error: LOAD_WORDS.startersNotSetup });
    }
    // A setup whose ids were changed after they were checked is refused at the end too.
    const tampered: LoadedSetup = { ...typed(one, ONE_SHOP_IDS), v2: { ...one.v2, shop: { ...required(one.v2.shop), collections: [{ ...required(one.v2.shop?.collections[0]), ids: '4-13' }] } } };
    expect(finishKit(tampered)).toEqual({ ok: false, error: LOAD_WORDS.startersNotSetup });
  });

  it('a shop with starter items and no curator made on this page loads back to its exact spec', async () => {
    const config = required(CONFIGURATIONS.find((entry) => entry.id === 'curio-corner'));
    const shop: ShopChoice = { ...required(config.shop), curator: 'none', collections: [
      { address: '0x00000000000000000000000000000000000000a1', tier: 0, ids: '1-6' }, { address: '0x00000000000000000000000000000000000000b2', tier: 2, ids: '7, 8, 9, 10' }] };
    const input = { ...inputV2Of(config, { pricing: NATIVE_TOKEN, shop }), cover: LOGO };
    const spec = buildSpecV2(input);
    expect(starterCommitmentV2(spec)?.count).toBe(10);
    const setup = await load(boxSpecFile(spec, recipeCtx(input), { pictures: [{ role: 'logo', sha256: LOGO.sha256, bytes: png(300) }] }).parts.join(''));
    expect(setup.starters).toBe(10);
    const draft = finished(typed(setup, ['1-6', '7-10']), null, DEMO_LISTINGS, allErc721(setup));
    expect(draft.v2.shop).toMatchObject({ curator: 'none', collections: [{ ids: '1-6' }, { ids: '7-10' }] });
    expect(specHashV2(rebuilt(draft))).toBe(specHashV2(spec));
    // A shop file without starter items needs no ids and loads as before.
    const plain = await load(boxSpecFile(buildSpecV2({ ...input, v2: { ...input.v2, shop: { ...shop, collections: shop.collections.map((row) => ({ ...row, ids: '' })) } } }), recipeCtx(input), { pictures: [{ role: 'logo', sha256: LOGO.sha256, bytes: png(300) }] }).parts.join(''));
    expect(plain.starters).toBe(0);
    expect(finished(plain, null, DEMO_LISTINGS, allErc721(plain)).v2.shop).toMatchObject({ curator: 'none' });
  });

  it('a loaded shop keeps its collections, starter ids and curator: none of them is one of the five', async () => {
    const { setup } = await loadFile(readFileSync(join(ROOT, ONE_SHOP), 'utf8'));
    const draft = finishKit(typed(setup, ONE_SHOP_IDS));
    if (!draft.ok) throw new Error(draft.error);
    const changed: ShopChoice = { ...required(draft.value.v2.shop), curator: 'creator', collections: [{ address: '0x00000000000000000000000000000000000000a1', tier: 1, ids: '1-10' }] };
    expect(lockedV2Patch({ shop: changed }, draft.value.info)).toEqual({});
    for (const control of [SHOP_CONTROL.starters(0), SHOP_CONTROL.collection(0), SHOP_CONTROL.curator]) expect(lockedIssue({ step: 'v2-contents', control }), control).toBe(true);
  });
});
