import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { decodeFunctionData, encodeFunctionData, toHex, type Address, type Hex } from 'viem';
import { PICTURE_THEN_CLOSING, h2Order, installUntouchableWallet, overflow, walletTouches } from './box-helpers';
import { holderLedgerV2Abi } from '../../../packages/chain/src/core/v2';
import { assertSendableCallV2 } from '../../../packages/chain/src/core/v2/write-calls-v2';
import { mixedDeployment } from '../src/features/core/v2/test-support/mixed-deployment';
import { publishedM2, A, B } from '../src/features/core/v2/test-support/m2-published';
import { m2RpcFixture, type BatchState, type RpcCall } from '../src/features/core/v2/test-support/m2-rpc';

// Synthetic M2-52 publication and RPC answers, through the real source, page and wallet boundary.
// The default projects run at 1440×900 and 390×844. Screenshots stay in Playwright's output directory;
// SH_EVIDENCE_SCREENSHOTS=1 writes the holder fee share ones to docs/evidence/SH-V2-FE1/ instead
// (or to docs/evidence/<SH_EVIDENCE_DIR>/ when that is set).
const CORE = 'http://127.0.0.1:8596';
const RPC = 'http://127.0.0.1:8599';
async function noTradingControls(page: Page) {
  await expect(page.getByRole('button', { name: /^(buy|sell|swap)$/i })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^(buy|sell|swap)$/i })).toHaveCount(0);
  await expect(page.locator('iframe, input[type="range"]')).toHaveCount(0);
}
async function shot(target: Locator, info: TestInfo, name: string) {
  const path = process.env.SH_EVIDENCE_SCREENSHOTS === '1'
    ? fileURLToPath(new URL(`../../../docs/evidence/${process.env.SH_EVIDENCE_DIR ?? 'SH-V2-FE1'}/${name}-${info.project.name}.png`, import.meta.url)) : info.outputPath(`${name}.png`);
  await target.screenshot({ path, scale: 'css' });
}
async function fixture(page: Page, options: { failed?: boolean; state?: BatchState; payout?: 'available' | 'paused'; batches?: readonly string[] } = {}) {
  const data = await mixedDeployment(); const m2 = await publishedM2(options.failed);
  // Extra recorded batches copy batch 1's record; the RPC double answers the same credit for each.
  const history = m2.body.m2; const recorded = history.batches['1'];
  const batches = options.batches && recorded ? Object.fromEntries(options.batches.map((id) => [id, recorded])) : history.batches;
  const body = { ...m2.body, m2: { ...history, batches }, chainId: data.manifest.chainId,
    row: { ...m2.body.row, chainId: data.manifest.chainId, record: { ...m2.body.row.record, poolManager: data.manifest.chain.poolManager.address } } };
  const rpc = m2RpcFixture(options); const requests: string[] = []; const sent: { from: string; to: string; data: Hex; value: string }[] = [];
  await installUntouchableWallet(page);
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, route => route.abort());
  await page.route(`${CORE}/**`, async route => {
    const path = new URL(route.request().url()).pathname;
    const answer = path === '/v1/feed' ? data.v1.feed : path === '/v2/feed' ? { ...data.feed, cards: [body] }
      : path.endsWith('/activity') ? { asOf: body.asOf, items: [], next: null } : null;
    await route.fulfill({ status: answer ? 200 : 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(answer) });
  });
  await page.route(`${RPC}/**`, async route => {
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const call = route.request().postDataJSON() as RpcCall & { id: number };
    let answer;
    try { answer = { result: call.method === 'eth_chainId' ? toHex(data.manifest.chainId) : await rpc.request(call) }; }
    catch (error) { answer = { error: { code: (error as { code?: number }).code ?? -32601, message: (error as Error).message } }; }
    await route.fulfill({ headers, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: call.id, ...answer }) });
  });
  await page.exposeFunction('m253Request', async ({ method, params }: RpcCall) => {
    requests.push(method);
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [A];
    if (method === 'eth_chainId') return toHex(data.manifest.chainId);
    // The test wallet signs nothing: it records what the site asked it to send and answers a transaction hash.
    if (method === 'eth_sendTransaction') { sent.push(params?.[0] as (typeof sent)[number]); return toHex(sent.length, { size: 32 }); }
    throw new Error(`Unexpected wallet request ${method}`);
  });
  await page.addInitScript(() => {
    const provider = { request: (call: unknown) => (window as unknown as { m253Request(call: unknown): Promise<unknown> }).m253Request(call), on() {}, removeListener() {} };
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: {
      info: { uuid: '53be785c-bf71-4c1c-9011-521e67622b70', name: 'M253 test wallet', rdns: 'org.example.m253', icon: 'data:image/svg+xml;base64,PHN2Zy8+' }, provider,
    } })));
  });
  await page.goto('/settings');
  await page.getByRole('radio', { name: /Local chain/ }).check();
  await page.goto(`/box/${data.manifest.chainId}/${body.token.toLowerCase()}`);
  await expect(page.getByRole('region', { name: 'Shop' })).toBeVisible();
  // The page names P by its coin: ETH for the zero address, otherwise P (recordV2).
  const symbol = /^0x0{40}$/i.test(body.row.record.q) ? 'ETH' : 'P';
  return { requests, sent, rpc, body, symbol };
}
async function connect(page: Page) {
  // The wallet is asked only here, on a press of Claim all; navigation asked nothing.
  await page.getByRole('button', { name: 'Claim all', exact: true }).click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: /M253 test wallet/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('M253-CREATE: holder choices name the price coin, with details on demand and no wallet request', async ({ page }, info) => {
  await installUntouchableWallet(page); await page.goto('/create/v2-fees');
  for (const side of ['Buyers', 'Sellers']) {
    const group = page.getByRole('group', { name: new RegExp(`^${side}’ fees ·`) });
    await expect(group.getByRole('button')).toHaveText(['Keep', 'Buy back and burn the box coin', 'Grow the pool', 'To holders', /^Lock /]);
    await group.getByRole('button', { name: 'To holders' }).click();
    await expect(group.getByRole('button', { name: 'To holders' })).toHaveAttribute('aria-pressed', 'true');
  }
  await page.getByText('Fee details', { exact: true }).click();
  // SH-194 af3 (396ebda6b, item 2): the holder paragraph names the claim coin and is scoped to it.
  await expect(page.getByText(/each holder claims its share/)).toHaveText('To holders, claimed in ETH: each holder claims its share once a batch is funded and calculated. Nothing is sent automatically. Not converted into the box coin. No expiry. Holder fees claimed in ETH stay separate from a failed box’s closing claim.');
  expect(await walletTouches(page)).toEqual([]); expect(await overflow(page)).toBeLessThanOrEqual(0);
  await noTradingControls(page);
  await page.screenshot({ path: info.outputPath('holder-choice.png'), fullPage: true });
});

test('M253-SHOP: exact budget, fixed prices, list powers and starter progress fit both viewports', async ({ page }, info) => {
  const f = await fixture(page);
  const shop = page.getByRole('region', { name: 'Shop' });
  // SH-283: thousands grouped, every digit kept (was 900719.925474099300000001 B52).
  await expect(shop.getByText('900,719.925474099300000001 B52')).toBeVisible();
  await expect(shop.getByRole('table')).toContainText('1.5 B52');
  await expect(shop.getByText('3 / 10 items')).toBeVisible();
  await expect(shop.getByRole('progressbar')).toHaveAttribute('value', '3');
  await shop.getByText('Budget and collection list', { exact: true }).click();
  await expect(shop.getByText(/Curator can only add/)).toBeVisible();
  await expect(shop.getByText(/10% per week/)).toContainText('2.5% per collection');
  await shop.getByText('Loading details', { exact: true }).click();
  await expect(shop.getByText(/No starter item moves at creation/)).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  expect(f.requests).toEqual([]); expect(await walletTouches(page)).toEqual([]);
  await noTradingControls(page);
  await page.screenshot({ path: info.outputPath('shop-loading.png'), fullPage: true });
});

for (const [state, payout, label] of [
  ['awaiting_funding', 'available', 'Awaiting funding'],
  ['settling', 'available', 'Calculating'],
  ['settled', 'paused', 'Paused'],
  ['settled', 'available', 'Ready'],
] as const) test(`M253-EXITS: failed box, ${state}, ${payout}; closing price first, earnings separate`, async ({ page }, info) => {
  const f = await fixture(page, { failed: true, state, payout });
  // SH-255: the closing price leads the picture's tiles and the page under the picture.
  await expect(page.locator('.sh-bpic .sh-box-stat dt').first()).toHaveText('Closing price');
  // Review R-16: the whole order up to the closing price: the picture's own cards, then the closing price, nothing else.
  await expect.poll(() => h2Order(page)).toEqual(PICTURE_THEN_CLOSING);
  await expect(page.getByText('1,000 B52 awaiting burn')).toBeVisible();
  expect(f.requests).toEqual([]); expect(await walletTouches(page)).toEqual([]);
  await connect(page);
  const earnings = page.getByRole('region', { name: 'Holder fee share' });
  const payoutRow = earnings.getByRole('list', { name: 'Payouts' }).getByRole('listitem').filter({ hasText: 'Batch 1' });
  await expect(payoutRow.getByText(label, { exact: true })).toBeVisible();
  await expect(payoutRow.getByText(state === 'settled' ? `60.000001 ${f.symbol}` : '—', { exact: true })).toBeVisible();
  if (state === 'settled' && payout === 'available') {
    await expect(earnings.getByText('1 ready', { exact: true })).toBeVisible();
    await payoutRow.getByRole('button', { name: 'Claim batch 1' }).click();
    await expect(earnings.getByRole('group', { name: 'Confirm claim' })).toContainText(A);
    await earnings.getByRole('button', { name: 'Cancel', exact: true }).click();
  } else {
    await expect(payoutRow.getByRole('button')).toHaveCount(0);
    // F128: Claim all is the page's "Your claims" panel; with no payout ready and no coins to hand in, nothing to claim.
    await expect(earnings.getByRole('button', { name: 'Claim all' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Your claims' }).getByRole('button', { name: 'Claim all', exact: true })).toBeDisabled();
  }
  expect(f.requests).not.toContain('eth_sendTransaction');
  const roles = [0, 2, 5, 17].map(i => f.body.row.record.contracts[i]?.toLowerCase());
  const holderReads = f.rpc.calls.filter(c => c.method === 'eth_call' && roles.includes((c.params?.[0] as { to?: string }).to?.toLowerCase()));
  expect(holderReads.length).toBeGreaterThanOrEqual(6);
  for (const call of holderReads) expect(call.params?.[1]).toEqual({ blockHash: f.body.asOf.hash, requireCanonical: true });
  expect(await overflow(page)).toBeLessThanOrEqual(0); await noTradingControls(page);
  await page.screenshot({ path: info.outputPath(`earnings-${state}-${payout}.png`), fullPage: true });
  await shot(earnings, info, `holders-${state}-${payout}`);
});

// F127: Claim all through the real page, source and shared sender. Since a41be8fa the shared sender admits
// holderLedger.claim(batchId, caller) to the prepared role-17 address, so each claim reaches the wallet: one
// eth_sendTransaction per batch, to the holder ledger, batch id > 0, paid to the caller, zero value. F128 moved Claim
// all to the page's "Your claims" panel (every claim of the box; here the three payouts, no coins to hand in).
test('F127 Claim all: each payout has its own Claim; one confirmation; each claim reaches the wallet, one after another', async ({ page }, info) => {
  const f = await fixture(page, { failed: true, batches: ['1', '2', '3'] });
  expect(f.requests).toEqual([]); expect(await walletTouches(page)).toEqual([]);
  await connect(page);
  const earnings = page.getByRole('region', { name: 'Holder fee share' });
  const claims = page.getByRole('region', { name: 'Your claims' });
  await expect(earnings.getByText('3 ready', { exact: true })).toBeVisible();
  await expect(earnings.getByText(`180.000003 ${f.symbol}`, { exact: true })).toBeVisible();
  for (const batch of [1, 2, 3]) await expect(earnings.getByRole('button', { name: `Claim batch ${batch}` })).toBeEnabled();
  await expect(claims.getByText('3 ready', { exact: true })).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await shot(earnings, info, 'holders-ready-3');
  await claims.getByRole('button', { name: 'Claim all', exact: true }).click();
  const confirm = claims.getByRole('group', { name: 'Confirm Claim all' });
  await expect(confirm.getByRole('listitem')).toHaveText([1, 2, 3].map((batch) => `Batch ${batch}60.000001 ${f.symbol}`));
  await expect(confirm).toContainText('3 signatures · one each');
  await expect(confirm).toContainText(A);
  await shot(claims, info, 'claim-all-confirm');
  expect(f.requests).not.toContain('eth_sendTransaction');
  await confirm.getByRole('button', { name: 'Confirm', exact: true }).click();
  for (const batch of [1, 2, 3]) await expect(earnings.getByRole('listitem').filter({ hasText: `Batch ${batch}` }).getByText('Claimed', { exact: true })).toBeVisible();
  await expect(earnings.getByRole('button', { name: /^Claim batch/ })).toHaveCount(0);
  await expect(claims.getByRole('button', { name: 'Claim all', exact: true })).toBeDisabled();
  const ledger = f.body.row.record.contracts[17] as Address;
  expect(f.sent).toHaveLength(3);
  f.sent.forEach((tx, index) => {
    expect(tx.to.toLowerCase()).toBe(ledger.toLowerCase());
    expect(tx.from.toLowerCase()).toBe(A.toLowerCase()); expect(BigInt(tx.value)).toBe(0n);
    expect(decodeFunctionData({ abi: holderLedgerV2Abi, data: tx.data })).toMatchObject({ functionName: 'claim', args: [BigInt(index + 1), A] });
  });
  // The guard still refuses what it refused before: another target, a recipient other than the caller, batch 0.
  const contracts = f.body.row.record.contracts as Address[];
  const target = { chainId: Number(f.body.chainId), coordinator: contracts[0] as Address, token: contracts[1] as Address, receiver: contracts[5] as Address, p: f.body.row.record.q as Address, holderLedger: ledger };
  const first = { to: ledger, data: f.sent[0]?.data as Hex, value: 0n };
  expect(() => assertSendableCallV2(first, target, A)).not.toThrow();
  const claim = (batch: bigint, to: Address) => encodeFunctionData({ abi: holderLedgerV2Abi, functionName: 'claim', args: [batch, to] });
  expect(() => assertSendableCallV2({ ...first, to: target.receiver }, target, A)).toThrow(/prepared box role/);
  expect(() => assertSendableCallV2({ ...first, data: claim(1n, B) }, target, A)).toThrow(/pay the caller/);
  expect(() => assertSendableCallV2({ ...first, data: claim(0n, A) }, target, A)).toThrow(/name a batch/);
  expect(await overflow(page)).toBeLessThanOrEqual(0); await noTradingControls(page);
  await shot(earnings, info, 'claim-all-claimed');
});
