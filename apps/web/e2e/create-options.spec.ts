import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { decodeFunctionData, encodeFunctionResult, getAddress, keccak256, toHex, zeroAddress, zeroHash, type Abi, type AbiParameter, type Address, type Hex } from 'viem';
import manifest from './fixtures/core-local/manifest-11155111.json' with { type: 'json' };
import { makePng } from '../../../packages/artwork/src/test-support/images';
import { coordinatorV2Abi, factoryV2Abi, listingRegistryV2Abi } from '../../../packages/chain/src/core/v2';
import { overflow } from './box-helpers';
import { listing } from './alchemist-site';
import { publishedItems } from '../src/features/core/v2/test-support/m3-published';
import { mixedDeployment } from '../src/features/core/v2/test-support/mixed-deployment';
import { m3RpcFixture } from '../src/features/core/v2/test-support/m3-rpc';
import type { RpcCall } from '../src/features/core/v2/test-support/m2-rpc';

// SH-218 rail 2 (design section 6, `create-switch-browser-journey` and `existing-box-is-independent-of-every-switch`):
// Create on a chain source (the local twin's build manifest; its listing book, its RPC and the release's list of
// switched-off options answered here; nothing leaves the machine) with a test wallet that records every request. The
// list starts empty; a token box with buyers' fees To holders is built; then the list switches that option off, then
// cannot be read, then is empty again and switches it off right before the wallet: Create sends nothing, every line is
// the founder's proposal (A or B), and the draft is kept. A box page asks the list nothing, whatever it says.
// SH218_SHOTS_DIR=<folder> writes the founder's pictures there, at 1440 (desktop) and 390 (mobile).

const CORE = 'http://127.0.0.1:8596';
const RPC = 'http://127.0.0.1:8599';
const CHAIN_ID = manifest.chainId;
const RELEASE = manifest.releases[0] as unknown as { factory: { address: Address }; registry: { address: Address }; listingRegistry: { address: Address }; implementations: { coordinator: { address: Address } }; versionCodeHash: Hex };
const REGISTRY = RELEASE.registry.address.toLowerCase();
const OPTIONS_PATH = `/v2/create-options/${CHAIN_ID}/${RELEASE.factory.address.toLowerCase()}.json`;
const RAISE = 4_206_980_085_000_000_000n;
const COORDINATOR = getAddress('0x00000000000000000000000000000000000c0071');
const TOKEN = getAddress('0x00000000000000000000000000000000000b0c51');
const CREATOR = getAddress('0x00000000000000000000000000000000000a11ce');
const A = 'Not available for new boxes right now.';
const B = 'Create is taking a short break. Your draft is kept.';

/** The server's fixture lists (packages/chain/src/create-options/fixtures), pinned to this build's release instead. */
function listOf(name: 'empty' | 'two-off'): string {
  const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../../../packages/chain/src/create-options/fixtures', `${name}.json`), 'utf8')) as Record<string, unknown>;
  return JSON.stringify({ ...fixture, chainId: CHAIN_ID, factory: RELEASE.factory.address.toLowerCase(), registry: REGISTRY, versionCodeHash: RELEASE.versionCodeHash.toLowerCase() });
}
type ListState = 'empty' | 'two-off' | 'down';

async function shot(page: Page, info: TestInfo, name: string) {
  const dir = process.env.SH218_SHOTS_DIR;
  const path = dir ? join(dir, `${name}-${info.project.name === 'mobile' ? '390' : '1440'}.png`) : info.outputPath(`${name}.png`);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const style = await page.addStyleTag({ content: '.sh-topbar, .sh-newbox__bar { position: static !important; }' });
  await page.screenshot({ path, fullPage: true, scale: 'css' });
  await style.evaluate((node) => (node as Element).remove());
}

