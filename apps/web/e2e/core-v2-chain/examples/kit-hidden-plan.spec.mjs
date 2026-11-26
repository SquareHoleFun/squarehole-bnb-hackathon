// SH-EX-O1: the hidden kits through Create on the local chain, the ways the founder will create them.
// 1. Frog Kiln by its plan on Contents: its 12 pictures and plan.csv (the page deals the 420 numbers itself), its logo
//    and cover, the kit's fees (buyers eat the price coin; sellers to items in KILN, the share of items still inside
//    burned), the reveal file saved before Create, then createBox and the chunk loads. Then the same setup's own
//    BoxSpec download with the kit's designed hidden picture (art/hidden.svg) in its placeholders add-on: loaded with
//    the 12 pictures and plan.csv again, the second box holds that picture on chain.
// 2. Frog Kiln and Gold Certificates from their public templates (scripts/kits, L1): each settings file with its plan
//    file, then the plan's pictures and plan.csv; the box keeps the template's spec but the marker, with its own root.
// Priced in the local ETH: the local twin lists no Test Frog with a checked burn, so eating locks the coin ("Lock ETH").
// Runs after create-v2-send (the core-v2-* specs count the example boxes first).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { decodeAbiParameters, encodeAbiParameters, keccak256 } from 'viem';
import { ROOT } from '../../../../../packages/chain/scripts/lib/core-v2-local-runtime.mjs';
import { sha256Hex } from '../../../../../packages/chain/scripts/lib/core-v2-local-example-art.mjs';
import { artifact } from '../../../../../packages/chain/scripts/lib/core-v2-local-manifest.mjs';
import { decoded, description, expectBoxFileSaved, read, saveMark, testWallet } from '../helpers.mjs';

test.describe.configure({ mode: 'serial' });
const OUT = join(ROOT, '.cache/core-v2-local/ex-o1');
const two = (i) => String(i + 1).padStart(2, '0');
const kitDir = (kit) => join(ROOT, 'examples/boxes', kit);
const picturesOf = (kit) => Array.from({ length: 12 }, (_, i) => join(kitDir(kit), 'art/items', `variant-${two(i)}.png`));
/** What a creator adds, on Contents or for a loaded setup: the 12 pictures as the kit names them, and its plan. */
const planOf = (kit) => [...picturesOf(kit), join(kitDir(kit), 'plan.csv')];
/** How many items each picture gets: plan.csv's second column, in its order (a count, never an amount). */
const countsOf = (kit) => readFileSync(join(kitDir(kit), 'plan.csv'), 'utf8').trim().split('\n').slice(1).map((line) => Number(line.split(',')[1]));
/** The kit's designed placeholder: one line of plain SVG text. */
const KIT_SVG = readFileSync(join(kitDir('frog-kiln'), 'art/hidden.svg'), 'utf8').trim();
const PLACEHOLDERS = Array.from({ length: 5 }, () => ({ type: 'string' }));
const specAbi = () => artifact('BoxFactoryV2').abi.find((entry) => entry.type === 'function' && entry.name === 'createBox').inputs[0];
const specOf = (file) => decodeAbiParameters([specAbi()], file.encoded)[0];
const shot = async (page, name) => { mkdirSync(OUT, { recursive: true }); await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true }); };
/** The placeholders add-on's (1) hidden picture in a spec, or null without the add-on. */
function hiddenSvgOf(spec) {
  const addOn = spec.addOns.find((entry) => Number(entry.id) === 1);
  return addOn ? decodeAbiParameters(PLACEHOLDERS, addOn.params)[4] : null;
}
/** The fields a box made from a loaded setup keeps as the file has them (its root, owner and payee are its own). */
const KEPT = ['boxType', 'tokenName', 'tokenSymbol', 'collectionName', 'collectionSymbol', 'description', 'n', 'artMode', 'metadataTable', 'coverSha256',
  'collectionCoverSha256', 'pricing', 'raise', 'deadlineDays', 'buyers', 'sellers', 'addOns', 'contentsParams', 'pickFeeBps', 'revealListId', 'openAt', 'creatorBuy'];

