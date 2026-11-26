/** F-1: the committed pictures as bytes, each checked against its sha256, and the one publish entry point (no store yet). */
import { sha256Hex } from '@squarehole/artwork';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetItemFiles, keepItemFiles } from '../item-files';
import { COLLECTION_COVER, COVER, PAGE, artOf, itemFilesOf } from '../test-support/fixtures';
import { EMPTY_PAGE, commitArt, revealList, type ArtState } from '../create-model';
import { boxSpecFile, buildSpecV2, recipeCtx } from './model';
import { artCommittedBy, committedModelHashes, committedModels, committedPictureHashes, committedPictures, eachCommittedModel, eachCommittedPicture, publishPictures, type CommittedPicture } from './pictures';
import { CONFIGURATIONS } from './test-support/example-configurations';
import { inputV2Of } from './test-support/v2-fixtures';
import { glbOf } from '../test-support/models';
import { specHashV2 } from './spec-types';

afterEach(() => { forgetItemFiles(); vi.restoreAllMocks(); });
const digest = async (bytes: Uint8Array) => sha256Hex(bytes);
const config = (id: string) => CONFIGURATIONS.find((entry) => entry.id === id);

describe('committedPictures', () => {
  it('gives each committed picture once, items in sha256 order, and names what this visit cannot supply', async () => {
    const input = inputV2Of(config('bag-holders'));
    const spec = buildSpecV2(input);
    const draft = { cover: COVER, collectionCover: COLLECTION_COVER, art: artOf() };
    keepItemFiles(itemFilesOf());
    const all = await committedPictures(spec, draft, digest);
    expect(all.missing).toEqual([]);
    expect(all.pictures.map((p) => p.role)).toEqual(['logo', 'collection cover', ...Array(12).fill('item')]);
    for (const picture of all.pictures) expect(sha256Hex(picture.bytes)).toBe(picture.sha256);
    const items = all.pictures.filter((p) => p.role === 'item').map((p) => p.sha256);
    expect(items).toEqual([...items].sort());
    // A file whose bytes changed since it was read, or one never read in this visit, is missing, never left out silently.
    const files = itemFilesOf(); const [first] = [...files.keys()].sort();
    files.set(first as string, new Blob(['other bytes'])); keepItemFiles(files);
    expect((await committedPictures(spec, draft, digest)).missing).toEqual([{ role: 'item', sha256: first }]);
    forgetItemFiles();
    expect((await committedPictures(spec, draft, digest)).missing).toHaveLength(12);
    // A logo that no longer matches the spec is missing too.
    expect((await committedPictures(spec, { ...draft, cover: COLLECTION_COVER }, digest)).missing[0]).toEqual({ role: 'logo', sha256: spec.coverSha256 });
  });

  // FE12 review H-1: add-on 6 commits the collection page's banner and teasers, the browser's re-encodings like the logo.
  it('a collection page’s banner and teasers come from the draft, in the spec’s order, each checked; gone ones are named', async () => {
    const input = { ...inputV2Of(config('bag-holders')), page: PAGE };
    const spec = buildSpecV2(input);
    keepItemFiles(itemFilesOf());
    const draft = { cover: COVER, collectionCover: COLLECTION_COVER, page: PAGE, art: artOf() };
    const all = await committedPictures(spec, draft, digest);
    expect(all.missing).toEqual([]);
    expect(all.pictures.slice(0, 6).map((p) => [p.role, p.sha256])).toEqual([
      ['logo', COVER.sha256], ['collection cover', COLLECTION_COVER.sha256], ['banner', PAGE.banner?.sha256],
      ...PAGE.teasers.map((teaser) => ['teaser', teaser.sha256]),
    ]);
    for (const picture of all.pictures) expect(sha256Hex(picture.bytes)).toBe(picture.sha256);
    expect((await committedPictures(spec, { ...draft, page: EMPTY_PAGE }, digest)).missing).toEqual([
      { role: 'banner', sha256: PAGE.banner?.sha256 }, ...PAGE.teasers.map((teaser) => ({ role: 'teaser', sha256: teaser.sha256 })),
    ]);
    // Without a page the spec commits none, and none is asked for.
    expect((await committedPictures(buildSpecV2(inputV2Of(config('bag-holders'))), { ...draft, page: EMPTY_PAGE }, digest)).missing).toEqual([]);
  });

  // FE12 review M-3: each picture is handed over before the next item file is read, so only one is held at a time.
  it('hands each picture over before the next item file is read', async () => {
    const spec = buildSpecV2(inputV2Of(config('bag-holders')));
    const order: string[] = [];
    const files = new Map([...itemFilesOf()].map(([sha256, file]) => [sha256, { arrayBuffer: async () => { order.push(`read ${sha256}`); return file.arrayBuffer(); } } as unknown as Blob]));
    keepItemFiles(files);
    const missing = await eachCommittedPicture(spec, { cover: COVER, collectionCover: COLLECTION_COVER, art: artOf() }, digest, (picture) => { order.push(`${picture.role} ${picture.sha256}`); });
    expect(missing).toEqual([]);
    const items = [...files.keys()].sort();
    expect(order).toEqual([`logo ${COVER.sha256}`, `collection cover ${COLLECTION_COVER.sha256}`, ...items.flatMap((sha256) => [`read ${sha256}`, `item ${sha256}`])]);
  });

  it('a token box commits its logo only', async () => {
    const spec = buildSpecV2(inputV2Of(config('rug-rugs'), {}, { contents: 'token' }));
    const result = await committedPictures(spec, { cover: COVER, collectionCover: COLLECTION_COVER, art: artOf() }, digest);
    expect(result).toEqual({ pictures: [{ role: 'logo', sha256: COVER.sha256, bytes: expect.any(Uint8Array) }], missing: [] });
  });
});

