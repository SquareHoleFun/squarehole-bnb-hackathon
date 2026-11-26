import { expect, test, type Page } from '@playwright/test';
import { noTradingActions, notTheErrorPage } from './box-helpers';

// M1 no-trade audit (UI-01, UI-09, EXT-01, EXT-04, FEED-08): every route, at both viewports, has no buy/sell/swap
// control, no amount or number input, no iframe, and browsing never asks a wallet for anything. The first handoff's
// pages are off in every build since F134 R46B: their old links stay in ROUTES (they open the boxes and My Box), and
// browsing is audited on the box feed.

const ORCHARD = '0x0000000000000000000000000000000000000066';
const ROUTES = [
  '/',
  '/?state=bonding&view=list',
  '/box/31337/0x000000000000000000000000000000000000f17e',
  '/box/31337/0x000000000000000000000000000000000000f17e?tab=owning',
  '/box/31337/0x000000000000000000000000000000000000f17e?tab=about',
  '/box/31337/0x000000000000000000000000000000000000f17e?scenario=window',
  '/box/31337/0x000000000000000000000000000000000000f17e?scenario=migrated&tab=owning',
  '/box/31337/0xde00700000000000000000000000000000000003',
  '/box/31337/0xde00700000000000000000000000000000000005',
  '/wallet/0xde00000000000000000000000000000000000b22',
  '/my-box',
  '/pairs',
  '/pairs?type=nft_collection',
  '/launch',
  '/create/basics',
  '/create/contents',
  '/create/kind',
  '/create/raise',
  '/create/launch',
  '/create/overview',
  '/create/price',
  '/create/review',
  // SH-251: the visual Create (the picture way), under the same check as the steps.
  '/create/v2-picture',
  '/rewards',
  '/portfolio',
  '/collections',
  '/settings',
  '/about/risks',
  '/about/terms',
  '/about/privacy',
  `/pair/31337/${ORCHARD}`,
  '/box/31337/0x000000000000000000000000000000000000f17e?tab=token',
  '/box/31337/0x000000000000000000000000000000000000f17e?scenario=window&tab=token',
  '/misfits',
  '/fit-pair',
  '/fit-pair?scenario=window',
  '/fit-pair?scenario=migrated',
  '/swap',
  '/trade',
];

/** A fake injected wallet that records every call, so a request made by browsing would be caught. */
async function installWalletProbe(page: Page) {
  await page.addInitScript(() => {
    const calls: unknown[] = [];
    Object.defineProperty(window, '__walletCalls', { value: calls });
    const record = (method: string) => (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.reject(new Error('audit wallet: no requests expected'));
    };
    Object.defineProperty(window, 'ethereum', {
      value: { isMetaMask: true, request: record('request'), send: record('send'), sendAsync: record('sendAsync'), enable: record('enable') },
    });
  });
}

const walletCalls = (page: Page) => page.evaluate(() => (window as unknown as { __walletCalls: unknown[] }).__walletCalls.length);

async function auditPage(page: Page, route: string) {
  await expect(page.locator('h1')).toBeVisible();
  // SH-254: Launch's visual way is audited once drawn, never on its loading line.
  if (new URL(page.url()).pathname === '/create/v2-picture') await expect(page.locator('.sh-newbox[data-step] svg.sh-pic [data-part]'), route).toHaveCount(10);
  await noTradingActions(page, route);
  await expect(page.getByRole('spinbutton'), route).toHaveCount(0);
  await expect(page.locator('input[type="number"], iframe, frame, embed, object'), route).toHaveCount(0);
}

test('every route: no trading controls, amount inputs, number inputs or iframes', async ({ page }) => {
  await installWalletProbe(page);
  for (const route of ROUTES) {
    await page.goto(route);
    await auditPage(page, route);
  }
  expect(await walletCalls(page)).toBe(0);
});

test('/swap and /trade are not pages', async ({ page }) => {
  for (const route of ['/swap', '/trade']) {
    await page.goto(route);
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' }), route).toBeVisible();
  }
});

