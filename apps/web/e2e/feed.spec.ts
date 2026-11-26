import { expect, test } from '@playwright/test';
import {
  MARKET_CAP_ORDER,
  USDC_DEMO,
  horizontalOverflow,
  openFeed,
  pid,
  results,
  row,
  rowIds,
  scrollY,
  status,
  trackErrors,
} from './feed-helpers';

// SH-005 (rows, pin, responsive), SH-006 (search, sorts, filters, URL state), SH-007 (states).
// Runs in both projects: desktop 1440×900 and mobile 390×844 (Pixel 7).

test.describe('feed contract (FEED-01, FEED-02, UI-05, UI-06)', () => {
  test('pins the platform outside the results and lists organic pairs in provider order', async ({ page, isMobile }) => {
    const errors = trackErrors(page);
    await openFeed(page, '/pairs', '11 pairs');
    await expect(page.getByRole(isMobile ? 'list' : 'table', { name: 'Launched pairs' })).toBeVisible();
    expect(await rowIds(page)).toEqual(MARKET_CAP_ORDER);

    const pin = page.getByRole('region', { name: 'Platform pin' });
    await expect(pin.getByRole('heading', { name: 'Square Hole' })).toBeVisible();
    await expect(pin).toContainText('Platform');
    await expect(pin).toContainText('Ticker not set');
    await expect(pin).not.toContainText(/#\d|\brank|crown/i);
    await expect(results(page).locator(`[data-pair-id="${pid('65')}"]`)).toHaveCount(0);
    expect(await pin.evaluate((el) => el.closest('[aria-label="Launched pairs"]'))).toBeNull();
    await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('rows carry identity links, who-earns-what wording, compact figures and route status', async ({ page }) => {
    await openFeed(page, '/pairs', '11 pairs');
    for (const id of MARKET_CAP_ORDER) {
      const address = id.split(':')[1];
      const links = page.locator(`[data-pair-id="${id}"] a[href="/pair/31337/${address}"]`);
      expect(await links.count()).toBeGreaterThan(0);
    }
    const orchard = row(page, '66');
    await expect(orchard.getByRole('link', { name: /^ORCHARD/ })).toHaveAttribute('href', '/pair/31337/0x0000000000000000000000000000000000000066');
    for (const text of ['ORCH', 'NFT collection', 'AAPLx-DEMO', 'Fee share in AAPLx-DEMO', '$600K', '$84.2K', '3d', 'Showcase concept · not deployed', 'Route unverified']) {
      await expect(orchard).toContainText(text);
    }
    await expect(row(page, '67')).toContainText('Fee share in ROUND');
    await expect(row(page, '67')).toContainText('Token');
    await expect(page.locator('[data-pair-id]').filter({ hasText: 'Route unverified' })).toHaveCount(11);
    await expect(page.locator('[data-pair-id]').filter({ hasText: 'Showcase concept · not deployed' })).toHaveCount(1);
    await expect(row(page, '6f')).toContainText('15m');

    const unpriced = row(page, '70');
    // Each missing metric is a decorative dash (hidden from assistive technology) plus visually hidden words.
    const missing = unpriced.locator('[data-metric="unavailable"]');
    await expect(missing).toHaveCount(2);
    await expect(missing.locator('[aria-hidden="true"]')).toHaveText(['—', '—']);
    await expect(missing.locator('.sh-visually-hidden')).toHaveText(['Not available', 'Not available']);
    await expect(unpriced.getByRole('img', { name: 'Not available' })).toHaveCount(0);
    await expect(unpriced).toContainText('—');
    await expect(unpriced).not.toContainText('$0');
    // Demo routes are never executable: no external hrefs anywhere in the results.
    expect(await results(page).locator('a[href^="http"], a[target="_blank"]').count()).toBe(0);
  });

  test('desktop budgets at 1440×900: bar, nav, compact pin and six organic rows (UI-05)', async ({ page, isMobile }) => {
    test.skip(isMobile, 'desktop budget');
    await openFeed(page, '/pairs', '11 pairs');
    const layout = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
      const rows = [...document.querySelectorAll('[data-pair-id]')].map((el) => el.getBoundingClientRect());
      return {
        topbar: box('.sh-topbar')?.height ?? 0,
        nav: box('#primary-nav')?.width ?? 0,
        pin: box('[aria-label="Platform pin"]')?.height ?? 0,
        fullyVisibleRows: rows.filter((r) => r.top >= 0 && r.bottom <= window.innerHeight).length,
      };
    });
    test.info().annotations.push({ type: 'layout', description: JSON.stringify(layout) });
    expect(layout.topbar).toBeGreaterThanOrEqual(64);
    expect(layout.topbar).toBeLessThanOrEqual(72);
    expect(layout.nav).toBeGreaterThanOrEqual(176);
    expect(layout.nav).toBeLessThanOrEqual(208);
    expect(layout.pin).toBeGreaterThanOrEqual(150);
    expect(layout.pin).toBeLessThanOrEqual(190);
    expect(layout.fullyVisibleRows).toBeGreaterThanOrEqual(6);
  });

  test('the table header sticks below the top bar inside the page scroller', async ({ page, isMobile }) => {
    test.skip(isMobile, 'cards have no header');
    await openFeed(page, '/pairs', '11 pairs');
    await page.mouse.wheel(0, 500);
    await expect.poll(() => scrollY(page)).toBeGreaterThan(300);
    const head = await page.locator('.sh-table thead th').first().boundingBox();
    expect(Math.round(head?.y ?? -1)).toBe(64);
  });

  test('narrow widths: one-row top bar, full-width cards, no horizontal overflow (UI-06)', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'mobile budget');
    await openFeed(page, '/pairs', '11 pairs');
    const header = await page.locator('.sh-topbar').boundingBox();
    expect(header?.height).toBeGreaterThanOrEqual(56);
    expect(header?.height).toBeLessThanOrEqual(64);
    const card = row(page, '66');
    for (const text of ['ORCHARD', 'AAPLx-DEMO', 'Fee share in AAPLx-DEMO', 'Market cap', '$600K', '24h turnover', '$84.2K', 'Age', '3d']) {
      await expect(card).toContainText(text);
    }
    const cardBox = await card.boundingBox();
    expect(cardBox?.width).toBeGreaterThan(340);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 360, height: 740 });
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    const narrowHeader = await page.locator('.sh-topbar').boundingBox();
    expect(narrowHeader?.height).toBeLessThanOrEqual(64);
  });
});

