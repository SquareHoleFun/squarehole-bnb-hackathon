import { createOptionsAnswer } from './create-options-list';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { decodeFunctionData, encodeFunctionResult, getAddress, keccak256, toHex, zeroAddress, zeroHash, type Abi, type AbiParameter, type Address, type Hex } from 'viem';
import manifest from './fixtures/core-local/manifest-11155111.json' with { type: 'json' };
import { makePng } from '../../../packages/artwork/src/test-support/images';
import { boxCollectionAbi } from '../../../packages/chain/src/abi/boxCollection';
import { coordinatorV2Abi, factoryV2Abi, listingRegistryV2Abi } from '../../../packages/chain/src/core/v2';
import { readOpenBoxSpec } from '../../../packages/chain/scripts/reveal-open-v2';
import { overflow } from './box-helpers';
import { listing } from './alchemist-site';
import { publishedItems } from '../src/features/core/v2/test-support/m3-published';
import { mixedDeployment } from '../src/features/core/v2/test-support/mixed-deployment';
import { m3RpcFixture } from '../src/features/core/v2/test-support/m3-rpc';
import type { RpcCall } from '../src/features/core/v2/test-support/m2-rpc';

// SH-192 (BOXSPEC-AUTOSAVE, founder 2026-11-02): an open collection created on a chain source (the local twin's build
// manifest; the listing book and the RPC answered here as the release would answer them; nothing leaves the machine)
// cannot be sent before its reveal data is saved. Create's press saves the box file itself (a download where the
// browser offers no save window; the save window, here a test double, where it does), Create is disabled meanwhile,
// "Download requested: <file>" (or a confirmed picker save) follows, and the run then keeps the reveal data in this browser's IndexedDB under its predicted token
// before the wallet is asked anything. The test wallet declines the first transaction; nothing is sent. The box page
// then offers the creator this device's copy again. SH_EVIDENCE_SCREENSHOTS=1 writes the pictures to
// docs/evidence/SH-BOXSPEC-AUTOSAVE/ (or SH_EVIDENCE_DIR), at 1440 (desktop) and 390 (mobile).

const CORE = 'http://127.0.0.1:8596';
const RPC = 'http://127.0.0.1:8599';
const CHAIN_ID = manifest.chainId;
const RELEASE = manifest.releases[0] as unknown as { factory: { address: Address }; registry: { address: Address }; listingRegistry: { address: Address }; implementations: { coordinator: { address: Address } } };
const REGISTRY = RELEASE.registry.address.toLowerCase();
const RAISE = 4_206_980_085_000_000_000n;
const COORDINATOR = getAddress('0x00000000000000000000000000000000000c0071');
const TOKEN = getAddress('0x00000000000000000000000000000000000b0c51');
const CREATOR = getAddress('0x00000000000000000000000000000000000a11ce');
const ITEMS = 10;

async function shot(page: Page, info: TestInfo, name: string) {
  const path = process.env.SH_EVIDENCE_SCREENSHOTS === '1'
    ? fileURLToPath(new URL(`../../../docs/evidence/${process.env.SH_EVIDENCE_DIR ?? 'SH-BOXSPEC-AUTOSAVE'}/${name}-${info.project.name === 'mobile' ? '390' : '1440'}.png`, import.meta.url)) : info.outputPath(`${name}.png`);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  // A full-page picture draws a sticky bar once, where the page scrolled it: keep the bars in the flow for it.
  const style = await page.addStyleTag({ content: '.sh-topbar, .sh-newbox__bar { position: static !important; }' });
  await page.screenshot({ path, fullPage: true, scale: 'css' });
  await style.evaluate((node) => (node as Element).remove());
}

/** A value of an ABI parameter with every field zero (structs recursively), so an answer names only what it means. */
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

