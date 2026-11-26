import { fileURLToPath } from 'node:url';
import { expect, test, type CDPSession, type Page, type TestInfo } from '@playwright/test';
import { decodeAbiParameters, decodeFunctionData, encodeFunctionResult, erc20Abi, keccak256, toHex, type Hex } from 'viem';
import manifestJson from './fixtures/core-local/manifest-11155111.json' with { type: 'json' };
import { FORBIDDEN, installUntouchableWallet, overflow, walletTouches } from './box-helpers';
import { boxSpecV2Parameter, encodeBoxSpecV2, parseCoreManifestV2, type BoxSpecV2 } from '../../../packages/chain/src/core/v2';
import { mixedDeployment } from '../src/features/core/v2/test-support/mixed-deployment';
import { gpuPoorLifeV2, onManifestV2, recordedLifeV2, type LifeFixtureV2 } from '../src/features/core/v2/test-support/life-v2';
import { candleAnswerV2 } from '../src/features/core/v2/test-support/candles-v2';
import type { LifeStageV2 } from '../src/features/core/v2/life-state';

// SH-BOX-LIFE-VIEW in the browser, at 1440 px (desktop project) and 375 px (mobile project): the top of a v2 box's page
// at every moment of its life (GPU Poor's real answers from api.squarehole.fun and its earlier moments, through the real
// source, feed, box page and activity reads; the indexer's routes and the RPC answered here, nothing leaves the
// machine): the life strip, the raise bar (full at 100%, with its colour), a chart that means something with few
// trades, the trades with who and the transaction, the holders, the coin named tNVDA, a new trade arriving without a
// reload. No wallet is touched and no control names a trade. SH_EVIDENCE_SCREENSHOTS=1 writes the pictures to
// docs/evidence/SH-BOX-LIFE-VIEW/.
//
// SH-BOX-CANDLES: the market's candle chart, from the candle route as the server answers once every step is served
// (test-support/candles-v2.ts over the same items): the step buttons, Max by default, one read per step, the readout
// under the crosshair, the one-line states, a vertical swipe over it scrolling the page on a phone, a new trade read
// again. SH_EVIDENCE_SCREENSHOTS=1 writes its pictures to docs/evidence/SH-BOX-CANDLES/.

const CORE = 'http://127.0.0.1:8596';
const RPC = 'http://127.0.0.1:8599';
const manifest = parseCoreManifestV2(manifestJson);
const TNVDA = '0x2cbbad2607fccfee778d959d386997862099f33b';
type Wire = Record<string, unknown>;
const width = (info: TestInfo) => (info.project.name === 'mobile' ? 375 : 1440);

/**
 * The top of the page (the header with the life strip, the market or the closing card, the trade box column and the
 * activity: SH-224's `.sh-v2-top`), as the founder sees it first.
 */
async function shot(page: Page, info: TestInfo, name: string) {
  const path = process.env.SH_EVIDENCE_SCREENSHOTS === '1'
    ? fileURLToPath(new URL(`../../../docs/evidence/SH-BOX-LIFE-VIEW/${name}-${width(info) === 375 ? '375' : 'desktop'}.png`, import.meta.url)) : info.outputPath(`${name}.png`);
  const style = await page.addStyleTag({ content: '.sh-topbar { position: static !important; }' });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  // No hover in the picture: the pointer of the last click can rest on a row's copy button once the top bar is static.
  await page.mouse.move(0, 0);
  const bottom = await page.locator('.sh-v2-top').evaluate((node) => Math.max(...[node, ...node.querySelectorAll('*')].map((one) => one.getBoundingClientRect().bottom)) + window.scrollY);
  await page.screenshot({ path, fullPage: true, scale: 'css', clip: { x: 0, y: 0, width: width(info), height: Math.ceil(bottom + 16) } });
  await style.evaluate((node) => (node as Element).remove());
}

/**
 * The fixture behind the local source's indexer and RPC; `state` can change while the page is open. `firstActivityMs`:
 * the life view's first activity read answers that late (a slow connection). The candle route answers over the same
 * items (`candleItems` instead, when given), the steps `candleSteps` (every one by default); its reads in
 * `candleQueries`.
 */
