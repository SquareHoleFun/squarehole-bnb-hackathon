import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { makePng } from '../../../packages/artwork/src/test-support/images';
import { noTradingActions, installUntouchableWallet, overflow, walletTouches } from './box-helpers';

// CQ11-E4 / M253: Demo create flow, fixed listing raises, four P fee choices, and no wallet requests on navigation.

const EVIDENCE = process.env.SH_EVIDENCE_SCREENSHOTS === '1';
const evidenceDir = fileURLToPath(new URL('../../../docs/evidence/screenshots/sh-v2-m1-53a/', import.meta.url));
async function shot(page: Page, testInfo: TestInfo, name: string) {
  if (!EVIDENCE) return;
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path: `${evidenceDir}${name}-${testInfo.project.name}.png`, fullPage: true, scale: 'css' });
}

const heading = (page: Page) => page.getByRole('heading', { level: 1 });
const next = (page: Page) => page.getByRole('button', { name: 'Next', exact: true });
const main = (page: Page) => page.getByRole('main');
const png = (size: number) => ({ name: `p${size}.png`, mimeType: 'image/png', buffer: Buffer.from(makePng({ width: size, height: size, decodable: true })) });
const artFiles = (n: number) => [
  ...Array.from({ length: n }, (_, i) => ({ name: `${i + 1}.png`, mimeType: 'image/png', buffer: Buffer.from(makePng({ width: 24 + i, height: 24, decodable: true })) })),
  { name: 'traits.csv', mimeType: 'text/csv', buffer: Buffer.from(['id,Colour', ...Array.from({ length: n }, (_, i) => `${i + 1},${i % 2 ? 'Teal' : 'Red'}`)].join('\n')) },
];

/** Every step: no refund wording, no trading control or amount field, no sideways scroll. */
async function audit(page: Page, where: string) {
  await expect(main(page), where).not.toContainText(/refund/i);
  await noTradingActions(page, where);
  await expect(page.locator('input[type="number"], input[type="range"], iframe'), where).toHaveCount(0);
  expect(await walletTouches(page), where).toEqual([]);
  expect(await overflow(page), `${where}: sideways scroll`).toBeLessThanOrEqual(0);
}

