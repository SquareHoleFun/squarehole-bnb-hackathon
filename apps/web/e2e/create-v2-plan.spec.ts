import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { boxLeaf, buildBoxTree, verifyBoxProof } from '../../../packages/artwork/src/index';
import { makePng } from '../../../packages/artwork/src/test-support/images';
import { installUntouchableWallet, overflow, walletTouches } from './box-helpers';

// SH-AI-PLAN in a real browser: Frog Kiln's 12 pictures and its plan.csv on Contents, hidden until drawn. This browser
// deals the 420 numbers with its own crypto.getRandomValues; the reveal file holds the map, and every proof checks.
// Two creations deal differently. The hidden-art line links to the plan guide, which carries the prompt to copy.

const KIT = new URL('../../../examples/boxes/frog-kiln/', import.meta.url);
const two = (i: number) => String(i + 1).padStart(2, '0');
const PICTURES = Array.from({ length: 12 }, (_, i) => ({ name: `variant-${two(i)}.png`, mimeType: 'image/png', buffer: readFileSync(fileURLToPath(new URL(`art/items/variant-${two(i)}.png`, KIT))) }));
const PLAN = { name: 'plan.csv', mimeType: 'text/csv', buffer: readFileSync(fileURLToPath(new URL('plan.csv', KIT))) };
/** The plan's counts by picture sha256 (variants 01-09: 44 toads each; 10-12: 8 each). */
const COUNTS = new Map(PICTURES.map((picture, i) => [`0x${createHash('sha256').update(picture.buffer).digest('hex')}`, i < 9 ? 44 : 8]));
const png = (size: number) => ({ name: `p${size}.png`, mimeType: 'image/png', buffer: Buffer.from(makePng({ width: size, height: size, decodable: true })) });
const next = (page: Page) => page.getByRole('button', { name: 'Next', exact: true }).click();
// SH_EVIDENCE_SCREENSHOTS=1: the evidence pictures of the new lines (docs/evidence/screenshots/sh-ai-plan/).
const EVIDENCE = process.env.SH_EVIDENCE_SCREENSHOTS === '1';
async function shot(page: Page, testInfo: TestInfo, name: string) {
  if (!EVIDENCE) return;
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path: fileURLToPath(new URL(`../../../docs/evidence/screenshots/sh-ai-plan/${name}-${testInfo.project.name}.png`, import.meta.url)), fullPage: true, scale: 'css' });
}

interface RevealItem { readonly id: string; readonly traitsPacked: string; readonly imageSha256: `0x${string}`; readonly avatarSha256: `0x${string}`; readonly modelSha256: `0x${string}`; readonly salt: `0x${string}` }
interface Reveal { readonly format: string; readonly n: string; readonly items: readonly RevealItem[]; readonly revealRoot: `0x${string}`; readonly traitTypes: readonly { name: string; values: string[] }[] }

