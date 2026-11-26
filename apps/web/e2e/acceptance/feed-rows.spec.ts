import { expect, test, type Page } from '@playwright/test';
import {
  AS_OF,
  CHAIN_ID,
  FAKE_ZERO_USD,
  FIXTURE_ADDRESSES,
  ORGANIC,
  PARTIAL_ORGANIC,
  PLATFORM,
  STALE_ORGANIC,
  TYPE_LABEL,
  VERIFIED_ORDERS,
  byName,
  canonicalId,
  countLabel,
  expectedAge,
  expectedIds,
  pairPath,
  rewardSymbol,
  startsWith,
  usdPattern,
  type FixturePair,
} from './expected';
import {
  FEED_PATH,
  accessibleText,
  allLinkTargets,
  bodyText,
  expectCount,
  expectRows,
  feedUrl,
  results,
  row,
  rows,
  suffixes,
  waitForFeed,
  type Scenario,
} from './helpers';

// Row content (contract), FEED-06 (stale/partial/unpriced explicit, never zero), FEED-09 / UI-04 (demo fixtures get no
// verification badge and no executable or external link), FEED-10 (no APY, guarantee or invented history).

const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const token = (text: string, flags = '') => new RegExp(`(?<![\\w-])${esc(text)}(?![\\w-])`, flags);
const occurrences = (text: string, pattern: RegExp) => (text.match(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`)) ?? []).length;

async function expectRowContent(page: Page, pair: FixturePair, turnover: string | null = pair.turnover24hUsd): Promise<void> {
  const locator = row(page, canonicalId(pair));
  await expect(locator).toBeVisible();
  const visible = await locator.innerText();
  const spoken = await accessibleText(locator);
  const label = `${pair.name} row`;

  expect(visible, `${label}: name`).toContain(pair.name);
  const reward = new RegExp(`Fee share in\\s+${esc(rewardSymbol(pair))}(?![\\w-])`, 'i');
  expect(spoken, `${label}: reward wording`).toMatch(reward);
  // Strip the reward phrase and the name, so "NEW" (NEW SHAPE) or "ROUND" (ROUND TRIP) must appear on their own.
  const rest = spoken.replace(new RegExp(reward.source, 'gi'), ' ').split(pair.name).join(' ');
  expect(rest, `${label}: symbol shown besides the name and the reward wording`).toMatch(token(pair.symbol));
  expect(rest, `${label}: pairing asset shown besides the reward wording`).toMatch(token(pair.quote.symbol));
  expect(spoken, `${label}: asset type`).toMatch(new RegExp(esc(TYPE_LABEL[pair.type]), 'i'));

  let unavailable = 0;
  for (const [metric, value] of [['market cap', pair.marketCapUsd], ['24h turnover', turnover]] as const) {
    if (value === null) unavailable += 1;
    else expect(visible, `${label}: ${metric} ${value}`).toMatch(usdPattern(value));
  }
  if (unavailable > 0) {
    expect(visible, `${label}: unavailable metric shows an em dash`).toContain('—');
    expect(occurrences(spoken, /Not available/i), `${label}: "Not available" per missing metric`).toBeGreaterThanOrEqual(unavailable);
  }
  expect(visible, `${label}: no fake $0`).not.toMatch(FAKE_ZERO_USD);
  expect(spoken, `${label}: no fake $0`).not.toMatch(FAKE_ZERO_USD);

  const age = expectedAge(pair.launchedAt, AS_OF);
  expect(visible, `${label}: age ${age} relative to the snapshot asOf`).toMatch(new RegExp(`(?<![\\w<])${esc(age)}(?!\\w)`));
  expect(visible, `${label}: route status`).toMatch(/route unverified/i);
}

test('every organic row shows identity, type, pairing, reward, metrics, age and route status', async ({ page }) => {
  // A far-future wall clock proves ages come from the snapshot asOf, not Date.now().
  await page.clock.setFixedTime(new Date('2031-01-01T00:00:00Z'));
  await page.goto(FEED_PATH);
  await waitForFeed(page);
  await expectRows(page, suffixes(VERIFIED_ORDERS.marketCap));
  for (const pair of ORGANIC) await expectRowContent(page, pair);

  await expect(row(page, canonicalId(byName('ORCHARD')))).toContainText(/Showcase concept\s*·\s*not deployed/i);
  for (const pair of ORGANIC) {
    const status = row(page, canonicalId(pair)).getByText(/route unverified/i).first();
    const inControl = await status.evaluate((el, own) => {
      if (el.closest('button, [role="button"], [role="link"]:not(a)')) return 'inside a button';
      const anchor = el.closest('a');
      return anchor && new URL(anchor.href).pathname !== own ? `inside a link to ${anchor.href}` : 'ok';
    }, pairPath(pair));
    expect(inControl, `${pair.name}: "Route unverified" is not a control`).toBe('ok');
  }
  // No rank column, no sparkline / trend column (ADR-0003, REFERENCE_OVERRIDES).
  await expect(results(page).getByRole('columnheader', { name: /^#$|rank|trend|7d|sparkline/i })).toHaveCount(0);
  await expect(results(page)).not.toContainText(/\u{1F451}|crown/iu);
});

test('row links open /pair/<chainId>/<address>; their names start with the pair name', async ({ page }) => {
  await page.goto(FEED_PATH);
  await waitForFeed(page);
  for (const pair of ORGANIC) {
    const link = row(page, canonicalId(pair)).getByRole('link', { name: startsWith(pair.name) }).first();
    await expect(link, `${pair.name} link`).toBeVisible();
    const href = await link.evaluate((a) => (a as HTMLAnchorElement).href);
    expect(new URL(href).pathname).toBe(pairPath(pair));
    const others = await row(page, canonicalId(pair)).locator('a[href]').evaluateAll((as) => as.map((a) => new URL((a as HTMLAnchorElement).href).pathname));
    for (const path of others) expect(path, `${pair.name}: every row link is its own detail route`).toBe(pairPath(pair));
  }
  const pair = byName('ROUND TRIP');
  await row(page, canonicalId(pair)).getByRole('link', { name: startsWith(pair.name) }).first().click();
  await expect(page).toHaveURL(new RegExp(`/pair/${CHAIN_ID}/${pairPath(pair).split('/').at(-1)}$`));
});

const SCENARIOS: Scenario[] = ['default', 'partial', 'stale', 'root_unlaunched', 'no_launches'];
const PAIR_PATHS = [...ORGANIC, PLATFORM].map(pairPath);

for (const scenario of SCENARIOS) {
  // F130 (founder 2026-10-11) supersedes UI-04's Demo label: the sample data carries no Demo badge or word.
  test(`FEED-09 / UI-04 / FEED-10 (${scenario}): no Demo label (F130), no verification badge, no fixture-address links, no yield claims`, async ({ page }) => {
    await page.goto(feedUrl({ scenario }));
    await expect(page.getByRole('banner').getByRole('link', { name: 'Square Hole home' })).toBeVisible();
    await expect(page.getByRole('banner').locator('.sh-source-badge')).toHaveCount(0);
    await expect(page.getByRole('banner')).not.toContainText(/\bdemo\b|\bmock\b/i);
    if (scenario === 'no_launches') await expect(page.getByRole('heading', { name: 'No launches yet' })).toBeVisible();
    else await waitForFeed(page);

    const organicText = (await rows(page).allInnerTexts()).join('\n');
    expect(organicText).not.toMatch(/(?<!un|not |never )verified/i);
    expect(organicText).not.toMatch(/[✓✔☑✅]/u);

    const origin = new URL(page.url()).origin;
    for (const url of await allLinkTargets(page)) {
      expect(['http:', 'https:'], `no ${url.protocol} links`).toContain(url.protocol);
      const hit = FIXTURE_ADDRESSES.find((address) => url.href.toLowerCase().includes(address.slice(2)));
      if (!hit) continue;
      expect(url.origin, `${url.href} uses fixture address ${hit}: only the app's own routes may`).toBe(origin);
      expect(url.pathname).toMatch(new RegExp(`^/pair/${CHAIN_ID}/0x[0-9a-f]{40}$`));
      expect(PAIR_PATHS, `${url.pathname} is a pair detail route, not a token/quote address`).toContain(url.pathname);
    }

    const text = await bodyText(page);
    expect(text).not.toMatch(/\bAPY\b|\bAPR\b/i);
    expect(text).not.toMatch(/(?<!not |no |never |isn't |aren't )guarantee(?:d|s)?\b/i);
    expect(text, 'no percentage figures: the fixture has none to show').not.toMatch(/\d\s*%/);
    expect(text).not.toMatch(/sustainable growth|organic volume|\b7D\b/i);
  });
}

