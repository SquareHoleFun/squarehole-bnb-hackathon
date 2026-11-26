import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { makePng } from '../../../packages/artwork/src/test-support/images';
import { brokenRuns, installUntouchableWallet, noTradingControls, overflow, walletTouches } from './box-helpers';

// SH-V21-FE13: a shop in the v2 creation flow, in the sample data, at 1440 px and, on the mobile project, 375 px: the
// Shop template, the Contents step's Shop tile and its settings (numbers first, the rules behind each (i)), holders
// paid on both sides, the Overview's settings and the seed's steps after Create, and the sample run. Navigation never
// touches a wallet; the sample wallet opens only from "Connect to create". SH_EVIDENCE_SCREENSHOTS=1 writes the
// pictures to docs/evidence/SH-V21-FE13/ (or SH_EVIDENCE_DIR).
const width = (info: TestInfo) => (info.project.name === 'mobile' ? 375 : 1440);
async function shot(target: Page | Locator, info: TestInfo, name: string) {
  const path = process.env.SH_EVIDENCE_SCREENSHOTS === '1'
    ? fileURLToPath(new URL(`../../../docs/evidence/${process.env.SH_EVIDENCE_DIR ?? 'SH-V21-FE13'}/${name}-${width(info) === 375 ? '375' : 'desktop'}.png`, import.meta.url)) : info.outputPath(`${name}.png`);
  if ('goto' in target) {
    // A full-page picture draws a sticky bar once, where the page scrolled it: keep the bars in the flow for it.
    const style = await target.addStyleTag({ content: '.sh-topbar, .sh-newbox__bar { position: static !important; }' });
    await target.screenshot({ path, fullPage: true, scale: 'css' });
    await style.evaluate((node) => (node as Element).remove());
  } else await target.screenshot({ path, scale: 'css' });
}
const next = (page: Page) => page.getByRole('button', { name: 'Next', exact: true }).click();
const heading = (page: Page) => page.getByRole('heading', { level: 1 });