/** The local chain source: ETH listed, the release's creation reads answered; anything else reverts or is refused. */
async function localCreateChain(page: Page) {
  const unanswered: string[] = [];
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (route) => route.abort());
  await page.route(`${CORE}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const answer = path === `/v2/listings/${CHAIN_ID}/${REGISTRY}` ? { schema: 'sh.core-listings.v2', chainId: CHAIN_ID, registry: REGISTRY, listings: [listing(1, zeroAddress, 18, 'NATIVE', RAISE)] }
      // SH-218 rail 2: the release's list of switched-off options, empty (the suite's one answer): Create reads it before it sends.
      : createOptionsAnswer(path);
    await route.fulfill({ status: answer ? 200 : 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(answer) });
  });
  await page.route(`${RPC}/**`, async (route) => {
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const body = route.request().postDataJSON() as { id: number; method: string; params?: unknown[] } | { id: number; method: string; params?: unknown[] }[];
    const answer = (call: { id: number; method: string; params?: unknown[] }) => {
      const ok = (value: unknown) => ({ jsonrpc: '2.0', id: call.id, result: value });
      const reverted = { jsonrpc: '2.0', id: call.id, error: { code: 3, message: 'execution reverted' } };
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
          return reverted;
        }
        default:
          unanswered.push(call.method);
          return { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: `the fixture RPC does not answer ${call.method}` } };
      }
    };
    await route.fulfill({ headers, contentType: 'application/json', body: JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)) });
  });
  return { unanswered };
}

/**
 * The test wallet (EIP-6963): it answers the account and chain, and declines every transaction. Before it declines, the
 * page's own script reads this browser's IndexedDB copy, so the test sees what was kept at the moment of the request.
 */
async function testWallet(page: Page, account: Address) {
  const requests: { method: string; kept?: unknown }[] = [];
  await page.exposeFunction('sh192Request', async ({ method, kept }: { method: string; kept?: unknown }) => {
    requests.push({ method, ...(kept !== undefined ? { kept } : {}) });
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
    if (method === 'eth_chainId') return toHex(CHAIN_ID);
    if (method === 'eth_sendTransaction') throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
    throw new Error(`Unexpected wallet request ${method}`);
  });
  await page.addInitScript(() => {
    const keptNow = () => new Promise<unknown>((resolve) => {
      const open = indexedDB.open('sh.reveal.keep.v1');
      open.onerror = () => resolve(null);
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('boxes')) { db.close(); resolve([]); return; }
        const all = db.transaction('boxes', 'readonly').objectStore('boxes').getAll();
        all.onsuccess = () => { db.close(); resolve(all.result); };
        all.onerror = () => { db.close(); resolve(null); };
      };
    });
    const send = (call: unknown) => (window as unknown as { sh192Request(call: unknown): Promise<unknown> }).sh192Request(call);
    const provider = {
      request: async (call: { method: string }) => {
        if (call.method !== 'eth_sendTransaction') return send({ method: call.method });
        const kept = await keptNow();
        try {
          return await send({ method: call.method, kept });
        } catch (error) {
          throw Object.assign(new Error('User rejected the request.'), { code: 4001, cause: error });
        }
      },
      on() {}, removeListener() {},
    };
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: {
      info: { uuid: '19219219-bf71-4c1c-9011-521e67622b70', name: 'SH192 test wallet', rdns: 'org.example.sh192', icon: 'data:image/svg+xml;base64,PHN2Zy8+' }, provider,
    } })));
  });
  return requests;
}

const png = (name: string, size: number) => ({ name, mimeType: 'image/png', buffer: Buffer.from(makePng({ width: size, height: size, decodable: true })) });
const next = (page: Page) => page.getByRole('button', { name: 'Next', exact: true }).click();

