import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { getAddress, type Address, type Hex } from 'viem';
import { NATIVE, PM, WETH, alchemistAnswer, alchemistCode, heading, localChain, logo, next, pileBook, readingLoad, row, serve, type AlchemistChain, type ReadingLoad } from './alchemist-site';
import { installUntouchableWallet, overflow, walletTouches } from './box-helpers';
import { m3RpcFixture } from '../src/features/core/v2/test-support/m3-rpc';
import { publishedAlchemistPile } from '../src/features/core/v2/test-support/alchemist-published';

// SH-ALCHEMIST-LESS-TEXT in the browser, at 1440 px (desktop project) and 375 px (mobile project): The Alchemist's three
// surfaces on the data of the founder's pictures (alchemist-site.ts: a PEPE-priced PAXG pile, row 4, its trigger the
// founder's deployer). Each default view shows exactly the agreed text with its Details closed; a press (Enter and Space
// on desktop, a tap on the phone) opens it in place and shows every moved line without moving anything above it; Escape
// or a second press closes it, and a new visit starts closed. No wallet is touched. SH_EVIDENCE_SCREENSHOTS=1 writes the
// pictures, closed and open, and each view's reading load to docs/evidence/SH-ALCHEMIST-LESS-TEXT/.
const DIR = process.env.SH_EVIDENCE_DIR ?? 'SH-ALCHEMIST-LESS-TEXT';
const EVIDENCE = process.env.SH_EVIDENCE_SCREENSHOTS === '1';
const width = (info: TestInfo) => (info.project.name === 'mobile' ? '375' : 'desktop');
const evidencePath = (info: TestInfo, file: string) => (EVIDENCE ? fileURLToPath(new URL(`../../../docs/evidence/${DIR}/${file}`, import.meta.url)) : info.outputPath(file));
async function shot(target: Page | Locator, info: TestInfo, name: string) {
  const path = evidencePath(info, `${name}-${width(info)}.png`);
  // The sticky bars stay in the flow for the picture: a full page draws them once, and none covers a part's top.
  const page = 'goto' in target ? target : target.page();
  const style = await page.addStyleTag({ content: '.sh-topbar, .sh-newbox__bar { position: static !important; }' });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  if ('goto' in target) await target.screenshot({ path, fullPage: true, scale: 'css' });
  else await target.screenshot({ path, scale: 'css' });
  await style.evaluate((node) => (node as Element).remove());
}
/** A view's reading load, closed and open, beside its pictures (the evidence's after figures). */
const keepLoad = (info: TestInfo, name: string, load: { closed: ReadingLoad; open: ReadingLoad }) =>
  writeFileSync(evidencePath(info, `${name}-load-${width(info)}.json`), `${JSON.stringify(load, null, 1)}\n`);
const texts = (load: ReadingLoad) => load.blocks.map((block) => block.text);
/** Where an element starts on the page (not in the viewport, which a tap may scroll). */
const top = (target: Locator) => target.evaluate((element) => element.getBoundingClientRect().top + window.scrollY);

/**
 * Opens a Details button the way each project's user would (Enter on desktop, a tap on the phone), checks it reports
 * itself open and that its panel shows, and returns the panel.
 */
async function press(page: Page, info: TestInfo, button: Locator): Promise<Locator> {
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  const panel = page.locator(`[id="${await button.getAttribute('aria-controls')}"]`);
  await expect(panel).toBeHidden();
  if (info.project.name === 'mobile') await button.tap();
  else { await button.focus(); await page.keyboard.press('Enter'); }
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(panel).toBeVisible();
  return panel;
}
/**
 * Closes it again: on desktop Escape, pressed on `from` (a control inside the panel, else the button), closes it and
 * puts focus back on the button; on the phone a second tap.
 */
async function close(page: Page, info: TestInfo, button: Locator, panel: Locator, from: Locator = button) {
  if (info.project.name === 'mobile') await button.tap();
  else {
    await from.focus();
    await page.keyboard.press('Escape');
    await expect(button).toBeFocused();
    // The site's focus ring shows on the button the keyboard returned to.
    await expect(button).toHaveCSS('outline-style', 'solid');
    await expect(button).toHaveCSS('outline-width', '3px');
  }
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(panel).toBeHidden();
}

test.beforeEach(async ({ page }, info) => {
  await installUntouchableWallet(page);
  // The pictures show a view as it stays: without the browser's brief tap highlight (touch feedback) on a tapped button.
  await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.textContent = '* { -webkit-tap-highlight-color: transparent; }';
    document.head.append(style);
  }));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize(info.project.name === 'mobile' ? { width: 375, height: 812 } : { width: 1440, height: 900 });
});