async function serve(page: Page, fixture: LifeFixtureV2, options: { readonly firstActivityMs?: number; readonly candleSteps?: readonly string[]; readonly candleItems?: readonly Wire[] } = {}) {
  const data = await mixedDeployment();
  const local = onManifestV2(fixture, manifest);
  const state = { body: local.body, items: structuredClone(local.activity.items as Wire[]), activityReads: 0, activityQueries: [] as string[], candleQueries: [] as string[], feedReads: 0 };
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (route) => route.abort());
  await page.route(`${CORE}/**`, async (route) => {
    const url = new URL(route.request().url());
    let answer: unknown = null;
    let status = 200;
    if (url.pathname === '/v1/feed') answer = data.v1.feed;
    else if (url.pathname === '/v2/feed') {
      state.feedReads += 1;
      answer = { schema: 'sh.core-feed.v2', chainId: manifest.chainId, asOf: state.body.asOf, cards: [state.body], hidden: [], platform: [] };
    }
    else if (url.pathname.endsWith('/activity') && url.pathname.startsWith('/v2/')) {
      state.activityReads += 1;
      state.activityQueries.push(url.search);
      // The life view's first read (the Burn log reads the same route with `limit=100`).
      if (options.firstActivityMs && url.search === '?limit=50' && state.activityQueries.filter((query) => query === '?limit=50').length === 1) await new Promise((resolve) => setTimeout(resolve, options.firstActivityMs));
      const limit = Number(url.searchParams.get('limit') ?? '50');
      const before = url.searchParams.get('before');
      const [b, l] = before ? before.split('-').map(BigInt) : [null, null];
      const older = state.items.filter((item) => b === null || l === null || BigInt(item.block as string) < b || (BigInt(item.block as string) === b && BigInt(item.logIndex as number) < l));
      const items = older.slice(0, limit);
      const last = items.at(-1);
      answer = { asOf: state.body.asOf, items, next: items.length === limit && last ? `${last.block as string}-${last.logIndex as number}` : null };
    } else if (url.pathname.endsWith('/candles') && url.pathname.startsWith('/v2/')) {
      state.candleQueries.push(url.search);
      const reply = candleAnswerV2(options.candleItems ?? state.items, url, state.body.asOf, options.candleSteps);
      ({ status, body: answer } = reply);
    }
    await route.fulfill({ status: answer ? status : 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(answer ?? { error: 'not found' }) });
  });
  await page.route(`${RPC}/**`, async (route) => {
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const call = route.request().postDataJSON() as { id: number; method: string; params?: unknown[] };
    let answer: Wire = { error: { code: -32601, message: 'not answered here' } };
    if (call.method === 'eth_chainId') answer = { result: toHex(manifest.chainId) };
    else if (call.method === 'eth_call') {
      const { to, data: input } = call.params?.[0] as { to: string; data: Hex };
      const symbol = (() => { try { return decodeFunctionData({ abi: erc20Abi, data: input }).functionName === 'symbol'; } catch { return false; } })();
      // The price coin's ERC-20 symbol (how Create and the box page name it); every other read answers nothing.
      answer = { result: symbol && to.toLowerCase() === TNVDA ? encodeFunctionResult({ abi: erc20Abi, functionName: 'symbol', result: 'tNVDA' }) : '0x' };
    }
    await route.fulfill({ headers, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: call.id, ...answer }) });
  });
  // The page counts its times from the block's: the clock stands at the snapshot's time.
  await page.clock.setFixedTime(new Date(Number((state.body.asOf as { timestamp: string }).timestamp) * 1000));
  await page.goto('/settings');
  await page.getByRole('radio', { name: /Local chain/ }).check();
  await page.goto(`/box/${manifest.chainId}/${(state.body.token as string).toLowerCase()}`);
  await expect(page.getByRole('region', { name: 'Box life' })).toBeVisible({ timeout: 30_000 });
  return state;
}

const steps = (page: Page) => page.getByRole('region', { name: 'Box life' }).locator('.sh-life__step');
const rows = (page: Page) => page.getByRole('region', { name: 'Activity' }).locator('.sh-life-row');

/**
 * Every short address keeps its copy button and one line, on a phone too: the graduation's caller, the closing's caller and
 * a claim's holder (an event's word is longer than a trade's Buy, so on a phone the address takes the line under it).
 */
async function namedRowsWhole(page: Page) {
  const named = page.getByRole('region', { name: 'Activity' }).locator('.sh-life-row .sh-life-who__id');
  await expect(named.first()).toBeVisible();
  for (const id of await named.all()) {
    const [address, copy] = [await id.locator('.sh-life-who__address').boundingBox(), await id.locator('.sh-copy__button').boundingBox()];
    expect(copy, 'its copy button is shown').not.toBeNull();
    expect(address?.height ?? 99, 'the address on one line').toBeLessThanOrEqual(20);
    expect(Math.abs((copy?.y ?? 0) + (copy?.height ?? 0) / 2 - ((address?.y ?? 0) + (address?.height ?? 0) / 2)), 'the copy button beside it').toBeLessThanOrEqual(4);
    // Nothing of its row's first line runs into it.
    const row = id.locator('xpath=ancestor::li[1]');
    for (const other of [row.locator('.sh-life-row__when'), row.locator('.sh-life-row__tx')]) {
      const box = await other.boundingBox();
      if (box && copy && Math.abs(box.y - (copy.y ?? 0)) < 10) expect(copy.x + copy.width).toBeLessThanOrEqual(box.x + 0.5);
    }
  }
}

