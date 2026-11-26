import { expect, test } from '@playwright/test';
import { FAKE_ZERO_USD, ORGANIC, VERIFIED_ORDERS, byName, canonicalId, countLabel, expectedIds } from './expected';
import {
  FEED_PATH,
  accessibleText,
  expectCount,
  expectRows,
  feedUrl,
  revealControls,
  row,
  rowIds,
  searchParams,
  sortRadio,
  suffixes,
  waitForFeed,
} from './helpers';

// FEED-02 (market cap desc, exact decimals, null last, stable ties) and FEED-03 (New / Turnover orders).

test.describe('FEED-02 default order', () => {
  test('rows follow market cap descending with the exact tie rule and the unpriced pair last', async ({ page }) => {
    await page.goto(FEED_PATH);
    await waitForFeed(page);
    await expectRows(page, suffixes(VERIFIED_ORDERS.marketCap));
    await expectCount(page, countLabel(ORGANIC.length));
    await revealControls(page);
    await expect(sortRadio(page, 'Market cap')).toBeChecked();
    await expect(sortRadio(page, 'New')).not.toBeChecked();
    await expect(sortRadio(page, 'Turnover (24h)')).not.toBeChecked();

    // Equal cap and equal launch time: canonical pairId ascending, so SOFT CORNERS sits directly above WRONG ANGLE.
    const ids = await rowIds(page);
    const soft = ids.indexOf(canonicalId(byName('SOFT CORNERS')));
    const wrong = ids.indexOf(canonicalId(byName('WRONG ANGLE')));
    expect(soft).toBeGreaterThanOrEqual(0);
    expect(wrong).toBe(soft + 1);

    // Unpriced sorts last (not as zero) and says so instead of showing a fake $0.
    const unpriced = byName('NO PRICE YET');
    expect(ids.at(-1)).toBe(canonicalId(unpriced));
    const text = await accessibleText(row(page, canonicalId(unpriced)));
    expect(text).toContain('Not available');
    expect(text).not.toMatch(FAKE_ZERO_USD);
  });

  test('the default sort is omitted from the URL', async ({ page }) => {
    await page.goto(`${FEED_PATH}?sort=new`);
    await waitForFeed(page);
    await revealControls(page);
    await sortRadio(page, 'Market cap').check();
    await expect(sortRadio(page, 'Market cap')).toBeChecked();
    await expect.poll(() => searchParams(page).sort ?? null).toBeNull();
    await expectRows(page, suffixes(VERIFIED_ORDERS.marketCap));
  });
});

test.describe('FEED-03 New and Turnover', () => {
  test('New orders by launch time, newest first, and includes unpriced launches', async ({ page }) => {
    await page.goto(FEED_PATH);
    await waitForFeed(page);
    await revealControls(page);
    await sortRadio(page, 'New').check();
    await expect(sortRadio(page, 'New')).toBeChecked();
    await expect(sortRadio(page, 'Market cap')).not.toBeChecked();
    await expect.poll(() => searchParams(page).sort).toBe('new');
    await expectRows(page, suffixes(VERIFIED_ORDERS.new));
    expect((await rowIds(page))[0]).toBe(canonicalId(byName('NO PRICE YET')));
    await expectCount(page, countLabel(ORGANIC.length));
  });

  test('Turnover (24h) orders by 24h turnover with the unavailable value last', async ({ page }) => {
    await page.goto(FEED_PATH);
    await waitForFeed(page);
    await revealControls(page);
    await sortRadio(page, 'Turnover (24h)').check();
    await expect(sortRadio(page, 'Turnover (24h)')).toBeChecked();
    await expect.poll(() => searchParams(page).sort).toBe('turnover');
    await expectRows(page, suffixes(VERIFIED_ORDERS.turnover));
    expect((await rowIds(page)).at(-1)).toBe(canonicalId(byName('NO PRICE YET')));
  });

  for (const sort of ['new', 'turnover'] as const) {
    test(`?sort=${sort} loads directly with the same order`, async ({ page }) => {
      await page.goto(feedUrl({ sort }));
      await waitForFeed(page);
      await expectRows(page, expectedIds({ sort }));
      await revealControls(page);
      await expect(sortRadio(page, sort === 'new' ? 'New' : 'Turnover (24h)')).toBeChecked();
    });
  }
});
