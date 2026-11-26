import { expect, test, type Page } from '@playwright/test';
import { type Address } from 'viem';
import { injectTestWallet } from './test-wallet';

// SH-319: an OpenFour token's page shows the create form's picture with its numbers, and a press on a part leads to
// its panel. Needs the fork that FOUR_RULES=1 scripts/four-fork.sh brings up (as e2e/four-rules.spec.ts, which this follows).
const RPC = process.env.PILE_RPC ?? 'http://127.0.0.1:8581';
const ACCOUNT = process.env.FOUR_ACCOUNT as Address;
const Q = '?addresses=local/addresses.json';

async function shot(page: Page, name: string) {
  for (const [w, h] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
    await page.screenshot({ path: `shots/${name}-${w}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function done(page: Page, box: string, label: string) {
  await expect(page.getByTestId(box).getByTestId('tx-status').filter({ hasText: `${label}: done` }).first()).toBeVisible({ timeout: 90_000 });
}

async function act(page: Page, box: string, button: string, label: string) {
  for (let i = 0; i < 3; i++) {
    const b = page.getByTestId(box).getByTestId(button);
    await expect(b).toBeEnabled({ timeout: 30_000 });
    const text = (await b.textContent()) ?? '';
    const doing = text.startsWith('Approve') ? 'Approve' : text.startsWith('Wrap') ? 'Wrap' : label;
    await b.click();
    await done(page, box, doing);
    if (doing === label) return;
    await expect(b).toHaveText(new RegExp(`^${label}`), { timeout: 30_000 });
  }
}

test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByTestId('press-close'), (close) => close.click());
});

test('a tax token with rules: the picture with its numbers; a part leads to its panel', async ({ page }) => {
  await injectTestWallet(page, RPC, 0, ACCOUNT);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${Q}#/four/create`);
  await page.getByTestId('connect').click();
  await page.getByTestId('four-kind-tax').click();
  const part = (id: string) => page.locator(`[data-part="${id}"] .sh-pic-hit`).first();
  await part('token').click();
  await page.getByTestId('four-name').fill('Picture Tax');
  await page.getByTestId('four-symbol').fill('PTX');
  await part('raise').click();
  await page.getByTestId('four-raise').fill('0.3');
  await part('tax').click();
  await page.getByTestId('rules-creator').fill('20');
  await page.getByTestId('rules-pile').fill('50');
  await page.getByTestId('rules-burn').fill('30');
  await page.getByTestId('part-close').click();
  await page.getByTestId('four-create-btn').click();
  await expect(page).toHaveURL(/#\/four\/0x[0-9a-fA-F]{40}$/, { timeout: 90_000 });
  await expect(page.getByTestId('four-token')).toHaveAttribute('data-kind', 'tax-rules', { timeout: 30_000 });

  // Before the rules are set up: the rules' parts from the token's own read (2 creator, 5 pile, 3 buy back of 10).
  const pic = page.getByTestId('live-picture');
  await expect(pic.locator('[data-cell="creator"]')).toHaveCount(4, { timeout: 30_000 });
  await expect(pic.locator('[data-cell="buyburn"]')).toHaveCount(6);
  await expect(pic.locator('[data-creator-tag]')).toContainText('20%');
  await shot(page, 'four-page-new');

  // Set up the rules, a curve buy, settle, share out: the creator's part shows what it was sent, the pile its amount.
  await page.getByTestId('create-rules').click();
  await expect(page.getByTestId('create-rules-box')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId('pile-size')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('curve-amount').fill('0.1');
  await expect(page.getByTestId('curve-review')).toBeVisible({ timeout: 30_000 });
  await act(page, 'curve-trade', 'curve-trade-btn', 'Buy');
  await page.getByTestId('settle').click();
  await done(page, 'settle-box', 'Settle');
  const panel = page.getByTestId('rules-panel');
  await expect(panel.getByTestId('share-out')).toBeEnabled({ timeout: 30_000 });
  await panel.getByTestId('share-out').click();
  await done(page, 'rules-panel', 'Share out');
  await expect(pic).toContainText('sent ', { timeout: 30_000 });
  await expect(pic.locator('[data-part="pile"]')).toHaveAttribute('aria-label', /^Pile: \d/);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, 'four-page-shared');

  for (const [id, target] of [
    ['pile', 'pile-panel'],
    ['token', 'curve-trade'],
    ['creator', 'rules-panel'],
  ] as const) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await pic.locator(`[data-part="${id}"] .sh-pic-hit`).first().click();
    await expect(page.getByTestId(target).first()).toBeFocused();
    await expect(page.getByTestId(target).first()).toBeInViewport();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await pic.locator('[data-part="token"] .sh-pic-hit').first().click();
  await expect(page.getByTestId('curve-trade')).toBeInViewport();
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'shots/four-page-led-to-trade-390.png' });
});
