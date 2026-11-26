import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectTestWallet } from './test-wallet';

// SH-288: the card shop's page on a local fork of BSC Testnet seeded by scripts/seed-shop.mjs (scripts/shop-fork.sh):
// the token's collection, a card for the token and the token for a card, the tax waiting and its Refill, each read back
// on the page and on chain; the link from the Flap sale's page; a shop not created yet; no wallet request on load.
// SHOP_PICTURES=<https origin>: the cards' pictures are asked of that site's /ipfs/ route (read only), as the live page
// asks its own; without it the cards keep their empty tiles.
const here = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.PILE_RPC ?? 'http://127.0.0.1:8581';
const SHOTS = process.env.SHOP_SHOTS ?? path.join(here, '../test-results/shop');
const PICTURES = process.env.SHOP_PICTURES ?? '';
const seed = JSON.parse(fs.readFileSync(path.join(here, '../public/local/shop-seed.json'), 'utf8')) as {
  account: string; token: string; factory: string; shop: string; collections: string[];
  stocked: { nft: string; id: string }[]; kept: { nft: string; id: string }[]; sale: { launcher: string; token: string } | null; saleShop: string | null; strangerShop: string | null;
};
const Q = '?addresses=local/shop-addresses.json';
test.describe.configure({ mode: 'serial' });

const call = async (method: string, params: unknown[]) => {
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = (await res.json()) as { result: string; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result;
};
const word = (n: bigint) => n.toString(16).padStart(64, '0');
const ownerOf = async (nft: string, id: bigint) => `0x${(await call('eth_call', [{ to: nft, data: '0x6352211e' + word(id) }, 'latest'])).slice(-40)}`;
const balanceOf = async (token: string, who: string) => BigInt(await call('eth_call', [{ to: token, data: '0x70a08231' + who.slice(2).toLowerCase().padStart(64, '0') }, 'latest']));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true });
  // The bar and the menu in the flow for the picture (a full page draws a sticky bar where the page was scrolled).
  const style = await page.addStyleTag({ content: '.sh-topbar, .sh-menu { position: static !important; }' });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
  await style.evaluate((n) => (n as Element).remove());
}
async function open(page: Page) {
  if (PICTURES) {
    await page.route('**/ipfs/**', async (route) => {
      const url = new URL(route.request().url());
      const r = await fetch(`${PICTURES}${url.pathname}`, { redirect: 'error' }).catch(() => null);
      if (!r) return route.fulfill({ status: 502 });
      return route.fulfill({ status: r.status, contentType: r.headers.get('content-type') ?? 'application/octet-stream', body: Buffer.from(await r.arrayBuffer()) });
    });
  }
  await injectTestWallet(page, RPC, 0);
  await page.goto(`/${Q}#/shop/${seed.shop}`);
  await expect(page.getByTestId('shop-page')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('shop-card').first()).toBeVisible({ timeout: 30_000 });
}
const done = (page: Page, box: string, label: string) =>
  expect(page.getByTestId(box).getByTestId('tx-status')).toContainText(`${label}: done`, { timeout: 60_000 });

test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByTestId('press-close'), (close) => close.click());
});

test('the token’s collection: the names, the grid, the prices; no wallet request on load', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('shop-names')).toContainText('Common · Uncommon · Rare · Legendary');
  const cards = page.getByRole('list', { name: 'Cards inside' }).getByRole('button');
  await expect(cards).toHaveCount(seed.stocked.length);
  await expect(cards.first()).toHaveAttribute('aria-label', /^Test Trading Cards Common · 0x675A…A174 #9001, 2,000 SHOPT$/);
  await expect(page.getByTestId('shop-budget')).toContainText('20,000');
  await expect(page.getByTestId('shop-cap')).toContainText('12,000');
  // The test token was launched on neither rail in the file: who made it is said, nothing more.
  await expect(page.getByTestId('shop-maker')).toHaveAttribute('data-maker', 'unknown', { timeout: 30_000 });
  await expect(page.getByTestId('shop-waiting')).toContainText('0.01');
  expect(await page.evaluate(() => (window as unknown as { __wallet: { requests: string[] } }).__wallet.requests)).toEqual([]);
  for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    if (PICTURES) await expect.poll(() => page.locator('[data-picture="shown"]').count(), { timeout: 30_000 }).toBeGreaterThan(0);
    await shot(page, `shop-${size.width}`);
    // The grid's tallest state: scrolled to its end, its last card inside it.
    const grid = page.getByRole('list', { name: 'Cards inside' });
    await grid.evaluate((n) => { n.scrollTop = n.scrollHeight; });
    await cards.last().scrollIntoViewIfNeeded();
    const last = await cards.last().boundingBox(); const box = await grid.boundingBox();
    expect(last && box && last.y >= box.y - 1 && last.y + last.height <= box.y + box.height + 1).toBeTruthy();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await shot(page, `shop-end-${size.width}`);
    await grid.evaluate((n) => { n.scrollTop = 0; });
  }
});

