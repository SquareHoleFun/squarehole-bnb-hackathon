import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { decodeAbiParameters, encodeAbiParameters, keccak256, type Hex } from 'viem';
import { buildBoxTree } from '../../../packages/artwork/src/box-commitment';
import { canonicalJson } from '../../../packages/artwork/src/manifest';
import { BOX_SPEC_V2_ABI_COMPONENTS, encodeBoxSpecV2, type BoxSpecV2 } from '../src/features/create/v2/spec-types';
import { THREE_D_COUNT, THREE_D_FIXTURE, threeDItemFiles } from '../src/features/create/v2/test-support/three-d-fixture';
import { installUntouchableWallet, overflow, walletTouches } from './box-helpers';

// R74-ART (SH-CREATE-ITEM-MODELS): a small 3D settings file (the page's own Download BoxSpec of ten items, each with a
// model; three-d-fixture.test.ts keeps it fresh) loads through Load settings with its numbered pictures and models, and
// the Overview's spec hash is the one its spec commits with every model: recomputed here, independently of the page,
// from the fixture's spec and list, the draft's new salts and the six-word leaves. The pictures alone are refused, and
// so are models that are not the setup's. On a new collection, the art's (i) says how models come. With
// SH_EVIDENCE_SCREENSHOTS=1 both write the evidence's pictures to docs/evidence/SH-CREATE-ITEM-MODELS/ (desktop, mobile).

const FIXTURE = fileURLToPath(new URL(`../src/features/create/v2/test-support/${THREE_D_FIXTURE}`, import.meta.url));
const ZERO = `0x${'0'.repeat(64)}` as Hex;
const files = (models = true) => threeDItemFiles({ models }).map((file) => ({ name: file.name, mimeType: file.mimeType, buffer: Buffer.from(file.bytes) }));
const sha256 = (text: string): Hex => `0x${createHash('sha256').update(text).digest('hex')}`;
const next = (page: Page) => page.getByRole('button', { name: 'Next', exact: true }).click();
/** The item files with 1.glb and 2.glb trading bytes: each model is real, but not its id's. */
const swappedModels = () => files().map((file) => (file.name === '1.glb' || file.name === '2.glb' ? { ...file, name: file.name === '1.glb' ? '2.glb' : '1.glb' } : file));
const EVIDENCE = process.env.SH_EVIDENCE_SCREENSHOTS === '1';
/** One part of the page as the creator sees it, for the evidence (only with SH_EVIDENCE_SCREENSHOTS=1). */
async function shot(target: Locator, info: TestInfo, name: string) {
  if (!EVIDENCE) return;
  await target.page().evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await target.screenshot({ path: fileURLToPath(new URL(`../../../docs/evidence/SH-CREATE-ITEM-MODELS/${name}-${info.project.name}.png`, import.meta.url)), scale: 'css' });
}

interface ListEntry { readonly id: string; readonly traitsPacked: string; readonly imageSha256: Hex; readonly avatarSha256: Hex; readonly modelSha256: Hex; readonly salt: Hex }
interface Fixture { readonly encoded: Hex; readonly specHash: Hex; readonly revealList: { readonly format: string; readonly n: string; readonly items: readonly ListEntry[] } }

/** The spec hash the loaded setup commits: the file's spec with the root and list id its list gives under `salts`. */
function expectedHash(fixture: Fixture, salts: readonly Hex[], withModels = true): Hex {
  const [spec] = decodeAbiParameters([{ type: 'tuple', components: BOX_SPEC_V2_ABI_COMPONENTS }], fixture.encoded) as unknown as [BoxSpecV2];
  const items = fixture.revealList.items.map((entry, i) => ({ ...entry, modelSha256: withModels ? entry.modelSha256 : ZERO, salt: salts[i] as Hex }));
  const leaves = items.map((entry) => keccak256(encodeAbiParameters(['uint256', 'uint128', 'bytes32', 'bytes32', 'bytes32', 'bytes32'].map((type) => ({ type })),
    [BigInt(entry.id), BigInt(entry.traitsPacked), entry.imageSha256, entry.avatarSha256, entry.modelSha256, entry.salt])));
  const revealRoot = buildBoxTree(leaves, items.length).root as Hex;
  const revealListId = sha256(canonicalJson({ format: fixture.revealList.format, n: fixture.revealList.n, items }));
  return keccak256(encodeBoxSpecV2({ ...spec, revealRoot, revealListId }));
}

