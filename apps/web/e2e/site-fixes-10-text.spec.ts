import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { makePng } from '../../../packages/artwork/src/test-support/images';
import { installUntouchableWallet, overflow, walletTouches } from './box-helpers';

// SH-SITE-FIXES-10 task 3 in the browser (the Demo data, desktop at 1440×900 and a phone at 375 px): Create's Fees step
// names the price coin itself, with no "P =" key; a link to a section of the Terms lands on that section, from About &
// risks and on a direct load. SH_EVIDENCE_SCREENSHOTS=1 writes the pictures to docs/evidence/<SH_EVIDENCE_DIR, default
// SH-SITE-FIXES-10/after>/<name>-<project>.png; each is taken before its checks, so a run on the earlier code records
// what it showed ("before").
const DIR = process.env.SH_EVIDENCE_DIR ?? 'SH-SITE-FIXES-10/after';

async function shot(page: Page, info: TestInfo, name: string, target?: Locator) {
  const path = process.env.SH_EVIDENCE_SCREENSHOTS === '1'
    ? fileURLToPath(new URL(`../../../docs/evidence/${DIR}/${name}-${info.project.name}.png`, import.meta.url)) : info.outputPath(`${name}.png`);
  if (target) await target.screenshot({ path, scale: 'css' });
  else await page.screenshot({ path, fullPage: false, scale: 'css' });
}

const heading = (page: Page) => page.getByRole('heading', { level: 1 });
const next = (page: Page) => page.getByRole('button', { name: 'Next', exact: true });
const png = (size: number) => ({ name: `p${size}.png`, mimeType: 'image/png', buffer: Buffer.from(makePng({ width: size, height: size, decodable: true })) });
/** A section's heading sits at the top of the view, just under the sticky top bar (its scroll margin), not off screen. */
async function atTop(page: Page, title: Locator) {
  await expect(title).toBeInViewport();
  const bar = (await page.locator('.sh-topbar').boundingBox())?.height ?? 0;
  const box = await title.boundingBox();
  expect(box?.y ?? -1).toBeGreaterThanOrEqual(bar);
  expect(box?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(bar + 120);
}

test.beforeEach(async ({ page }, info) => {
  await installUntouchableWallet(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 375, height: 812 });
});

test('SH-SITE-FIXES-10: the Fees step names the price coin (USDC), no "P =" key', async ({ page }, info) => {
  test.setTimeout(90_000);
  await page.goto('/create/v2-basics');
  await page.getByRole('radio', { name: /USDC/ }).check();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Glass Owls');
  await page.getByRole('textbox', { name: 'Ticker', exact: true }).fill('GOWL');
  await page.locator('#create-logo').setInputFiles(png(512));
  await expect(page.getByRole('button', { name: 'Logo Change' })).toBeAttached();
  await next(page).click();
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 2 of 6: Contents');
  await page.getByRole('radio', { name: /^Token/ }).check();
  await next(page).click();
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 3 of 6: Fees');
  const main = page.getByRole('main');
  const lead = main.getByText(/^1% of every trade: in /);
  await lead.scrollIntoViewIfNeeded();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await shot(page, info, 'fees-header');
  await expect(lead).toHaveText('1% of every trade: in USDC on buys, in GOWL on sales');
  await expect(main.getByText('You choose where 10/15 goes', { exact: true })).toBeVisible();
  await expect(main.getByText(/P = |in P on buys/)).toHaveCount(0);
  await expect(page.getByRole('group', { name: /^Buyers’ fees · in USDC/ })).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  expect(await walletTouches(page)).toEqual([]);
});

test('SH-SITE-FIXES-10: a Terms section link lands on its section, from About & risks and on a direct load', async ({ page }, info) => {
  test.setTimeout(90_000);
  await page.goto('/about/risks');
  const legal = page.getByRole('region', { name: 'Terms' });
  await legal.getByRole('link', { name: 'Risks · Section 6' }).click();
  await expect(page).toHaveURL(/\/about\/terms#terms-6$/);
  const six = page.locator('#terms-6-title');
  await page.waitForTimeout(300);
  await shot(page, info, 'terms-6-from-risks');
  await atTop(page, six);
  await expect(six).toBeFocused();

  // Every Terms section link of About & risks (each card's, "every risk", Risks · Section 6, Fees · Section 11).
  await page.goto('/about/risks');
  const hrefs = [...new Set(await page.getByRole('main').locator('a[href^="/about/terms#"]').evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? '')))];
  expect(hrefs.length).toBeGreaterThanOrEqual(3);
  for (const href of hrefs) {
    await page.goto('/about/risks');
    const link = page.getByRole('main').locator(`a[href="${href}"]`).first();
    // A card's Terms link is in its details: open them first.
    if (!(await link.isVisible())) await link.locator('xpath=ancestor::details[1]/summary').click();
    await link.click();
    const id = href.split('#')[1] ?? '';
    await atTop(page, page.locator(`[id="${id}-title"]`));
  }

  // A direct load (as from another site or a bookmark) lands there once the page has rendered.
  await page.goto('/about/terms#terms-11');
  const eleven = page.locator('#terms-11-title');
  await page.waitForTimeout(300);
  await shot(page, info, 'terms-11-direct');
  await atTop(page, eleven);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  expect(await walletTouches(page)).toEqual([]);
});
