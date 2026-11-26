import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { getAddress, type Address, type Hex } from 'viem';
import { KEEPER_WORDS, NATIVE, PM, WETH, alchemistAnswer, alchemistCode, figure, heading, localChain, logo, next, pileBook, row, serve, type AlchemistChain } from './alchemist-site';
import { brokenRuns, installUntouchableWallet, overflow, walletTouches } from './box-helpers';
import { m2RpcFixture } from '../src/features/core/v2/test-support/m2-rpc';
import { m3RpcFixture } from '../src/features/core/v2/test-support/m3-rpc';
import { publishedShopFees } from '../src/features/core/v2/test-support/shop-fees-published';
import { publishedAlchemistPile } from '../src/features/core/v2/test-support/alchemist-published';

// SH-V21-FE14 in the browser, at 1440 px (desktop project) and 375 px (mobile project): Into the shop with its ceiling in
// the creation flow (sample data); a shop with Into the shop and a coin pile with The Alchemist on their box pages
// (synthetic publications, through the real source, page and wallet boundary); and, on the local chain source, a book
// of 150 listed coins in the coin picker and The Alchemist offered for a PEPE-priced PAXG pile once the release's
// directory resolves a row (the indexer's book and the RPC answered here; nothing leaves the machine). No wallet is
// touched. SH_EVIDENCE_SCREENSHOTS=1 writes the pictures to docs/evidence/SH-V21-FE14/.
const width = (info: TestInfo) => (info.project.name === 'mobile' ? 375 : 1440);
async function shot(target: Page | Locator, info: TestInfo, name: string) {
  const path = process.env.SH_EVIDENCE_SCREENSHOTS === '1'
    ? fileURLToPath(new URL(`../../../docs/evidence/${process.env.SH_EVIDENCE_DIR ?? 'SH-V21-FE14'}/${name}-${width(info) === 375 ? '375' : 'desktop'}.png`, import.meta.url)) : info.outputPath(`${name}.png`);
  // The sticky bars stay in the flow for the picture: a full page draws them once, and none covers a part's top.
  const page = 'goto' in target ? target : target.page();
  const style = await page.addStyleTag({ content: '.sh-topbar, .sh-newbox__bar { position: static !important; }' });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  if ('goto' in target) await target.screenshot({ path, fullPage: true, scale: 'css' });
  else await target.screenshot({ path, scale: 'css' });
  await style.evaluate((node) => (node as Element).remove());
}
const LINE = 'Fees fill the shop up to a ceiling, then go to holders.';
const WARNING = 'Whoever picks the collections decides who can sell into a budget the fees pay for.';

