import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { collectWords, summarise } from '../../../scripts/lib/visible-words.mjs';
import { boxHeader, installUntouchableWallet, noTradingControls, overflow, walletTouches } from './box-helpers';

// Core v1 on the site (S10a § 5, § 6; BC-084, -085, -086, -089, -090, -091, -092, -094, -095, -099), hermetic: the app
// is built with the local core manifest recorded with box 0's life (e2e/fixtures/core-local/), and the indexer origin
// it names (127.0.0.1:8596, where nothing runs) is answered from the gateway answers recorded at each stage of that
// life. Nothing leaves this machine. SH_EVIDENCE_SCREENSHOTS=1 writes docs/evidence/screenshots/S10a/ (box 0 in each
// phase at 1280 and 400 px).

interface RowJson {
  readonly record: { readonly boxId: string; readonly contracts: readonly string[] } & Record<string, unknown>;
}
interface Stage {
  readonly block: string;
  readonly feed: { readonly cards: readonly (Record<string, unknown> & { readonly row: RowJson })[] } & Record<string, unknown>;
  readonly box: Record<string, unknown>;
  readonly activity: unknown;
  readonly candles: unknown;
  readonly wallets: Readonly<Record<string, { readonly boxes: readonly (Record<string, unknown> & { readonly row: RowJson })[] } & Record<string, unknown>>>;
}
const LIFE = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/core-local/life.json', import.meta.url)), 'utf8')) as { token: string; accounts: Readonly<Record<string, string>>; stages: Readonly<Record<string, Stage>> };
const TOKEN = LIFE.token;
const BOX0 = `/box/11155111/${TOKEN}`;
const ORIGIN = 'http://127.0.0.1:8596';
const EVIDENCE = process.env.SH_EVIDENCE_SCREENSHOTS === '1';
const evidenceDir = fileURLToPath(new URL('../../../docs/evidence/screenshots/S10a/', import.meta.url));
const stage = (name: string): Stage => {
  const s = LIFE.stages[name];
  if (!s) throw new Error(`no stage ${name}`);
  return s;
};

/** Chooses the local chain as the data source before the app starts (the build offers it: a core manifest is embedded). */
async function onLocal(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem('squarehole.data-source.v1', JSON.stringify({ source: 'local' })));
}

/** The indexer answers of one stage (and anything off this machine refused). Returns the paths asked for. */
async function serve(page: Page, s: Stage, overrides: { feed?: unknown; wallet?: unknown; activity?: unknown } = {}): Promise<string[]> {
  const asked: string[] = [];
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (route) => route.abort());
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    const path = `${url.pathname}${url.search}`;
    asked.push(path);
    let body: unknown;
    if (url.pathname === '/v1/feed') body = overrides.feed ?? s.feed;
    else if (url.pathname.endsWith('/activity')) body = overrides.activity ?? s.activity;
    else if (url.pathname.endsWith('/candles')) body = s.candles;
    else if (url.pathname.startsWith('/v1/wallets/')) body = overrides.wallet ?? s.wallets['alice'];
    else if (url.pathname === `/v1/boxes/11155111/${TOKEN}`) body = s.box;
    if (body === undefined) return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '{}' });
    return route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  });
  return asked;
}

async function shot(page: Page, testInfo: TestInfo, name: string) {
  const width = testInfo.project.name === 'mobile' ? 400 : 1280;
  await page.setViewportSize({ width, height: testInfo.project.name === 'mobile' ? 860 : 900 });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.evaluate(() => window.scrollTo(0, 0));
  const file = EVIDENCE ? `${evidenceDir}${name}-${width}.png` : testInfo.outputPath(`${name}-${width}.png`);
  if (EVIDENCE) mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({ path: file, fullPage: true, scale: 'css' });
}

test.beforeEach(async ({ page }) => {
  await installUntouchableWallet(page);
  await onLocal(page);
});