describe('publishPictures', () => {
  const pictures: CommittedPicture[] = [
    { role: 'logo', sha256: COVER.sha256, bytes: new TextEncoder().encode('cover bytes as re-encoded') },
    { role: 'collection cover', sha256: COLLECTION_COVER.sha256, bytes: new TextEncoder().encode('collection cover bytes as re-encoded') },
  ];
  it('without a store (the founder’s pending decision) uploads nothing and keeps every picture pending', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await publishPictures(pictures)).toEqual({ published: [], pending: [COVER.sha256, COLLECTION_COVER.sha256] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('with a store, hands it each picture’s exact bytes; one that fails stays pending and the rest still go', async () => {
    const put = vi.fn(async (picture: CommittedPicture) => { if (picture.role === 'logo') throw new Error('store down'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await publishPictures(pictures, { put })).toEqual({ published: [COLLECTION_COVER.sha256], pending: [COVER.sha256] });
    expect(put.mock.calls.map(([picture]) => picture)).toEqual(pictures);
  });
});

/** `artOf(n)` with a GLB per item, and the files a visit that read them keeps (pictures and models, by sha256). */
const modelArt = (n = 12): ArtState => ({ ...artOf(n), items: artOf(n).items.map((item) => ({ ...item, modelSha256: sha256Hex(glbOf(item.id)), modelBytes: glbOf(item.id).byteLength })) });
const modelFiles = (n = 12) => new Map([...itemFilesOf(n), ...Array.from({ length: n }, (_, i) => [sha256Hex(glbOf(i + 1)), new Blob([glbOf(i + 1).slice().buffer])] as const)]);

// R74-ART (SH-CREATE-ITEM-MODELS): the models a collection's art commits, for the BoxSpec file and publishing.
describe('committedModels', () => {
  it('gives each committed model once, in sha256 order, checked as the viewer checks one; names what this visit cannot supply', async () => {
    const spec = buildSpecV2(inputV2Of(config('bag-holders')));
    const art = modelArt();
    keepItemFiles(modelFiles());
    expect(committedModelHashes(spec, art)).toEqual(art.items.map((item) => item.modelSha256).sort());
    const all = await committedModels(spec, { art });
    expect(all.missing).toEqual([]);
    expect(all.models.map((model) => model.sha256)).toEqual([...art.items.map((item) => item.modelSha256 as string)].sort());
    for (const model of all.models) expect(sha256Hex(model.bytes)).toBe(model.sha256);
    // Changed bytes, bytes that are no model any more, or no file since a reload: missing, never left out.
    const [first] = [...art.items.map((item) => item.modelSha256 as string)].sort();
    const files = modelFiles(); files.set(first as string, new Blob(['other bytes'])); keepItemFiles(files);
    expect((await committedModels(spec, { art })).missing).toEqual([{ sha256: first }]);
    forgetItemFiles();
    expect((await committedModels(spec, { art })).missing).toHaveLength(12);
    // 2D art, and a box that is no new collection, commit none.
    expect(committedModelHashes(spec, artOf())).toEqual([]);
    expect(committedModelHashes(buildSpecV2(inputV2Of(config('rug-rugs'))), art)).toEqual([]);
    expect(await committedModels(spec, { art: artOf() })).toEqual({ models: [], missing: [] });
  });

  it('hands each model over before the next is read; a model larger than one raw block is never read', async () => {
    const spec = buildSpecV2(inputV2Of(config('bag-holders')));
    const art = modelArt(3);
    const order: string[] = [];
    const files = new Map([...modelFiles(3)].map(([sha256, file]) => [sha256, { size: file.size, arrayBuffer: async () => { order.push(`read ${sha256}`); return file.arrayBuffer(); } } as unknown as Blob]));
    keepItemFiles(files);
    expect(await eachCommittedModel(spec, { art }, (model) => { order.push(`model ${model.sha256}`); })).toEqual([]);
    expect(order).toEqual([...art.items.map((item) => item.modelSha256 as string)].sort().flatMap((sha256) => [`read ${sha256}`, `model ${sha256}`]));
    const [first] = [...art.items.map((item) => item.modelSha256 as string)].sort();
    files.set(first as string, { size: 1_048_577, arrayBuffer: () => { throw new Error('never read'); } } as unknown as Blob);
    keepItemFiles(files);
    expect(await eachCommittedModel(spec, { art }, () => undefined)).toEqual([{ sha256: first }]);
  });
});

/**
 * Download BoxSpec's file (model.ts `boxSpecFile`): a 2D file is byte for byte what it was before models (the hashes
 * below are the base commit's, c745f1cd6); a 3D file adds its `models` list between the pictures and the reveal list.
 */
describe('the BoxSpec file with and without models', () => {
  const fileOf = async (id: string, art: ArtState | null) => {
    const base = inputV2Of(config(id));
    const input = { ...base, art: art && base.art ? art : base.art, commitment: art && base.art ? commitArt(art, base.form.artMode) : base.commitment };
    const spec = buildSpecV2(input);
    const { pictures } = await committedPictures(spec, { cover: input.cover, collectionCover: input.collectionCover ?? null, page: input.page, art: input.art }, digest);
    const { models } = await committedModels(spec, { art: input.art });
    const open = input.form.contents === 'collection' && input.form.artMode === 'open' && input.art && input.commitment;
    const file = boxSpecFile(spec, recipeCtx(input), { pictures, models, revealList: open ? revealList(input.art as ArtState, input.commitment?.packed ?? []) : null });
    return { spec, text: file.parts.join(''), parts: file.parts.length };
  };

  it('2D files are unchanged: an open collection, a hidden one and a token box, byte for byte', async () => {
    const golden = {
      'bag-holders': { specHash: '0x951d5378ff871fae3ad9e79d529dc09dbb578c4e5c19aa849699a09f7ce62f9e', text: '0xdb1c2ed04b3b607803f26a9a76b68ef36d22ce5c17e918d142fd0ee60a09f130', parts: 16 },
      'ultrasound-owls': { specHash: '0xae828f4bf1e6b3ea542111c70aa3dd04de673f40c06a644be2b17245f12bc625', text: '0x101238f894a7d6980b5969206276257498ef8ebbdf6a5209b64971ac778076bd', parts: 16 },
      'rug-rugs': { specHash: '0xcd4779d278682d7925ad19571495c9ac78dcebb794c1c2982567695313c57909', text: '0xbf8f6d11e69bfd63b2007974843b1b5b5ae04ab1dca5f9945068be9b1bc6c287', parts: 3 },
    } as const;
    for (const [id, want] of Object.entries(golden)) {
      keepItemFiles(itemFilesOf());
      const { spec, text, parts } = await fileOf(id, null);
      expect({ specHash: specHashV2(spec), text: sha256Hex(new TextEncoder().encode(text)), parts }, id).toEqual(want);
      expect(Object.keys(JSON.parse(text) as object), id).not.toContain('models');
    }
  });

  it('a 3D file: its models after its pictures, typed, each once, the JSON whole; its spec commits the models', async () => {
    keepItemFiles(modelFiles());
    const { spec, text } = await fileOf('bag-holders', modelArt());
    const body = JSON.parse(text) as { pictures: unknown[]; models: { type: string; sha256: string; base64: string }[]; revealList: { items: { modelSha256: string }[] } };
    expect(Object.keys(body).slice(-3)).toEqual(['pictures', 'models', 'revealList']);
    expect(body.models.map((model) => model.type)).toEqual(Array(12).fill('model/gltf-binary'));
    expect(body.models.map((model) => model.sha256)).toEqual([...modelArt().items.map((item) => item.modelSha256 as string)].sort());
    expect(body.revealList.items.map((entry) => entry.modelSha256)).toEqual(modelArt().items.map((item) => item.modelSha256));
    expect(specHashV2(spec)).not.toBe('0x951d5378ff871fae3ad9e79d529dc09dbb578c4e5c19aa849699a09f7ce62f9e');
  });
});

describe('committedPictureHashes (SH-WITHHELD-SITE fix round af3)', () => {
  it('names, without bytes, exactly the pictures committedPictures reads: logo, collection cover, banner, teasers, items', async () => {
    const art = artOf();
    const spec = buildSpecV2({ ...inputV2Of(config('bag-holders')), page: PAGE, art });
    const draft = { cover: COVER, collectionCover: COLLECTION_COVER, page: PAGE, art };
    keepItemFiles(itemFilesOf());
    const read = await committedPictures(spec, draft, digest);
    const named = [...read.pictures.map((picture) => picture.sha256), ...read.missing.map((picture) => picture.sha256)].map((sha256) => sha256.toLowerCase());
    expect(new Set(committedPictureHashes(spec, art))).toEqual(new Set(named));
    const withFiles = committedPictureHashes(spec, art);
    expect(withFiles).toHaveLength(new Set(named).size);
    // Without any item file the same hashes (nothing is read), while committedPictures can then only name them missing.
    forgetItemFiles();
    expect(committedPictureHashes(spec, art)).toEqual(withFiles);
    expect((await committedPictures(spec, draft, digest)).missing.filter((picture) => picture.role === 'item')).toHaveLength(12);
    // A token commits only its logo; a collection's items count only for a new collection.
    const token = buildSpecV2(inputV2Of(config('rug-rugs')));
    expect(committedPictureHashes(token, art)).toEqual([token.coverSha256.toLowerCase()]);
  });
});

describe('artCommittedBy (SH-WITHHELD-SITE fix round af4)', () => {
  it('the spec’s own art rebuilds its reveal root; other art, other salts or none does not; a box without art needs none', () => {
    const spec = buildSpecV2(inputV2Of(config('bag-holders')));
    const art = artOf();
    expect(artCommittedBy(spec, art)).toBe(true);
    expect(artCommittedBy(spec, artOf(5))).toBe(false);
    expect(artCommittedBy(spec, null)).toBe(false);
    const resalted = { ...art, salts: art.salts.map((salt, i) => (i === 0 ? sha256Hex(new TextEncoder().encode('another salt')) : salt)) };
    expect(artCommittedBy(spec, resalted)).toBe(false);
    expect(committedPictureHashes(spec, artOf(5))).toBeNull();
    expect(committedPictureHashes(spec, null)).toBeNull();
    const token = buildSpecV2(inputV2Of(config('rug-rugs')));
    expect(artCommittedBy(token, null)).toBe(true);
    expect(committedPictureHashes(token, null)).toEqual([token.coverSha256.toLowerCase()]);
  });
});
