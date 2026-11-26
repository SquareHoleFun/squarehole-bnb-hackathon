import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { installUntouchableWallet, walletTouches } from '../box-helpers';
import { BOX0_COVER, BOX0_COVER_CID, BOX0_COVER_SHA256, BOX0_LOGO_CID, BOX0_LOGO_SHA256, BOX0_PATH, FIXTURE, sepoliaSite, shotPath, type SepoliaSite, type ShotTicket } from './sepolia-fixture';

/**
 * SH-TA-12: the Sepolia test site as it ships, read only, on the committed manifest (playwright.sepolia-readonly.config.ts):
 * box 0 on the feed and on its page with its numbers, the v2 side with nothing in it yet (no error words, a short empty
 * state when no box is listed at all), Create offering ETH as the price coin, the legal links on the test network
 * notice, and no wallet request on any navigation. SH-TA-26 and SH-BOX0-ART-TEST-SITE: box 0's two pictures (the FIT
 * icon as its logo, an SVG our node never serves, and the Misfits collection picture) come from the app's own bundle
 * and show only once their bytes hash to the spec's commitment; nothing is asked of the node for them.
 */

test.beforeEach(async ({ page }) => {
  await installUntouchableWallet(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

async function shot(page: Page, info: TestInfo, ticket: ShotTicket, name: string) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path: shotPath(info, ticket, name), fullPage: true, scale: 'css' });
}

/** Nothing asked a wallet and nothing left the machine but the indexer, our node and the keyless RPCs, all answered. */
async function quiet(page: Page, site: SepoliaSite) {
  expect(await walletTouches(page)).toEqual([]);
  expect(site.escaped).toEqual([]);
}

const box0Card = (page: Page) => page.locator(`a[href="${BOX0_PATH}"]`).first();