const PHASES = [
  { stage: 'upcoming', label: 'Upcoming', figure: /^in (~\d+ (min|h)|<1 min)$/, phase: /^Launch tax 93\.20% → 8\.06% on buys$/ },
  { stage: 'window', label: 'Launch window', figure: /^tax \d+\.\d\d% · (~\d+ min|<1 min) left$/, phase: /^Launch tax \d+\.\d\d% on buys$/ },
  { stage: 'bonding', label: 'Bonding', figure: /^\d+\.\d% · [\d.]+ \/ 4\.206980085 ETH$/, phase: null },
  { stage: 'closed', label: 'Graduating', figure: /^filled · graduating$/, phase: /^Filled: waiting for anyone’s graduate\(\)$/ },
  { stage: 'stream', label: 'Graduated', figure: /^[\d.]+ ETH per 1M FIT$/, phase: /^Graduated at block [\d,]+$/ },
] as const;

for (const p of PHASES) {
  test(`BC-084: box 0 from its row, ${p.stage}: band, phase line, stats; no deadline (BC-090); safe and short (BC-091); no trading (BC-092)`, async ({ page }, testInfo) => {
    await serve(page, stage(p.stage));
    await page.goto(BOX0);
    const header = boxHeader(page);
    await expect(header.locator('.sh-box-band__label')).toHaveText(p.label);
    await expect(header.locator('.sh-box-band__figure')).toHaveText(new RegExp(`^: ${p.figure.source.slice(1)}`));
    if (p.phase === null) await expect(header.locator('.sh-box-phase')).toHaveCount(0);
    else await expect(header.locator('.sh-box-phase')).toHaveText(p.phase);
    await expect(header.locator('.sh-box-stat dt')).toHaveText(['Price', 'FDV', 'Burned', 'Items']);
    await expect(header).not.toContainText(/deadline|Ends \d+ d/i);
    // Box 0 by its row: the Misfits pack attaches by its collection (BC-095), Featured kind "Genesis box".
    await expect(header).toContainText('Genesis box');
    // A local twin with Sepolia's chain id: the chip names the source, never Sepolia.
    await expect(header.locator('.sh-box-chain')).toHaveAttribute('title', 'Local chain (Sepolia twin)');
    await expect(header.locator('.sh-box-peekstrip img').first()).toBeVisible();
    await noTradingControls(page);
    expect(await walletTouches(page)).toEqual([]);
    if (testInfo.project.name === 'mobile') {
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      const words = summarise((await page.evaluate(collectWords)).words);
      expect(words.viewportMain.words, `${p.stage}: words in <main> on the phone's first screen`).toBeLessThanOrEqual(45);
    }
    await shot(page, testInfo, `box0-${p.stage}`);
  });
}

for (const p of PHASES) {
  test(`BC-084 ${p.stage}: box 0 on the feed and in a wallet, each in its own state; no layout break, no trading, no wallet asked (BC-092)`, async ({ page }) => {
    const s = stage(p.stage);
    await serve(page, s);
    await page.goto('/');
    const card = page.getByRole('list', { name: 'Boxes' }).locator('li', { has: page.locator(`a[href="${BOX0}"]`) });
    await expect(card).toContainText(p.label);
    await noTradingControls(page);
    await page.goto(`/wallet/${LIFE.accounts['alice']}`);
    const holdings = page.locator('section.sh-box-holding');
    if ((s.wallets['alice']?.boxes.length ?? 0) === 0) {
      await expect(page.locator('main h1, main h2').first()).toBeVisible();
      await expect(holdings).toHaveCount(0);
    } else {
      await expect(holdings).toHaveCount(1);
      await expect(holdings).toContainText(p.label);
      await expect(holdings.locator(`a[href="${BOX0}"]`)).toBeVisible();
    }
    await expect(page.locator('main')).not.toContainText(/Unavailable|Unverified|Stale/);
    await noTradingControls(page);
    expect(await walletTouches(page)).toEqual([]);
  });
}