test('browsing, searching, filtering and opening boxes never requests the wallet (EXT-04, FEED-08, UI-09)', async ({ page }) => {
  await installWalletProbe(page);
  await page.goto('/');
  await expect(page.getByText('6 boxes')).toBeVisible();
  const cards = page.getByRole('list', { name: 'Boxes' }).getByRole('link');
  const search = page.getByRole('searchbox', { name: 'Search boxes, tokens or a wallet' });
  await search.fill('pots');
  await expect(cards).toHaveCount(1);
  await search.fill('');
  await expect(cards).toHaveCount(6);
  await page.getByRole('group', { name: 'State' }).getByRole('button', { name: /^Bonding/ }).click();
  await page.getByLabel('Sort').selectOption('progress');
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'List' }).click();
  await expect(page).toHaveURL(/\/\?state=bonding&sort=progress&view=list$/);
  await auditPage(page, 'box feed, filtered list');
  await page.getByRole('group', { name: 'State' }).getByRole('button', { name: /^All/ }).click();
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Grid' }).click();
  await cards.filter({ hasText: 'Clay Pots' }).first().click();
  await expect(page).toHaveURL(/\/box\/31337\/0x/);
  await auditPage(page, 'box after click');
  await page.goBack();
  await expect(page.getByRole('list', { name: 'Boxes' })).toBeVisible();
  expect(await walletCalls(page)).toBe(0);
});

// M2/M3 integration: the same audit with a CONNECTED demo wallet. A connection lives in memory only, so the routes are
// reached by client-side navigation (a reload would disconnect). The demo wallet never touches `window.ethereum`.

async function openNav(page: Page, name: string) {
  const nav = page.getByRole('navigation', { name: 'Primary' });
  const link = nav.getByRole('link', { name, exact: true });
  if (!(await link.isVisible())) await page.getByRole('button', { name: 'Menu' }).click();
  await link.click();
}

async function connectDemoWallet(page: Page, persona: 'Box wallet A' | 'Box wallet B') {
  await page.getByRole('banner').getByRole('button', { name: 'Connect wallet' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sample wallet' });
  await dialog.getByRole('radio', { name: persona }).check();
  await dialog.getByRole('button', { name: 'Connect sample wallet' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('banner').getByRole('button', { name: /^Wallet 0x/ })).toBeVisible();
}

/** SH-254: a connected page is audited only once it is shown as itself, never as the error page. */
async function auditConnected(page: Page, route: string) {
  await auditPage(page, route);
  await notTheErrorPage(page, route);
}

// The sample wallet's box wallets (SH-V2-FE11: the old pairs' holders are no longer offered).
for (const persona of ['Box wallet A', 'Box wallet B'] as const) {
  test(`connected demo wallet (${persona}): My Box, /launch, /settings and a box page stay free of trading controls`, async ({ page }) => {
    await installWalletProbe(page);
    await page.goto('/');
    await expect(page.getByText('6 boxes')).toBeVisible();
    await connectDemoWallet(page, persona);
    await openNav(page, 'My Box');
    await expect(page).toHaveURL(/\/my-box$/);
    await auditConnected(page, `/my-box (${persona})`);

    for (const [name, path] of [
      // SH-254: Launch opens the visual way (the default).
      ['Launch', '/create/v2-picture'],
      ['Settings', '/settings'],
    ] as const) {
      await openNav(page, name);
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await auditConnected(page, `${path} (${persona})`);
      await expect(page.getByRole('banner').getByRole('button', { name: /^Wallet 0x/ }), path).toBeVisible();
    }
    // Claims, Portfolio and the pair detail (with its claim card), audited here before, are off (F134 R46B): their old
    // links open My Box, connected, with nothing to trade.
    await page.evaluate(() => {
      window.history.pushState(window.history.state, '', '/rewards');
      window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
    });
    await expect(page).toHaveURL(/\/my-box$/);
    await auditConnected(page, `/rewards → /my-box (${persona})`);
    await openNav(page, 'Boxes');
    await page.getByRole('link', { name: /^The Misfits, FIT/ }).click();
    await expect(page).toHaveURL(/\/box\/31337\/0x0+f17e$/);
    await auditConnected(page, `box 0 (${persona})`);
    await expect(page.getByRole('banner').getByRole('button', { name: /^Wallet 0x/ })).toBeVisible();
    expect(await walletCalls(page)).toBe(0);
  });
}