/** Every number of the strip without a space keeps one line: a price never breaks between its digits, on a phone too. */
async function stripOneLine(page: Page) {
  for (const value of await steps(page).locator('.sh-life__value').all()) {
    const text = (await value.textContent()) ?? '';
    if (/\s/.test(text)) continue;
    // The lines its text is laid out on: the distinct tops of the text's boxes.
    const lines = await value.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
    });
    expect(lines, text).toBe(1);
  }
}

async function common(page: Page) {
  await stripOneLine(page);
  await expect(page.getByRole('button', { name: FORBIDDEN })).toHaveCount(0);
  await expect(page.getByRole('link', { name: FORBIDDEN })).toHaveCount(0);
  // The price coin is named, never "P".
  await expect(page.getByRole('region', { name: 'Box life' })).not.toContainText(/(^|[^A-Za-z0-9])P([^A-Za-z0-9]|$)/);
  await expect(page.getByRole('region', { name: 'Activity' })).not.toContainText(/(^|[^A-Za-z0-9])P([^A-Za-z0-9]|$)/);
  // The box life's three cards (SH-224: the strip in the header, the market or the closing card, the activity): every
  // Details closed. The market and the closing card each have one, so the list is never empty.
  const lifeDetails = await page.locator('.sh-bpic-head .sh-life details, .sh-v2-top__market details, .sh-v2-top__activity details').all();
  expect(lifeDetails.length).toBeGreaterThan(0);
  for (const details of lifeDetails) expect(await details.evaluate((node) => (node as HTMLDetailsElement).open)).toBe(false);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  expect(await walletTouches(page)).toEqual([]);
}

