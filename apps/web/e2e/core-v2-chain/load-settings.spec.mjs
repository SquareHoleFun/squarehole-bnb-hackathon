// TA-27: Load settings on the Create page against the local chain. The fixture settings file is the page's own
// "Download BoxSpec" of a 10-item open collection made in this test; loading it (and its item pictures) fills the
// whole setup, the fields outside the five show read-only, the price coin, name, ticker and a fee change, and the page
// creates the box through the browser test wallet. Runs after the core-v2-* specs (they count the example boxes).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi } from 'viem';
import { makePng } from '../../../../packages/artwork/src/test-support/images.ts';
import { ROOT, rpc, waitLocalReceipt } from '../../../../packages/chain/scripts/lib/core-v2-local-runtime.mjs';
import { artifact } from '../../../../packages/chain/scripts/lib/core-v2-local-manifest.mjs';
import { decoded, description, expectBoxFileSaved, read, saveMark, testWallet } from './helpers.mjs';

test.describe.configure({ mode: 'serial' });
const SHOTS = join(ROOT, '.cache/core-v2-local/ta27');
const shot = async (page, name) => { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };
const TEN = Array.from({ length: 10 }, (_, i) => i + 1);
// Ten distinct item pictures and their traits, as a creator adds them on Contents (and again for the loaded setup).
const ITEMS = [
  ...TEN.map((id) => ({ name: `${id}.png`, mimeType: 'image/png', buffer: Buffer.from(makePng({ width: 40 + id, height: 40 + id, decodable: true })) })),
  { name: 'traits.csv', mimeType: 'text/csv', buffer: Buffer.from(['id,Colour', ...TEN.map((id) => `${id},${id % 2 ? 'Red' : 'Teal'}`)].join('\n')) },
];
const picture = (side) => ({ name: `${side}.png`, mimeType: 'image/png', buffer: Buffer.from(makePng({ width: side, height: side, decodable: true })) });

