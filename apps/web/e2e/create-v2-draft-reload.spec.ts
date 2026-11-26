import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { makePng } from '../../../packages/artwork/src/test-support/images';
import { installUntouchableWallet, walletTouches } from './box-helpers';

// SH-256: after a fresh document in the same tab (a reload, the way out to the Examples page and back through its
// "Launch a box" link) the Launch form is the WHOLE draft as it was, so the Overview's rows are the same text, on the
// steps and on the picture; or a clean start. Never the names and items with the money choices back at their defaults
// (the owner's box of 2 November). A loaded settings file never comes back after a fresh document (SH-256 E5): a token
// kit and Rent Free (500 items) both start clean, both stores, nothing locked. The Demo build; no wallet is touched.
const heading = (page: Page) => page.getByRole('heading', { level: 1 });
const next = (page: Page) => page.getByRole('button', { name: 'Next', exact: true });
const png = (size: number) => ({ name: `p${size}.png`, mimeType: 'image/png', buffer: Buffer.from(makePng({ width: size, height: size, decodable: true })) });
const artFiles = (n: number) => [
  ...Array.from({ length: n }, (_, i) => ({ name: `${i + 1}.png`, mimeType: 'image/png', buffer: Buffer.from(makePng({ width: 24 + i, height: 24, decodable: true })) })),
  { name: 'traits.csv', mimeType: 'text/csv', buffer: Buffer.from(['id,Colour', ...Array.from({ length: n }, (_, i) => `${i + 1},${i % 2 ? 'Teal' : 'Red'}`)].join('\n')) },
];
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const kitFile = (kit: string) => join(ROOT, 'examples/boxes', kit, 'settings', `${kit}-boxspec-v2.json`);

/** Every row of the Overview (its name and its value), as text. */
async function overviewRows(page: Page): Promise<string[]> {
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  await expect(page.locator('.sh-newbox-row').first()).toBeVisible();
  return page.locator('.sh-newbox-rows').evaluateAll((lists) => lists.flatMap((list) => Array.from(list.querySelectorAll('dt'), (dt) => `${dt.textContent ?? ''} = ${dt.nextElementSibling?.textContent ?? ''}`)));
}

/** From any step to the Overview inside this document (Next, ticking the rights on Opening). */
async function toOverview(page: Page) {
  for (let step = 0; step < 6; step += 1) {
    const at = await heading(page).textContent() ?? '';
    if (/Overview$/.test(at)) return;
    const rights = page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' });
    if (await rights.isVisible() && !(await rights.isChecked())) await rights.check();
    await next(page).click();
    await expect(heading(page)).not.toHaveText(at);
  }
}

/** The money rows the defect lost, by name. */
const row = (rows: readonly string[], name: string): string => rows.find((line) => line.startsWith(`${name} = `)) ?? `${name}: no row`;

/** Steps 1 to 6 with every money choice away from its default: USDC, 1%, To items with Burn in the vault, To holders, 90 days. */
async function setUp(page: Page): Promise<string[]> {
  await page.goto('/create/v2-basics');
  await page.getByRole('radio', { name: /^USDC/ }).check();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Glass Owls');
  await page.getByRole('textbox', { name: 'Ticker' }).fill('GOWL');
  await page.getByRole('textbox', { name: 'About' }).fill('Fees go to the items outside the box.');
  await page.locator('#create-logo').setInputFiles(png(512));
  await expect(page.getByRole('button', { name: 'Logo Change' })).toBeAttached();
  await next(page).click();
  await page.getByRole('radio', { name: /^New collection/ }).check();
  await page.getByLabel('Images + traits').setInputFiles(artFiles(10));
  await page.locator('#create-collection-cover').setInputFiles(png(600));
  await page.getByRole('group', { name: /^Pick fee/ }).getByRole('radio', { name: '1%', exact: true }).check();
  await next(page).click();
  const buyers = page.getByRole('group', { name: /^Buyers’ fees/ });
  const sellers = page.getByRole('group', { name: /^Sellers’ fees/ });
  await buyers.getByRole('button', { name: 'To items', exact: true }).click();
  await buyers.getByRole('button', { name: /^Buy back and burn GOWL in the vault$/ }).click();
  await sellers.getByRole('button', { name: 'To holders', exact: true }).click();
  await next(page).click();
  await page.getByRole('radio', { name: /^90/ }).check();
  await next(page).click();
  await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check();
  await next(page).click();
  const rows = await overviewRows(page);
  // Not the defaults: the rows the owner's box of 2 November lost.
  expect(row(rows, 'Buyers’ fees')).toMatch(/To items/);
  expect(row(rows, 'Sellers’ fees')).toMatch(/To holders/);
  expect(row(rows, 'Pick fee')).toMatch(/^Pick fee = 1%/);
  return rows;
}

