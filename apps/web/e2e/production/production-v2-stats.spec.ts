import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { recordedStatisticsV2 } from '../../src/features/core/v2/test-support/statistics-v2';
import { installUntouchableWallet, walletTouches } from '../box-helpers';
import { evidencePath, LIVE_COIN, noDemoTrace, productionChain } from './production-fixture';

/**
 * SH-TA-29: a v2 box's numbers on its feed card and its page, in the production build, from the indexer's statistics
 * (SH-TA-28): the v2 box of the recorded deployment laid over with the statistics the indexer published for a recorded
 * six-decimal-P life (on its curve, then graduated). Numbers and the price chart first; nothing asks a wallet.
 * SH-BOX-LIFE-VIEW: the page now leads with the box's life (the strip, then these numbers with the raise bar and a
 * chart that means something with few trades, then the live trades and holders), and names the price coin by its own
 * symbol, read over the RPC (here USDC, as the stubbed RPC answers), never "P".
 * SH-BOX-CANDLES: the chart is the candle chart (the fixture's candle route made from the same statistics' hours), the
 * hourly table behind Details gone.
 */
/** A box that has not failed or filled, its gate open long ago and its deadline far ahead. */
const OPEN = { failed: null, closing: null, closedAt: '0', gate: { open: true, effectiveOpenAt: '1', deadline: '99999999999' } };

test.beforeEach(async ({ page }) => {
  await installUntouchableWallet(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

async function current(page: Page, timestamp: string) {
  // The browser clock 20 s after the snapshot, so a Sepolia answer is current (over a minute old: Stale).
  await page.clock.setFixedTime((Number(timestamp) + 20) * 1000);
}

/**
 * SH-224: the page's five figures are its header's number tiles (the first box's header); the market card keeps the
 * raise bar and the chart. A tile's value is its cell's first text, its unit the small line under it.
 */
// SH-255: the tiles are the picture's figures row (beside the head on a wide screen, under the picture on a phone).
const tiles = (page: Page) => page.locator('.sh-bpic .sh-box-stat');
const tileValues = (page: Page) => tiles(page).locator('dd').evaluateAll((cells) => cells.map((cell) => cell.firstChild?.textContent ?? null));

async function shot(page: Page, testInfo: TestInfo, name: string, fullPage = false) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path: evidencePath(testInfo, `ta29-${name}`), fullPage, scale: 'css' });
}

test('on the curve: the card shows the raise with its bar, price, market cap, holders, burned and 24 h volume; the page leads with the box’s life and them', async ({ page }, testInfo) => {
  const chain = await productionChain(page, { v2: { ...OPEN, graduated: false, statistics: recordedStatisticsV2('buy', 'sixDecimals') } });
  await current(page, chain.v2Timestamp);
  await page.goto('/');
  const card = page.locator(`a[href="/box/11155111/${chain.tokens.v2}"]`).first();
  await expect(card).toBeVisible();
  await expect(card.locator('.sh-box-card__figure')).toHaveText(`19.8% · 0.1983 / 1 ${LIVE_COIN}`);
  await expect(card.locator('.sh-box-bar')).toBeVisible();
  await expect(card.locator('.sh-v2-card-stats__label')).toHaveText(['Price', 'Mcap', 'Holders', 'Burned', '24h']);
  await expect(card.locator('.sh-v2-card-stats__value')).toHaveText(['0.00079682', '0.7959', '3', '1.07M', '0.2003']);
  await expect(card.locator('svg.sh-v2-spark polyline')).toHaveCount(1);
  expect(await card.getAttribute('aria-label')).toContain('Price 0.00079682, Market cap 0.7959, Holders 3, Burned 1.07M, 24h volume 0.2003');
  await noDemoTrace(page, 'the feed with a v2 box on its curve');
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: evidencePath(testInfo, 'ta29-card-curve'), scale: 'css' });
  await card.click();
  await expect(page).toHaveURL(new RegExp(`/box/11155111/${chain.tokens.v2}$`));
  await expect(page.getByRole('region', { name: 'Box life' }).locator('[aria-current="step"]')).toHaveAttribute('data-step', 'raise');
  const market = page.getByRole('region', { name: 'Market' });
  await expect(market).toBeVisible();
  await expect(tiles(page).locator('dt')).toHaveText(['Price', 'Market cap', 'Holders', 'Burned', '24h volume']);
  await expect.poll(() => tileValues(page)).toEqual(['0.00079682', '0.7959', '3', '1.07M', '0.2003']);
  await expect(market.locator('.sh-v2-stats__grid')).toHaveCount(0);
  await expect(market.getByRole('progressbar', { name: 'Raised' })).toHaveAttribute('aria-valuetext', `19.8%, 0.1983 / 1 ${LIVE_COIN}`);
  // SH-BOX-CANDLES: the candle chart, Max by default, drawn by the lazily loaded library.
  await expect(market.locator('.sh-candles')).toHaveAttribute('data-status', 'drawn');
  await expect(market.locator('.sh-candles canvas').first()).toBeVisible();
  expect(chain.asked.filter((path) => path.endsWith('/candles'))).toHaveLength(1);
  await noDemoTrace(page, 'a v2 box page on its curve');
  await shot(page, testInfo, 'page-curve');
  expect(await walletTouches(page)).toEqual([]);
  expect(chain.escaped).toEqual([]);
});

test('graduated: the market cap is the card’s figure, no raise bar on the page, the pool’s price; the hours in the candle chart', async ({ page }, testInfo) => {
  const chain = await productionChain(page, { v2: { ...OPEN, graduated: true, statistics: recordedStatisticsV2('poolSellBurn', 'sixDecimals') } });
  await current(page, chain.v2Timestamp);
  await page.goto('/');
  const card = page.locator(`a[href="/box/11155111/${chain.tokens.v2}"]`).first();
  await expect(card.locator('.sh-box-card__figure')).toHaveText(`Mcap 3.62 ${LIVE_COIN}`);
  await expect(card.locator('.sh-v2-card-stats__label')).toHaveText(['Price', 'Holders', 'Burned', '24h']);
  await expect(card.locator('.sh-v2-card-stats__value')).toHaveText(['0.0036309', '2', '1.46M', '1.29']);
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: evidencePath(testInfo, 'ta29-card-graduated'), scale: 'css' });
  await page.goto(`/box/11155111/${chain.tokens.v2}`);
  const market = page.getByRole('region', { name: 'Market' });
  await expect(tiles(page).locator('dt')).toHaveText(['Price', 'Market cap', 'Holders', 'Burned', '24h volume']);
  await expect(market.locator('.sh-v2-stats__grid')).toHaveCount(0);
  // SH-BOX-CANDLES: the candle chart; the hours at its 1h step (the table behind Details is gone).
  await expect(market.locator('.sh-candles')).toHaveAttribute('data-status', 'drawn');
  await expect(market.locator('.sh-life-raise')).toHaveCount(0);
  await shot(page, testInfo, 'page-graduated');
  await market.locator('summary', { hasText: 'Details' }).click();
  await expect(market.locator('details table')).toHaveCount(0);
  await market.getByRole('button', { name: '1h', exact: true }).click();
  await expect(market.locator('.sh-candles')).toHaveAttribute('data-step', '1h');
  await expect(market.locator('.sh-candles')).toHaveAttribute('data-status', 'drawn');
  await market.scrollIntoViewIfNeeded();
  await market.screenshot({ path: evidencePath(testInfo, 'ta29-hours'), scale: 'css' });
  expect(await walletTouches(page)).toEqual([]);
  expect(chain.escaped).toEqual([]);
});
