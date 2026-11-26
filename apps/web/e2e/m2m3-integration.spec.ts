import { expect, test, type Page } from '@playwright/test';
import { goInApp } from './feed-helpers';
import { LEGACY_OFF } from './legacy-off';
import { card, chooseScenario, claimButton, connectAs, evidence, figure, installUntouchableWallet, main, overflow, txPanel, walletTouches } from './m3-helpers';

// M2/M3 integration (SH-012 × SH-014/015): the top-bar wallet button on every route, and the pair detail reward card
// running the same claim flow as /rewards once a demo wallet is connected. Nothing touches `window.ethereum` (UI-09).
// The pair detail and Claims are off in every build since F134 R46B: their old links stay in ROUTES (they now open the
// boxes and My Box), and the tests of their claim flow skip themselves (LEGACY_OFF).

const ORCHARD = '/pair/31337/0x0000000000000000000000000000000000000066';
const SIGNED = ['preparing', 'awaiting_signature', 'submitted', 'pending'];
const ROUTES = [
  '/',
  '/box/31337/0x000000000000000000000000000000000000f17e',
  '/wallet/0xde00000000000000000000000000000000000a11',
  '/my-box',
  '/pairs',
  '/pairs?type=nft_collection',
  '/launch',
  '/rewards',
  '/portfolio',
  '/settings',
  '/about/risks',
  ORCHARD,
  '/pair/31337/0x1234',
  '/pair/31337/0x00000000000000000000000000000000000000ff',
  '/no-such-page',
];

// Element screenshots of tall cards scroll under the sticky top bar; hide it in the evidence images only.
const NO_TOPBAR = '.sh-topbar { visibility: hidden; }';
const topBarWallet = (page: Page) => page.getByRole('banner').getByRole('button', { name: /wallet/i });

async function openNav(page: Page, name: string) {
  const nav = page.getByRole('navigation', { name: 'Primary' });
  const link = nav.getByRole('link', { name, exact: true });
  if (!(await link.isVisible())) await page.getByRole('button', { name: 'Menu' }).click();
  await link.click();
}

/** Claims, Portfolio and the pair feed left the navigation in the launch set: reached in the page, no reload. Launch (box creation, F69 C1) is in it. */
const IN_NAV: ReadonlySet<string> = new Set(['Boxes', 'Launch', 'My Box', 'Settings', 'About & risks']);
async function open(page: Page, name: string, path: string) {
  if (IN_NAV.has(name)) await openNav(page, name);
  else await goInApp(page, path);
}

test('the top bar shows the wallet button on every route: "Connect wallet", a 44px target, closed', async ({ page }) => {
  await installUntouchableWallet(page);
  for (const route of ROUTES) {
    await page.goto(route);
    await expect(page.locator('h1'), route).toBeVisible();
    const button = page.getByRole('banner').getByRole('button', { name: 'Connect wallet', exact: true });
    await expect(button, route).toBeVisible();
    await expect(button, route).toHaveAttribute('aria-expanded', 'false');
    const box = await button.boundingBox();
    expect(box?.height ?? 0, route).toBeGreaterThanOrEqual(44);
    await expect(page.getByRole('dialog'), route).toHaveCount(0);
  }
  expect(await walletTouches(page)).toEqual([]);
});

test('once connected, every route shows the sample wallet ("Wallet", no Demo word) and its short account in the top bar', async ({ page }) => {
  await installUntouchableWallet(page);
  await page.goto('/');
  await connectAs(page, 'Box wallet A', { via: 'banner' });
  for (const [name, path] of [
    ['Launch', '/create/v2-picture'],
    ['Settings', '/settings'],
    ['About & risks', '/about/risks'],
    ['Boxes', '/'],
    ['My Box', '/my-box'],
  ] as const) {
    await open(page, name, path);
    await expect(page).toHaveURL(new RegExp(`${path.replace('/', '\\/')}$`));
    await expect(topBarWallet(page), path).toHaveAccessibleName('Wallet 0xDe00…0A11');
  }
  // A box card opens its page with the connection kept (the pair rows that did this are off, F134 R46B).
  await open(page, 'Boxes', '/');
  await page.getByRole('link', { name: /^The Misfits, FIT/ }).click();
  await expect(page).toHaveURL(/\/box\/31337\/0x0+f17e$/);
  await expect(topBarWallet(page)).toHaveAccessibleName('Wallet 0xDe00…0A11');
  expect(await walletTouches(page)).toEqual([]);
});

