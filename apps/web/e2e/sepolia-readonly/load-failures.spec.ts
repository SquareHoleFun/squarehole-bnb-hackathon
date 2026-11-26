import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import { TRADE_SLOT_MARKER } from '../../production-check';
import { installUntouchableWallet, walletTouches } from '../box-helpers';
import { API, BOX0_PATH, sepoliaSite } from './sepolia-fixture';

/**
 * SH-246 (findings 11.3 and 11.4) on the Sepolia test site as the server builds it (playwright.sepolia-readonly.config.ts:
 * the five settings of infra/server/app/build.mjs), its indexer answered inside the browser (sepolia-fixture.ts).
 * - The v2 feed fails while box 0's feed answers: box 0 is listed with "Some boxes may be missing from this list." and
 *   Retry; Retry reads the v2 feed again and the line goes. Both feeds fail: "The boxes did not load." with Retry,
 *   never "No boxes yet.".
 * - The setup step's script fails to load for an approved tester not set up yet (our server's `/alpha/me` answered
 *   here): "The setup step hit a problem." with Reload above the page; Reload loads the page again and the step shows.
 * - A wallet page while the v2 feed fails: its Claims tab says "Not available" and "Claims did not load." with Retry
 *   (before: "Claims are not built yet.").
 * SH246_SHOTS=<folder> writes each picture there as <name>-<project>.png (the desktop project at 1280 px, the phone at
 * 390 px); otherwise the test output folder.
 */

test.beforeEach(async ({ page }, info) => {
  await installUntouchableWallet(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1280, height: 900 });
});

async function shot(page: Page, info: TestInfo, name: string) {
  const folder = process.env.SH246_SHOTS;
  const path = folder ? fileURLToPath(new URL(`${name}-${info.project.name}.png`, `file://${folder.replace(/\/?$/, '/')}`)) : info.outputPath(`${name}.png`);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path, fullPage: false, scale: 'css' });
}

/** Fails a feed of the indexer (connection refused, as a server that is down) while `failing()` says so. */
async function failFeed(page: Page, path: '/v1/feed' | '/v2/feed', failing: () => boolean) {
  await page.route(`${API}${path}*`, (route) => (failing() && route.request().method() !== 'OPTIONS' ? route.abort('connectionrefused') : route.fallback()));
}

const box0Card = (page: Page) => page.locator(`a[href="${BOX0_PATH}"]`).first();
const partial = (page: Page) => page.locator('[data-feed="partial"]');