test('BC-099, BC-142: the Token tab after graduation: F77 fees with live totals, the pool row read from the chain, the stream, the draws; no link on a local chain', async ({ page }, testInfo) => {
  await serve(page, stage('stream'));
  await page.goto(`${BOX0}?tab=token`);
  const fees = page.locator('[data-card="core-fees"]');
  await expect(fees).toContainText(/Fees so far: [\d.]+ ETH · [\d.]+[KMB]? FIT/);
  await expect(fees).toContainText('11/15 burns FIT');
  // After graduation the 13/15 T funds the per-Misfit stream: both parts, so the sides add up (S10a review).
  await expect(fees.locator('.sh-core-facts__row', { hasText: '13/15 burned or to the per-Misfit stream' })).toContainText(/[\d.]+[KMB]? FIT burned · [\d.]+[KMB]? FIT to the stream/);
  await expect(fees.locator('.sh-core-facts__row', { hasText: '2/15 platform' })).toHaveText(/^2\/15 platform[\d.]+ ETH$/);
  await expect(page.locator('[data-card="core-pool"]')).toContainText(/In the pool[\d.]+ ETH \+ [\d.]+M FIT/);
  await expect(page.locator('[data-card="core-stream"]')).toContainText(/Per Misfit so far/);
  await expect(page.locator('[data-card="core-draws"]')).toContainText(/Draws settled1 of 1/);
  await expect(page.locator('[data-card="core-activity"] li').first()).toBeVisible();
  // The contract address always; no link out on a local chain (links follow the source, not the chain id).
  await expect(page.locator('.sh-fit-ca__address')).toHaveText(new RegExp(`^${TOKEN}$`, 'i'));
  await expect(page.locator('main a[href^="http"]')).toHaveCount(0);
  await noTradingControls(page);
  await shot(page, testInfo, 'box0-token-graduated');
});

test('SH-BOX0-LIVE-CURVE: box 0’s Token tab opens with the live curve card from the gateway’s answer: price, fill, ETH in the curve; no control; nothing wider than the screen', async ({ page }) => {
  await serve(page, stage('bonding'));
  await page.goto(`${BOX0}?tab=token`);
  const main = page.locator('.sh-box-token .sh-fit-grid__main');
  const curve = page.getByRole('region', { name: 'Bonding curve' });
  await expect(curve).toBeVisible();
  // The first card of the main column; the row page's cards follow in their order.
  await expect(main.locator(':scope > section').first()).toHaveAttribute('aria-labelledby', 'fit-curve-title');
  expect(await main.locator(':scope > section').evaluateAll((cards) => cards.slice(1).map((c) => c.getAttribute('data-card')))).toEqual(['core-fees', 'core-pool', 'core-stream', 'core-draws', 'core-activity']);
  await expect(curve.locator('.sh-fit-chip')).toHaveText('Live');
  // The recorded gateway at block 107: 0.000000004337130543 ETH per FIT, 1.152172034645046223 of 4.206980085 ETH, 2738 bps.
  await expect(curve.locator('.sh-fit-hero__price dd')).toHaveText('0.0043371 ETH per 1M FIT');
  await expect(curve.locator('.sh-fit-band__pct')).toHaveText('27.3%');
  await expect(curve.locator('.sh-fit-band__text')).toHaveText('1.1521 of 4.206980085 ETH');
  await expect(curve.getByRole('progressbar')).toHaveAttribute('aria-valuetext', '1.152172034 ETH of 4.206980085 ETH (27.3%) · after sells');
  await expect(curve.locator('svg.sh-fit-chart__svg')).toBeVisible();
  // The (i) carries the freshness line: the block and the chain read that matched the price.
  await curve.getByRole('button', { name: 'About the bonding curve' }).click();
  await expect(curve.locator('.sh-info-panel__data')).toHaveText(/^Data: block 107, from the live service; its price matched a direct chain read at block 107\./);
  await expect(curve.locator('a, input, iframe')).toHaveCount(0);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await noTradingControls(page);
  expect(await walletTouches(page)).toEqual([]);
});

/** One activity row as the gateway answers it (the indexer's fields; packages/indexer/src/core/derive-core.ts). */
const activityRow = (kind: string, block: number, logIndex: number, timestamp: string, data: Record<string, string>) => ({
  id: `${block}-${logIndex}`, kind, block: String(block), blockHash: `0x${'ab'.repeat(32)}`, timestamp,
  txHash: `0x${(block * 100 + logIndex).toString(16).padStart(64, '0')}`, logIndex, data,
});