test.beforeEach(async ({ page }, info) => {
  await installUntouchableWallet(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize(info.project.name === 'mobile' ? { width: 375, height: 812 } : { width: 1440, height: 900 });
});

const STATES: readonly { stage: LifeStageV2; current: string; rows: readonly string[] }[] = [
  { stage: 'scheduled', current: 'launch', rows: ['created'] },
  { stage: 'window', current: 'launch', rows: ['trade', 'created'] },
  { stage: 'raising', current: 'raise', rows: ['trade', 'created'] },
  { stage: 'graduating', current: 'graduate', rows: ['full', 'trade', 'created'] },
  { stage: 'graduated', current: 'pool', rows: ['deepened', 'buyBack', 'buyBack', 'fees', 'graduated', 'full', 'trade', 'created'] },
  { stage: 'failed', current: '', rows: ['claim', 'closed', 'trade', 'created'] },
];

for (const { stage, current, rows: story } of STATES) {
  test(`SH-BOX-LIFE-VIEW ${stage}: the strip, the market and the story at the top of the page`, async ({ page }, info) => {
    await serve(page, gpuPoorLifeV2(stage));
    await expect(rows(page)).toHaveCount(story.length, { timeout: 30_000 });
    expect(await rows(page).evaluateAll((list) => list.map((row) => (row.getAttribute('data-kind') === 'trade' ? 'trade' : row.getAttribute('data-event'))))).toEqual(story);
    const currentStep = steps(page).locator('[aria-current="step"]');
    if (current) await expect(steps(page).and(page.locator('[aria-current="step"]'))).toHaveAttribute('data-step', current);
    else await expect(currentStep).toHaveCount(0);
    if (stage === 'failed') {
      await expect(steps(page).and(page.locator('[data-status="failed"]'))).toHaveAttribute('data-step', 'raise');
      const claim = page.getByRole('region', { name: 'Failure claim' });
      await expect(claim).toBeVisible();
      await expect(page.getByRole('region', { name: 'Market' })).toHaveCount(0);
      // Numbers first, short, in the box's usual units; the exact digits behind the closed Claim details.
      await expect(claim.locator('.sh-v2-value')).toHaveText('0.071758 tNVDA per 1M VRAM');
      await expect(claim.locator('.sh-v2-stats__grid > div')).toHaveText(['Claim pot31.57 tNVDA', 'Coins left440.01M VRAM']);
      await expect(claim.getByText(/^Exact: 0\.0000000717585204568771808104557061\d* tNVDA per VRAM$/)).toBeHidden();
      await expect(claim.getByText(/^Claim pot 31\.575000000000000001 tNVDA · 440017433\.\d+ coins left$/)).toBeHidden();
    } else {
      // SH-BOX-CANDLES: the candle chart drawn, Max by default.
      const chart = page.getByRole('region', { name: 'Market' }).locator('.sh-candles');
      await expect(chart).toHaveAttribute('data-status', 'drawn');
      await expect(chart).toHaveAttribute('data-choice', 'max');
      await expect(chart.locator('canvas').first()).toBeVisible();
    }
    if (stage === 'scheduled') {
      // One word per moment: the strip's Launch is the opening; the box's creation is the Created row. The strip's Raise
      // says what the bar says.
      await expect(rows(page).first().locator('.sh-life-event')).toHaveText('Created');
      await expect(page.getByRole('region', { name: 'Activity' })).not.toContainText('Launch');
      await expect(steps(page).nth(1).locator('.sh-life__sub')).toHaveText('0.03529 / 100 tNVDA');
      await expect(page.getByRole('progressbar', { name: 'Raised' })).toHaveAttribute('aria-valuetext', '0.0%, 0.03529 / 100 tNVDA');
    }
    if (stage === 'graduated' || stage === 'failed') await namedRowsWhole(page);
    if (stage === 'graduating') {
      // The raise bar at 100% looks full: its fill spans the track and has its colour (the founder's grey bar).
      const fill = page.locator('.sh-life-raise__fill');
      const track = page.locator('.sh-life-raise__track');
      const [fillBox, trackBox] = [await fill.boundingBox(), await track.boundingBox()];
      expect(Math.round(fillBox?.width ?? 0)).toBe(Math.round(trackBox?.width ?? -1));
      expect(await fill.evaluate((node) => getComputedStyle(node).backgroundImage)).toMatch(/gradient\(.*rgb\(103, 232, 249\)/);
      await expect(page.locator('.sh-life-raise__full')).toContainText('Full');
      // The same token on the v1 bar the feed and the old stats card use: no longer transparent outside the feed.
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--sh-box-graduating').trim())).toBe('#67e8f9');
      // Who filled it: the founder's deployer, its transaction on Sepolia Etherscan.
      await expect(rows(page).nth(1).locator('.sh-life-who__address code')).toHaveText('0x1F14…4eeE');
      await expect(rows(page).nth(1).locator('.sh-life-row__tx')).toHaveAttribute('href', 'https://sepolia.etherscan.io/tx/0x2c14a15762315c0867621dd5f76b956185d248e29fa2dcb57936130dbcbfb9f8');
    }
    await common(page);
    await shot(page, info, stage);
    if (stage === 'graduated' || stage === 'graduating') {
      await page.getByRole('region', { name: 'Activity' }).getByRole('tab', { name: /^Holders/ }).click();
      await expect(page.locator('.sh-life-holder')).toHaveCount(stage === 'graduated' ? 2 : 3);
      await expect(page.locator('.sh-life-holder .sh-life-chip', { hasText: 'Pool' })).toHaveCount(1);
      await common(page);
      await shot(page, info, `${stage}-holders`);
    }
  });
}

test('SH-BOX-LIFE-VIEW a box priced in the native coin (Dragon’s Hoard as read): ETH everywhere; its long pool price keeps one line', async ({ page }) => {
  await serve(page, { body: structuredClone(recordedLifeV2.dragonsHoard.body), activity: structuredClone(recordedLifeV2.dragonsHoard.activity) });
  await expect(rows(page)).toHaveCount(6, { timeout: 30_000 });
  expect(await rows(page).evaluateAll((list) => list.map((row) => (row.getAttribute('data-kind') === 'trade' ? 'trade' : row.getAttribute('data-event'))))).toEqual(['deepened', 'fees', 'graduated', 'full', 'trade', 'created']);
  await expect(steps(page).nth(3).locator('.sh-life__value')).toHaveText('0.00048058');
  await expect(steps(page).nth(3).locator('.sh-life__sub')).toHaveText('ETH per 1M HOARD');
  await expect(rows(page).nth(2).locator('.sh-life-row__p')).toHaveText('0.0001 ETH tip');
  await namedRowsWhole(page);
  await common(page);
});

test('SH-BOX-LIFE-VIEW live: a new trade lands while the page is open and appears on top without a reload, once', async ({ page }, info) => {
  const state = await serve(page, gpuPoorLifeV2('raising'));
  await expect(rows(page)).toHaveCount(2, { timeout: 30_000 });
  const reads = state.activityReads;
  await expect(page.locator('.sh-candles')).toHaveAttribute('data-status', 'drawn');
  const candleReads = [...state.candleQueries];
  // A new block with a new buy: the snapshot moves (the feed is read again every 4 s), then its rows are read.
  const asOf = state.body.asOf as { block: string; timestamp: string; hash: string };
  const block = BigInt(asOf.block) + 1n;
  const trade = structuredClone(state.items.find((item) => item.kind === 'trade' && item.route === 'other') as Wire);
  const transfer = structuredClone(state.items.find((item) => item.kind === 'v2_event' && (item.data as Wire).event === 'Transfer' && item.block === trade.block) as Wire);
  const ref = (logIndex: number) => ({ id: `${block}-${logIndex}`, block: String(block), logIndex, timestamp: String(BigInt(asOf.timestamp) + 12n), txHash: `0x${'4c'.repeat(32)}` });
  state.items = [{ ...transfer, ...ref(9) }, { ...trade, ...ref(6) }, ...state.items];
  const stats = state.body.statistics as Wire;
  // The indexer's figures after the buy: one trade more, in its hour too.
  const hours = (stats.hourlyCandles as Wire[]).map((hour, i, all) => (i === all.length - 1 ? { ...hour, tradeCount: String(BigInt(hour.tradeCount as string) + 1n) } : hour));
  state.body = { ...state.body, asOf: { ...asOf, block: String(block), timestamp: String(BigInt(asOf.timestamp) + 12n) }, money: { ...(state.body.money as Wire), block: String(block) }, statistics: { ...stats, tradeCount: String(BigInt(stats.tradeCount as string) + 1n), hourlyCandles: hours } };
  await expect(rows(page)).toHaveCount(3, { timeout: 15_000 });
  await expect(rows(page).first()).toHaveAttribute('data-new', '');
  expect(state.activityReads).toBeGreaterThan(reads);
  // SH-BOX-CANDLES: the chart read its step again on the moved figures (one cached answer per step, no other read).
  await expect.poll(() => state.candleQueries.length).toBeGreaterThan(candleReads.length);
  expect(new Set(state.candleQueries)).toEqual(new Set(candleReads));
  await expect(page.getByRole('region', { name: 'Activity' }).locator('.sh-life-live__word')).toHaveText('Live');
  // Shown for its flash (2.4 s), the row is no longer new: a tab switch does not flash it again (review round 2).
  await expect(rows(page).first()).not.toHaveAttribute('data-new', { timeout: 5_000 });
  const tabs = page.getByRole('region', { name: 'Activity' });
  await tabs.getByRole('tab', { name: /^Holders/ }).click();
  await tabs.getByRole('tab', { name: 'Trades' }).click();
  await expect(rows(page)).toHaveCount(3);
  await expect(page.locator('.sh-life-row[data-new]')).toHaveCount(0);
  // The same rows again read nothing twice.
  await page.waitForTimeout(5_000);
  await expect(rows(page)).toHaveCount(3);
  await common(page);
  await shot(page, info, 'live-new-trade');
});

// Review round 2: the holders of a box whose history is longer than one read (GPU Poor raising in 30 buys: 71 items, 32
// holders), on a chain whose head moves whatever the box does.
const crowd = () => gpuPoorLifeV2('raising', { buys: 30 });
/** The life view's activity reads (the page's Burn log reads the same route, `?limit=100`, once per snapshot block). */
const lifeReads = (state: { activityQueries: readonly string[] }) => state.activityQueries.filter((query) => query !== '?limit=100');

test('SH-BOX-LIFE-VIEW holders of a long history on a moving head: opened between two idle reads, every holder at once', async ({ page }, info) => {
  const state = await serve(page, crowd());
  await expect(rows(page)).toHaveCount(12, { timeout: 30_000 });
  // A quick chain: a new head every 3 s, the box idle (its figures as they were); the snapshot is read every 4 s.
  let head = BigInt((state.body.asOf as { block: string }).block);
  const chain = setInterval(() => {
    head += 1n;
    state.body = { ...state.body, asOf: { ...(state.body.asOf as Wire), block: String(head) }, money: { ...(state.body.money as Wire), block: String(head) } };
  }, 3_000);
  try {
    // Past the first idle read (15 s) and two heads after it: the snapshot is newer than every activity read.
    await page.waitForTimeout(22_000);
    expect(lifeReads(state)).toEqual(['?limit=50', '?limit=50']);
    const asked = Date.now();
    await page.getByRole('region', { name: 'Activity' }).getByRole('tab', { name: /^Holders/ }).click();
    await expect(page.locator('.sh-life-holder')).toHaveCount(10, { timeout: 5_000 });
    // Its whole history in one more page, at once; no wait for the next idle read (45 s).
    expect(Date.now() - asked).toBeLessThan(5_000);
    expect(lifeReads(state).slice(2)).toEqual(['?limit=200&before=12003431-10']);
    await expect(page.getByRole('region', { name: 'Activity' }).getByRole('tab', { name: 'Holders 32' })).toBeVisible();
    await expect(page.locator('.sh-life-holder').nth(0).locator('.sh-life-chip')).toHaveText('Pool');
    await expect(page.locator('.sh-life-holder').nth(1).locator('.sh-life-chip')).toHaveText('Box');
    await expect(page.getByRole('button', { name: 'Show all 32' })).toBeVisible();
    await common(page);
    await shot(page, info, 'crowd-holders');
  } finally {
    clearInterval(chain);
  }
});

test('SH-BOX-LIFE-VIEW holders opened before the first activity read answers (a slow connection): the list once it does', async ({ page }) => {
  const state = await serve(page, crowd(), { firstActivityMs: 4_000 });
  const activity = page.getByRole('region', { name: 'Activity' });
  await activity.getByRole('tab', { name: /^Holders/ }).click();
  await expect(activity.locator('.sh-life-empty')).toHaveText('Reading holders…');
  await expect(page.locator('.sh-life-holder')).toHaveCount(10, { timeout: 15_000 });
  expect(lifeReads(state)).toEqual(['?limit=50', '?limit=200&before=12003431-10']);
  await common(page);
});

// ------------------------------------------------------------------------------------------------ SH-BOX-CANDLES

const market = (page: Page) => page.getByRole('region', { name: 'Market' });
const candles = (page: Page) => market(page).locator('.sh-candles');
const stepButton = (page: Page, name: string) => market(page).getByRole('group', { name: 'Candle step' }).getByRole('button', { name, exact: true });

/** The market card, chart and readout, as the founder sees it. */
async function chartShot(page: Page, info: TestInfo, name: string) {
  const path = process.env.SH_EVIDENCE_SCREENSHOTS === '1'
    ? fileURLToPath(new URL(`../../../docs/evidence/SH-BOX-CANDLES/${name}-${width(info) === 375 ? '375' : 'desktop'}.png`, import.meta.url)) : info.outputPath(`${name}.png`);
  await market(page).screenshot({ path, scale: 'css' });
}

/** Moves the pointer across the plot from the right until the readout shows a candle; returns the readout. */
async function hoverACandle(page: Page): Promise<string> {
  const plot = candles(page).locator('.sh-candles__plot');
  await plot.scrollIntoViewIfNeeded();
  const box = await plot.boundingBox();
  if (!box) throw new Error('the plot has no box');
  for (let x = box.x + box.width - 60; x > box.x + 4; x -= 3) {
    await page.mouse.move(x, box.y + box.height * 0.4);
    const text = ((await candles(page).locator('.sh-candles__readout').textContent()) ?? '').trim();
    if (text) return text;
  }
  return '';
}

test('SH-BOX-CANDLES the chart: Max by default, one read per step and its limit, the readout under the crosshair and nothing at rest', async ({ page }, info) => {
  const state = await serve(page, gpuPoorLifeV2('raising'));
  const chart = candles(page);
  await expect(chart).toHaveAttribute('data-status', 'drawn', { timeout: 30_000 });
  const buttons = market(page).getByRole('group', { name: 'Candle step' }).getByRole('button');
  await expect(buttons).toHaveText(['12s', '1m', '10m', '1h', '10h', '1d', 'Max']);
  await expect(stepButton(page, 'Max')).toHaveAttribute('aria-pressed', 'true');
  // The library's own drawing, its TradingView attribution logo left on (its license notice).
  await expect(chart.locator('canvas').first()).toBeVisible();
  await expect(chart.locator('a#tv-attr-logo')).toHaveAttribute('href', /^https:\/\/www\.tradingview\.com\//);
  // The limit by the chart's width: wide at 1440 px, narrow on a phone.
  const limit = width(info) === 375 ? 120 : 300;
  const shown = await chart.getAttribute('data-step');
  expect(state.candleQueries).toEqual([`?interval=${shown}&limit=${limit}`]);
  await expect(stepButton(page, shown ?? '')).toHaveAttribute('data-max', '');
  await page.mouse.move(0, 0);
  await expect(chart.locator('.sh-candles__readout')).toHaveText('');
  await common(page);
  await chartShot(page, info, 'raising-max');
  const readout = await hoverACandle(page);
  expect(readout).toMatch(/^O \S+\s+H \S+\s+L \S+\s+C \S+\s+Vol \S+ tNVDA$/);
  await chartShot(page, info, 'raising-max-readout');
  await page.mouse.move(0, 0);
  await expect(chart.locator('.sh-candles__readout')).toHaveText('');
  // Each step once; a step shown before costs no request while the box's figures stand.
  for (const step of ['12s', '1m', '10m', '1h', '10h', '1d']) {
    await stepButton(page, step).click();
    await expect(stepButton(page, step)).toHaveAttribute('aria-pressed', 'true');
    await expect(chart).toHaveAttribute('data-step', step);
    await expect(chart).toHaveAttribute('data-status', 'drawn');
  }
  await stepButton(page, '1m').click();
  await stepButton(page, 'Max').click();
  await expect(chart).toHaveAttribute('data-status', 'drawn');
  expect([...state.candleQueries].sort()).toEqual(['12s', '1m', '10m', '1h', '10h', '1d'].map((step) => `?interval=${step}&limit=${limit}`).sort());
  await stepButton(page, '1h').click();
  await expect(chart).toHaveAttribute('data-step', '1h');
  await chartShot(page, info, 'raising-1h');
  await common(page);
});

test('SH-BOX-CANDLES graduated (GPU Poor as read): its candles, no graduation line; 1d and the readout', async ({ page }, info) => {
  const state = await serve(page, gpuPoorLifeV2('graduated'));
  const chart = candles(page);
  await expect(chart).toHaveAttribute('data-status', 'drawn', { timeout: 30_000 });
  await chartShot(page, info, 'graduated-max');
  await stepButton(page, '1d').click();
  await expect(chart).toHaveAttribute('data-step', '1d');
  await expect(chart).toHaveAttribute('data-status', 'drawn');
  expect(await hoverACandle(page)).toMatch(/^O .+ Vol .+ tNVDA$/);
  await chartShot(page, info, 'graduated-1d-readout');
  expect(state.candleQueries.at(-1)).toMatch(/^\?interval=1d&limit=\d+$/);
  await common(page);
});

test('SH-BOX-CANDLES a step the server does not answer (the live server today: 12s, 10m, 10h): one line; the other steps as usual', async ({ page }, info) => {
  await serve(page, gpuPoorLifeV2('graduated'), { candleSteps: ['1m', '1h', '1d'] });
  const chart = candles(page);
  await expect(chart).not.toHaveAttribute('data-status', 'reading', { timeout: 30_000 });
  await stepButton(page, '10m').click();
  await expect(chart.locator('.sh-candles__message')).toHaveText('Price history unavailable');
  await chartShot(page, info, 'unavailable-step');
  await stepButton(page, '1h').click();
  await expect(chart).toHaveAttribute('data-status', 'drawn');
  await expect(chart.locator('.sh-candles__message')).toHaveCount(0);
  await common(page);
});

test('SH-BOX-CANDLES no trade yet: one line instead of the chart', async ({ page }, info) => {
  await serve(page, gpuPoorLifeV2('scheduled'), { candleItems: [] });
  await expect(candles(page).locator('.sh-candles__message')).toHaveText('No trades yet', { timeout: 30_000 });
  await chartShot(page, info, 'no-trades');
  await common(page);
});

/**
 * A finger's swipe from (x, y) by (dx, dy): the browser's own touch events, start, ten moves, end. Not Chromium's
 * synthesizeScrollGesture with a touch source: on Linux (Chromium 153, headless shell and new headless alike) that
 * gesture scrolls no page at all, not even a bare 3000 px one, while these touch events do (SH-195).
 */
async function swipe(page: Page, cdp: CDPSession, x: number, y: number, dx: number, dy: number) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * i) / 10, y: y + (dy * i) / 10 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test('SH-BOX-CANDLES on a phone: a vertical swipe over the chart scrolls the page; nothing scrolls sideways', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'touch: the phone project');
  await serve(page, gpuPoorLifeV2('raising'));
  const chart = candles(page);
  await expect(chart).toHaveAttribute('data-status', 'drawn', { timeout: 30_000 });
  const plot = chart.locator('.sh-candles__plot');
  await plot.scrollIntoViewIfNeeded();
  const box = await plot.boundingBox();
  if (!box) throw new Error('the plot has no box');
  const before = await page.evaluate(() => window.scrollY);
  // A finger's swipe up over the middle of the plot.
  const cdp = await page.context().newCDPSession(page);
  const [x, y] = [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)];
  await swipe(page, cdp, x, y, 0, -200);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before + 50);
  // A sideways swipe moves the chart, never the page.
  await swipe(page, cdp, x, y, 120, 0);
  expect(await page.evaluate(() => window.scrollX)).toBe(0);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
});