async function connect(page) {
  await page.getByRole('button', { name: 'Connect to create' }).click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: 'Local v2 test wallet' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

/** A file the page saves: its name and its JSON. */
async function saved(page, label) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: label, exact: true }).click()]);
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  return { name: download.suggestedFilename(), json: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
}

/** The same settings file with `svg` as its hidden picture, its spec encoded again and hashed (as the kit tooling writes it). */
function withHiddenPicture(file, svg) {
  const spec = specOf(file);
  const addOns = spec.addOns.map((addOn) => {
    if (Number(addOn.id) !== 1) return addOn;
    const [name, symbol, ticket, hidden] = decodeAbiParameters(PLACEHOLDERS, addOn.params);
    return { ...addOn, params: encodeAbiParameters(PLACEHOLDERS, [name, symbol, ticket, hidden, svg]) };
  });
  const encoded = encodeAbiParameters([specAbi()], [{ ...spec, addOns }]);
  return { ...file, specHash: keccak256(encoded), encoded, spec: { ...file.spec, addOns: addOns.map((addOn) => ({ id: Number(addOn.id), params: addOn.params })) } };
}

/**
 * SH-254: a new box opens the visual way (the default); Load settings is on the steps' Basics, one press away.
 */
async function toSteps(page) {
  await page.getByRole('navigation', { name: 'Launch' }).getByRole('link', { name: 'Steps' }).click();
  await expect(page).toHaveURL(/\/create\/v2-basics$/);
}

/** The page's steps for a page and its wallet: Next, the Overview, and Create after the reveal file. */
function stepsFor(page, chain, wallet) {
  const next = () => page.getByRole('button', { name: 'Next', exact: true }).click();
  const atOverview = () => expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  /** A loaded setup's steps as loaded; the creator confirms the rights. */
  async function throughLoaded() {
    await next(); await next(); await next(); await next();
    await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check();
    await next();
    await atOverview();
  }
  /** Loads `settings` (with its plan file when given), then the kit's plan: the setup with its items, hidden. */
  async function load(kit, n, settings) {
    await page.locator('#create-load-settings').setInputFiles(settings);
    await expect(page.getByText(`Item pictures · ${n}`)).toBeVisible({ timeout: 60_000 });
    await page.locator('#create-load-items').setInputFiles(planOf(kit));
    const loaded = page.locator('[data-loaded-setup]');
    await expect(loaded).toContainText('From the loaded setup.', { timeout: 120_000 });
    await expect(loaded).toContainText(`${n} items, hidden`);
    await expect(page.locator('[data-load-problem]')).toHaveCount(0);
  }
  /** The reveal file first (nothing is sent before it), then Create: the box it made, checked against the file and the chain. */
  async function create(kit, n, slug, label) {
    await expect(page.getByRole('button', { name: 'Create', exact: true })).toHaveCount(0);
    const sentBefore = wallet.sent.length;
    const reveal = await saved(page, 'Save reveal file');
    expect(reveal.name).toBe(`${slug}-reveal-file.json`);
    expect(wallet.sent.length, 'nothing is sent before the reveal file is saved').toBe(sentBefore);
    // Each picture as often as the plan says, under numbers this page dealt.
    const hashes = picturesOf(kit).map((path) => sha256Hex(readFileSync(path)));
    expect(reveal.json.items).toHaveLength(n);
    expect(hashes.map((hash) => reveal.json.items.filter((item) => item.imageSha256.toLowerCase() === hash).length)).toEqual(countsOf(kit));
    const registry = await read(chain, 'BoxFactoryV2', chain.factory, 'registry');
    const before = await read(chain, 'BoxRegistryV2', registry, 'boxCount');
    const mark = saveMark(wallet);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.locator('[data-create-status]')).toHaveText(/^Created · (\d+)\/\1$/, { timeout: 180_000 });
    // SH-192: the press saved the box file through the save window before the wallet was asked.
    expectBoxFileSaved(wallet, mark);
    expect(await read(chain, 'BoxRegistryV2', registry, 'boxCount')).toBe(before + 1n);
    const spec = wallet.sent.slice(sentBefore).map((tx) => { try { return decoded('BoxFactoryV2', tx); } catch { return null; } }).find((call) => call?.functionName === 'createBox').args[0];
    const coordinator = await read(chain, 'BoxRegistryV2', registry, 'coordinatorOf', [before]);
    const collection = await read(chain, 'BoxCoordinatorV2', coordinator, 'roleAddress', [4n]);
    expect(spec.revealRoot.toLowerCase()).toBe(reveal.json.revealRoot.toLowerCase());
    expect((await read(chain, 'BoxCollectionV2', collection, 'revealRoot')).toLowerCase()).toBe(reveal.json.revealRoot.toLowerCase());
    await shot(page, label);
    return { spec, collection, reveal: reveal.json };
  }
  return { next, atOverview, throughLoaded, load, create };
}

