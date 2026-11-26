import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { installWalletSpy } from './acceptance/helpers';
import { horizontalOverflow, pid, row, trackErrors } from './feed-helpers';

// SH-012 read-only pair detail + SH-013 external destinations and navigation (UI-01, UI-02, FEED-07, FEED-08,
// EXT-01..04, EXT-06..08). Both projects: desktop 1440×900 and mobile 390×844.

interface FixturePair {
  pairId: string;
  name: string;
  type: string;
  token: { address: string };
  quote: { address: string };
  mirrorAddress?: string;
}
const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../packages/providers/src/fixtures/feed.json', import.meta.url)), 'utf8'),
) as { items: FixturePair[] };
const PAIRS = fixture.items;
const FIXTURE_ADDRESSES = [
  ...new Set(
    PAIRS.flatMap((pair) => [pair.token.address, pair.quote.address, pair.mirrorAddress ?? '', pair.pairId.split(':')[1] ?? ''])
      .filter(Boolean)
      .map((address) => address.toLowerCase()),
  ),
];
const path = (suffix: string) => `/pair/31337/0x${suffix.padStart(40, '0')}`;
const ORCHARD = path('66');
const FORBIDDEN_NAME = /\b(buy|sell|swap)\b|\bamount\b/i;

async function openDetail(page: Page, url: string, name: string) {
  await page.goto(url);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

/** Scrolls through the page so lazy images load, then waits until every image has decoded. */
async function loadAllImages(page: Page) {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < height; y += 500) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(30);
  }
  // Rendered images only: a lazy image inside the closed compact menu (display: none) is never requested.
  await page.waitForFunction(() =>
    [...document.images].filter((img) => img.getClientRects().length > 0).every((img) => img.complete && img.naturalWidth > 0),
  );
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function hrefs(page: Page): Promise<string[]> {
  return page.locator('a[href]').evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
}