test('SH-BOX-CANDLES fix round 1 (F4): the visitor\'s zoom stays while the snapshot moves on; a press of Max shows the whole life again', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'the mouse wheel: the desktop project');
  const state = await serve(page, gpuPoorLifeV2('graduated'));
  const chart = candles(page);
  await expect(chart).toHaveAttribute('data-status', 'drawn', { timeout: 30_000 });
  await expect(chart).toHaveAttribute('data-choice', 'max');
  const plot = chart.locator('.sh-candles__plot');
  await plot.scrollIntoViewIfNeeded();
  const box = await plot.boundingBox();
  if (!box) throw new Error('the plot has no box');
  await page.mouse.move(0, 0);
  const fitted = await plot.screenshot();
  // The visitor zooms in with the wheel, then moves the pointer off the chart (no crosshair in the pictures).
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2);
  await page.mouse.wheel(0, -600);
  await page.mouse.move(0, 0);
  await expect.poll(async () => (await plot.screenshot()).equals(fitted)).toBe(false);
  const zoomed = await plot.screenshot();
  // Two more feed reads with a new block a second later, the box idle: Max's time runs on, its figures stand.
  const reads = state.feedReads;
  const asOf = state.body.asOf as { block: string; timestamp: string };
  state.body = { ...state.body, asOf: { ...asOf, block: String(BigInt(asOf.block) + 1n), timestamp: String(BigInt(asOf.timestamp) + 1n) }, money: { ...(state.body.money as Wire), block: String(BigInt(asOf.block) + 1n) } };
  await expect.poll(() => state.feedReads, { timeout: 15_000 }).toBeGreaterThan(reads + 1);
  await page.waitForTimeout(500);
  expect((await plot.screenshot()).equals(zoomed), 'the zoom kept').toBe(true);
  // A press of Max: the box's whole life on one screen again.
  await stepButton(page, 'Max').click();
  await page.mouse.move(0, 0);
  await expect.poll(async () => (await plot.screenshot()).equals(fitted)).toBe(true);
  await common(page);
});