test.beforeEach(async ({ page }, info) => {
  await installUntouchableWallet(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize(info.project.name === 'mobile' ? { width: 375, height: 812 } : { width: 1440, height: 900 });
});

test('SH-V21-FE14 create: Into the shop on the shop’s sellers’ side, its ceiling, the founder’s line and warning, the Overview', async ({ page }, info) => {
  await page.goto('/create/v2-basics');
  const templates = page.getByRole('region', { name: 'Start from a template' });
  await templates.getByRole('button', { name: /^Shop/ }).click();
  await page.getByRole('group', { name: /^Priced in/ }).getByRole('radio', { name: /^PAXG/ }).check();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Scrap Shop');
  await page.getByRole('textbox', { name: 'Ticker', exact: true }).fill('SCRAP');
  await page.locator('#create-logo').setInputFiles(logo);
  await expect(page.getByRole('button', { name: 'Logo Change' })).toBeAttached();
  await next(page);
  await page.getByRole('textbox', { name: 'Seed · SCRAP' }).fill('1000');
  for (const [i, price] of ['1', '2', '4', '8'].entries()) await page.getByRole('textbox', { name: `Tier ${i + 1}`, exact: true }).fill(price);
  await page.getByRole('textbox', { name: 'Collection 1' }).fill('0x00000000000000000000000000000000000000a1');
  await page.getByRole('textbox', { name: 'Collection 1' }).press('Tab');
  await next(page);
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 3 of 6: Fees');
  const buyers = page.getByRole('group', { name: /^Buyers’ fees/ }); const sellers = page.getByRole('group', { name: /^Sellers’ fees/ });
  // Offered on the sellers' side of every shop, never on the buyers'.
  await expect(buyers.getByRole('button', { name: 'Into the shop' })).toHaveCount(0);
  await sellers.getByRole('button', { name: 'Into the shop' }).click();
  await expect(sellers.getByRole('button', { name: 'Into the shop' })).toHaveAttribute('aria-pressed', 'true');
  const ceiling = sellers.getByRole('group', { name: 'Ceiling' });
  await expect(ceiling.getByRole('button')).toHaveText(['2x the seed2000 SCRAP', '4x the seed4000 SCRAP', '8x the seed8000 SCRAP']);
  await expect(ceiling.getByRole('button', { name: /^2x/ })).toHaveAttribute('aria-pressed', 'true');
  await ceiling.getByRole('button', { name: /^4x/ }).click();
  await expect(ceiling.getByRole('button', { name: /^4x/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(sellers.getByText(LINE, { exact: true })).toBeVisible();
  await expect(sellers.getByText(WARNING, { exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  expect(await brokenRuns(ceiling.locator('.sh-newbox-chips__row'))).toEqual([]);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await shot(page, info, 'create-shop-fees');
  await page.getByText('Fee details', { exact: true }).click();
  await expect(page.getByText(/The collection time decides, not the trade time/)).toBeVisible();
  await page.getByText('Fee details', { exact: true }).click();
  await next(page); await next(page);
  await page.getByRole('radio', { name: /^Now/ }).check();
  await page.getByRole('textbox', { name: 'Your PAXG at start' }).fill('0.05');
  await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check();
  await next(page);
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  const fees = page.getByRole('region', { name: 'Fees' });
  await expect(row(fees, 'Sellers’ fees')).toHaveText('Into the shop · ceiling 4x the seed (4000 SCRAP) · paid in SCRAP, used as PAXG');
  await expect(row(fees, 'Buyers’ fees')).toHaveText('To holders · in PAXG');
  await expect(fees.getByText(WARNING, { exact: true })).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await shot(page, info, 'create-shop-fees-overview');
  expect(await walletTouches(page)).toEqual([]);
});

test('SH-V21-FE14 box page: a shop with Into the shop shows its ceiling, budget, fees, waiting P and holders, and the warning', async ({ page }, info) => {
  const published = await publishedShopFees();
  await serve(page, published.body as never, m2RpcFixture().request);
  const fees = page.locator('section[data-shop-fees]');
  await expect(fees.getByRole('heading', { name: 'Fees into the shop', level: 3 })).toBeVisible({ timeout: 30_000 });
  // The fee part sits inside the one Shop region (FE13's specs find it by that name).
  await expect(page.getByRole('region', { name: 'Shop' })).toHaveCount(1);
  await expect(fees.locator('.sh-chip')).toHaveText('Filling');
  await expect(figure(fees, 'Ceiling')).toHaveText('2000 B52 · 2x the seed');
  await expect(figure(fees, 'Budget')).toHaveText('1000 B52');
  await expect(figure(fees, 'From fees')).toHaveText('12 B52');
  await expect(figure(fees, 'Waiting')).toHaveText(/^0\.5 /);
  await expect(figure(fees, 'To holders')).toHaveText(/^1 /);
  await expect(fees.getByText(LINE, { exact: true })).toBeVisible();
  await expect(fees.getByText(WARNING, { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Shop', exact: true })).not.toContainText('Fees do not fund');
  await expect(page.getByText('Into the shop · ceiling 2x the seed', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Holder fee share' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await shot(fees, info, 'shop-fees-panel');
  await fees.getByText('How fees fill the shop', { exact: true }).click();
  await expect(fees.getByText(/The collection time decides, not the trade time/)).toBeVisible();
  await shot(fees, info, 'shop-fees-details');
  await expect(page.getByRole('button', { name: /^(buy|sell|swap)$/i })).toHaveCount(0);
  expect(await walletTouches(page)).toEqual([]);
});

test('SH-V21-FE14 box page: a pile The Alchemist fills shows P converted, P waiting, PAXG added and the redeemable balance apart', async ({ page }, info) => {
  const published = await publishedAlchemistPile();
  const asset = published.asset as Address;
  const seeder = (published.row.record as unknown as { creator: Address }).creator;
  // The pile coin's listing reads its symbol on chain (indexer-listings.ts): PAXG at the pile's address.
  const pileRpc = m3RpcFixture({ symbol: 'PAXG', pile: { asset, seeder, seed: 0n, balance: 25n * 10n ** 17n, supply: 1_000_000n * 10n ** 18n, leaveBehindBps: 500n } });
  const chain: AlchemistChain = { price: NATIVE, pile: getAddress(asset), id: 4, route: [{ kind: 4, tokenIn: NATIVE, tokenOut: WETH, pool: PM, fee: 3000, tickSpacing: 60 }, { kind: 3, tokenIn: WETH, tokenOut: getAddress(asset), pool: getAddress('0x00000000000000000000000000000000000000a1'), fee: 3000, tickSpacing: 60 }] };
  await serve(page, published.body as never, async (call) => {
    if (call.method === 'eth_getCode') return alchemistCode(String(call.params?.[0])) ?? '0x';
    if (call.method === 'eth_call') {
      const tx = call.params?.[0] as { to: string; data: Hex };
      const answer = alchemistAnswer(chain, tx.to, tx.data);
      if (answer === null) throw Object.assign(new Error('execution reverted'), { code: 3 });
      if (answer !== undefined) return answer;
    }
    return pileRpc.request(call);
  }, pileBook(asset));
  const panel = page.getByRole('region', { name: 'Coin pile' });
  await expect(panel.locator('.sh-v2-value')).toHaveText('2.5 PAXG', { timeout: 30_000 });
  await expect(figure(panel, 'Redeemable')).toHaveText('2.5 PAXG');
  await expect(figure(panel, 'ETH converted')).toHaveText('1 ETH');
  await expect(figure(panel, 'ETH waiting')).toHaveText('0.3 ETH');
  await expect(figure(panel, 'Added by conversion')).toHaveText('0.5 PAXG');
  // RC5-B: the P of too-small steps kept for the box's own pool depth, apart from what the pile received.
  await expect(figure(panel, 'ETH added to pool depth')).toHaveText('0.00000000000000001 ETH');
  // The module checked out on chain as this release's Alchemist for ETH into PAXG: the side is named, the route listed.
  // SH-255: the side's name in the picture's Where the fees go (its station says it too).
  await expect(page.locator('.sh-bpic-ledger-place', { hasText: /^The Alchemist$/ })).toBeVisible({ timeout: 30_000 });
  // SH-ALCHEMIST-LESS-TEXT: the conversion figures above are in Pile details too, closed until pressed.
  await expect(figure(panel, 'ETH converted')).toBeHidden();
  await panel.getByText('Pile details', { exact: true }).click();
  await expect(figure(panel, 'ETH converted')).toBeVisible();
  // G1 A3: every hop at the 0.3% fee floor (a 0.05% hop is no Alchemist route since SH-V21-G1-FIX).
  await expect(panel.getByRole('list', { name: 'Conversion route' }).getByRole('listitem')).toHaveText(['ETH → 0x0000…00E2 · Uniswap v4 · 0.3%', '0x0000…00E2 → PAXG · Uniswap v3 · 0.3%']);
  // G1: the module's cap and trigger, read on chain, and the seven-day fallback.
  await expect(panel.getByText(/^Each step converts at most 0\.001 ETH; the rest waits for the next one\./)).toBeVisible();
  // RC5-B: only a step within the module's dust size stays for the box's own pool depth; graduation restarts the 7 days.
  await expect(panel.getByText(/A step of at most 0\.000000001 ETH that a pool would pay nothing for stays in this box instead, as ETH for its own pool’s next deepening/)).toBeVisible();
  await expect(panel.getByText(/FIT Safe/)).toHaveCount(0);
  await expect(panel.getByText(/Graduation and every step that goes through start the 7 days again; a refused try does not\./)).toBeVisible();
  await expect(panel.getByText(/^Only 0x1F14…4eeE starts a step, until a side has waited 7 days without one; before that, anyone else’s try is refused and nothing moves\./)).toBeVisible();
  await expect(panel.getByText('It knows no fair price. Once anyone may start a step, a trader can move a pool’s price just before it, within the 49 ticks; a step seen early can be traded around the same way.', { exact: true })).toBeVisible();
  await expect(panel.getByText(KEEPER_WORDS)).toHaveCount(0);
  // SH-APP8: the trigger's short address (and the route's unlisted coin) in tabular figures, as the Fees step's and the
  // Overview's rows draw it: in the body font's proportional figures its contextual alternates draw "0x1F14" as "0×1F14".
  const address = panel.locator('p > .sh-numeric');
  await expect(address).toHaveText('0x1F14…4eeE');
  await expect(address).toHaveCSS('font-variant-numeric', 'tabular-nums');
  await expect(address).toHaveCSS('white-space', 'nowrap');
  await expect(panel.getByRole('list', { name: 'Conversion route' })).toHaveCSS('font-variant-numeric', 'tabular-nums');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await shot(panel, info, 'alchemist-pile-panel');
  await shot(address.locator('xpath=..'), info, 'alchemist-pile-trigger');
  await expect(page.getByRole('button', { name: /^(buy|sell|swap)$/i })).toHaveCount(0);
  expect(await walletTouches(page)).toEqual([]);
});

test('SH-V21-FE14 create on a chain: 150 coins found by search and group, and The Alchemist for a PEPE-priced PAXG pile', async ({ page }, info) => {
  test.setTimeout(120_000);
  await localChain(page);
  await page.goto('/create/v2-basics');
  const coins = page.getByRole('group', { name: /^Priced in/ });
  await expect(coins.getByText('150 coins')).toBeVisible({ timeout: 30_000 });
  for (const group of ['Native', 'Stablecoins', 'Stock-linked', 'Box coins', 'Other coins']) await expect(coins.getByRole('group', { name: group })).toBeVisible();
  await expect(coins.getByRole('group', { name: 'Other coins' }).getByRole('button', { name: /^Show all \d+$/ })).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await shot(coins, info, 'coin-picker-groups');
  await coins.getByRole('searchbox', { name: 'Find a coin · Priced in' }).fill('pepe');
  await expect(coins.getByText('1 of 150')).toBeVisible();
  await coins.getByRole('radio', { name: /^PEPE/ }).check();
  await shot(coins, info, 'coin-picker-search');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Lead Pile');
  await page.getByRole('textbox', { name: 'Ticker', exact: true }).fill('LEAD');
  await page.locator('#create-logo').setInputFiles(logo);
  await expect(page.getByRole('button', { name: 'Logo Change' })).toBeAttached();
  await next(page);
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 2 of 6: Contents');
  await page.getByRole('radio', { name: /^Token/ }).check();
  await page.getByRole('group', { name: /^Coin pile/ }).getByRole('radio', { name: /^Coin pile/ }).check();
  const seedCoin = page.getByRole('group', { name: 'Seed coin' });
  await seedCoin.getByRole('searchbox', { name: 'Find a coin · Seed coin' }).fill('PAXG');
  await seedCoin.getByRole('radio', { name: 'PAXG', exact: true }).check();
  await page.getByRole('textbox', { name: /^Seed · PAXG/ }).fill('0');
  await page.getByRole('group', { name: 'Leave behind' }).getByRole('radio', { name: '5%' }).check();
  await next(page);
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 3 of 6: Fees');
  const buyers = page.getByRole('group', { name: /^Buyers’ fees · in PEPE/ });
  // Offered once the release's directory resolved row 4 for PEPE into PAXG, with the route its helper holds.
  await buyers.getByRole('button', { name: 'The Alchemist' }).click({ timeout: 30_000 });
  await expect(buyers.getByRole('button', { name: 'The Alchemist' })).toHaveAttribute('aria-pressed', 'true');
  const route = buyers.locator('[data-alchemist="4"]');
  // SH-ALCHEMIST-LESS-TEXT: the route, its limits and its trigger wait behind the side's closed Details.
  await expect(route.getByText('Route · row 4')).toBeHidden();
  await route.getByRole('button', { name: 'Details: Alchemist, buyers’ fees' }).click();
  await expect(route.getByText('Route · row 4')).toBeVisible();
  await expect(route.locator('.sh-v2-route li')).toHaveText(['PEPE → WETH · Uniswap v3 · 1%', 'WETH → PAXG · Uniswap v2 · 0.3%']);
  await expect(route.getByText('Fees wait until graduation, then convert into PAXG along this route.')).toBeVisible();
  // G1: the row's admitted cap and fixed trigger, before the side is confirmed.
  await expect(row(route, 'Each step')).toHaveText('Up to 0.001 PEPE');
  await expect(row(route, 'Too small')).toHaveText('0.000000001 PEPE or less stays in the box’s pool depth');
  await expect(row(route, 'Started by')).toHaveText('0x1F14…4eeE · anyone after 7 days without a step');
  await expect(row(route, 'Started by')).toHaveCSS('font-variant-numeric', 'tabular-nums');
  await expect(page.getByText(KEEPER_WORDS)).toHaveCount(0);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await shot(page, info, 'create-alchemist-fees');
  await next(page); await next(page);
  await page.getByRole('radio', { name: /^Now/ }).check();
  await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check();
  await next(page);
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  const fees = page.getByRole('region', { name: 'Fees' });
  await expect(row(fees, 'Buyers’ fees')).toHaveText('The Alchemist · row 4 · in PEPE');
  await expect(row(fees, 'Route')).toHaveText('PEPE → WETH · Uniswap v3 · 1% · then WETH → PAXG · Uniswap v2 · 0.3%');
  await expect(row(fees, 'Each step')).toHaveText('Up to 0.001 PEPE');
  await expect(row(fees, 'Too small')).toHaveText('0.000000001 PEPE or less stays in the box’s pool depth');
  await expect(row(fees, 'Started by')).toHaveText('0x1F14…4eeE · anyone after 7 days without a step');
  await expect(row(fees, 'Started by')).toHaveCSS('font-variant-numeric', 'tabular-nums');
  await expect(fees.getByText(KEEPER_WORDS)).toHaveCount(0);
  // SH-APP8: true for any trigger, the deployer's public steps included, not only after the 7 days. SH-ALCHEMIST-LESS-TEXT:
  // with the route, limits and trigger behind the Fees section's closed Details.
  await expect(fees.getByText('A trader can move a pool’s price just before any step.', { exact: true })).toBeHidden();
  await fees.getByRole('button', { name: 'Details: Alchemist' }).click();
  await expect(fees.getByText('A trader can move a pool’s price just before any step.', { exact: true })).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await shot(page, info, 'create-alchemist-overview');
  expect(await walletTouches(page)).toEqual([]);
});
