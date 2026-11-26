import { expect, test } from '@playwright/test';
import { evidence, installUntouchableWallet, noTradingControls, overflow, WALLET_A, walletTouches } from './box-helpers';

// The feed of boxes (home, SH-BOX-UI-launch; F46; BOX-INTERFACE § 3) on the Demo data at 1440×900 and 390×844: the
// Misfits pinned first, the five Demo boxes taped "Demo", state chips with counts, one sort, search by name, ticker and
// wallet, Grid and List; nothing asks a wallet for anything and nothing scrolls sideways.

const cards = (page: import('@playwright/test').Page) => page.getByRole('list', { name: 'Boxes' }).getByRole('link');

test.beforeEach(async ({ page }) => {
  await installUntouchableWallet(page);
});

test('the Misfits come first (Featured), the five sample boxes carry no Demo tape or word (F130), no wallet is touched', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Boxes' })).toBeVisible();
  await expect(page.getByText('6 boxes')).toBeVisible();
  // The live curve's first block has arrived: the Misfits card names its state.
  await expect(cards(page).first()).toHaveAccessibleName(/^The Misfits, FIT, Genesis box, Bonding, \d+\.\d% · [\d.]+ \/ 4\.206980085 ETH, 4,269 Misfits, Local chain 31337, Featured$/);
  const names = await cards(page).evaluateAll((links) => links.map((link) => (link.getAttribute('aria-label') ?? '').split(',')[0]));
  expect(names).toEqual(['The Misfits', 'Paper Kites', 'Pocket Stamps', 'Toy Trains', 'Clay Pots', 'Tin Cans']);
  for (const label of await cards(page).evaluateAll((links) => links.map((link) => link.getAttribute('aria-label') ?? ''))) expect(label).not.toMatch(/demo/i);
  await expect(page.locator('.sh-box-tape')).toHaveCount(0);
  await expect(page.locator('.sh-box-card--featured .sh-box-featured')).toHaveText('Featured');
  // Ordinary family avatars only (F47): the Misfits card shows six, at least 32 px, cropped to the character.
  await expect(page.locator('.sh-box-card__avatars img')).toHaveCount(6);
  for (const size of await page.locator('.sh-box-card__avatars .sh-box-avatar').evaluateAll((avatars) => avatars.map((avatar) => avatar.getBoundingClientRect().width))) expect(size).toBeGreaterThanOrEqual(32);
  // The Demo data is current: no card says Stale or Unverified.
  await expect(page.locator('.sh-box-card__notice')).toHaveCount(0);
  await noTradingControls(page);
  await evidence(page, testInfo, 'feed');
  await page.waitForTimeout(300);
  expect(await walletTouches(page)).toEqual([]);
});

test('state chips count and filter; the sort is in the URL; the List view reads the same boxes', async ({ page }) => {
  await page.goto('/');
  const chips = page.getByRole('group', { name: 'State' });
  await expect(chips.getByRole('button')).toHaveText(['All 6', 'Upcoming 1', 'Launch window 0', 'Bonding 3', 'Graduating 0', 'Graduated 1', 'Failed 1']);
  await chips.getByRole('button', { name: /^Failed/ }).click();
  await expect(page).toHaveURL(/\/\?state=failed$/);
  await expect(chips.getByRole('button', { name: /^Failed/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toHaveAccessibleName(/^Tin Cans, TINS, New collection, Failed, Refunds open/);
  // The count follows the filter and is announced (a polite live region).
  await expect(page.getByRole('status').filter({ hasText: 'of 6 boxes' })).toHaveText('1 of 6 boxes');
  await chips.getByRole('button', { name: /^All/ }).click();
  await page.getByLabel('Sort').selectOption('progress');
  await expect(page).toHaveURL(/\/\?sort=progress$/);
  await page.getByLabel('Sort').selectOption('mcap');
  // Every Demo box is paired with ETH (F74 U5: one raise; another Q's "ETH equivalent" is open, S12): no per-asset note.
  await expect(page.getByText('Sorted within each pair asset')).toHaveCount(0);
  await expect(page.getByRole('option', { name: '24h volume · not yet' })).toBeDisabled();
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'List' }).click();
  await expect(page).toHaveURL(/\/\?sort=mcap&view=list$/);
  const table = page.getByRole('table');
  await expect(table.getByRole('row')).toHaveCount(7);
  // Back restores the grid.
  await page.goBack();
  await expect(page.getByRole('list', { name: 'Boxes' })).toBeVisible();
});

test('search by name, ticker, address and wallet: a full address that is no box opens that wallet, view only', async ({ page }) => {
  await page.goto('/');
  const search = page.getByRole('searchbox', { name: 'Search boxes, tokens or a wallet' });
  await search.fill('kites');
  await expect(cards(page)).toHaveCount(1);
  await search.fill('choo');
  await expect(cards(page).first()).toHaveAccessibleName(/^Toy Trains/);
  await search.fill('0xde007');
  await expect(cards(page)).toHaveCount(5);
  // The short form a card's address shows, and the last four digits.
  await search.fill('0x0000…f17e');
  await expect(cards(page)).toHaveCount(1);
  await search.fill('0003');
  await expect(cards(page).first()).toHaveAccessibleName(/^Toy Trains/);
  await search.fill('nothing like this');
  await expect(page.getByText('No boxes match.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear search and state' }).click();
  await expect(search).toBeFocused();
  await expect(cards(page)).toHaveCount(6);
  await search.fill(WALLET_A);
  // A wallet is a box: a card of the same shape, what it holds, "View only"; the state chips (all 0) step aside.
  const wallet = page.getByRole('list', { name: 'Wallet' }).getByRole('link', { name: 'Wallet 0xde00…0a11, 2 items from 2 boxes, View only' });
  await expect(wallet).toBeVisible();
  await expect(wallet.locator('.sh-box-shell')).toBeVisible();
  await expect(page.getByRole('group', { name: 'State' })).toBeHidden();
  await wallet.click();
  await expect(page).toHaveURL(new RegExp(`/wallet/${WALLET_A}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Wallet' })).toBeVisible();
  expect(await walletTouches(page)).toEqual([]);
});

test('an old pair-feed link opens the box feed with its search: the pair feed is off in every build (F134 R46B)', async ({ page }) => {
  await page.goto('/?q=orch&type=token');
  await expect(page).toHaveURL(/\/\?q=orch$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Boxes' })).toBeVisible();
  await expect(page.getByRole('main')).not.toContainText(/-DEMO\b|ORCHARD/);
});

test('a card opens its box page, and the chips scroll inside their row on a phone without page overflow', async ({ page }, testInfo) => {
  await page.goto('/');
  if (testInfo.project.name === 'mobile') {
    const row = page.getByRole('group', { name: 'State' });
    const scroll = await row.evaluate((element) => element.scrollWidth > element.clientWidth);
    expect(scroll).toBe(true);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    // Two columns of cards.
    const boxes = await page.locator('.sh-box-grid > li:not(.sh-box-card--featured)').evaluateAll((items) => items.slice(0, 2).map((item) => Math.round(item.getBoundingClientRect().top)));
    expect(boxes[0]).toBe(boxes[1]);
  }
  await cards(page).nth(3).click();
  await expect(page).toHaveURL(/\/box\/31337\/0xde00700000000000000000000000000000000003$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Toy Trains' })).toBeVisible();
});
