import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { decodeFunctionData, erc20Abi, toHex, type Abi, type Address, type Hex } from 'viem';
import { coordinatorV2Abi, holderLedgerV2Abi, itemLedgerV2Abi, receiverV2Abi, rolesOfV2 } from '../../../packages/chain/src/core/v2';
import { assertSendableCallV2, type WriteTargetV2 } from '../../../packages/chain/src/core/v2/write-calls-v2';
import { FORBIDDEN, PICTURE_THEN_CLOSING, brokenRuns, h2Order, installUntouchableWallet, overflow, walletTouches } from './box-helpers';
import { mixedDeployment } from '../src/features/core/v2/test-support/mixed-deployment';
import { publishedM2, A } from '../src/features/core/v2/test-support/m2-published';
import { ETH, publishedItems } from '../src/features/core/v2/test-support/m3-published';
import { m2RpcFixture, type RpcCall } from '../src/features/core/v2/test-support/m2-rpc';
import { m3RpcFixture } from '../src/features/core/v2/test-support/m3-rpc';

// F128 "Claim all covers every claim a wallet has": through the real source, page, claim reads and shared sender
// (`submitWrite`) of the site, against a synthetic M2-52/M3-52 publication and RPC answers (no chain). The test wallet
// signs nothing: it records each transaction the site asks it to send and answers a hash. Two boxes:
// - a failed holder-payout box (M2): three payouts, and this wallet's 3 coins to hand in for their share of the pot;
// - a graduated every-item box (M3): two items of this wallet, and the creator's fees, this wallet being the payee.
// Both run at 1440 px and, on the mobile project, 375 px. SH_EVIDENCE_SCREENSHOTS=1 writes the Claim all screenshots
// to docs/evidence/SH-V2-FE4/ (or SH_EVIDENCE_DIR).
const CORE = 'http://127.0.0.1:8596';
const RPC = 'http://127.0.0.1:8599';
const COINS = 3n * ETH;
const QUOTE = 3333333n;
type Tx = { from: Address; to: Address; data: Hex; value: Hex };

const width = (info: TestInfo) => (info.project.name === 'mobile' ? 375 : 1440);
async function shot(target: Page | Locator, info: TestInfo, name: string) {
  const path = process.env.SH_EVIDENCE_SCREENSHOTS === '1'
    ? fileURLToPath(new URL(`../../../docs/evidence/${process.env.SH_EVIDENCE_DIR ?? 'SH-V2-FE4'}/${name}-${width(info)}.png`, import.meta.url)) : info.outputPath(`${name}.png`);
  const page = 'goto' in target ? target : target.page();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  // A page shot for My Box, from the top: its tab bar is sticky and would cover part of an element shot.
  if ('goto' in target) { await target.evaluate(() => window.scrollTo(0, 0)); await target.screenshot({ path, fullPage: true, scale: 'css' }); }
  else await target.screenshot({ path, scale: 'css' });
}
const lower = (a: unknown) => String(a).toLowerCase();