const CHIPS = ['Keep', 'Buy back and burn LEAD', 'Grow the pool', 'To holders', 'The Alchemist'];
const FEES_DEFAULT = ['1% of every trade: in PEPE on buys, in LEAD on sales', 'You choose where 10/15 goes',
  'Buyers’ fees · in PEPE', ...CHIPS, 'Details', 'Sellers’ fees · paid in LEAD, used as PEPE', ...CHIPS, 'Fee details', 'Sale list'];
const ROUTE = ['PEPE → WETH · Uniswap v3 · 1%', 'WETH → PAXG · Uniswap v2 · 0.3%'];
const LINE = 'Fees wait until graduation, then convert into PAXG along this route.';
const STARTED_BY = '0x1F14…4eeE · anyone after 7 days without a step';
const TOO_SMALL = '0.000000001 PEPE or less stays in the box’s pool depth';
const WARNING = 'A trader can move a pool’s price just before any step.';
const OVERVIEW_DEFAULT = ['Fees', 'Edit', 'Buyers’ fees', 'The Alchemist · row 4 · in PEPE', 'Sellers’ fees', 'Buy back and burn LEAD · paid in LEAD, used as PEPE', 'Details'];

test('SH-ALCHEMIST-LESS-TEXT create: the Fees step and the Overview show the choice; the route, limits, trigger and warning wait behind a closed Details', async ({ page }, info) => {
  test.setTimeout(120_000);
  await localChain(page);
  await page.goto('/create/v2-basics');
  const coins = page.getByRole('group', { name: /^Priced in/ });
  await expect(coins.getByText('150 coins')).toBeVisible({ timeout: 30_000 });
  await coins.getByRole('searchbox', { name: 'Find a coin · Priced in' }).fill('pepe');
  await coins.getByRole('radio', { name: /^PEPE/ }).check();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Lead Pile');
  await page.getByRole('textbox', { name: 'Ticker', exact: true }).fill('LEAD');
  await page.locator('#create-logo').setInputFiles(logo);
  await expect(page.getByRole('button', { name: 'Logo Change' })).toBeAttached();
  await next(page);
  await page.getByRole('radio', { name: /^Token/ }).check();
  await page.getByRole('group', { name: /^Coin pile/ }).getByRole('radio', { name: /^Coin pile/ }).check();
  const seedCoin = page.getByRole('group', { name: 'Seed coin' });
  await seedCoin.getByRole('searchbox', { name: 'Find a coin · Seed coin' }).fill('PAXG');
  await seedCoin.getByRole('radio', { name: 'PAXG', exact: true }).check();
  await page.getByRole('textbox', { name: /^Seed · PAXG/ }).fill('0');
  await page.getByRole('group', { name: 'Leave behind' }).getByRole('radio', { name: '5%' }).check();
  await next(page);
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 3 of 6: Fees');
  const form = page.locator('form.sh-newbox__form');
  const buyers = page.getByRole('group', { name: /^Buyers’ fees · in PEPE/ });
  const sellers = page.getByRole('group', { name: /^Sellers’ fees · paid in LEAD, used as PEPE/ });
  await buyers.getByRole('button', { name: 'The Alchemist' }).click({ timeout: 30_000 });
  await expect(buyers.getByRole('button', { name: 'The Alchemist' })).toHaveAttribute('aria-pressed', 'true');
  const block = buyers.locator('[data-alchemist="4"]');
  const details = block.getByRole('button', { name: 'Details: Alchemist, buyers’ fees' });
  await expect(details).toBeVisible();
  await expect(details).toHaveText('Details');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));

  // The default view, word for word: the step's two lines, each side's chips, one closed Details, Fee details, Sale list.
  const feesClosed = await readingLoad(form, '.sh-newbox__bar');
  expect(texts(feesClosed)).toEqual(FEES_DEFAULT);
  for (const hidden of ['Route · row 4', ...ROUTE, 'Each step', 'Too small', 'Started by', LINE, 'Inbox money follows the buyers’ side.']) {
    await expect(page.getByText(hidden, { exact: true }), hidden).toBeHidden();
  }
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await shot(page, info, 'create-alchemist-fees-closed');

  // Opened in place: the chips and the button keep their place; the route, limits, trigger, line and Terms link show.
  const chipsTop = await top(buyers.getByRole('button', { name: 'The Alchemist' }));
  const buttonTop = await top(details);
  const panel = await press(page, info, details);
  expect(await top(buyers.getByRole('button', { name: 'The Alchemist' }))).toBe(chipsTop);
  expect(await top(details)).toBe(buttonTop);
  await expect(panel.getByText('Route · row 4', { exact: true })).toBeVisible();
  await expect(panel.locator('.sh-v2-route li')).toHaveText(ROUTE);
  await expect(row(panel, 'Each step')).toHaveText('Up to 0.001 PEPE');
  await expect(row(panel, 'Too small')).toHaveText(TOO_SMALL);
  await expect(row(panel, 'Started by')).toHaveText(STARTED_BY);
  await expect(row(panel, 'Started by')).toHaveCSS('font-variant-numeric', 'tabular-nums');
  await expect(panel.getByText(LINE, { exact: true })).toBeVisible();
  await expect(panel.getByRole('link', { name: 'Terms, Section 6' })).toHaveAttribute('href', '/about/terms#terms-6');
  const feesOpen = await readingLoad(form, '.sh-newbox__bar');
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await shot(page, info, 'create-alchemist-fees-open');
  if (EVIDENCE) keepLoad(info, 'create-alchemist-fees', { closed: feesClosed, open: feesOpen });
  await close(page, info, details, panel, panel.getByRole('link', { name: 'Terms, Section 6' }));
  if (info.project.name !== 'mobile') {
    // Space toggles it too, as any button.
    await details.focus();
    await page.keyboard.press('Space');
    await expect(details).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Space');
    await expect(details).toHaveAttribute('aria-expanded', 'false');
  }
  // The inbox line moved into Fee details, after the inbox paragraph it sums up.
  await page.getByText('Fee details', { exact: true }).click();
  await expect(page.getByText('Inbox money follows the buyers’ side.', { exact: true })).toBeVisible();
  await page.getByText('Fee details', { exact: true }).click();

  // The Alchemist on the sellers' side alone: its own closed Details holds the inbox note.
  await sellers.getByRole('button', { name: 'The Alchemist' }).click();
  await buyers.getByRole('button', { name: 'Buy back and burn LEAD' }).click();
  const note = page.getByText('The inbox will not feed the sellers’ Alchemist.', { exact: true });
  await expect(note).toBeHidden();
  const sellerDetails = sellers.getByRole('button', { name: 'Details: Alchemist, sellers’ fees' });
  const sellerPanel = await press(page, info, sellerDetails);
  await expect(sellerPanel.getByText('The inbox will not feed the sellers’ Alchemist.', { exact: true })).toBeVisible();
  await close(page, info, sellerDetails, sellerPanel);
  await buyers.getByRole('button', { name: 'The Alchemist' }).click();
  await sellers.getByRole('button', { name: 'Buy back and burn LEAD' }).click();
  await expect(buyers.getByRole('button', { name: 'Details: Alchemist, buyers’ fees' })).toHaveAttribute('aria-expanded', 'false');

  await next(page); await next(page);
  await page.getByRole('radio', { name: /^Now/ }).check();
  await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check();
  await next(page);
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  const fees = page.getByRole('region', { name: 'Fees' });
  const more = fees.getByRole('button', { name: 'Details: Alchemist' });
  // The default view of the Fees section, word for word: its two side rows and one closed Details.
  const overviewClosed = await readingLoad(fees);
  expect(texts(overviewClosed)).toEqual(OVERVIEW_DEFAULT);
  for (const hidden of ['Route', 'Each step', 'Too small', 'Started by', WARNING]) await expect(fees.getByText(hidden, { exact: true }), hidden).toBeHidden();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await shot(page, info, 'create-alchemist-overview-closed');
  const editTop = await top(fees.getByRole('link', { name: 'Edit Fees' }));
  const moreTop = await top(more);
  const overviewPanel = await press(page, info, more);
  expect(await top(fees.getByRole('link', { name: 'Edit Fees' }))).toBe(editTop);
  expect(await top(more)).toBe(moreTop);
  await expect(row(overviewPanel, 'Route')).toHaveText(`${ROUTE[0]} · then ${ROUTE[1]}`);
  await expect(row(overviewPanel, 'Each step')).toHaveText('Up to 0.001 PEPE');
  await expect(row(overviewPanel, 'Too small')).toHaveText(TOO_SMALL);
  await expect(row(overviewPanel, 'Started by')).toHaveText(STARTED_BY);
  // The warning keeps its warning style inside the panel, then the Terms link.
  await expect(overviewPanel.locator('.sh-newbox-warnings li')).toHaveText(WARNING);
  await expect(overviewPanel.getByRole('link', { name: 'Terms, Section 6' })).toHaveAttribute('href', '/about/terms#terms-6');
  const overviewOpen = await readingLoad(fees);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await shot(page, info, 'create-alchemist-overview-open');
  if (EVIDENCE) keepLoad(info, 'create-alchemist-overview', { closed: overviewClosed, open: overviewOpen });

  // Nothing remembers an open panel: back at Fees and again at the Overview, both start closed.
  await fees.getByRole('link', { name: 'Edit Fees' }).click();
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 3 of 6: Fees');
  await expect(buyers.getByRole('button', { name: 'Details: Alchemist, buyers’ fees' })).toHaveAttribute('aria-expanded', 'false');
  await page.goBack();
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  await expect(fees.getByRole('button', { name: 'Details: Alchemist' })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: /^(buy|sell|swap)$/i })).toHaveCount(0);
  expect(await walletTouches(page)).toEqual([]);
});

