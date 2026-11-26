import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import { encodeBoxSpecV2, decodeBoxSpecV2 } from '../../../packages/chain/src/core/v2';
import { makePng } from '../../../packages/artwork/src/test-support/images';
import { installUntouchableWallet, openBox, walletTouches } from './box-helpers';
import { mixedDeployment } from '../src/features/core/v2/test-support/mixed-deployment';
import { A, ETH, publishedItems, publishedPile } from '../src/features/core/v2/test-support/m3-published';
import { publishedM2 } from '../src/features/core/v2/test-support/m2-published';
import { m3RpcFixture } from '../src/features/core/v2/test-support/m3-rpc';
import { m2RpcFixture, type RpcCall } from '../src/features/core/v2/test-support/m2-rpc';
import { claimsBoxOf, claimsPageJson, type ClaimRow } from '../src/features/core/v2/test-support/claims-page';

// SH-V2-FE3 evidence (extended by SH-V2-FE4: the template row, Claim all on a box page and on My Box; and by SH-V2-FE5:
// Claim all from the wallet claims index with Claimed after a reload, the seed return, the item panel's paging): the v2 surface
// against the founder's standing rules, at 375 px (mobile project) and 1440 px
// (desktop): the four sample v2 boxes, the creation flow (a token with a coin pile, a collection with To items) and the
// synthetic M2/M3 box pages. Every page is checked for sideways scroll, short labels (chips, buttons, tabs, figures)
// on one line, at most one short visible sentence per card, and (SH-V2-FE8, F130, superseding FE3's "one Demo badge"
// rule) no Demo or mock word anywhere: text, hidden text, accessible names, titles and the page title.
// Runs only with SH_FE3_SHOTS=1, which writes full-page screenshots to docs/evidence/SH-V2-FE3/<name>-375.png and
// -1440.png (or SH_FE3_DIR) and each page's measurements to e2e/.artifacts/fe3-survey/; ordinary runs skip it.

const SHOTS = process.env.SH_FE3_SHOTS === '1';
test.skip(!SHOTS, 'evidence sweep only: SH_FE3_SHOTS=1');

const dir = process.env.SH_FE3_DIR ? `${process.env.SH_FE3_DIR.replace(/\/$/, '')}/` : fileURLToPath(new URL('../../../docs/evidence/SH-V2-FE3/', import.meta.url));
/** Each page's measurements, beside Playwright's other output (git-ignored). */
const reportDir = fileURLToPath(new URL('./.artifacts/fe3-survey/', import.meta.url));
const CORE = 'http://127.0.0.1:8596';
const RPC = 'http://127.0.0.1:8599';
const token = (n: number) => `0xde027${'0'.repeat(31)}${n.toString(16).padStart(4, '0')}`;
const DEMO = { marbles: `/box/31337/${token(1)}`, keys: `/box/31337/${token(2)}`, hats: `/box/31337/${token(3)}`, boats: `/box/31337/${token(4)}` } as const;

const width = (info: TestInfo) => (info.project.name === 'mobile' ? 375 : 1440);
async function sized(page: Page, info: TestInfo) {
  await page.setViewportSize(info.project.name === 'mobile' ? { width: 375, height: 812 } : { width: 1440, height: 900 });
}

interface Survey {
  readonly overflow: number;
  /** Chips and short labels that wrapped onto a second line. */
  readonly wrapped: readonly string[];
  /** Cards showing more than one sentence outside closed disclosures and info panels. */
  readonly walls: readonly string[];
  /** F130: every Demo or mock word in the page (none allowed): text runs, names, titles, alt texts and the title. */
  readonly demoWords: readonly string[];
}