test('SH-EX-O1 hidden kit: Frog Kiln by its plan, then from its settings file with the kit’s own hidden picture', async ({ page }) => {
  test.setTimeout(600_000);
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
  const chain = description();
  const wallet = await testWallet(page, chain, { create: true });
  const { next, atOverview, throughLoaded, load, create } = stepsFor(page, chain, wallet);
  const kit = 'frog-kiln'; const N = 420;

  // ── 1. The plan route on Contents ──
  await page.goto('/create/v2-basics');
  await page.getByRole('group', { name: /^Priced in/ }).getByRole('radio', { name: /^ETH\b/ }).check();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Frog Kiln');
  await page.getByRole('textbox', { name: 'Ticker' }).fill('KILN');
  await page.locator('#create-logo').setInputFiles(join(kitDir(kit), 'art/logo.png'));
  await expect(page.locator('#create-logo-action')).toHaveText('Change');
  await next();
  await page.getByRole('radio', { name: /^New collection/ }).check();
  await page.getByLabel('Images + traits').setInputFiles(planOf(kit));
  await expect(page.getByRole('status').filter({ hasText: `${N} items · 2 traits` })).toBeVisible({ timeout: 120_000 });
  await page.getByRole('radio', { name: 'Hidden until drawn' }).check();
  await expect(page.locator('[data-plan-note="planned"]')).toBeVisible();
  await page.locator('#create-collection-cover').setInputFiles(join(kitDir(kit), 'art/cover.png'));
  await expect(page.locator('#create-collection-cover-action')).toHaveText('Change');
  await page.getByRole('group', { name: /^Pick fee/ }).getByRole('radio', { name: '1%', exact: true }).check();
  await next();
  const buyers = page.locator('#create-v2-buyers'); const sellers = page.locator('#create-v2-sellers');
  await buyers.getByRole('button', { name: 'Lock ETH', exact: true }).click();
  await sellers.getByRole('button', { name: 'To items', exact: true }).click();
  await sellers.getByRole('button', { name: 'Claimed in KILN', exact: true }).click();
  await sellers.getByRole('button', { name: 'Buy back and burn KILN in the vault', exact: true }).click();
  await next();
  await expect(page.getByRole('radio', { name: /^30 days$/ })).toBeChecked();
  await next();
  await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check();
  await next();
  await atOverview();
  expect(wallet.requests, 'navigation never asks the wallet').toEqual([]);
  // The setup's own file: hidden art carries its 12 pictures as a set and no reveal list; the neutral hidden picture.
  const setupFile = (await saved(page, 'Download BoxSpec')).json;
  expect(setupFile.revealList).toBeNull();
  expect(setupFile.pictures.filter((picture) => picture.role === 'item').map((picture) => picture.sha256).sort()).toEqual(picturesOf(kit).map((path) => sha256Hex(readFileSync(path))).sort());
  const neutral = hiddenSvgOf(specOf(setupFile));
  expect(neutral).not.toBe(KIT_SVG);
  await connect(page);
  const first = await create(kit, N, 'kiln', 'hidden-kit-plan-created');
  // The kit's recipe: 420 hidden items; buyers eat the price coin; sellers to items in KILN, the inside share burned.
  expect([first.spec.n, first.spec.artMode, first.spec.pickFeeBps, first.spec.deadlineDays]).toEqual([N, 2, 100, 30]);
  expect([first.spec.buyers.a.leg, first.spec.buyers.a.dest]).toEqual([1, 1]);
  expect([first.spec.sellers.a.leg, first.spec.sellers.a.dest, first.spec.sellers.a.destParams]).toEqual([2, 8, encodeAbiParameters([{ type: 'uint8' }], [2])]);
  expect(hiddenSvgOf(first.spec)).toBe(neutral);
  expect(await read(chain, 'BoxCollectionV2', first.collection, 'hiddenSvg')).toBe(neutral);

  // ── 2. The same setup from a settings file that carries the kit's own hidden picture ──
  const kitFile = withHiddenPicture(setupFile, KIT_SVG);
  mkdirSync(OUT, { recursive: true });
  const kitPath = join(OUT, 'frog-kiln-own-picture-boxspec-v2.json');
  writeFileSync(kitPath, `${JSON.stringify(kitFile, null, 2)}\n`);
  await page.getByRole('button', { name: 'Start a new box', exact: true }).click();
  await toSteps(page);
  await load(kit, N, kitPath);
  await throughLoaded();
  const second = await create(kit, N, 'kiln', 'hidden-kit-loaded-created');
  // The file's setup, its own hidden picture included, on chain; only the creator's own and the new deal are new.
  expect(hiddenSvgOf(second.spec)).toBe(KIT_SVG);
  expect(await read(chain, 'BoxCollectionV2', second.collection, 'hiddenSvg')).toBe(KIT_SVG);
  const kitSpec = specOf(kitFile);
  for (const key of KEPT) expect(second.spec[key], key).toEqual(kitSpec[key]);
  expect(second.reveal.revealRoot).not.toBe(first.reveal.revealRoot);
});