test.beforeEach(async ({ page }) => {
  await installUntouchableWallet(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

/** Basics, then Contents with the kit's pictures and plan, hidden; Fees, Raise and Opening as they are; then the reveal file. */
async function createWithPlan(page: Page, testInfo?: TestInfo): Promise<Reveal> {
  await page.goto('/create/v2-basics');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Frog Kiln');
  await page.getByRole('textbox', { name: 'Ticker', exact: true }).fill('KILN');
  await page.locator('#create-logo').setInputFiles(png(512));
  await expect(page.getByRole('button', { name: 'Logo Change' })).toBeAttached();
  await next(page);
  await page.getByRole('radio', { name: /^New collection/ }).check();
  await page.getByRole('radio', { name: 'Hidden until drawn' }).check();
  const line = page.locator('[data-plan-note]');
  await expect(line).toHaveAttribute('data-plan-note', 'numbered');
  await page.getByLabel('Images + traits').setInputFiles([...PICTURES, PLAN]);
  await expect(page.getByText('420 items · 2 traits')).toBeVisible({ timeout: 30_000 });
  await expect(line).toHaveAttribute('data-plan-note', 'planned');
  await expect(line).toHaveText('This page picked the numbers at random.');
  if (testInfo) await shot(page, testInfo, '02-contents-planned');
  await page.locator('#create-collection-cover').setInputFiles(png(600));
  await expect(page.locator('#create-collection-cover-action')).toHaveText('Change');
  await next(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Launch a box, step 3 of 6: Fees');
  await next(page);
  await next(page);
  await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check();
  await next(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  await page.getByRole('button', { name: 'Connect to create' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sample wallet' });
  await dialog.getByRole('radio', { name: 'Box wallet A' }).check();
  await dialog.getByRole('button', { name: /^(Connect|Update) sample wallet$/ }).click();
  await expect(dialog).toHaveCount(0);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save reveal file', exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('kiln-reveal-file.json');
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  // Saved: Create is next (the Demo plays the plan; nothing here sends anything).
  await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeEnabled();
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Reveal;
}

/** Counts as planned, ids 1..420, a salt each, the root rebuilt from the file, and every item's proof. */
function checkReveal(reveal: Reveal) {
  expect(reveal.format).toBe('squarehole.box-reveal-list/1');
  expect(reveal.n).toBe('420');
  expect(reveal.items.map((item) => item.id)).toEqual(Array.from({ length: 420 }, (_, i) => String(i + 1)));
  const counts = new Map<string, number>();
  for (const item of reveal.items) counts.set(item.imageSha256, (counts.get(item.imageSha256) ?? 0) + 1);
  expect(counts).toEqual(COUNTS);
  expect(new Set(reveal.items.map((item) => item.salt)).size).toBe(420);
  expect(reveal.traitTypes.map((type) => type.name)).toEqual(['Crack', 'Glaze']);
  const leaves = reveal.items.map((item) => boxLeaf({ id: Number(item.id), traitsPacked: BigInt(item.traitsPacked), imageSha256: item.imageSha256, avatarSha256: item.avatarSha256, modelSha256: item.modelSha256, salt: item.salt }, 420));
  const tree = buildBoxTree(leaves, 420);
  expect(tree.root).toBe(reveal.revealRoot);
  expect(leaves.filter((leaf, i) => verifyBoxProof(i + 1, leaf, tree.proof(i + 1), reveal.revealRoot, 420))).toHaveLength(420);
}

test('Frog Kiln from its plan: this browser deals the 420 numbers; two creations differ, each reveal file proves every item', async ({ page, browser }, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const first = await createWithPlan(page, testInfo);
  checkReveal(first);
  const other = await browser.newPage();
  await installUntouchableWallet(other);
  const second = await createWithPlan(other);
  checkReveal(second);
  const map = (reveal: Reveal) => reveal.items.map((item) => item.imageSha256);
  expect(map(first)).not.toEqual(map(second));
  expect(map(first).filter((sha, i) => sha !== map(second)[i]).length).toBeGreaterThan(210);
  expect(first.revealRoot).not.toBe(second.revealRoot);
  expect(first.traitTypes).toEqual(second.traitTypes);
  expect(await walletTouches(page)).toEqual([]);
  expect(errors).toEqual([]);
  await other.close();
});

test('the hidden-art line links to the plan guide: the format, the prompt to copy, and back to Contents', async ({ page }, testInfo) => {
  await page.goto('/create/v2-contents');
  await page.getByRole('radio', { name: /^New collection/ }).check();
  await page.getByRole('radio', { name: 'Hidden until drawn' }).check();
  await expect(page.locator('[data-plan-note]')).toContainText('Numbered files: whoever named them knows which item is which. Use a plan instead');
  await shot(page, testInfo, '01-contents-numbered');
  await page.getByRole('link', { name: 'Use a plan instead' }).click();
  await expect(page).toHaveURL(/\/create\/plan$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Plan a hidden collection');
  await expect(page).toHaveTitle('Plan a hidden collection · Square Hole');
  await expect(page.locator('[data-plan-example]')).toContainText('bisque.png,44,Bisque,');
  await expect(page.locator('[data-plan-prompt]')).toContainText('Never choose item numbers, ids, salts or seeds.');
  await expect(page.getByRole('button', { name: 'Copy the prompt' })).toBeVisible();
  expect(await overflow(page), 'sideways scroll').toBeLessThanOrEqual(0);
  await shot(page, testInfo, '03-plan-guide');
  await page.getByRole('link', { name: 'Back to Contents' }).click();
  await expect(page).toHaveURL(/\/create\/v2-contents$/);
  expect(await walletTouches(page)).toEqual([]);
});
