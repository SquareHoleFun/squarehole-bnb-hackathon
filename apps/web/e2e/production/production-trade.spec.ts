import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { TRADE_PATTERN, TRADE_SLOT_MARKER } from '../../production-check';
import { installUntouchableWallet, walletTouches } from '../box-helpers';
import { productionChain } from './production-fixture';
import { productionTarget } from './production-target';

/**
 * F156 (SH-ALPHA-BUILD-SWITCH): the trade switch in the browser, on the build the caller's target names (`pnpm
 * check:production` for the main site, `SH_TARGET=sepolia pnpm check:production` for the test site). production-check.ts
 * proves where the trade markers sit in the files; this file proves what a visitor's browser loads. The main site loads
 * no page, script or style that holds one, on the feed or on a v2 box page. The Sepolia test site loads none at first
 * paint, and its trade slot's chunk only once a v2 box page mounts the slot: lazily, after the page's own chunk.
 */
const SEPOLIA = productionTarget() === 'sepolia';

interface Loaded {
  readonly path: string;
  /** The trade markers its body holds (null until the body is read). */
  markers: string[] | null;
}

/** Every page, script and style the page loads from the preview server, in the order they answered. */
function recordLoads(page: Page): { readonly files: Loaded[]; readonly settled: () => Promise<void> } {
  const files: Loaded[] = [];
  const reading: Promise<void>[] = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.hostname !== '127.0.0.1' || (response.request().resourceType() !== 'document' && !/\.(?:m?js|css)$/.test(url.pathname))) return;
    const entry: Loaded = { path: url.pathname, markers: null };
    files.push(entry);
    reading.push(response.text().then(
      (text) => { entry.markers = [...text.matchAll(new RegExp(TRADE_PATTERN.source, TRADE_PATTERN.flags))].map((match) => match[0]); },
      () => { entry.markers = ['(body unreadable)']; },
    ));
  });
  return { files, settled: async () => { await Promise.all(reading); } };
}

/**
 * Until no page, script or style has arrived for a second (the indexer's polls are not counted), then every body read.
 * A slot's chunk is asked for as the box page renders, so a second of quiet after that is ample for one to show.
 */
async function quiet(loads: ReturnType<typeof recordLoads>): Promise<void> {
  let seen = -1;
  let since = Date.now();
  await expect.poll(() => {
    if (loads.files.length !== seen) {
      seen = loads.files.length;
      since = Date.now();
    }
    return Date.now() - since >= 1_000;
  }, { timeout: 15_000, intervals: [100] }).toBe(true);
  await loads.settled();
}

const marked = (files: readonly Loaded[]): string[] => files.filter((file) => (file.markers ?? []).length > 0).map((file) => file.path);
const slotFiles = (files: readonly Loaded[]): string[] => files.filter((file) => (file.markers ?? []).some((found) => found.toLowerCase() === TRADE_SLOT_MARKER)).map((file) => file.path);

