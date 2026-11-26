import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { decodeFunctionData, encodeFunctionData, erc20Abi, toHex, type Address, type Hex } from 'viem';
import { makePng } from '../../../packages/artwork/src/test-support/images';
import { itemLedgerV2Abi, pileVaultV2Abi, rolesOfV2 } from '../../../packages/chain/src/core/v2';
import { assertSendableCallV2, type WriteTargetV2 } from '../../../packages/chain/src/core/v2/write-calls-v2';
import { PICTURE_THEN_CLOSING, noTradingActions, brokenRuns, h2Order, installUntouchableWallet, overflow, walletTouches } from './box-helpers';
import { mixedDeployment } from '../src/features/core/v2/test-support/mixed-deployment';
import { A, B, ETH, publishedItems, publishedPile, type PileOptions } from '../src/features/core/v2/test-support/m3-published';
import { m3RpcFixture, type M3RpcOptions } from '../src/features/core/v2/test-support/m3-rpc';
import type { RpcCall } from '../src/features/core/v2/test-support/m2-rpc';

// M3-53: every-item payouts and the coin pile, in the creation flow (Demo) and on the v2 box page (synthetic M3-52
// publication and RPC answers through the real source, page and wallet boundary; no chain). Since 69204e00 the shared
// sender admits item claims and sync (role 16) and the pile's approval, redemption and seed return (role 3), so each
// press reaches the test wallet, which signs nothing and records the call. The default projects run at 1440×900 and
// 390×844. SH_EVIDENCE_SCREENSHOTS=1 writes the screenshots to docs/evidence/<SH_EVIDENCE_DIR, default SH-V2-M3-53>/.
const CORE = 'http://127.0.0.1:8596';
const RPC = 'http://127.0.0.1:8599';

async function shot(target: Page | Locator, info: TestInfo, name: string) {
  const path = process.env.SH_EVIDENCE_SCREENSHOTS === '1'
    ? fileURLToPath(new URL(`../../../docs/evidence/${process.env.SH_EVIDENCE_DIR ?? 'SH-V2-M3-53'}/${name}-${info.project.name}.png`, import.meta.url)) : info.outputPath(`${name}.png`);
  if ('goto' in target) {
    await target.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await target.screenshot({ path, fullPage: true, scale: 'css' });
  } else await target.screenshot({ path, scale: 'css' });
}
/** No trading control, no number or range field, no frame, no sideways scroll; the only fields are named ones. */
async function noTradingControls(page: Page, fields: readonly string[] = []) {
  await noTradingActions(page);
  await expect(page.locator('iframe, textarea, input[type="number"], input[type="range"]')).toHaveCount(0);
  const visible = await page.locator('main input:visible:not([type="radio"]):not([type="checkbox"]):not([type="file"])')
    .evaluateAll((inputs) => inputs.map((i) => ((i as HTMLInputElement).labels?.[0]?.textContent ?? i.getAttribute('aria-label') ?? i.id).trim()));
  expect(visible).toEqual(fields);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
}

// --- Creation flow (Demo) ---------------------------------------------------------------------------------------
const heading = (page: Page) => page.getByRole('heading', { level: 1 });
const next = (page: Page) => page.getByRole('button', { name: 'Next', exact: true });
const main = (page: Page) => page.getByRole('main');
const png = (size: number) => ({ name: `p${size}.png`, mimeType: 'image/png', buffer: Buffer.from(makePng({ width: size, height: size, decodable: true })) });
const artFiles = (n: number) => [
  ...Array.from({ length: n }, (_, i) => ({ name: `${i + 1}.png`, mimeType: 'image/png', buffer: Buffer.from(makePng({ width: 24 + i, height: 24, decodable: true })) })),
  { name: 'traits.csv', mimeType: 'text/csv', buffer: Buffer.from(['id,Colour', ...Array.from({ length: n }, (_, i) => `${i + 1},${i % 2 ? 'Teal' : 'Red'}`)].join('\n')) },
];
async function basics(page: Page, name: string, ticker: string) {
  await page.goto('/create/v2-basics');
  await page.getByRole('textbox', { name: 'Name' }).fill(name);
  await page.getByRole('textbox', { name: 'Ticker' }).fill(ticker);
  await page.locator('#create-logo').setInputFiles(png(512));
  await expect(page.getByRole('button', { name: 'Logo Change' })).toBeAttached();
  await next(page).click();
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 2 of 6: Contents');
}
async function toOverview(page: Page) {
  await next(page).click();
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 4 of 6: Raise');
  await next(page).click();
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 5 of 6: Opening');
  await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check();
  await next(page).click();
  await expect(heading(page)).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
}

