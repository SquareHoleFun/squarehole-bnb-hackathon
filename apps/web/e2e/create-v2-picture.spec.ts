import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { installUntouchableWallet, overflow, walletTouches } from './box-helpers';

// SH-251: the visual Create at /create/v2-picture, beside the six steps, at 400 and 1280 px, light and dark (the app
// itself is dark; the page must hold in either scheme). Every part opens its sheet and is named with the words it
// shows, its description holding what sits beside it; the steps' fields change the picture at once; What happens
// requests nothing and asks no wallet, with and without reduced motion; the switch keeps the draft; the page never
// scrolls sideways; a long ticker and a long raise stay inside the picture. SH_EVIDENCE_SCREENSHOTS=1 writes the
// screenshots to docs/evidence/SH-251/ (or SH_EVIDENCE_DIR).
const SIZES = [{ width: 400, height: 860 }, { width: 1280, height: 860 }] as const;
const SCHEMES = ['light', 'dark'] as const;
const PARTS = ['buyers', 'token', 'contents', 'sellers', 'creator', 'raise', 'price', 'holders', 'mark', 'pool'] as const;
/** A part's first hit area: a side's part spans the picture, so its middle can be another part's. */
const hitOf = (page: Page, id: string) => page.locator(`[data-part="${id}"] .sh-pic-hit`).first();
const part = (page: Page, id: string) => page.locator(`[data-part="${id}"]`);

async function shot(page: Page, info: TestInfo, name: string, fullPage = false) {
  const path = process.env.SH_EVIDENCE_SCREENSHOTS === '1'
    ? fileURLToPath(new URL(`../../../docs/evidence/${process.env.SH_EVIDENCE_DIR ?? 'SH-251'}/${name}.png`, import.meta.url)) : info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage, scale: 'css' });
}

/** Every text of the picture, and the picture's own box: nothing may lie outside it. */
async function outside(page: Page): Promise<string[]> {
  return page.locator('svg.sh-pic').evaluate((svg) => {
    const box = svg.getBoundingClientRect();
    return Array.from(svg.querySelectorAll('text'), (text) => {
      const r = text.getBoundingClientRect();
      return r.width > 0 && (r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1) ? text.textContent ?? '' : null;
    }).filter((text): text is string => text !== null);
  });
}

test.beforeEach(async ({ page }, info) => {
  // One run of each size and scheme is enough: the sizes are set here, not by the project.
  test.skip(info.project.name !== 'desktop', 'sizes are set per test');
  await installUntouchableWallet(page);
});

for (const size of SIZES) {
  for (const scheme of SCHEMES) {
    test(`SH-251 the picture way at ${size.width} px, ${scheme}: every part opens its sheet, What happens calls nothing`, async ({ page }, info) => {
      await page.setViewportSize(size);
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await page.goto('/create/v2-picture');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Launch a box');
      const picture = page.getByRole('group', { name: 'Your box' });
      await expect(picture).toBeVisible();
      await expect(picture).toHaveAccessibleDescription('Tap a part to change it.');
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      expect(await outside(page)).toEqual([]);
      // Names hold the words each part shows; what sits beside it is its description.
      await expect(part(page, 'buyers')).toHaveAccessibleName('Buys · Buyers’ fees');
      await expect(part(page, 'buyers')).toHaveAccessibleDescription('Buy back and burn the box coin · 0.667%');
      await expect(part(page, 'sellers')).toHaveAccessibleName('Sells · Sellers’ fees');
      await expect(part(page, 'pool')).toHaveAccessibleDescription('0.133%');
      await shot(page, info, `first-${size.width}-${scheme}`);

      // Every part is a button with its name; each opens its own sheet, which closes with Escape.
      for (const id of PARTS) {
        await hitOf(page, id).click();
        const sheet = page.getByRole('dialog');
        await expect(sheet).toBeVisible();
        await expect(part(page, id)).toHaveAttribute('aria-expanded', 'true');
        await expect(sheet.locator('.sh-pic-sheet__title')).toBeFocused();
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        if (id === 'sellers' || id === 'contents') await shot(page, info, `sheet-${id}-${size.width}-${scheme}`);
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(part(page, id)).toBeFocused();
      }
      // Focus shows on the box front too (the ring on its dark casing).
      await part(page, 'price').focus();
      await expect(part(page, 'price').locator('.sh-pic-ring--focus').first()).toHaveCSS('opacity', '1');

      // A choice in a sheet redraws the picture at once: To holders on the buyers' side.
      await hitOf(page, 'buyers').click();
      await page.locator('#create-v2-buyers [data-fee-choice="holders"]').click();
      await expect(page.locator('[data-words="buyers"]')).toContainText('To holders');
      await shot(page, info, `holders-${size.width}-${scheme}`);
      await page.keyboard.press('Escape');

      // What happens: no request and no wallet on any press; the ledger follows the fifteenths.
      const requests: string[] = [];
      page.on('request', (request) => requests.push(request.url()));
      const happens = page.getByRole('region', { name: 'What happens' });
      await happens.getByRole('button', { name: /^Someone buys/ }).click();
      await expect(happens.locator('[data-row="buyers"] b')).toHaveText('0.00667');
      await happens.getByRole('button', { name: /^Someone sells/ }).click();
      await happens.getByRole('button', { name: /^100 trades/ }).click();
      await expect(happens.locator('[data-traded]')).toHaveText('102 ETH traded · fee 1.02 ETH');
      expect(requests).toEqual([]);
      expect(await walletTouches(page)).toEqual([]);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await shot(page, info, `run-${size.width}-${scheme}`, true);
    });
  }
}