/** Basics to Overview for an open collection of ten items on the local chain source, the wallet connected. */
async function toOverview(page: Page) {
  await page.goto('/settings');
  await page.getByRole('radio', { name: /Local chain/ }).check();
  await page.goto('/create/v2-basics');
  await page.getByRole('radio', { name: /^ETH\b/ }).check();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Rent Free');
  await page.getByRole('textbox', { name: 'Ticker', exact: true }).fill('RENT');
  await page.locator('#create-logo').setInputFiles(png('logo.png', 512));
  await expect(page.locator('#create-logo-action')).toHaveText('Change');
  await next(page);
  await page.getByRole('radio', { name: /^New collection/ }).check();
  await page.getByLabel('Images + traits').setInputFiles(Array.from({ length: ITEMS }, (_, i) => png(`${i + 1}.png`, 64 + i)));
  await expect(page.getByRole('button', { name: 'Change art', exact: true })).toBeVisible();
  await page.locator('#create-collection-cover').setInputFiles(png('cover.png', 600));
  await expect(page.locator('#create-collection-cover-action')).toHaveText('Change');
  await page.getByRole('radio', { name: 'Open', exact: true }).check();
  await next(page);
  await next(page);
  await next(page);
  await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check();
  await next(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  await page.getByRole('banner').locator('.sh-wallet-button').click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: /SH192 test wallet/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

interface Kept { readonly key: string; readonly token: string; readonly creator: string; readonly specHash: string; readonly artMode: string; readonly fileName: string; readonly text: string }

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

test('Create saves the box file first (a download here), then keeps the reveal data in this browser before the wallet is asked', async ({ page }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // This browser offers no save window: the download, as Download BoxSpec gives it.
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    Object.defineProperty(navigator.storage, 'persist', { value: async () => true });
  });
  const chain = await localCreateChain(page);
  const wallet = await testWallet(page, CREATOR);
  await toOverview(page);
  const line = page.locator('[data-box-file]');
  await expect(line).toHaveText('Create first saves your box file.');
  await shot(page, info, '01-before-create');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe('rent-boxspec-v2.json');
  await expect(line).toHaveText('Download requested: rent-boxspec-v2.json');
  // The run goes on: it keeps the reveal data, then asks the wallet, which declines. Nothing is sent.
  await expect(page.locator('[data-create-error]')).toHaveText('! Declined in the wallet.', { timeout: 120_000 });
  await shot(page, info, '02-saved-then-declined');
  const sends = wallet.filter((request) => request.method === 'eth_sendTransaction');
  expect(sends).toHaveLength(1);
  // At the wallet's first transaction request, this browser already held the copy, under the predicted token.
  const keptAtSend = sends[0]?.kept as Kept[];
  expect(keptAtSend).toHaveLength(1);
  expect(keptAtSend[0]).toMatchObject({ key: `${CHAIN_ID}:${TOKEN.toLowerCase()}`, token: TOKEN.toLowerCase(), creator: CREATOR, artMode: 'open', fileName: 'rent-reveal-data-v2.json' });
  // The downloaded file and the kept copy: the same spec, and the reveal tool reads both, salts and all.
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer);
  const file = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { specHash: string; pictures: unknown[] };
  expect(file.pictures.length).toBeGreaterThanOrEqual(ITEMS + 2);
  const copy = JSON.parse(keptAtSend[0]?.text ?? '{}') as { specHash: string };
  expect(copy.specHash).toBe(file.specHash);
  expect(keptAtSend[0]?.specHash).toBe(file.specHash.toLowerCase());
  for (const read of [readOpenBoxSpec(file), readOpenBoxSpec(copy)]) {
    expect(read.list.items).toHaveLength(ITEMS);
    expect(read.list.items.every((item) => item.salt !== zeroHash)).toBe(true);
  }
  expect(readOpenBoxSpec(copy).tree.root).toBe(readOpenBoxSpec(file).tree.root);
  expect(chain.unanswered).toEqual([]);
  expect(await overflow(page), 'sideways scroll').toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

test('a silently blocked download and refused persistence send nothing and offer saving again', async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    Object.defineProperty(navigator.storage, 'persist', { value: async () => false });
    HTMLAnchorElement.prototype.click = () => undefined;
  });
  await localCreateChain(page);
  const wallet = await testWallet(page, CREATOR);
  await toOverview(page);
  const before = wallet.length;
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save box file', exact: true })).toBeVisible();
  await expect(page.locator('[data-create-error]')).toHaveText('! The reveal data could not be kept in this browser. Nothing sent. Save again.');
  expect(wallet).toHaveLength(before);
});

