import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Route } from '@playwright/test';
import { LAUNCH_HINTS } from '../src/features/fit-pair/market-names';
import { boxHeader, evidence, installUntouchableWallet, noTradingControls, walletTouches } from './box-helpers';

// The box pages on the Sepolia data source (SH-BOX-UI-launch): the full v2 deployment of 2026-09-30 from the committed
// record apps/web/fit-markets/fit-market-11155111.json, in the neutral names its contracts carry. A rehearsal is a normal
// card ("Rehearsal · test set"), never Featured; its box shows only counts and "Test set only", no teasers, no
// composition, no Misfits wording. No network: the live service and the keyless RPC are answered from the recorded
// fixture e2e/fixtures/fit-live-11155111.json, as in fit-pair-sepolia.spec.ts; anything else off this machine is refused.

interface Recorded {
  readonly head: string;
  readonly snapshot: string;
  readonly streams: Readonly<Record<'initial' | 'next', string>>;
  readonly rpc: { readonly latest: { readonly number: string; readonly hash: string; readonly timestamp: string }; readonly calls: Readonly<Record<string, string>> };
}

const LIVE = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/fit-live-11155111.json', import.meta.url)), 'utf8')) as Recorded;
const MARKET = JSON.parse(readFileSync(fileURLToPath(new URL('../fit-markets/fit-market-11155111.json', import.meta.url)), 'utf8')) as { poolId: string; contracts: Readonly<Record<string, string>> };
const TOKEN = (MARKET.contracts['token'] ?? '').toLowerCase();
const BOX = `/box/11155111/${TOKEN}`;
const INDEXER = 'http://127.0.0.1:8597/**';
const RPC = 'https://ethereum-sepolia-rpc.publicnode.com/**';
const STREAM_PATH = `/v1/pools/11155111/${MARKET.poolId.toLowerCase()}/stream`;
const SNAPSHOT_PATH = `/v1/pools/11155111/${MARKET.poolId.toLowerCase()}/snapshot`;

async function refuseTheNetwork(page: Page): Promise<string[]> {
  const offline: string[] = [];
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (route) => {
    offline.push(route.request().url());
    return route.abort();
  });
  return offline;
}

async function serveIndexer(page: Page, { stale = false } = {}) {
  let connection = 0;
  // A stale service: the same recording, with the gateway reporting stale and no block after the snapshot.
  const staleStatus = (body: string) => body.replace('{"indexer":"live","reason":null', '{"indexer":"stale","reason":"no new block"');
  const streams = stale ? [staleStatus(LIVE.streams.initial)] : [LIVE.streams.initial, LIVE.streams.next];
  await page.route(INDEXER, async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname === STREAM_PATH) {
      const body = streams[Math.min(connection, streams.length - 1)];
      connection += 1;
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body });
    }
    if (url.pathname === SNAPSHOT_PATH) {
      return route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', etag: '"1"', 'x-sh-indexer': 'live', 'access-control-expose-headers': 'ETag, X-SH-Indexer' }, body: LIVE.snapshot });
    }
    return route.abort();
  });
}

/** The keyless RPC does not answer (a stale service then has no direct read to fall back to). */
async function failRpc(page: Page) {
  await page.route(RPC, (route: Route) => route.fulfill({ status: 503, headers: { 'access-control-allow-origin': '*' }, body: 'unavailable' }));
}

/** The recorded head and the chain's own eth_call answers at it; a call the recording does not hold reverts. */
async function serveRpc(page: Page) {
  await page.route(RPC, async (route: Route) => {
    const request = JSON.parse(route.request().postData() ?? '{}') as { id: number; method: string; params: unknown[] };
    const reply = (body: object) => route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id: request.id, ...body }) });
    if (request.method === 'eth_getBlockByNumber') return reply({ result: request.params[0] === 'latest' ? { ...LIVE.rpc.latest, transactions: [] } : null });
    if (request.method === 'eth_call') {
      const call = request.params[0] as { to: string; data: string };
      const result = LIVE.rpc.calls[`${call.to.toLowerCase()}:${call.data.slice(0, 10)}`];
      return result ? reply({ result }) : reply({ error: { code: -32000, message: 'execution reverted' } });
    }
    if (request.method === 'eth_chainId') return reply({ result: '0xaa36a7' });
    return reply({ error: { code: -32601, message: 'method not found' } });
  });
}

test.beforeEach(async ({ page }) => {
  await installUntouchableWallet(page);
  await page.addInitScript(() => window.localStorage.setItem('squarehole.data-source.v1', JSON.stringify({ source: 'sepolia' })));
});