/** What the rules care about, measured in the page as rendered. */
async function survey(page: Page): Promise<Survey> {
  return page.evaluate(() => {
    const shown = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && !el.closest('[hidden], [aria-hidden="true"]');
    };
    // What a reader sees: innerText leaves out closed info panels and disclosures.
    const text = (el: Element) => ((el as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim();
    // A short label (40 characters or fewer: a chip, button, tab, figure or value) wraps when one of its text runs
    // breaks onto a second line; a hint under a label is its own run, so a two-line tile by design is not a wrap.
    const runWraps = (node: Node) => {
      const range = document.createRange(); range.selectNodeContents(node);
      return new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size > 1;
    };
    const main = document.querySelector('main') ?? document.body;
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    const wrapped: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      // Screen-reader-only words (clipped to 1 px) and headings are not labels.
      // Accepted: the state band's figure under a desktop cover ("22.0% · 0.9255 / 4.206980085 ETH", the exact raise)
      // may take two lines; it is a status line, not a chip.
      if (!parent || !node.textContent?.trim() || !shown(parent) || /^H[1-6]$/.test(parent.tagName) || parent.closest('.sh-visually-hidden, .sh-box-band__figure')) continue;
      const label = parent.closest('button, a, label, dt, dd, li, [role="tab"], [class*="chip"], [class*="badge"], [class*="stat"], [class*="count"]') ?? parent;
      const words = text(label);
      if (words.length > 0 && words.length <= 40 && runWraps(node)) wrapped.push(words);
    }
    // A sentence: two or more words ending in . ! or ? (figures and labels do not count).
    const sentences = (value: string) => value.split(/(?<=[.!?])\s+/).filter((part) => /[.!?]$/.test(part) && part.trim().split(/\s+/).length >= 2).length;
    const CARD = 'section, .sh-panel, article, fieldset, .sh-newbox-field, header, form, main';
    const blocks = [...main.querySelectorAll('p, li, dd, small, .sh-newbox-hint')].filter((el) => shown(el) && !el.closest('details:not([open])'));
    const leaves = blocks.filter((el) => !blocks.some((other) => other !== el && el.contains(other)));
    const byCard = new Map<Element, string[]>();
    for (const el of leaves) {
      const card = el.parentElement?.closest(CARD) ?? main;
      if (sentences(text(el)) > 0) byCard.set(card, [...(byCard.get(card) ?? []), text(el)]);
    }
    const walls = [...byCard].flatMap(([card, lines]) => {
      const count = lines.reduce((sum, line) => sum + sentences(line), 0);
      if (count <= 1) return [];
      const title = text(card.querySelector('h1, h2, h3, legend, .sh-newbox-label') ?? card).slice(0, 40);
      return [`${title} · ${count}: ${lines.join(' | ').slice(0, 300)}`];
    });
    // F130: no Demo or mock word anywhere, shown or not (a badge, chip, tape, label, explanation, accessible name, title),
    // the top bar's included.
    const DEMO = /(?<![a-z])(?:demo|mock)s?(?![a-z])/i;
    const all: string[] = [];
    const words = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = words.nextNode(); node; node = words.nextNode()) if (node.parentElement?.tagName !== 'SCRIPT' && node.parentElement?.tagName !== 'STYLE') all.push(node.textContent ?? '');
    for (const element of document.querySelectorAll('*')) for (const name of ['aria-label', 'aria-description', 'title', 'placeholder', 'alt']) all.push(element.getAttribute(name) ?? '');
    all.push(document.title);
    const demoWords = [...new Set(all.map((value) => value.replace(/\s+/g, ' ').trim()).filter((value) => DEMO.test(value)))];
    return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, wrapped, walls, demoWords };
  });
}