test('FEED-06 unpriced: NO PRICE YET shows "—" / "Not available" for cap and turnover, never $0', async ({ page }) => {
  await page.goto(FEED_PATH);
  await waitForFeed(page);
  const pair = byName('NO PRICE YET');
  await expectRowContent(page, pair);
  expect(occurrences(await accessibleText(row(page, canonicalId(pair))), /Not available/i)).toBeGreaterThanOrEqual(2);
});

test('FEED-06 partial: "Partial coverage" notice, unindexed turnover is "—" not $0 and sorts last', async ({ page }) => {
  await page.goto(feedUrl({ scenario: 'partial' }));
  await waitForFeed(page);
  await expect(page.getByText(/Partial coverage/).first()).toBeVisible();
  await expect(page.getByRole('banner')).not.toContainText(/\bdemo\b/i);
  await expectRows(page, expectedIds({}, PARTIAL_ORGANIC));
  for (const pair of PARTIAL_ORGANIC) await expectRowContent(page, pair, pair.turnover24hUsd);

  await page.goto(feedUrl({ scenario: 'partial', sort: 'turnover' }));
  await waitForFeed(page);
  await expectRows(page, suffixes(VERIFIED_ORDERS.partialTurnover));
});

test.describe('FEED-06 stale', () => {
  test.use({ timezoneId: 'UTC' });

  test('"Stale data" notice with the snapshot as-of time; later launches are absent', async ({ page }) => {
    await page.goto(feedUrl({ scenario: 'stale' }));
    await waitForFeed(page);
    const notices = page.locator('body *').filter({ hasText: /Stale data/ }).filter({ hasText: /10:00/ });
    const compact = await notices.evaluateAll((els) => els.filter((el) => (el.textContent ?? '').length < 300).length);
    expect(compact, 'one compact notice carries both "Stale data" and the 10:00 UTC as-of time').toBeGreaterThan(0);
    await expect(page.getByText(/Stale data/).first()).toBeVisible();
    await expectRows(page, suffixes(VERIFIED_ORDERS.staleMarketCap));
    await expectCount(page, countLabel(STALE_ORGANIC.length));
  });
});