test('ORCHARD detail renders every section without overflow or console errors', async ({ page }) => {
  const errors = trackErrors(page);
  await openDetail(page, ORCHARD, 'ORCHARD');
  for (const name of ['Price USD per ORCH', 'Trade externally', 'Holder fee share', 'Supply', 'Collection gallery', 'Activity', 'About ORCHARD']) {
    await expect(page.getByRole('region', { name, exact: true }), name).toBeVisible();
  }
  const header = page.locator('header.sh-pair-head');
  for (const text of ['NFT collection', 'Not an approved factory', 'Showcase concept', 'Paired with AAPLx-DEMO', 'Holder fee share paid in AAPLx-DEMO', 'Local chain 31337']) {
    await expect(header, text).toContainText(text);
  }
  await expect(page.getByRole('region', { name: 'Supply' })).toContainText('1 NFT = 1 ORCH');
  // Three days of observed history: 24H and All only, never 7D or 30D (FEED-10); the gap is drawn.
  await expect(page.getByRole('group', { name: 'Chart timeframe' }).getByRole('button')).toHaveText(['24H', 'All']);
  await expect(page.locator('text.sh-chart__gap-label')).toHaveText('No observation');
  await expect(page.getByRole('region', { name: 'Trade externally' })).toContainText(
    'Draft policy: 3% target · native T fees burned · realized Q split 1/3 protocol : 2/3 holders',
  );
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await loadAllImages(page);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

test('every demo pair: no trading surface, no external href, fixture addresses only in internal routes (EXT-01, EXT-08)', async ({ page }) => {
  for (const pair of PAIRS) {
    const suffix = pair.pairId.slice(-2);
    await openDetail(page, path(suffix), pair.name);
    for (const role of ['button', 'link', 'textbox', 'spinbutton', 'combobox', 'slider', 'tab'] as const) {
      await expect(page.getByRole(role, { name: FORBIDDEN_NAME }), `${pair.name}: ${role}`).toHaveCount(0);
    }
    await expect(page.locator('input, textarea, select, iframe, frame, object, embed, form'), pair.name).toHaveCount(0);
    const all = await hrefs(page);
    expect(all.filter((href) => /^(https?:|\/\/|javascript:|data:|mailto:)/i.test(href)), pair.name).toEqual([]);
    const carrying = all.filter((href) => FIXTURE_ADDRESSES.some((address) => href.toLowerCase().includes(address)));
    expect(carrying, pair.name).toEqual([`/rewards?pair=31337%3A${pair.pairId.split(':')[1]}`]);
    const card = page.getByRole('region', { name: 'Trade externally' });
    await expect(card.getByRole('link'), pair.name).toHaveCount(0);
    await expect(card.getByRole('listitem').filter({ hasText: 'Route unverified' }), pair.name).toHaveCount(3);
    expect(await horizontalOverflow(page), pair.name).toBeLessThanOrEqual(0);
  }
});

test('gallery images load lazily with the metadata name as alt text', async ({ page }) => {
  await openDetail(page, ORCHARD, 'ORCHARD');
  const gallery = page.getByRole('region', { name: 'Collection gallery' });
  const images = gallery.locator('img');
  await expect(images).toHaveCount(4);
  expect(await images.evaluateAll((els) => els.map((img) => img.getAttribute('loading')))).toEqual(['lazy', 'lazy', 'lazy', 'lazy']);
  await gallery.scrollIntoViewIfNeeded();
  await expect
    .poll(() => images.evaluateAll((els) => els.every((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0)))
    .toBe(true);
  expect(await images.evaluateAll((els) => els.map((img) => img.getAttribute('alt')))).toEqual(['ORCHARD #7', 'ORCHARD #12', 'ORCHARD #31', 'ORCHARD #44']);
  await expect(gallery.getByRole('img', { name: 'ORCHARD #58: artwork unavailable' })).toBeVisible();
  await expect(gallery).toContainText('Sunglasses');
});

test('copy actions put exact addresses on the clipboard and never touch the wallet (EXT-04, UI-09)', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const calls = await installWalletSpy(page);
  await openDetail(page, ORCHARD, 'ORCHARD');
  const cases: [string, string][] = [
    ['Copy token address', '0x00000000000000000000000000000000000003ea'],
    ['Copy NFT mirror address', '0x00000000000000000000000000000000000007d2'],
    ['Copy ORCH (T) address', '0x00000000000000000000000000000000000003ea'],
    ['Copy AAPLx-DEMO (Q) address', '0x0000000000000000000000000000000000002329'],
  ];
  for (const [name, address] of cases) {
    const button = page.getByRole('button', { name, exact: true });
    await button.click();
    await expect(button).toContainText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText()), name).toBe(address);
  }
  expect(calls()).toEqual([]);
});