// SH-224 phase 3 (review XR-SH-224, F1, N1, N2): the v2 box page's header with adversarial words. A name of 120 letters
// and a description of 1,024 bytes, neither with a space, and an 11-letter ticker (the spec's longest), written into GPU
// Poor's spec (re-encoded, its record's hash with it, as the chain would hold such a box).
const LONG_NAME = 'Supercalifragilistic'.repeat(6);
const LONG_TICKER = 'WWWWWWWWWWW';
const LONG_DESCRIPTION = 'Rentfree'.repeat(128);

function withLongWords(fixture: LifeFixtureV2): LifeFixtureV2 {
  const body = structuredClone(fixture.body) as Wire;
  const row = body.row as Wire;
  const words = { tokenName: LONG_NAME, collectionName: LONG_NAME, tokenSymbol: LONG_TICKER, description: LONG_DESCRIPTION };
  const spec = decodeAbiParameters([boxSpecV2Parameter], row.encodedSpec as Hex)[0] as unknown as BoxSpecV2;
  const encodedSpec = encodeBoxSpecV2({ ...spec, ...words });
  const specHash = keccak256(encodedSpec);
  return { body: { ...body, row: { ...row, encodedSpec, specHash, spec: { ...(row.spec as Wire), ...words }, record: { ...(row.record as Wire), specHash } } }, activity: fixture.activity };
}