test.beforeEach(async ({ page }) => {
  await installUntouchableWallet(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

test('Load settings: a 3D setup takes its pictures and models, and the Overview’s spec hash commits every model', async ({ page }, info) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture;
  expect(fixture.revealList.items).toHaveLength(THREE_D_COUNT);
  expect(fixture.revealList.items.every((entry) => entry.modelSha256 !== ZERO)).toBe(true);

  await page.goto('/create/v2-basics');
  await page.locator('#create-load-settings').setInputFiles(FIXTURE);
  await expect(page.getByText(`Item pictures + models · ${THREE_D_COUNT}`)).toBeVisible();
  await expect(page.locator('#create-load-items-files')).toHaveText('Images + models + traits');
  const load = page.locator('[data-load-settings]');
  await shot(load, info, 'load-asks-models');
  // The pictures alone: refused, nothing loaded.
  await page.locator('#create-load-items').setInputFiles(files(false));
  await expect(page.locator('[data-load-problem]')).toContainText('This setup has 3D models: add 1.glb … N.glb with the pictures.');
  await expect(page.locator('[data-loaded-setup]')).toHaveCount(0);
  await shot(load, info, 'load-pictures-alone');
  // Two ids' models traded: each is a real model, but not its id's, so the line names the models.
  await page.locator('#create-load-items').setInputFiles(swappedModels());
  await expect(page.locator('[data-load-problem]')).toContainText('These item pictures, models or traits are not the setup’s.');
  await expect(page.locator('[data-loaded-setup]')).toHaveCount(0);
  await shot(load, info, 'load-models-not-setup');
  // With their models: the whole setup loads.
  await page.locator('#create-load-items').setInputFiles(files());
  const loaded = page.locator('[data-loaded-setup]');
  await expect(loaded).toContainText('From the loaded setup.');
  await expect(loaded).toContainText(`${THREE_D_COUNT} items, 3D`);
  await expect(page.locator('[data-load-problem]')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Glass Houses');
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await shot(loaded, info, 'loaded-3d');

  await next(page);
  await expect(page.getByRole('status').filter({ hasText: /^10 items · 1 trait · 3D$/ })).toBeVisible();
  await shot(page.locator('.sh-newbox-field', { has: page.locator('#create-art-label') }), info, 'contents-3d');
  await next(page); await next(page); await next(page);
  await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check();
  await next(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  const shown = await page.locator('[data-spec-hash]').getAttribute('data-spec-hash');

  // The new box's salts, as the draft keeps them (each item's model hash with them), never the file's.
  const art = JSON.parse(await page.evaluate(() => window.sessionStorage.getItem('sh.create.art.v2') ?? 'null')) as { items: { id: number; modelSha256?: Hex }[]; salts: Hex[] } | null;
  if (!art) throw new Error('no stored art');
  expect(art.items.map((item) => item.modelSha256)).toEqual(fixture.revealList.items.map((entry) => entry.modelSha256));
  expect(art.salts).not.toEqual(fixture.revealList.items.map((entry) => entry.salt));
  expect(shown).toBe(expectedHash(fixture, art.salts));
  expect(shown).not.toBe(expectedHash(fixture, art.salts, false));
  expect(shown).not.toBe(fixture.specHash);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  expect(await walletTouches(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('Contents: the art’s (i) says how a 3D collection’s models come, behind its closed Details', async ({ page }, info) => {
  await page.goto('/create/v2-contents');
  await page.getByRole('radio', { name: /^New collection/ }).check();
  const line = page.getByText('3D: a model beside every picture, 1.glb … N.glb (one self-contained GLB, up to 1 MB each).');
  await expect(line).toBeHidden();
  await page.getByRole('button', { name: 'About the art files' }).click();
  await expect(line).toBeVisible();
  // The picker takes models without asking: its button keeps its words.
  await expect(page.locator('#create-art-files')).toHaveText('Images + traits');
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await shot(page.locator('.sh-newbox-field', { has: page.locator('#create-art-label') }), info, 'contents-art-info');
  expect(await walletTouches(page)).toEqual([]);
});