test.beforeEach(async ({ page }) => {
  await installUntouchableWallet(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

test('SH-256 steps: a reload, and the way out to the Examples page and back through “Launch a box”, keep every Overview row', async ({ page }) => {
  test.setTimeout(120_000);
  const before = await setUp(page);
  await page.reload();
  expect(await overviewRows(page)).toEqual(before);

  await page.goto('/examples/index.html');
  await page.getByRole('link', { name: 'Launch a box' }).first().click();
  // The way back opens the default way, which is Visual since SH-254 (merged with SH-256 on 24 November 2026): the
  // drawing shows, and the Overview reached from it holds every row as before (name, price coin and the money rows).
  await expect(page).toHaveURL(/\/create\/v2-picture$/);
  await expect(page.getByRole('group', { name: 'Your box' })).toBeVisible();
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  expect(await overviewRows(page)).toEqual(before);
  // And on the steps: Basics holds the name and the price coin as typed, and its Overview the same rows.
  await page.goto('/create/v2-basics');
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Glass Owls');
  await expect(page.getByRole('radio', { name: /^USDC/ })).toBeChecked();
  await toOverview(page);
  expect(await overviewRows(page)).toEqual(before);
  expect(await walletTouches(page)).toEqual([]);
});

test('SH-256 picture: the picture’s parts and the Overview reached from it are the same after a reload', async ({ page }) => {
  test.setTimeout(120_000);
  const before = await setUp(page);
  await page.locator('a[href$="/create/v2-picture"]').first().click();
  const picture = page.getByRole('group', { name: 'Your box' });
  await expect(picture).toBeVisible();
  const parts = () => page.locator('[data-part]').evaluateAll((all) => all.map((part) => `${part.getAttribute('data-part')}: ${part.getAttribute('aria-label') ?? ''} | ${part.getAttribute('aria-description') ?? ''} ${part.textContent ?? ''}`));
  const shown = await parts();
  expect(shown.join('\n')).toMatch(/To items/);
  await page.reload();
  await expect(picture).toBeVisible();
  expect(await parts()).toEqual(shown);
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  expect(await overviewRows(page)).toEqual(before);
  expect(await walletTouches(page)).toEqual([]);
});

test('SH-256 (E5) a loaded token kit, its fee changed, then a reload: a clean start of both stores, nothing locked', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/create/v2-overview');
  const fresh = await overviewRows(page);
  await page.goto('/create/v2-basics');
  await page.locator('#create-load-settings').setInputFiles(kitFile('lake-house'));
  const loaded = page.locator('[data-loaded-setup]');
  await expect(loaded).toContainText('From the loaded setup.');
  await expect(page.getByRole('textbox', { name: 'About' })).not.toBeEditable();
  // One of the five a loaded setup leaves editable: the buyers' fee (in this document: Next, never a new address).
  await next(page).click();
  await next(page).click();
  await page.getByRole('group', { name: /^Buyers’ fees/ }).getByRole('button', { name: 'Keep', exact: true }).click();
  await toOverview(page);
  expect(row(await overviewRows(page), 'Buyers’ fees')).toMatch(/Keep/);
  await page.reload();
  expect(await overviewRows(page)).toEqual(fresh);
  await page.goto('/create/v2-basics');
  await expect(loaded).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'About' })).toBeEditable();
});

test('SH-256 Rent Free loaded, then a reload: a clean start of both stores, never its items with default fees', async ({ page }, info) => {
  // The kit tooling rebuilds Rent Free when its inputs changed since its cache (about 7 minutes on a busy laptop).
  test.setTimeout(1_200_000);
  const files = info.outputPath('rent-free');
  execFileSync(process.execPath, [join(ROOT, 'apps/web/e2e/core-v2-chain/examples/kit-files.mjs'), 'rent-free', files], { cwd: ROOT, stdio: 'pipe', timeout: 900_000 });
  // The rows of a fresh start, for comparison.
  await page.goto('/create/v2-overview');
  const fresh = await overviewRows(page);
  await page.goto('/create/v2-basics');
  await page.locator('#create-load-settings').setInputFiles(join(files, 'rent-free-boxspec-v2.json'));
  await expect(page.getByText('Item pictures + models · 500')).toBeVisible({ timeout: 120_000 });
  const items = [...Array.from({ length: 500 }, (_, i) => join(files, 'items', `${i + 1}.png`)), ...Array.from({ length: 500 }, (_, i) => join(files, 'items', `${i + 1}.glb`)), join(files, 'items', 'traits.csv')];
  await page.locator('#create-load-items').setInputFiles(items);
  await expect(page.locator('[data-loaded-setup]')).toContainText('From the loaded setup.', { timeout: 300_000 });
  await toOverview(page);
  const kit = await overviewRows(page);
  expect(row(kit, 'Buyers’ fees')).toMatch(/To items/);
  expect(row(kit, 'Pick fee')).toMatch(/^Pick fee = 1%/);
  await page.reload();
  expect(await overviewRows(page)).toEqual(fresh);
  await page.goto('/create/v2-basics');
  await expect(page.locator('[data-loaded-setup]')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'About' })).toHaveValue('');
  expect(await walletTouches(page)).toEqual([]);
});