test('F142 R64-ROWS "hide": box 0’s Activity card shows no backup start or fix: no raw kind, no label, the same rows as without them, no hint', async ({ page }) => {
  const s = stage('word');
  const plain = s.activity as { readonly items: readonly Record<string, unknown>[] } & Record<string, unknown>;
  const by = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
  // Between the word stage's newest rows, in its newest-first order (111-0 word_stored, 110-0 round_posted, 109-23 ...).
  const fixed = activityRow('backup_fixed', 110, 5, '1790765364', { round: '32654000', targetBlock: '366', mix: `0x${'12'.repeat(32)}`, by });
  const started = activityRow('backup_started', 109, 30, '1790765352', { round: '32654000', targetBlock: '366', by });
  const [first, second, ...rest] = plain.items;
  if (!first || !second) throw new Error('the word stage has fewer than two activity rows');
  const card = page.locator('[data-card="core-activity"]');
  const read = async () => ({ kinds: await card.locator('li').evaluateAll((lis) => lis.map((li) => li.getAttribute('data-kind'))), text: await card.innerText() });
  await serve(page, s, { activity: plain });
  await page.goto(`${BOX0}?tab=token`);
  await expect(card.locator('li')).toHaveCount(12);
  const want = await read();
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await serve(page, s, { activity: { ...plain, items: [first, fixed, second, started, ...rest] } });
  await page.goto(`${BOX0}?tab=token`);
  await expect(card.locator('li')).toHaveCount(12);
  expect(await read()).toEqual(want);
  await expect(card.locator('[data-kind^="backup"]')).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText(/backup/i);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await serve(page, s, { activity: { ...plain, items: [fixed, started] } });
  await page.goto(`${BOX0}?tab=token`);
  await expect(card).toContainText('Nothing yet');
  await expect(card.locator('li')).toHaveCount(0);
  await noTradingControls(page);
});

test('C19: the indexer refusing connections (and no chain to read either) never says box 0 is not there; the wallet chip names the source', async ({ page }) => {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (route) => route.abort());
  await page.route(`${ORIGIN}/**`, (route) => route.abort('connectionrefused'));
  await page.goto(BOX0);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Unavailable', { timeout: 30_000 });
  // SH-SITE-FIXES-10: a few words and Retry; the reason behind Details.
  await expect(page.getByRole('main').getByRole('status')).toHaveText('The box could not be read.');
  await expect(page.getByRole('main').getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(page.locator('main')).not.toContainText(/Not in Local chain|is not on .* in this build|Box not found/);
  await page.goto(`/wallet/${LIFE.accounts['alice']}`);
  await expect(page.locator('main')).toContainText(/Unavailable/, { timeout: 30_000 });
  await expect(page.locator('main .sh-box-chain').first()).toHaveAttribute('title', 'Local chain (Sepolia twin)');
  await expect(page.locator('main')).not.toContainText('Sepolia testnet');
  expect(await walletTouches(page)).toEqual([]);
});

test('BC-086: /misfits opens box 0 by its row', async ({ page }) => {
  await serve(page, stage('bonding'));
  await page.goto('/misfits');
  await expect(page).toHaveURL(new RegExp(`${BOX0}$`));
});

/** A feed answer with `count` boxes (box 0 and boxes of other ids), each in its own phase with its own figure. */
function feedOf(count: number, tweak: (i: number, card: Record<string, unknown>) => Record<string, unknown> = (_, c) => c): unknown {
  const phases = ['upcoming', 'window', 'bonding', 'graduating', 'graduated'];
  const base = stage('bonding').feed;
  const card0 = base.cards[0];
  if (!card0) throw new Error('no card');
  const cards = Array.from({ length: count }, (_, i) => {
    const token = i === 0 ? TOKEN : `0x${(0x1000 + i).toString(16).padStart(40, 'a')}`;
    const row = { ...card0.row, record: { ...card0.row.record, boxId: String(i), contracts: card0.row.record.contracts.map((a, role) => (role === 1 ? token : a)) } };
    const phase = phases[i % phases.length] ?? 'bonding';
    return tweak(i, { ...card0, token, row, phase, fillBps: phase === 'bonding' ? 1_000 + i : phase === 'graduating' || phase === 'graduated' ? 10_000 : 0, retainedQ: String(10n ** 17n * BigInt(i + 1)), fdvQ: String(10n ** 18n * BigInt(i + 1)), volumeQ: String(i) });
  });
  return { ...base, cards };
}

