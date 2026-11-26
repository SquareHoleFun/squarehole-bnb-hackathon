import { expect, test, type Page } from '@playwright/test';
import { injectTestWallet } from './test-wallet';

// SH-318: "What happens" beside Four.meme's launch picture (the four-rules fork, FOUR_RULES=1 scripts/four-fork.sh):
// the curve-fee kind pays every fee to the pile; the tax kind shares the tax by the rules; nothing overflows at 390.
// Pictures in shots/ (not committed).
const RPC = process.env.PILE_RPC ?? 'http://127.0.0.1:8581';
const ACCOUNT = process.env.FOUR_ACCOUNT;
const Q = '?addresses=local/addresses.json';

async function look(page: Page, name: string, w: number) {
  await page.waitForTimeout(800);
  await page.screenshot({ path: `shots/${name}-${w}.png`, fullPage: true });
  await page.getByTestId('what-happens').screenshot({ path: `shots/${name}-panel-${w}.png` });
}

for (const [w, h] of [[1440, 900], [390, 844]] as const) {
  test(`Four.meme: What happens in both kinds (${w})`, async ({ page }) => {
    await injectTestWallet(page, RPC, 0, ACCOUNT);
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`/${Q}#/four/create`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('way-visual')).toHaveAttribute('aria-current', 'true');
    const panel = page.getByTestId('what-happens');
    await expect(panel).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('wh-traded')).toContainText('fee 1 ');
    await expect(panel.locator('[data-row="pile"]')).toContainText('1');
    await look(page, 'wh-four-fee', w);
    await page.getByTestId('four-kind-tax').click();
    await expect(page.getByTestId('wh-traded')).toContainText('tax 1 ');
    await page.locator('[data-part="tax"] .sh-pic-hit').first().click();
    await page.getByTestId('rules-creator').fill('20');
    await page.getByTestId('rules-pile').fill('50');
    await page.getByTestId('rules-burn').fill('30');
    await page.getByTestId('part-close').click();
    await expect(panel.locator('[data-row="creator"]')).toContainText('0.2');
    await expect(panel.locator('[data-row="pile"]')).toContainText('0.5');
    await expect(panel.locator('[data-row="buyburn"]')).toContainText('0.3');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
    await look(page, 'wh-four-tax', w);
  });
}
