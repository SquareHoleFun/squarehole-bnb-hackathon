import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectTestWallet } from './test-wallet';

// SH-281: Four.meme's create screen, Visual way, on the OpenFour fork (scripts/four-fork.sh), in both kinds: every
// part opens its fields, nothing is clipped at 1440 or 390, every part is at least 44 px, the keyboard reaches every
// part, a problem marks its part and the press opens it, and the two ways edit one form. Screenshots of each state.
const here = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.PILE_RPC ?? 'http://127.0.0.1:8581';
const ACCOUNT = process.env.FOUR_ACCOUNT;
const SHOTS = process.env.PILE_SHOTS ?? path.join(here, '../../../hackathon/evidence/SH-281');
const Q = '?addresses=local/addresses.json';
const PARTS = ['buyers', 'token', 'sellers', 'creator', 'raise', 'price', 'tax', 'pool', 'pile'] as const;

test.describe.configure({ mode: 'serial' });

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}
const part = (page: Page, id: string) => page.locator(`[data-part="${id}"] .sh-pic-hit`).first();

async function openCreate(page: Page, w: number, h: number) {
  await injectTestWallet(page, RPC, 0, ACCOUNT);
  await page.setViewportSize({ width: w, height: h });
  await page.goto(`/${Q}#/four/create`);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('launch-picture')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('launch-on-four')).toHaveAttribute('aria-current', 'true');
}

for (const kind of ['preset', 'tax'] as const) {
  for (const [w, h] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    test(`${kind}: every part opens its fields, nothing clipped, targets at least 44 px (${w})`, async ({ page }) => {
      await openCreate(page, w, h);
      await page.getByTestId(`four-kind-${kind}`).click();
      await expect(page.locator('[data-part="buyers"]')).toHaveAttribute('aria-label', kind === 'tax' ? 'Buys: tax 1%' : 'Buys: fee 1%');
      await shot(page, `four-${kind}-filled-${w}`);
      for (const id of PARTS) {
        const box = await page.locator(`[data-part="${id}"] .sh-pic-hit`).first().boundingBox();
        expect(box, id).not.toBeNull();
        expect(Math.min(box!.width, box!.height), id).toBeGreaterThanOrEqual(44);
      }
      await expect(page.locator('[data-part="deadline"]')).toHaveCount(0);
      for (const id of PARTS) {
        await part(page, id).click();
        const sheet = page.getByTestId('part-sheet');
        await expect(sheet).toBeVisible();
        for (const input of await sheet.locator('input, select').all()) {
          await input.scrollIntoViewIfNeeded();
          const b = await input.boundingBox();
          expect(b, `${id} field`).not.toBeNull();
          expect(b!.x).toBeGreaterThanOrEqual(0);
          expect(b!.x + b!.width).toBeLessThanOrEqual(w + 0.5);
          expect(b!.y).toBeGreaterThanOrEqual(0);
          expect(b!.y + b!.height).toBeLessThanOrEqual(h + 0.5);
          expect(b!.height).toBeGreaterThanOrEqual(44);
        }
        await shot(page, `four-${kind}-open-${id}-${w}`);
        await page.getByTestId('part-close').click();
        await expect(sheet).toHaveCount(0);
        await expect(page.locator(`[data-part="${id}"]`)).toBeFocused();
      }
    });
  }
}

test('a problem marks its part; Create opens the first one; the keyboard reaches every part', async ({ page }) => {
  await openCreate(page, 1440, 900);
  await part(page, 'token').click();
  await page.getByTestId('four-symbol').fill('pile');
  await part(page, 'sellers').click();
  await page.getByTestId('four-sell').fill('11');
  await page.getByTestId('part-close').click();
  await expect(page.locator('[data-warn="token"]')).toBeVisible();
  await expect(page.locator('[data-warn="sellers"]')).toBeVisible();
  await shot(page, 'four-problem-1440');
  await page.getByTestId('four-create-btn').click();
  await expect(page.locator('[data-part="token"]')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('four-refusal')).toHaveText('1 to 10 capital letters or digits.');
  await page.keyboard.press('Escape');
  await page.locator('[data-part="buyers"]').focus();
  for (const id of PARTS.slice(1)) {
    await page.keyboard.press('Tab');
    await expect(page.locator(`[data-part="${id}"]`)).toBeFocused();
  }
});

test('Visual and Steps edit the same form, the kind included', async ({ page }) => {
  await openCreate(page, 1440, 900);
  await page.getByTestId('four-kind-tax').click();
  await part(page, 'token').click();
  await page.getByTestId('four-symbol').fill('KITE');
  await page.getByTestId('part-close').click();
  await page.getByTestId('way-steps').click();
  await expect(page.getByTestId('four-symbol')).toHaveValue('KITE');
  await expect(page.getByTestId('four-kind-tax')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('four-raise').fill('');
  await page.getByTestId('way-visual').click();
  await expect(page.locator('[data-warn="raise"]')).toBeVisible();
  await shot(page, 'four-empty-raise-1440');
});

test('without a rules template in the deployment file: the tax kind has no rule fields, the trays as before', async ({ page }) => {
  await openCreate(page, 1440, 900);
  await page.getByTestId('four-kind-tax').click();
  await part(page, 'tax').click();
  await expect(page.getByTestId('part-sheet')).toContainText("the token's tax goes to the pile through OpenFour's tax vault");
  await expect(page.getByTestId('rules-fields')).toHaveCount(0);
  await page.getByTestId('part-close').click();
  const pic = page.getByTestId('launch-picture');
  await expect(pic.locator('[data-cell="pile"]')).toHaveCount(20);
  await expect(pic.locator('[data-cell="creator"], [data-cell="buyburn"], [data-creator-tag]')).toHaveCount(0);
  await page.getByTestId('way-steps').click();
  await expect(page.getByTestId('four-name')).toBeVisible();
  await expect(page.getByTestId('rules-fields')).toHaveCount(0);
});