test('the v2 feed fails while box 0’s answers: box 0 with "Some boxes may be missing from this list." and Retry; Retry reads it again', async ({ page }, info) => {
  const site = await sepoliaSite(page);
  let failing = true;
  await failFeed(page, '/v2/feed', () => failing);
  await page.goto('/');
  await expect(box0Card(page)).toBeVisible();
  await expect(partial(page).getByRole('status')).toHaveText('Some boxes may be missing from this list.', { timeout: 30_000 });
  await expect(partial(page).getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(page.locator('.sh-box-empty')).toHaveCount(0);
  await expect(page.getByRole('main')).not.toContainText(/No boxes yet|V2 data unavailable|Failed to fetch/);
  await shot(page, info, 'feed-v2-failed');
  failing = false;
  await partial(page).getByRole('button', { name: 'Retry' }).click();
  await expect(partial(page)).toHaveCount(0, { timeout: 30_000 });
  await expect(box0Card(page)).toBeVisible();
  expect(site.asked.filter((path) => path.startsWith('/v2/feed')).length).toBeGreaterThan(0);
  expect(await walletTouches(page)).toEqual([]);
  expect(site.escaped).toEqual([]);
});

test('both feeds fail: "The boxes did not load." with Retry, never "No boxes yet."', async ({ page }, info) => {
  test.setTimeout(90_000);
  const site = await sepoliaSite(page);
  await failFeed(page, '/v1/feed', () => true);
  await failFeed(page, '/v2/feed', () => true);
  await page.goto('/');
  const empty = page.locator('.sh-box-empty');
  // Box 0's feed falls back to reading the chain (the fixture's RPC reverts every view), so it fails last.
  await expect(empty.locator('p').first()).toHaveText('The boxes did not load.', { timeout: 60_000 });
  await expect(empty.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(page.getByRole('main')).not.toContainText(/No boxes yet|could not be read|V2 data unavailable/);
  // No count and no state chips above a list that did not load (review M3).
  await expect(page.locator('.sh-box-feed__count')).toHaveText('');
  await expect(page.getByRole('group', { name: 'State' })).toHaveCount(0);
  await shot(page, info, 'feed-both-failed');
  expect(await walletTouches(page)).toEqual([]);
  expect(site.escaped).toEqual([]);
});

/**
 * The trade folders' chunk (the one script that holds the slot's marker): refused while `blocked()` says so, as a
 * dropped connection or a file a site update removed would be; every other script as served.
 */
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

test('the setup step’s script fails to load for a tester it is for: "The setup step hit a problem." with Reload; Reload shows the step', async ({ page }, info) => {
  await sepoliaSite(page);
  // Our server's answer for an approved tester not set up yet: the step has something to offer.
  await page.route(/^http:\/\/127\.0\.0\.1:\d+\/alpha\/me$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'approved', handle: 'tester', claim: null }) }));
  let blocked = true;
  const refused = await blockTradeChunk(page, () => blocked);
  await page.goto('/');
  await expect(box0Card(page)).toBeVisible();
  const failed = page.locator('main > [data-part="failed"]');
  await expect(failed.getByRole('status')).toHaveText('The setup step hit a problem.', { timeout: 30_000 });
  await expect(failed.getByRole('button', { name: 'Reload' })).toBeVisible();
  expect(refused).toHaveLength(1);
  // The page under it stays.
  await expect(page.getByRole('heading', { level: 1, name: 'Boxes' })).toBeVisible();
  await shot(page, info, 'setup-step-failed');
  blocked = false;
  await failed.getByRole('button', { name: 'Reload' }).click();
  await expect(page.locator('.sh-welcome')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-part="failed"]')).toHaveCount(0);
  expect(await walletTouches(page)).toEqual([]);
});

test('a visitor the setup step has nothing for: no line, even with its script refused', async ({ page }) => {
  await sepoliaSite(page);
  const refused = await blockTradeChunk(page, () => true);
  await page.goto('/');
  await expect(box0Card(page)).toBeVisible();
  await page.waitForTimeout(2_000);
  await expect(page.locator('[data-part="failed"]')).toHaveCount(0);
  // The step's script was never asked for: nothing failed that a visitor would miss.
  expect(refused).toEqual([]);
});

test('a wallet page while the v2 feed fails: Claims "Not available", "Claims did not load." and Retry; Retry reads it again', async ({ page }, info) => {
  const site = await sepoliaSite(page);
  let failing = true;
  await failFeed(page, '/v2/feed', () => failing);
  await page.goto(`/wallet/0x${'ab'.repeat(20)}?tab=claims`);
  const claims = page.locator('[data-claims="unread"]');
  await expect(claims.getByRole('status')).toHaveText('Claims did not load.', { timeout: 30_000 });
  await expect(page.locator('.sh-box-lead h2')).toHaveText('Not available');
  await expect(page.locator('.sh-box-stat').filter({ hasText: 'Claims ready' })).toContainText('Not available');
  await expect(page.getByRole('main')).not.toContainText(/not built yet|V2 data unavailable/i);
  await shot(page, info, 'wallet-claims-failed');
  failing = false;
  await claims.getByRole('button', { name: 'Retry' }).click();
  // The v2 feed answers (the recorded one lists no box): the line goes, the tab keeps its earlier words.
  await expect(page.locator('[data-claims="unread"]')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator('.sh-box-lead h2')).not.toHaveText('Not available');
  expect(await walletTouches(page)).toEqual([]);
  expect(site.escaped).toEqual([]);
});