test('the save window where the browser has one: Create is disabled while it saves; a closed window saves nothing and sends nothing', async ({ page }, info) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    Object.defineProperty(navigator.storage, 'persist', { value: async () => false });
    const state = { asked: 0, close: true, release: null as null | (() => void), written: [] as string[], name: 'rent-free-boxspec.json' };
    Object.defineProperty(window, '__sh192Picker', { value: state });
    (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async () => {
      state.asked += 1;
      if (state.close) throw new DOMException('The user aborted a request.', 'AbortError');
      // Held until the test lets it go, so the saving state can be seen.
      await new Promise<void>((resolve) => { state.release = resolve; });
      return { name: state.name, createWritable: async () => ({ write: async (part: Blob | string) => { state.written.push(typeof part === 'string' ? part : await part.text()); }, close: async () => undefined }) };
    };
  });
  await localCreateChain(page);
  const wallet = await testWallet(page, CREATOR);
  await toOverview(page);
  const create = page.getByRole('button', { name: 'Create', exact: true });
  await create.click();
  await expect(page.locator('[data-box-file="failed"]')).toHaveText('! Not saved: the save window was closed. Nothing was sent.');
  await expect(create).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save box file', exact: true })).toBeVisible();
  await shot(page, info, '03-save-closed');
  expect(wallet.map((request) => request.method)).not.toContain('eth_sendTransaction');
  // Save box file again; the window is held open: Create disabled, "Saving your box file…".
  await page.evaluate(() => { (window as unknown as { __sh192Picker: { close: boolean } }).__sh192Picker.close = false; });
  await page.getByRole('button', { name: 'Save box file', exact: true }).click();
  await expect(page.locator('[data-box-file="saving"]')).toHaveText('Saving your box file…');
  await expect(create).toBeDisabled();
  await shot(page, info, '04-saving');
  await page.evaluate(() => (window as unknown as { __sh192Picker: { release: () => void } }).__sh192Picker.release());
  await expect(page.locator('[data-box-file="saved"]')).toHaveText('Saved: rent-free-boxspec.json');
  await expect(create).toBeEnabled();
  const written = await page.evaluate(() => (window as unknown as { __sh192Picker: { written: string[] } }).__sh192Picker.written.join(''));
  expect(readOpenBoxSpec(JSON.parse(written)).list.items).toHaveLength(ITEMS);
  const asked = await page.evaluate(() => (window as unknown as { __sh192Picker: { asked: number } }).__sh192Picker.asked);
  expect(asked).toBe(2);
  expect(wallet.map((request) => request.method)).not.toContain('eth_sendTransaction');
  // The completed file write is sufficient even though browser persistence is refused.
  await create.click();
  await expect(page.locator('[data-create-error]')).toHaveText('! Declined in the wallet.', { timeout: 120_000 });
  expect(wallet.filter((request) => request.method === 'eth_sendTransaction')).toHaveLength(1);
});

