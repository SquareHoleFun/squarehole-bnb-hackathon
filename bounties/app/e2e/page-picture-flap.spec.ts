import { expect, test, type Page } from '@playwright/test';
import { createPublicClient, http, type Address } from 'viem';
import { injectTestWallet } from './test-wallet';
import { toDecimalString } from '../src/lib/amounts';

// SH-319: a launched Flap sale's page shows the create form's picture with its numbers, and a press on a part leads
// to its panel. Needs the fork of scripts/flap-rules-fork.sh (as e2e/flap-rules.spec.ts, whose first test this follows).
const RPC = process.env.PILE_RPC ?? 'http://127.0.0.1:8582';
const chain = createPublicClient({ transport: http(RPC) });
const Q = '?addresses=local/addresses.json';
const erc20 = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
] as const;
const launcherAbi = [
  { type: 'function', name: 'launchInfo', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }, { type: 'address' }, { type: 'address' }] },
] as const;

async function shot(page: Page, name: string) {
  for (const [w, h] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(300);
    // nothing wider than the screen
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
    await page.screenshot({ path: `shots/${name}-${w}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function done(page: Page, box: string, labelText: string) {
  await expect(page.getByTestId(box).getByTestId('tx-status').filter({ hasText: `${labelText}: done` }).first()).toBeVisible({ timeout: 90_000 });
}

test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByTestId('press-close'), (close) => close.click());
});

test('a rules sale: the picture with its numbers before and after the launch; a part leads to its panel', async ({ page }) => {
  const me = ((await chain.request({ method: 'eth_accounts' as never })) as Address[])[2]!;
  await injectTestWallet(page, RPC, 2);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${Q}#/flap/create`);
  await page.getByTestId('connect').click();
  await page.locator('[data-part="tax"] .sh-pic-hit').first().click();
  await page.getByTestId('rules-creator').fill('20');
  await page.getByTestId('rules-pile').fill('50');
  await page.getByTestId('rules-burn').fill('30');
  await page.getByTestId('part-close').click();
  for (let i = 0; i < 2; i++) {
    await page.getByTestId('mint').click();
    await done(page, 'mint-box', 'Get');
  }
  await expect(page.getByTestId('create-review')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('create').click();
  await expect(page).toHaveURL(/#\/flap\/0x[0-9a-fA-F]{40}$/, { timeout: 120_000 });
  const launcher = page.url().split('/').pop() as Address;
  await expect(page.getByTestId('flap-sale')).toHaveAttribute('data-trusted', 'yes', { timeout: 30_000 });

  // Selling: the picture's front shows the raise and the sold share; the trays the rules (2 burned, 2 creator, 4 pile, 2 buy back).
  const pic = page.getByTestId('live-picture');
  await expect(pic.locator('[data-cell="creator"]')).toHaveCount(4, { timeout: 30_000 });
  await expect(pic.locator('[data-cell="buyburn"]')).toHaveCount(4);
  await expect(pic.locator('[data-creator-tag]')).toContainText('20%');
  await expect(pic).toContainText('Raised');
  await expect(pic).toContainText('Sold');
  await shot(page, 'flap-page-selling');

  // Buy, launch, claim.
  await page.getByTestId('buy-amount').fill('300');
  await expect(page.getByTestId('buy-review')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('buy').click();
  await done(page, 'buy-box', 'Buy');
  await page.getByTestId('launch').click();
  await done(page, 'launch-status', 'Launch');
  await expect(page.getByTestId('sale-phase')).toHaveText('Launched', { timeout: 30_000 });
  await page.getByTestId('claim').click();
  await done(page, 'claim-box', 'Claim');
  const [token] = (await chain.readContract({ address: launcher, abi: launcherAbi, functionName: 'launchInfo' })) as readonly [Address, Address, Address];

  // Pool trades until tax waits; send it to the rules; share out.
  for (let round = 0; round < 6; round++) {
    await page.getByTestId('trade-buy-tab').click();
    await page.getByTestId('trade-amount').fill('100');
    await expect(page.getByTestId('trade-review')).toBeVisible({ timeout: 30_000 });
    for (const step of ['Approve', 'Buy']) {
      if (step === 'Approve' && !((await page.getByTestId('trade').textContent()) ?? '').startsWith('Approve')) continue;
      await page.getByTestId('trade').click();
      await done(page, 'pool-trade', step);
      if (step === 'Approve') await expect(page.getByTestId('trade')).toHaveText('Buy', { timeout: 30_000 });
    }
    const held = await chain.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [me] });
    await page.getByTestId('trade-sell-tab').click();
    await page.getByTestId('trade-amount').fill(toDecimalString(held / 3n, 18));
    await expect(page.getByTestId('trade-review')).toBeVisible({ timeout: 30_000 });
    for (const step of ['Approve', 'Sell']) {
      if (step === 'Approve' && !((await page.getByTestId('trade').textContent()) ?? '').startsWith('Approve')) continue;
      await page.getByTestId('trade').click();
      await done(page, 'pool-trade', step);
      if (step === 'Approve') await expect(page.getByTestId('trade')).toHaveText('Sell', { timeout: 30_000 });
    }
    if (await page.getByTestId('dispatch').isEnabled({ timeout: 10_000 }).catch(() => false)) break;
  }
  await page.getByTestId('dispatch').click();
  await done(page, 'dispatch-box', 'Send to the rules');
  await page.getByTestId('rules-panel').getByTestId('share-out').click();
  await done(page, 'rules-panel', 'Share out');

  // Launched: the creator's part shows what it was sent, the pile its amount, the front 100% sold.
  await expect(pic).toContainText('sent ', { timeout: 30_000 });
  await expect(pic).toContainText('100%');
  await expect(pic.locator('[data-part="pile"]')).toHaveAttribute('aria-label', /^Pile: \d/);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, 'flap-page-launched');

  // A part leads to its panel: the pile to the pile panel, the token to the trade box, Tax to the rules.
  for (const [part, panel] of [
    ['pile', 'pile-panel'],
    ['token', 'pool-trade'],
    ['tax', 'rules-panel'],
  ] as const) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await pic.locator(`[data-part="${part}"] .sh-pic-hit`).first().click();
    await expect(page.getByTestId(panel).first()).toBeFocused();
    await expect(page.getByTestId(panel).first()).toBeInViewport();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await pic.locator('[data-part="token"] .sh-pic-hit').first().click();
  await expect(page.getByTestId('pool-trade')).toBeInViewport();
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'shots/flap-page-led-to-trade-390.png' });
});