test.beforeEach(async ({ page }) => {
  await installUntouchableWallet(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

test('Launch in the navigation opens the visual way (SH-254), as /create and every create link do; the steps keep the templates row and the price-coin picker (founder 2026-10-11)', async ({ page, isMobile }) => {
  await page.goto('/');
  await expect(page.getByText('6 boxes')).toBeVisible();
  if (isMobile) await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Launch' }).click();
  // SH-254: Launch opens the visual way, the default (the founder, 24 November 2026); the steps are a press away.
  await expect(page).toHaveURL(/\/create\/v2-picture$/);
  await expect(heading(page)).toHaveAccessibleName('Launch a box');
  await expect(main(page).getByRole('region', { name: 'Start from a template' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Launch' }).getByRole('link', { name: 'Visual' })).toHaveAttribute('aria-current', 'true');
  await page.getByRole('navigation', { name: 'Launch' }).getByRole('link', { name: 'Steps' }).click();
  await expect(page).toHaveURL(/\/create\/v2-basics$/);
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 1 of 6: Basics');
  const coins = main(page).getByRole('group', { name: /^Priced in/ });
  await expect(coins).toBeVisible();
  for (const coin of [/^ETH/, /^USDC/, /^FIT/]) await expect(coins.getByRole('radio', { name: coin })).toBeVisible();
  await coins.getByRole('radio', { name: /^USDC/ }).check();
  await expect(page.locator('[data-pricing-card]')).toContainText('USDC');
  // v1's "Paired with ETH" flow is not behind any entry point any more.
  await expect(main(page)).not.toContainText(/Paired with ETH|native ETH only/);
  for (const from of ['/create', '/launch']) {
    await page.goto(from);
    await expect(page, from).toHaveURL(/\/create\/v2-picture$/);
    await expect(heading(page)).toHaveAccessibleName('Launch a box');
  }
  await page.goto('/');
  await page.getByRole('link', { name: 'Launch a box' }).click();
  await expect(page).toHaveURL(/\/create\/v2-picture$/);
  expect(await walletTouches(page)).toEqual([]);
});

test('/create/v2 opens the v2 flow’s Basics, with no source chip or Demo word for the sample data (F130); v1’s flow stays at /create/basics, by URL only', async ({ page }) => {
  await page.goto('/create/v2');
  await expect(page).toHaveURL(/\/create\/v2-basics$/);
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 1 of 6: Basics');
  await expect(page.locator('.sh-newbox__source')).toHaveCount(0);
  await expect(page.getByRole('main')).not.toContainText(/\bdemo\b/i);
  await page.goto('/create/basics');
  await expect(page.getByRole('navigation', { name: 'Steps' }).getByText('Box kind')).toBeVisible();
  expect(await walletTouches(page)).toEqual([]);
});

test('Demo: a USDC-priced collection with Keep and Grow the pool fees waits for its table, then opens', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/create/v2-basics');
  await page.getByRole('radio', { name: /USDC/ }).check();
  await expect(main(page).getByText('The issuer can freeze addresses, including the pool.')).toBeVisible();
  await page.getByRole('radio', { name: /NVDAon/ }).check();
  await expect(main(page).getByText('Ondo can pause or block all its tokens at once.')).toBeVisible();
  await page.getByRole('radio', { name: /FIT/ }).check();
  await expect(page.locator('[data-pricing-card]')).toContainText('21034900.425 FIT');
  await page.getByRole('radio', { name: /CHOO/ }).check();
  await expect(main(page).getByRole('link', { name: 'Toy Trains' })).toBeVisible();
  await expect(main(page).getByText('9783674.616279069767441859 CHOO', { exact: true })).toBeVisible();
  await expect(main(page).getByText(/at spot/)).toHaveCount(0);
  await shot(page, testInfo, '01-basics-box-token');
  await page.getByRole('radio', { name: /USDC/ }).check();
  await page.getByRole('textbox', { name: 'Name' }).fill('Glass Owls');
  await page.getByRole('textbox', { name: 'Ticker' }).fill('GOWL');
  await page.locator('#create-logo').setInputFiles(png(512));
  await expect(page.getByRole('button', { name: 'Logo Change' })).toBeAttached();
  await audit(page, 'Basics');
  await next(page).click();

  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 2 of 6: Contents');
  await page.getByRole('radio', { name: /^New collection/ }).check();
  await page.getByLabel('Images + traits').setInputFiles(artFiles(10));
  await page.locator('#create-collection-cover').setInputFiles(png(600));
  const pickFee = page.getByRole('group', { name: /^Pick fee/ });
  await expect(pickFee.getByRole('radio', { name: '5%', exact: true })).toBeVisible();
  await pickFee.getByRole('radio', { name: '5%', exact: true }).check();
  await audit(page, 'Contents');
  await next(page).click();

  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 3 of 6: Fees');
  const buyers = page.getByRole('group', { name: /^Buyers’ fees · in USDC/ });
  const sellers = page.getByRole('group', { name: /^Sellers’ fees · paid in GOWL, used as USDC/ });
  await expect(main(page).getByText(/^1% of every trade: in USDC on buys, in .+ on sales$/)).toBeVisible();
  for (const group of [buyers, sellers]) {
    // M3: a collection box also offers To items (its in-vault rule appears once chosen); v2.1 eating USDC locks it.
    await expect(group.getByRole('button')).toHaveText(['Keep', 'Buy back and burn GOWL', 'Grow the pool', 'To holders', 'To items', 'Lock USDC']);
  }
  await buyers.getByRole('button', { name: 'Keep', exact: true }).click();
  await sellers.getByRole('button', { name: 'Grow the pool', exact: true }).click();
  await expect(buyers.getByRole('button', { name: 'Keep', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(sellers.getByRole('button', { name: 'Grow the pool', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await audit(page, 'Fees');
  await shot(page, testInfo, '03-fees');
  await next(page).click();

  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 4 of 6: Raise');
  await expect(main(page).getByText('15986.524323 USDC')).toBeVisible();
  await page.getByRole('radio', { name: /^90/ }).check();
  await audit(page, 'Raise');
  await next(page).click();

  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 5 of 6: Opening');
  await expect(main(page).getByText(/ETH-in helper/)).toHaveCount(0);
  await page.getByRole('textbox', { name: /Your USDC at start/ }).fill('250');
  await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check();
  await audit(page, 'Opening');
  await next(page).click();

  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  await expect(main(page).getByText('15986.524323 USDC')).toBeVisible();
  await expect(main(page).getByText(/createBox/)).toBeVisible();
  await audit(page, 'Overview');
  expect(await walletTouches(page)).toEqual([]);

  await page.getByRole('button', { name: 'Connect to create' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sample wallet' });
  await dialog.getByRole('radio', { name: 'Box wallet A' }).check();
  await dialog.getByRole('button', { name: /^(Connect|Update) sample wallet$/ }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const status = page.locator('[data-create-status]');
  await expect(status).toHaveText(/^Waiting for its table/);
  await shot(page, testInfo, '06-overview-waiting');
  await expect(status).toHaveText(/^Open/, { timeout: 30_000 });
  await shot(page, testInfo, '06-overview-open');
  expect(await walletTouches(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('Demo: a permanently listed box coin uses its published raise; a different price coin invalidates the run', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/create/v2-basics');
  await page.getByRole('radio', { name: /CHOO/ }).check();
  await page.getByRole('textbox', { name: 'Name' }).fill('Next Stop');
  await page.getByRole('textbox', { name: 'Ticker' }).fill('STOP');
  await page.locator('#create-logo').setInputFiles(png(512));
  await expect(page.getByRole('button', { name: 'Logo Change' })).toBeAttached();
  await next(page).click();
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 2 of 6: Contents');
  await page.getByRole('radio', { name: /^Token/ }).check();
  await next(page).click();
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 3 of 6: Fees');
  await next(page).click();
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 4 of 6: Raise');
  await expect(main(page).getByText('9783674.616279069767441859 CHOO', { exact: true })).toBeVisible();
  await expect(main(page).getByText(/at spot|not readable/)).toHaveCount(0);
  await next(page).click();
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 5 of 6: Opening');
  await page.getByRole('textbox', { name: /Your CHOO at start/ }).fill('1000');
  await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check();
  await audit(page, 'Opening');
  await next(page).click();

  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  await expect(page.getByRole('heading', { name: 'Create · 2 transactions' })).toBeVisible();
  await expect(main(page).getByText(/^approve ·/)).toBeVisible();
  await expect(main(page).getByText(/^createBox/)).toBeVisible();
  await audit(page, 'Overview');
  expect(await walletTouches(page)).toEqual([]);
  await page.getByRole('button', { name: 'Connect to create' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sample wallet' });
  await dialog.getByRole('radio', { name: 'Box wallet A' }).check();
  await dialog.getByRole('button', { name: /^(Connect|Update) sample wallet$/ }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('[data-create-status]')).toHaveText('Open', { timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Start a new box' })).toBeVisible();
  await shot(page, testInfo, '06-overview-box-coin');

  // Priced in USDC instead, the previous run is not this plan's: no status, nothing marked sent, Create on (review round 3).
  await page.getByRole('link', { name: 'Edit Basics' }).click();
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 1 of 6: Basics');
  await page.getByRole('radio', { name: /USDC/ }).check();
  await page.getByRole('button', { name: 'Back to overview' }).click();
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  await expect(page.getByRole('heading', { name: /^Create · \d+ transactions$/ })).toBeVisible();
  await expect(page.locator('[data-create-status]')).toHaveCount(0);
  await expect(page.locator('.sh-v2-plan [data-done]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeEnabled();
  // SH-254: after a create, "Start a new box" opens the default way, Visual.
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('[data-create-status]')).toHaveText('Open', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Start a new box' }).click();
  await expect(page).toHaveURL(/\/create\/v2-picture$/);
  await expect(page.locator('svg.sh-pic')).toBeVisible();
  expect(await walletTouches(page)).toEqual([]);
  expect(errors).toEqual([]);
});