test('the box page: the creator sees this device’s reveal data with Download again; without a copy, one plain line', async ({ page }, info) => {
  const published = await publishedItems();
  const data = await mixedDeployment();
  const record = published.body.row.record as { creator: Address; specHash: Hex; contracts: readonly Address[] };
  const collection = record.contracts[4] as Address;
  const card = { ...published.body, chainId: data.manifest.chainId, row: { ...published.body.row, chainId: data.manifest.chainId, record: { ...published.body.row.record, poolManager: data.manifest.chain.poolManager.address } } };
  const rpc = m3RpcFixture({});
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (route) => route.abort());
  await page.route(`${CORE}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const answer = path === '/v1/feed' ? data.v1.feed : path === '/v2/feed' ? { ...data.feed, cards: [card] } : path.endsWith('/activity') ? { asOf: published.body.asOf, items: [], next: null } : null;
    await route.fulfill({ status: answer ? 200 : 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(answer) });
  });
  await page.route(`${RPC}/**`, async (route) => {
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const calls = route.request().postDataJSON() as (RpcCall & { id: number }) | (RpcCall & { id: number })[];
    const one = async (call: RpcCall & { id: number }) => {
      // The collection's reveal count: 1 of its 4 items revealed.
      const params = call.params as [{ to?: string; data?: Hex }] | undefined;
      if (call.method === 'eth_call' && params?.[0]?.to?.toLowerCase() === collection.toLowerCase()) {
        try {
          const { functionName } = decodeFunctionData({ abi: boxCollectionAbi, data: params[0].data ?? '0x' });
          if (functionName === 'revealedCount') return { jsonrpc: '2.0', id: call.id, result: encodeFunctionResult({ abi: boxCollectionAbi, functionName, result: 1n }) };
          if (functionName === 'collectionSize') return { jsonrpc: '2.0', id: call.id, result: encodeFunctionResult({ abi: boxCollectionAbi, functionName, result: 4n }) };
        } catch { /* another collection read */ }
      }
      try { return { jsonrpc: '2.0', id: call.id, result: call.method === 'eth_chainId' ? toHex(data.manifest.chainId) : await rpc.request(call) }; }
      catch (error) { return { jsonrpc: '2.0', id: call.id, error: { code: (error as { code?: number }).code ?? -32601, message: (error as Error).message } }; }
    };
    await route.fulfill({ headers, contentType: 'application/json', body: JSON.stringify(Array.isArray(calls) ? await Promise.all(calls.map(one)) : await one(calls)) });
  });
  await testWallet(page, record.creator);
  await page.goto('/settings');
  await page.getByRole('radio', { name: /Local chain/ }).check();
  const box = `/box/${data.manifest.chainId}/${published.body.token.toLowerCase()}`;
  await page.goto(box);
  await page.getByRole('banner').locator('.sh-wallet-button').click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: /SH192 test wallet/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // No copy on this device yet: the creator is told plainly.
  const panel = page.getByRole('region', { name: 'Reveal data' });
  await expect(panel.getByText('3/4 not revealed')).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByRole('alert')).toHaveText('No copy of this box’s reveal data on this device. Keep the box file you saved at Create: without it, unrevealed items cannot be opened.');
  await panel.scrollIntoViewIfNeeded();
  await shot(page, info, '05-box-page-no-copy');
  // The copy Create keeps (as reveal-keep.ts writes it), then the page again.
  const text = '{"format":"squarehole.boxspec/2"}\n';
  await page.evaluate(async (copy) => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('sh.reveal.keep.v1', 1);
      open.onupgradeneeded = () => { open.result.createObjectStore('boxes', { keyPath: 'key' }); };
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction('boxes', 'readwrite');
        tx.objectStore('boxes').put(copy);
        tx.oncomplete = () => { open.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, { format: 'squarehole.reveal-keep/1', key: `${data.manifest.chainId}:${published.body.token.toLowerCase()}`, chainId: data.manifest.chainId, token: published.body.token.toLowerCase(),
    creator: record.creator, specHash: record.specHash.toLowerCase(), revealRoot: `0x${'11'.repeat(32)}`, artMode: 'open', n: 4, fileName: 'm3-reveal-data-v2.json', text, savedAt: 1 });
  await page.reload();
  await expect(panel.getByText('Reveal data saved on this device.')).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByText('3/4 not revealed')).toBeVisible();
  await panel.scrollIntoViewIfNeeded();
  await shot(page, info, '06-box-page-saved');
  const [again] = await Promise.all([page.waitForEvent('download'), panel.getByRole('button', { name: 'Download again', exact: true }).click()]);
  expect(again.suggestedFilename()).toBe('m3-reveal-data-v2.json');
  const chunks: Buffer[] = [];
  for await (const chunk of await again.createReadStream()) chunks.push(chunk as Buffer);
  expect(Buffer.concat(chunks).toString('utf8')).toBe(text);
  expect(await overflow(page), 'sideways scroll').toBeLessThanOrEqual(0);
});