async function look(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const seen = await survey(page);
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}${name}-${width(info)}.png`, fullPage: true, scale: 'css' });
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(`${reportDir}${name}-${width(info)}.json`, JSON.stringify(seen, null, 2));
  expect.soft(seen.overflow, `${name}: no sideways scroll`).toBeLessThanOrEqual(0);
  expect.soft(seen.wrapped, `${name}: chips and labels on one line`).toEqual([]);
  expect.soft(seen.walls, `${name}: at most one visible sentence per card`).toEqual([]);
  expect.soft(seen.demoWords, `${name}: no Demo or mock word anywhere (F130)`).toEqual([]);
}

test.beforeEach(async ({ page }, info) => {
  await installUntouchableWallet(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await sized(page, info);
});

test('FE3: the four sample v2 boxes', async ({ page }, info) => {
  for (const [slug, path] of Object.entries(DEMO)) {
    await openBox(page, path);
    await look(page, info, `demo-${slug}`);
  }
  expect(await walletTouches(page)).toEqual([]);
});

// --- Creation flow (the sample data) ---------------------------------------------------------------------------------------
const heading = (page: Page) => page.getByRole('heading', { level: 1 });
const next = (page: Page) => page.getByRole('button', { name: 'Next', exact: true });
const png = (size: number) => ({ name: `p${size}.png`, mimeType: 'image/png', buffer: Buffer.from(makePng({ width: size, height: size, decodable: true })) });
const artFiles = (n: number) => [
  ...Array.from({ length: n }, (_, i) => ({ name: `${i + 1}.png`, mimeType: 'image/png', buffer: Buffer.from(makePng({ width: 24 + i, height: 24, decodable: true })) })),
  { name: 'traits.csv', mimeType: 'text/csv', buffer: Buffer.from(['id,Colour', ...Array.from({ length: n }, (_, i) => `${i + 1},${i % 2 ? 'Teal' : 'Red'}`)].join('\n')) },
];
async function basics(page: Page, info: TestInfo, name: string, ticker: string, shoot: boolean) {
  await page.goto('/create/v2-basics');
  await page.getByRole('textbox', { name: 'Name' }).fill(name);
  await page.getByRole('textbox', { name: 'Ticker' }).fill(ticker);
  await page.locator('#create-logo').setInputFiles(png(512));
  await expect(page.getByRole('button', { name: 'Logo Change' })).toBeAttached();
  if (shoot) await look(page, info, 'create-1-basics');
  await next(page).click();
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 2 of 6: Contents');
}

test('FE3: create a token with a coin pile, every step', async ({ page }, info) => {
  test.setTimeout(120_000);
  await basics(page, info, "Dragon's Hoard", 'HOARD', true);
  await page.getByRole('radio', { name: /^Token/ }).check();
  await page.getByRole('group', { name: /^Coin pile/ }).getByRole('radio', { name: /^Coin pile/ }).check();
  await page.getByRole('group', { name: 'Seed coin' }).getByRole('radio', { name: 'USDC', exact: true }).check();
  await page.getByRole('textbox', { name: /^Seed · USDC/ }).fill('1000');
  await look(page, info, 'create-2-contents-pile');
  await next(page).click();
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 3 of 6: Fees');
  await look(page, info, 'create-3-fees-token');
  await next(page).click();
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 4 of 6: Raise');
  await look(page, info, 'create-4-raise');
  await next(page).click();
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 5 of 6: Opening');
  await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check();
  await look(page, info, 'create-5-opening');
  await next(page).click();
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  await look(page, info, 'create-6-overview-pile');
  expect(await walletTouches(page)).toEqual([]);
});

test('FE3: create a collection with To items', async ({ page }, info) => {
  test.setTimeout(120_000);
  await basics(page, info, 'Bag Holders', 'TOTE', false);
  await page.getByRole('radio', { name: /^New collection/ }).check();
  await page.getByLabel('Images + traits').setInputFiles(artFiles(10));
  await page.locator('#create-collection-cover').setInputFiles(png(600));
  await expect(page.getByText('10 items · 1 trait')).toBeVisible();
  await look(page, info, 'create-2-contents-collection');
  await next(page).click();
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 3 of 6: Fees');
  for (const side of ['Buyers’', 'Sellers’']) await page.getByRole('group', { name: side === 'Buyers’' ? 'Buyers’ fees · in ETH' : 'Sellers’ fees · paid in TOTE, used as ETH' }).getByRole('button', { name: 'To items', exact: true }).click();
  await page.getByRole('group', { name: /^Sellers’ fees · paid in TOTE, used as ETH/ }).getByRole('button', { name: 'Buy back and burn TOTE in the vault' }).click();
  await look(page, info, 'create-3-fees-items');
  await next(page).click();
  await next(page).click();
  await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check();
  await next(page).click();
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  await look(page, info, 'create-6-overview-items');
  expect(await walletTouches(page)).toEqual([]);
});

// --- Synthetic M2/M3 box pages ------------------------------------------------------------------------------------
type Body = { token: string; row: { chainId: number; record: Record<string, unknown> }; asOf: { hash: string } } & Record<string, unknown>;
/**
 * The published card and RPC answers through the real source and page; the wallet signs nothing. `claims`, when given,
 * answers the wallet claims index (SH-V2-FE5) for the connected wallet; otherwise that route is absent (404), as on an
 * older gateway, and Claim all reads the chain directly. `account` is the test wallet's address (A by default).
 */
async function synthetic(page: Page, published: Body, request: (call: RpcCall) => Promise<unknown>, extra: { claims?: (chainId: number, wallet: Address) => unknown; account?: Address } = {}) {
  const data = await mixedDeployment();
  const body = { ...published, chainId: data.manifest.chainId,
    row: { ...published.row, chainId: data.manifest.chainId, record: { ...published.row.record, poolManager: data.manifest.chain.poolManager.address } } };
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (route) => route.abort());
  await page.route(`${CORE}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const wallet = (extra.account ?? A).toLowerCase() as Address;
    const answer = path === '/v1/feed' ? data.v1.feed : path === '/v2/feed' ? { ...data.feed, cards: [body] } : path.endsWith('/activity') ? { asOf: body.asOf, items: [], next: null }
      : extra.claims && path === `/v2/wallets/${data.manifest.chainId}/${wallet}/claims` ? extra.claims(data.manifest.chainId, wallet) : null;
    await route.fulfill({ status: answer ? 200 : 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(answer) });
  });
  await page.route(`${RPC}/**`, async (route) => {
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const call = route.request().postDataJSON() as RpcCall & { id: number };
    let answer;
    try { answer = { result: call.method === 'eth_chainId' ? toHex(data.manifest.chainId) : await request(call) }; }
    catch (error) { answer = { error: { code: (error as { code?: number }).code ?? -32601, message: (error as Error).message } }; }
    await route.fulfill({ headers, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: call.id, ...answer }) });
  });
  await page.exposeFunction('fe3Request', async ({ method }: RpcCall) => {
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [extra.account ?? A];
    if (method === 'eth_chainId') return toHex(data.manifest.chainId);
    throw new Error(`Unexpected wallet request ${method}`);
  });
  await page.addInitScript(() => {
    const provider = { request: (call: unknown) => (window as unknown as { fe3Request(call: unknown): Promise<unknown> }).fe3Request(call), on() {}, removeListener() {} };
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: {
      info: { uuid: '0fe30fe3-bf71-4c1c-9011-521e67622b70', name: 'FE3 test wallet', rdns: 'org.example.fe3', icon: 'data:image/svg+xml;base64,PHN2Zy8+' }, provider,
    } })));
  });
  await page.goto('/settings');
  await page.getByRole('radio', { name: /Local chain/ }).check();
  await page.goto(`/box/${data.manifest.chainId}/${body.token.toLowerCase()}`);
}
async function connect(page: Page, button: string) {
  await page.getByRole('button', { name: button, exact: true }).click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: /FE3 test wallet/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('FE3: an every-item box with this wallet’s items', async ({ page }, info) => {
  const published = await publishedItems();
  const rpc = m3RpcFixture({ owners: { '1': A, '2': A }, credits: { '1': [ETH / 4n, ETH], '2': [ETH / 4n + 1n, 0n] }, vault: published.at(3) });
  await synthetic(page, published.body as unknown as Body, rpc.request);
  await expect(page.getByRole('region', { name: 'Item payouts' })).toBeVisible();
  await look(page, info, 'box-items-before-wallet');
  await connect(page, 'Claim all');
  await expect(page.getByRole('region', { name: 'Item payouts' }).getByText('2 ready', { exact: true })).toBeVisible();
  await look(page, info, 'box-items-ready');
});

for (const [name, options] of [['box-pile-open', {}], ['box-pile-failed', { failed: true }]] as const) {
  test(`FE3: a coin pile box (${name})`, async ({ page }, info) => {
    const published = await publishedPile(options);
    const money = (published.body.money as { m3: { pile: { balance: string | null; supply: string } } }).m3.pile;
    const rpc = m3RpcFixture({ pile: { asset: published.asset, seeder: published.row.record.creator, seed: published.seed, balance: BigInt(money.balance ?? 0), supply: BigInt(money.supply) }, coinsT: 10n * ETH, allowanceT: 10n * ETH });
    await synthetic(page, published.body as unknown as Body, rpc.request);
    const pile = page.getByRole('region', { name: 'Coin pile' });
    await expect(pile).toBeVisible();
    if (name === 'box-pile-open') await pile.getByRole('textbox', { name: 'HOARD to redeem' }).fill('3');
    await look(page, info, name);
  });
}

test('FE3: a holder-payout shop box', async ({ page }, info) => {
  const m2 = await publishedM2(false);
  await synthetic(page, m2.body as unknown as Body, m2RpcFixture({}).request);
  await expect(page.getByRole('region', { name: 'Shop' })).toBeVisible();
  await look(page, info, 'box-holders-shop');
  await connect(page, 'Claim all');
  await look(page, info, 'box-holders-connected');
});

// --- SH-V2-FE4: templates and Claim all ------------------------------------------------------------------------------
test('FE4: create Basics after choosing a template', async ({ page }, info) => {
  await page.goto('/create/v2-basics');
  await page.getByRole('region', { name: 'Start from a template' }).getByRole('button', { name: /^Collection that burns/ }).click();
  await expect(page.getByRole('region', { name: 'Start from a template' }).getByRole('button', { name: /^Collection that burns/ })).toHaveAttribute('aria-pressed', 'true');
  await look(page, info, 'create-1-basics-template');
  expect(await walletTouches(page)).toEqual([]);
});

test('FE4: Claim all on a failed holder box, then across My Box', async ({ page }, info) => {
  const m2 = await publishedM2(true); const recorded = m2.body.m2.batches['1'];
  const body = { ...m2.body, m2: { ...m2.body.m2, batches: { '1': recorded, '2': recorded, '3': recorded } } };
  await synthetic(page, body as unknown as Body, m2RpcFixture({ coinsT: 3n * ETH, pot: 10000001n, tLeft: 3n * ETH, quoteP: 3333333n }).request);
  await connect(page, 'Claim all');
  const claims = page.getByRole('region', { name: 'Your claims' });
  await expect(claims.getByText('4 ready', { exact: true })).toBeVisible();
  await look(page, info, 'box-claims-ready');
  await claims.getByRole('button', { name: 'Claim all', exact: true }).click();
  await expect(claims.getByRole('group', { name: 'Confirm Claim all' })).toBeVisible();
  await look(page, info, 'box-claim-all-list');
  await page.goto('/my-box');
  await page.getByRole('banner').getByRole('button', { name: /wallet/i }).click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: /FE3 test wallet/ }).click();
  await page.getByRole('tab', { name: 'Claims' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'On 1 box' })).toBeVisible();
  await page.getByRole('region', { name: 'Your claims' }).getByRole('button', { name: 'Claim all', exact: true }).click();
  await look(page, info, 'wallet-claims-list');
});

