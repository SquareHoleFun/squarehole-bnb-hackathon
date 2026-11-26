import { expect, test, type Page } from '@playwright/test';
import { evidence, installUntouchableWallet, noTradingControls, WALLET_B, walletTouches } from './box-helpers';

// Wallets as boxes (SH-BOX-UI-launch; F46; BOX-INTERFACE § 4) on the Demo data: `/wallet/<address>` for any address,
// view only; `/my-box` for the connected account, which never opens a wallet by itself; "My Box" in the navigation
// only once a wallet is connected (by an explicit click); nothing signed, no totals, no USD.

const header = (page: Page) => page.locator('header.sh-box-head');
const nav = (page: Page) => page.getByRole('navigation', { name: 'Primary' });

async function openMenuIfCompact(page: Page) {
  const menu = page.getByRole('button', { name: 'Menu' });
  if (await menu.isVisible()) await menu.click();
}

async function connectAs(page: Page, persona: 'Box wallet A' | 'Box wallet B' | 'Never held') {
  await page.getByRole('banner').getByRole('button', { name: /wallet/i }).click();
  const dialog = page.getByRole('dialog', { name: 'Sample wallet' });
  await dialog.getByRole('radio', { name: persona }).check();
  await dialog.getByRole('button', { name: /^(Connect|Update) sample wallet$/ }).click();
  await expect(dialog).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await installUntouchableWallet(page);
});

test('a disconnected /my-box explains how to connect and opens nothing; My Box is not in the navigation', async ({ page }) => {
  await page.goto('/my-box');
  await expect(page.getByRole('heading', { level: 1, name: 'My Box' })).toBeVisible();
  await expect(page.getByText('Connect a wallet (top right) to see your box. Nothing opens by itself.')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('banner').getByRole('button', { name: 'Connect wallet' })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#primary-nav a')).toHaveText(['Boxes', 'Launch', 'Settings', 'About & risks']);
  await page.waitForTimeout(300);
  expect(await walletTouches(page)).toEqual([]);
});

test('connecting by an explicit click puts My Box in the navigation; persona A during the curve, B after graduation', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByText('6 boxes')).toBeVisible();
  await connectAs(page, 'Box wallet A');
  await openMenuIfCompact(page);
  await nav(page).getByRole('link', { name: 'My Box' }).click();
  await expect(page).toHaveURL(/\/my-box$/);
  await expect(page.getByRole('heading', { level: 1, name: 'My Box' })).toBeVisible();
  await expect(header(page)).not.toContainText('View only');
  await expect(header(page)).toContainText('During the curve');
  await expect(header(page)).not.toContainText(/demo/i);
  await expect(header(page).locator('.sh-box-stat')).toHaveText(['Boxes2', 'Items2', 'Claims readyNot built yet']);
  const misfits = page.getByRole('region', { name: 'The Misfits' });
  await expect(misfits).toContainText('1.25M FIT');
  await expect(misfits).toContainText('2 sealed');
  await expect(page.getByRole('region', { name: 'Clay Pots' })).toContainText('40K POTS');
  await expect(page.getByText('Other assets not shown')).toBeVisible();
  await noTradingControls(page);
  await evidence(page, testInfo, 'my-box-a');

  // The wallet window offers "Open My Box" once connected; persona B after graduation.
  await connectAs(page, 'Box wallet B');
  await expect(page.getByRole('region', { name: 'The Misfits' })).toContainText('3 Misfits');
  await expect(page.getByRole('region', { name: 'Toy Trains' })).toContainText('4 toy blocks');
  // Its own wallet: the companion's slot asks to choose one of its Misfits (the copy follows what the wallet holds).
  await expect(header(page).locator('.sh-box-shell__slot')).toBeVisible();
  await page.getByRole('tab', { name: 'Companion' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Choose one of your 3 Misfits' })).toBeVisible();
  await page.getByRole('tab', { name: 'What’s in the box?' }).click();
  await page.getByRole('region', { name: 'The Misfits' }).getByRole('link', { name: 'Open box' }).click();
  await expect(page).toHaveURL(/\/box\/31337\/0x0+f17e\?scenario=migrated$/);
  await expect(page.locator('header.sh-box-head .sh-box-band__label')).toHaveText('Graduated');
  await page.getByRole('banner').getByRole('button', { name: /^Wallet 0x/ }).click();
  await page.getByRole('dialog').getByRole('link', { name: 'Open My Box' }).click();
  await expect(page).toHaveURL(/\/my-box$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await walletTouches(page)).toEqual([]);
});

test('/wallet/<address> from the search is view only; an older persona’s own box is empty, never 0 for unread', async ({ page }, testInfo) => {
  await page.goto(`/?q=${WALLET_B}`);
  await page.getByRole('link', { name: 'Wallet 0xde00…0b22, 7 items from 2 boxes, View only' }).click();
  await expect(page).toHaveURL(new RegExp(`/wallet/${WALLET_B}$`));
  // The name, the address once (on the Copy line), "View only".
  await expect(page.getByRole('heading', { level: 1, name: 'Wallet' })).toBeVisible();
  await expect(header(page).getByText('0xde00…0b22')).toHaveCount(1);
  await expect(header(page)).toContainText('View only');
  await expect(header(page)).toContainText('After graduation');
  // Revealed Misfits are items (Demo example art), never the sealed box.
  const misfits = page.getByRole('region', { name: 'The Misfits' });
  await expect(misfits.locator('.sh-box-mosaic img')).toHaveCount(3);
  await expect(misfits).toContainText('Example art');
  await expect(misfits).not.toContainText(/demo/i);
  await expect(misfits.locator('img[src*="cover-misfits"], img[src*="sealed-"]')).toHaveCount(0);
  await page.getByRole('tab', { name: 'About' }).click();
  await expect(page.getByText('None. Different assets are never added up.')).toBeVisible();
  await evidence(page, testInfo, 'wallet-b-view-only');

  // An older persona has no box in the Demo: its My Box is empty, with counts of 0 (read, not missing).
  await connectAs(page, 'Never held');
  await expect(header(page)).toContainText('View only');
  await openMenuIfCompact(page);
  await nav(page).getByRole('link', { name: 'My Box' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'My Box' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Nothing from supported boxes' })).toBeVisible();
  await expect(header(page).locator('.sh-box-stat')).toHaveText(['Boxes0', 'Items0', 'Claims readyNot built yet']);
  expect(await walletTouches(page)).toEqual([]);
});