test.describe('search, sorts and filters in the URL (FEED-03, FEED-04)', () => {
  test('one search field; typing updates ?q= by replacing history, and the pin says it is not a match', async ({ page }) => {
    await openFeed(page, '/pairs', '11 pairs');
    await expect(page.getByRole('searchbox')).toHaveCount(1);
    const historyLength = await page.evaluate(() => history.length);
    await page.getByRole('searchbox', { name: 'Search pairs' }).fill('orch');
    await expect(page).toHaveURL(/\/pairs\?q=orch$/);
    await expect(status(page)).toHaveText('2 pairs');
    expect(await rowIds(page)).toEqual([pid('66'), pid('6e')]);
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
    await expect(page.getByRole('region', { name: 'Platform pin' })).toContainText('Not a search match');
  });

  test('searching a quote address lists the pairs using it', async ({ page }) => {
    await openFeed(page, '/pairs', '11 pairs');
    await page.getByRole('searchbox', { name: 'Search pairs' }).fill(USDC_DEMO.toUpperCase().replace('0X', '0x'));
    await expect(status(page)).toHaveText('3 pairs');
    expect(await rowIds(page)).toEqual([pid('68'), pid('6b'), pid('6f')]);
  });

  test('sorts and filters push history; Back and Forward restore controls and results', async ({ page }) => {
    await openFeed(page, '/pairs', '11 pairs');
    await expect(page.getByRole('radio', { name: 'Market cap' })).toBeChecked();
    await page.getByRole('radio', { name: 'New' }).check();
    await expect(page).toHaveURL(/\/pairs\?sort=new$/);
    await expect.poll(() => rowIds(page).then((ids) => ids[0])).toBe(pid('70'));

    await page.getByRole('radio', { name: 'NFT collections' }).check();
    await expect(page).toHaveURL(/\/pairs\?sort=new&type=nft_collection$/);
    await expect(status(page)).toHaveText('5 pairs');

    await page.getByLabel('Fee share in').selectOption('T');
    await expect(page).toHaveURL(/reward=T/);
    await expect(status(page)).toHaveText('2 pairs');

    await page.getByLabel('Lifecycle').selectOption('curve');
    await expect(page).toHaveURL(/lifecycle=curve/);
    await expect(status(page)).toHaveText('1 pair');
    expect(await rowIds(page)).toEqual([pid('6e')]);

    await page.getByRole('radio', { name: 'Turnover (24h)' }).check();
    await expect(page).toHaveURL(/sort=turnover/);

    await page.goBack();
    await expect(page.getByRole('radio', { name: 'New' })).toBeChecked();
    await expect(page.getByLabel('Lifecycle')).toHaveValue('curve');
    await page.goBack();
    await expect(page.getByLabel('Lifecycle')).toHaveValue('');
    await expect(page.getByLabel('Fee share in')).toHaveValue('T');
    await expect(status(page)).toHaveText('2 pairs');
    await page.goBack();
    await page.goBack();
    await expect(page.getByRole('radio', { name: 'All' })).toBeChecked();
    await expect(page.getByRole('radio', { name: 'New' })).toBeChecked();
    await expect(status(page)).toHaveText('11 pairs');
    await page.goBack();
    await expect(page.getByRole('radio', { name: 'Market cap' })).toBeChecked();
    expect(await rowIds(page)).toEqual(MARKET_CAP_ORDER);
    await page.goForward();
    await expect(page.getByRole('radio', { name: 'New' })).toBeChecked();
    await expect.poll(() => rowIds(page).then((ids) => ids[0])).toBe(pid('70'));
  });

  // Integration regression (M1): Back pressed before the router has rendered a sort change used to land on the same
  // memoised location, so the controls kept the abandoned choice ("New" checked on a market-cap URL) and the next
  // change was merged into the abandoned URL.
  test('Back right after a sort change: the controls follow the URL, and the next change starts from it', async ({ page }) => {
    await openFeed(page, '/pairs', '11 pairs');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await page.evaluate(() => {
        const group = document.querySelector('[role="radiogroup"][aria-label="Sort by"]');
        const option = group?.querySelector<HTMLInputElement>('input[type="radio"][value="new"]');
        if (!option) throw new Error('missing "New" sort radio');
        option.click();
        history.back();
      });
      await expect.poll(() => page.evaluate(() => location.search)).toBe('');
      await expect(page.getByRole('radio', { name: 'Market cap' })).toBeChecked();
      await expect(page.getByRole('radio', { name: 'New' })).not.toBeChecked();
      expect(await rowIds(page)).toEqual(MARKET_CAP_ORDER);
    }
    await page.getByRole('radio', { name: 'Tokens' }).check();
    await expect(page).toHaveURL(/\/pairs\?type=token$/);
    await expect(page.getByRole('radio', { name: 'Market cap' })).toBeChecked();
  });

  test('the reward filter offers the snapshot’s reward assets by symbol', async ({ page }) => {
    await openFeed(page, '/pairs', '11 pairs');
    const options = await page.getByLabel('Fee share in').locator('option').evaluateAll((els) =>
      els.map((el) => [el.textContent, (el as HTMLOptionElement).value]),
    );
    expect(options).toEqual([
      ['Any asset', ''],
      ['Own token (T)', 'T'],
      ['AAPLx-DEMO', '0x0000000000000000000000000000000000002329'],
      ['USDC-DEMO', USDC_DEMO],
    ]);
    await page.getByLabel('Fee share in').selectOption(USDC_DEMO);
    await expect(page).toHaveURL(new RegExp(`reward=${USDC_DEMO}`));
    await expect(status(page)).toHaveText('3 pairs');
  });

  test('invalid or unknown URL values fall back to defaults without errors', async ({ page }) => {
    const errors = trackErrors(page);
    await openFeed(
      page,
      '/pairs?sort=bogus&type=__proto__&reward=0x00000000000000000000000000000000000000ff&lifecycle=unlaunched&q=&scenario=nope&cursor=',
      '11 pairs',
    );
    await expect(page.getByRole('radio', { name: 'Market cap' })).toBeChecked();
    await expect(page.getByRole('radio', { name: 'All' })).toBeChecked();
    await expect(page.getByLabel('Fee share in')).toHaveValue('');
    await expect(page.getByLabel('Lifecycle')).toHaveValue('');
    expect(await rowIds(page)).toEqual(MARKET_CAP_ORDER);
    expect(errors).toEqual([]);
  });

  test('the header trigger and "/" open the box feed’s one search field (launch set); the pair feed keeps its own', async ({ page, isMobile }) => {
    await page.goto('/launch');
    await expect(page.getByRole('searchbox')).toHaveCount(0);
    await page.getByRole('button', { name: 'Search boxes' }).click();
    await expect(page).toHaveURL(/\/$/);
    const boxes = page.getByRole('searchbox', { name: 'Search boxes, tokens or a wallet' });
    await expect(boxes).toBeFocused();
    if (!isMobile) {
      await page.getByRole('heading', { level: 1, name: 'Boxes' }).focus();
      await page.keyboard.press('/');
      await expect(boxes).toBeFocused();
      await page.keyboard.type('pots');
      await expect(page).toHaveURL(/\/\?q=pots$/);
    }
    await openFeed(page, '/pairs', '11 pairs');
    await expect(page.getByRole('searchbox')).toHaveCount(1);
    await expect(page.getByRole('searchbox', { name: 'Search pairs' })).toBeVisible();
  });
});