test('the feed: box 0 with its numbers from the indexer, FDV, price, burned and items; nothing from v2 and no error words', async ({ page }, info) => {
  const site = await sepoliaSite(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Boxes' })).toBeVisible();
  const card = box0Card(page);
  await expect(card).toBeVisible();
  await expect(card.locator('.sh-box-card__figure')).toHaveText('FDV 2.05 ETH');
  await expect(card.locator('.sh-v2-card-stats__label')).toHaveText(['Price', 'Burned']);
  await expect(card.locator('.sh-v2-card-stats__value')).toHaveText(['0.0020649', '2.56M']);
  await expect(card).toContainText('4,269 Misfits');
  expect(await card.getAttribute('aria-label')).toMatch(/^Rehearsal Collection 2, RHT3, .*Graduated, FDV 2\.05 ETH, Price 0\.0020649, Burned 2\.56M, 4,269 Misfits, Sepolia testnet, Featured$/);
  await expect(page.locator('.sh-box-card__notice')).toHaveCount(0);
  await expect(page.getByRole('main')).not.toContainText(/unavailable|could not be read|Stale|Unverified/i);
  await expect(page.locator('.sh-source-badge')).toHaveAttribute('data-source', 'sepolia');
  await shot(page, info, 'SH-TA-12', 'feed');
  expect(site.asked).toEqual(expect.arrayContaining(['/v1/feed?chain=11155111', '/v2/feed?chain=11155111']));
  await quiet(page, site);
});

test('box 0’s page: price, FDV, burned and items in its header, the graduation line, the contracts by role', async ({ page }, info) => {
  const site = await sepoliaSite(page);
  await page.goto('/');
  await box0Card(page).click();
  await expect(page).toHaveURL(new RegExp(`${BOX0_PATH}$`));
  const header = page.locator('header.sh-box-head');
  await expect(header).toBeVisible();
  await expect(header.getByRole('heading', { level: 1 })).toHaveText('Rehearsal Collection 2');
  const stats = header.locator('.sh-box-stat');
  await expect(stats.locator('dt')).toHaveText(['Price', 'FDV', 'Burned', 'Items']);
  await expect(stats.locator('dd')).toContainText(['0.0020649', '2.05', '2.56M', '4,269']);
  await expect(header).toContainText('Graduated at block 11,966,812');
  await expect(page.getByRole('main')).not.toContainText(/could not be read|Stale|Unverified/i);
  await shot(page, info, 'SH-TA-12', 'box0');
  await page.getByRole('tab', { name: 'Token' }).click();
  await expect(page.locator('[data-card="core-contracts"]')).toContainText('0xaC0B…D396');
  await expect(page.locator('[data-card="core-fees"]')).toContainText('Fees so far: 0.0005 ETH');
  expect(site.asked).toEqual(expect.arrayContaining([`/v1/boxes/11155111/${BOX0_PATH.split('/').at(-1)}`]));
  await quiet(page, site);
});

test('the empty v2 side: a short line when the indexer lists no box at all, never an error or a zero', async ({ page }, info) => {
  // The recorded v2 feed is the real one (no box in the v2 registry today); the v1 feed is emptied for this variant.
  const v1 = FIXTURE.answers['/v1/feed'] as Record<string, unknown>;
  const site = await sepoliaSite(page, { answers: { '/v1/feed': { ...v1, cards: [] } } });
  expect((FIXTURE.answers['/v2/feed'] as { cards: unknown[] }).cards).toEqual([]);
  await page.goto('/');
  const empty = page.locator('.sh-box-empty');
  await expect(empty).toHaveText('No boxes yet.');
  await expect(page.getByRole('link', { name: 'Launch a box' })).toBeVisible();
  await expect(page.getByRole('main')).not.toContainText(/unavailable|could not be read|in this build/i);
  await shot(page, info, 'SH-TA-12', 'feed-empty');
  await quiet(page, site);
});

test('Create’s first step offers ETH, the native listing 0, as the price coin', async ({ page }, info) => {
  const site = await sepoliaSite(page);
  await page.goto('/');
  await page.getByRole('link', { name: 'Launch a box' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Launch a box' })).toBeVisible();
  // SH-254: Launch opens the visual way; the steps' first page is one press away.
  await expect(page).toHaveURL(/\/create\/v2-picture$/);
  await page.getByRole('navigation', { name: 'Launch' }).getByRole('link', { name: 'Steps' }).click();
  await expect(page).toHaveURL(/\/create\/v2-basics$/);
  await expect(page.getByRole('main')).not.toContainText(/Price coins unavailable|No price coins/);
  await expect(page.getByRole('radio', { name: /^ETH\b/ }).first()).toBeAttached();
  await shot(page, info, 'SH-TA-12', 'create');
  expect(site.asked).toContain('/v2/listings/11155111/0x5d2866ef084d801ae734d3a2a6e4f7179898737c');
  await quiet(page, site);
});

test('the legal links open the test network notice', async ({ page }) => {
  const site = await sepoliaSite(page);
  await page.goto(BOX0_PATH);
  await expect(page.locator('header.sh-box-head')).toBeVisible();
  const links = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/about/terms"], a[href*="/about/privacy"]'), (a) => [a.innerText.trim(), a.getAttribute('href')]));
  expect(links.length).toBeGreaterThan(0);
  for (const [text, href] of links) expect([text, href]).toEqual(['Test network notice', '/about/terms']);
  await page.getByRole('link', { name: 'Test network notice' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Test network notice' })).toBeVisible();
  await expect(page.getByRole('main')).toContainText('It runs on the Sepolia test network only.');
  await quiet(page, site);
});

/** The sha256 of the bytes an <img> draws (its blob or data URL, read inside the page). */
async function drawnSha256(page: Page, img: ReturnType<Page['locator']>): Promise<string> {
  const src = (await img.getAttribute('src')) ?? '';
  return page.evaluate(async (url) => {
    const bytes = await (await fetch(url)).arrayBuffer();
    return `0x${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  }, src);
}

/**
 * Box 0’s real pictures where `scope` shows them: drawn, decoded, and the exact committed bytes. SH-BOX-PICTURE-FIT:
 * the feed card (a card slot) shows the collection cover and its coin the logo. SH-223: box 0 is the Genesis box, so
 * the big picture of its page’s header is the collection cover too (picture-slot.ts `headerSlot`), not the logo; the
 * header has no token coin (its token mark is for token-only boxes, HeaderSide.tsx).
 */
async function realPictures(page: Page, scope: ReturnType<Page['locator']>, place: 'card' | 'header' = 'card') {
  const card = place === 'card';
  const frame = scope.locator('.sh-box-cover').first();
  await expect(frame).toHaveAttribute('data-art', 'image');
  await expect(frame).toHaveAttribute('data-slot', 'card');
  await expect(frame).toHaveAttribute('data-picture', 'cover');
  const frameImg = frame.locator('img');
  const logoImg = scope.locator('img.sh-box-coin--logo').first();
  if (card) await expect(logoImg).toBeAttached();
  for (const img of card ? [frameImg, logoImg] : [frameImg]) {
    await expect(img).toHaveAttribute('src', /^blob:/);
    await expect.poll(() => img.evaluate(async (node: HTMLImageElement) => {
      try { await node.decode(); } catch { return 0; }
      return node.naturalWidth;
    })).toBeGreaterThan(0);
  }
  expect(await drawnSha256(page, frameImg)).toBe(BOX0_COVER_SHA256);
  if (card) expect(await drawnSha256(page, logoImg)).toBe(BOX0_LOGO_SHA256);
}

test.describe('SH-TA-26, SH-BOX0-ART-TEST-SITE: box 0’s real pictures', () => {
  test('the feed shows box 0’s logo (the FIT icon) and collection cover from the app’s bundle, its page’s header the collection cover: the committed bytes; the node is not asked', async ({ page }, info) => {
    const site = await sepoliaSite(page);
    await page.goto('/');
    await realPictures(page, box0Card(page));
    await shot(page, info, 'SH-BOX0-ART-TEST-SITE', 'feed');
    // SH-223: the List row of box 0 (the Genesis box) shows the collection cover too, not the logo.
    await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'List' }).click();
    const thumb = page.locator('.sh-box-table').getByRole('link', { name: /^Rehearsal Collection 2,/ }).locator('.sh-box-table__thumb');
    await expect(thumb).toHaveAttribute('data-slot', 'card');
    await expect(thumb).toHaveAttribute('data-picture', 'cover');
    await expect(thumb.locator('img')).toHaveAttribute('src', /^blob:/);
    expect(await drawnSha256(page, thumb.locator('img'))).toBe(BOX0_COVER_SHA256);
    await page.goto(BOX0_PATH);
    await realPictures(page, page.locator('header.sh-box-head'), 'header');
    await shot(page, info, 'SH-BOX0-ART-TEST-SITE', 'box0');
    expect(site.pictures).toEqual([]);
    await quiet(page, site);
  });

  test('whatever the node holds for box 0’s CIDs is never drawn: the bundle’s committed bytes show', async ({ page }) => {
    const wrong = BOX0_COVER.slice();
    wrong[wrong.length - 20] = (wrong[wrong.length - 20] ?? 0) ^ 0xff;
    const site = await sepoliaSite(page, { pictures: new Map([[BOX0_COVER_CID, wrong], [BOX0_LOGO_CID, wrong]]) });
    await page.goto('/');
    await realPictures(page, box0Card(page));
    await page.goto(BOX0_PATH);
    await realPictures(page, page.locator('header.sh-box-head'), 'header');
    expect(site.pictures).toEqual([]);
    await quiet(page, site);
  });
});
