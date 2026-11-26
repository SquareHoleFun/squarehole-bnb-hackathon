// SH-ARWEAVE-PICTURES-WEB: the real flow once, in a browser, against the local core-v2 chain stack, with ONE REAL
// Arweave upload (Turbo's free tier: public and permanent). Skipped unless SH_ARWEAVE_LIVE=1; only its own config
// (playwright.config.mjs here) matches this file, and that config starts the stack with SH_ARWEAVE_PICTURES=1.
//
// The page creates a token box whose logo is a generated abstract picture (an 8x8 grid of random colours, no text).
// The page shrinks the logo to Turbo's free tier as it reads it; Create's press publishes it through Turbo (no wallet
// prompt) before the wallet is asked for anything, so the real copy is on Arweave before createBox makes its hash public
// (fix round 1), and the box page then draws it from Arweave (a blob: URL whose sha256 is the one committed).
// The browser is never allowed to reach the stack's local art gateway, so the picture shown came from Arweave.
// Until sh-042-no-picture-gate merges, the local indexer lists a box only once its logo answers on the stack's art
// gateway, so its catalogue is fed the bytes read back from Arweave (as the indexer's own Arweave lookup will).
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { ROOT, localOptions } from '../../../../../packages/chain/scripts/lib/core-v2-local-runtime.mjs';
import { writeExampleArt } from '../../../../../packages/chain/scripts/lib/core-v2-local-example-art.mjs';
import { boxPath, description, read, testWallet } from '../helpers.mjs';

const LIVE = process.env.SH_ARWEAVE_LIVE === '1';
const OUT = join(ROOT, '.cache/core-v2-arweave');
const CREATED_ART = join(ROOT, '.cache/core-v2-local/run/created-art');
const PICTURE_HOSTS = ['https://upload.ardrive.io', 'https://turbo-gateway.com', 'https://arweave.net', 'https://goldsky.arweave.net'];
const sha256 = (bytes) => `0x${createHash('sha256').update(bytes).digest('hex')}`;