for (const count of [2, 50]) {
  test(`BC-085: ${count} boxes from ONE feed request, each card its own state`, async ({ page }, testInfo) => {
    const asked = await serve(page, stage('bonding'), { feed: feedOf(count) });
    await page.goto('/');
    const grid = page.getByRole('list', { name: 'Boxes' });
    await expect(grid.locator('a[href^="/box/11155111/"]')).toHaveCount(count);
    // One request for every card; no per-card stream or box request from the feed.
    expect(asked.filter((path) => path.startsWith('/v1/feed'))).toHaveLength(1);
    expect(asked.filter((path) => path.startsWith('/v1/boxes/'))).toEqual([]);
    // Box 0 is Featured and shows its own figure; the next box its own state.
    const box0 = page.locator(`a[href="${BOX0}"]`).first();
    await expect(box0).toContainText('Upcoming');
    if (count >= 3) await expect(page.locator(`a[href="/box/11155111/0x${(0x1002).toString(16).padStart(40, 'a')}"]`)).toContainText('Bonding');
    await noTradingControls(page);
    if (count === 2) await shot(page, testInfo, 'feed-two-boxes');
  });
}

test('BC-094: one Stale and one Unverified box next to a healthy one; only those say so, no FDV on the Unverified one', async ({ page }) => {
  await serve(page, stage('stream'), { feed: feedOf(3, (i, card) => ({ ...card, phase: 'graduated', fillBps: 10_000, stale: i === 1, verified: i !== 2, fdvQ: i === 2 ? null : card.fdvQ })) });
  await page.goto('/');
  const cardOf = (i: number) => page.getByRole('list', { name: 'Boxes' }).locator('li', { has: page.locator(`a[href="/box/11155111/${i === 0 ? TOKEN : `0x${(0x1000 + i).toString(16).padStart(40, 'a')}`}"]`) });
  await expect(cardOf(1)).toContainText(/Stale · since block/);
  await expect(cardOf(2)).toContainText('Unverified');
  await expect(cardOf(2)).toContainText('FDV not available');
  await expect(cardOf(0)).not.toContainText(/Stale|Unverified/);
  await expect(cardOf(0)).toContainText(/FDV [\d.]+ ETH/);
});

test('BC-089: a wallet across 5 boxes, two with the same ticker, one holding per box address, nothing summed', async ({ page }, testInfo) => {
  const alice = stage('stream').wallets['alice'];
  const first = alice?.boxes[0];
  if (!alice || !first) throw new Error('no wallet');
  const boxes = Array.from({ length: 5 }, (_, i) => {
    const token = i === 0 ? TOKEN : `0x${(0x2000 + i).toString(16).padStart(40, 'b')}`;
    const row = { ...first.row, record: { ...first.row.record, boxId: String(i), contracts: first.row.record.contracts.map((a, role) => (role === 1 ? token : a)) } };
    return { ...first, token, row, t: String(10n ** 21n * BigInt(i + 1)), tickets: [], items: [] };
  });
  await serve(page, stage('stream'), { wallet: { ...alice, boxes } });
  await page.goto(`/wallet/${LIFE.accounts['alice']}`);
  await expect(page.locator('section.sh-box-holding')).toHaveCount(5);
  await expect(page.locator('section.sh-box-holding .sh-box-wtile strong').first()).toHaveText('1K FIT');
  await expect(page.locator('main')).not.toContainText(/15K FIT|15,000 FIT/);
  expect(await walletTouches(page)).toEqual([]);
  await shot(page, testInfo, 'wallet-five-boxes');
});
