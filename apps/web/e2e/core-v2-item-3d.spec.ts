import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page, type Request, type TestInfo } from '@playwright/test';
import { decodeFunctionData, encodeFunctionResult, toFunctionSelector, toHex, type Abi, type AbiFunction, type Address, type Hex } from 'viem';
import { boxCollectionAbi } from '@squarehole/chain/abi';
import { rawCidV1 } from '../../../packages/artwork/src/misfits-commitment';
import { rolesOfV2, vaultV2Abi } from '../../../packages/chain/src/core/v2';
import { installUntouchableWallet, overflow, walletTouches } from './box-helpers';
import { mixedDeployment } from '../src/features/core/v2/test-support/mixed-deployment';
import { ETH, publishedItems } from '../src/features/core/v2/test-support/m3-published';
import { m3RpcFixture } from '../src/features/core/v2/test-support/m3-rpc';
import { bagHoldersItem, rentFreeItem, threeDFixtureItem, type ItemArtFixture } from '../src/features/core/v2/test-support/item-models';
import type { RpcCall } from '../src/features/core/v2/test-support/m2-rpc';
import { ITEM_NOT_REVEALED } from '../src/features/core/v2/reveal-words';

// T06 (View 3D on v2 items): a v2 box's items panel on synthetic reads (the M3-52 publication, a JSON-RPC double for the
// vault and the collection, and the local art gateway the browser suite's build names, 127.0.0.1:8595, answered here),
// through the real page, viewer, loader and three.js on the browser's WebGL. Five items on the shelf: 1 a Rent Free house
// and 2 a Bag Holders bag (the kits' real pictures and GLBs), 3 an item of Create's 3D fixture (T01: a placeholder model
// without geometry), 4 a 2D item (zero model hash), 5 not revealed. Desktop at 1440×900 and a phone at 375 px.
// SH_EVIDENCE_SCREENSHOTS=1 writes the pictures to docs/evidence/SH-ITEM-3D-V2/<name>-<project>.png.
const CORE = 'http://127.0.0.1:8596';
const RPC = 'http://127.0.0.1:8599';
const GATEWAY = 'http://127.0.0.1:8595';
const ZERO = `0x${'0'.repeat(64)}` as Hex;
/** The lazy chunks of the 3D viewer: three.js and its loader and controls (Vite names each after its module). */
const THREE_CHUNK = /\/assets\/(?:three[\w.]*|GLTFLoader|OrbitControls|deps)-[\w-]+\.js$/;

async function shot(target: Page | Locator, info: TestInfo, name: string) {
  const path = process.env.SH_EVIDENCE_SCREENSHOTS === '1'
    ? fileURLToPath(new URL(`../../../docs/evidence/SH-ITEM-3D-V2/${name}-${info.project.name}.png`, import.meta.url)) : info.outputPath(`${name}.png`);
  if ('goto' in target) await target.screenshot({ path, fullPage: false, scale: 'css' });
  else await target.screenshot({ path, scale: 'css' });
}

interface Shelf { readonly revealed: boolean; readonly art: ItemArtFixture | null; readonly model: boolean }
const rent = rentFreeItem();
const bags = bagHoldersItem();
const placeholder = threeDFixtureItem(1);
const flat = threeDFixtureItem(2);
const SHELF: Readonly<Record<string, Shelf>> = {
  '1': { revealed: true, art: rent, model: true },
  '2': { revealed: true, art: bags, model: true },
  '3': { revealed: true, art: placeholder, model: true },
  '4': { revealed: true, art: flat, model: false },
  '5': { revealed: false, art: null, model: false },
};

const ABI = [...vaultV2Abi, ...boxCollectionAbi] as Abi;
const OWN = ABI.filter((item): item is AbiFunction => item.type === 'function');