test('the token for a card: approve the exact price, get the card, read back', async ({ page }) => {
  await open(page);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('account')).toBeVisible();
  const card = seed.stocked.find((c) => same(c.nft, seed.collections[2]!))!; // a Rare: 8,000 SHOPT
  const before = await balanceOf(seed.token, seed.account);
  await page.getByRole('button', { name: new RegExp(`#${card.id}, 8,000 SHOPT$`) }).first().click();
  await expect(page.getByRole('list', { name: 'Cards inside' }).locator('[aria-pressed="true"]')).toHaveCount(1);
  await shot(page, 'shop-chosen-1440');
  await page.getByTestId('pick').click();
  await done(page, 'pick-box', 'Get this card');
  expect(same(await ownerOf(card.nft, BigInt(card.id)), seed.account)).toBe(true);
  expect(before - (await balanceOf(seed.token, seed.account))).toBe(8_000n * 10n ** 18n);
  await expect(page.getByRole('list', { name: 'Cards inside' }).getByRole('button')).toHaveCount(seed.stocked.length - 1);
  await expect(page.getByTestId('shop-budget')).toContainText('28,000');
  // A pick gives its give price (4,000) back to this period's room: shown as it is, above the 12,000 cap.
  await expect(page.getByTestId('shop-cap')).toContainText('16,000 SHOPT');
});

test('a card for the token: your own cards as tiles, select one, one press, read back', async ({ page }) => {
  await open(page);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('account')).toBeVisible();
  const box = page.getByTestId('give-box');
  const yours = box.getByRole('list', { name: 'Your cards' }).getByRole('button');
  // The wallet holds the two cards it kept (Common and Uncommon #9004, never picked here) and the Rare it picked.
  await expect(yours).toHaveCount(3, { timeout: 30_000 });
  const kept = seed.kept[0]!; // Common #9004: 1,000 SHOPT
  const tile = box.getByRole('button', { name: new RegExp(`Common · 0x675A…A174 #${kept.id}, 1,000 SHOPT$`) });
  await tile.click();
  await expect(tile).toHaveAttribute('aria-pressed', 'true');
  await box.scrollIntoViewIfNeeded();
  await shot(page, 'shop-own-cards-1440');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, 'shop-own-cards-390');
  await page.setViewportSize({ width: 1440, height: 900 });
  const before = await balanceOf(seed.token, seed.account);
  await box.getByTestId('give').click();
  await done(page, 'give-box', 'Get SHOPT');
  expect(same(await ownerOf(kept.nft, BigInt(kept.id)), seed.shop)).toBe(true);
  expect((await balanceOf(seed.token, seed.account)) - before).toBe(1_000n * 10n ** 18n);
  // The period's room: 12,000, plus the Rare's 4,000 given back by the pick, less this 1,000.
  await expect(page.getByTestId('shop-cap')).toContainText('15,000 SHOPT');
  await expect(yours).toHaveCount(2, { timeout: 30_000 });
});

test('a wallet with none of these cards reads one line, and no press to give', async ({ page }) => {
  await injectTestWallet(page, RPC, 1); // the fork's second account: no card of these collections
  await page.goto(`/${Q}#/shop/${seed.shop}`);
  await expect(page.getByTestId('shop-card').first()).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('account')).toBeVisible();
  const box = page.getByTestId('give-box');
  await expect(box.getByTestId('own-none')).toHaveText('No cards of these collections in your wallet.', { timeout: 30_000 });
  await expect(box.getByTestId('give')).toHaveCount(0);
  await expect(box.getByRole('list', { name: 'Your cards' })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await box.scrollIntoViewIfNeeded();
  await shot(page, 'shop-no-cards-390');
});

test('the tax waiting: Refill buys the token for the shop, read back', async ({ page }) => {
  await open(page);
  await page.getByTestId('connect').click();
  const before = await balanceOf(seed.token, seed.shop);
  await page.getByTestId('refill').click();
  // Once nothing waits, the line and its press leave the page; the press's outcome is in its dialog.
  await expect(page.getByTestId('refill-box')).toHaveCount(0, { timeout: 60_000 });
  expect((await balanceOf(seed.token, seed.shop)) > before).toBe(true);
  await shot(page, 'shop-after-1440');
});

test('the Flap sale’s page links to its token’s cards; an address without a shop yet says so', async ({ page }) => {
  test.skip(!seed.sale || !seed.saleShop, 'no Flap sale in the deployment file');
  await injectTestWallet(page, RPC, 0);
  await page.goto(`/${Q}#/flap/${seed.sale!.launcher}`);
  const link = page.getByTestId('shop-links').getByRole('link');
  await expect(link).toHaveCount(1, { timeout: 30_000 });
  await expect(link).toHaveAttribute('href', `#/shop/${seed.saleShop}`);
  // The sale creator's own shop: no line about its maker; a stranger's for the same token: never linked, and opened by
  // its address it says who made it.
  await page.goto(`/${Q}#/shop/${seed.saleShop}`);
  await expect(page.getByTestId('shop-page')).toHaveAttribute('data-maker', 'launch', { timeout: 30_000 });
  await expect(page.getByTestId('shop-maker')).toHaveCount(0);
  await page.goto(`/${Q}#/shop/${seed.strangerShop}`);
  await expect(page.getByTestId('shop-maker')).toHaveAttribute('data-maker', 'other', { timeout: 30_000 });
  await expect(page.getByTestId('shop-maker')).toContainText('not by the token’s creator.');
  await shot(page, 'shop-stranger-1440');
  await page.goto(`/${Q}#/shop/0x00000000000000000000000000000000000c0de0`);
  await expect(page.getByTestId('shop-page')).toHaveAttribute('data-absent', 'not-created');
  await expect(page.getByTestId('shop-page')).toContainText('No shop at 0x0000…0de0 yet.');
});
