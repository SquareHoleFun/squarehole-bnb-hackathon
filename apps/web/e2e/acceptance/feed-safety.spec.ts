import { expect, test, type Page } from '@playwright/test';
import { byName, canonicalId, expectedIds, pairPath, startsWith } from './expected';
import {
  FEED_PATH,
  expectRows,
  feedUrl,
  installWalletSpy,
  lifecycleSelect,
  revealControls,
  rewardSelect,
  row,
  searchbox,
  searchParams,
  sortRadio,
  typeRadio,
  waitForFeed,
  type Scenario,
} from './helpers';

// FEED-08 / EXT-04 / UI-09: browsing never asks the wallet for anything. UI-01 / EXT-01: no trading surface anywhere.

const FORBIDDEN_NAME = /\b(buy|sell|swap)\b|trade amount|\bamount\b/i;
const ROLES = ['button', 'link', 'textbox', 'spinbutton', 'combobox', 'tab', 'menuitem', 'radio', 'checkbox', 'slider', 'searchbox'] as const;

async function expectNoTradingSurface(page: Page, where: string): Promise<void> {
  for (const role of ROLES) {
    await expect(page.getByRole(role, { name: FORBIDDEN_NAME }), `${where}: ${role} named buy/sell/swap/amount`).toHaveCount(0);
  }
  await expect(page.getByLabel(FORBIDDEN_NAME), `${where}: labelled buy/sell/swap/amount`).toHaveCount(0);
  await expect(page.locator('input[type="number"]'), `${where}: number input`).toHaveCount(0);
  await expect(page.locator('iframe, frame, object, embed'), `${where}: embedded frame`).toHaveCount(0);
  await expect(page.getByRole('dialog'), `${where}: no dialog opened by browsing`).toHaveCount(0);
}

test('UI-09: loading the feed makes no wallet request', async ({ page }) => {
  const calls = await installWalletSpy(page);
  let dialogs = 0;
  page.on('dialog', (d) => {
    dialogs += 1;
    void d.dismiss();
  });
  await page.goto(FEED_PATH);
  await waitForFeed(page);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1_000);
  expect(calls()).toEqual([]);
  expect(dialogs).toBe(0);
});

test('FEED-08: browse, search, sort, filter, open a row and come back: zero wallet requests', async ({ page }) => {
  const calls = await installWalletSpy(page);
  await page.goto(FEED_PATH);
  await waitForFeed(page);

  await searchbox(page).fill('orch');
  await expect.poll(() => searchParams(page).q).toBe('orch');
  await expectRows(page, expectedIds({ q: 'orch' }));
  await searchbox(page).fill('');
  await expectRows(page, expectedIds({}));

  await revealControls(page);
  await sortRadio(page, 'New').check();
  await expectRows(page, expectedIds({ sort: 'new' }));
  await sortRadio(page, 'Turnover (24h)').check();
  await expectRows(page, expectedIds({ sort: 'turnover' }));
  await typeRadio(page, 'NFT collections').check();
  await rewardSelect(page).selectOption('T');
  await lifecycleSelect(page).selectOption('curve');
  await expectRows(page, expectedIds({ sort: 'turnover', type: 'nft_collection', reward: 'T', lifecycle: 'curve' }));
  await typeRadio(page, 'All').check();
  await rewardSelect(page).selectOption('');
  await lifecycleSelect(page).selectOption('');
  await sortRadio(page, 'Market cap').check();
  await expectRows(page, expectedIds({}));

  const pair = byName('ORCHARD');
  const link = row(page, canonicalId(pair)).getByRole('link', { name: startsWith(pair.name) }).first();
  await link.click();
  await expect(page).toHaveURL(new RegExp(`${pairPath(pair)}$`));
  await page.goBack();
  await waitForFeed(page);
  await expectRows(page, expectedIds({}));
  await page.waitForTimeout(500);
  expect(calls()).toEqual([]);
});

const SCENARIOS: Scenario[] = ['default', 'loading', 'stale', 'partial', 'unavailable', 'no_launches', 'root_unlaunched', 'ranking_updated'];

for (const scenario of SCENARIOS) {
  test(`UI-01 / UI-09 (${scenario}): no trading surface and no wallet request`, async ({ page }) => {
    const calls = await installWalletSpy(page);
    await page.goto(feedUrl({ scenario }));
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(300);
    await expectNoTradingSurface(page, scenario);
    expect(calls()).toEqual([]);
  });
}

test('UI-01: the pair detail route reached from a row has no trading surface either', async ({ page }) => {
  const calls = await installWalletSpy(page);
  await page.goto(FEED_PATH);
  await waitForFeed(page);
  const pair = byName('NO PRICE YET');
  await row(page, canonicalId(pair)).getByRole('link', { name: startsWith(pair.name) }).first().click();
  await expect(page).toHaveURL(new RegExp(`${pairPath(pair)}$`));
  await expectNoTradingSurface(page, pairPath(pair));
  expect(calls()).toEqual([]);
});