test('SH-224 a long unbroken name, ticker and description: the description shown whole at 390, 640, 641, 800 and 1440 px, the page never wider than the screen', async ({ page }, info) => {
  // Five widths, each measured after its own layout: more time than one page's check.
  test.setTimeout(180_000);
  expect(LONG_DESCRIPTION).toHaveLength(1024);
  await serve(page, withLongWords(gpuPoorLifeV2('graduated')));
  const head = page.locator('header.sh-bpic-head');
  await expect(head.getByRole('heading', { level: 1 })).toHaveText(LONG_NAME);
  // The local source's twin of Sepolia is a local chain, as the chip's title says (F2).
  await expect(head.locator('.sh-box-chain')).toHaveAttribute('title', 'Local chain');
  await expect(head.locator('.sh-box-chain__short')).toHaveText('Local chain');
  // 640 and 641: the two sides of the phone breakpoint (the description's phone copy, then BoxHeader's own line).
  for (const width of info.project.name === 'mobile' ? [390] : [390, 640, 641, 800, 1440]) await test.step(`${width} px`, async () => {
    await page.setViewportSize({ width, height: 900 });
    // Exactly one copy of the description is shown at each width (beside the picture, or under the band on a phone),
    // whole, and inside the screen.
    const shown = head.getByText(LONG_DESCRIPTION, { exact: true }).locator('visible=true');
    await expect(shown, `${width} px`).toHaveCount(1);
    await expect(shown, `${width} px`).toBeVisible();
    const box = await shown.boundingBox();
    expect(box, `${width} px`).not.toBeNull();
    expect((box?.x ?? 0) + (box?.width ?? 0), `${width} px: the description inside the screen`).toBeLessThanOrEqual(width);
    expect(box?.x ?? -1, `${width} px: the description's left edge on the screen`).toBeGreaterThanOrEqual(0);
    // Never cut in height: no line clamp, no max-height (SH-224 phase 4: "no line limit").
    const cut = await shown.evaluate((node) => ({ scroll: node.scrollHeight, client: node.clientHeight }));
    expect(cut.scroll, `${width} px: the description not cut (${cut.scroll} > ${cut.client})`).toBeLessThanOrEqual(cut.client);
    await expect(head.locator('.sh-fit-ca--compact strong')).toHaveText(LONG_TICKER);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    // On a failure, the elements that reach past the screen's right edge, deepest first, name the cause.
    const past = await page.evaluate(() => [...document.querySelectorAll('main *')].filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5)
      .filter((el) => ![...el.children].some((child) => child.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5))
      .slice(0, 6).map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} right=${Math.round(el.getBoundingClientRect().right)}`));
    expect(await overflow(page), `${width} px: no sideways scroll; past the edge: ${past.join(' | ')}`).toBeLessThanOrEqual(0);
  });
  expect(await walletTouches(page)).toEqual([]);
});