async function fixture(page: Page) {
  const data = await mixedDeployment();
  const known = Object.fromEntries(Object.keys(SHELF).map((id, i) => [id, { inside: true, sequence: BigInt(i + 1) }]));
  const published = await publishedItems({ n: Object.keys(SHELF).length, known });
  const body = { ...published.body, chainId: data.manifest.chainId, gate: { ...(published.body.gate as Record<string, unknown>), open: true },
    row: { ...published.body.row, chainId: data.manifest.chainId, record: { ...published.body.row.record, poolManager: data.manifest.chain.poolManager.address } } };
  const vault = rolesOfV2(body.row.record as never).contracts.vault as Address;
  const m3 = m3RpcFixture({ vault });
  // The vault and the collection as the items panel reads them; any other read goes to the M3 double.
  const own: Record<string, (args: readonly unknown[]) => unknown> = {
    inside: () => 5n, pickFeeBps: () => 100n, returnFeeBps: () => 100n, quoteWithdraw: () => 300n * ETH, quoteReturn: () => 290n * ETH,
    isOnShelf: () => true, isOutside: () => false, ownerOf: () => vault,
    traitsOf: ([id]) => {
      const item = SHELF[String(id)];
      return item?.revealed && item.art ? [true, 1n, item.art.pictureSha256, item.model ? item.art.modelSha256 : ZERO] : [false, 0n, ZERO, ZERO];
    },
  };
  // The local art gateway: each committed file by its raw CID, as our node serves it.
  const files = new Map<string, { bytes: Uint8Array; type: string; kind: 'picture' | 'model'; id: string }>();
  for (const [id, item] of Object.entries(SHELF)) {
    if (!item.art) continue;
    files.set(rawCidV1(item.art.pictureSha256), { bytes: item.art.picture, type: 'image/png', kind: 'picture', id });
    if (item.model) files.set(rawCidV1(item.art.modelSha256), { bytes: item.art.model, type: 'model/gltf-binary', kind: 'model', id });
  }
  // The box's own logo and cover are pictures too (the header asks for them by their committed hashes).
  const spec = published.row.spec as { coverSha256: Hex; collectionCoverSha256: Hex };
  const boxPictures = new Set([spec.coverSha256, spec.collectionCoverSha256].filter((hash) => hash !== ZERO).map((hash) => rawCidV1(hash)));
  const asked: { kind: 'picture' | 'model' | 'box' | 'unknown'; id: string | null; at: number }[] = [];
  const chunks: string[] = [];
  page.on('request', (request: Request) => { if (THREE_CHUNK.test(new URL(request.url()).pathname)) chunks.push(request.url()); });
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
    try {
      if (call.method === 'eth_chainId') answer = { result: toHex(data.manifest.chainId) };
      // SH-235: the Items card names its item reads by the chain's head; the head is the published card's block.
      else if (call.method === 'eth_blockNumber') answer = { result: toHex(BigInt(body.asOf.block)) };
      else {
        const tx = call.method === 'eth_call' ? call.params?.[0] as { data: Hex } : null;
        const fn = tx ? OWN.find((f) => toFunctionSelector(f) === tx.data.slice(0, 10) && own[f.name]) : undefined;
        if (tx && fn) {
          const { args = [] } = decodeFunctionData({ abi: [fn], data: tx.data });
          answer = { result: encodeFunctionResult({ abi: [fn], functionName: fn.name, result: (own[fn.name] as (a: readonly unknown[]) => unknown)(args) as never }) };
        } else answer = { result: await m3.request(call) };
      }
    } catch (error) { answer = { error: { code: (error as { code?: number }).code ?? -32601, message: (error as Error).message } }; }
    await route.fulfill({ headers, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: call.id, ...answer }) });
  });
  await page.route(`${GATEWAY}/**`, async (route) => {
    const cid = new URL(route.request().url()).pathname.replace(/^\/ipfs\//, '');
    const file = files.get(cid);
    asked.push({ kind: file?.kind ?? (boxPictures.has(cid) ? 'box' : 'unknown'), id: file?.id ?? null, at: Date.now() });
    if (!file) return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' } });
    await route.fulfill({ status: 200, contentType: file.type, headers: { 'access-control-allow-origin': '*', 'content-length': String(file.bytes.length) }, body: Buffer.from(file.bytes) });
  });
  await page.goto('/settings');
  await page.getByRole('radio', { name: /Local chain/ }).check();
  await page.goto(`/box/${data.manifest.chainId}/${body.token.toLowerCase()}`);
  const panel = page.getByRole('region', { name: 'Items in the vault' });
  await expect(panel).toBeVisible();
  const shelf = panel.getByRole('list', { name: 'In the vault' });
  for (const id of ['1', '2', '3', '4']) await expect(shelf.getByRole('img', { name: `Item #${id}`, exact: true })).toBeVisible();
  await expect(shelf.getByRole('img', { name: 'Item #5, not revealed' })).toBeVisible();
  // SH-203 on the line: the unrevealed item says why its Take out is off, on its tile and as the button's description;
  // the revealed ones say nothing. A visitor (no wallet here) gets no Reveal items entry.
  const unrevealed = shelf.getByRole('listitem').filter({ has: page.getByRole('img', { name: 'Item #5, not revealed' }) });
  await expect(unrevealed.getByText(ITEM_NOT_REVEALED, { exact: true })).toBeVisible();
  await expect(unrevealed.getByRole('button', { name: 'Take out item 5' })).toBeDisabled();
  await expect(unrevealed.getByRole('button', { name: 'Take out item 5' })).toHaveAccessibleDescription(ITEM_NOT_REVEALED);
  await expect(shelf.getByText(ITEM_NOT_REVEALED, { exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Reveal items' })).toHaveCount(0);
  return { panel, shelf, asked, chunks };
}

const sheetOf = (page: Page, id: number) => page.getByRole('dialog', { name: `Item #${id}` });
/** Canvases on the page outside the box's price chart (SH-BOX-CANDLES draws on its own): the 3D viewer's. */
const modelCanvases = (page: Page) => page.locator('canvas').evaluateAll((list) => list.filter((canvas) => !canvas.closest('.sh-candles')).length);
/** The drawn view: a widget named as a 3D model (an image until drawn). */
const viewOf = (page: Page, id: number) => sheetOf(page, id).getByRole('application', { name: `3D model of item #${id}` });

/** Pixels of the drawn view, to tell a turned model from a still one. */
const pixels = async (view: Locator): Promise<Buffer> => view.screenshot({ scale: 'css' });

/** A one-finger drag across the view (a phone): Chromium's touch input, as a finger would. */
async function touchDrag(page: Page, view: Locator) {
  const box = await view.boundingBox();
  if (!box) throw new Error('no view');
  const cdp = await page.context().newCDPSession(page);
  const y = box.y + box.height / 2; const x0 = box.x + box.width * 0.3; const x1 = box.x + box.width * 0.75;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] });
  for (let i = 1; i <= 8; i += 1) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + ((x1 - x0) * i) / 8, y: y + i * 2 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

async function mouseDrag(page: Page, view: Locator) {
  const box = await view.boundingBox();
  if (!box) throw new Error('no view');
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.3, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, y + 12, { steps: 8 });
  await page.mouse.up();
}

