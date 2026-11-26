import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page, type Route, type TestInfo } from '@playwright/test';
import { UNISWAP_TESTNET_MODE_WARNING } from '../../../packages/links/src/chain-links';
import { LAUNCH_HINTS } from '../src/features/fit-pair/market-names';

// The FIT pair page (/fit-pair since the box pages took /misfits) on the Sepolia data source: the full v2 deployment of 2026-09-30 (docs/v2/sepolia-full.md),
// from the committed record apps/web/fit-markets/fit-market-11155111.json, in the neutral names its contracts carry
// (Rehearsal Token 2 / RHT2, Rehearsal Collection / RHC, Rehearsal placeholder / RHC-P). No network: the build points
// the record at a live service on 127.0.0.1:8597 that nobody runs (playwright.config.ts), and this file answers it and
// the keyless Sepolia RPC from e2e/fixtures/fit-live-11155111.json, recorded read-only from the real service following
// the deployment and from the chain (packages/indexer/scripts/record-web-fixture.ts). Any other request off this
// machine is refused and counted. SH_EVIDENCE_SCREENSHOTS=1 writes docs/evidence/screenshots/sepolia-full-*.png.

interface Recorded {
  readonly head: string;
  readonly headAfter: string;
  readonly snapshot: string;
  readonly streams: Readonly<Record<'initial' | 'next', string>>;
  readonly rpc: { readonly latest: { readonly number: string; readonly hash: string; readonly timestamp: string }; readonly calls: Readonly<Record<string, string>> };
}

interface MarketRecord {
  readonly poolId: string;
  readonly contracts: Readonly<Record<string, string>>;
}

const LIVE = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/fit-live-11155111.json', import.meta.url)), 'utf8')) as Recorded;
const MARKET = JSON.parse(readFileSync(fileURLToPath(new URL('../fit-markets/fit-market-11155111.json', import.meta.url)), 'utf8')) as MarketRecord;
const TOKEN = MARKET.contracts['token'] ?? '';
const INDEXER = 'http://127.0.0.1:8597/**';
const RPC = 'https://ethereum-sepolia-rpc.publicnode.com/**';
const STREAM_PATH = `/v1/pools/11155111/${MARKET.poolId.toLowerCase()}/stream`;
const SNAPSHOT_PATH = `/v1/pools/11155111/${MARKET.poolId.toLowerCase()}/snapshot`;
const FORBIDDEN = /\b(buy|sell|swap)\b/i;
const block = (value: string) => value.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

async function evidence(page: Page, testInfo: TestInfo, name: string, focus?: Locator) {
  const file =
    process.env.SH_EVIDENCE_SCREENSHOTS === '1'
      ? fileURLToPath(new URL(`../../../docs/evidence/screenshots/sepolia-full-${name}-${testInfo.project.name}.png`, import.meta.url))
      : testInfo.outputPath(`sepolia-full-${name}.png`);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  if (focus) await focus.evaluate((element) => window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 72));
  else await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: file, fullPage: !focus, scale: 'css' });
}

/** Records every request a page makes to an injected wallet: browsing must make none (UI-05, EXT-04). */
async function installWalletProbe(page: Page) {
  await page.addInitScript(() => {
    const calls: unknown[] = [];
    Object.defineProperty(window, '__walletCalls', { value: calls });
    const record = (method: string) => (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.reject(new Error('no wallet requests expected'));
    };
    Object.defineProperty(window, 'ethereum', { value: { isMetaMask: true, request: record('request'), send: record('send'), sendAsync: record('sendAsync') } });
  });
}

const walletCalls = (page: Page) => page.evaluate(() => (window as unknown as { __walletCalls: unknown[] }).__walletCalls.length);

/** No live network in e2e: every request off this machine that no route below answers is refused and remembered. */
async function refuseTheNetwork(page: Page): Promise<string[]> {
  const offline: string[] = [];
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (route) => {
    offline.push(route.request().url());
    return route.abort();
  });
  return offline;
}

/**
 * The live service. Every stream connection gets the same recorded body until the test calls `advance()`; from then on
 * the next recorded body (the browser reconnects after the body's `retry`, 3 s here).
 *
 * SH-225: before, the second connection always got the next blocks. The test then had about three seconds for all its
 * checks of the first block, and lost that race on a busy machine: in gate k of 15 November 2026 it reached its first
 * check 5.5 s in, one second after the page had already followed the stream to the next blocks (the page was right, the
 * test was late). Now the test decides when the next blocks come.
 */
async function serveIndexer(page: Page, streams: readonly string[]): Promise<{ readonly advance: () => void }> {
  let index = 0;
  await page.route(INDEXER, async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname === STREAM_PATH) {
      const body = streams[Math.min(index, streams.length - 1)];
      if (body === undefined || body === 'abort') return route.abort();
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body });
    }
    if (url.pathname === SNAPSHOT_PATH && streams[0] !== 'abort') {
      return route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', etag: '"1"', 'x-sh-indexer': 'live', 'access-control-expose-headers': 'ETag, X-SH-Indexer' }, body: LIVE.snapshot });
    }
    return route.abort();
  });
  return { advance: () => { index += 1; } };
}