test.beforeEach(async ({ page }, info) => {
  await installUntouchableWallet(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize(info.project.name === 'mobile' ? { width: 375, height: 812 } : { width: 1440, height: 900 });
});

test('SH-V21-FE13 create: the Shop template, its step, holders on both sides and the seed’s steps after Create', async ({ page }, info) => {
  await page.goto('/create/v2-basics');
  const row = page.getByRole('region', { name: 'Start from a template' });
  await row.getByRole('button', { name: /^Shop/ }).click();
  await expect(row.getByRole('button', { name: /^Shop/ })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('group', { name: /^Priced in/ }).getByRole('radio', { name: /^PAXG/ }).check();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Curio Corner');
  await page.getByRole('textbox', { name: 'Ticker', exact: true }).fill('CURIO');
  await page.locator('#create-logo').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from(makePng({ width: 512, height: 512, decodable: true })) });
  await expect(page.getByRole('button', { name: 'Logo Change' })).toBeAttached();
  await row.getByRole('button', { name: /^Shop/ }).scrollIntoViewIfNeeded();
  await shot(page, info, 'create-shop-basics');
  await next(page);
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 2 of 6: Contents');
  // The third contents tile, chosen by the template; its settings with their defaults; no coin pile beside it.
  await expect(page.getByRole('radio', { name: /^Shop/ })).toBeChecked();
  await expect(page.getByRole('group', { name: /^Coin pile/ })).toHaveCount(0);
  for (const [group, chip] of [['Pick', '2x'], ['Gives a week', '10%'], ['Per collection a week', '2.5%'], ['Curator', 'You']] as const) {
    await expect(page.getByRole('group', { name: new RegExp(`^${group}`) }).getByRole('radio', { name: new RegExp(`^${chip.replace('.', '\\.')}`) })).toBeChecked();
  }
  await page.getByRole('textbox', { name: 'Seed · CURIO' }).fill('1000');
  for (const [i, price] of ['1', '2', '4', '8'].entries()) await page.getByRole('textbox', { name: `Tier ${i + 1}`, exact: true }).fill(price);
  await expect(page.getByText('At least 2 CURIO · from your first buy')).toBeVisible();
  await page.getByRole('textbox', { name: 'Collection 1' }).fill('0x00000000000000000000000000000000000000a1');
  await page.getByRole('button', { name: 'Add collection' }).click();
  await page.getByRole('textbox', { name: 'Collection 2' }).fill('0x00000000000000000000000000000000000000b2');
  await page.getByRole('group', { name: 'Tier of collection 2' }).getByRole('radio', { name: /^3/ }).check();
  await page.getByRole('button', { name: 'About the weekly limit' }).click();
  await expect(page.getByText(/never less than one cheapest give while the budget covers it/)).toBeVisible();
  await page.getByRole('button', { name: 'About the weekly limit' }).click();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  // No chip's text breaks across lines, the collections' tier chips with their gives included (at 375 px four a row
  // once broke "1 CURIO" letter by letter).
  const rows = await page.locator('.sh-v2-shop .sh-newbox-chips__row').all();
  expect(rows.length).toBe(7);
  for (const chips of rows) expect(await brokenRuns(chips)).toEqual([]);
  await shot(page, info, 'create-shop-contents');
  await next(page);
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 3 of 6: Fees');
  for (const side of ['Buyers', 'Sellers']) {
    const group = page.getByRole('group', { name: new RegExp(`^${side}’ fees`) });
    await expect(group.getByRole('button', { name: 'To holders' })).toHaveAttribute('aria-pressed', 'true');
    // A shop has no collection of its own and no pile: neither is offered.
    await expect(group.getByRole('button', { name: /^To (items|the pile)$/ })).toHaveCount(0);
  }
  await shot(page, info, 'create-shop-fees');
  await next(page); await next(page);
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 5 of 6: Opening');
  await page.getByRole('radio', { name: /^Now/ }).check();
  // The seed comes from the first buy: without one Next names it.
  await next(page);
  await expect(page.getByRole('alert')).toContainText('A shop needs your PAXG at start: the seed comes from it.');
  await page.getByRole('textbox', { name: 'Your PAXG at start' }).fill('0.05');
  await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check();
  await next(page);
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  const contents = page.getByRole('region', { name: 'Contents' });
  for (const [term, value] of [['Contents', 'Shop'], ['Seed', '1000 CURIO'], ['Give tiers', '1 · 2 · 4 · 8 CURIO'], ['Pick', '2x · 2 · 4 · 8 · 16 CURIO'],
    ['Gives a week', '10% · 2.5% per collection'], ['New entries wait', '7 days'], ['Curator', 'You · connect a wallet'], ['Collections', '2']] as const) {
    await expect(contents.locator('.sh-newbox-row').filter({ has: page.locator('dt', { hasText: new RegExp(`^${term}$`) }) }).locator('dd')).toHaveText(value);
  }
  await expect(page.locator('.sh-v2-plan li').last()).toHaveText('complete · opens the box');
  expect(await walletTouches(page)).toEqual([]);
  await page.getByRole('button', { name: 'Connect to create' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sample wallet' });
  await dialog.getByRole('radio', { name: 'Box wallet A' }).check();
  await dialog.getByRole('button', { name: /^(Connect|Update) sample wallet$/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(contents.locator('.sh-newbox-row').filter({ has: page.locator('dt', { hasText: /^Curator$/ }) }).locator('dd')).toHaveText(/^You · 0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}$/);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await shot(page, info, 'create-shop-overview');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('[data-create-status]')).toHaveText('Open', { timeout: 30_000 });
  await expect(page.locator('.sh-v2-plan li[data-done]')).toHaveCount(await page.locator('.sh-v2-plan li').count());
  await noTradingControls(page);
  expect(await walletTouches(page)).toEqual([]);
});

test('SH-V21-FE13 create: the Shop step names what to fix, each at its field', async ({ page }, info) => {
  await page.goto('/create/v2-basics');
  await page.getByRole('region', { name: 'Start from a template' }).getByRole('button', { name: /^Shop/ }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Curio Corner');
  await page.getByRole('textbox', { name: 'Ticker', exact: true }).fill('CURIO');
  await page.locator('#create-logo').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from(makePng({ width: 512, height: 512, decodable: true })) });
  await expect(page.getByRole('button', { name: 'Logo Change' })).toBeAttached();
  await next(page);
  for (const [i, price] of ['1', '1', '4', '8'].entries()) await page.getByRole('textbox', { name: `Tier ${i + 1}`, exact: true }).fill(price);
  await page.getByRole('textbox', { name: 'Seed · CURIO' }).fill('1');
  await page.getByRole('textbox', { name: 'Collection 1' }).fill('curio.eth');
  // Leave the field first: its message appears on leaving it and moves Next down (the flow's errors show on blur).
  await page.getByRole('textbox', { name: 'Collection 1' }).press('Tab');
  await next(page);
  const summary = page.getByRole('alert');
  await expect(summary.getByRole('link')).toHaveText(['Tier 2: Above tier 1', 'Seed: At least 2 CURIO: twice the cheapest listed give', 'Collection 1: Use a collection address like 0x12…, 42 characters']);
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 2 of 6: Contents');
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await shot(page, info, 'create-shop-fix');
  expect(await walletTouches(page)).toEqual([]);
});

// SH-SHOP-CREATE: starter items (ids per starting collection: none, or 10 to 10,000 in all) and "No curator" (the zero
// curator, a fixed list) in the sample data: the step's fields and rules, the Overview's rows, the plan's steps for each
// item and the sample run. SH_EVIDENCE_SCREENSHOTS=1 SH_EVIDENCE_DIR=SH-SHOP-CREATE writes the pictures there.
test('SH-SHOP-CREATE create: starter ids per collection and No curator; the Overview counts them and the plan approves and loads each', async ({ page }, info) => {
  await page.goto('/create/v2-basics');
  await page.getByRole('region', { name: 'Start from a template' }).getByRole('button', { name: /^Shop/ }).click();
  await page.getByRole('group', { name: /^Priced in/ }).getByRole('radio', { name: /^PAXG/ }).check();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Bent Can Shop');
  await page.getByRole('textbox', { name: 'Ticker', exact: true }).fill('CANS');
  await page.locator('#create-logo').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from(makePng({ width: 512, height: 512, decodable: true })) });
  await expect(page.getByRole('button', { name: 'Logo Change' })).toBeAttached();
  await next(page);
  await page.getByRole('textbox', { name: 'Seed · CANS' }).fill('1000');
  for (const [i, price] of ['1', '2', '4', '8'].entries()) await page.getByRole('textbox', { name: `Tier ${i + 1}`, exact: true }).fill(price);
  await page.getByRole('textbox', { name: 'Collection 1' }).fill('0x00000000000000000000000000000000000000a1');
  await page.getByRole('textbox', { name: 'Starter ids 1', exact: true }).fill('1-6');
  await page.getByRole('button', { name: 'Add collection' }).click();
  await page.getByRole('textbox', { name: 'Collection 2' }).fill('0x00000000000000000000000000000000000000b2');
  await page.getByRole('textbox', { name: 'Starter ids 2', exact: true }).fill('7, 8, 9');
  const curator = page.getByRole('group', { name: /^Curator/ });
  await curator.getByRole('radio', { name: /^No curator/ }).check();
  await expect(curator.getByRole('radio', { name: /^No curator/ })).toBeChecked();
  await expect(page.getByRole('textbox', { name: 'Curator address' })).toHaveCount(0);
  await next(page);
  await expect(page.getByRole('alert').getByRole('link')).toHaveText(['Collections: At least 10 starter items, or none']);
  await page.getByRole('textbox', { name: 'Starter ids 2', exact: true }).fill('7-10');
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const rows = await page.locator('.sh-v2-shop .sh-newbox-chips__row').all();
  expect(rows.length).toBe(7);
  for (const chips of rows) expect(await brokenRuns(chips)).toEqual([]);
  await shot(page, info, 'create-shop-starters');
  await next(page);
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 3 of 6: Fees');
  await next(page); await next(page);
  await page.getByRole('radio', { name: /^Now/ }).check();
  await page.getByRole('textbox', { name: 'Your PAXG at start' }).fill('0.05');
  await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check();
  await next(page);
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  const contents = page.getByRole('region', { name: 'Contents' });
  const row = (term: string) => contents.locator('.sh-newbox-row').filter({ has: page.locator('dt', { hasText: new RegExp(`^${term}$`) }) }).locator('dd');
  for (const [term, value] of [['Curator', 'None'], ['Collections', '2'], ['Starter items', '10 · Connect the wallet that holds the starter items.']] as const) {
    await expect(row(term)).toHaveText(value);
  }
  const plan = page.locator('.sh-v2-plan li');
  await expect(plan).toHaveText([/^approve · .* PAXG$/, /^createBox/, ...Array.from({ length: 10 }, (_, i) => `approve starter · ${i + 1}`), 'load starters · page 1',
    'approve seed · 1000 CANS', 'fundSeed · 1000 CANS', 'complete · opens the box']);
  expect(await walletTouches(page)).toEqual([]);
  await page.getByRole('button', { name: 'Connect to create' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sample wallet' });
  await dialog.getByRole('radio', { name: 'Box wallet A' }).check();
  await dialog.getByRole('button', { name: /^(Connect|Update) sample wallet$/ }).click();
  await expect(dialog).toHaveCount(0);
  // The sample data has no chain to ask about the items: with a wallet, nothing more holds them.
  await expect(row('Starter items')).toHaveText('10');
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await shot(page, info, 'create-shop-starters-overview');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('[data-create-status]')).toHaveText('Open', { timeout: 30_000 });
  await expect(page.locator('.sh-v2-plan li[data-done]')).toHaveCount(await plan.count());
  await noTradingControls(page);
  expect(await walletTouches(page)).toEqual([]);
});