test.describe('T06 View 3D on a v2 box’s items', () => {
  test.beforeEach(async ({ page }, info) => {
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 375, height: 812 });
  });

  test('T06: the picture first; 3D only on a press, only for revealed items with a model; the model turns by drag, touch and the arrow keys; Close disposes it', async ({ page }, info) => {
    test.setTimeout(120_000);
    const phone = info.project.name === 'mobile';
    const { shelf, asked, chunks } = await fixture(page);
    // Navigation asked for pictures only: no model, nothing for the unrevealed item, no three.js.
    await expect(shelf.getByRole('button', { name: 'View 3D model of item 1' })).toHaveText('3D');
    await expect(shelf.getByRole('button', { name: 'View 3D model of item 2' })).toBeVisible();
    await expect(shelf.getByRole('button', { name: 'View 3D model of item 3' })).toBeVisible();
    await expect(shelf.getByRole('button', { name: /^View 3D model of item [45]$/ })).toHaveCount(0);
    await expect.poll(() => asked.filter((a) => a.kind === 'picture').length).toBe(4);
    expect(asked.filter((a) => a.kind !== 'picture' && a.kind !== 'box')).toEqual([]);
    expect(asked.some((a) => a.id === '5')).toBe(false);
    expect(chunks).toEqual([]);
    expect(await modelCanvases(page)).toBe(0);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await shot(page.getByRole('region', { name: 'Items in the vault' }), info, 'items-3d-buttons');

    // Rent Free's house, opened with the keyboard: Enter on its 3D button.
    const open = shelf.getByRole('button', { name: 'View 3D model of item 1' });
    await open.focus();
    await page.keyboard.press('Enter');
    const sheet = sheetOf(page, 1);
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('.sh-vault-model')).toHaveAttribute('data-model', 'shown', { timeout: 15_000 });
    expect(asked.filter((a) => a.kind === 'model').map((a) => a.id)).toEqual(['1']);
    expect(chunks.length).toBeGreaterThan(0);
    const view = viewOf(page, 1);
    await expect(view).toHaveAttribute('aria-roledescription', '3D model');
    await expect(view.locator('canvas')).toHaveCount(1);
    await expect(sheet.getByRole('img', { name: 'Item #1', exact: true })).toHaveCount(0);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await shot(page, info, 'rent-free-3d');

    // With the keyboard: the sheet's heading has focus; Tab reaches Close, then the view; the arrow keys turn the model.
    await expect(sheet.getByRole('heading', { name: 'Item #1' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(sheet.getByRole('button', { name: 'Close' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(view).toBeFocused();
    const still = await pixels(view);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowUp');
    await expect.poll(async () => (await pixels(view)).equals(still)).toBe(false);
    await expect(view).toBeFocused();
    await shot(page, info, 'rent-free-3d-keys-turned');
    // By touch on the phone, by a drag on the desktop.
    const before = await pixels(view);
    if (phone) await touchDrag(page, view); else await mouseDrag(page, view);
    await expect.poll(async () => (await pixels(view)).equals(before)).toBe(false);
    await shot(page, info, phone ? 'rent-free-3d-touch-turned' : 'rent-free-3d-drag-turned');
    await view.focus();

    // Escape closes: the view and its canvas are gone, focus is back on the 3D button.
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    expect(await modelCanvases(page)).toBe(0);
    await expect(open).toBeFocused();

    // Bag Holders' bag, by a click (or a tap): drawn the same way; Close.
    await shelf.getByRole('button', { name: 'View 3D model of item 2' }).click();
    await expect(sheetOf(page, 2).locator('.sh-vault-model')).toHaveAttribute('data-model', 'shown', { timeout: 15_000 });
    await expect(viewOf(page, 2).locator('canvas')).toHaveCount(1);
    await shot(page, info, 'bag-holders-3d');
    await sheetOf(page, 2).getByRole('button', { name: 'Close' }).click();
    await expect(sheetOf(page, 2)).toHaveCount(0);
    expect(await modelCanvases(page)).toBe(0);

    // Create's 3D fixture (T01): its model passes the hash check but has nothing to draw, so its picture stays.
    await shelf.getByRole('button', { name: 'View 3D model of item 3' }).click();
    const failed = sheetOf(page, 3);
    await expect(failed.getByRole('status')).toHaveText('3D unavailable', { timeout: 15_000 });
    await expect(failed.locator('.sh-vault-model')).toHaveAttribute('data-model', 'failed');
    await expect(failed.getByRole('img', { name: 'Item #3', exact: true })).toBeVisible();
    await shot(page, info, 'fixture-3d-unavailable');
    await page.keyboard.press('Escape');
    await expect(failed).toHaveCount(0);

    // Never a model for the 2D or the unrevealed item; never a wallet request.
    expect(asked.filter((a) => a.kind === 'model').map((a) => a.id)).toEqual(['1', '2', '3']);
    expect(asked.filter((a) => a.kind === 'unknown')).toEqual([]);
    expect(asked.some((a) => a.id === '4' && a.kind !== 'picture') || asked.some((a) => a.id === '5')).toBe(false);
    expect(await walletTouches(page)).toEqual([]);
  });
});
