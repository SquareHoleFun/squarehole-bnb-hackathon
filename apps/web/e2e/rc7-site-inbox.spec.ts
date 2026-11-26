import { createOptionsAnswer } from './create-options-list';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, erc20Abi, getAddress, parseAbi, toHex, type Address, type Hex } from 'viem';
import manifest from './fixtures/core-local/manifest-11155111.json' with { type: 'json' };
import { installUntouchableWallet, overflow, walletTouches } from './box-helpers';
import { launchRouterV2Abi, listingRegistryV2Abi, parseCoreManifestV2, royaltyRouterV2Abi } from '../../../packages/chain/src/core/v2';
import { assertSendableCallV2 } from '../../../packages/chain/src/core/v2/write-calls-v2';
import recording from '../../../packages/indexer/test/fixtures/core-local-life.json' with { type: 'json' };
import life from './fixtures/core-local/life.json' with { type: 'json' };
import { publishedV2 } from '../src/features/core/v2/test-support/published-v2';
import { inboxRpcFixture, type InboxRpcWorld } from '../src/features/core/v2/test-support/inbox-rpc';
import type { RpcCall } from '../src/features/core/v2/test-support/m2-rpc';

// SH-RC7-SITE-INBOX (rc7 open item 11) in the browser, at 1440 px (desktop) and 390 px (mobile): a live box's Inbox with
// each coin's history and the guarded public refresh and observe (read and dry-run before they show), a graduated
// box's launch tax with its public sweep (KF-5), the connected payee's in-kind claim, and the create page's sale-list
// preview. Synthetic publications through the real source, page and wallet boundary; the indexer and the RPC answered
// here, nothing leaves the machine. Navigation asks the wallet nothing; a press opens it. SH_EVIDENCE_SCREENSHOTS=1
// writes the pictures to docs/evidence/SH-RC7-SITE-INBOX/.
const CORE = 'http://127.0.0.1:8596';
const RPC = 'http://127.0.0.1:8599';
const NOW = BigInt(Math.floor(Date.now() / 1000));
const DAY = 86_400n;
const USDC = getAddress('0x00000000000000000000000000000000000005dc');
const LINK = getAddress('0x0000000000000000000000000000000000000514');
const DUST = getAddress('0x0000000000000000000000000000000000000d05');
const ACTOR = getAddress('0x00000000000000000000000000000000000000a1');
const FORBIDDEN = /^(buy|sell|swap)$/i;
async function shot(target: Page | Locator, info: TestInfo, name: string) {
  const path = process.env.SH_EVIDENCE_SCREENSHOTS === '1'
    ? fileURLToPath(new URL(`../../../docs/evidence/SH-RC7-SITE-INBOX/${name}-${info.project.name}.png`, import.meta.url)) : info.outputPath(`${name}.png`);
  const page = 'goto' in target ? target : target.page();
  const style = await page.addStyleTag({ content: '.sh-topbar, .sh-newbox__bar { position: static !important; }' });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  if ('goto' in target) await target.screenshot({ path, fullPage: true, scale: 'css' }); else await target.screenshot({ path, scale: 'css' });
  await style.evaluate((node) => (node as Element).remove());
}

type Json = Record<string, unknown>;
const ref = { blockNumber: '102', blockHash: `0x${'e8'.repeat(32)}`, txHash: `0x${'8f'.repeat(32)}`, txIndex: 0, logIndex: 0 };
const totals = { inKindClaimed: '0', funded: '0', flushed: '0', unwrapped: '0' };
const coin = (address: Address, lot: bigint, balance: bigint, extra: Json = {}) => ({ coin: address, lot: String(lot), balance: String(balance), oldestUnsoldAt: '0', registered: false,
  belowOneLot: lot > 0n && balance > 0n && balance < lot, lastRefresh: null, lastSale: null, ...totals, ...extra });