test('the feed shows the rehearsal as a normal card, never Featured, in its neutral names', async ({ page }) => {
  const offline = await refuseTheNetwork(page);
  await serveIndexer(page);
  await serveRpc(page);
  await page.goto('/');
  await expect(page.getByText('1 box', { exact: true })).toBeVisible();
  const card = page.getByRole('list', { name: 'Boxes' }).getByRole('link');
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAccessibleName(/^Rehearsal Collection, RHT2, Genesis box, (Upcoming|Launch window|Bonding), .*, 4,200 items, Sepolia testnet, Rehearsal, test set$/);
  await expect(page.locator('.sh-box-card--featured, .sh-box-featured, .sh-box-tape')).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Boxes' })).not.toContainText(LAUNCH_HINTS);
  await noTradingControls(page);
  expect(offline).toEqual([]);
  expect(await walletTouches(page)).toEqual([]);
});

test('a stale service with no chain read to fall back to: the card and the box say "Stale · since block", never hidden', async ({ page }) => {
  const offline = await refuseTheNetwork(page);
  await serveIndexer(page, { stale: true });
  await failRpc(page);
  await page.goto('/');
  const card = page.getByRole('list', { name: 'Boxes' }).getByRole('link');
  const notice = card.locator('.sh-box-card__notice');
  await expect(notice).toHaveText(`Stale · since block ${Number(LIVE.head).toLocaleString('en-US')}`, { timeout: 15_000 });
  await expect(notice).toHaveAttribute('data-disclosure', '');
  await expect(card).toHaveAccessibleName(new RegExp(`, Stale · since block ${Number(LIVE.head).toLocaleString('en-US')}, 4,200 items, Sepolia testnet, Rehearsal, test set$`));
  await card.click();
  await expect(page).toHaveURL(new RegExp(`${BOX}$`));
  await expect(boxHeader(page).locator('.sh-box-notice').first()).toContainText(`Stale · since block ${Number(LIVE.head).toLocaleString('en-US')}`, { timeout: 15_000 });
  // The vault could not be read either: said, and nothing is shown as zero.
  await expect(boxHeader(page).locator('.sh-box-notice', { hasText: /^Vault not read · / })).toBeVisible({ timeout: 15_000 });
  expect(offline).toEqual([]);
});

test('the box page: counts and "Test set only", no teasers, no composition, no launch names; the vault read from the chain', async ({ page }, testInfo) => {
  const offline = await refuseTheNetwork(page);
  await serveIndexer(page);
  await serveRpc(page);
  await page.goto('/misfits');
  await expect(page).toHaveURL(new RegExp(`${BOX}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Rehearsal Collection' })).toBeVisible();
  const header = boxHeader(page);
  await expect(header).not.toHaveAttribute('data-state', 'unavailable');
  await expect(header.locator('.sh-box-rehearsal')).toContainText('Rehearsal · test set');
  await expect(header.locator('.sh-box-demo, .sh-box-featured')).toHaveCount(0);
  await expect(header).toContainText('Sepolia testnet');
  await expect(header.locator('.sh-box-stat').first()).toContainText('4,200');
  await expect(page.getByRole('heading', { level: 2, name: '4,200 items, sealed until graduation' })).toBeVisible();
  await expect(page.getByText('Test set only: made-up traits, no art.')).toBeVisible();
  await expect(page.getByText('Sneak peek')).toHaveCount(0);
  await expect(page.locator('.sh-box-comp')).toHaveCount(0);
  await expect(page.locator('.sh-box-sealed')).toContainText('Sealed inside4,200');
  // The launch's names appear nowhere the market is described (header and contents, open or closed panels).
  expect(await header.evaluate((element) => element.textContent ?? '')).not.toMatch(LAUNCH_HINTS);
  expect(await page.locator('.sh-box-panel').evaluate((element) => element.textContent ?? '')).not.toMatch(LAUNCH_HINTS);
  await noTradingControls(page);
  await evidence(page, testInfo, 'box-sepolia');

  // Owning one: the price picture's FIT side needs the vault's escrow, which this recorded deployment does not answer:
  // it says "Not available", never a guess.
  await page.getByRole('tab', { name: 'Owning one' }).click();
  const price = page.getByRole('region', { name: 'Price' });
  await expect(price).toContainText('1 item');
  await expect(price.locator('.sh-box-price__row strong')).toHaveText([/^0\.\d+ ETH$/]);
  await expect(price).toContainText('Not available');
  expect(await page.locator('.sh-box-panel').evaluate((element) => element.textContent ?? '')).not.toMatch(LAUNCH_HINTS);
  expect(offline).toEqual([]);
  expect(await walletTouches(page)).toEqual([]);
});