// --- SH-V2-FE5: Claim all from the wallet claims index, the seed return, the item panel's paging ---------------------
/** The failed holder box with three batches: two paid at earlier blocks (in the index's receipts), one and the hand-in left. */
async function holderBox() {
  const m2 = await publishedM2(true); const recorded = m2.body.m2.batches['1'];
  const body = { ...m2.body, m2: { ...m2.body.m2, batches: { '1': recorded, '2': recorded, '3': recorded } } };
  // The index one block ahead of the feed, as it often is: its reads decide the receipts it lists.
  const box = claimsBoxOf(body as never); const block = BigInt(body.asOf.block) + 1n;
  const rows: { box: typeof box; row: ClaimRow }[] = [
    { box, row: { kind: 'holder', batch: 1n, amount: 60000001n, paid: { block: block - 5n, tx: `0x${'61'.repeat(32)}` } } },
    { box, row: { kind: 'holder', batch: 2n, amount: 60000001n, paid: { block: block - 4n, tx: `0x${'62'.repeat(32)}` } } },
    { box, row: { kind: 'holder', batch: 3n, amount: 60000001n } },
    { box, row: { kind: 'failure', coins: 3n * ETH, amount: 3333333n } },
  ];
  const claims = (chainId: number, wallet: Address) => claimsPageJson({ chainId, wallet, block, rows });
  return { body, claims, rpc: m2RpcFixture({ coinsT: 3n * ETH, pot: 10000001n, tLeft: 3n * ETH, quoteP: 3333333n }) };
}