// SH-SHOP-CREATE: Load settings with the one-collection shop kit's settings file (sh-050-one-collection-shop, copied
// unchanged): it asks for the ten starter ids the file commits by hash, refuses others, then keeps them and "No curator"
// read-only. The sample data has no chain to ask about the collection, so the shop loads unchecked, as on its own page.
test('SH-SHOP-CREATE Load settings: the one-collection shop’s file loads with its starter ids typed; ids and No curator stay as loaded', async ({ page }, info) => {
  const file = fileURLToPath(new URL('../src/features/create/v2/test-support/one-collection-shop-boxspec-v2.json', import.meta.url));
  await page.goto('/create/v2-basics');
  await page.locator('#create-load-settings').setInputFiles(file);
  const starters = page.getByRole('group', { name: 'Starter items · 10' });
  await expect(starters).toBeVisible();
  const ids = starters.getByRole('textbox', { name: 'Collection 1 · 0x0000…0011' });
  await ids.fill('3-11');
  await starters.getByRole('button', { name: 'Load', exact: true }).click();
  await expect(page.locator('[data-load-problem]')).toHaveText(/These starter ids are not the setup’s\./);
  await ids.fill('3-12');
  // Editing the ids clears the line.
  await expect(page.locator('[data-load-problem]')).toHaveCount(0);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await shot(page, info, 'load-shop-starters');
  await starters.getByRole('button', { name: 'Load', exact: true }).click();
  await expect(page.locator('[data-loaded-setup]')).toContainText('From the loaded setup.');
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('One-collection shop');
  await next(page);
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 2 of 6: Contents');
  const loaded = page.getByRole('textbox', { name: 'Starter ids 1', exact: true });
  await expect(loaded).toHaveValue('3-12');
  await expect(loaded).toBeDisabled();
  await expect(page.getByRole('group', { name: /^Curator/ }).getByRole('radio', { name: /^No curator/ })).toBeChecked();
  await expect(page.getByRole('group', { name: /^Curator/ }).getByRole('radio', { name: /^No curator/ })).toBeDisabled();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await shot(page, info, 'loaded-shop-contents');
  expect(await walletTouches(page)).toEqual([]);
});
