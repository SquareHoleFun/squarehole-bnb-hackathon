import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

// SH-015 demo wallet (UI-09): the top-bar button is the only way in, nothing prompts on load or navigation, and the demo
// wallet never touches an injected wallet. A fake `window.ethereum` records every READ of the property (not just calls)
// plus any EIP-6963 discovery request, so even probing for a wallet would be caught.

const ROUTES = [
  '/',
  '/box/31337/0x000000000000000000000000000000000000f17e',
  '/box/31337/0x000000000000000000000000000000000000f17e?tab=token',
  '/wallet/0xde00000000000000000000000000000000000a11',
  '/my-box',
  '/pairs',
  '/rewards',
  '/portfolio',
  '/launch',
  '/pair/31337/0x0000000000000000000000000000000000000066',
];

async function installUntouchableWallet(page: Page) {
  await page.addInitScript(() => {
    const touches: string[] = [];
    Object.defineProperty(window, '__walletTouches', { value: touches });
    const provider = new Proxy(
      {},
      {
        get(_target, key) {
          touches.push(`provider.${String(key)}`);
          return () => Promise.reject(new Error('untouchable wallet'));
        },
      },
    );
    Object.defineProperty(window, 'ethereum', {
      configurable: true,
      get() {
        touches.push('window.ethereum');
        return provider;
      },
    });
    window.addEventListener('eip6963:requestProvider', () => touches.push('eip6963:requestProvider'));
  });
}

const touches = (page: Page) => page.evaluate(() => [...(window as unknown as { __walletTouches: string[] }).__walletTouches]);
const walletButton = (page: Page) => page.getByRole('banner').locator('.sh-wallet-button');
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function evidence(page: Page, testInfo: TestInfo, name: string) {
  const file =
    process.env.SH_EVIDENCE_SCREENSHOTS === '1'
      ? fileURLToPath(new URL(`../../../docs/evidence/screenshots/SH-015-${name}-${testInfo.project.name}.png`, import.meta.url))
      : testInfo.outputPath(`SH-015-${name}-${testInfo.project.name}.png`);
  await page.screenshot({ path: file });
}

test('UI-09: loading and navigating every route leaves the injected wallet untouched and opens nothing', async ({ page }) => {
  await installUntouchableWallet(page);
  let dialogs = 0;
  page.on('dialog', (dialog) => {
    dialogs += 1;
    void dialog.dismiss();
  });
  for (const route of ROUTES) {
    await page.goto(route);
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.getByRole('banner').getByRole('button', { name: 'Connect wallet' })).toBeVisible();
    await expect(walletButton(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  // Client-side navigation too (no reloads): a box card, then the navigation.
  await page.goto('/');
  await page.getByRole('link', { name: /^The Misfits, FIT/ }).click();
  await expect(page).toHaveURL(/\/box\/31337\/0x0+f17e$/);
  await expect(page.getByRole('heading', { level: 1, name: 'The Misfits' })).toBeVisible();
  const menu = page.getByRole('button', { name: 'Menu' });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  expect(await touches(page)).toEqual([]);
  expect(dialogs).toBe(0);
});

test('the sample wallet connects, simulates a wrong network and disconnects without ever touching window.ethereum', async ({ page }, testInfo) => {
  await installUntouchableWallet(page);
  await page.goto('/');
  await expect(page.getByText('6 boxes')).toBeVisible();

  const button = page.getByRole('banner').getByRole('button', { name: 'Connect wallet' });
  const box = await button.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  await button.click();

  const dialog = page.getByRole('dialog', { name: 'Sample wallet' });
  await expect(dialog).toBeVisible();
  // Never held and the box mock-up's two wallets (A during the curve, B after graduation); the old pairs' holders are
  // not offered (SH-V2-FE11).
  await expect(dialog.getByRole('radio')).toHaveCount(3);
  await expect(dialog.getByRole('radio', { name: 'Never held' })).toBeFocused();
  await expect(dialog.getByRole('radio', { name: 'Current holder' })).toHaveCount(0);
  await expect(dialog.getByRole('radio', { name: 'Past holder' })).toHaveCount(0);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  // The window's top is on screen (a taller-than-screen window scrolls downwards, never off the top).
  expect((await dialog.boundingBox())?.y ?? -1).toBeGreaterThanOrEqual(0);
  await evidence(page, testInfo, 'dialog');

  await dialog.getByRole('radio', { name: 'Box wallet B' }).check();
  await dialog.getByRole('button', { name: 'Connect sample wallet' }).click();
  await expect(dialog).toHaveCount(0);
  const connected = page.getByRole('banner').getByRole('button', { name: 'Wallet 0xdE00…0B22', exact: true });
  await expect(connected).toBeVisible();
  await expect(connected).toBeFocused();
  await evidence(page, testInfo, 'connected');

  await connected.click();
  await page.getByRole('dialog').getByRole('checkbox', { name: 'Simulate wrong network' }).check();
  await page.getByRole('dialog').getByRole('button', { name: 'Update sample wallet' }).click();
  await expect(page.getByRole('banner').getByRole('button', { name: 'Wallet 0xdE00…0B22, wrong network' })).toBeVisible();
  await evidence(page, testInfo, 'wrong-network');

  await page.getByRole('banner').getByRole('button', { name: /^Wallet 0x/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByRole('banner').getByRole('button', { name: 'Connect wallet' })).toBeVisible();

  // A reload starts disconnected again: nothing reconnects by itself.
  await page.reload();
  await expect(page.getByRole('banner').getByRole('button', { name: 'Connect wallet' })).toBeVisible();
  await page.waitForTimeout(300);
  expect(await touches(page)).toEqual([]);
});

test('keyboard: the wallet window opens with Enter, traps Tab, closes with Escape and returns focus', async ({ page }) => {
  await installUntouchableWallet(page);
  await page.goto('/about/risks');
  await expect(page.locator('h1')).toBeVisible();
  const button = page.getByRole('banner').getByRole('button', { name: 'Connect wallet' });
  await button.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Sample wallet' });
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(button).toBeFocused();
  expect(await touches(page)).toEqual([]);
});
