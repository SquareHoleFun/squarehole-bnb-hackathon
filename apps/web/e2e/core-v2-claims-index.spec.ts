import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { decodeFunctionData, erc20Abi, toHex, type Abi, type Address, type Hex } from 'viem';
import { coordinatorV2Abi, holderLedgerV2Abi, itemLedgerV2Abi, pileVaultV2Abi, receiverV2Abi, rolesOfV2 } from '../../../packages/chain/src/core/v2';
import { assertSendableCallV2, type WriteTargetV2 } from '../../../packages/chain/src/core/v2/write-calls-v2';
import { FORBIDDEN, brokenRuns, installUntouchableWallet, overflow, walletTouches } from './box-helpers';
import { mixedDeployment } from '../src/features/core/v2/test-support/mixed-deployment';
import { publishedM2, A } from '../src/features/core/v2/test-support/m2-published';
import { ETH, publishedItems, publishedPile } from '../src/features/core/v2/test-support/m3-published';
import { m2RpcFixture, type RpcCall } from '../src/features/core/v2/test-support/m2-rpc';
import { m3RpcFixture } from '../src/features/core/v2/test-support/m3-rpc';
import { claimsBoxOf, claimsPageJson, type ClaimRow, type ClaimsBox } from '../src/features/core/v2/test-support/claims-page';

// SH-V2-FE5: Claim all and the Claims page from the wallet claims index (GET /v2/wallets/<chain>/<wallet>/claims),
// through the real source, page, reads, claim-state rules and shared sender (`submitWrite`), against synthetic
// M2-52/M3-52 publications, a synthetic index answer and RPC answers (no chain). The index answers from what the test
// wallet actually sent: a sent claim is a payment at a later block. So a page reload shows what survives it. The test
// wallet signs nothing; it records each transaction and answers a hash. SH_EVIDENCE_SCREENSHOTS=1 writes the
// screenshots to docs/evidence/SH-V2-FE5/ (or SH_EVIDENCE_DIR).
const CORE = 'http://127.0.0.1:8596';
const RPC = 'http://127.0.0.1:8599';
const COINS = 3n * ETH;
const QUOTE = 3333333n;
const CREDIT = 60000001n;
const INDEX_HASH = `0x${'71'.repeat(32)}` as Hex;
type Tx = { from: Address; to: Address; data: Hex; value: Hex };

const width = (info: TestInfo) => (info.project.name === 'mobile' ? 375 : 1440);
async function shot(target: Page | Locator, info: TestInfo, name: string) {
  const path = process.env.SH_EVIDENCE_SCREENSHOTS === '1'
    ? fileURLToPath(new URL(`../../../docs/evidence/${process.env.SH_EVIDENCE_DIR ?? 'SH-V2-FE5'}/${name}-${width(info)}.png`, import.meta.url)) : info.outputPath(`${name}.png`);
  const page = 'goto' in target ? target : target.page();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  if ('goto' in target) { await target.evaluate(() => window.scrollTo(0, 0)); await target.screenshot({ path, fullPage: true, scale: 'css' }); }
  else await target.screenshot({ path, scale: 'css' });
}
const lower = (a: unknown) => String(a).toLowerCase();
const ABIS: readonly Abi[] = [holderLedgerV2Abi, itemLedgerV2Abi, erc20Abi, receiverV2Abi, coordinatorV2Abi, pileVaultV2Abi];
function decoded(tx: Tx) {
  for (const abi of ABIS) { try { return decodeFunctionData({ abi, data: tx.data }); } catch { /* the next */ } }
  throw new Error(`unknown call ${tx.data.slice(0, 10)}`);
}

type Options = { readonly items?: boolean; readonly pile?: boolean; readonly index?: 'up' | 'down' };

