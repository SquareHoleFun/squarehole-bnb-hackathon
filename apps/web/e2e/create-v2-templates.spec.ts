import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { makePng } from '../../../packages/artwork/src/test-support/images';
import { brokenRuns, installUntouchableWallet, overflow, walletTouches } from './box-helpers';

// F128 "Start from a template": the tile row at the start of the v2 creation flow, at 1440 px and, on the mobile
// project, 375 px. Generic recipes since the founder's correction (2026-10-11): named by what the box does, no named
// example box; Shop since SH-V21-FE13 (the flow has its step now); a choice fills only contents, fees, the coin pile and
// a shop, never the price coin, a name or a ticker. SH_EVIDENCE_SCREENSHOTS=1 writes the row, every icon at 32 px and a filled Basics
// step to docs/evidence/SH-V2-FE4/ (or SH_EVIDENCE_DIR).
const width = (info: TestInfo) => (info.project.name === 'mobile' ? 375 : 1440);
async function shot(target: Page | Locator, info: TestInfo, name: string) {
  const path = process.env.SH_EVIDENCE_SCREENSHOTS === '1'
    ? fileURLToPath(new URL(`../../../docs/evidence/${process.env.SH_EVIDENCE_DIR ?? 'SH-V2-FE4'}/${name}-${width(info)}.png`, import.meta.url)) : info.outputPath(`${name}.png`);
  if ('goto' in target) await target.screenshot({ path, fullPage: true, scale: 'css' });
  else await target.screenshot({ path, scale: 'css' });
}
const NAMES = ['Liquidity token', 'Burn', 'To the creator', 'To holders', 'Collection', 'Collection that burns', 'Coin pile', 'Shop', 'Blank'];
const LINES = ['Token · Grow the pool', 'Token · Buy back and burn', 'Token · Keep', 'Token · To holders', 'NFTs · To items · Keep', 'NFTs · To items · Buy back and burn', 'Token · Coin pile', 'Shop · To holders', 'No recipe'];

test.beforeEach(async ({ page }, info) => {
  await installUntouchableWallet(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize(info.project.name === 'mobile' ? { width: 375, height: 812 } : { width: 1440, height: 900 });
});

test('F128 templates: one tile per generic recipe and Blank, each name and line on one line, the icons at 32 px', async ({ page }, info) => {
  await page.goto('/create/v2-basics');
  const row = page.getByRole('region', { name: 'Start from a template' });
  await expect(row).toBeVisible();
  const tiles = row.getByRole('button');
  await expect(tiles).toHaveCount(NAMES.length);
  for (const [i, name] of NAMES.entries()) await expect(tiles.nth(i).locator('.sh-v2-template__name')).toHaveText(name);
  for (const [i, line] of LINES.entries()) await expect(tiles.nth(i).locator('.sh-v2-template__tag')).toHaveText(line);
  // No named example box anywhere in the cards, and nothing announced for later.
  await expect(row).not.toContainText(/Link Marines|Gold Rush|GPU Poor|Next Stop|Deep End|Gas Guzzlers|Rug Rugs|Square Pegs|Bag Holders|Dragon|Junkyard|coming soon/i);
  // Every icon at 32 px; hidden from screen readers beside its name.
  const icons = row.locator('svg[data-icon]');
  await expect(icons).toHaveCount(NAMES.length);
  for (const box of await icons.evaluateAll((all) => all.map((svg) => { const r = svg.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), svg.getAttribute('aria-hidden')]; }))) expect(box).toEqual([32, 32, 'true']);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  expect(await brokenRuns(row.getByRole('list'))).toEqual([]);
  // The page never scrolls sideways; on a phone the row scrolls inside itself.
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  const scrolls = await row.getByRole('list').evaluate((list) => list.scrollWidth > list.clientWidth);
  expect(scrolls).toBe(info.project.name === 'mobile');
  await shot(row, info, 'templates-row');
  // Each icon at 32 px with its name, for the evidence (the row on a phone shows only the first ones at a time).
  if (info.project.name === 'mobile') {
    for (const [i] of NAMES.entries()) if (i % 2 === 0) { await tiles.nth(i).scrollIntoViewIfNeeded(); await shot(row, info, `templates-row-${String(i + 1).padStart(2, '0')}`); }
  }
  expect(await walletTouches(page)).toEqual([]);
});

test('F128 templates: choosing one fills only its recipe (contents, fees, the coin pile); the price coin, name and ticker stay; Blank puts it back', async ({ page }, info) => {
  await page.goto('/create/v2-basics');
  const row = page.getByRole('region', { name: 'Start from a template' });
  const coins = page.getByRole('group', { name: /^Priced in/ });
  await coins.getByRole('radio', { name: /^USDC/ }).check();
  await row.getByRole('button', { name: /^Coin pile/ }).click();
  await expect(row.getByRole('button', { name: /^Coin pile/ })).toHaveAttribute('aria-pressed', 'true');
  // Nothing named or coin-specific is filled: name and ticker stay empty for the creator, the price coin stays USDC.
  await expect(page.getByRole('textbox', { name: 'Name' })).toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Ticker' })).toHaveValue('');
  await expect(coins.getByRole('radio', { name: /^USDC/ })).toBeChecked();
  await page.getByRole('textbox', { name: 'Name' }).fill('Night Owls');
  await page.getByRole('textbox', { name: 'Ticker' }).fill('OWLS');
  await expect(row.getByRole('button', { name: /^Coin pile/ })).toHaveAttribute('aria-pressed', 'true');
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await shot(page, info, 'templates-basics-filled');
  await page.locator('#create-logo').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from(makePng({ width: 512, height: 512, decodable: true })) });
  await expect(page.getByRole('button', { name: 'Logo Change' })).toBeAttached();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Launch a box, step 2 of 6: Contents');
  // The recipe: a token with a coin pile, its seed coin the price coin and its amount left to the creator.
  await expect(page.getByRole('radio', { name: /^Token/ })).toBeChecked();
  await expect(page.getByRole('radio', { name: /^Coin pile/ })).toBeChecked();
  await expect(page.getByRole('textbox', { name: /^Seed · USDC/ })).toHaveValue('');
  await page.getByRole('link', { name: 'Back to Basics' }).click();
  await expect(page.getByRole('textbox', { name: 'Ticker' })).toHaveValue('OWLS');
  await row.getByRole('button', { name: /^Blank/ }).click();
  await expect(row.getByRole('button', { name: /^Blank/ })).toHaveAttribute('aria-pressed', 'true');
  // Blank puts back the recipe only: the creator's name and the price coin stay.
  await expect(page.getByRole('textbox', { name: 'Name' })).toHaveValue('Night Owls');
  await expect(coins.getByRole('radio', { name: /^USDC/ })).toBeChecked();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('radio', { name: /^Token/ })).not.toBeChecked();
  await expect(page.getByRole('radio', { name: /^New collection/ })).not.toBeChecked();
  await expect(page.getByRole('radio', { name: /^Shop/ })).not.toBeChecked();
  expect(await walletTouches(page)).toEqual([]);
});