function zeroOf(param: AbiParameter): unknown {
  const type = param.type;
  if (type.endsWith(']')) return [];
  if (type === 'tuple') return Object.fromEntries(((param as { components: readonly AbiParameter[] }).components).map((c) => [c.name ?? '', zeroOf(c)]));
  if (type.startsWith('uint') || type.startsWith('int')) return 0n;
  if (type === 'address') return zeroAddress;
  if (type === 'bool') return false;
  if (type === 'string') return '';
  if (type === 'bytes') return '0x';
  return zeroHash;
}
function result(abi: Abi, functionName: string, fill: (outputs: unknown[]) => unknown[]): Hex {
  const fn = abi.find((entry) => entry.type === 'function' && entry.name === functionName) as { outputs: readonly AbiParameter[] };
  const values = fill(fn.outputs.map(zeroOf));
  return encodeFunctionResult({ abi, functionName, result: values.length === 1 ? values[0] : values } as never);
}
/** The release's creation reads, as the local twin's contracts would answer them for a new ETH-priced box. */
function createAnswer(to: string, data: Hex): Hex | null {
  const at = to.toLowerCase();
  if (at === RELEASE.implementations.coordinator.address.toLowerCase()) {
    const { functionName } = decodeFunctionData({ abi: coordinatorV2Abi, data });
    return functionName === 'CHUNK_MAX' ? result(coordinatorV2Abi as Abi, functionName, () => [8192n]) : null;
  }
  if (at === RELEASE.listingRegistry.address.toLowerCase()) {
    const { functionName } = decodeFunctionData({ abi: listingRegistryV2Abi, data });
    return functionName === 'listing' ? result(listingRegistryV2Abi as Abi, functionName, ([record]) => [{ ...(record as object), id: 1, token: zeroAddress, decimals: 18, raise: RAISE }]) : null;
  }
  if (at === RELEASE.factory.address.toLowerCase()) {
    const { functionName } = decodeFunctionData({ abi: factoryV2Abi, data });
    const abi = factoryV2Abi as Abi;
    if (functionName === 'listingRegistry') return result(abi, functionName, () => [RELEASE.listingRegistry.address]);
    if (functionName === 'refusal') return result(abi, functionName, () => ['0x']);
    if (functionName === 'boxQParameters') return result(abi, functionName, ([q]) => [{ ...(q as object), bootstrapQ: 1_000_000n }]);
    if (functionName === 'tokenAddressLimit') return result(abi, functionName, () => [getAddress('0x8000000000000000000000000000000000000000')]);
    if (functionName === 'predictBox') return result(abi, functionName, () => [COORDINATOR, TOKEN, keccak256('0x1234')]);
  }
  return null;
}

/** The local chain source: ETH listed, the release's creation reads answered, the list as `state()` says. */
async function localCreateChain(page: Page, state: () => ListState) {
  const lists: { readonly at: number; readonly state: ListState }[] = [];
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (route) => route.abort());
  await page.route(`${CORE}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const headers = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
    if (path === OPTIONS_PATH) {
      const now = state();
      lists.push({ at: Date.now(), state: now });
      if (now === 'down') return route.fulfill({ status: 503, contentType: 'application/json', headers, body: '{"error":"create options unavailable"}' });
      return route.fulfill({ status: 200, contentType: 'application/json', headers, body: listOf(now) });
    }
    const answer = path === `/v2/listings/${CHAIN_ID}/${REGISTRY}` ? { schema: 'sh.core-listings.v2', chainId: CHAIN_ID, registry: REGISTRY, listings: [listing(1, zeroAddress, 18, 'NATIVE', RAISE)] } : null;
    await route.fulfill({ status: answer ? 200 : 404, contentType: 'application/json', headers, body: JSON.stringify(answer) });
  });
  await page.route(`${RPC}/**`, async (route) => {
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const body = route.request().postDataJSON() as { id: number; method: string; params?: unknown[] } | { id: number; method: string; params?: unknown[] }[];
    const answer = (call: { id: number; method: string; params?: unknown[] }) => {
      const ok = (value: unknown) => ({ jsonrpc: '2.0', id: call.id, result: value });
      switch (call.method) {
        case 'eth_chainId': return ok(toHex(CHAIN_ID));
        case 'eth_blockNumber': return ok('0x64');
        case 'eth_getCode': return ok(String(call.params?.[0]).toLowerCase() === COORDINATOR.toLowerCase() ? '0x' : '0x6080');
        case 'eth_estimateGas': return ok(toHex(3_000_000n));
        case 'eth_getBalance': return ok(toHex(10n ** 18n));
        case 'eth_maxPriorityFeePerGas': return ok(toHex(1_000_000_000n));
        case 'eth_gasPrice': return ok(toHex(2_000_000_000n));
        case 'eth_getBlockByNumber': return ok({ number: '0x64', hash: keccak256('0x64'), parentHash: zeroHash, timestamp: toHex(Math.floor(Date.now() / 1000)), gasLimit: toHex(30_000_000n), gasUsed: '0x0', baseFeePerGas: toHex(1_000_000_000n), transactions: [], logsBloom: `0x${'0'.repeat(512)}`, miner: zeroAddress, difficulty: '0x0', extraData: '0x', size: '0x1', nonce: '0x0000000000000000', mixHash: zeroHash, sha3Uncles: zeroHash, stateRoot: zeroHash, receiptsRoot: zeroHash, transactionsRoot: zeroHash, uncles: [] });
        case 'eth_call': {
          const { to, data } = call.params?.[0] as { to: string; data: Hex };
          try { const value = createAnswer(to, data); if (value) return ok(value); } catch { /* another contract's read */ }
          return { jsonrpc: '2.0', id: call.id, error: { code: 3, message: 'execution reverted' } };
        }
        default:
          return { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: `the fixture RPC does not answer ${call.method}` } };
      }
    };
    await route.fulfill({ headers, contentType: 'application/json', body: JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)) });
  });
  return { lists };
}

