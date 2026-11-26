import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// SH-281 step 3: a Flap rules launch whose rules pay a card shop, on lane e's rehearsal kept up
// (scripts/rules-shop-fork.sh): the rules panel names the shop "Card shop" (proven on chain against the deployment
// file's shop factory), the sale's page links exactly that shop, and the shop's page knows who launched the token (the
// rules pair's launcher factory), so it does not say "Made by …".
const here = path.dirname(fileURLToPath(import.meta.url));
const stand = JSON.parse(fs.readFileSync(path.join(here, '../public/local/shop-stand.json'), 'utf8')) as { launcher: string; shop: string };
const SHOTS = process.env.PILE_SHOTS ?? path.join(here, '../../../hackathon/evidence/SH-281');

test('a rules sale names its shop "Card shop" and links it; the shop page knows the launch', async ({ page }) => {
  test.setTimeout(180_000);
  for (const [w, h] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`/?addresses=local/addresses.json#/flap/${stand.launcher}`);
    const rules = page.getByTestId('rules-panel');
    await expect(rules).toBeVisible({ timeout: 90_000 });
    // the rehearsal's rules: creator, pile, the shop, buy back last
    await expect(rules.locator('[data-testid$="-name"]')).toHaveText(['Creator', 'Pile', 'Card shop', 'Buy back and burn'], { timeout: 30_000 });
    const links = page.getByTestId('shop-links').locator('a');
    await expect(links).toHaveCount(1, { timeout: 60_000 });
    await expect(links.first()).toHaveAttribute('href', `#/shop/${stand.shop}`);
    await page.screenshot({ path: path.join(SHOTS, `rules-with-shop-${w}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId('shop-links').locator('a').first().click();
  await expect(page).toHaveURL(new RegExp(`#/shop/${stand.shop}$`, 'i'));
  // the launch's creator is known and made the shop: the page says so by its state, and no "Made by …" line
  await expect(page.locator('[data-testid="shop-page"][data-maker="launch"]')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('shop-maker')).toHaveCount(0);
});