async function fixture(page: Page, info: TestInfo, options: { items?: boolean; rejectAt?: number } = {}) {
  await page.setViewportSize(info.project.name === 'mobile' ? { width: 375, height: 812 } : { width: 1440, height: 900 });
  const data = await mixedDeployment();
  const adapt = <B extends { row: { record: Record<string, unknown> } & Record<string, unknown> }>(body: B) =>
    ({ ...body, chainId: data.manifest.chainId, row: { ...body.row, chainId: data.manifest.chainId, record: { ...body.row.record, poolManager: data.manifest.chain.poolManager.address } } });
  const m2 = await publishedM2(true); const recorded = m2.body.m2.batches['1'];
  const holders = adapt({ ...m2.body, m2: { ...m2.body.m2, batches: { '1': recorded, '2': recorded, '3': recorded } } });
  const published = await publishedItems();
  const money = published.body.money as unknown as { values: Record<string, unknown> } & Record<string, unknown>;
  const items = adapt({ ...published.body, money: { ...money, values: { ...money.values, 'receiver.creatorPayee': A } } });
  const cards = options.items ? [holders, items] : [holders];
  const m2Rpc = m2RpcFixture({ coinsT: COINS, pot: 10000001n, tLeft: COINS, quoteP: QUOTE });
  const owed = BigInt(String(money.values['receiver.creatorOwed']));
  const m3Rpc = m3RpcFixture({ owners: { '1': A, '2': A }, credits: { '1': [ETH / 4n, ETH], '2': [ETH / 4n + 1n, 0n] }, vault: published.at(3), creator: { payee: A, owed } });
  // Calls to the holder box's contracts go to its double, every other call to the item box's.
  const m2Roles = new Set([holders.token, ...(holders.row.record.contracts as string[])].map(lower));
  const requests: string[] = []; const sent: Tx[] = []; let attempts = 0;
  await installUntouchableWallet(page);
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (route) => route.abort());
  await page.route(`${CORE}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const answer = path === '/v1/feed' ? data.v1.feed : path === '/v2/feed' ? { ...data.feed, cards } : path.endsWith('/activity') ? { asOf: holders.asOf, items: [], next: null } : null;
    await route.fulfill({ status: answer ? 200 : 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(answer) });
  });
  await page.route(`${RPC}/**`, async (route) => {
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const call = route.request().postDataJSON() as RpcCall & { id: number };
    const to = (call.params?.[0] as { to?: string } | undefined)?.to;
    const double = call.method === 'eth_call' && to !== undefined && !m2Roles.has(lower(to)) ? m3Rpc : m2Rpc;
    let answer;
    try { answer = { result: call.method === 'eth_chainId' ? toHex(data.manifest.chainId) : await double.request(call) }; }
    catch (error) { answer = { error: { code: (error as { code?: number }).code ?? -32601, message: (error as Error).message } }; }
    await route.fulfill({ headers, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: call.id, ...answer }) });
  });
  await page.exposeFunction('claimAllRequest', async ({ method, params }: RpcCall) => {
    requests.push(method);
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [A];
    if (method === 'eth_chainId') return toHex(data.manifest.chainId);
    if (method === 'eth_sendTransaction') {
      attempts += 1;
      if (attempts === options.rejectAt) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      const tx = params?.[0] as Tx; sent.push(tx);
      // The approval mined: the coordinator may now take the coins.
      if (tx.data.startsWith('0x095ea7b3')) m2Rpc.chain.allowanceT = decodeFunctionData({ abi: erc20Abi, data: tx.data }).args[1] as bigint;
      return toHex(sent.length, { size: 32 });
    }
    throw new Error(`Unexpected wallet request ${method}`);
  });
  await page.addInitScript(() => {
    const provider = { request: (call: unknown) => (window as unknown as { claimAllRequest(call: unknown): Promise<unknown> }).claimAllRequest(call), on() {}, removeListener() {} };
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: {
      info: { uuid: 'f1280000-bf71-4c1c-9011-521e67622b70', name: 'Claim all test wallet', rdns: 'org.example.f128', icon: 'data:image/svg+xml;base64,PHN2Zy8+' }, provider,
    } })));
  });
  await page.goto('/settings');
  await page.getByRole('radio', { name: /Local chain/ }).check();
  // The shared sender's target for each box, as the site builds it (m3Target), for the guard checks on captured calls.
  const targetOf = (body: typeof holders): WriteTargetV2 => {
    const roles = rolesOfV2(body.row.record as never).contracts;
    return { chainId: data.manifest.chainId, coordinator: roles.coordinator as Address, receiver: roles.receiver as Address, token: body.token as Address, p: body.row.record.q as Address,
      ...(roles.holderLedger ? { holderLedger: roles.holderLedger } : {}), ...(roles.itemLedger ? { itemLedger: roles.itemLedger } : {}) };
  };
  return { requests, sent, holders, items, m2Rpc, chainId: data.manifest.chainId, holderTarget: targetOf(holders), itemTarget: targetOf(items as unknown as typeof holders) };
}
async function chooseWallet(page: Page) {
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: /Claim all test wallet/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
const ABIS: readonly Abi[] = [holderLedgerV2Abi, itemLedgerV2Abi, erc20Abi, receiverV2Abi, coordinatorV2Abi];
function decoded(tx: Tx) {
  for (const abi of ABIS) { try { return decodeFunctionData({ abi, data: tx.data }); } catch { /* the next */ } }
  throw new Error(`unknown call ${tx.data.slice(0, 10)}`);
}
/** Each captured transaction: from the caller, zero value, to `to`, calling `fn(args)`, and admitted by the guard as sent. */
function expectSends(sent: readonly Tx[], expected: readonly (readonly [Address | null | undefined, string, readonly unknown[], WriteTargetV2])[]) {
  expect(sent).toHaveLength(expected.length);
  expected.forEach(([to, fn, args, target], i) => {
    const tx = sent[i] as Tx;
    expect(lower(tx.to)).toBe(lower(to)); expect(lower(tx.from)).toBe(lower(A)); expect(BigInt(tx.value)).toBe(0n);
    expect(decoded(tx)).toMatchObject({ functionName: fn, args });
    expect(() => assertSendableCallV2({ to: tx.to, data: tx.data, value: 0n }, target, A)).not.toThrow();
  });
}
async function noTradingControls(page: Page) {
  await expect(page.getByRole('button', { name: FORBIDDEN })).toHaveCount(0);
  await expect(page.getByRole('link', { name: FORBIDDEN })).toHaveCount(0);
  await expect(page.locator('iframe, textarea, input[type="number"], input[type="range"]')).toHaveCount(0);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
}

