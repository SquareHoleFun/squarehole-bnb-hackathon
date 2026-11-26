import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { verifyEthDataItem } from '../src/lib/pictures/ans104-eth';
import { injectTestWallet } from './test-wallet';

// SH-294: a launch WITH a picture on each rail, on a local fork of BSC Testnet as it is (the real factories and Core;
// Core's signer set to anvil's public development key on the fork only, with a signer stand-in in the dev server). The
// picture goes to a stand-in for Turbo and is read back from stand-ins for the two raw gateways (never Arweave from a
// test); the withheld list is the site's own path, answered empty. Shots: the create screen (both ways, the Visual
// coin), the launch's page and the home row, at 1440 and 390. Run only when PICTURE_FORK is set.
const here = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.PILE_RPC ?? 'http://127.0.0.1:8581';
const SHOTS = process.env.PILE_SHOTS ?? path.join(here, '../../../hackathon/evidence/SH-294');
const STORE = process.env.PICTURE_STORE ?? path.join(SHOTS, 'stand-in-items.json');
const Q = '?addresses=local/addresses.json';

test.describe.configure({ mode: 'serial' });
test.skip(!process.env.PICTURE_FORK, 'needs the fork run (PICTURE_FORK)');

/** A 256 px PNG with a pattern (a real picture to shrink, drawn by the browser). */
function picturePng(seed: number): Buffer {
  const w = 256; const h = 256;
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * (w * 3 + 1) + 1 + x * 3; const d = Math.hypot(x - 128, y - 128);
    raw[o] = (x * seed) & 255; raw[o + 1] = d < 90 ? 230 : (y * 2) & 255; raw[o + 2] = d < 60 ? 40 : 200;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** The stand-ins: Turbo (its free size, an upload that keeps the item's payload by its own id), the raw gateways, the list. */
const items = new Map<string, Buffer>();
async function standIns(page: Page) {
  await page.route('https://upload.ardrive.io/**', async (route) => {
    const url = route.request().url();
    if (url.endsWith('/info')) return route.fulfill({ json: { freeUploadLimitBytes: 107_520 } });
    const body = route.request().postDataBuffer();
    const item = body ? await verifyEthDataItem(new Uint8Array(body)) : null;
    if (!item?.valid) return route.fulfill({ status: 400, body: 'bad item' });
    items.set(item.id, Buffer.from(item.data));
    fs.mkdirSync(path.dirname(STORE), { recursive: true });
    fs.writeFileSync(STORE, JSON.stringify(Object.fromEntries([...items].map(([id, b]) => [id, b.toString('base64')]))));
    return route.fulfill({ json: { id: item.id } });
  });
  for (const gateway of ['https://turbo-gateway.com', 'https://arweave.net']) {
    await page.route(`${gateway}/raw/*`, (route) => {
      const bytes = items.get(route.request().url().split('/raw/')[1] ?? '');
      return bytes ? route.fulfill({ status: 200, body: bytes, contentType: 'application/octet-stream' }) : route.fulfill({ status: 404, body: '' });
    });
  }
  await page.route('**/v2/withheld', (route) => route.fulfill({ json: { version: 1, hashes: [] } }));
}

async function shot(page: Page, name: string, full = true) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: full });
}
async function addPicture(page: Page, seed: number) {
  await page.getByTestId('picture-input').first().setInputFiles({ name: 'picture.png', mimeType: 'image/png', buffer: picturePng(seed) });
  await expect(page.locator('.picture-field__thumb').first()).toBeVisible({ timeout: 30_000 });
}
async function both(page: Page, name: string, check: () => Promise<void>) {
  for (const [w, h] of [[1440, 900], [390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await check();
    await shot(page, `${name}-${w}`);
  }
}

test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByTestId('press-close'), (close) => close.click());
  await standIns(page);
});

test('Flap: a sale with a picture: the field, the Visual coin, the sale page, the home row', async ({ page }) => {
  await injectTestWallet(page, RPC, 1);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${Q}#/flap/create`);
  await page.getByTestId('connect').click();
  await page.getByTestId('way-steps').click();
  if (await page.getByTestId('quote-choice').waitFor({ timeout: 10_000 }).then(() => true, () => false)) await page.getByTestId('quote-native').click();
  await page.getByTestId('create-name').fill('Picture Curve');
  await page.getByTestId('create-symbol').fill('PICT');
  await addPicture(page, 3);
  await shot(page, 'flap-create-steps-1440');
  await page.getByTestId('way-visual').click();
  await expect(page.locator('[data-coin-picture]')).toBeVisible({ timeout: 30_000 });
  await both(page, 'flap-create-visual', async () => { await expect(page.locator('[data-coin-picture]')).toBeVisible(); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId('way-steps').click();
  await expect(page.locator('.picture-field__thumb').first()).toBeVisible();
  await expect(page.getByTestId('create-review')).toBeVisible({ timeout: 90_000 });
  await page.getByTestId('create').click();
  await expect(page).toHaveURL(/#\/flap\/0x[0-9a-fA-F]{40}$/, { timeout: 120_000 });
  await both(page, 'flap-sale', async () => { await expect(page.locator('h1 [data-launch-picture]')).toBeVisible({ timeout: 60_000 }); });
  await page.goto(`/${Q}#/flap`);
  await both(page, 'flap-home', async () => {
    await expect(page.getByTestId('sale-line').filter({ hasText: 'Picture Curve' }).locator('[data-launch-picture]')).toBeVisible({ timeout: 90_000 });
  });
});

test('Four.meme: a token with a picture: the field, the token page, the home row', async ({ page }) => {
  await injectTestWallet(page, RPC, 2);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${Q}#/four/create`);
  await page.getByTestId('connect').click();
  await page.getByTestId('way-steps').click();
  await page.getByTestId('four-name').fill('Picture Four');
  await page.getByTestId('four-symbol').fill('PICF');
  await page.getByTestId('four-buy').fill('2');
  await page.getByTestId('four-sell').fill('1');
  await addPicture(page, 7);
  await shot(page, 'four-create-steps-1440');
  await page.getByTestId('way-visual').click();
  await both(page, 'four-create-visual', async () => { await expect(page.locator('[data-coin-picture]')).toBeVisible({ timeout: 30_000 }); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId('way-steps').click();
  await page.getByTestId('four-create-btn').first().click();
  await expect(page).toHaveURL(/#\/four\/0x[0-9a-fA-F]{40}$/, { timeout: 120_000 });
  await both(page, 'four-token', async () => { await expect(page.locator('h1 [data-launch-picture]')).toBeVisible({ timeout: 90_000 }); });
  await page.goto(`/${Q}#/four`);
  await both(page, 'four-home', async () => {
    await expect(page.getByTestId('four-line').filter({ hasText: 'Picture Four' }).locator('[data-launch-picture]')).toBeVisible({ timeout: 90_000 });
  });
});