test('SH-EX-O1 hidden templates: Frog Kiln and Gold Certificates from their public settings and plan files', async ({ page }) => {
  test.setTimeout(600_000);
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
  const chain = description();
  const wallet = await testWallet(page, chain, { create: true });
  const { throughLoaded, load, create } = stepsFor(page, chain, wallet);
  await page.goto('/create/v2-basics');
  for (const [kit, n, slug] of [['frog-kiln', 420, 'kiln'], ['paper-certificates', 1_929, 'scrip']]) {
    const settings = join(kitDir(kit), 'settings', `${kit}-boxspec-v2.json`);
    const planFile = join(kitDir(kit), 'settings', `${kit}-plan.json`);
    const template = specOf(JSON.parse(readFileSync(settings, 'utf8')));
    const marker = JSON.parse(readFileSync(planFile, 'utf8')).plan.templateRoot;
    expect(template.revealRoot).toBe(marker);
    // The template alone is refused: its plan file goes with it.
    await page.locator('#create-load-settings').setInputFiles(settings);
    await expect(page.locator('[data-load-problem]')).toHaveText(/load its -plan\.json file with it/);
    await load(kit, n, [settings, planFile]);
    await throughLoaded();
    if (await page.getByRole('button', { name: 'Connect to create' }).isVisible()) await connect(page);
    const box = await create(kit, n, slug, `${kit}-template-created`);
    // The template's whole spec but its marker: the box's root is its own, from this page's deal and salts.
    for (const key of KEPT) expect(box.spec[key], `${kit} ${key}`).toEqual(template[key]);
    expect(box.spec.revealRoot).not.toBe(marker);
    await page.getByRole('button', { name: 'Start a new box', exact: true }).click();
    await toSteps(page);
  }
});
