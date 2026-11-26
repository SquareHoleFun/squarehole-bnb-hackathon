import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { PNG_SIGNATURE, concat, pngChunk } from '../../../packages/artwork/src/test-support/images';
import { MISFITS_BOX, STORED_NO_PARTS, STORED_V2_DEFAULTS, overflow, walletTouches, installUntouchableWallet } from './box-helpers';

// SH-F74-polish evidence: the changed UI at 1280 px (desktop project) and 400 px (mobile project), written to
// docs/evidence/screenshots/F74-polish/<name>-1280.png and <name>-400.png. Runs only with SH_F74_POLISH_SHOTS=1, so an
// ordinary run never dirties the tree; each shot also checks the words it shows.

const SHOTS = process.env.SH_F74_POLISH_SHOTS === '1';
const dir = fileURLToPath(new URL('../../../docs/evidence/screenshots/F74-polish/', import.meta.url));
const SEPOLIA = JSON.stringify({ source: 'sepolia' });
const DRAFT_KEY = 'sh.create.draft.v2';
const KITES = '/box/31337/0xde00700000000000000000000000000000000001';
const STAMPS = '/box/31337/0xde00700000000000000000000000000000000002';

test.skip(!SHOTS, 'evidence screenshots only: SH_F74_POLISH_SHOTS=1');

const main = (page: Page) => page.getByRole('main');
const steps = (page: Page) => page.getByRole('navigation', { name: 'Steps' });
const side = (page: Page, which: 'Buyers’' | 'Sellers’') => page.getByRole('group', { name: new RegExp(`^${which} fees · `) });

async function sized(page: Page, testInfo: TestInfo) {
  await page.setViewportSize(testInfo.project.name === 'mobile' ? { width: 400, height: 844 } : { width: 1280, height: 900 });
}