test.describe('pair detail reward card: the same claim flow as /rewards', () => {
  test.skip(true, LEGACY_OFF);
  test('disconnected, it keeps the Rewards link and offers only an explicit button', async ({ page }) => {
    await installUntouchableWallet(page);
    await page.goto(ORCHARD);
    const rewards = page.getByRole('region', { name: 'Holder fee share' });
    await expect(rewards.getByRole('link', { name: 'Claim on the Claims page' })).toHaveAttribute('href', '/rewards?pair=31337%3A0x0000000000000000000000000000000000000066');
    const button = rewards.getByRole('button', { name: 'Connect wallet' });
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    expect((await button.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await expect(rewards.locator('article')).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(await walletTouches(page)).toEqual([]);
  });

  test('past holder claims prior earnings from the detail page; only finalized counts; /rewards shows it consumed', async ({ page }, testInfo) => {
    await installUntouchableWallet(page);
    await page.goto(ORCHARD);
    await expect(page.getByRole('heading', { level: 1, name: 'ORCHARD' })).toBeVisible();
    await connectAs(page, 'Past holder');
    const rewards = page.getByRole('region', { name: 'Holder fee share' });
    const heading = rewards.getByRole('heading', { level: 3, name: 'Your claims on ORCHARD' });
    await expect(heading).toBeFocused();
    const claim = rewards.locator('article[data-claim-variant="pair"]');
    await expect(figure(claim, 'claimable')).toHaveText('9.705953 AAPLx-DEMO');
    await expect(claimButton(claim)).toHaveText('Claim 9.705953 AAPLx-DEMO');
    await expect(rewards.getByRole('combobox', { name: 'Scenario', exact: true })).toBeVisible();
    await expect(main(page).getByRole('textbox')).toHaveCount(0);
    await expect(main(page).getByRole('spinbutton')).toHaveCount(0);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await rewards.scrollIntoViewIfNeeded();
    await evidence(page, testInfo, 'M2M3-detail-claim-ready', { locator: rewards, style: NO_TOPBAR });

    await page.evaluate(() => {
      const seen: string[] = [];
      Object.defineProperty(window, '__detailStatuses', { value: seen });
      const push = () => {
        const status = document.querySelector('article[data-claim-variant="pair"] [data-tx-status]')?.getAttribute('data-tx-status') ?? 'idle';
        if (seen[seen.length - 1] !== status) seen.push(status);
      };
      push();
      new MutationObserver(push).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-tx-status'] });
    });
    await claimButton(claim).click();
    const sign = claim.getByRole('button', { name: 'Sign', exact: true });
    await expect(sign).toBeVisible();
    await sign.click();
    await expect(txPanel(claim)).toHaveAttribute('data-tx-status', 'confirmed_unfinalized');
    await expect(figure(claim, 'claimable')).toHaveText('9.705953 AAPLx-DEMO');
    await expect(txPanel(claim)).toHaveAttribute('data-tx-status', 'finalized');
    await expect(figure(claim, 'claimable')).toHaveText('0 AAPLx-DEMO');
    await expect(figure(claim, 'claimed')).toHaveText('9.705953 AAPLx-DEMO');
    await expect(claimButton(claim)).toBeDisabled();
    expect(await page.evaluate(() => [...(window as unknown as { __detailStatuses: string[] }).__detailStatuses])).toEqual([
      'idle',
      ...SIGNED,
      'confirmed_unfinalized',
      'finalized',
    ]);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await evidence(page, testInfo, 'M2M3-detail-claim-finalized', { locator: rewards, style: NO_TOPBAR });

    await rewards.getByRole('link', { name: 'Open in Claims' }).click();
    await expect(page).toHaveURL(/\/rewards\?pair=31337%3A0x0+66$/);
    const listed = main(page).locator('article').first();
    await expect(listed).toHaveAttribute('data-pair-id', '31337:0x0000000000000000000000000000000000000066');
    await expect(figure(listed, 'claimable')).toHaveText('0 AAPLx-DEMO');
    await expect(claimButton(listed)).toHaveText('Nothing claimable yet');
    expect(await walletTouches(page)).toEqual([]);
  });

  test('R=T pair: read-only estimate, minimum and deadline in the detail card; no amount or slippage input', async ({ page }, testInfo) => {
    await page.goto('/pair/31337/0x000000000000000000000000000000000000006a');
    await expect(page.getByRole('heading', { level: 1, name: 'TINY FRAMES' })).toBeVisible();
    await connectAs(page, 'Past holder');
    const rewards = page.getByRole('region', { name: 'Holder fee share' });
    const estimate = rewards.getByTestId('conversion-estimate');
    await expect(estimate).toContainText('≈ 163.149767 FRAME');
    await expect(estimate).toContainText('161.518269 FRAME');
    await expect(estimate).toContainText('25 Sep 2026, 12:20 UTC');
    await expect(main(page).getByRole('textbox')).toHaveCount(0);
    await expect(main(page).getByRole('spinbutton')).toHaveCount(0);
    await expect(main(page).getByRole('slider')).toHaveCount(0);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await rewards.scrollIntoViewIfNeeded();
    await evidence(page, testInfo, 'M2M3-detail-claim-rt', { locator: rewards, style: NO_TOPBAR });
  });
});

test.describe('a signed claim outlives its card (06-ARCHITECTURE; ADR-0008 §4; UI-08)', () => {
  test.skip(true, LEGACY_OFF);
  const REORG = 'Included, reorganised out, included again, finalized';
  const IN_FLIGHT = /submitted|pending|confirmed_unfinalized/;

  test('/rewards persona switch after signing: the sent claim stays tracked, finishes, and is not offered again', async ({ page }, testInfo) => {
    await installUntouchableWallet(page);
    await page.goto('/rewards');
    await connectAs(page, 'Past holder');
    await chooseScenario(page, REORG);
    const orchard = card(page, 'ORCHARD');
    await claimButton(orchard).click();
    await orchard.getByRole('button', { name: 'Sign', exact: true }).click();
    await expect(txPanel(orchard)).toHaveAttribute('data-tx-status', IN_FLIGHT);

    await connectAs(page, 'Current holder', { via: 'banner' });
    const list = page.getByRole('region', { name: 'Your claims' });
    await expect(list.getByTestId('account-bar')).toContainText('Current holder');
    const tracked = page.getByTestId('tracked-claims');
    await expect(tracked.getByRole('heading', { level: 2, name: 'Claims still being tracked' })).toBeVisible();
    await expect(tracked.getByTestId('account-bar')).toContainText('Past holder');
    const sent = tracked.locator('article').filter({ has: page.getByRole('heading', { level: 3, name: /^ORCHARD/ }) });
    await expect(txPanel(sent)).toHaveAttribute('data-tx-status', IN_FLIGHT);
    await expect(claimButton(sent)).toBeDisabled();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await sent.scrollIntoViewIfNeeded();
    await evidence(page, testInfo, 'M2M3-claim-tracked-after-switch', { locator: tracked, style: NO_TOPBAR });
    await expect(txPanel(sent)).toHaveAttribute('data-tx-status', 'finalized', { timeout: 10_000 });
    await expect(figure(sent, 'claimable')).toHaveText('0 AAPLx-DEMO');

    await connectAs(page, 'Past holder', { via: 'banner' });
    await expect(page.getByTestId('tracked-claims')).toHaveCount(0);
    const back = card(page, 'ORCHARD');
    await expect(txPanel(back)).toHaveAttribute('data-tx-status', 'finalized');
    await expect(figure(back, 'claimable')).toHaveText('0 AAPLx-DEMO');
    await expect(claimButton(back)).toHaveText('Nothing claimable yet');
    await expect(claimButton(back)).toBeDisabled();
    expect(await walletTouches(page)).toEqual([]);
  });

  test('/rewards account-data change after signing: the card stays on screen and keeps its request', async ({ page }) => {
    await page.goto('/rewards');
    await connectAs(page, 'Past holder');
    await chooseScenario(page, REORG);
    const orchard = card(page, 'ORCHARD');
    await claimButton(orchard).click();
    await orchard.getByRole('button', { name: 'Sign', exact: true }).click();
    await main(page).getByRole('combobox', { name: 'Account data' }).selectOption({ label: 'Conversion route unavailable (emergency settlement)' });
    await expect(page).toHaveURL(/scenario=conversion_fails/);
    await expect(txPanel(card(page, 'ORCHARD'))).toHaveAttribute('data-tx-status', /submitted|pending|confirmed_unfinalized|finalized/);
    await expect(txPanel(card(page, 'ORCHARD'))).toHaveAttribute('data-tx-status', 'finalized', { timeout: 10_000 });
    await expect(figure(card(page, 'ORCHARD'), 'claimable')).toHaveText('0 AAPLx-DEMO');
  });

  test('signed on the detail page, then navigated to /rewards: the same request is shown there, never a second claim', async ({ page }) => {
    await installUntouchableWallet(page);
    await page.goto(ORCHARD);
    await expect(page.getByRole('heading', { level: 1, name: 'ORCHARD' })).toBeVisible();
    await connectAs(page, 'Past holder');
    const rewards = page.getByRole('region', { name: 'Holder fee share' });
    await rewards.getByRole('combobox', { name: 'Scenario', exact: true }).selectOption({ label: REORG });
    const claim = rewards.locator('article[data-claim-variant="pair"]');
    await claimButton(claim).click();
    await claim.getByRole('button', { name: 'Sign', exact: true }).click();
    await rewards.getByRole('link', { name: 'Open in Claims' }).click();
    await expect(page).toHaveURL(/\/rewards\?pair=/);
    const listed = card(page, 'ORCHARD');
    await expect(txPanel(listed)).toHaveAttribute('data-tx-status', IN_FLIGHT);
    await expect(claimButton(listed)).toHaveText('Claim in progress…');
    await expect(txPanel(listed)).toHaveAttribute('data-tx-status', 'finalized', { timeout: 10_000 });
    await expect(figure(listed, 'claimable')).toHaveText('0 AAPLx-DEMO');
    // And back on the detail page, the result is still there.
    await listed.getByRole('link', { name: 'Pair detail: ORCHARD' }).click();
    await expect(txPanel(page.getByRole('region', { name: 'Holder fee share' }).locator('article[data-claim-variant="pair"]'))).toHaveAttribute('data-tx-status', 'finalized');
    expect(await walletTouches(page)).toEqual([]);
  });

  test('detail card: pressing Claim with the keyboard keeps focus off <body>', async ({ page }) => {
    await page.goto(ORCHARD);
    await expect(page.getByRole('heading', { level: 1, name: 'ORCHARD' })).toBeVisible();
    await connectAs(page, 'Past holder');
    const claim = page.getByRole('region', { name: 'Holder fee share' }).locator('article[data-claim-variant="pair"]');
    const button = claimButton(claim);
    await button.focus();
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
    await expect(button).toBeFocused();
    await expect(claim.getByRole('button', { name: 'Sign', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  });

  test('detail card, R=T: at the quote deadline on the demo clock the estimate is replaced by "No current quote"', async ({ page }, testInfo) => {
    await page.clock.install();
    await page.goto('/pair/31337/0x000000000000000000000000000000000000006a');
    await expect(page.getByRole('heading', { level: 1, name: 'TINY FRAMES' })).toBeVisible();
    await connectAs(page, 'Past holder');
    const rewards = page.getByRole('region', { name: 'Holder fee share' });
    const claim = rewards.locator('article[data-claim-variant="pair"]');
    await expect(claim.getByTestId('conversion-estimate')).toBeVisible();
    await page.clock.fastForward('21:00');
    await expect(claim).toHaveAttribute('data-claim-action', 'needs_quote');
    await expect(claim.getByTestId('conversion-estimate')).toHaveCount(0);
    await expect(claim.getByTestId('needs-quote')).toBeVisible();
    await expect(claimButton(claim)).toBeDisabled();
    await rewards.scrollIntoViewIfNeeded();
    await evidence(page, testInfo, 'M2M3-detail-claim-quote-expired', { locator: rewards, style: NO_TOPBAR });
  });
});