async function fixture(page: Page, info: TestInfo, options: Options = {}) {
  await page.setViewportSize(info.project.name === 'mobile' ? { width: 375, height: 812 } : { width: 1440, height: 900 });
  const data = await mixedDeployment(); const chainId = data.manifest.chainId;
  const adapt = <B extends { row: { record: Record<string, unknown> } & Record<string, unknown> }>(body: B) =>
    ({ ...body, chainId, row: { ...body.row, chainId, record: { ...body.row.record, poolManager: data.manifest.chain.poolManager.address } } });
  const m2 = await publishedM2(true); const recorded = m2.body.m2.batches['1'];
  const holders = adapt({ ...m2.body, m2: { ...m2.body.m2, batches: { '1': recorded, '2': recorded, '3': recorded } } });
  const published = await publishedItems();
  const money = published.body.money as unknown as { values: Record<string, unknown> } & Record<string, unknown>;
  const items = adapt({ ...published.body, money: { ...money, values: { ...money.values, 'receiver.creatorPayee': A } } });
  const pileBox = await publishedPile({ failed: true, loaded: true });
  const pile = adapt(pileBox.body);
  const owed = BigInt(String(money.values['receiver.creatorOwed']));
  const cards = options.pile ? [pile] : options.items ? [holders, items] : [holders];
  // The pile's recorded seeder is its creator: that wallet connects for the seed return.
  const account = (options.pile ? pileBox.body.row.record.creator : A) as Address;
  const m2Rpc = m2RpcFixture({ coinsT: COINS, pot: 10000001n, tLeft: COINS, quoteP: QUOTE });
  // The receiver books 5 more on the claim itself: the index's amount is the payee's own claim, not creatorOwed.
  const m3Rpc = m3RpcFixture({ owners: { '1': A, '2': A }, credits: { '1': [ETH / 4n, ETH], '2': [ETH / 4n + 1n, 0n] }, vault: published.at(3), creator: { payee: A, owed: owed + 5n },
    ...(options.pile ? { failed: true, pile: { asset: pileBox.asset, seeder: account, seed: pileBox.seed, balance: pileBox.seed + 20n, supply: 1_000_000n * ETH } } : {}) });
  const m2Roles = new Set([holders.token, ...(holders.row.record.contracts as string[])].map(lower));
  const requests: string[] = []; const sent: Tx[] = []; const rpcHashes: { to: string; fn: string; hash: string | null }[] = []; let indexAsks = 0;
  const box = { holders: claimsBoxOf(holders as never), items: claimsBoxOf(items as never), pile: claimsBoxOf(pile as never) } satisfies Record<string, ClaimsBox>;
  const feedBlock = BigInt(holders.asOf.block);
  /** What the index says now: everything this wallet has not yet sent is claimable at the feed block; a sent claim is paid at block 200 + n. */
  const indexPage = () => {
    const paidAt = (match: (tx: Tx) => boolean) => { const at = sent.findIndex(match); return at < 0 ? null : { block: 200n + BigInt(at), tx: toHex(at + 1, { size: 32 }) }; };
    const call = (to: string | null | undefined, fn: string, args?: (a: readonly unknown[]) => boolean) => (tx: Tx) => {
      if (lower(tx.to) !== lower(to)) return false;
      const d = decoded(tx); return d.functionName === fn && (!args || args(d.args as readonly unknown[]));
    };
    const h = rolesOfV2(holders.row.record as never).contracts; const it = rolesOfV2(items.row.record as never).contracts;
    const rows: { box: ClaimsBox; row: ClaimRow }[] = [];
    const add = (b: ClaimsBox, row: ClaimRow) => rows.push({ box: b, row });
    if (options.pile) return { block: sent.length ? 300n : feedBlock, rows };
    for (const batch of [1n, 2n, 3n]) { const paid = paidAt(call(h.holderLedger, 'claim', (a) => a[0] === batch)); add(box.holders, { kind: 'holder', batch, amount: CREDIT, ...(paid ? { paid } : {}) }); }
    const handed = paidAt(call(h.coordinator, 'claim', (a) => a[0] === COINS));
    add(box.holders, handed ? { kind: 'failure', coins: COINS, amount: QUOTE, paid: handed } : { kind: 'failure', coins: COINS, amount: QUOTE, allowance: m2Rpc.chain.allowanceT });
    if (options.items) {
      for (const [id, amount, stash] of [[1n, ETH / 4n + ETH, ETH], [2n, ETH / 4n + 1n, 0n]] as const) {
        const paid = paidAt(call(it.itemLedger, 'claim', (a) => (a[0] as readonly bigint[])[0] === id));
        add(box.items, { kind: 'item', id, amount, stash, ...(paid ? { paid } : {}) });
      }
      const fees = paidAt(call(it.receiver, 'claimCreator'));
      add(box.items, { kind: 'creator', amount: owed + 5n, ...(fees ? { paid: fees } : {}) });
    }
    return { block: sent.length ? 300n : feedBlock, rows };
  };
  await installUntouchableWallet(page);
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (route) => route.abort());
  await page.route(`${CORE}/**`, async (route) => {
    const url = new URL(route.request().url()); const path = url.pathname;
    const headers = { 'access-control-allow-origin': '*' };
    if (path === `/v2/wallets/${chainId}/${lower(account)}/claims`) {
      indexAsks += 1;
      if (options.index === 'down') return route.fulfill({ status: 503, contentType: 'application/json', headers, body: JSON.stringify({ error: 'claims index is not following the chain' }) });
      const { block, rows } = indexPage();
      return route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify(claimsPageJson({ chainId, wallet: account, block, hash: block === feedBlock ? INDEX_HASH : undefined, rows })) });
    }
    const answer = path === '/v1/feed' ? data.v1.feed : path === '/v2/feed' ? { ...data.feed, cards } : path.endsWith('/activity') ? { asOf: holders.asOf, items: [], next: null } : null;
    await route.fulfill({ status: answer ? 200 : 404, contentType: 'application/json', headers, body: JSON.stringify(answer) });
  });
  await page.route(`${RPC}/**`, async (route) => {
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const call = route.request().postDataJSON() as RpcCall & { id: number };
    const tx = call.params?.[0] as { to?: string; data?: Hex } | undefined;
    if (call.method === 'eth_call' && tx?.to && tx.data) {
      let fn = tx.data.slice(0, 10);
      for (const abi of ABIS) { try { fn = decodeFunctionData({ abi, data: tx.data }).functionName; break; } catch { /* the next */ } }
      rpcHashes.push({ to: lower(tx.to), fn, hash: (call.params?.[1] as { blockHash?: string } | undefined)?.blockHash ?? null });
    }
    // The pile box answers every call itself; otherwise calls to the holder box's roles go to its double.
    const double = options.pile || (call.method === 'eth_call' && tx?.to !== undefined && !m2Roles.has(lower(tx.to))) ? m3Rpc : m2Rpc;
    let answer;
    try { answer = { result: call.method === 'eth_chainId' ? toHex(chainId) : await double.request(call) }; }
    catch (error) { answer = { error: { code: (error as { code?: number }).code ?? -32601, message: (error as Error).message } }; }
    await route.fulfill({ headers, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: call.id, ...answer }) });
  });
  await page.exposeFunction('claimsIndexRequest', async ({ method, params }: RpcCall) => {
    requests.push(method);
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
    if (method === 'eth_chainId') return toHex(chainId);
    if (method === 'eth_sendTransaction') {
      const sentTx = params?.[0] as Tx; sent.push(sentTx);
      if (sentTx.data.startsWith('0x095ea7b3')) m2Rpc.chain.allowanceT = decodeFunctionData({ abi: erc20Abi, data: sentTx.data }).args[1] as bigint;
      return toHex(sent.length, { size: 32 });
    }
    throw new Error(`Unexpected wallet request ${method}`);
  });
  await page.addInitScript(() => {
    const provider = { request: (call: unknown) => (window as unknown as { claimsIndexRequest(call: unknown): Promise<unknown> }).claimsIndexRequest(call), on() {}, removeListener() {} };
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: {
      info: { uuid: 'f5000000-bf71-4c1c-9011-521e67622b70', name: 'Claims index test wallet', rdns: 'org.example.fe5', icon: 'data:image/svg+xml;base64,PHN2Zy8+' }, provider,
    } })));
  });
  await page.goto('/settings');
  await page.getByRole('radio', { name: /Local chain/ }).check();
  const targetOf = (body: typeof holders, withPile = false): WriteTargetV2 => {
    const roles = rolesOfV2(body.row.record as never).contracts;
    return { chainId, coordinator: roles.coordinator as Address, receiver: roles.receiver as Address, token: body.token as Address, p: body.row.record.q as Address,
      ...(roles.holderLedger ? { holderLedger: roles.holderLedger } : {}), ...(roles.itemLedger ? { itemLedger: roles.itemLedger } : {}), ...(withPile && roles.vault ? { pile: roles.vault } : {}) };
  };
  return { requests, sent, rpcHashes, indexAsks: () => indexAsks, holders, items, pile, account, chainId,
    holderTarget: targetOf(holders), itemTarget: targetOf(items as unknown as typeof holders), pileTarget: targetOf(pile as unknown as typeof holders, true) };
}
async function chooseWallet(page: Page) {
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: /Claims index test wallet/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
function expectSends(sent: readonly Tx[], from: Address, expected: readonly (readonly [Address | null | undefined, string, readonly unknown[], WriteTargetV2])[]) {
  expect(sent).toHaveLength(expected.length);
  expected.forEach(([to, fn, args, target], i) => {
    const tx = sent[i] as Tx;
    expect(lower(tx.to)).toBe(lower(to)); expect(lower(tx.from)).toBe(lower(from)); expect(BigInt(tx.value)).toBe(0n);
    expect(decoded(tx)).toMatchObject(args.length ? { functionName: fn, args } : { functionName: fn });
    expect(() => assertSendableCallV2({ to: tx.to, data: tx.data, value: 0n }, target, from)).not.toThrow();
  });
}
async function noTradingControls(page: Page) {
  await expect(page.getByRole('button', { name: FORBIDDEN })).toHaveCount(0);
  await expect(page.getByRole('link', { name: FORBIDDEN })).toHaveCount(0);
  await expect(page.locator('iframe, textarea, input[type="number"], input[type="range"]')).toHaveCount(0);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
}

test('FE5 box page: the claims index lists every claim; each send re-checks at its block; Claimed survives a reload', async ({ page }, info) => {
  const f = await fixture(page, info);
  await page.goto(`/box/${f.chainId}/${f.holders.token.toLowerCase()}`);
  const panel = page.getByRole('region', { name: 'Your claims' });
  await expect(panel).toBeVisible();
  // Navigation asked neither the wallet nor the index anything.
  expect(f.requests).toEqual([]); expect(await walletTouches(page)).toEqual([]); expect(f.indexAsks()).toBe(0);
  await panel.getByRole('button', { name: 'Claim all', exact: true }).click();
  await chooseWallet(page);
  await expect(panel.getByText('4 ready', { exact: true })).toBeVisible();
  await expect(panel.locator('.sh-v2-fresh')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Claim all', exact: true }).click();
  const confirm = panel.getByRole('group', { name: 'Confirm Claim all' });
  await expect(confirm.getByRole('listitem')).toHaveText(['Batch 160.000001 ETH', 'Batch 260.000001 ETH', 'Batch 360.000001 ETH', 'Approve coins3 B52', 'Hand in coins3 B52 → for 3.333333 ETH']);
  expect(await brokenRuns(confirm.getByRole('list'))).toEqual([]);
  await noTradingControls(page);
  await shot(panel, info, 'index-box-list');
  expect(f.requests).not.toContain('eth_sendTransaction');
  await confirm.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(panel.getByText('5 / 5 done', { exact: true })).toBeVisible();
  const roles = rolesOfV2(f.holders.row.record as never).contracts;
  expectSends(f.sent, A, [
    [roles.holderLedger, 'claim', [1n, A], f.holderTarget], [roles.holderLedger, 'claim', [2n, A], f.holderTarget], [roles.holderLedger, 'claim', [3n, A], f.holderTarget],
    [f.holders.token as Address, 'approve', [roles.coordinator, COINS], f.holderTarget], [roles.coordinator, 'claim', [COINS, A], f.holderTarget],
  ]);
  // Each holder claim re-read its batch at the index's block hash before the wallet was asked (the holder panel's own
  // rows read at the feed's hash).
  const checks = f.rpcHashes.filter((c) => c.to === lower(roles.holderLedger) && c.fn === 'claimable' && c.hash === INDEX_HASH);
  expect(checks).toHaveLength(3);
  await expect(panel.getByText('Nothing to claim', { exact: true })).toBeVisible();
  // A reload: no session. The index's payments bring back Claimed, on Claim all and on the holder rows.
  await page.reload();
  await page.getByRole('banner').getByRole('button', { name: /wallet/i }).click();
  await chooseWallet(page);
  await expect(panel.getByText('Nothing to claim', { exact: true })).toBeVisible();
  const claimed = panel.locator('details.sh-v2-claimed');
  await expect(claimed.locator('summary')).toHaveText('4 claimed');
  await claimed.locator('summary').click();
  await expect(claimed.getByRole('listitem')).toHaveText(['Batch 1Claimed60.000001 ETH', 'Batch 2Claimed60.000001 ETH', 'Batch 3Claimed60.000001 ETH', 'Hand in coinsClaimed3 B52 → for 3.333333 ETH']);
  const earnings = page.getByRole('region', { name: 'Holder fee share' });
  for (const batch of [1, 2, 3]) await expect(earnings.getByRole('listitem').filter({ hasText: `Batch ${batch}` }).getByText('Claimed', { exact: true })).toBeVisible();
  expect(await brokenRuns(claimed.getByRole('list'))).toEqual([]);
  await noTradingControls(page);
  await shot(panel, info, 'index-box-reload-claimed');
});

test('FE5 fallback: with the index down the bounded scan stands in, marked Direct chain read, and still claims', async ({ page }, info) => {
  const f = await fixture(page, info, { index: 'down' });
  await page.goto(`/box/${f.chainId}/${f.holders.token.toLowerCase()}`);
  const panel = page.getByRole('region', { name: 'Your claims' });
  await panel.getByRole('button', { name: 'Claim all', exact: true }).click();
  await chooseWallet(page);
  await expect(panel.getByText('4 ready', { exact: true })).toBeVisible();
  const chip = panel.locator('.sh-v2-fresh');
  await expect(chip).toHaveText('Direct chain read');
  expect(await brokenRuns(chip)).toEqual([]);
  expect(f.indexAsks()).toBeGreaterThan(0);
  await noTradingControls(page);
  await shot(panel, info, 'index-down-direct');
  await panel.getByRole('button', { name: 'Claim all', exact: true }).click();
  await panel.getByRole('group', { name: 'Confirm Claim all' }).getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(panel.getByText('5 / 5 done', { exact: true })).toBeVisible();
  expect(f.sent).toHaveLength(5);
});

test('FE5 My Box: one index answer across the wallet’s boxes; the creator’s fees are the payee’s own claim; Claimed after a reload', async ({ page }, info) => {
  test.setTimeout(60_000);
  const f = await fixture(page, info, { items: true });
  await page.goto('/my-box');
  expect(f.requests).toEqual([]); expect(f.indexAsks()).toBe(0);
  await page.getByRole('banner').getByRole('button', { name: /wallet/i }).click();
  await chooseWallet(page);
  await expect(page.locator('header.sh-box-head .sh-box-stat').filter({ hasText: 'Claims ready' })).toHaveText('Claims ready7');
  await page.getByRole('tab', { name: 'Claims' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'On 2 boxes' })).toBeVisible();
  const panel = page.getByRole('region', { name: 'Your claims' });
  await expect(panel.locator('.sh-v2-fresh')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Claim all', exact: true }).click();
  const confirm = panel.getByRole('group', { name: 'Confirm Claim all' });
  await expect(confirm.getByRole('list', { name: 'Claims on Box 352 Items' }).getByRole('listitem')).toHaveText(['Item #11.25 ETH', 'Item #20.250000000000000001 ETH', 'Creator fees900719.925474099300000006 ETH']);
  await expect(confirm).toContainText('8 signatures · one each');
  await noTradingControls(page);
  await shot(page, info, 'index-wallet-list');
  await confirm.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(panel.getByText('8 / 8 done', { exact: true })).toBeVisible();
  const h = rolesOfV2(f.holders.row.record as never).contracts; const it = rolesOfV2(f.items.row.record as never).contracts;
  expectSends(f.sent, A, [
    [h.holderLedger, 'claim', [1n, A], f.holderTarget], [h.holderLedger, 'claim', [2n, A], f.holderTarget], [h.holderLedger, 'claim', [3n, A], f.holderTarget],
    [f.holders.token as Address, 'approve', [h.coordinator, COINS], f.holderTarget], [h.coordinator, 'claim', [COINS, A], f.holderTarget],
    [it.itemLedger, 'claim', [[1n], A], f.itemTarget], [it.itemLedger, 'claim', [[2n], A], f.itemTarget],
    [it.receiver, 'claimCreator', [f.items.row.record.q, A], f.itemTarget],
  ]);
  // The creator's amount was re-simulated as the payee's own claim at the index's hash before sending.
  expect(f.rpcHashes.some((c) => c.to === lower(it.receiver) && c.fn === 'claimCreator' && c.hash === INDEX_HASH)).toBe(true);
  await page.reload();
  await page.getByRole('banner').getByRole('button', { name: /wallet/i }).click();
  await chooseWallet(page);
  await page.getByRole('tab', { name: 'Claims' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Nothing to claim' })).toBeVisible();
  const claimed = page.getByRole('region', { name: 'Your claims' }).locator('details.sh-v2-claimed');
  await expect(claimed.locator('summary')).toHaveText('7 claimed');
  await claimed.locator('summary').click();
  await expect(claimed.getByRole('heading', { level: 3 })).toHaveText(['Box 52', 'Box 352 Items']);
  for (const list of await claimed.getByRole('list').all()) expect(await brokenRuns(list)).toEqual([]);
  await noTradingControls(page);
  await shot(page, info, 'index-wallet-reload-claimed');
});

test('FE5 seed return (M363-OC03): a failed pile’s seeder finds its seed in Claim all, sent as returnSeed() to the pile', async ({ page }, info) => {
  const f = await fixture(page, info, { pile: true });
  await page.goto(`/box/${f.chainId}/${f.pile.token.toLowerCase()}`);
  const panel = page.getByRole('region', { name: 'Your claims' });
  await panel.getByRole('button', { name: 'Claim all', exact: true }).click();
  await chooseWallet(page);
  await expect(panel.getByText('1 ready', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Claim all', exact: true }).click();
  const confirm = panel.getByRole('group', { name: 'Confirm Claim all' });
  await expect(confirm.getByRole('listitem')).toHaveText(['Seed return1000 ETH']);
  await expect(confirm).toContainText(f.account);
  await noTradingControls(page);
  await shot(panel, info, 'index-seed-list');
  await confirm.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(panel.getByText('1 / 1 done', { exact: true })).toBeVisible();
  const roles = rolesOfV2(f.pile.row.record as never).contracts;
  expectSends(f.sent, f.account, [[roles.vault, 'returnSeed', [], f.pileTarget]]);
  await expect(panel.locator('details.sh-v2-claimed summary')).toHaveText('1 claimed');
  await shot(panel, info, 'index-seed-done');
});