async function connect(page) {
  await page.getByRole('button', { name: 'Connect to create' }).click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: 'Local v2 test wallet' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('TA-27 Load settings: the page’s own BoxSpec file loads its whole setup; the five change; the page creates it', async ({ page }) => {
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
  const chain = description();
  const wallet = await testWallet(page, chain, { create: true });
  const mint = await rpc(chain.rpcUrl, 'eth_sendTransaction', [{ from: chain.accounts.actor, to: chain.usdc,
    data: encodeFunctionData({ abi: parseAbi(['function mint(address to, uint256 amount)']), functionName: 'mint', args: [chain.accounts.actor, 10n ** 12n] }) }]);
  await waitLocalReceipt(chain.rpcUrl, mint);
  const next = () => page.getByRole('button', { name: 'Next', exact: true }).click();

  // 1. A setup made on the page (ETH, a 10-item open collection, To items on both sides, 90 days), then downloaded.
  await page.goto('/create/v2-basics');
  await page.getByRole('group', { name: /^Priced in/ }).getByRole('radio', { name: /^ETH\b/ }).check();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Paper Moons');
  await page.getByRole('textbox', { name: 'Ticker' }).fill('MOON');
  await page.getByRole('textbox', { name: 'About' }).fill('Moons, folded.');
  await page.locator('#create-logo').setInputFiles(picture(512));
  await expect(page.locator('#create-logo-action')).toHaveText('Change');
  await next();
  await page.getByRole('radio', { name: /^New collection/ }).check();
  await page.getByLabel('Images + traits').setInputFiles(ITEMS);
  await expect(page.getByRole('button', { name: 'Change art', exact: true })).toBeVisible();
  await page.locator('#create-collection-cover').setInputFiles(picture(400));
  await expect(page.locator('#create-collection-cover-action')).toHaveText('Change');
  await page.getByRole('group', { name: /^Pick fee/ }).getByRole('radio', { name: '1%', exact: true }).check();
  await next();
  for (const side of ['buyers', 'sellers']) await page.locator(`#create-v2-${side}`).getByRole('button', { name: 'To items', exact: true }).click();
  await next();
  await page.getByRole('radio', { name: /^90 days$/ }).check();
  await next();
  await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check();
  await next();
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download BoxSpec', exact: true }).click();
  const chunks = [];
  for await (const chunk of await (await pending).createReadStream()) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  const file = JSON.parse(text);
  expect(file.format).toBe('squarehole.boxspec/2'); expect(file.demo).not.toBe(true);
  expect(keccak256(file.encoded)).toBe(file.specHash);
  const specAbi = artifact('BoxFactoryV2').abi.find((entry) => entry.type === 'function' && entry.name === 'createBox').inputs[0];
  const [loaded] = decodeAbiParameters([specAbi], file.encoded);
  expect(loaded.n).toBe(10);
  mkdirSync(SHOTS, { recursive: true });
  const fixture = join(SHOTS, 'moon-boxspec-v2.json');
  writeFileSync(fixture, text);

  // 2. Load it: the settings file, then its item pictures.
  await page.goto('/create/v2-basics');
  await page.locator('#create-load-settings').setInputFiles(fixture);
  await expect(page.getByText('Item pictures · 10')).toBeVisible();
  await page.locator('#create-load-items').setInputFiles(ITEMS);
  await expect(page.locator('[data-loaded-setup]')).toContainText('From the loaded setup.');
  await expect(page.getByRole('heading', { name: 'Start from a template' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Paper Moons');
  await expect(page.getByRole('textbox', { name: 'About' })).toHaveValue('Moons, folded.');
  await expect(page.getByRole('textbox', { name: 'About' })).toBeDisabled();
  await expect(page.locator('#create-logo')).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toBeEnabled();
  // The five: a new name and ticker, priced in USDC (its raise is the USDC listing's).
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Moon Copy');
  await page.getByRole('textbox', { name: 'Ticker' }).fill('MCOPY');
  await page.getByRole('group', { name: /^Priced in/ }).getByRole('radio', { name: /^USDC\b/ }).check();
  await expect(page.locator('[data-price-refused]')).toHaveCount(0);
  await shot(page, 'loaded-basics');
  await next();
  await expect(page.locator('[data-loaded-setup]')).toBeVisible();
  await expect(page.getByRole('radio', { name: /^New collection/ })).toBeDisabled();
  // Read-only: the art's Change button is disabled and not shown.
  const changeArt = page.locator('#create-art').getByRole('button', { name: 'Change art', exact: true, includeHidden: true });
  await expect(changeArt).toBeDisabled(); await expect(changeArt).toBeHidden();
  await expect(page.getByRole('group', { name: /^Pick fee/ }).getByRole('radio', { name: '1%', exact: true })).toBeEnabled();
  await shot(page, 'loaded-contents');
  await next();
  await expect(page.locator('#create-v2-buyers').getByRole('button', { name: 'To items', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#create-v2-sellers').getByRole('button', { name: 'Grow the pool', exact: true }).click();
  await next();
  await expect(page.getByRole('radio', { name: /^90 days$/ })).toBeChecked();
  await expect(page.getByRole('radio', { name: /^90 days$/ })).toBeDisabled();
  await shot(page, 'loaded-raise');
  await next();
  await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check();
  await next();
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  expect(wallet.requests, 'navigation and loading never ask the wallet').toEqual([]);
  await shot(page, 'loaded-overview');

  // 3. Create on the local chain through the page's own buttons.
  const registry = await read(chain, 'BoxFactoryV2', chain.factory, 'registry');
  const before = await read(chain, 'BoxRegistryV2', registry, 'boxCount');
  await connect(page);
  const mark = saveMark(wallet);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('[data-create-status]')).toHaveText(/^Created · (\d+)\/\1$/, { timeout: 180_000 });
  // SH-192: the press saved the box file through the save window before the wallet was asked.
  expectBoxFileSaved(wallet, mark);
  expect(await read(chain, 'BoxRegistryV2', registry, 'boxCount')).toBe(before + 1n);
  const create = wallet.sent.map((tx) => { try { return decoded('BoxFactoryV2', tx); } catch { return null; } }).find((call) => call?.functionName === 'createBox');
  const spec = create.args[0];
  // The five changed; everything else is the loaded setup's (new salts for a new box: a new root and reveal list id).
  expect(spec.tokenName).toBe('Moon Copy'); expect(spec.tokenSymbol).toBe('MCOPY');
  expect(spec.collectionName).toBe('Moon Copy'); expect(spec.collectionSymbol).toBe('MCOPY');
  expect(spec.pricing.token.toLowerCase()).toBe(chain.usdc.toLowerCase());
  const listings = await read(chain, 'BoxFactoryV2', chain.factory, 'listingRegistry');
  expect(spec.raise).toBe((await read(chain, 'ListingRegistry', listings, 'listing', [spec.pricing.listingId])).raise);
  expect([spec.sellers.a.leg, spec.sellers.a.dest]).toEqual([1, 4]);
  for (const key of ['boxType', 'description', 'n', 'artMode', 'metadataTable', 'coverSha256', 'collectionCoverSha256', 'deadlineDays', 'pickFeeBps', 'buyers', 'addOns', 'contentsParams']) {
    expect(spec[key], key).toEqual(loaded[key]);
  }
  expect(spec.revealRoot).not.toBe(loaded.revealRoot);
  const coordinator = await read(chain, 'BoxRegistryV2', registry, 'coordinatorOf', [before]);
  expect((await read(chain, 'BoxCoordinatorV2', coordinator, 'creator')).toLowerCase()).toBe(chain.accounts.actor.toLowerCase());
  await shot(page, 'created');
});

// SH-256: the money choices survive a fresh document. The owner's box of 2 November was created after a reload with
// its names and items as typed but its fees at their defaults. Here a 10-item collection priced in USDC, To items with
// Burn in the vault on the buyers' side, To holders on the sellers', a 1% pick fee and 90 days. The property: for a
// fresh document BEFORE any change, the Overview's rows (and the spec they are read from) equal those before it. Adding
// the item files again (a reload keeps only their hashes; the box file Create saves first needs their bytes) is a new
// read with new salts: a new reveal root and reveal list id, and the reveal data saved again for it, as the page
// requires before any Create. So the decoded createBox is compared on the choices (both sides, pick fee, deadline,
// coin, About), not on the art's commitment.
test('SH-256 a reload before Create: the decoded createBox carries the buyers’, sellers’ and pick fee choices as set', async ({ page }) => {
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
  const chain = description();
  const wallet = await testWallet(page, chain, { create: true });
  const mint = await rpc(chain.rpcUrl, 'eth_sendTransaction', [{ from: chain.accounts.actor, to: chain.usdc,
    data: encodeFunctionData({ abi: parseAbi(['function mint(address to, uint256 amount)']), functionName: 'mint', args: [chain.accounts.actor, 10n ** 12n] }) }]);
  await waitLocalReceipt(chain.rpcUrl, mint);
  const next = () => page.getByRole('button', { name: 'Next', exact: true }).click();
  const overviewRows = async () => {
    await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
    await expect(page.locator('.sh-newbox-row').first()).toBeVisible();
    return page.locator('.sh-newbox-rows').evaluateAll((lists) => lists.flatMap((list) => Array.from(list.querySelectorAll('dt'), (dt) => `${dt.textContent} = ${dt.nextElementSibling?.textContent}`)));
  };

  await page.goto('/create/v2-basics');
  await page.getByRole('group', { name: /^Priced in/ }).getByRole('radio', { name: /^USDC\b/ }).check();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Rent Again');
  await page.getByRole('textbox', { name: 'Ticker' }).fill('RENTA');
  await page.getByRole('textbox', { name: 'About' }).fill('Fees go to the items outside the box.');
  await page.locator('#create-logo').setInputFiles(picture(512));
  await expect(page.locator('#create-logo-action')).toHaveText('Change');
  await next();
  await page.getByRole('radio', { name: /^New collection/ }).check();
  await page.getByLabel('Images + traits').setInputFiles(ITEMS);
  await expect(page.getByRole('button', { name: 'Change art', exact: true })).toBeVisible();
  await page.locator('#create-collection-cover').setInputFiles(picture(400));
  await expect(page.locator('#create-collection-cover-action')).toHaveText('Change');
  await page.getByRole('group', { name: /^Pick fee/ }).getByRole('radio', { name: '1%', exact: true }).check();
  await next();
  await page.locator('#create-v2-buyers').getByRole('button', { name: 'To items', exact: true }).click();
  await page.locator('#create-v2-buyers').getByRole('button', { name: /^Buy back and burn RENTA in the vault$/ }).click();
  await page.locator('#create-v2-sellers').getByRole('button', { name: 'To holders', exact: true }).click();
  await next();
  await page.getByRole('radio', { name: /^90 days$/ }).check();
  await next();
  await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check();
  await next();
  const rows = await overviewRows();

  // A fresh document: the same rows; the item pictures again on Contents (new salts), then back to the Overview.
  await page.reload();
  expect(await overviewRows()).toEqual(rows);
  await page.goto('/create/v2-contents');
  await page.getByRole('button', { name: 'Change art', exact: true }).click();
  await page.getByLabel('Images + traits').setInputFiles(ITEMS);
  await expect(page.getByRole('button', { name: 'Change art', exact: true })).toBeVisible();
  for (let step = 0; step < 4; step += 1) await next();
  expect(await overviewRows()).toEqual(rows);

  const registry = await read(chain, 'BoxFactoryV2', chain.factory, 'registry');
  const before = await read(chain, 'BoxRegistryV2', registry, 'boxCount');
  await connect(page);
  const mark = saveMark(wallet);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('[data-create-status]')).toHaveText(/^Created · (\d+)\/\1$/, { timeout: 180_000 });
  expectBoxFileSaved(wallet, mark);
  expect(await read(chain, 'BoxRegistryV2', registry, 'boxCount')).toBe(before + 1n);
  const create = wallet.sent.map((tx) => { try { return decoded('BoxFactoryV2', tx); } catch { return null; } }).find((call) => call?.functionName === 'createBox');
  const spec = create.args[0];
  const uint8 = (value) => encodeAbiParameters([{ type: 'uint8' }], [value]);
  // Buyers: AsPaid (1) to Items (8), Burn in the vault (2); sellers: AsPaid to Holders (6), paid in P (1); 1%.
  expect(spec.buyers.a).toEqual({ leg: 1, dest: 8, legParams: '0x', destParams: uint8(2) });
  expect(spec.sellers.a).toEqual({ leg: 1, dest: 6, legParams: '0x', destParams: uint8(1) });
  for (const side of [spec.buyers, spec.sellers]) expect([side.split, side.b.leg, side.b.dest]).toEqual([1, 0, 0]);
  expect(spec.pickFeeBps).toBe(100);
  expect(spec.deadlineDays).toBe(90);
  expect(spec.pricing.token.toLowerCase()).toBe(chain.usdc.toLowerCase());
  expect(spec.description).toBe('Fees go to the items outside the box.');
});