/** The test wallet (EIP-6963): it answers the account and chain, records every request, and declines any transaction. */
async function testWallet(page: Page, account: Address) {
  const requests: string[] = [];
  await page.exposeFunction('sh218Request', async (method: string) => {
    requests.push(method);
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
    if (method === 'eth_chainId') return toHex(CHAIN_ID);
    if (method === 'eth_sendTransaction') throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
    throw new Error(`Unexpected wallet request ${method}`);
  });
  await page.addInitScript(() => {
    const send = (method: string) => (window as unknown as { sh218Request(method: string): Promise<unknown> }).sh218Request(method);
    const provider = {
      request: async (call: { method: string }) => {
        try { return await send(call.method); } catch (error) { throw Object.assign(new Error('User rejected the request.'), { code: 4001, cause: error }); }
      },
      on() {}, removeListener() {},
    };
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: {
      info: { uuid: '21821821-bf71-4c1c-9011-521e67622b70', name: 'SH218 test wallet', rdns: 'org.example.sh218', icon: 'data:image/svg+xml;base64,PHN2Zy8+' }, provider,
    } })));
  });
  return requests;
}

const png = (name: string, size: number) => ({ name, mimeType: 'image/png', buffer: Buffer.from(makePng({ width: size, height: size, decodable: true })) });
const next = (page: Page) => page.getByRole('button', { name: 'Next', exact: true }).click();
const step = (page: Page, label: string) => page.getByRole('navigation', { name: 'Steps' }).getByRole('link', { name: new RegExp(`^${label}`) }).click();
/** The page reads its list again as a tab does when it is shown again. */
const showAgain = (page: Page) => page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
});

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