test.describe('creation', () => {
  test.beforeEach(async ({ page }) => { await installUntouchableWallet(page); await page.emulateMedia({ reducedMotion: 'reduce' }); });

  test('M353-CREATE: a collection offers To items with its in-vault rule; details on demand; no wallet request', async ({ page }, info) => {
    test.setTimeout(90_000);
    await basics(page, 'Bag Holders', 'TOTE');
    await page.getByRole('radio', { name: /^New collection/ }).check();
    await page.getByLabel('Images + traits').setInputFiles(artFiles(10));
    await page.locator('#create-collection-cover').setInputFiles(png(600));
    await next(page).click();
    await expect(heading(page)).toHaveAccessibleName('Launch a box, step 3 of 6: Fees');
    const buyers = page.getByRole('group', { name: /^Buyers’ fees · in ETH/ });
    const sellers = page.getByRole('group', { name: /^Sellers’ fees · paid in TOTE, used as ETH/ });
    for (const group of [buyers, sellers]) {
      await expect(group.getByRole('button').first()).toHaveText('Keep');
      await group.getByRole('button', { name: 'To items', exact: true }).click();
      await expect(group.getByRole('button', { name: 'To items', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(group.getByRole('button', { name: 'Keep in the vault' })).toHaveAttribute('aria-pressed', 'true');
    }
    await sellers.getByRole('button', { name: 'Buy back and burn TOTE in the vault' }).click();
    await expect(sellers.getByRole('button', { name: 'Buy back and burn TOTE in the vault' })).toHaveAttribute('aria-pressed', 'true');
    await sellers.getByRole('button', { name: /About items in the vault/ }).click();
    await expect(sellers.getByText('Undrawn items share one hidden pool; each draw takes its equal part.')).toBeVisible();
    await expect(sellers.getByText(/the Misfits’ way/)).toBeVisible();
    await page.getByText('Fee details', { exact: true }).click();
    await expect(main(page).getByText(/An item picked just before a payout shares in it/)).toBeVisible();
    await noTradingControls(page);
    await shot(page, info, 'create-items-fees');
    await toOverview(page);
    await expect(main(page).getByText('To items · Keep · in ETH')).toBeVisible();
    await expect(main(page).getByText('To items · Buy back and burn TOTE · paid in TOTE, used as ETH')).toBeVisible();
    await shot(page, info, 'create-items-overview');
    expect(await walletTouches(page)).toEqual([]);
  });

  test('M353-CREATE: a token-only box adds a coin pile: seed coin, exact seed, the no-rescue line; Demo Create waits for the seed', async ({ page }, info) => {
    test.setTimeout(90_000);
    await basics(page, "Dragon's Hoard", 'HOARD');
    await page.getByRole('radio', { name: /^Token/ }).check();
    const pile = page.getByRole('group', { name: /^Coin pile/ });
    await pile.getByRole('radio', { name: /^Coin pile/ }).check();
    await page.getByRole('group', { name: 'Seed coin' }).getByRole('radio', { name: 'USDC', exact: true }).check();
    await page.getByRole('textbox', { name: /^Seed · USDC/ }).fill('1000');
    await expect(main(page).getByText('Coins sent to the pile by mistake cannot be recovered.')).toBeVisible();
    // SH-V2-FE3: the pile comes right after the tiles, before Coming later, and each tile's words keep one line.
    const tiles = page.getByRole('group', { name: 'What’s in the box' });
    expect(await brokenRuns(tiles)).toEqual([]);
    expect(await pile.evaluate((group, later) => (group.compareDocumentPosition(later as Node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      await page.getByRole('region', { name: 'Coming later' }).elementHandle())).toBe(true);
    await noTradingControls(page, ['Seed · USDC']);
    await shot(page, info, 'create-pile-contents');
    await next(page).click();
    await expect(heading(page)).toHaveAccessibleName('Launch a box, step 3 of 6: Fees');
    await expect(page.getByRole('group', { name: /^Buyers’ fees/ }).getByRole('button', { name: 'To items' })).toHaveCount(0);
    await toOverview(page);
    await expect(main(page).getByText('Token and coin pile')).toBeVisible();
    await expect(main(page).getByText('approve seed · 1000 USDC')).toBeVisible();
    await expect(main(page).getByText('loadSeed · 1000 USDC')).toBeVisible();
    expect(await walletTouches(page)).toEqual([]);
    await page.getByRole('button', { name: 'Connect to create' }).click();
    const dialog = page.getByRole('dialog', { name: 'Sample wallet' });
    await dialog.getByRole('radio', { name: 'Box wallet A' }).check();
    await dialog.getByRole('button', { name: /^(Connect|Update) sample wallet$/ }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.locator('[data-create-status]')).toHaveText('Open', { timeout: 30_000 });
    await shot(page, info, 'create-pile-overview');
    expect(await walletTouches(page)).toEqual([]);
  });
});

// --- Box page (synthetic publication) ----------------------------------------------------------------------------
type Published = { body: { token: string; row: { chainId: number; record: Record<string, unknown> }; asOf: { hash: string } } & Record<string, unknown> };
async function fixture(page: Page, published: Published, rpcOptions: M3RpcOptions) {
  const data = await mixedDeployment();
  const body = { ...published.body, chainId: data.manifest.chainId,
    row: { ...published.body.row, chainId: data.manifest.chainId, record: { ...published.body.row.record, poolManager: data.manifest.chain.poolManager.address } } };
  const rpc = m3RpcFixture(rpcOptions); const requests: string[] = []; const sent: Tx[] = [];
  await installUntouchableWallet(page);
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (route) => route.abort());
  await page.route(`${CORE}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const answer = path === '/v1/feed' ? data.v1.feed : path === '/v2/feed' ? { ...data.feed, cards: [body] } : path.endsWith('/activity') ? { asOf: body.asOf, items: [], next: null } : null;
    await route.fulfill({ status: answer ? 200 : 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(answer) });
  });
  await page.route(`${RPC}/**`, async (route) => {
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const call = route.request().postDataJSON() as RpcCall & { id: number };
    let answer;
    try { answer = { result: call.method === 'eth_chainId' ? toHex(data.manifest.chainId) : await rpc.request(call) }; }
    catch (error) { answer = { error: { code: (error as { code?: number }).code ?? -32601, message: (error as Error).message } }; }
    await route.fulfill({ headers, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: call.id, ...answer }) });
  });
  await page.exposeFunction('m353Request', async ({ method, params }: RpcCall) => {
    requests.push(method);
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [A];
    if (method === 'eth_chainId') return toHex(data.manifest.chainId);
    // The test wallet signs nothing: it records what the site asked it to send and answers a transaction hash.
    if (method === 'eth_sendTransaction') { sent.push(params?.[0] as Tx); return toHex(sent.length, { size: 32 }); }
    throw new Error(`Unexpected wallet request ${method}`);
  });
  await page.addInitScript(() => {
    const provider = { request: (call: unknown) => (window as unknown as { m353Request(call: unknown): Promise<unknown> }).m353Request(call), on() {}, removeListener() {} };
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: {
      info: { uuid: '35353535-bf71-4c1c-9011-521e67622b70', name: 'M353 test wallet', rdns: 'org.example.m353', icon: 'data:image/svg+xml;base64,PHN2Zy8+' }, provider,
    } })));
  });
  await page.goto('/settings');
  await page.getByRole('radio', { name: /Local chain/ }).check();
  await page.goto(`/box/${data.manifest.chainId}/${body.token.toLowerCase()}`);
  // The shared sender's target for this box, as m3-actions.ts builds it, for the guard checks on captured calls.
  const roles = rolesOfV2(body.row.record as never).contracts;
  const target: WriteTargetV2 = { chainId: data.manifest.chainId, coordinator: roles.coordinator as Address, receiver: roles.receiver as Address, token: body.token as Address,
    p: (body.row.record as { q?: unknown }).q as Address, ...(roles.itemLedger ? { itemLedger: roles.itemLedger } : {}), ...(Number((body.row as { spec?: { boxType?: unknown } }).spec?.boxType) === 5 && roles.vault ? { pile: roles.vault } : {}) };
  return { requests, sent, rpc, body, target };
}
type Tx = { from: Address; to: Address; data: Hex; value: Hex };
/** Each captured transaction goes from the caller to `to` with zero value; the guard admits it as sent. */
function sentFromCaller(sent: readonly Tx[], to: Address | undefined, target: WriteTargetV2) {
  for (const tx of sent) {
    expect(tx.to.toLowerCase()).toBe(String(to).toLowerCase());
    expect(tx.from.toLowerCase()).toBe(A.toLowerCase()); expect(BigInt(tx.value)).toBe(0n);
    expect(() => assertSendableCallV2({ to: tx.to, data: tx.data, value: 0n }, target, A)).not.toThrow();
  }
}
async function connect(page: Page, button: string) {
  // The wallet is asked only here, on a press; navigation asked nothing.
  await page.getByRole('button', { name: button, exact: true }).click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: /M353 test wallet/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
async function items(page: Page, rpc: M3RpcOptions = {}) {
  const published = await publishedItems();
  const f = await fixture(page, published, { owners: { '1': A, '2': A }, credits: { '1': [ETH / 4n, ETH], '2': [ETH / 4n + 1n, 0n] }, vault: published.at(3), ...rpc });
  await expect(page.getByRole('region', { name: 'Item payouts' })).toBeVisible();
  return f;
}
async function pile(page: Page, options: PileOptions = {}) {
  const published = await publishedPile(options);
  const money = (published.body.money as { m3: { pile: { balance: string | null; supply: string } } }).m3.pile;
  const f = await fixture(page, published, { pile: { asset: published.asset, seeder: published.row.record.creator, seed: published.seed, balance: BigInt(money.balance ?? 0), supply: BigInt(money.supply) }, coinsT: 10n * ETH, allowanceT: 10n * ETH });
  await expect(page.getByRole('region', { name: 'Coin pile' })).toBeVisible();
  return f;
}

test.describe('box page', () => {
  test('M353-ITEMS: each item this wallet holds has its exact claimable and its own Claim; Claim all reaches the wallet, one item per send', async ({ page }, info) => {
    const f = await items(page);
    const panel = page.getByRole('region', { name: 'Item payouts' });
    // SH-255: each side's rule in the picture's Where the fees go (the Fees card's rows before it).
    const fees = page.locator('.sh-bpic section', { has: page.getByRole('heading', { name: 'Where the fees go', exact: true }) });
    await expect(fees).toContainText('To items · Keep');
    await expect(fees).toContainText('To items · Buy back and burn');
    await expect(panel.getByText('Paid per item')).toBeVisible();
    // SH-V2-FE3: the figures ("Buyers Keep · Sellers Buy back and burn …" included) keep one line each, phone included.
    expect(await brokenRuns(panel.locator('.sh-m3-figures'))).toEqual([]);
    expect(f.requests).toEqual([]); expect(await walletTouches(page)).toEqual([]);
    await connect(page, 'Claim all');
    await expect(panel.getByText('2 ready', { exact: true })).toBeVisible();
    await expect(panel.getByText('1.500000000000000001 ETH', { exact: true })).toBeVisible();
    const first = panel.getByRole('listitem').filter({ hasText: 'Item #1' });
    await expect(first.getByText('1.25 ETH', { exact: true })).toBeVisible();
    await expect(first.getByText(/stash 1 ETH/)).toBeVisible();
    await expect(panel.getByRole('listitem').filter({ hasText: 'Item #3' })).toHaveCount(0);
    await noTradingControls(page);
    await shot(panel, info, 'items-ready-2');
    // F128: Claim all is the page's "Your claims" panel, every claim of the box (here the two items).
    const claims = page.getByRole('region', { name: 'Your claims' });
    await claims.getByRole('button', { name: 'Claim all', exact: true }).click();
    const confirm = claims.getByRole('group', { name: 'Confirm Claim all' });
    await expect(confirm.getByRole('listitem')).toHaveText(['Item #11.25 ETH', 'Item #20.250000000000000001 ETH']);
    await expect(confirm).toContainText('2 signatures · one each');
    await expect(confirm).toContainText(A);
    await shot(claims, info, 'items-claim-all-confirm');
    expect(f.requests).not.toContain('eth_sendTransaction');
    await confirm.getByRole('button', { name: 'Confirm', exact: true }).click();
    for (const id of [1, 2]) await expect(panel.getByRole('listitem').filter({ hasText: `Item #${id}` }).getByText('Claimed', { exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: /^Claim item/ })).toHaveCount(0);
    await expect(claims.getByRole('button', { name: 'Claim all', exact: true })).toBeDisabled();
    // One eth_sendTransaction per item, in order: claim([id], caller) to the item ledger (role 16), zero value.
    expect(f.sent).toHaveLength(2);
    sentFromCaller(f.sent, f.target.itemLedger, f.target);
    expect(f.sent.map((tx) => decodeFunctionData({ abi: itemLedgerV2Abi, data: tx.data }))).toMatchObject([
      { functionName: 'claim', args: [[1n], A] }, { functionName: 'claim', args: [[2n], A] }]);
    // The guard still refuses two items, item 0, another recipient and another target.
    const claim = (ids: readonly bigint[], to: Address) => ({ to: f.target.itemLedger as Address, data: encodeFunctionData({ abi: itemLedgerV2Abi, functionName: 'claim', args: [ids, to] }), value: 0n });
    expect(() => assertSendableCallV2(claim([1n, 2n], A), f.target, A)).toThrow(/one item and pay the caller/);
    expect(() => assertSendableCallV2(claim([0n], A), f.target, A)).toThrow(/one item and pay the caller/);
    expect(() => assertSendableCallV2(claim([1n], B), f.target, A)).toThrow(/one item and pay the caller/);
    expect(() => assertSendableCallV2({ ...claim([1n], A), to: f.target.coordinator }, f.target, A)).toThrow(/must be a number/);
    await page.getByText('Item payout details', { exact: true }).click();
    await expect(panel.getByText(/one hidden pool/)).toBeVisible();
    await expect(panel.getByText(/picked just before a payout/)).toBeVisible();
    await noTradingControls(page, ['Check an item']);
    await shot(panel, info, 'items-claimed-details');
    // Every read is at the displayed snapshot hash, canonical only.
    const reads = f.rpc.calls.filter((c) => c.method === 'eth_call' && (c.params?.[1] as { blockHash?: string } | undefined)?.blockHash !== undefined);
    expect(reads.length).toBeGreaterThan(6);
    for (const call of reads) expect(call.params?.[1]).toEqual({ blockHash: f.body.asOf.hash, requireCanonical: true });
  });

  test('M353-ITEMS: a ledger behind its records shows Needs sync and a Sync button that reaches the wallet as sync(32)', async ({ page }, info) => {
    const f = await items(page, { synced: false });
    const panel = page.getByRole('region', { name: 'Item payouts' });
    await connect(page, 'Claim all');
    await expect(panel.getByRole('listitem').filter({ hasText: 'Item #1' }).getByText('Needs sync', { exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: /^Claim item/ })).toHaveCount(0);
    await shot(panel, info, 'items-needs-sync');
    expect(f.requests).not.toContain('eth_sendTransaction');
    await panel.getByRole('button', { name: 'Sync', exact: true }).click();
    await expect(panel.getByText('Synced. Reading the updated box…')).toBeVisible();
    // Sync reaches the wallet as sync(32) to the item ledger; the guard refuses 0 and 33 records.
    expect(f.sent).toHaveLength(1);
    sentFromCaller(f.sent, f.target.itemLedger, f.target);
    expect(decodeFunctionData({ abi: itemLedgerV2Abi, data: f.sent[0]?.data as Hex })).toMatchObject({ functionName: 'sync', args: [32n] });
    const sync = (k: bigint) => ({ to: f.target.itemLedger as Address, data: encodeFunctionData({ abi: itemLedgerV2Abi, functionName: 'sync', args: [k] }), value: 0n });
    expect(() => assertSendableCallV2(sync(0n), f.target, A)).toThrow(/1 to 32 records/);
    expect(() => assertSendableCallV2(sync(33n), f.target, A)).toThrow(/1 to 32 records/);
    await noTradingControls(page);
    await shot(panel, info, 'items-synced');
  });

  test('M353-PILE: after graduation, the share per coin and an exact-minimum redemption that reaches the wallet', async ({ page }, info) => {
    const f = await pile(page);
    const panel = page.getByRole('region', { name: 'Coin pile' });
    await expect(panel.getByText('1000.00000000000000002 ETH', { exact: true })).toBeVisible();
    // SH-V2-FE3: the exact balance keeps its digits on one line, phone included.
    expect(await brokenRuns(panel.locator('.sh-v2-value'))).toEqual([]);
    await expect(panel.getByText('Redeem open', { exact: true })).toBeVisible();
    await expect(panel.getByText('Coins sent to the pile by mistake cannot be recovered.')).toBeVisible();
    expect(f.requests).toEqual([]); expect(await walletTouches(page)).toEqual([]);
    await panel.getByRole('textbox', { name: 'HOARD to redeem' }).fill('3');
    await expect(panel.locator('.sh-m3-quote')).toContainText('You get0.003 ETH');
    await expect(panel.locator('.sh-m3-quote')).toContainText('Minimum0.003 ETH');
    await noTradingControls(page, ['HOARD to redeem']);
    await shot(panel, info, 'pile-redeem-open');
    await connect(page, 'Redeem');
    await panel.getByRole('button', { name: 'Redeem', exact: true }).click();
    const confirm = panel.getByRole('group', { name: 'Confirm transaction' });
    await expect(confirm).toContainText('Redeem 3 HOARD for 0.003 ETH, minimum 0.003 ETH?');
    await shot(panel, info, 'pile-redeem-confirm');
    expect(f.requests).not.toContain('eth_sendTransaction');
    await confirm.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(panel.getByText('Confirmed. Reading the updated box…')).toBeVisible();
    // The coins were approved already (the RPC double's allowance), so one send: redeem(3 HOARD, exact quote, caller).
    expect(f.sent).toHaveLength(1);
    sentFromCaller(f.sent, f.target.pile, f.target);
    expect(decodeFunctionData({ abi: pileVaultV2Abi, data: f.sent[0]?.data as Hex })).toMatchObject({ functionName: 'redeem', args: [3n * ETH, 3n * ETH / 1000n, A] });
    // The guard refuses a zero minimum, another recipient, and an approval for anyone but the pile or coordinator.
    const redeem = (tIn: bigint, minOut: bigint, to: Address) => ({ to: f.target.pile as Address, data: encodeFunctionData({ abi: pileVaultV2Abi, functionName: 'redeem', args: [tIn, minOut, to] }), value: 0n });
    expect(() => assertSendableCallV2(redeem(3n * ETH, 0n, A), f.target, A)).toThrow(/positive minimum, paid to the caller/);
    expect(() => assertSendableCallV2(redeem(3n * ETH, 1n, B), f.target, A)).toThrow(/positive minimum, paid to the caller/);
    const approve = (spender: Address) => ({ to: f.target.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, ETH] }), value: 0n });
    expect(() => assertSendableCallV2(approve(f.target.pile as Address), f.target, A)).not.toThrow();
    expect(() => assertSendableCallV2(approve(B), f.target, A)).toThrow(/coordinator or the pile/);
    await shot(panel, info, 'pile-redeem-confirmed');
  });

  test('M353-PILE: before graduation there is no redemption; the seed waits', async ({ page }, info) => {
    await pile(page, { graduated: false, loaded: false });
    const panel = page.getByRole('region', { name: 'Coin pile' });
    await expect(panel.getByText('Seed waiting', { exact: true })).toBeVisible();
    await expect(panel.getByRole('textbox')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Redeem' })).toHaveCount(0);
    await noTradingControls(page);
    await shot(panel, info, 'pile-seed-waiting');
  });

  test('M353-PILE: a failed pile shows the closing price first and the seed due, with Return seed', async ({ page }, info) => {
    const f = await pile(page, { failed: true });
    // SH-255: the closing price leads the picture's tiles and the page under the picture.
    await expect(page.locator('.sh-bpic .sh-box-stat dt').first()).toHaveText('Closing price');
    // Review R-16: the whole order up to the closing price: the picture's own cards, then the closing price, nothing else.
    await expect.poll(() => h2Order(page)).toEqual(PICTURE_THEN_CLOSING);
    const panel = page.getByRole('region', { name: 'Coin pile' });
    await expect(panel.getByText('Closed', { exact: true })).toBeVisible();
    await expect(panel.getByText('1000 ETH due', { exact: true })).toBeVisible();
    await shot(panel, info, 'pile-failed-seed-due');
    await connect(page, 'Return seed');
    await panel.getByRole('button', { name: 'Return seed', exact: true }).click();
    expect(f.requests).not.toContain('eth_sendTransaction');
    await panel.getByRole('group', { name: 'Confirm transaction' }).getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(panel.getByText('Confirmed. Reading the updated box…')).toBeVisible();
    // returnSeed() reaches the wallet, to the pile; a box without a pile role is refused.
    expect(f.sent).toHaveLength(1);
    sentFromCaller(f.sent, f.target.pile, f.target);
    expect(decodeFunctionData({ abi: pileVaultV2Abi, data: f.sent[0]?.data as Hex })).toMatchObject({ functionName: 'returnSeed' });
    const withoutPile: WriteTargetV2 = { chainId: f.target.chainId, coordinator: f.target.coordinator, receiver: f.target.receiver, token: f.target.token, p: f.target.p };
    expect(() => assertSendableCallV2({ to: f.sent[0]?.to as Address, data: f.sent[0]?.data as Hex, value: 0n }, withoutPile, A)).toThrow(/needs the coin pile/);
    await noTradingControls(page, ['Coins to claim']);
    await shot(page, info, 'pile-failed-page');
  });
});
