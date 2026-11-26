/**
 * Reading the creator's files (box creation flow § 3): pictures by content and id, traits from one file or per-item
 * metadata, the table's character rules with the item ids named, the cover re-encoded, hashed and kept. Nothing
 * throws: problems are grouped by rule, at most three lines.
 */
import { MAX_RAW_BLOCK_BYTES, sha256Hex } from '@squarehole/artwork';
import { describe, expect, it } from 'vitest';
import { shLimit } from '../../../../../vitest.timeouts.mjs';
import { C2PA_FIXTURES, caBX, pngStore, readC2paFixture } from '../../../../../packages/artwork/src/test-support/c2pa';
import { SVG_WITH_SCRIPT, makePng, pngText } from '../../../../../packages/artwork/src/test-support/images';
import { BANNER_TOO_NARROW, ITEM_LIMITS, MAX_PROBLEM_LINES, MODEL_WORDS, fromBase64, inspectModel, readArt, readCover, readPicture, tableProblems, toBase64, type ArtEnvironment } from './art-files';
import { NOT_A_GLB, glbOf, truncatedGlb } from './test-support/models';
import { TEASER_IS_ITEM, teaserRefusal } from './use-create-flow';
import { DEFAULT_FORM } from './create-model';
import { fitsFree } from '../pictures/arweave-publish';
import { TOO_DETAILED } from '../pictures/shrink';

function env(): ArtEnvironment & { readonly salts: number } {
  let salts = 0;
  return {
    digest: async (bytes) => sha256Hex(bytes),
    thumbnail: async () => 'data:image/png;base64,iVBORw0KGgo=',
    encodeCover: async (file) => ({ bytes: new Uint8Array(await file.arrayBuffer()) }),
    salt: () => {
      salts += 1;
      return sha256Hex(new TextEncoder().encode(`salt-${salts}`));
    },
    get salts() {
      return salts;
    },
  };
}

const png = (side = 32) => makePng({ width: side, height: side, decodable: true });
const file = (name: string, bytes: Uint8Array | string, type = 'image/png') => new File([typeof bytes === 'string' ? bytes : bytes.slice().buffer], name, { type });
const pictures = (n: number, skip: readonly number[] = []) => Array.from({ length: n }, (_, i) => i + 1).filter((id) => !skip.includes(id)).map((id) => file(`${id}.png`, png()));