test('FE5: Claim all from the claims index, Claimed open after a fresh load, on the box page and My Box', async ({ page }, info) => {
  const h = await holderBox();
  await synthetic(page, h.body as unknown as Body, h.rpc.request, { claims: h.claims });
  await connect(page, 'Claim all');
  const claims = page.getByRole('region', { name: 'Your claims' });
  await expect(claims.getByText('2 ready', { exact: true })).toBeVisible();
  await expect(claims.locator('.sh-v2-fresh')).toHaveCount(0);
  await claims.locator('details.sh-v2-claimed summary').click();
  await expect(claims.locator('details.sh-v2-claimed')).toHaveAttribute('open', '');
  await look(page, info, 'box-index-claimed');
  await claims.getByRole('button', { name: 'Claim all', exact: true }).click();
  await expect(claims.getByRole('group', { name: 'Confirm Claim all' })).toBeVisible();
  await look(page, info, 'box-index-list');
  await page.goto('/my-box');
  await page.getByRole('banner').getByRole('button', { name: /wallet/i }).click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: /FE3 test wallet/ }).click();
  await page.getByRole('tab', { name: 'Claims' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'On 1 box' })).toBeVisible();
  await page.getByRole('region', { name: 'Your claims' }).locator('details.sh-v2-claimed summary').click();
  await look(page, info, 'wallet-index-claimed');
});

