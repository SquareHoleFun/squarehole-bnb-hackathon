import { expect, test } from '@playwright/test';
import {
  ORGANIC,
  PLATFORM,
  canonicalId,
  countLabel,
  expectedIds,
  platformMatches,
  rewardAssetOptions,
  type FeedQuery,
} from './expected';
import {
  FEED_PATH,
  bodyText,
  expectCount,
  expectRows,
  feedUrl,
  pin,
  results,
  row,
  searchbox,
  searchParams,
  trackErrors,
  waitForFeed,
} from './helpers';

// FEED-01 platform pin, 01-PRODUCT root card rules, ADR-0003 root_unlaunched, SH-008 accent integration notes.

const NOT_A_MATCH = 'Not a search match';
const aaplx = rewardAssetOptions()[0]?.value ?? '';
const usdc = rewardAssetOptions()[1]?.value ?? '';

test('FEED-01: the platform is pinned once, above and outside the results, and never counted', async ({ page }) => {
  await page.goto(FEED_PATH);
  await waitForFeed(page);
  await expect(pin(page)).toHaveCount(1);
  await expect(pin(page)).toBeVisible();
  await expect(pin(page).getByRole('heading', { name: PLATFORM.name })).toBeVisible();
  await expect(pin(page)).toContainText('Platform');
  await expect(pin(page)).toContainText('Ticker not set');
  await expect(pin(page)).not.toContainText(NOT_A_MATCH);

  const pinText = await pin(page).innerText();
  expect(pinText, 'placement is not a rank').not.toMatch(/#\s*1\b|\brank(?:ed|ing)?\b|crown|\u{1F451}/iu);
  expect(pinText, 'root ticker HOLE is not approved').not.toMatch(/\bHOLE\b/);
  expect(await bodyText(page), 'UNSET-DEMO renders as "Ticker not set"').not.toContain('UNSET-DEMO');

  const pinHandle = await pin(page).elementHandle();
  const resultsHandle = await results(page).elementHandle();
  const relation = await page.evaluate(
    ([p, r]) => ({
      pinInsideResults: !!r?.contains(p ?? null),
      resultsInsidePin: !!p?.contains(r ?? null),
      pinFirst: !!(p && r && p.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING),
    }),
    [pinHandle, resultsHandle] as const,
  );
  expect(relation).toEqual({ pinInsideResults: false, resultsInsidePin: false, pinFirst: true });

  await expect(row(page, canonicalId(PLATFORM))).toHaveCount(0);
  await expect(results(page)).not.toContainText(PLATFORM.name);
  await expectCount(page, countLabel(ORGANIC.length));
});

test('FEED-01: searching "orch" keeps the pin visible, labelled as not a match, and out of the count', async ({ page }) => {
  await page.goto(FEED_PATH);
  await waitForFeed(page);
  await searchbox(page).fill('orch');
  await expect.poll(() => searchParams(page).q).toBe('orch');
  await expectRows(page, expectedIds({ q: 'orch' }));
  await expectCount(page, countLabel(expectedIds({ q: 'orch' }).length));
  await expect(pin(page)).toBeVisible();
  await expect(pin(page)).toContainText(NOT_A_MATCH);
  await expect(pin(page).getByRole('heading', { name: PLATFORM.name })).toBeVisible();
  await expect(row(page, canonicalId(PLATFORM))).toHaveCount(0);
});

const PIN_MATCH_CASES: { label: string; query: FeedQuery }[] = [
  { label: 'NFT-only type filter', query: { type: 'nft_collection' } },
  { label: 'curve lifecycle filter', query: { lifecycle: 'curve' } },
  { label: 'own-token reward filter', query: { reward: 'T' } },
  { label: 'AAPLx-DEMO reward filter', query: { reward: aaplx } },
  { label: 'USDC-DEMO reward filter (the platform pays USDC-DEMO)', query: { reward: usdc } },
  { label: 'search for the platform name', query: { q: 'square' } },
  { label: 'search for the platform quote address', query: { q: usdc } },
];

for (const { label, query } of PIN_MATCH_CASES) {
  test(`FEED-01: ${label} → pin ${platformMatches(query) ? 'matches' : 'is labelled "Not a search match"'}`, async ({ page }) => {
    await page.goto(feedUrl(query));
    const expected = expectedIds(query);
    await expect(pin(page)).toBeVisible();
    await expectRows(page, expected);
    await expectCount(page, countLabel(expected.length));
    if (platformMatches(query)) await expect(pin(page)).not.toContainText(NOT_A_MATCH);
    else await expect(pin(page)).toContainText(NOT_A_MATCH);
    // Even when the platform matches, it is never inserted into the results.
    await expect(row(page, canonicalId(PLATFORM))).toHaveCount(0);
  });
}

test('the pin collapse is a remembered local preference', async ({ page }) => {
  await page.goto(FEED_PATH);
  await waitForFeed(page);
  const hide = pin(page).getByRole('button', { name: 'Hide platform pin', exact: true });
  await expect(hide).toHaveAttribute('aria-expanded', 'true');
  await hide.click();
  const show = pin(page).getByRole('button', { name: 'Show platform pin', exact: true });
  await expect(show).toHaveAttribute('aria-expanded', 'false');
  await expect(pin(page)).toBeVisible();

  await page.reload();
  await waitForFeed(page);
  await expect(pin(page).getByRole('button', { name: 'Show platform pin', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await pin(page).getByRole('button', { name: 'Show platform pin', exact: true }).click();
  await expect(pin(page).getByRole('button', { name: 'Hide platform pin', exact: true })).toHaveAttribute('aria-expanded', 'true');

  await page.reload();
  await waitForFeed(page);
  await expect(pin(page).getByRole('button', { name: 'Hide platform pin', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expect(pin(page).getByRole('heading', { name: PLATFORM.name })).toBeVisible();
});

test('the feed and the pin toggle still work when localStorage throws', async ({ page }) => {
  await page.addInitScript(() => {
    const blocked = () => {
      throw new DOMException('storage blocked by acceptance test', 'SecurityError');
    };
    Object.defineProperty(window, 'localStorage', { get: blocked, configurable: true });
    Object.defineProperty(window, 'sessionStorage', { get: blocked, configurable: true });
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(FEED_PATH);
  await waitForFeed(page);
  await expectRows(page, expectedIds({}));
  await pin(page).getByRole('button', { name: 'Hide platform pin', exact: true }).click();
  await expect(pin(page).getByRole('button', { name: 'Show platform pin', exact: true })).toHaveAttribute('aria-expanded', 'false');
  expect(errors).toEqual([]);
});

test('root_unlaunched: a branded coming-soon pin with no metrics, prices or trading CTA', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto(feedUrl({ scenario: 'root_unlaunched' }));
  await waitForFeed(page);
  await expect(pin(page)).toBeVisible();
  await expect(pin(page)).toContainText('Coming soon');
  await expect(pin(page)).toContainText('Platform');
  const text = await pin(page).innerText();
  expect(text, 'no invented amounts').not.toContain('$');
  expect(text, 'no market metrics').not.toMatch(/market cap|turnover|holders|price|\bfdv\b/i);
  expect(text).not.toMatch(/#\s*1\b|\brank(?:ed|ing)?\b/i);
  const cta = /trade|buy|sell|swap|dex|venue|uniswap|screener/i;
  await expect(pin(page).getByRole('link', { name: cta })).toHaveCount(0);
  await expect(pin(page).getByRole('button', { name: cta })).toHaveCount(0);
  // Organic launches are unchanged.
  await expectRows(page, expectedIds({}));
  await expectCount(page, countLabel(ORGANIC.length));
  expect(errors).toEqual([]);
});

test('the shape-sorter accent is never nested in a control and never shown twice', async ({ page }) => {
  await page.goto(FEED_PATH);
  await waitForFeed(page);
  await expect(page.locator('[data-scene-variant="wizard"]')).toHaveCount(0);
  expect(await page.locator('[data-scene-variant="pin"]').count()).toBeLessThanOrEqual(1);
  await expect(page.locator('a [data-scene-variant], button [data-scene-variant], [role="button"] [data-scene-variant]')).toHaveCount(0);
  await expect(pin(page).locator('a a, a button, button a, button button')).toHaveCount(0);
});