test.describe('states (FEED-06, FEED-10)', () => {
  test('empty search: "No pairs match" and "Clear search"', async ({ page }) => {
    await openFeed(page, '/pairs?q=zzz', '0 pairs');
    await expect(page.getByRole('heading', { name: 'No pairs match' })).toBeVisible();
    await expect(page.locator('[data-pair-id]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(status(page)).toHaveText('11 pairs');
    await expect(page.getByRole('searchbox', { name: 'Search pairs' })).toHaveValue('');
  });

  test('a filter with no match offers "Reset filters"', async ({ page }) => {
    await openFeed(page, '/pairs?lifecycle=graduating', '0 pairs');
    await expect(page.getByRole('heading', { name: 'No pairs match' })).toBeVisible();
    await page.getByRole('button', { name: 'Reset filters' }).click();
    await expect(status(page)).toHaveText('11 pairs');
  });

  test('stale snapshot: notice with its as-of time; later launches are absent', async ({ page }) => {
    await openFeed(page, '/pairs?scenario=stale', '8 pairs');
    await expect(page.getByText('Stale data')).toBeVisible();
    await expect(page.locator('[data-notice="stale"]')).toContainText('25 Sep 2026, 10:00 UTC');
  });

  test('partial coverage: notice, and unknown turnover is "Not available" and sorts last', async ({ page }) => {
    await openFeed(page, '/pairs?scenario=partial&sort=turnover', '11 pairs');
    await expect(page.getByText('Partial coverage')).toBeVisible();
    const ids = await rowIds(page);
    expect(ids.slice(0, 5)).toEqual([pid('67'), pid('66'), pid('6a'), pid('68'), pid('69')]);
    await expect(row(page, '6b').locator('[data-metric="unavailable"]')).toHaveCount(1);
    await expect(row(page, '6b').locator('[data-metric="unavailable"] .sh-visually-hidden')).toHaveText('Not available');
    await expect(row(page, '6b')).not.toContainText('$0');
  });

  test('provider unavailable: alert with "Try again"', async ({ page }) => {
    await openFeed(page, '/pairs?scenario=unavailable', 'Pairs unavailable');
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Feed unavailable');
    await alert.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('alert')).toContainText('Feed unavailable');
    await expect(page.locator('[data-pair-id]')).toHaveCount(0);
  });

  test('no organic launches: "No launches yet" while the platform stays pinned', async ({ page }) => {
    await openFeed(page, '/pairs?scenario=no_launches', '0 pairs');
    await expect(page.getByRole('heading', { name: 'No launches yet' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Platform pin' }).getByRole('heading', { name: 'Square Hole' })).toBeVisible();
  });

  test('root unlaunched: "Coming soon" without metrics, prices or a trading call to action', async ({ page }) => {
    await openFeed(page, '/pairs?scenario=root_unlaunched', '11 pairs');
    const pin = page.getByRole('region', { name: 'Platform pin' });
    await expect(pin).toContainText('Coming soon');
    await expect(pin).not.toContainText(/\$|Market cap|turnover|Holders/);
    await expect(pin.getByRole('link')).toHaveCount(0);
  });

  test('loading: skeleton with aria-busy', async ({ page }) => {
    await page.goto('/pairs?scenario=loading');
    await expect(status(page)).toHaveText('Loading pairs…');
    await expect(results(page)).toHaveAttribute('aria-busy', 'true');
  });

  test('ranking updated: offered, not applied, until "Show updated ranking" is pressed', async ({ page }) => {
    await openFeed(page, '/pairs?scenario=ranking_updated', '11 pairs');
    const button = page.getByRole('button', { name: 'Show updated ranking' });
    await expect(button).toBeVisible();
    expect((await rowIds(page)).slice(0, 2)).toEqual([pid('66'), pid('67')]);
    await button.click();
    await expect.poll(async () => (await rowIds(page)).slice(0, 2)).toEqual([pid('67'), pid('66')]);
    await expect(button).toHaveCount(0);
  });
});

test.describe('pin preference and scroll restoration', () => {
  test('collapsing the pin is remembered across reloads', async ({ page, isMobile }) => {
    await openFeed(page, '/pairs', '11 pairs');
    const pin = page.getByRole('region', { name: 'Platform pin' });
    // The decorative accent is mounted in the pin on wider screens only (never inside a link or button).
    await expect(pin.locator('[data-scene-variant="pin"]')).toHaveCount(isMobile ? 0 : 1);
    expect(await pin.locator('[data-scene-variant]').evaluateAll((els) => els.filter((el) => el.closest('a, button')).length)).toBe(0);
    await page.getByRole('button', { name: 'Hide platform pin' }).click();
    await expect(page.getByRole('button', { name: 'Show platform pin' })).toHaveAttribute('aria-expanded', 'false');
    await expect(pin.locator('[data-scene-variant]')).toHaveCount(0);
    await expect(pin.getByRole('heading', { name: 'Square Hole' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Show platform pin' })).toBeVisible();
    await page.getByRole('button', { name: 'Show platform pin' }).click();
    await expect(page.getByRole('button', { name: 'Hide platform pin' })).toHaveAttribute('aria-expanded', 'true');
  });

  test('Back and Forward restore the scroll position with the results', async ({ page }) => {
    await openFeed(page, '/pairs', '11 pairs');
    await page.getByRole('radio', { name: 'New' }).check();
    await expect(page).toHaveURL(/sort=new/);
    await page.evaluate(() => window.scrollTo(0, 260));
    await expect.poll(() => scrollY(page)).toBe(260);
    await page.goBack();
    await expect(page.getByRole('radio', { name: 'Market cap' })).toBeChecked();
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => scrollY(page)).toBe(0);
    await page.goForward();
    await expect(page.getByRole('radio', { name: 'New' })).toBeChecked();
    await expect.poll(() => scrollY(page)).toBe(260);
  });

  test('returning from a pair page restores the feed position', async ({ page }) => {
    await openFeed(page, '/pairs', '11 pairs');
    await page.evaluate(() => window.scrollTo(0, 320));
    await expect.poll(() => scrollY(page)).toBe(320);
    await row(page, '66').getByRole('link', { name: /^ORCHARD/ }).click();
    await expect(page).toHaveURL(/\/pair\/31337\/0x0+66$/);
    await page.goBack();
    await expect(status(page)).toHaveText('11 pairs');
    await expect.poll(() => scrollY(page)).toBe(320);
  });
});