test.beforeEach(async ({ page }) => {
  await installUntouchableWallet(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

test('the feed: the first paint loads no trade code, on either target', async ({ page }) => {
  const chain = await productionChain(page);
  const loads = recordLoads(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Boxes' })).toBeVisible();
  await expect(page.locator(`a[href="/box/11155111/${chain.tokens.v2}"]`).first()).toBeVisible();
  await quiet(loads);
  // The page, its entry and what the entry imports, the feed's own chunk: none holds a trade marker.
  expect(loads.files.filter((file) => file.path.endsWith('.js')).length).toBeGreaterThan(3);
  expect(marked(loads.files)).toEqual([]);
  expect(await walletTouches(page)).toEqual([]);
  expect(chain.escaped).toEqual([]);
});

test('a v2 box page: no trade code on the main site; on the Sepolia test site the slot’s own chunk, loaded lazily', async ({ page }) => {
  const chain = await productionChain(page);
  const loads = recordLoads(page);
  await page.goto('/');
  await expect(page.locator(`a[href="/box/11155111/${chain.tokens.v2}"]`).first()).toBeVisible();
  await quiet(loads);
  const firstPaint = loads.files.map((file) => file.path);
  expect(marked(loads.files)).toEqual([]);
  await page.locator(`a[href="/box/11155111/${chain.tokens.v2}"]`).first().click();
  await expect(page).toHaveURL(new RegExp(`/box/11155111/${chain.tokens.v2}$`));
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('main h2').first()).toBeVisible();
  await quiet(loads);
  const order = loads.files.map((file) => file.path);
  const boxPage = order.findIndex((path) => /^\/assets\/BoxPage-[^/]+\.js$/.test(path));
  expect(boxPage, order.join('\n')).toBeGreaterThan(firstPaint.length - 1);
  if (SEPOLIA) {
    const slot = slotFiles(loads.files);
    expect(slot).toHaveLength(1);
    const [chunk] = slot as [string];
    expect(chunk).toMatch(/^\/assets\/[^/]+\.js$/);
    // Not part of the first paint (the page, the entry and its static imports), and asked for after the box page's chunk.
    expect(firstPaint).not.toContain(chunk);
    expect(order.indexOf(chunk)).toBeGreaterThan(boxPage);
    // Every trade marker the browser met sits in that chunk alone.
    expect(marked(loads.files)).toEqual([chunk]);
  } else {
    expect(slotFiles(loads.files)).toEqual([]);
    expect(marked(loads.files)).toEqual([]);
  }
  expect(await walletTouches(page)).toEqual([]);
  expect(chain.escaped).toEqual([]);
});

/**
 * SH-ALPHA-TEST-COINS: the trade folders' second door, the test-coin page's route. On the Sepolia test site it opens
 * the slot's own chunk, lazily (one trade chunk for both doors), and says one line: "not live yet" while the coin
 * record (read here as data, packages/chain/src/trade-sepolia/coin-deployment.json) is predicted, then the wallet's
 * press. Neither reads the chain or asks the wallet anything. On the main site the route does not exist: the page is the
 * site's "Page not found", with no trade code anywhere.
 */
const COIN_RECORD = JSON.parse(readFileSync(new URL('../../../../packages/chain/src/trade-sepolia/coin-deployment.json', import.meta.url), 'utf8')) as { status: string };
test('the test-coin page: on the Sepolia test site the slot’s one lazy chunk; on the main site no such page', async ({ page }) => {
  const chain = await productionChain(page);
  const loads = recordLoads(page);
  // Every JSON-RPC call the page makes, to any endpoint: none is expected here.
  const rpcCalls: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    try { const body = request.postDataJSON() as unknown; for (const call of Array.isArray(body) ? body : [body]) if (call && typeof call === 'object' && 'jsonrpc' in call) rpcCalls.push(String((call as { method?: unknown }).method)); } catch { /* not JSON */ }
  });
  await page.goto('/test-coins');
  if (SEPOLIA) {
    await expect(page.getByRole('heading', { level: 1, name: 'Test coins' })).toBeVisible();
    const line = COIN_RECORD.status === 'deployed' ? 'Connect a wallet to see your test coins.' : 'Test coins are not live yet.';
    await expect(page.getByRole('region', { name: 'Test coins' }).getByText(line, { exact: true })).toBeVisible();
    await quiet(loads);
    const slot = slotFiles(loads.files);
    expect(slot).toHaveLength(1);
    const [chunk] = slot as [string];
    expect(chunk).toMatch(/^\/assets\/[^/]+\.js$/);
    expect(marked(loads.files)).toEqual([chunk]);
  } else {
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    await quiet(loads);
    expect(slotFiles(loads.files)).toEqual([]);
    expect(marked(loads.files)).toEqual([]);
  }
  expect(rpcCalls).toEqual([]);
  expect(await walletTouches(page)).toEqual([]);
  expect(chain.escaped).toEqual([]);
});