/** An abstract test picture: an 8x8 grid of random colours, PNG, 256 px (the logo's minimum side). */
function gridPng(side = 256, cells = 8) {
  const crc = (bytes) => { let c = 0xffffffff; for (const b of bytes) { c ^= b; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8); out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length); return out; };
  const colours = randomBytes(cells * cells * 3);
  const raw = Buffer.alloc((1 + side * 3) * side);
  for (let y = 0; y < side; y += 1) for (let x = 0; x < side; x += 1) {
    const c = (Math.floor((y * cells) / side) * cells + Math.floor((x * cells) / side)) * 3;
    colours.copy(raw, y * (1 + side * 3) + 1 + x * 3, c, c + 3);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(side, 0); ihdr.writeUInt32BE(side, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

test('Create publishes the logo to Arweave before the wallet creates the box (one real upload); the box page shows it from Arweave', async ({ page }) => {
  test.skip(!LIVE, 'opt-in: a real, permanent Arweave upload (SH_ARWEAVE_LIVE=1)');
  const log = { started: new Date().toISOString(), events: [] };
  const note = (name, data = {}) => { log.events.push({ at: new Date().toISOString(), name, ...data }); mkdirSync(OUT, { recursive: true }); writeFileSync(join(OUT, 'browser-run.json'), `${JSON.stringify(log, null, 2)}\n`); };
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
  const chain = description();
  const ports = localOptions();
  const wallet = await testWallet(page, chain, { create: true });
  const registry = await read(chain, 'BoxFactoryV2', chain.factory, 'registry');
  const before = await read(chain, 'BoxRegistryV2', registry, 'boxCount');

  // testWallet refuses every public host; the four picture hosts (the CSP's connect-src additions) go out. Reading the
  // logo asks Turbo's free size (GET /info); Create's press then searches for the logo by its fingerprint and uploads
  // it while the box does not exist yet, and the wallet is asked to send only after Turbo's answer.
  const external = [];
  page.on('request', (r) => { const u = new URL(r.url()); if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') external.push({ method: r.method(), url: r.url() }); });
  const firstPictureRequest = [];
  const uploadRequest = [];
  await page.route(/^https:\/\/(?:turbo-gateway\.com|arweave\.net|goldsky\.arweave\.net|upload\.ardrive\.io)\//, async (route) => {
    const url = new URL(route.request().url());
    if (firstPictureRequest.length === 0 && url.pathname !== '/info') firstPictureRequest.push({ url: url.href, boxCount: await read(chain, 'BoxRegistryV2', registry, 'boxCount') });
    if (url.pathname === '/v1/tx') uploadRequest.push({ boxCount: await read(chain, 'BoxRegistryV2', registry, 'boxCount') });
    return route.continue();
  });
  const uploads = [];
  page.on('response', async (r) => {
    if (!r.url().startsWith('https://upload.ardrive.io/v1/tx')) return;
    // Counted as the answer arrives, before the page has read it.
    const sendsBefore = wallet.requests.filter((method) => method === 'eth_sendTransaction').length;
    const body = await r.json().catch(() => ({}));
    uploads.push({ status: r.status(), id: body.id, winc: body.winc ?? null, sendsBefore });
    note('upload-answer', { status: r.status(), id: body.id, winc: body.winc ?? null, sendsBefore });
  });
  const localArt = [];
  await page.route(`http://127.0.0.1:${ports.artPort}/**`, (route) => { localArt.push(route.request().url()); return route.abort(); });

  const logo = gridPng();
  const next = () => page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.goto('/create/v2-basics');
  await page.getByRole('group', { name: /^Priced in/ }).getByRole('radio', { name: /^ETH\b/ }).check();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Grid Live');
  await page.getByRole('textbox', { name: 'Ticker' }).fill('GRIDL');
  await page.locator('#create-logo').setInputFiles({ name: 'grid.png', mimeType: 'image/png', buffer: logo });
  await expect(page.locator('#create-logo-action')).toHaveText('Change');
  await next(); await page.getByRole('radio', { name: /^Token/ }).check();
  await next(); await next(); await next();
  await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check(); await next();
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  await expect(page.locator('[data-arweave-note]')).toHaveText('Logo and cover go on Arweave: public and permanent.');
  const committed = await page.evaluate(async () => {
    const { currentDraft } = await import('/src/features/create/draft.ts');
    const cover = currentDraft().cover;
    return { sha256: cover?.sha256 ?? null, bytes: cover?.bytes ?? null };
  });
  note('committed', committed);
  expect(committed.bytes).toBeLessThanOrEqual(107_520);
  expect(wallet.requests, 'navigation never asks the wallet').toEqual([]);
  // Reading the logo asked Turbo's free size (GET /info); nothing was uploaded or searched before Create.
  expect(external.filter((r) => PICTURE_HOSTS.includes(new URL(r.url).origin)).map((r) => `${r.method} ${r.url}`)).toEqual(['GET https://upload.ardrive.io/info']);

  await page.getByRole('button', { name: 'Connect to create' }).click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: 'Local v2 test wallet' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const pictures = page.locator('[data-pictures-status]');
  await expect(pictures).toHaveText('Pictures published · 1/1', { timeout: 180_000 });
  await expect(page.locator('[data-create-status]')).toHaveText(/^Created · /, { timeout: 180_000 });
  note('published', { firstPictureRequest: firstPictureRequest[0]?.url, boxCount: String(firstPictureRequest[0]?.boxCount), uploadBoxCount: String(uploadRequest[0]?.boxCount), before: String(before) });
  expect(firstPictureRequest[0]?.boxCount, 'the logo is searched for before the box exists').toBe(before);
  expect(uploadRequest.map((u) => u.boxCount), 'the logo is uploaded once, before the box exists').toEqual([before]);
  expect(uploads.map((u) => [u.status, u.winc, u.sendsBefore]), 'Turbo answered before the wallet was asked to send anything').toEqual([[200, '0', 0]]);
  const coordinator = await read(chain, 'BoxRegistryV2', registry, 'coordinatorOf', [before]);
  const token = await read(chain, 'BoxCoordinatorV2', coordinator, 'token');

  // Read it back from Arweave (Node side) and hand the local indexer's catalogue those bytes (see above).
  const back = await fetch(`https://turbo-gateway.com/raw/${uploads[0]?.id}`);
  const bytes = Buffer.from(await back.arrayBuffer());
  expect(sha256(bytes)).toBe(committed.sha256);
  writeExampleArt(CREATED_ART, 'gridl', [{ role: 'logo', sha256: committed.sha256, bytes }]);

  await page.getByRole('link', { name: 'Open your box' }).click();
  await expect(page).toHaveURL(new RegExp(`${boxPath(chain, token)}$`));
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Grid Live', { timeout: 5_000 });
  }).toPass({ timeout: 120_000 });
  const cover = 'header.sh-bpic-head .sh-box-cover[data-art="image"] img';
  await expect(page.locator(cover)).toBeVisible({ timeout: 60_000 });
  const shown = await page.evaluate(async (css) => {
    const src = document.querySelector(css)?.getAttribute('src') ?? '';
    const b = await (await fetch(src)).arrayBuffer();
    return { src: src.slice(0, 5), sha256: `0x${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b)), (x) => x.toString(16).padStart(2, '0')).join('')}` };
  }, cover);
  note('box-page', shown);
  expect(shown).toEqual({ src: 'blob:', sha256: committed.sha256 });
  mkdirSync(join(OUT, 'shots'), { recursive: true });
  await page.screenshot({ path: join(OUT, 'shots', 'box-page-from-arweave.png'), fullPage: true });
  const hosts = [...new Set(external.map((r) => new URL(r.url).origin))].sort();
  note('external', { hosts, localArtRefused: localArt.length });
  // Only the picture hosts were reached, and the upload origin only for /info and the one item.
  expect(hosts.filter((h) => /ardrive|arweave|turbo/.test(h)).every((h) => PICTURE_HOSTS.includes(h))).toBe(true);
  expect(external.filter((r) => r.url.startsWith('https://upload.ardrive.io')).map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(['GET /info', 'POST /v1/tx']);
});