test('create-switch-browser-journey: switched-off options, an unreadable list and the last check before the wallet; nothing sent, the draft kept', async ({ page }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let list: ListState = 'empty';
  const chain = await localCreateChain(page, () => list);
  const wallet = await testWallet(page, CREATOR);
  await page.goto('/settings');
  await page.getByRole('radio', { name: /Local chain/ }).check();
  await page.goto('/create/v2-basics');
  // The empty list: nothing is marked.
  await expect(page.getByRole('button', { name: /To holders/ }).first()).toBeVisible();
  await expect.poll(() => chain.lists.length).toBeGreaterThan(0);
  await expect(page.locator('[data-create-options]')).toHaveCount(0);
  // A token box, buyers' fees To holders (paid in ETH), the rest as it comes.
  await page.getByRole('radio', { name: /^ETH\b/ }).check();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Lantern Fund');
  await page.getByRole('textbox', { name: 'Ticker', exact: true }).fill('LANT');
  await page.locator('#create-logo').setInputFiles(png('logo.png', 512));
  await expect(page.locator('#create-logo-action')).toHaveText('Change');
  await next(page);
  await page.getByRole('radio', { name: /^Token/ }).check();
  await next(page);
  await page.getByRole('group', { name: /^Buyers’ fees/ }).getByRole('button', { name: 'To holders', exact: true }).click();
  await next(page);
  await next(page);
  await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check();
  await next(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  await page.getByRole('banner').locator('.sh-wallet-button').click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: /SH218 test wallet/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const create = page.getByRole('button', { name: 'Create', exact: true });
  await expect(create).toBeEnabled();

  // The list switches the buyers' holders in ETH and the To holders template off: the draft cannot be sent.
  list = 'two-off';
  await showAgain(page);
  await expect(page.locator('[data-create-options="off"]')).toHaveText(`! ${A}`);
  await expect(create).toBeDisabled();
  // af1: the row that holds the option says so too; only the line under Create is announced.
  const buyersRow = page.locator('.sh-newbox-row').filter({ has: page.getByText('Buyers’ fees', { exact: true }) });
  await expect(buyersRow.locator('[data-create-options="row"]')).toHaveText(A);
  await expect(page.locator('[data-create-options="row"]')).toHaveCount(1);
  await expect(page.getByRole('alert').filter({ hasText: A })).toHaveCount(1);
  await buyersRow.scrollIntoViewIfNeeded();
  await shot(page, info, 'a-draft-blocked');
  // The form keeps the chosen option, marked; the template tile is off.
  await step(page, 'Fees');
  const buyers = page.getByRole('group', { name: /^Buyers’ fees/ });
  await expect(buyers.getByRole('button', { name: 'To holders', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(buyers.getByRole('button', { name: 'Claimed in ETH' })).toHaveAttribute('aria-disabled', 'true');
  await expect(buyers.getByText(A, { exact: true })).toBeVisible();
  await shot(page, info, 'a-form-option-off');
  await step(page, 'Basics');
  const tile = page.locator('[data-template="holders"]');
  await expect(tile).toHaveAttribute('aria-disabled', 'true');
  await tile.click({ force: true });
  await expect(tile).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.sh-v2-templates').getByText(A, { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Lantern Fund');
  await shot(page, info, 'a-template-off');

  // The list cannot be read: line B with Retry; Retry while it is still down keeps it.
  list = 'down';
  await step(page, 'Overview');
  await showAgain(page);
  await expect(page.locator('[data-create-options="unavailable"]').getByRole('alert')).toHaveText(`! ${B}`);
  await expect(create).toBeDisabled();
  const asked = chain.lists.length;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => chain.lists.length).toBeGreaterThan(asked);
  await expect(page.locator('[data-create-options="unavailable"]')).toBeVisible();
  await shot(page, info, 'b-unavailable');

  // Readable and empty again: Create is back. The list switches the option off once more right before the wallet.
  list = 'empty';
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('[data-create-options]')).toHaveCount(0);
  await expect(create).toBeEnabled();
  const before = chain.lists.length;
  await page.route(`${CORE}${OPTIONS_PATH}`, async (route) => {
    // From the press on: every read says the option is off (the page's own read was the empty list).
    list = 'two-off';
    await route.fallback();
  });
  await create.click();
  await expect(page.locator('[data-create-error]')).toHaveText(`! ${A}`, { timeout: 60_000 });
  expect(chain.lists.length).toBeGreaterThan(before);
  // af1 (N2): the fresh check before the pictures refused the run, so the executor never asked the wallet anything
  // for it (no eth_accounts), and nothing was sent or published.
  expect(wallet).not.toContain('eth_sendTransaction');
  expect(wallet).not.toContain('eth_accounts');
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('[data-create-error]')).toHaveText(`! ${A}`, { timeout: 60_000 });
  expect(wallet.filter((method) => method === 'eth_sendTransaction')).toHaveLength(0);
  // The draft is kept.
  await step(page, 'Basics');
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Lantern Fund');
  await expect(page.getByRole('textbox', { name: 'Ticker', exact: true })).toHaveValue('LANT');
  await expect(page.locator('#create-logo-action')).toHaveText('Change');
  expect(await overflow(page), 'sideways scroll').toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

for (const state of ['two-off', 'all-off', 'down'] as const) {
  test(`existing-box-is-independent-of-every-switch: a box page with the list ${state} asks it nothing and shows the same`, async ({ page }) => {
    const published = await publishedItems();
    const data = await mixedDeployment();
    const card = { ...published.body, chainId: data.manifest.chainId, row: { ...published.body.row, chainId: data.manifest.chainId, record: { ...published.body.row.record, poolManager: data.manifest.chain.poolManager.address } } };
    const rpc = m3RpcFixture({});
    const asked: string[] = [];
    await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (route) => route.abort());
    await page.route(`${CORE}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.startsWith('/v2/create-options/')) {
        asked.push(path);
        const off = state === 'all-off' ? ['kind.token', 'kind.collection', 'kind.shop', 'kind.pile'] : ['fee.buyers.holders-p'];
        return route.fulfill(state === 'down' ? { status: 503, body: '{}' } : { status: 200, contentType: 'application/json', body: JSON.stringify({ ...JSON.parse(listOf('empty')), off: off.map((key) => ({ key })) }) });
      }
      const answer = path === '/v1/feed' ? data.v1.feed : path === '/v2/feed' ? { ...data.feed, cards: [card] } : path.endsWith('/activity') ? { asOf: published.body.asOf, items: [], next: null } : null;
      await route.fulfill({ status: answer ? 200 : 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(answer) });
    });
    await page.route(`${RPC}/**`, async (route) => {
      const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      const calls = route.request().postDataJSON() as (RpcCall & { id: number }) | (RpcCall & { id: number })[];
      const one = async (call: RpcCall & { id: number }) => {
        try { return { jsonrpc: '2.0', id: call.id, result: call.method === 'eth_chainId' ? toHex(data.manifest.chainId) : await rpc.request(call) }; }
        catch (error) { return { jsonrpc: '2.0', id: call.id, error: { code: (error as { code?: number }).code ?? -32601, message: (error as Error).message } }; }
      };
      await route.fulfill({ headers, contentType: 'application/json', body: JSON.stringify(Array.isArray(calls) ? await Promise.all(calls.map(one)) : await one(calls)) });
    });
    await page.goto('/settings');
    await page.getByRole('radio', { name: /Local chain/ }).check();
    await page.goto(`/box/${data.manifest.chainId}/${published.body.token.toLowerCase()}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState('networkidle');
    expect(asked).toEqual([]);
    await expect(page.locator('[data-create-options]')).toHaveCount(0);
    await expect(page.getByText(A, { exact: true })).toHaveCount(0);
    await expect(page.getByText(B, { exact: true })).toHaveCount(0);
  });
}
