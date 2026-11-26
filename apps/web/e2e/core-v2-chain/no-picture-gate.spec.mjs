// SH-NO-PICTURE-GATE (founder 2026-10-24, answer 1): a box made through the page whose logo is on no picture gateway is
// listed at once, on the feed and on its own page, with the plain placeholder (no words, no badge). A gateway answering
// other bytes for the logo's CID changes nothing: those bytes never show. Once the right bytes are published (here on
// the stack's own art gateway), the logo shows, checked against its hash. Runs after create-v2-send and hidden-art-draw
// (the core-v2-* specs count the nine example boxes first). Before this change the stack's indexer kept such a box off
// the site ("art not available") until its logo was served.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { makePng } from '../../../../packages/artwork/src/test-support/images.ts';
import { rawCidV1 } from '../../../../packages/artwork/src/misfits-commitment.ts';
import { ROOT } from '../../../../packages/chain/scripts/lib/core-v2-local-runtime.mjs';
import { sha256Hex, writeExampleArt } from '../../../../packages/chain/scripts/lib/core-v2-local-example-art.mjs';
import { TERMS_ACCEPTED } from '../terms-state.ts';
import { boxPath, decoded, description, read, testWallet } from './helpers.mjs';

test.describe.configure({ mode: 'serial' });
const SHOTS = join(ROOT, '.cache/core-v2-local/no-picture-gate');
// The stack's catalogue for pictures a page-created box commits (scripts/dev-core-v2-local.mjs, --e2e).
const CREATED_ART = join(ROOT, '.cache/core-v2-local/run/created-art');
const shot = async (page, name) => { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

/** The box picture in `scope` is the plain tile: no image, no text of its own. */
async function plainTile(scope) {
  const cover = scope.locator('.sh-box-cover').first();
  await expect(cover).toHaveAttribute('data-art', 'plain');
  await expect(cover.locator('img')).toHaveCount(0);
  await expect(cover).toHaveText('');
}

test('NO-PICTURE-GATE: a box whose logo is not stored is listed at once with a plain placeholder; other bytes never show', async ({ page, browser }) => {
  test.setTimeout(300_000);
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
  const chain = description();
  const wallet = await testWallet(page, chain, { create: true });
  await page.setViewportSize(DESKTOP);

  // ── Create through the page: a token priced in ETH, its logo not published on the stack's art gateway ──
  await page.goto('/create/v2-basics');
  await page.getByRole('group', { name: /^Priced in/ }).getByRole('radio', { name: /^ETH\b/ }).check();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Plain Tile');
  await page.getByRole('textbox', { name: 'Ticker' }).fill('PLAIN');
  // A size no other spec uses, so the processed logo is one no earlier spec has stored (checked below: every answer 404).
  await page.locator('#create-logo').setInputFiles({ name: 'plain.png', mimeType: 'image/png', buffer: Buffer.from(makePng({ width: 704, height: 704, decodable: true })) });
  await expect(page.locator('#create-logo-action')).toHaveText('Change');
  const next = () => page.getByRole('button', { name: 'Next', exact: true }).click();
  await next(); await page.getByRole('radio', { name: /^Token/ }).check();
  await next(); await next(); await next();
  await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check(); await next();
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  expect(wallet.requests, 'navigation never asks the wallet').toEqual([]);
  const logo = Buffer.from(await page.evaluate(async () => {
    const { currentDraft } = await import('/src/features/create/draft.ts');
    return currentDraft().cover?.data ?? '';
  }), 'base64');
  const logoPath = `/ipfs/${rawCidV1(sha256Hex(logo))}`;

  await page.getByRole('button', { name: 'Connect to create' }).click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: 'Local v2 test wallet' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('[data-pictures-note]')).toHaveText('Your box shows up as soon as it is created. Its logo appears once published. The BoxSpec file carries it.');
  const registry = await read(chain, 'BoxFactoryV2', chain.factory, 'registry');
  const before = await read(chain, 'BoxRegistryV2', registry, 'boxCount');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('[data-create-status]')).toHaveText(/^Created · (\d+)\/\1$/, { timeout: 120_000 });
  expect(decoded('BoxFactoryV2', wallet.sent.at(-1)).functionName).toBe('createBox');
  const coordinator = await read(chain, 'BoxRegistryV2', registry, 'coordinatorOf', [before]);
  const token = await read(chain, 'BoxCoordinatorV2', coordinator, 'token');
  const path = boxPath(chain, token);

  // ── Listed at once: the feed card and the box page, each with the plain tile; the logo's CID is asked and refused ──
  const logoAnswers = [];
  page.on('response', (response) => { if (new URL(response.url()).pathname === logoPath) logoAnswers.push(response.status()); });
  const card = page.locator('.sh-box-card').filter({ has: page.locator(`a.sh-box-card__link[href="${path}"]`) });
  await expect(async () => {
    await page.goto('/');
    await expect(card).toHaveCount(1, { timeout: 5_000 });
  }).toPass({ timeout: 90_000 });
  await plainTile(card);
  await expect(card.locator('img.sh-box-coin--logo')).toHaveCount(0);
  await expect(card.locator('.sh-box-coin')).toHaveAttribute('data-letter', 'P');
  await card.scrollIntoViewIfNeeded();
  await shot(page, 'feed-desktop');
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Plain Tile');
  await plainTile(page.locator('header.sh-bpic-head'));
  await expect.poll(() => logoAnswers.length).toBeGreaterThan(0);
  expect(logoAnswers.every((status) => status === 404), `the logo is on no gateway: ${logoAnswers}`).toBe(true);
  await expect(page.getByRole('button', { name: /^(buy|sell|swap)$/i })).toHaveCount(0);
  await shot(page, 'box-desktop');
  await page.setViewportSize(PHONE);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Plain Tile');
  await plainTile(page.locator('header.sh-bpic-head'));
  await shot(page, 'box-390');
  await page.goto('/');
  await expect(card).toHaveCount(1);
  await plainTile(card);
  await card.scrollIntoViewIfNeeded();
  await shot(page, 'feed-390');
  await page.setViewportSize(DESKTOP);

  // ── A gateway answering other bytes for the logo's CID: a valid PNG, not the committed one. It never shows. ──
  const other = Buffer.from(makePng({ width: 300, height: 300, decodable: true }));
  expect(sha256Hex(other)).not.toBe(sha256Hex(logo));
  let served = 0;
  await page.route(`**${logoPath}`, async (route) => {
    served += 1;
    await route.fulfill({ status: 200, contentType: 'image/png', headers: { 'cache-control': 'no-store' }, body: other });
  });
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Plain Tile');
  await expect.poll(() => served).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  await plainTile(page.locator('header.sh-bpic-head'));
  await expect(page.locator('.sh-v2-page img[src^="blob:"]')).toHaveCount(0);
  await shot(page, 'box-wrong-bytes-desktop');
  await page.unroute(`**${logoPath}`);

  // ── The right bytes published on the stack's art gateway: the logo shows, checked against its hash. A fresh context,
  // so this browser's earlier 404 for the CID (the local gateway sends no cache header) cannot answer instead. ──
  writeExampleArt(CREATED_ART, 'plain-tile', [{ role: 'logo', sha256: sha256Hex(logo), bytes: logo }]);
  const context = await browser.newContext({ storageState: TERMS_ACCEPTED, viewport: DESKTOP });
  try {
    const fresh = await context.newPage();
    // The local chain as the data source, as testWallet sets it for every other page of this suite (helpers.mjs).
    await fresh.addInitScript(() => window.localStorage.setItem('squarehole.data-source.v1', JSON.stringify({ source: 'local' })));
    await expect(async () => {
      await fresh.goto(new URL(path, page.url()).href);
      await expect(fresh.locator('header.sh-bpic-head .sh-box-cover')).toHaveAttribute('data-art', 'image', { timeout: 5_000 });
    }).toPass({ timeout: 60_000 });
    await shot(fresh, 'box-stored-desktop');
  } finally { await context.close(); }
  expect(wallet.sent, 'only Create sent anything; viewing pictures sends nothing').toHaveLength(1);
});