describe('readArt', () => {
  it('reads pictures 1..N and a traits CSV: items in id order, sha256 of the file as uploaded, a salt each', async () => {
    const csv = ['id,Colour,Shape', ...Array.from({ length: 10 }, (_, i) => `${i + 1},${i % 2 ? 'Teal' : 'Red'},Square`)].join('\n');
    const e = env();
    const progress: number[] = [];
    const art = await readArt([...pictures(10).reverse(), file('traits.csv', csv, 'text/csv')], { env: e, onProgress: (done) => progress.push(done) });
    expect(art.problems).toEqual([]);
    expect(art.items.map((item) => item.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(art.items[0]?.imageSha256).toBe(sha256Hex(png()));
    expect(art.items[1]?.traits).toEqual([
      { trait: 'Colour', value: 'Teal' },
      { trait: 'Shape', value: 'Square' },
    ]);
    expect(art.salts).toHaveLength(10);
    expect(new Set(art.salts).size).toBe(10);
    expect(art.thumbs).toHaveLength(8);
    expect(art.totalBytes).toBe(10 * png().byteLength);
    expect(progress.at(-1)).toBe(10);
  });

  it('a folder: <id>.json metadata, of which only attributes is read', async () => {
    const meta = (id: number) => file(`${id}.json`, JSON.stringify({ name: `Item ${id}`, image: 'https://example.invalid/x.png', attributes: [{ trait_type: 'Size', value: id < 5 ? 'Small' : 'Big' }] }), 'application/json');
    const art = await readArt([...pictures(10), ...Array.from({ length: 10 }, (_, i) => meta(i + 1)), file('.DS_Store', 'x', '')], { env: env() });
    expect(art.problems).toEqual([]);
    expect(art.items[6]?.traits).toEqual([{ trait: 'Size', value: 'Big' }]);
  });

  it('names the file or ids of each problem: duplicates, wrong names, content that is not a picture, gaps', async () => {
    const one = async (files: File[]) => (await readArt([...pictures(10), ...files], { env: env() })).problems;
    expect(await one([file('1.webp', png())])).toEqual(['1.webp: id 1 is already 1.png.']);
    expect(await one([file('cover.png', png())])).toEqual(['cover.png: name each picture after its id (1.png, 2.png …).']);
    expect(await one([file('notes.txt', 'hello', 'text/plain')])).toEqual(['notes.txt: not a picture (PNG, JPEG or WebP) or a traits file.']);
    expect(await one([file('11.png', SVG_WITH_SCRIPT)])).toEqual([expect.stringMatching(/^11\.png: /)]);
    expect((await readArt(pictures(10, [4, 7, 8, 9]), { env: env() })).problems).toEqual([expect.stringMatching(/^Missing pictures for ids 4, 7–9/)]);
  });

  it('groups problems by rule, one line each with a count and an example, at most three lines', async () => {
    const misnamed = Array.from({ length: 37 }, (_, i) => file(`cat-${String(i + 1).padStart(2, '0')}.png`, png()));
    expect((await readArt([...pictures(10), ...misnamed], { env: env() })).problems).toEqual(['37 pictures not named by id, e.g. cat-01.png (use 1.png, 2.png …).']);
    const art = await readArt(
      [...pictures(10, [4, 7, 8, 9]), file('1.webp', png()), file('2.webp', png()), file('cover.png', png()), file('9.png', SVG_WITH_SCRIPT), file('notes.txt', 'hello', 'text/plain')],
      { env: env() },
    );
    expect(art.problems).toHaveLength(MAX_PROBLEM_LINES);
    expect(art.problems).toEqual([
      '2 pictures repeat an id, e.g. 1.webp: id 1 is already 1.png.',
      'cover.png: name each picture after its id (1.png, 2.png …).',
      '…and 3 more problems.',
    ]);
  });

  it('refuses a picture over one raw block (1 MiB) and traits for ids without a picture', async () => {
    const big = makePng({ width: 32, height: 32, decodable: true, trailing: new Uint8Array(0) });
    const huge = new Uint8Array(1_048_577);
    huge.set(big);
    const csv = 'id,Colour\n1,Red\n12,Blue\n';
    const art = await readArt([...pictures(10).slice(1), file('1.png', huge), file('traits.csv', csv, 'text/csv')], { env: env() });
    // SH-AI-PLAN: how large it is, rounded up to a tenth of a MB (never "1.0 MB" for a file over the limit), and what to do.
    expect(art.problems).toContain('1.png is 1.1 MB. Max 1 MB. Save it as WebP or JPEG.');
    expect(art.problems).toContain('Traits for ids without a picture: 12.');
  });

  it('takes a traits file up to a box’s 10,000 items (no longer the old 2,000), and refuses one row more (SH-AI-PLAN)', async () => {
    const tiny = png(16);
    const numbered = (n: number) => Array.from({ length: n }, (_, i) => file(`${i + 1}.png`, tiny));
    const traits = (n: number) => file('traits.csv', ['id,Shade', ...Array.from({ length: n }, (_, i) => `${i + 1},s${i % 9}`)].join('\n'), 'text/csv');
    const ten = await readArt([...numbered(10_000), traits(10_000)], { env: env() });
    expect(ten.problems).toEqual([]);
    expect(ten.items).toHaveLength(10_000);
    expect(ten.items[9_999]?.traits).toEqual([{ trait: 'Shade', value: 's0' }]);
    const more = await readArt([...numbered(2_001), traits(2_001)], { env: env() });
    expect(more.problems).toEqual([]);
    expect((await readArt([...numbered(10), traits(10_001)], { env: env() })).problems).toEqual(['Traits: This site accepts at most 10,000 items (found 10,001).']);
  }, shLimit(60_000));

  it('the table rules: no " or \\ or non-ASCII, at most 16 types and 255 values each, naming the items', () => {
    expect(tableProblems([{ id: 3, traits: [{ trait: 'Mood', value: 'Say "hi"' }] }, { id: 4, traits: [{ trait: 'Mood', value: 'Say "hi"' }] }])).toEqual([
      'Items 3–4: "Say "hi"" uses a character the box cannot store (plain letters, numbers and punctuation; no " or \\).',
    ]);
    expect(tableProblems([{ id: 1, traits: [{ trait: 'Café', value: 'Ok' }] }])[0]).toMatch(/^Items 1: "Café"/);
    const types = Array.from({ length: 17 }, (_, i) => ({ trait: `T${i}`, value: 'v' }));
    expect(tableProblems([{ id: 1, traits: types }])).toEqual(['17 trait types: a box holds at most 16.']);
    const values = Array.from({ length: 256 }, (_, i) => ({ id: i + 1, traits: [{ trait: 'Number', value: `n${i}` }] }));
    expect(tableProblems(values)).toEqual(['Trait "Number" has 256 values: at most 255.']);
  });
});

describe('readCover', () => {
  it('checks the content, re-encodes, hashes the stored bytes and keeps a thumbnail', async () => {
    const cover = makePng({ width: 512, height: 512, decodable: true });
    const result = await readCover(file('cover.png', cover), env());
    expect(result).toEqual({ cover: { sha256: sha256Hex(cover), url: 'data:image/png;base64,iVBORw0KGgo=', bytes: cover.byteLength, data: toBase64(cover) } });
    // The kept bytes are exactly the ones the hash commits to (a browser cannot re-encode them byte for byte later).
    expect(fromBase64(toBase64(cover))).toEqual(cover);
    expect(fromBase64('not base64!')).toBeNull();
  });

  it('refuses a small picture, a script in disguise and a browser that cannot draw it', async () => {
    expect(await readCover(file('small.png', png(64)), env())).toEqual({ error: expect.stringMatching(/at least 256/) });
    expect(await readCover(file('cover.png', SVG_WITH_SCRIPT), env())).toEqual({ error: expect.any(String) });
    const blind = { ...env(), encodeCover: async () => ({ error: 'This browser could not read the picture.' }) };
    expect(await readCover(file('cover.png', makePng({ width: 512, height: 512, decodable: true })), blind)).toEqual({ error: 'This browser could not read the picture.' });
  });
});

describe('readPicture: the banner and the teasers (add-on 6)', () => {
  it('a banner must be at least 2:1 as drawn (shown at 4:1, its hash fixed for good)', async () => {
    const wide = makePng({ width: 1024, height: 256, decodable: true });
    expect(await readPicture(file('banner.png', wide), env(), 'banner')).toMatchObject({ picture: { sha256: sha256Hex(wide) } });
    const two = makePng({ width: 512, height: 256, decodable: true });
    expect(await readPicture(file('banner.png', two), env(), 'banner')).toMatchObject({ picture: { sha256: sha256Hex(two) } });
    for (const [width, height] of [[256, 256], [256, 512], [500, 256]] as const) {
      expect(await readPicture(file('banner.png', makePng({ width, height, decodable: true })), env(), 'banner'), `${width} × ${height}`).toEqual({ error: BANNER_TOO_NARROW });
    }
    // The shape that counts is the one drawn: a browser that turns the picture (EXIF) re-encodes it upright.
    const turned = { ...env(), encodeCover: async () => ({ bytes: makePng({ width: 1024, height: 256, decodable: true }) }) };
    expect(await readPicture(file('photo.png', makePng({ width: 256, height: 1024, decodable: true })), turned, 'banner')).toMatchObject({ picture: expect.any(Object) });
    // A teaser has no shape rule.
    expect(await readPicture(file('t.png', makePng({ width: 256, height: 512, decodable: true })), env(), 'teaser')).toMatchObject({ picture: expect.any(Object) });
  });

  it('keeps the sha256 of the file as uploaded, so a teaser can be compared with the items (hashed as uploaded)', async () => {
    const bytes = makePng({ width: 300, height: 300, decodable: true });
    const processed = makePng({ width: 280, height: 280, decodable: true });
    const reencode = { ...env(), encodeCover: async () => ({ bytes: processed }) };
    expect(await readPicture(file('t.png', bytes), reencode, 'teaser')).toMatchObject({ sourceSha256: sha256Hex(bytes), picture: { sha256: sha256Hex(processed) } });
  });
});

/**
 * SH-ARWEAVE-PICTURES-WEB: where the source keeps the logo and cover on Arweave, those two are shrunk by the free ladder
 * (pictures/shrink.ts) and one that cannot fit Turbo's free tier is refused as it is read, long before Create. The banner
 * and teasers keep their rule; without Arweave every picture keeps it.
 */
describe('readPicture with the free tier (Arweave on)', () => {
  const FITS = fitsFree(11155111, 107_520);
  // A picture over Turbo's free size (a large comment chunk pads it).
  const padded = (width: number, height: number) => makePng({ width, height, decodable: true, before: [pngText('Comment', 'x'.repeat(120_000))] });
  const big = padded(512, 512);
  const picture = makePng({ width: 512, height: 512, decodable: true });

  it('the logo and a collection cover go through encodeFree with the fit; the banner and teasers do not', async () => {
    const shrunk = makePng({ width: 300, height: 300, decodable: true });
    const asked: string[] = [];
    const free: ArtEnvironment = { ...env(), encodeFree: async (_file, fits) => { asked.push(`free ${fits(shrunk.byteLength, 'image/png')}`); return { bytes: shrunk }; },
      encodeCover: async (f) => { asked.push('cover'); return { bytes: new Uint8Array(await f.arrayBuffer()) }; } };
    expect(await readPicture(file('logo.png', picture), free, 'logo', FITS)).toMatchObject({ picture: { sha256: sha256Hex(shrunk), bytes: shrunk.byteLength } });
    expect(await readPicture(file('cover.png', picture), free, 'collection', FITS)).toMatchObject({ picture: { sha256: sha256Hex(shrunk) } });
    expect(asked).toEqual(['free true', 'free true']);
    asked.length = 0;
    await readPicture(file('t.png', picture), free, 'teaser', FITS);
    await readPicture(file('b.png', makePng({ width: 1024, height: 256, decodable: true })), free, 'banner', FITS);
    // Arweave off: the earlier rule, even for the logo.
    await readPicture(file('logo.png', picture), free, 'logo', null);
    expect(asked).toEqual(['cover', 'cover', 'cover']);
  });

  it('a result that does not fit is refused with one short line, whoever encoded it (no 1 MiB fallback)', async () => {
    expect(big.byteLength).toBeGreaterThan(107_520);
    // An environment without the ladder: its encoding is checked against the same fit.
    expect(await readPicture(file('logo.png', big), env(), 'logo', FITS)).toEqual({ error: TOO_DETAILED });
    expect(await readPicture(file('logo.png', picture), env(), 'logo', FITS)).toMatchObject({ picture: { sha256: sha256Hex(picture) } });
    // The ladder's own refusal comes through as it is.
    const refusing: ArtEnvironment = { ...env(), encodeFree: async () => ({ error: TOO_DETAILED }) };
    expect(await readPicture(file('logo.png', picture), refusing, 'collection', FITS)).toEqual({ error: TOO_DETAILED });
    // A banner of the same size is not published to Arweave and keeps its rule.
    expect(await readPicture(file('b.png', padded(1024, 256)), env(), 'banner', FITS)).toMatchObject({ picture: expect.any(Object) });
  });
});

describe('AI pictures with C2PA content credentials (SH-ACCEPT-C2PA, founder decision 2026-10-24)', () => {
  const holdsStore = (bytes: Uint8Array) => Buffer.from(bytes).includes('caBX') && Buffer.from(bytes).includes('c2pa.icon');

  it.each(C2PA_FIXTURES.map((fixture) => [fixture.name, fixture] as const))('%s is accepted as the logo, a collection cover and a teaser', async (_name, fixture) => {
    const bytes = readC2paFixture(fixture.name);
    for (const kind of ['logo', 'collection', 'teaser'] as const) {
      const result = await readPicture(file(`${kind}.png`, bytes), env(), kind);
      expect(result, kind).toMatchObject({ sourceSha256: `0x${fixture.sha256}`, picture: { sha256: expect.any(String) } });
    }
    expect(await readCover(file('logo.png', bytes), env())).toMatchObject({ cover: { bytes: fixture.bytes } });
  });

  it('an AI picture is an item as uploaded: the stored file and its hash keep the C2PA store, byte for byte', async () => {
    const fixture = C2PA_FIXTURES.find((f) => f.bytes <= MAX_RAW_BLOCK_BYTES);
    if (!fixture) throw new Error('no fixture fits one raw block');
    const bytes = readC2paFixture(fixture.name);
    const kept = new Map<string, File>();
    const art = await readArt([file('1.png', bytes)], { env: env(), onItemFile: (sha, item) => kept.set(sha, item) });
    expect(art.problems).toEqual([]);
    expect(art.items).toEqual([expect.objectContaining({ id: 1, imageSha256: `0x${fixture.sha256}`, bytes: fixture.bytes })]);
    const stored = new Uint8Array(await (kept.get(`0x${fixture.sha256}`) as File).arrayBuffer());
    expect(stored).toEqual(bytes);
    expect(holdsStore(stored)).toBe(true);
  });

  it('item pictures carrying each real store are accepted unchanged; hashes are of the bytes with the store', async () => {
    const items = C2PA_FIXTURES.map((fixture) => makePng({ width: 64, height: 64, decodable: true, before: [caBX(pngStore(readC2paFixture(fixture.name)))] }));
    const kept = new Map<string, File>();
    const art = await readArt(items.map((bytes, i) => file(`${i + 1}.png`, bytes)), { env: env(), onItemFile: (sha, item) => kept.set(sha, item) });
    expect(art.problems).toEqual([]);
    expect(art.items.map((item) => item.imageSha256)).toEqual(items.map((bytes) => sha256Hex(bytes)));
    expect(art.totalBytes).toBe(items.reduce((sum, bytes) => sum + bytes.byteLength, 0));
    for (const bytes of items) expect(new Uint8Array(await (kept.get(sha256Hex(bytes)) as File).arrayBuffer())).toEqual(bytes);
  });

  it('the item size limit is unchanged: AI pictures over one raw block (1 MiB) are refused for their size, not as polyglots', async () => {
    expect(ITEM_LIMITS.maxBytes).toBe(MAX_RAW_BLOCK_BYTES);
    const large = C2PA_FIXTURES.filter((fixture) => fixture.bytes > MAX_RAW_BLOCK_BYTES);
    expect(large.length).toBeGreaterThan(0);
    const art = await readArt(large.map((fixture, i) => file(`${i + 1}.png`, readC2paFixture(fixture.name))), { env: env() });
    expect(art.items).toEqual([]);
    expect(art.problems[0]).toMatch(new RegExp(`^${large.length} pictures refused, e.g. 1\\.png is [0-9.]+ MB\\. Max 1 MB\\.`));
    expect(art.problems.join(' ')).not.toMatch(/polyglot/);
  });
});

describe('teaserRefusal (F71: teasers without revealing the art)', () => {
  const item = sha256Hex(new TextEncoder().encode('item 3 as uploaded'));
  const art = { items: [{ id: 3, imageSha256: item, traits: [], bytes: 10 }], salts: [], thumbs: [], totalBytes: 10, problems: [] };
  it('refuses one of the hidden items as a teaser; open art, another picture or no art yet is fine', () => {
    const hidden = { ...DEFAULT_FORM, contents: 'collection' as const, artMode: 'hidden' as const };
    expect(teaserRefusal({ form: hidden, art }, item)).toBe(TEASER_IS_ITEM);
    expect(teaserRefusal({ form: hidden, art }, item.toUpperCase().replace('0X', '0x') as `0x${string}`)).toBe(TEASER_IS_ITEM);
    expect(teaserRefusal({ form: hidden, art }, sha256Hex(new TextEncoder().encode('another picture')))).toBeNull();
    expect(teaserRefusal({ form: { ...hidden, artMode: 'open' }, art }, item)).toBeNull();
    expect(teaserRefusal({ form: hidden, art: null }, item)).toBeNull();
  });
});

/**
 * R74-ART (SH-CREATE-ITEM-MODELS): a 3D model beside each numbered picture, `<id>.glb`, checked by the rules the site's
 * model viewer applies (artwork `glbSha256`: binary glTF 2.0, its declared length the file's, a JSON chunk first, no
 * outside files, one raw block) and hashed as uploaded. A model for every picture or for none.
 */
describe('readArt with 3D models', () => {
  const glb = (id: number, options: Parameters<typeof glbOf>[1] = {}) => file(`${id}.glb`, glbOf(id, options), 'model/gltf-binary');
  const models = (n: number, skip: readonly number[] = []) => Array.from({ length: n }, (_, i) => i + 1).filter((id) => !skip.includes(id)).map((id) => glb(id));

  it('reads 1.glb … N.glb beside 1.png … N.png: each item’s model sha256 as uploaded and its size; the files kept by sha256', async () => {
    const kept = new Map<string, File>();
    const progress: number[] = [];
    const art = await readArt([...pictures(10), ...models(10).reverse(), file('traits.csv', 'id,Colour\n1,Red\n', 'text/csv')], { env: env(), onProgress: (done) => progress.push(done), onItemFile: (sha, item) => kept.set(sha, item) });
    expect(art.problems).toEqual([]);
    expect(art.items.map((item) => item.modelSha256)).toEqual(Array.from({ length: 10 }, (_, i) => sha256Hex(glbOf(i + 1))));
    expect(art.items.map((item) => item.modelBytes)).toEqual(Array.from({ length: 10 }, (_, i) => glbOf(i + 1).byteLength));
    // Every picture is still hashed as before; the model's bytes count towards the art's size.
    expect(art.items[0]?.imageSha256).toBe(sha256Hex(png()));
    expect(art.totalBytes).toBe(10 * png().byteLength + Array.from({ length: 10 }, (_, i) => glbOf(i + 1).byteLength).reduce((a, b) => a + b, 0));
    expect(progress.at(-1)).toBe(20);
    for (let id = 1; id <= 10; id += 1) expect(new Uint8Array(await (kept.get(sha256Hex(glbOf(id))) as File).arrayBuffer())).toEqual(glbOf(id));
    // A model with a binary chunk, as an exporter writes it, is as good; "007.glb" is item 7, as "007.png" would be.
    const bin = await readArt([...pictures(10, [7]), file('007.png', png()), ...models(10, [7]), file('007.glb', glbOf(7, { bin: 40 }))], { env: env() });
    expect(bin.problems).toEqual([]);
    expect(bin.items[6]?.modelSha256).toBe(sha256Hex(glbOf(7, { bin: 40 })));
  });

  it('art without models is read as before: no model fields at all (a 2D collection is unchanged)', async () => {
    const art = await readArt(pictures(10), { env: env() });
    expect(art.problems).toEqual([]);
    expect(art.items.every((item) => !('modelSha256' in item) && !('modelBytes' in item))).toBe(true);
    expect(art.totalBytes).toBe(10 * png().byteLength);
  });

  it('refuses an oversized model, one that is no GLB, a truncated one and one that loads an outside file, by name', async () => {
    const one = async (bad: File) => (await readArt([...pictures(10), ...models(10, [3]), bad], { env: env() })).problems;
    expect(await one(file('3.glb', glbOf(3, { pad: 1_048_576 })))).toEqual(['3.glb is 1.1 MB. Max 1 MB.']);
    expect(await one(file('3.glb', NOT_A_GLB))).toEqual(['3.glb: not a GLB model (binary glTF 2.0).']);
    expect(await one(file('3.glb', truncatedGlb(3).slice()))).toEqual(['3.glb: not a GLB model (binary glTF 2.0).']);
    expect(await one(file('3.glb', glbOf(3, { external: true })))).toEqual(['3.glb: the model loads other files. Use one self-contained GLB.']);
    // A refused model is never also counted as missing, and the art is unusable while it stands.
    const art = await readArt([...pictures(10), ...models(10, [3]), file('3.glb', NOT_A_GLB)], { env: env() });
    expect(art.problems).toHaveLength(1);
    expect(art.items[2]).not.toHaveProperty('modelSha256');
    // Several refusals: one line with a count and an example.
    expect((await readArt([...pictures(10), ...models(10, [3, 4]), file('3.glb', NOT_A_GLB), file('4.glb', NOT_A_GLB)], { env: env() })).problems)
      .toEqual(['2 models refused, e.g. 3.glb: not a GLB model (binary glTF 2.0).']);
  });

  it('a model for every picture or for none: missing models and models without a picture are named, never left out', async () => {
    expect((await readArt([...pictures(10), ...models(10, [4, 7, 8, 9])], { env: env() })).problems).toEqual([MODEL_WORDS.missing('4, 7–9')]);
    expect((await readArt([...pictures(10), ...models(10), glb(12)], { env: env() })).problems).toEqual([MODEL_WORDS.orphans('12')]);
    expect((await readArt([...pictures(10), glb(1)], { env: env() })).problems).toEqual([MODEL_WORDS.missing('2–10')]);
  });

  it('names models not named by id and an id given twice', async () => {
    expect((await readArt([...pictures(10), ...models(10), file('house.glb', glbOf(1))], { env: env() })).problems).toEqual(['house.glb: name each model after its picture’s id (1.glb, 2.glb …).']);
    expect((await readArt([...pictures(10), ...models(10), file('0.glb', glbOf(1))], { env: env() })).problems).toEqual(['0.glb: name each model after its picture’s id (1.glb, 2.glb …).']);
    expect((await readArt([...pictures(10), ...models(10), file('01.glb', glbOf(1, { variant: 'b' }))], { env: env() })).problems).toEqual(['01.glb: id 1 is already 1.glb.']);
    // A hidden system file named like a model is skipped, as hidden pictures are.
    expect((await readArt([...pictures(10), ...models(10), file('._1.glb', 'x', '')], { env: env() })).problems).toEqual([]);
  });

  it('a plan’s pictures have any names, so models are refused with a plan (SH-AI-PLAN)', async () => {
    const plan = file('plan.csv', 'file,count,Colour\nred.png,10,Red\n', 'text/csv');
    const art = await readArt([file('red.png', png()), file('1.glb', glbOf(1)), plan], { env: env(), });
    expect(art.planned).toBe(true);
    expect(art.problems).toContain(MODEL_WORDS.withPlan);
    expect(art.items).toEqual([]);
  });

  it('inspectModel: the viewer’s rules and the sha256 of the bytes as given', () => {
    expect(inspectModel(glbOf(5))).toEqual({ ok: true, sha256: sha256Hex(glbOf(5)) });
    expect(inspectModel(glbOf(5, { pad: 1_048_576 }))).toEqual({ ok: false, reason: 'too_large' });
    expect(inspectModel(NOT_A_GLB)).toEqual({ ok: false, reason: 'not_glb' });
    expect(inspectModel(glbOf(5, { external: true }))).toEqual({ ok: false, reason: 'external' });
    expect(inspectModel(new Uint8Array(0))).toEqual({ ok: false, reason: 'not_glb' });
  });
});
