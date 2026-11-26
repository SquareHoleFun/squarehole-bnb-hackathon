import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import { TRADE_SLOT_MARKER } from '../../production-check';
import { installUntouchableWallet, walletTouches } from '../box-helpers';
import { productionChain } from './production-fixture';
import { PRODUCTION_INDEXER } from './production-origin';
import { productionTarget } from './production-target';

/**
 * SH-246 (finding 11.3) on the production build (playwright.production.config.ts, with a recorded v2 box): on the
 * Sepolia test site (`SH_TARGET=sepolia`) a v2 box page whose trade slot's script fails to load says "This part of the
 * page hit a problem." with Reload where the slot would be; the rest of the page stays; Reload loads the page again and
 * the slot shows. On the main site there is no slot and no such line. On either target (review M1): the front page with
 * box 0's feed refused and the v2 box listed, then Retry while box 0's feed hangs: the v2 card keeps its figures. SH246_SHOTS=<folder> writes the pictures there as
 * <name>-<project>.png (the desktop project at 1280 px, the phone at 390 px); otherwise the test output folder.
 */
const SEPOLIA = productionTarget() === 'sepolia';

test.beforeEach(async ({ page }, info) => {
  await installUntouchableWallet(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1280, height: 900 });
});

async function shot(page: Page, info: TestInfo, name: string, fullPage = false) {
  const folder = process.env.SH246_SHOTS;
  const path = folder ? fileURLToPath(new URL(`${name}-${info.project.name}.png`, `file://${folder.replace(/\/?$/, '/')}`)) : info.outputPath(`${name}.png`);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path, fullPage, scale: 'css' });
}

/** The trade folders' chunk (the one script holding the slot's marker): refused while `blocked()` says so. */
async function blockTradeChunk(page: Page, blocked: () => boolean): Promise<string[]> {
  const refused: string[] = [];
  await page.route(/^http:\/\/127\.0\.0\.1:\d+\/assets\/.+\.js$/, async (route: Route) => {
    const response = await route.fetch();
    const body = await response.text();
    if (blocked() && body.includes(TRADE_SLOT_MARKER)) {
      refused.push(new URL(route.request().url()).pathname);
      return route.abort('connectionrefused');
    }
    return route.fulfill({ response, body });
  });
  return refused;
}

test('a v2 box page whose trade slot did not load: one line and Reload in its place on the Sepolia test site; nothing on the main site', async ({ page }, info) => {
  const chain = await productionChain(page);
  let blocked = true;
  const refused = await blockTradeChunk(page, () => blocked);
  await page.goto(`/box/11155111/${chain.tokens.v2}`);
  const header = page.locator('header.sh-bpic-head');
  await expect(header.getByRole('heading', { level: 1 })).toBeVisible();
  const aside = page.locator('.sh-v2-top__aside');
  if (!SEPOLIA) {
    await page.waitForTimeout(2_000);
    await expect(page.locator('[data-part="failed"]')).toHaveCount(0);
    expect(refused).toEqual([]);
    expect(chain.escaped).toEqual([]);
    return;
  }
  const failed = aside.locator('[data-part="failed"]');
  await expect(failed.getByRole('status')).toHaveText('This part of the page hit a problem.', { timeout: 30_000 });
  await expect(failed.getByRole('button', { name: 'Reload' })).toBeVisible();
  expect(refused).toHaveLength(1);
  // The rest of the page stays: its header, the market and the live trades.
  await expect(header).toBeVisible();
  await expect(page.locator('.sh-v2-top__market')).toBeVisible();
  await failed.scrollIntoViewIfNeeded();
  await shot(page, info, 'box-trade-failed');
  blocked = false;
  await failed.getByRole('button', { name: 'Reload' }).click();
  await expect(header.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.sh-v2-top__aside .sh-trade-box')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-part="failed"]')).toHaveCount(0);
  expect(await walletTouches(page)).toEqual([]);
  expect(chain.escaped).toEqual([]);
});

test('the front page during a Retry of box 0’s feed: the v2 card keeps its figures while box 0’s feed reads again', async ({ page }, info) => {
  test.setTimeout(120_000);
  const chain = await productionChain(page);
  let v1: 'refuse' | 'hang' = 'refuse';
  await page.route(`${PRODUCTION_INDEXER}/v1/feed*`, (route) => {
    if (route.request().method() === 'OPTIONS') return route.fallback();
    // A request left unanswered: the page's own deadline ends it, then its chain read (reverted here) fails it again.
    return v1 === 'refuse' ? route.abort('connectionrefused') : new Promise<void>(() => undefined);
  });
  await page.goto('/');
  const card = page.locator(`a[href="/box/11155111/${chain.tokens.v2}"]`).first();
  await expect(card).toBeVisible();
  const partial = page.locator('[data-feed="partial"]');
  await expect(partial.getByRole('status')).toHaveText('Some boxes may be missing from this list.', { timeout: 60_000 });
  // The card's own reads first: its price coin is its short address until the coin's symbol is read (price-coin.ts,
  // F123). A reference taken before that read differs from the later labels for that reason alone: in a gate of
  // 24 November 2026 the symbol arrived 2 ms after the reference, and the comparison below failed on the coin's name.
  await expect(card).not.toHaveAttribute('aria-label', /0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}/);
  const before = await card.getAttribute('aria-label');
  expect(before).not.toMatch(/Unavailable/);
  v1 = 'hang';
  await partial.getByRole('button', { name: 'Retry' }).click();
  await expect(partial).toHaveCount(0);
  await shot(page, info, 'feed-during-retry');
  for (let i = 0; i < 8; i += 1) {
    expect(await card.getAttribute('aria-label')).toBe(before);
    await page.waitForTimeout(500);
  }
  expect(chain.escaped).toEqual([]);
});