test('F128 box page: one Claim all lists every claim with its amount, then sends each through the shared sender, one signature each', async ({ page }, info) => {
  const f = await fixture(page, info);
  await page.goto(`/box/${f.chainId}/${f.holders.token.toLowerCase()}`);
  const panel = page.getByRole('region', { name: 'Your claims' });
  await expect(panel).toBeVisible();
  // Navigation asked the wallet nothing; the closing price still comes first (SH-255: in the picture's tiles, and first
  // under the picture).
  await expect(page.locator('.sh-bpic .sh-box-stat dt').first()).toHaveText('Closing price');
  // Review R-16: the whole order up to the closing price: the picture's own cards, then the closing price, nothing else.
  await expect.poll(() => h2Order(page)).toEqual(PICTURE_THEN_CLOSING);
  expect(f.requests).toEqual([]); expect(await walletTouches(page)).toEqual([]);
  await panel.getByRole('button', { name: 'Claim all', exact: true }).click();
  await chooseWallet(page);
  await expect(panel.getByText('4 ready', { exact: true })).toBeVisible();
  await expect(panel.getByText('183.333336 ETH', { exact: true })).toBeVisible();
  expect(f.requests).not.toContain('eth_sendTransaction');
  await panel.getByRole('button', { name: 'Claim all', exact: true }).click();
  const confirm = panel.getByRole('group', { name: 'Confirm Claim all' });
  // Before the first signature: each transaction with its amount, the hand-in with the coins going in and the P coming out.
  await expect(confirm.getByRole('listitem')).toHaveText(['Batch 160.000001 ETH', 'Batch 260.000001 ETH', 'Batch 360.000001 ETH', 'Approve coins3 B52', 'Hand in coins3 B52 → for 3.333333 ETH']);
  await expect(confirm).toContainText('5 signatures · one each');
  await expect(confirm).toContainText(A);
  // Labels and amounts keep one line each, phone included.
  expect(await brokenRuns(confirm.getByRole('list'))).toEqual([]);
  await noTradingControls(page);
  await shot(panel, info, 'claim-all-box-list');
  expect(f.requests).not.toContain('eth_sendTransaction');
  await confirm.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(panel.getByText('5 / 5 done', { exact: true })).toBeVisible();
  const roles = rolesOfV2(f.holders.row.record as never).contracts;
  expectSends(f.sent, [
    [roles.holderLedger, 'claim', [1n, A], f.holderTarget], [roles.holderLedger, 'claim', [2n, A], f.holderTarget], [roles.holderLedger, 'claim', [3n, A], f.holderTarget],
    [f.holders.token as Address, 'approve', [roles.coordinator, COINS], f.holderTarget], [roles.coordinator, 'claim', [COINS, A], f.holderTarget],
  ]);
  // The holder rows follow the same session: each payout Claimed, nothing left for Claim all.
  const earnings = page.getByRole('region', { name: 'Holder fee share' });
  for (const batch of [1, 2, 3]) await expect(earnings.getByRole('listitem').filter({ hasText: `Batch ${batch}` }).getByText('Claimed', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Claim all', exact: true })).toBeDisabled();
  await noTradingControls(page);
  await shot(panel, info, 'claim-all-box-done');
});

test('F128 stop rule: the wallet declines the second transaction; the run stops there and everything after it stays claimable', async ({ page }, info) => {
  const f = await fixture(page, info, { rejectAt: 2 });
  await page.goto(`/box/${f.chainId}/${f.holders.token.toLowerCase()}`);
  const panel = page.getByRole('region', { name: 'Your claims' });
  await panel.getByRole('button', { name: 'Claim all', exact: true }).click();
  await chooseWallet(page);
  await expect(panel.getByText('4 ready', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Claim all', exact: true }).click();
  await panel.getByRole('group', { name: 'Confirm Claim all' }).getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(panel.getByText('Batch 2 not confirmed · 1 / 5 done · the rest stay claimable', { exact: true })).toBeVisible();
  // Asked twice, signed once; the approval and the hand-in were never asked for.
  expect(f.requests.filter((m) => m === 'eth_sendTransaction')).toHaveLength(2);
  expectSends(f.sent, [[rolesOfV2(f.holders.row.record as never).contracts.holderLedger, 'claim', [1n, A], f.holderTarget]]);
  expect(f.m2Rpc.chain.allowanceT).toBe(0n);
  await expect(panel.getByText('3 ready', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Claim all', exact: true })).toBeEnabled();
  await shot(panel, info, 'claim-all-stopped');
});

test('F128 My Box: one Claim all across the wallet’s boxes, box after box, every claim kind included', async ({ page }, info) => {
  test.setTimeout(60_000);
  const f = await fixture(page, info, { items: true });
  await page.goto('/my-box');
  expect(f.requests).toEqual([]);
  await page.getByRole('banner').getByRole('button', { name: /wallet/i }).click();
  await chooseWallet(page);
  await expect(page.getByRole('heading', { level: 1, name: 'My Box' })).toBeVisible();
  await expect(page.locator('header.sh-box-head .sh-box-stat').filter({ hasText: 'Claims ready' })).toHaveText('Claims ready7');
  await page.getByRole('tab', { name: 'Claims' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'On 2 boxes' })).toBeVisible();
  const panel = page.getByRole('region', { name: 'Your claims' });
  // Different coins are never added up (the synthetic boxes price in the zero address with 6 and 18 decimals).
  await expect(panel.locator('.sh-v2-value')).toHaveText('183.333336 ETH · 900721.425474099300000002 ETH');
  await panel.getByRole('button', { name: 'Claim all', exact: true }).click();
  const confirm = panel.getByRole('group', { name: 'Confirm Claim all' });
  await expect(confirm.getByRole('heading', { level: 3 })).toHaveText(['Box 52', 'Box 352 Items']);
  await expect(confirm.getByRole('list', { name: 'Claims on Box 52' }).getByRole('listitem')).toHaveCount(5);
  await expect(confirm.getByRole('list', { name: 'Claims on Box 352 Items' }).getByRole('listitem')).toHaveText(['Item #11.25 ETH', 'Item #20.250000000000000001 ETH', 'Creator fees900719.925474099300000001 ETH']);
  await expect(confirm).toContainText('8 signatures · one each');
  await noTradingControls(page);
  await shot(page, info, 'claim-all-wallet-list');
  expect(f.requests).not.toContain('eth_sendTransaction');
  await confirm.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(panel.getByText('8 / 8 done', { exact: true })).toBeVisible();
  const h = rolesOfV2(f.holders.row.record as never).contracts; const it = rolesOfV2(f.items.row.record as never).contracts;
  expectSends(f.sent, [
    [h.holderLedger, 'claim', [1n, A], f.holderTarget], [h.holderLedger, 'claim', [2n, A], f.holderTarget], [h.holderLedger, 'claim', [3n, A], f.holderTarget],
    [f.holders.token as Address, 'approve', [h.coordinator, COINS], f.holderTarget], [h.coordinator, 'claim', [COINS, A], f.holderTarget],
    [it.itemLedger, 'claim', [[1n], A], f.itemTarget], [it.itemLedger, 'claim', [[2n], A], f.itemTarget],
    [it.receiver, 'claimCreator', [f.items.row.record.q, A], f.itemTarget],
  ]);
  await expect(page.getByRole('heading', { level: 2, name: 'Nothing to claim' })).toBeVisible();
  // With its Done marks the list still keeps each label and exact amount on one line, phone included.
  for (const list of await panel.locator('.sh-v2-claim-run ol').all()) expect(await brokenRuns(list)).toEqual([]);
  await noTradingControls(page);
  await shot(page, info, 'claim-all-wallet-done');
});
