import { expect, test, type Page } from '@playwright/test';
import { injectTestWallet } from './test-wallet';

// SH-318: "What happens" beside Flap's launch picture (the flap-rules fork, scripts/flap-rules-fork.sh): 100 trades
// at the form's 1% curve fee give 1 coin of curve fees, shared 20 / 50 / 30 by the rules; the panel follows a part's
// change at once; nothing overflows at 390. Pictures in shots/ (not committed).
const RPC = process.env.PILE_RPC ?? 'http://127.0.0.1:8582';
const Q = '?addresses=local/addresses.json';

async function look(page: Page, name: string, w: number) {
  await page.waitForTimeout(800);
  await page.screenshot({ path: `shots/${name}-${w}.png`, fullPage: true });
  await page.getByTestId('what-happens').screenshot({ path: `shots/${name}-panel-${w}.png` });
}

for (const [w, h] of [[1440, 900], [390, 844]] as const) {
  test(`Flap: What happens follows the rules (${w})`, async ({ page }) => {
    await injectTestWallet(page, RPC, 2);
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`/${Q}#/flap/create`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('way-visual')).toHaveAttribute('aria-current', 'true');
    const panel = page.getByTestId('what-happens');
    await expect(panel).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('wh-traded')).toContainText('100 trades');
    await expect(page.getByTestId('wh-traded')).toContainText('fee 1 ');
    await look(page, 'wh-flap-default', w);
    await page.locator('[data-part="tax"] .sh-pic-hit').first().click();
    await page.getByTestId('rules-creator').fill('20');
    await page.getByTestId('rules-pile').fill('50');
    await page.getByTestId('rules-burn').fill('30');
    await page.getByTestId('part-close').click();
    await expect(panel.locator('[data-row="creator"]').first()).toContainText('0.2');
    await expect(panel.locator('[data-row="pile"]').first()).toContainText('0.5');
    await expect(panel.locator('[data-row="buyburn"]').first()).toContainText('0.3');
    await expect(panel.locator('[data-row="creator"]').nth(1)).toContainText('20%');
    await expect(panel.getByText('?', { exact: true })).toBeVisible();
    // Nothing wider than the window.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
    const box = await panel.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(w + 0.5);
    await look(page, 'wh-flap-rules', w);
    await page.getByRole('button', { name: 'About the fees' }).click();
    await look(page, 'wh-flap-help', w);
  });
}