async function shot(page: Page, testInfo: TestInfo, name: string) {
  mkdirSync(dir, { recursive: true });
  expect(await overflow(page), `${name}: no sideways scroll`).toBeLessThanOrEqual(0);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${dir}${name}-${testInfo.project.name === 'mobile' ? '400' : '1280'}.png`, fullPage: true, scale: 'css' });
}

/** A decodable square PNG (a coloured field with a lighter square), for the logo and the collection cover. */
function png(size: number, [r, g, b]: readonly [number, number, number]): Buffer {
  const row = 1 + size * 3;
  const raw = new Uint8Array(row * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const k = Math.abs(x - size / 2) < size / 4 && Math.abs(y - size / 2) < size / 4 ? 1.6 : 0.55;
      raw.set([Math.min(255, Math.round(r * k)), Math.min(255, Math.round(g * k)), Math.min(255, Math.round(b * k))], y * row + 1 + x * 3);
    }
  }
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, size);
  new DataView(ihdr.buffer).setUint32(4, size);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.from(concat(PNG_SIGNATURE, pngChunk('IHDR', ihdr), pngChunk('IDAT', new Uint8Array(deflateSync(raw))), pngChunk('IEND', new Uint8Array())));
}

/** A stored draft as the page writes it (choices only; the logo is added on Basics); `older`: saved before F74 U2. */
function seedDraft(page: Page, patch: Record<string, unknown>, older = false) {
  const all: Record<string, unknown> = {
    qIndex: 0, name: 'Kites', ticker: 'KITE', description: '', links: { website: '', x: '', telegram: '' }, contents: 'token', separateCollection: false,
    collectionName: '', collectionSymbol: '', artMode: 'open', specials: [], ticketLine: 'Opens into one item once its number is drawn.', hiddenLine: 'This item is not revealed yet.',
    royaltyBps: 0, royaltyTo: 'fees', storeAll: false, pageLink: '', pageLinkEdited: false, qStream: 5, tStream: 1, capPerEpoch: '0', capExcess: 2, deadlineDays: 30,
    open: { kind: 'preset', blocks: 300 }, firstIn: '', rights: false, ownerText: '', ...patch,
  };
  // Before F74 U2 a draft stored the cap as a share of the raise (capBps) and had no capPerEpoch.
  const form = older ? Object.fromEntries(Object.entries(all).filter(([key]) => key !== 'capPerEpoch')) : all;
  return page.addInitScript(([key, value]) => {
    if (!window.sessionStorage.getItem(key)) window.sessionStorage.setItem(key, value);
  }, [DRAFT_KEY, JSON.stringify({ form, cover: null, collectionCover: null, revealSaved: false, v2: STORED_V2_DEFAULTS, parts: STORED_NO_PARTS })] as const);
}

async function logo(page: Page) {
  await page.goto('/create/basics');
  await page.locator('#create-logo').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: png(512, [80, 160, 120]) });
  await expect(page.getByRole('button', { name: 'Logo Change' })).toBeAttached();
}

async function onSepolia(page: Page) {
  await page.route((url) => !url.href.startsWith('http://127.0.0.1'), (route) => route.abort());
  await page.addInitScript((value) => window.localStorage.setItem('squarehole.data-source.v1', value), SEPOLIA);
}

test.beforeEach(async ({ page }, testInfo) => {
  await installUntouchableWallet(page);
  await sized(page, testInfo);
});

test.afterEach(async ({ page }) => {
  expect(await walletTouches(page)).toEqual([]);
});

test('Box kind in the Demo: the cap’s (i) names every choice on screen; the amount once (items 4, 9, 12)', async ({ page }, testInfo) => {
  await seedDraft(page, { capPerEpoch: '4000000000000000000' });
  await logo(page);
  await steps(page).getByRole('link', { name: /^Box kind/ }).click();
  await main(page).locator('summary', { hasText: 'Fee cap' }).click();
  await expect(main(page).locator('summary', { hasText: 'Fee cap' })).toHaveText('Fee cap');
  await expect(page.locator('#create-cap-hint')).toHaveText('Per 30 days');
  await page.getByRole('button', { name: 'About the cap' }).click();
  await expect(main(page).getByText(/^The most you receive per 30 days, a fixed amount\. Above it, fees are burned, go into the pool or go to holders\. KITE paid to you counts at the pool’s 1-hour average price; KITE bought for you counts the ETH spent\.$/)).toBeVisible();
  await shot(page, testInfo, '01-kind-cap-demo');
});

test('Box kind on Sepolia: only what core v1 builds; the sides’ (i) name no conversion or sell (item 5)', async ({ page }, testInfo) => {
  await onSepolia(page);
  await seedDraft(page, {});
  await logo(page);
  await steps(page).getByRole('link', { name: /^Box kind/ }).click();
  await expect(side(page, 'Buyers’').getByRole('group', { name: 'Paid in' }).locator('label.sh-newbox-chip')).toHaveText(['ETH']);
  await side(page, 'Sellers’').getByRole('button', { name: 'About sellers’ fees' }).click();
  await expect(main(page).getByText('Burn: the KITE is burned.')).toBeVisible();
  await shot(page, testInfo, '02-kind-sepolia');
});

test('Overview on Sepolia: a holder payout kept from the Demo is tagged "Demo only" (item 7)', async ({ page }, testInfo) => {
  await onSepolia(page);
  await seedDraft(page, { qStream: 4 });
  await logo(page);
  await steps(page).getByRole('link', { name: /^Overview/ }).click();
  const kind = page.getByRole('region', { name: 'Box kind' });
  await expect(kind).toContainText('Holders · ETH');
  await expect(kind.locator('.sh-newbox-pending')).toHaveText(['Not offered here yet']);
  await shot(page, testInfo, '03-overview-sepolia-demo-only');
});

test('Overview in the Demo: "Collection cover", holders "Pending legal review", the cap (items 7, 10)', async ({ page }, testInfo) => {
  await seedDraft(page, { qStream: 4, tStream: 5, capPerEpoch: '32000000000000000000', capExcess: 1 });
  await logo(page);
  await steps(page).getByRole('link', { name: /^Contents/ }).click();
  await page.getByRole('radio', { name: 'New collection' }).check();
  const art = [
    ...Array.from({ length: 10 }, (_, i) => ({ name: `${i + 1}.png`, mimeType: 'image/png', buffer: png(96, [40 + i * 18, 170, 160]) })),
    { name: 'traits.csv', mimeType: 'text/csv', buffer: Buffer.from(`id,Colour\n${Array.from({ length: 10 }, (_, i) => `${i + 1},${i % 2 ? 'Teal' : 'Red'}`).join('\n')}\n`) },
  ];
  await page.getByLabel('Images + traits').setInputFiles(art);
  await expect(page.getByRole('status').filter({ hasText: /^10 items/ })).toBeVisible();
  await page.locator('#create-collection-cover').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: png(640, [220, 120, 60]) });
  await expect(page.getByRole('button', { name: 'Collection cover Change' })).toBeAttached();
  await page.getByRole('button', { name: 'About the collection cover' }).click();
  await expect(main(page).getByText('The collection’s picture on marketplaces, and each item’s until it is revealed. Your logo stays the token’s picture.')).toBeVisible();
  await shot(page, testInfo, '04-contents-collection-cover-info');
  await steps(page).getByRole('link', { name: /^Overview/ }).click();
  await expect(page.getByRole('region', { name: 'Contents' }).locator('dt')).toContainText(['Collection cover']);
  const kind = page.getByRole('region', { name: 'Box kind' });
  await expect(kind.locator('.sh-newbox-pending')).toHaveText(['Pending legal review', 'Pending legal review']);
  await shot(page, testInfo, '05-overview-demo');
});

test('a draft saved with a share-of-the-raise cap says the cap was reset; the target’s (i) (items 12, 13)', async ({ page }, testInfo) => {
  await seedDraft(page, { capBps: 2500 }, true);
  await page.goto('/create/raise');
  await expect(page.getByText(/^Draft restored/)).toHaveText('Draft restored · Fee cap reset · Start over');
  await page.getByRole('button', { name: 'About the target' }).click();
  await expect(main(page).getByText('Every box raises this same amount, so nobody picks one.')).toBeVisible();
  await shot(page, testInfo, '06-draft-cap-reset-and-target');
});

test('the one raise exactly on box pages and feed cards (item 8); Demo holder claims in one wording (item 11)', async ({ page }, testInfo) => {
  await page.goto(KITES);
  const target = page.locator('header.sh-box-head .sh-box-stat', { hasText: 'Target' });
  await expect(target).toContainText('4.206980085');
  await shot(page, testInfo, '07-box-header-target');
  await page.goto(MISFITS_BOX);
  await expect(page.locator('header.sh-box-head')).toContainText('/ 4.206980085 ETH');
  await shot(page, testInfo, '08-misfits-band');
  await page.goto('/');
  await expect(page.getByRole('link', { name: /^Pocket Stamps,/ })).toContainText('1.4303 / 4.206980085 ETH');
  await shot(page, testInfo, '09-feed-cards');
  await page.goto(STAMPS);
  await page.getByRole('tab', { name: 'About' }).click();
  await expect(page.locator('.sh-box-about .sh-box-flag')).toHaveText(['Pending legal review']);
  await shot(page, testInfo, '10-stamps-about-holders');
});
