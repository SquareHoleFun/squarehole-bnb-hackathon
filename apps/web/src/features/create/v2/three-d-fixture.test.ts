/**
 * R74-ART (SH-CREATE-ITEM-MODELS): the committed 3D settings fixture (test-support/three-d-boxspec-v2.json, loaded by
 * e2e/create-v2-models.spec.ts) is the page's own Download BoxSpec of the fixture's items, byte for byte, and loads back
 * through Load settings with those items. `SH_WRITE_FIXTURES=1` writes it again after a deliberate change.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '@squarehole/artwork';
import { afterEach, describe, expect, it } from 'vitest';
import { readArt, toBase64, type ArtEnvironment } from '../art-files';
import { DEFAULT_FORM, commitArt, revealList, type CoverState } from '../create-model';
import { forgetItemFiles, keepItemFiles } from '../item-files';
import { DEMO_LISTINGS, NATIVE_TOKEN } from './listings';
import { finishLoad, readSettingsFile, setupOf } from './load-settings';
import { DEFAULT_V2, boxSpecFile, buildSpecV2, recipeCtx, type BuildV2Input } from './model';
import { committedModels, committedPictures } from './pictures';
import { pickFor } from './recipes';
import { specHashV2 } from './spec-types';
import { THREE_D_COUNT, THREE_D_FIXTURE, threeDCover, threeDItemFiles, threeDLogo, threeDSalt } from './test-support/three-d-fixture';
import { glbOf } from '../test-support/models';

const PATH = join(dirname(fileURLToPath(import.meta.url)), 'test-support', THREE_D_FIXTURE);
const digest = async (bytes: Uint8Array) => sha256Hex(bytes);
const filesOf = (models = true) => threeDItemFiles({ models }).map((file) => new File([file.bytes.slice().buffer], file.name, { type: file.mimeType }));
const picture = (bytes: Uint8Array): CoverState => ({ sha256: sha256Hex(bytes), url: null, bytes: bytes.byteLength, data: toBase64(bytes) });
const envWith = (salt: () => `0x${string}`): ArtEnvironment => ({ digest, thumbnail: async () => null, encodeCover: async (file) => ({ bytes: new Uint8Array(await file.arrayBuffer()) }), salt });

/** The fixture's settings file, as the page downloads it (no owner: the Demo with no wallet connected). */
async function fixtureText(): Promise<string> {
  let next = 0;
  const kept = new Map<string, Blob>();
  const art = await readArt(filesOf(), { env: envWith(() => threeDSalt((next += 1))), onItemFile: (sha256, file) => kept.set(sha256, file) });
  if (art.problems.length > 0) throw new Error(art.problems.join(' '));
  keepItemFiles(kept);
  const commitment = commitArt(art, 'open');
  const input: BuildV2Input = {
    form: { ...DEFAULT_FORM, name: 'Glass Houses', ticker: 'HOUSE', description: 'Ten glass houses, each with its own model.', contents: 'collection', rights: true },
    art, commitment, cover: picture(threeDLogo()), collectionCover: picture(threeDCover()), owner: null, nowMs: 0,
    v2: { ...DEFAULT_V2, pricing: NATIVE_TOKEN, buyers: pickFor('burn'), sellers: pickFor('burn') }, listings: DEMO_LISTINGS,
  };
  const spec = buildSpecV2(input);
  const { pictures, missing } = await committedPictures(spec, { cover: input.cover, collectionCover: input.collectionCover ?? null, art }, digest);
  const { models, missing: lost } = await committedModels(spec, { art });
  if (missing.length > 0 || lost.length > 0) throw new Error('fixture files missing');
  return boxSpecFile(spec, recipeCtx(input), { pictures, models, revealList: revealList(art, commitment?.packed ?? []) }).parts.join('');
}

afterEach(() => forgetItemFiles());

describe('the 3D settings fixture', () => {
  it('is the page’s own download of the fixture items, byte for byte', async () => {
    const text = await fixtureText();
    if (process.env.SH_WRITE_FIXTURES === '1') writeFileSync(PATH, text);
    expect(readFileSync(PATH, 'utf8')).toBe(text);
    const body = JSON.parse(text) as { specHash: string; models: { sha256: string }[]; revealList: { items: { modelSha256: string }[] } };
    expect(body.models).toHaveLength(THREE_D_COUNT);
    expect(body.revealList.items.map((entry) => entry.modelSha256)).toEqual(Array.from({ length: THREE_D_COUNT }, (_, i) => sha256Hex(glbOf(i + 1, { bin: 64 }))));
  });

  it('loads back with its pictures and models; the pictures alone are refused', async () => {
    const file = await readSettingsFile(readFileSync(PATH, 'utf8'), digest);
    if (!file.ok) throw new Error(file.error);
    const setup = await setupOf(file.value, DEMO_LISTINGS, async () => null);
    if (!setup.ok) throw new Error(setup.error);
    expect(setup.value.info).toMatchObject({ items: THREE_D_COUNT, hidden: false, models: true });
    const read = async (models: boolean) => readArt(filesOf(models), { env: envWith(() => `0x${'0'.repeat(64)}`) });
    let fresh = 0;
    const done = finishLoad(setup.value, await read(true), DEMO_LISTINGS, NATIVE_TOKEN, 0, { salt: () => sha256Hex(new TextEncoder().encode(`fresh-${(fresh += 1)}`)) });
    if (!done.ok) throw new Error(done.error);
    const built = buildSpecV2({ form: done.value.form, art: done.value.art, commitment: commitArt(done.value.art, 'open'), cover: done.value.cover, collectionCover: done.value.collectionCover, page: done.value.page, owner: null, nowMs: 0, v2: done.value.v2, listings: DEMO_LISTINGS });
    expect(specHashV2({ ...built, revealRoot: file.value.spec.revealRoot, revealListId: file.value.spec.revealListId })).toBe(specHashV2(file.value.spec));
    expect(finishLoad(setup.value, await read(false), DEMO_LISTINGS, NATIVE_TOKEN, 0, { salt: () => `0x${'1'.repeat(64)}` }).ok).toBe(false);
  });
});