test('SH-251 What happens in motion: the coins play, the buttons say they are off meanwhile, every trade is counted', async ({ page }, info) => {
  await page.setViewportSize({ width: 400, height: 860 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/create/v2-picture');
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  const happens = page.getByRole('region', { name: 'What happens' });
  const buys = happens.getByRole('button', { name: /^Someone buys/ });
  await buys.click();
  await expect(page.locator('.sh-pic-fx circle').first()).toBeAttached();
  await expect(buys).toHaveAttribute('aria-disabled', 'true');
  await expect(happens.locator('[data-row="buyers"] b')).toHaveText('0.00667', { timeout: 15_000 });
  await expect(buys).not.toHaveAttribute('aria-disabled', 'true');
  await happens.getByRole('button', { name: /^100 trades/ }).click();
  await expect(happens.locator('[data-traded]')).toHaveText('101 ETH traded · fee 1.01 ETH', { timeout: 60_000 });
  await expect(page.locator('.sh-pic-fx circle')).toHaveCount(0);
  await shot(page, info, 'motion-400');
  expect(requests).toEqual([]);
  expect(await walletTouches(page)).toEqual([]);
});

test('SH-251 the play buttons fit at 320 and 400 px; a long ticker and a long raise stay inside the picture', async ({ page }, info) => {
  for (const width of [320, 400]) {
    await page.setViewportSize({ width, height: 860 });
    await page.goto('/create/v2-picture');
    for (const button of await page.getByRole('region', { name: 'What happens' }).locator('.sh-pic-play > button').all()) {
      expect(await button.evaluate((element) => element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    }
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  }
  // An 11-character ticker, and the box coin with the longest raise on the list (FIT: eight digits).
  await hitOf(page, 'token').click();
  await page.getByRole('dialog').getByRole('textbox', { name: 'Ticker' }).fill('ABCDEFGHIJK');
  await page.keyboard.press('Escape');
  await hitOf(page, 'price').click();
  await page.getByRole('dialog').getByRole('radio', { name: /^FIT/ }).check();
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  expect(await outside(page)).toEqual([]);
  await shot(page, info, 'long-ticker-raise-400');
});

test('SH-251 the steps keep their header; the switch keeps the draft; Overview follows the steps’ rule', async ({ page }, info) => {
  for (const width of [400, 1280]) {
    await page.setViewportSize({ width, height: 860 });
    await page.goto('/create/v2-basics');
    // The steps' header holds what it held before; the switch is a row of its own above it.
    await expect(page.locator('header.sh-newbox__head .sh-pic-ways')).toHaveCount(0);
    await page.locator('header.sh-newbox__head').screenshot({ path: process.env.SH_EVIDENCE_SCREENSHOTS === '1'
      ? fileURLToPath(new URL(`../../../docs/evidence/${process.env.SH_EVIDENCE_DIR ?? 'SH-251'}/steps-header-${width}.png`, import.meta.url)) : info.outputPath(`steps-header-${width}.png`) });
  }
  await page.setViewportSize({ width: 400, height: 860 });
  await page.goto('/create/v2-picture');
  await hitOf(page, 'token').click();
  await page.getByRole('dialog').getByRole('textbox', { name: 'Name' }).fill('Night Owls');
  await page.keyboard.press('Escape');
  await expect(part(page, 'token')).toBeFocused();
  const ways = page.getByRole('navigation', { name: 'Launch' });
  await ways.getByRole('link', { name: 'Steps' }).click();
  await expect(page).toHaveURL(/\/create\/v2-basics$/);
  await expect(page.getByRole('textbox', { name: 'Name' })).toHaveValue('Night Owls');
  await page.getByRole('navigation', { name: 'Launch' }).getByRole('link', { name: 'Visual' }).click();
  await expect(page).toHaveURL(/\/create\/v2-picture$/);
  // Basics still has something to fix (the ticker, the logo): Overview reveals it and stays, as the steps would.
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(page).toHaveURL(/\/create\/v2-picture$/);
  await expect(page.locator('.sh-pic-issues__title')).toBeFocused();
  await expect(page.locator('.sh-pic-issues')).toContainText('Ticker: Required');
  // SH-254: one rounded control, Visual, Steps, Examples (the examples are in the app, SH-252), the current way marked.
  const control = page.getByRole('navigation', { name: 'Launch' }).locator('.sh-pic-ways__switch');
  await expect(control.getByRole('link')).toHaveText(['Visual', 'Steps', 'Examples']);
  await expect(control.getByRole('link', { name: 'Visual' })).toHaveAttribute('aria-current', 'true');
  await expect(control.getByRole('link', { name: 'Examples' })).toHaveAttribute('href', '/examples');
  await expect(control.getByRole('link', { name: 'Examples' })).not.toHaveAttribute('aria-current', /.*/);
  expect(await walletTouches(page)).toEqual([]);
});