const PILE_DEFAULT = ['Coin pile', '2.5 PAXG', 'Redeem open', 'Per HOARD', '0.000002375 PAXG', 'Coins sent to the pile by mistake cannot be recovered.',
  'HOARD to redeem', 'Approve coins', 'Redeem', 'Pile details'];
const PILE_FIGURES: readonly (readonly [string, string])[] = [['Seed', '0 PAXG'], ['HOARD out', '1000000 HOARD'], ['Leave behind', '5%'], ['Redeemable', '2.5 PAXG'],
  ['ETH converted', '1 ETH'], ['ETH waiting', '0.3 ETH'], ['Added by conversion', '0.5 PAXG'], ['ETH added to pool depth', '0.00000000000000001 ETH']];

async function alchemistPile(page: Page) {
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
  // The module checked out on chain as The Alchemist (the side is named), so the panel holds its route and trigger.
  // SH-255: the side's name in the picture's Where the fees go (the Fees card's row before it).
  await expect(page.locator('.sh-bpic-ledger-place', { hasText: /^The Alchemist$/ })).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  return panel;
}

test('SH-ALCHEMIST-LESS-TEXT box page: the coin pile shows the pile, what one coin gets, the no-rescue line and the redeem box; every other figure and paragraph waits behind a closed Pile details', async ({ page }, info) => {
  const panel = await alchemistPile(page);
  const details = panel.getByRole('button', { name: 'Pile details', exact: true });
  // The default view, word for word, and the one visible sentence (it guards against a loss nobody can undo).
  const closed = await readingLoad(panel);
  expect(texts(closed)).toEqual(PILE_DEFAULT);
  for (const [label] of PILE_FIGURES) await expect(panel.getByText(label, { exact: true }), label).toBeHidden();
  await expect(panel.getByText(/^Only 0x1F14…4eeE starts a step/)).toBeHidden();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await shot(panel, info, 'alchemist-pile-panel-closed');

  // Opened below the actions: the redeem box and its two buttons stay exactly where they were.
  const redeem = panel.getByRole('group', { name: 'Redeem' });
  const before = await Promise.all([redeem, panel.getByRole('button', { name: 'Approve coins' }), panel.getByRole('button', { name: 'Redeem', exact: true }), details].map(top));
  const pileDetails = await press(page, info, details);
  expect(await Promise.all([redeem, panel.getByRole('button', { name: 'Approve coins' }), panel.getByRole('button', { name: 'Redeem', exact: true }), details].map(top))).toEqual(before);
  for (const [label, value] of PILE_FIGURES) {
    await expect(pileDetails.locator('dt', { hasText: new RegExp(`^${label}$`) }), label).toBeVisible();
    await expect(pileDetails.locator('dt', { hasText: new RegExp(`^${label}$`) }).locator('xpath=following-sibling::dd[1]'), label).toHaveText(value);
  }
  await expect(pileDetails.getByRole('list', { name: 'Conversion route' }).getByRole('listitem')).toHaveText(['ETH → 0x0000…00E2 · Uniswap v4 · 0.3%', '0x0000…00E2 → PAXG · Uniswap v3 · 0.3%']);
  await expect(pileDetails.getByText(/^Only 0x1F14…4eeE starts a step, until a side has waited 7 days without one;/)).toBeVisible();
  await expect(pileDetails.getByText('It knows no fair price. Once anyone may start a step, a trader can move a pool’s price just before it, within the 49 ticks; a step seen early can be traded around the same way.', { exact: true })).toBeVisible();
  await expect(pileDetails.getByText(/^If the box fails, only the recorded seed goes back to the creator/)).toBeVisible();
  await expect(pileDetails.getByText(/^Redeeming calls approve\(pile, coins\) on HOARD/)).toBeVisible();
  const open = await readingLoad(panel);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await shot(panel, info, 'alchemist-pile-panel-open');
  if (EVIDENCE) keepLoad(info, 'alchemist-pile-panel', { closed, open });
  await close(page, info, details, pileDetails);

  // A new page load starts closed again: nothing stores the open state.
  await press(page, info, details);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Coin pile' }).locator('.sh-v2-value')).toHaveText('2.5 PAXG', { timeout: 30_000 });
  await expect(page.getByRole('region', { name: 'Coin pile' }).getByRole('button', { name: 'Pile details', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: /^(buy|sell|swap)$/i })).toHaveCount(0);
  expect(await walletTouches(page)).toEqual([]);
});
