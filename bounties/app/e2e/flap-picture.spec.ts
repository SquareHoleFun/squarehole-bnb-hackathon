import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectTestWallet } from './test-wallet';

// SH-281: Flap's create screen, Visual way, on the token-quote fork (scripts/flap-usdt-fork.sh): every part opens its
// fields, nothing is clipped at 1440 or 390, every part is at least 44 px, the keyboard reaches and opens every part,
// and the Visual and Steps ways edit the same form. Screenshots of each state and each part open.
const here = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.PILE_RPC ?? 'http://127.0.0.1:8581';
const SHOTS = process.env.PILE_SHOTS ?? path.join(here, '../../../hackathon/evidence/SH-281');
const Q = '?addresses=local/addresses.json';
const PARTS = ['buyers', 'token', 'sellers', 'creator', 'raise', 'price', 'deadline', 'tax', 'pool', 'pile'] as const;
const SIZES = [
  [1440, 900],
  [390, 844],
] as const;

test.describe.configure({ mode: 'serial' });

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

async function openCreate(page: Page, w: number, h: number) {
  await injectTestWallet(page, RPC, 3);
  await page.setViewportSize({ width: w, height: h });
  await page.goto(`/${Q}#/flap/create`);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('launch-picture')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('create-raise')).toBeVisible({ timeout: 60_000 });
}

for (const [w, h] of SIZES) {
  test(`every part opens its fields, nothing clipped, targets at least 44 px (${w})`, async ({ page }) => {
    await openCreate(page, w, h);
    await expect(page.locator('[data-testid="launch-on-flap"]')).toHaveAttribute('aria-current', 'true');
    await shot(page, `flap-filled-${w}`);
    // Every part's hit area is at least 44 px on this screen.
    for (const id of PARTS) {
      const box = await page.locator(`[data-part="${id}"] .sh-pic-hit`).first().boundingBox();
      expect(box, id).not.toBeNull();
      expect(Math.min(box!.width, box!.height), id).toBeGreaterThanOrEqual(44);
    }
    for (const id of PARTS) {
      await page.locator(`[data-part="${id}"] .sh-pic-hit`).first().click();
      const sheet = page.getByTestId('part-sheet');
      await expect(sheet).toBeVisible();
      await expect(page.locator(`[data-part="${id}"]`)).toHaveAttribute('aria-expanded', 'true');
      // Every field of the sheet can be scrolled into view, whole, inside the window.
      for (const input of await sheet.locator('input:not([type=checkbox])').all()) {
        await input.scrollIntoViewIfNeeded();
        const b = await input.boundingBox();
        expect(b, `${id} field`).not.toBeNull();
        expect(b!.x).toBeGreaterThanOrEqual(0);
        expect(b!.x + b!.width).toBeLessThanOrEqual(w + 0.5);
        expect(b!.y).toBeGreaterThanOrEqual(0);
        expect(b!.y + b!.height).toBeLessThanOrEqual(h + 0.5);
        expect(b!.height).toBeGreaterThanOrEqual(44);
      }
      await shot(page, `flap-open-${id}-${w}`);
      await page.getByTestId('part-close').click();
      await expect(sheet).toHaveCount(0);
      await expect(page.locator(`[data-part="${id}"]`)).toBeFocused();
    }
  });
}

test('a field with a problem marks its part, and Create opens the first such part', async ({ page }) => {
  await openCreate(page, 1440, 900);
  await page.locator('[data-part="token"] .sh-pic-hit').first().click();
  await page.getByTestId('create-symbol').fill('');
  await page.getByTestId('part-close').click();
  await page.locator('[data-part="raise"] .sh-pic-hit').first().click();
  await page.getByTestId('create-target').fill('');
  await expect(page.getByTestId('create-refusal')).toHaveText('Enter the target in BNB.');
  await page.getByTestId('part-close').click();
  await expect(page.locator('[data-warn="token"]')).toBeVisible();
  await expect(page.locator('[data-warn="raise"]')).toBeVisible();
  await expect(page.getByTestId('create-problems')).toContainText('Target ?');
  await shot(page, 'flap-problem-1440');
  await page.getByTestId('create').click();
  // The first part with a problem, in reading order: the token.
  await expect(page.locator('[data-part="token"]')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('create-refusal').first()).toHaveText('Enter a symbol.');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, 'flap-problem-open-390');
});

test('the keyboard reaches every part; Enter opens it, Escape shuts it and focus returns', async ({ page }) => {
  await openCreate(page, 1440, 900);
  for (const id of PARTS) {
    await page.locator(`[data-part="${id}"]`).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('part-sheet')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('part-sheet')).toHaveCount(0);
    await expect(page.locator(`[data-part="${id}"]`)).toBeFocused();
  }
  // Tab moves from part to part in reading order.
  await page.locator('[data-part="buyers"]').focus();
  for (const id of ['token', 'sellers', 'creator', 'raise', 'price', 'deadline', 'tax', 'pool', 'pile']) {
    await page.keyboard.press('Tab');
    await expect(page.locator(`[data-part="${id}"]`)).toBeFocused();
  }
});

test('Visual and Steps edit the same form; empty fields mark their parts', async ({ page }) => {
  await openCreate(page, 1440, 900);
  await page.getByTestId('way-steps').click();
  for (const key of ['name', 'symbol', 'target', 'saleTokens', 'virtualBnb', 'durationHours', 'tradeFee', 'buyTax', 'sellTax', 'burnShare', 'taxDays']) {
    await page.getByTestId(`create-${key}`).fill('');
  }
  await page.getByTestId('way-visual').click();
  for (const id of ['token', 'buyers', 'sellers', 'raise', 'deadline', 'tax'] as const) await expect(page.locator(`[data-warn="${id}"]`)).toBeVisible();
  await shot(page, 'flap-empty-1440');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, 'flap-empty-390');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('[data-part="token"] .sh-pic-hit').first().click();
  await page.getByTestId('create-symbol').fill('KITE');
  await page.getByTestId('part-close').click();
  await page.getByTestId('way-steps').click();
  await expect(page.getByTestId('create-symbol')).toHaveValue('KITE');
});

test('without any wallet the test coin has no frame; the screen speaks in one place', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${Q}#/flap/create`);
  await expect(page.getByTestId('launch-picture')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('no-wallet')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId('mint-box')).toHaveCount(0);
  await shot(page, 'flap-no-wallet-1440');
});

test('without a rules entry in the deployment file: no rule fields in either way, the trays as before', async ({ page }) => {
  await openCreate(page, 1440, 900);
  await page.locator('[data-part="tax"] .sh-pic-hit').first().click();
  await expect(page.getByTestId('part-sheet')).toBeVisible();
  await expect(page.getByTestId('rules-fields')).toHaveCount(0);
  await expect(page.getByTestId('part-sheet')).toContainText("the token's tax is split between burning and the pile");
  await page.getByTestId('part-close').click();
  const tray = page.getByTestId('launch-picture');
  await expect(tray.locator('[data-cell="burn"]')).toHaveCount(4);
  await expect(tray.locator('[data-cell="pile"]')).toHaveCount(16);
  await expect(tray.locator('[data-cell="creator"], [data-cell="buyburn"], [data-creator-tag]')).toHaveCount(0);
  await page.getByTestId('way-steps').click();
  await expect(page.getByTestId('create-target')).toBeVisible();
  await expect(page.getByTestId('rules-fields')).toHaveCount(0);
});