test('FE5: the claims index down: the box page marks its direct chain read', async ({ page }, info) => {
  const h = await holderBox();
  await synthetic(page, h.body as unknown as Body, h.rpc.request);
  await connect(page, 'Claim all');
  const claims = page.getByRole('region', { name: 'Your claims' });
  await expect(claims.locator('.sh-v2-fresh')).toHaveText('Direct chain read');
  await look(page, info, 'box-index-down');
});

test('FE5: a failed pile’s seeder finds the seed return in Claim all', async ({ page }, info) => {
  const published = await publishedPile({ failed: true, loaded: true });
  const seeder = published.row.record.creator as Address;
  const money = (published.body.money as { m3: { pile: { balance: string | null; supply: string } } }).m3.pile;
  const rpc = m3RpcFixture({ failed: true, pile: { asset: published.asset, seeder, seed: published.seed, balance: BigInt(money.balance ?? 0), supply: BigInt(money.supply) } });
  await synthetic(page, published.body as unknown as Body, rpc.request, { account: seeder,
    claims: (chainId, wallet) => claimsPageJson({ chainId, wallet, block: BigInt(published.body.asOf.block), rows: [] }) });
  await connect(page, 'Claim all');
  const claims = page.getByRole('region', { name: 'Your claims' });
  await expect(claims.getByText('1 ready', { exact: true })).toBeVisible();
  await claims.getByRole('button', { name: 'Claim all', exact: true }).click();
  await expect(claims.getByRole('group', { name: 'Confirm Claim all' }).getByRole('listitem')).toHaveText(['Seed return1000 ETH']);
  await look(page, info, 'box-seed-return-list');
});

test('FE5: an item box with 26 of this wallet’s items reads them a page at a time', async ({ page }, info) => {
  const published = await publishedItems();
  // A 30-item collection (the spec and the record's spec hash follow), 26 items out with this wallet (the indexer's owners).
  const row = published.body.row as unknown as { encodedSpec: Hex; record: Record<string, unknown> & { specHash: Hex } } & Record<string, unknown>;
  const spec = { ...decodeBoxSpecV2(row.encodedSpec, { ...published.row.record }), n: 30 };
  const encodedSpec = encodeBoxSpecV2(spec);
  const ids = Array.from({ length: 26 }, (_, i) => i + 1);
  const m3 = published.body.m3 as unknown as { items: Record<string, unknown> };
  const items = { ...m3.items, items: Object.fromEntries(ids.map((id) => [String(id), { inside: false, sequence: String(id) }])), owners: Object.fromEntries(ids.map((id) => [String(id), A.toLowerCase()])) };
  const body = { ...published.body, row: { ...row, encodedSpec, record: { ...row.record, specHash: keccak256(encodedSpec) } }, m3: { ...m3, items } };
  const rpc = m3RpcFixture({ owners: Object.fromEntries(ids.map((id) => [String(id), A])), credits: Object.fromEntries(ids.map((id) => [String(id), [BigInt(id) * 10n ** 15n, 0n] as const])), vault: published.at(3) });
  await synthetic(page, body as unknown as Body, rpc.request);
  await connect(page, 'Claim all');
  const panel = page.getByRole('region', { name: 'Item payouts' });
  await expect(panel.getByText('12 ready', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'More items, page 2 of 3' }).click();
  await expect(panel.getByText('24 ready', { exact: true })).toBeVisible();
  await look(page, info, 'box-items-more');
});