/** A live box (graduated when asked) whose inbox holds USDC (whole lots, one sale), LINK (below a lot) and DUST (no lot). */
async function serve(page: Page, o: { graduated?: boolean; account?: 'payee' | 'actor'; world?: Partial<InboxRpcWorld> } = {}) {
  const published = await publishedV2(false);
  const manifestV1 = recording.manifest;
  const deployed = parseCoreManifestV2({ ...manifestV1, releases: published.source.manifest.releases.map((release) => ({ ...release, startBlock: manifestV1.evidence.block.number,
    safes: { ...release.safes, platform: { ...release.safes.platform, address: manifestV1.chain.platformSafe.address } } })) });
  const body = published.body as unknown as Json & { row: Json & { record: Json & { contracts: readonly Address[]; creator: Address; q: Address } }; money: Json; token: string; asOf: Json };
  const contracts = body.row.record.contracts;
  const router = getAddress(contracts[8] as string); const payee = getAddress(((body.money.royalty as Json).payee as string));
  const royalty = { router, payee, balances: { [DUST.toLowerCase()]: '7' }, listVersion: '3', complete: true, coins: [
    coin(USDC, 100_000_000n, 250_000_000n, { registered: true, oldestUnsoldAt: String(NOW - DAY),
      lastRefresh: { balance: '350000000', oldestUnsoldAt: String(NOW - 3n * DAY), at: String(NOW - 3n * DAY), ref },
      lastSale: { buyToken: deployed.chain.weth.address, sellAmount: '100000000', buyAmount: '41000000', feeAmount: '0', orderUid: `0x${'ab'.repeat(56)}`, at: String(NOW - 2n * DAY), ref } }),
    coin(LINK, 10n ** 18n, 4n * 10n ** 17n),
    coin(DUST, 0n, 7n, { inKindClaimed: '3' }),
  ] };
  const card = { ...body, verified: true, graduated: o.graduated === true, chainId: deployed.chainId, money: { ...body.money, royalty },
    row: { ...body.row, chainId: deployed.chainId, record: { ...body.row.record, poolManager: deployed.chain.poolManager.address } } };
  const rpc = inboxRpcFixture({ router, coordinator: getAddress(contracts[0] as string), launchRouter: getAddress(contracts[6] as string), weth: deployed.chain.weth.address as Address,
    relayer: getAddress('0x00000000000000000000000000000000000c0e00'), payee, now: NOW,
    coins: { [USDC.toLowerCase()]: { lot: 100_000_000n, held: 250_000_000n, registered: true, oldestUnsoldAt: NOW - DAY, allowance: 100_000_000n, approved: 100_000_000n, inKind: 'WaitForSale' },
      [LINK.toLowerCase()]: { lot: 10n ** 18n, held: 4n * 10n ** 17n }, [DUST.toLowerCase()]: { lot: 0n, held: 7n, inKind: 7n } }, ...o.world });
  const requests: string[] = []; const sent: { from: Address; to: Address; data: Hex; value: Hex; gas: Hex }[] = [];
  const account = o.account === 'payee' ? payee : ACTOR;
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (route) => route.abort());
  await page.route(`${CORE}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const answer = path === '/v1/feed' ? life.stages.bonding : path === '/v2/feed' ? { ...published.feed, chainId: deployed.chainId, cards: [card] } : path.endsWith('/activity') ? { asOf: body.asOf, items: [], next: null } : null;
    await route.fulfill({ status: answer ? 200 : 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(answer) });
  });
  await page.route(`${RPC}/**`, async (route) => {
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const call = route.request().postDataJSON() as RpcCall & { id: number };
    let answer;
    // SH-BOX-LIFE-VIEW: the page names the box's price coin by its ERC-20 symbol (as Create does): this one is tUSDC.
    const read = call.method === 'eth_call' ? call.params?.[0] as { to?: string; data?: Hex } | undefined : undefined;
    const symbolCall = read?.to?.toLowerCase() === (body.row.record.q as string).toLowerCase() && read.data !== undefined && (() => { try { return decodeFunctionData({ abi: erc20Abi, data: read.data }).functionName === 'symbol'; } catch { return false; } })();
    try { answer = { result: call.method === 'eth_chainId' ? toHex(deployed.chainId) : symbolCall ? encodeFunctionResult({ abi: erc20Abi, functionName: 'symbol', result: 'tUSDC' }) : await rpc.request(call) }; }
    catch (error) { answer = { error: { code: (error as { code?: number }).code ?? -32601, message: (error as Error).message, ...((error as { data?: Hex }).data ? { data: (error as { data?: Hex }).data } : {}) } }; }
    await route.fulfill({ headers, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: call.id, ...answer }) });
  });
  await page.exposeFunction('rc7Request', async ({ method, params }: RpcCall) => {
    requests.push(method);
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
    if (method === 'eth_chainId') return toHex(deployed.chainId);
    // The test wallet signs nothing: it records what the site asked it to send and answers a transaction hash.
    if (method === 'eth_sendTransaction') { sent.push(params?.[0] as (typeof sent)[number]); return toHex(sent.length, { size: 32 }); }
    throw new Error(`Unexpected wallet request ${method}`);
  });
  await page.addInitScript(() => {
    const provider = { request: (call: unknown) => (window as unknown as { rc7Request(call: unknown): Promise<unknown> }).rc7Request(call), on() {}, removeListener() {} };
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: {
      info: { uuid: '7c2a7f0e-5a43-4f5e-9d0b-2b8f4f1a7c11', name: 'RC7 test wallet', rdns: 'org.example.rc7', icon: 'data:image/svg+xml;base64,PHN2Zy8+' }, provider } })));
  });
  await page.goto('/settings');
  await page.getByRole('radio', { name: /Local chain/ }).check();
  await page.goto(`/box/${deployed.chainId}/${body.token.toLowerCase()}`);
  await expect(page.locator('.sh-v2-page')).toBeVisible({ timeout: 30_000 });
  const target = { chainId: deployed.chainId, token: getAddress(body.token), coordinator: getAddress(contracts[0] as string), receiver: getAddress(contracts[5] as string),
    p: getAddress(body.row.record.q as string), royaltyRouter: router, launchRouter: getAddress(contracts[6] as string) };
  return { requests, sent, rpc, router, payee, account, target, launchRouter: target.launchRouter };
}
const inbox = (page: Page) => page.locator('details', { has: page.locator('summary', { hasText: /^Inbox$/ }) });
const coinRow = (page: Page, address: Address) => page.locator(`[data-coin="${address.toLowerCase()}"]`);
async function connect(page: Page, press: Locator) {
  await press.click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: /RC7 test wallet/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test.beforeEach(async ({ page }) => { await installUntouchableWallet(page); await page.emulateMedia({ reducedMotion: 'reduce' }); });

test('SH-RC7-SITE-INBOX box page: each coin’s history and the guarded refresh and observe; the wallet only on a press', async ({ page }, info) => {
  test.setTimeout(90_000);
  const f = await serve(page);
  // Navigation asks the wallet nothing and reads nothing of the inbox until its panel opens.
  expect(f.requests).toEqual([]);
  expect(f.rpc.calls.filter((c) => c.method === 'eth_getStorageAt')).toEqual([]);
  await inbox(page).locator('summary').first().click();
  const usdc = coinRow(page, USDC); const link = coinRow(page, LINK);
  await expect(usdc.getByRole('button', { name: 'Refresh · 2 lots' })).toBeVisible({ timeout: 30_000 });
  await expect(link.getByRole('button', { name: 'Start clock' })).toBeVisible();
  // A coin with no lot has no public control; its taken-in-kind total is in its history.
  await expect(coinRow(page, DUST).getByRole('button')).toHaveCount(0);
  await usdc.getByText('History', { exact: true }).click();
  await expect(usdc.locator('dt', { hasText: /^Last sale$/ }).locator('xpath=following-sibling::dd[1]')).toHaveText('100000000 raw units for 41 tUSDC · 2 days ago');
  await expect(usdc.locator('dt', { hasText: /^Last refresh$/ }).locator('xpath=following-sibling::dd[1]')).toHaveText('350000000 raw units · 3 days ago');
  await coinRow(page, DUST).getByText('History', { exact: true }).click();
  await expect(coinRow(page, DUST).locator('dt', { hasText: /^Taken in kind$/ }).locator('xpath=following-sibling::dd[1]')).toHaveText('3 raw units');
  expect(f.requests).toEqual([]);
  await expect(page.getByRole('button', { name: FORBIDDEN })).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await shot(inbox(page), info, 'inbox-controls-history');
  expect(await walletTouches(page), 'browsing and opening the inbox touch no wallet').toEqual([]);
  // The press opens the wallet; a second press asks one confirmation and sends exactly refreshOrder(USDC) to the inbox.
  await connect(page, usdc.getByRole('button', { name: 'Refresh · 2 lots' }));
  expect(f.sent).toEqual([]);
  await usdc.getByRole('button', { name: 'Refresh · 2 lots' }).click();
  const confirm = page.getByRole('group', { name: 'Confirm transaction' });
  await expect(confirm.getByText('Offer 2 lots of this coin for tUSDC on CoW?')).toBeVisible();
  await shot(inbox(page), info, 'inbox-refresh-confirm');
  await confirm.getByRole('button', { name: 'Confirm' }).click();
  await expect(inbox(page).getByRole('status')).toHaveText('Confirmed. Reading the updated box…');
  expect(f.sent).toHaveLength(1);
  const tx = f.sent[0] as (typeof f.sent)[number];
  expect(getAddress(tx.to)).toBe(f.router); expect(getAddress(tx.from)).toBe(ACTOR); expect(tx.value).toBe('0x0');
  expect(decodeFunctionData({ abi: royaltyRouterV2Abi, data: tx.data })).toMatchObject({ functionName: 'refreshOrder', args: [USDC] });
  expect(() => assertSendableCallV2({ to: tx.to, data: tx.data, value: 0n }, f.target, ACTOR)).not.toThrow();
});

test('SH-RC7-SITE-INBOX KF-5: a graduated box’s launch tax shows with what its sweep would move, and the press sends sweep()', async ({ page }, info) => {
  test.setTimeout(90_000);
  const f = await serve(page, { graduated: true, world: { sweep: 12_500_000n } });
  const panel = page.getByRole('region', { name: 'Launch tax' });
  await expect(panel.locator('.sh-v2-value')).toHaveText('12.5 tUSDC', { timeout: 30_000 });
  await expect(panel.getByText('Waits to move into the pool’s depth. Anyone may move it.')).toBeVisible();
  expect(f.requests).toEqual([]); expect(await walletTouches(page)).toEqual([]);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await shot(panel, info, 'launch-tax');
  await connect(page, panel.getByRole('button', { name: 'Move' }));
  await panel.getByRole('button', { name: 'Move' }).click();
  await panel.getByRole('group', { name: 'Confirm transaction' }).getByRole('button', { name: 'Confirm' }).click();
  await expect(panel.getByRole('status')).toHaveText('Confirmed. Reading the updated box…');
  const tx = f.sent[0] as (typeof f.sent)[number];
  expect(f.sent).toHaveLength(1);
  expect(getAddress(tx.to)).toBe(f.launchRouter);
  expect(decodeFunctionData({ abi: launchRouterV2Abi, data: tx.data })).toMatchObject({ functionName: 'sweep' });
});

test('SH-RC7-SITE-INBOX the payee’s in-kind claim: a coin address checked by its own dry run, then Take', async ({ page }, info) => {
  test.setTimeout(90_000);
  const f = await serve(page, { account: 'payee' });
  // Not connected: no field on the page at all.
  await inbox(page).locator('summary').first().click();
  await expect(page.getByRole('textbox', { name: 'Coin to take' })).toHaveCount(0);
  await connect(page, coinRow(page, USDC).getByRole('button', { name: 'Refresh · 2 lots' }));
  const field = page.getByRole('textbox', { name: 'Coin to take' });
  await field.fill(USDC);
  await expect(page.getByText('Not yet: a coin on the sale list waits 30 days without a sale.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take' })).toHaveCount(0);
  await field.fill(DUST);
  await expect(page.getByRole('button', { name: 'Take' })).toBeVisible();
  await expect(inbox(page).locator('.sh-v2-in-kind .sh-v2-value')).toHaveText('7 raw units');
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await shot(inbox(page), info, 'inbox-in-kind');
  await page.getByRole('button', { name: 'Take' }).click();
  await page.getByRole('group', { name: 'Confirm transaction' }).getByRole('button', { name: 'Confirm' }).click();
  await expect(inbox(page).getByRole('status')).toHaveText('Confirmed. Reading the updated box…');
  const tx = f.sent[0] as (typeof f.sent)[number];
  expect(f.sent).toHaveLength(1);
  expect(getAddress(tx.from)).toBe(f.payee); expect(getAddress(tx.to)).toBe(f.router);
  expect(decodeFunctionData({ abi: royaltyRouterV2Abi, data: tx.data })).toMatchObject({ functionName: 'claimInKind', args: [DUST] });
});

// --- The create page: the sale list a box created now copies, on the local chain source --------------------------------
const NATIVE = '0x0000000000000000000000000000000000000000' as Address;
const SALE_USDC = getAddress('0x0000000000000000000000000000000000006001');
const SALE_LINK = getAddress('0x0000000000000000000000000000000000006002');
const BOOK = [['ETH', NATIVE, 18, 'NATIVE', 4_206_980_085_000_000_000n], ['USDC', SALE_USDC, 6, 'STABLE', 15_986_524_323n], ['LINK', SALE_LINK, 18, 'OTHER', 10n ** 21n]] as const;
function listing(id: number, token: Address, decimals: number, cls: string, raise: bigint) {
  const detail = { id, token, decimals, class: cls, kind: 'LISTED', listedAt: '1', raise: raise.toString(), q: { bootstrapQ: '1', batchMinQ: '1', tipMaxQ: '1', swapStepMinQ: '1' } };
  return { id, token, class: cls, kind: 'LISTED', raise: raise.toString(), detail };
}

test('SH-RC7-SITE-INBOX create: the Fees step previews the sale list and each coin’s lot, read-only, the price coin left out', async ({ page }, info) => {
  test.setTimeout(90_000);
  const release = manifest.releases[0] as unknown as { listingRegistry: { address: Address }; implementations: { royaltyRouter: { address: Address } }; registry: { address: Address } };
  const weth = getAddress(manifest.chain.weth.address);
  const sale = [[weth, 10n ** 16n], [SALE_USDC, 100_000_000n], [SALE_LINK, 25n * 10n ** 17n]] as const;
  const symbols = new Map(BOOK.map(([symbol, token]) => [token.toLowerCase(), symbol]));
  const MINIMUM = parseAbi(['function minimumLot() view returns (uint256)']);
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (route) => route.abort());
  await page.route(`${CORE}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const registry = release.registry.address.toLowerCase();
    const answer = path === `/v2/listings/${manifest.chainId}/${registry}` ? { schema: 'sh.core-listings.v2', chainId: manifest.chainId, registry, listings: BOOK.map(([, token, decimals, cls, raise], i) => listing(i + 1, token, decimals, cls, raise)) } : createOptionsAnswer(path);
    await route.fulfill({ status: answer ? 200 : 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(answer) });
  });
  const reads: string[] = [];
  await page.route(`${RPC}/**`, async (route) => {
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const body = route.request().postDataJSON() as { id: number; method: string; params?: unknown[] } | { id: number; method: string; params?: unknown[] }[];
    const answer = (call: { id: number; method: string; params?: unknown[] }) => {
      const ok = (result: unknown) => ({ jsonrpc: '2.0', id: call.id, result });
      const reverted = { jsonrpc: '2.0', id: call.id, error: { code: 3, message: 'execution reverted' } };
      if (call.method === 'eth_chainId') return ok(toHex(manifest.chainId));
      if (call.method === 'eth_getCode') return ok('0x6080');
      if (call.method !== 'eth_call') return { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: `the fixture RPC does not answer ${call.method}` } };
      const { to, data } = call.params?.[0] as { to: string; data: Hex };
      if (to.toLowerCase() === release.listingRegistry.address.toLowerCase()) {
        const d = decodeFunctionData({ abi: listingRegistryV2Abi, data });
        reads.push(d.functionName);
        const result = d.functionName === 'sellableVersion' ? 4n : d.functionName === 'sellableCount' ? BigInt(sale.length)
          : d.functionName === 'sellableToken' ? sale[Number(d.args[0])]?.[0] : d.functionName === 'sellableLotAt' ? sale.find(([c]) => c.toLowerCase() === String(d.args[0]).toLowerCase())?.[1] : undefined;
        return result === undefined ? reverted : ok(encodeFunctionResult({ abi: listingRegistryV2Abi, functionName: d.functionName, result } as never));
      }
      if (to.toLowerCase() === release.implementations.royaltyRouter.address.toLowerCase()) return ok(encodeFunctionResult({ abi: MINIMUM, functionName: 'minimumLot', result: 5n * 10n ** 16n }));
      const symbol = symbols.get(to.toLowerCase());
      try { if (symbol && decodeFunctionData({ abi: erc20Abi, data }).functionName === 'symbol') return ok(encodeAbiParameters([{ type: 'string' }], [symbol])); } catch { /* another getter */ }
      return reverted;
    };
    await route.fulfill({ headers, contentType: 'application/json', body: JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)) });
  });
  await page.goto('/settings');
  await page.getByRole('radio', { name: /Local chain/ }).check();
  await page.goto('/create/v2-basics');
  await expect(page.getByRole('group', { name: /^Priced in/ }).getByRole('radio', { name: /^ETH/ })).toBeChecked({ timeout: 30_000 });
  // The basics step reads no sale list; the Fees step does.
  expect(reads).toEqual([]);
  await page.goto('/create/v2-fees');
  const details = page.locator('details[data-sale-list]');
  await expect(details.locator('summary')).toHaveText('Sale list · 2 coins', { timeout: 30_000 });
  await details.locator('summary').click();
  const lot = (name: string) => details.locator('.sh-newbox-row').filter({ has: page.locator('dt', { hasText: new RegExp(`^${name}$`) }) }).locator('dd');
  // The box is priced in ETH, so WETH (bought for it and unwrapped) is left out; each other coin at its listed lot.
  await expect(lot('USDC')).toHaveText('100 USDC');
  await expect(lot('LINK')).toHaveText('2.5 LINK');
  await expect(details.locator('dt')).toHaveText(['USDC', 'LINK']);
  expect(reads).toEqual(expect.arrayContaining(['sellableVersion', 'sellableCount', 'sellableToken', 'sellableLotAt']));
  await expect(details.getByRole('button')).toHaveCount(0);
  await expect(details.locator('input')).toHaveCount(0);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await shot(details, info, 'create-sale-list');
  expect(await walletTouches(page)).toEqual([]);
});