/** The keyless Sepolia RPC: the recorded head and the chain's own eth_call answers at it; safe and finalized unknown. */
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

async function noTradingControls(page: Page) {
  await expect(page.getByRole('button', { name: FORBIDDEN })).toHaveCount(0);
  await expect(page.getByRole('link', { name: FORBIDDEN })).toHaveCount(0);
  await expect(page.locator('input, select, textarea, iframe')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

const curve = (page: Page) => page.getByRole('region', { name: 'Bonding curve' });
const chip = (page: Page) => curve(page).locator('.sh-fit-chip');
const header = (page: Page) => page.locator('header.sh-fit-head');

test.describe('Sepolia testnet: the full v2 deployment (recorded fixture)', () => {
  test.beforeEach(async ({ page }) => {
    await installWalletProbe(page);
  });

  test('Settings offers Sepolia for the v2 market; the page follows the live pool in its neutral names', async ({ page, context }, testInfo) => {
    const offline = await refuseTheNetwork(page);
    const live = await serveIndexer(page, [LIVE.streams.initial, LIVE.streams.next]);
    await serveRpc(page);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    await page.goto('/settings');
    const group = page.getByRole('group', { name: 'Data source' });
    await expect(group.getByRole('radio', { name: /Sepolia testnet/ })).toBeEnabled();
    // The build carries core v1 on Sepolia (packages/contracts/deployments/core-v1/11155111.json, deployed since
    // a73688062), so the option shows the core hint, which wins over the market-only hint (data-source.ts sepoliaOption).
    await expect(group).toContainText('Reads core v1 on Sepolia (box 0 and every box from its registry)');
    await group.getByRole('radio', { name: /Sepolia testnet/ }).check();
    await expect(page.getByRole('banner')).toContainText('Sepolia');

    await page.goto('/fit-pair');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('RHT2 Rehearsal Collection');
    await expect(page).toHaveTitle(/^RHT2 · Rehearsal Collection/);
    // Beside the address: the network and the rehearsal badge, both on the first screen.
    await expect(header(page).locator('.sh-fit-ca__network')).toHaveText('Sepolia testnet');
    await expect(header(page).locator('.sh-fit-head__rehearsal')).toBeVisible();
    await expect(header(page).locator('.sh-fit-head__rehearsal')).toContainText('Rehearsal · test set');
    // What the token is, behind the (i) next to its name.
    await header(page).getByRole('button', { name: 'About RHT2' }).click();
    await expect(header(page)).toContainText('Rehearsal Token 2 (RHT2) is the fraction token of the Rehearsal Collection (RHC)');
    await expect(header(page).getByText('Test tokens have no value.')).toBeVisible();
    await expect(header(page)).toContainText('Sepolia testnet (chain id 11155111)');
    await header(page).getByRole('button', { name: 'About RHT2' }).click();
    await expect(header(page).getByText(TOKEN, { exact: true })).toBeVisible();
    await header(page).getByRole('button', { name: 'Copy the RHT2 contract address' }).click();
    await expect(header(page).getByText('Copied.')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(TOKEN);

    // Live from the recorded stream (the chip's word; the block in its title); the price agrees with the chain's own
    // answer at the same block (said in the curve's (i)).
    await expect(chip(page)).toHaveText('Live');
    await expect(chip(page)).toHaveAttribute('title', `Block ${block(LIVE.head)}`);
    await expect(curve(page)).toContainText(`its price matched a direct chain read at block ${block(LIVE.head)}`);
    // The target is the record's curve (the Misfits launch curve, 4.206980085 ETH).
    await expect(curve(page).getByRole('progressbar', { name: 'Progress to graduation' })).toHaveAttribute('aria-valuetext', '0.001484999 ETH of 4.206980085 ETH (0.0%) · after sells');
    await expect(curve(page)).toContainText('ETH per 1M RHT2');
    await expect(curve(page)).toContainText('1.07M RHT2');
    await expect(page.getByRole('region', { name: 'Recent trades' })).toContainText('Genesis · RHT2 burned');
    const vault = page.getByRole('region', { name: 'Rehearsal Collection vault' });
    await expect(vault).toContainText('Items inside');
    await expect(vault).toContainText('4,200');
    await expect(vault).toContainText(`Chain read · block ${block(LIVE.head)}`);
    await expect(vault.getByText('Test set only: made-up traits, no art.')).toBeVisible();

    // Links out follow the route-evidence rule: the explorer page of the exact token; Uniswap not checked; no DEX Screener.
    const links = page.getByRole('region', { name: 'Open on' });
    await expect(links.locator('a[href]')).toHaveCount(1);
    await expect(links.locator('a[href]')).toHaveAttribute('href', `https://sepolia.etherscan.io/token/${TOKEN}`);
    await expect(links.locator('a[href]')).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(links.locator('[data-kind="execution"]')).toHaveText('Uniswap web app: not checked');
    await expect(links.locator('[data-kind="discovery"]')).toHaveText('DEX Screener: no link');
    // The Testnet-mode caveat exactly once: Uniswap is not a link, so it is said with Uniswap's reason in the (i).
    expect((await links.innerText()).split(UNISWAP_TESTNET_MODE_WARNING)).toHaveLength(1);
    await links.getByRole('button', { name: 'About the links' }).click();
    expect((await links.innerText()).split(UNISWAP_TESTNET_MODE_WARNING)).toHaveLength(2);
    await expect(links).toContainText('This app has no trade form.');
    await links.getByRole('button', { name: 'About the links' }).click();

    // Every address of the deployment, with a copy button each.
    const contracts = page.getByRole('region', { name: 'All contract addresses' });
    await contracts.locator('summary').click();
    for (const key of ['token', 'hook', 'poolManager', 'launchRouter', 'vault', 'placeholders', 'collection', 'genesis', 'collector', 'executor', 'randomnessSource']) {
      await expect(contracts.getByText(MARKET.contracts[key] ?? '-', { exact: true })).toBeVisible();
    }
    await expect(contracts.getByText(MARKET.poolId, { exact: true })).toBeVisible();
    await expect(contracts.getByRole('button', { name: /^Copy the / })).toHaveCount(12);
    await contracts.getByRole('button', { name: 'Copy the Genesis address' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(MARKET.contracts['genesis']);

    // The launch's names appear nowhere the market is described: the names rule's own list (LAUNCH_HINTS: fit, misfit,
    // square, hole, stonk, sorter, so "Square Hole" too), case-insensitive. With the Terms 5.7 (e) quotes gone (F49 D3)
    // the Fees card is checked like every other card. Every (i) panel is checked too (textContent: open or closed).
    const fees = page.getByRole('region', { name: 'Fees' });
    for (const part of [header(page), curve(page), vault, links, contracts, fees, page.getByRole('region', { name: 'Recent trades' }), page.getByRole('region', { name: 'Launch window' })]) {
      expect(await part.innerText()).not.toMatch(LAUNCH_HINTS);
      expect(await part.evaluate((element) => element.textContent ?? '')).not.toMatch(LAUNCH_HINTS);
    }
    expect(await fees.evaluate((element) => element.textContent ?? '')).not.toMatch(/fee share|outside liquidity/i);
    await noTradingControls(page);
    await evidence(page, testInfo, 'live', testInfo.project.name === 'mobile' ? undefined : page.locator('main'));

    // Everything above was checked at the first block, however long it took: reconnects so far got that block again.
    await expect(chip(page)).toHaveAttribute('title', `Block ${block(LIVE.head)}`);
    // Now the service has the next blocks: the browser reconnects after the recorded retry and follows them.
    live.advance();
    await expect(chip(page)).toHaveAttribute('title', `Block ${block(LIVE.headAfter)}`, { timeout: 15_000 });
    expect(await walletCalls(page)).toBe(0);
    expect(offline).toEqual([]);
  });

  test('without the live service the page reads the chain itself (the recorded RPC answers), and says why', async ({ page }, testInfo) => {
    await page.addInitScript(() => window.localStorage.setItem('squarehole.data-source.v1', JSON.stringify({ source: 'sepolia' })));
    const offline = await refuseTheNetwork(page);
    await serveIndexer(page, ['abort']);
    await serveRpc(page);
    await page.goto('/fit-pair');
    await expect(chip(page)).toHaveText('Direct chain read', { timeout: 20_000 });
    await expect(chip(page)).toHaveAttribute('title', `Block ${block(LIVE.head)}`);
    await expect(curve(page).getByText('The live service cannot be reached.')).toBeVisible();
    await expect(curve(page)).toContainText('read directly from the chain');
    await expect(page.getByRole('region', { name: 'Recent trades' })).toContainText('a direct chain read carries none');
    await evidence(page, testInfo, 'direct', testInfo.project.name === 'mobile' ? curve(page) : page.locator('main'));
    expect(offline).toEqual([]);
    expect(await walletCalls(page)).toBe(0);
  });

  test('says unavailable when neither answers, never empty', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('squarehole.data-source.v1', JSON.stringify({ source: 'sepolia' })));
    const offline = await refuseTheNetwork(page);
    await page.route(INDEXER, (route) => route.abort());
    await page.goto('/fit-pair');
    await expect(chip(page)).toContainText('Unavailable', { timeout: 25_000 });
    await expect(curve(page)).toContainText('Nothing is shown as empty or zero in its place');
    // The page did try the RPC (the direct-read fallback), it was the only thing off this machine it tried, and it was
    // refused here (no live network). An empty list would prove nothing, so at least one request must be there.
    expect(offline.length).toBeGreaterThan(0);
    expect(offline.every((url) => url.startsWith('https://ethereum-sepolia-rpc.publicnode.com'))).toBe(true);
    // The registry's pair feed (/pairs) checked here before is off in every build (F134 R46B).
    expect(await walletCalls(page)).toBe(0);
  });
});