test('browsing from the feed into detail, using every control and returning makes no wallet request (FEED-08)', async ({ page }) => {
  const calls = await installWalletSpy(page);
  let dialogs = 0;
  page.on('dialog', (dialog) => {
    dialogs += 1;
    void dialog.dismiss();
  });
  await page.goto('/pairs');
  await expect(page.getByRole('status')).toHaveText('11 pairs');
  await row(page, '66').getByRole('link', { name: /^ORCHARD/ }).click();
  await expect(page).toHaveURL(new RegExp(`${ORCHARD}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'ORCHARD' })).toBeFocused();
  for (const button of await page.getByRole('main').getByRole('button').all()) {
    await button.click();
    // Since M2/M3 integration the reward card has an explicit "Connect wallet" button. Clicking it opens only the demo
    // wallet window (no injected-wallet call, checked below); close it so the remaining controls can be used.
    const demoWallet = page.getByRole('dialog', { name: 'Sample wallet' });
    if (await demoWallet.isVisible()) {
      await page.keyboard.press('Escape');
      await expect(demoWallet).toHaveCount(0);
      await expect(button).toBeFocused();
    }
  }
  await page.getByText('Observations as a table').click();
  for (const item of await page.getByRole('region', { name: 'Trade externally' }).getByRole('listitem').all()) await item.click();
  await page.goBack();
  await expect(page.locator(`[data-pair-id="${pid('66')}"]`)).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { level: 1, name: 'ORCHARD' })).toBeVisible();
  await page.getByRole('link', { name: 'Claim on the Claims page' }).click();
  await expect(page).toHaveURL(/\/rewards\?pair=31337%3A0x0{38}66$/);
  await page.waitForTimeout(300);
  expect(calls()).toEqual([]);
  expect(dialogs).toBe(0);
});

test('keyboard: every control is reachable in order, timeframes toggle with Enter and Space, focus stays visible', async ({ page }) => {
  await openDetail(page, ORCHARD, 'ORCHARD');
  // Tab from the top of the document (skip link, top bar, navigation) into the page content.
  for (let i = 0; i < 30; i += 1) {
    await page.keyboard.press('Tab');
    if (await page.evaluate(() => Boolean(document.activeElement?.closest('main')))) break;
  }
  const seen: string[] = [];
  for (let i = 0; i < 40; i += 1) {
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || !el.closest('main')) return null;
      const style = getComputedStyle(el);
      return { name: el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '', outline: style.outlineStyle };
    });
    if (info === null) break;
    expect(info.outline, info.name).not.toBe('none');
    seen.push(info.name);
    await page.keyboard.press('Tab');
  }
  const order = (name: string) => seen.findIndex((entry) => entry.startsWith(name));
  for (const name of ['Feed', 'Copy token address', 'Copy NFT mirror address', 'Last 24 hours', 'All observed history', 'Observations as a table', 'Copy ORCH (T) address', 'Copy AAPLx-DEMO (Q) address', 'Claim on the Claims page', 'How data sources and external routes work']) {
    expect(order(name), `${name} in ${JSON.stringify(seen)}`).toBeGreaterThanOrEqual(0);
  }
  expect(seen[0]).toBe('Feed');
  expect(order('Copy token address')).toBeLessThan(order('Last 24 hours'));
  expect(order('Observations as a table')).toBeLessThan(order('Copy ORCH (T) address'));
  expect(order('Claim on the Claims page')).toBeLessThan(order('How data sources and external routes work'));

  const day = page.getByRole('button', { name: 'Last 24 hours' });
  const all = page.getByRole('button', { name: 'All observed history' });
  await day.focus();
  await page.keyboard.press('Enter');
  await expect(day).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: 'Price USD per ORCH' }).locator('text.sh-chart__gap-label')).toHaveCount(0);
  await all.focus();
  await page.keyboard.press('Space');
  await expect(all).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: 'Price USD per ORCH' }).locator('text.sh-chart__gap-label')).toHaveCount(1);
});

test('touch targets: controls in the detail are at least 44px tall, copy buttons through their hit area', async ({ page }) => {
  await openDetail(page, ORCHARD, 'ORCHARD');
  for (const locator of [
    page.locator('.sh-pair-back__link'),
    page.getByRole('button', { name: 'Last 24 hours' }),
    page.getByRole('link', { name: 'Claim on the Claims page' }),
    page.locator('.sh-chart__table summary'),
  ]) {
    const box = await locator.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  const hits = await page.locator('.sh-copy__button').evaluateAll((buttons) =>
    buttons.map((button) => {
      button.scrollIntoView({ block: 'center' });
      const box = button.getBoundingClientRect();
      const x = box.left + box.width / 2;
      return [-21, 21].every((dy) => button.contains(document.elementFromPoint(x, box.top + box.height / 2 + dy)));
    }),
  );
  expect(hits).toEqual(hits.map(() => true));
});

test('token pair: no NFT concepts, no gallery, honest empty chart', async ({ page }) => {
  await openDetail(page, path('67'), 'ROUND TRIP');
  await expect(page.getByRole('region', { name: 'Collection gallery' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Supply' })).not.toContainText('Whole-NFT capacity');
  await expect(page.getByText('Before you trade externally')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Price USD per ROUND' })).toContainText('No observed price history in this snapshot');
  await expect(page.getByRole('group', { name: 'Chart timeframe' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Holder fee share' })).toContainText('Holder fee share paid in ROUND, converted from credited WETH-DEMO');
});

test('not found and invalid pair routes never guess a pair', async ({ page }) => {
  await page.goto(path('99'));
  await expect(page.getByRole('heading', { level: 1, name: 'Pair not found' })).toBeVisible();
  await expect(page.getByRole('main')).toContainText('31337:0x0000000000000000000000000000000000000099');
  for (const [url, reason] of [
    ['/pair/1/0x0000000000000000000000000000000000000066', 'only shows pairs on local chain 31337'],
    ['/pair/31337/0x66', 'not 0x followed by 40 hexadecimal characters'],
    ['/pair/abc/0x0000000000000000000000000000000000000066', 'not a positive whole number'],
  ] as const) {
    await page.goto(url);
    await expect(page.getByRole('heading', { level: 1, name: 'Not a valid pair address' }), url).toBeVisible();
    await expect(page.getByRole('main'), url).toContainText(reason);
  }
  await page.goto(`${ORCHARD}?scenario=unavailable`);
  await expect(page.getByRole('heading', { level: 1, name: 'Pair unavailable' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('/about/risks: the sample data’s status, the core v2 cards with their details closed, no overflow (SH-V2-FE7)', async ({ page }) => {
  const errors = trackErrors(page);
  await openDetail(page, '/about/risks', 'About & risks');
  await expect(page.locator('.sh-risks__status')).toContainText('No outside audit');
  await expect(page.locator('.sh-risks__status')).toContainText('Claim only');
  for (const name of ['What’s a box', 'Curve & graduation', 'Fees & payouts', 'Failure & claim', 'Coins, stocks & gold', 'Box 0 · The Misfits', 'More risks', 'No trading here', 'Terms']) {
    await expect(page.getByRole('region', { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('table')).toHaveCount(0);
  const failure = page.getByRole('region', { name: 'Failure & claim' });
  await expect(failure.getByText('Claims never close.')).toBeHidden();
  await failure.locator('summary').click();
  // RC5-A (F136): claims never close, and what nobody can claim stays locked; no year and no sweep to FIT.
  await expect(failure.getByText('Claims never close. Money that reaches the box later goes to the claims made after it.')).toBeVisible();
  await expect(failure.getByText('The share of coins nobody hands in stays locked for good, and so does money arriving after the last claim. Nobody can take it out, Square Hole included.')).toBeVisible();
  await expect(failure.getByText(/one year|Rest to FIT/i)).toHaveCount(0);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  expect((await hrefs(page)).filter((href) => /^(https?:|\/\/)/i.test(href))).toEqual([]);
  expect(errors).toEqual([]);
});

// Evidence: fixed demo time, reduced motion. SH_M2_SCREENSHOTS=1 refreshes docs/evidence/screenshots/M2-*.png; an
// ordinary run writes to the test output folder.
test.describe('M2 detail evidence screenshots', () => {
  const target = (name: string) =>
    process.env.SH_M2_SCREENSHOTS === '1'
      ? fileURLToPath(new URL(`../../../docs/evidence/screenshots/${name}`, import.meta.url))
      : test.info().outputPath(name);

  for (const [name, url, heading, mobile] of [
    ['M2-detail-orchard-desktop.png', ORCHARD, 'ORCHARD', false],
    ['M2-detail-orchard-mobile.png', ORCHARD, 'ORCHARD', true],
    ['M2-detail-token.png', path('67'), 'ROUND TRIP', false],
    ['M2-about-risks.png', '/about/risks', 'About & risks', false],
  ] as const) {
    test(name, async ({ page, isMobile }) => {
      test.skip(isMobile !== mobile, mobile ? 'captured in the mobile project' : 'captured in the desktop project');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await openDetail(page, url, heading);
      await page.waitForLoadState('networkidle');
      await loadAllImages(page);
      await page.screenshot({ path: target(name), fullPage: true, scale: 'css' });
    });
  }
});
