// SH-EX-O1: a 500-item open kit through Create on the local chain, as the founder will load one on the test site: Rent
// Free's settings file (the kit tooling's own bytes, written to a scratch folder by kit-files.mjs: an open collection's
// file carries its reveal list, so it is never committed), then its 500 numbered pictures and traits.csv, read in the
// browser. The page rebuilds the kit's spec from them, Create sends createBox and the chunk loads through the browser
// test wallet, and the box holds the kit's contents with its own new salts. The BoxSpec download after Create is the
// new box's own: item 1 reveals on chain with its proof, as the reveals of a live box must (plan correction 2: fresh
// salts on load). Runs after create-v2-send (the core-v2-* specs count the example boxes first).
// SH-EX-LMV2: Link Marines version 2 (F151), the Sepolia example kit, the same way and bound as the founder binds it:
// its settings file built with this chain's LINK listing (the kit tooling's --bindings; tLINK on Sepolia), then its 420
// numbered marines and traits.csv. Create approves the exact LINK, makes the box and loads its chunks. The box's own
// download reveals marine 1 through the page's wallet, then every other marine through the reviewed open reveal reader
// and its checked calls, as the launch pack's open-reveals.json asks after creation.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, erc20Abi, keccak256, parseAbi, zeroAddress } from 'viem';
import { boxLeaf, buildBoxTree } from '../../../../../packages/artwork/src/box-commitment.ts';
import { ROOT, TX_GAS, hex, rpc, waitLocalReceipt } from '../../../../../packages/chain/scripts/lib/core-v2-local-runtime.mjs';
import { artifact } from '../../../../../packages/chain/scripts/lib/core-v2-local-manifest.mjs';
import { localClient, readLocalBox } from '../../../../../packages/chain/scripts/local-core-v2-chain.mjs';
import { readOpenBoxSpec } from '../../../../../packages/chain/scripts/reveal-open-v2.ts';
import { registryV2Abi } from '../../../../../packages/chain/src/core/v2/abi-v2.ts';
import { checkedRevealCallV2, collectionTargetV2 } from '../../../../../packages/chain/src/core/v2/collection-calls-v2.ts';
import { browserContractCall, decoded, description, expectBoxFileSaved, read, saveMark, testWallet } from '../helpers.mjs';

test.describe.configure({ mode: 'serial' });
const KIT = 'rent-free';
const N = 500;
const FILES = join(ROOT, '.cache/core-v2-local/kits', KIT);
const SHOTS = join(ROOT, '.cache/core-v2-local/ex-o1');
const shot = async (page, name) => { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };
const specAbi = () => artifact('BoxFactoryV2').abi.find((entry) => entry.type === 'function' && entry.name === 'createBox').inputs[0];

async function connect(page) {
  await page.getByRole('button', { name: 'Connect to create' }).click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: 'Local v2 test wallet' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

/** A file the page saves, read as JSON. */
async function saved(page, label) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: label, exact: true }).click()]);
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

test('SH-EX-O1 open kit: Rent Free’s settings file and 500 numbered pictures load, and Create makes the box', async ({ page }) => {
  test.setTimeout(900_000);
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
  execFileSync(process.execPath, [fileURLToPath(new URL('./kit-files.mjs', import.meta.url)), KIT, FILES], { cwd: ROOT, stdio: 'pipe', timeout: 300_000 });
  const settings = join(FILES, `${KIT}-boxspec-v2.json`);
  const file = JSON.parse(readFileSync(settings, 'utf8'));
  expect(file.format).toBe('squarehole.boxspec/2'); expect(keccak256(file.encoded)).toBe(file.specHash);
  const [kit] = decodeAbiParameters([specAbi()], file.encoded);
  expect([kit.n, kit.artMode, file.revealList.items.length]).toEqual([N, 1, N]);
  // SH-CREATE-ITEM-MODELS: Rent Free is 3D, so each house's model comes with its picture.
  const items = [...Array.from({ length: N }, (_, i) => join(FILES, 'items', `${i + 1}.png`)), ...Array.from({ length: N }, (_, i) => join(FILES, 'items', `${i + 1}.glb`)), join(FILES, 'items', 'traits.csv')];
  const chain = description();
  const wallet = await testWallet(page, chain, { create: true });
  const next = () => page.getByRole('button', { name: 'Next', exact: true }).click();

  // ── 1. Load settings: the kit's file, then its 500 numbered pictures and traits.csv ──
  await page.goto('/create/v2-basics');
  await page.locator('#create-load-settings').setInputFiles(settings);
  await expect(page.getByText(`Item pictures + models · ${N}`)).toBeVisible({ timeout: 120_000 });
  await page.locator('#create-load-items').setInputFiles(items);
  const loaded = page.locator('[data-loaded-setup]');
  await expect(loaded).toContainText('From the loaded setup.', { timeout: 300_000 });
  await expect(loaded).toContainText(`${N} items, 3D`);
  await expect(page.locator('[data-load-problem]')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(kit.tokenName);
  await expect(page.getByRole('textbox', { name: 'Ticker' })).toHaveValue(kit.tokenSymbol);
  await shot(page, 'open-kit-loaded');

  // ── 2. The kit's contents, fees and deadline as loaded; the creator confirms the rights ──
  await next();
  await expect(page.getByRole('status').filter({ hasText: new RegExp(`^${N} items`) })).toBeVisible();
  await next(); await next(); await next();
  await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check();
  await next();
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  // ETH: no approval; createBox, then the table and the texts in chunks.
  const plan = page.locator('.sh-v2-send').getByRole('listitem');
  await expect(plan.first()).toHaveText('Create the box');
  const steps = await plan.allTextContents();
  expect(steps.slice(1).every((label) => /^Load (items|texts) \d+\/\d+$/.test(label)), steps.join(' | ')).toBe(true);
  expect(steps.length).toBeGreaterThanOrEqual(3);
  expect(wallet.requests, 'navigation and loading never ask the wallet').toEqual([]);
  await shot(page, 'open-kit-overview');

  // ── 3. Create through the page's own buttons ──
  const registry = await read(chain, 'BoxFactoryV2', chain.factory, 'registry');
  const before = await read(chain, 'BoxRegistryV2', registry, 'boxCount');
  await connect(page);
  const mark = saveMark(wallet);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('[data-create-status]')).toHaveText(`Created · ${steps.length}/${steps.length}`, { timeout: 300_000 });
  // SH-192: the press saved the box file through the save window before the wallet was asked.
  expectBoxFileSaved(wallet, mark);
  expect(await read(chain, 'BoxRegistryV2', registry, 'boxCount')).toBe(before + 1n);
  const spec = wallet.sent.map((tx) => { try { return decoded('BoxFactoryV2', tx); } catch { return null; } }).find((call) => call?.functionName === 'createBox').args[0];
  // The kit's setup, field by field: only the creator's own (owner) and the new box's salts differ.
  for (const key of ['boxType', 'tokenName', 'tokenSymbol', 'collectionName', 'collectionSymbol', 'description', 'n', 'firstId', 'artMode', 'metadataTable',
    'coverSha256', 'collectionCoverSha256', 'deadlineDays', 'buyers', 'sellers', 'addOns', 'contentsParams', 'pickFeeBps', 'creatorBuy', 'openAt', 'generatorHash']) {
    expect(spec[key], key).toEqual(kit[key]);
  }
  expect(spec.pricing.token).toBe(zeroAddress);
  expect(spec.revealRoot).not.toBe(kit.revealRoot); expect(spec.revealListId).not.toBe(kit.revealListId);
  expect(spec.marketplaceOwner.toLowerCase()).toBe(chain.accounts.actor.toLowerCase());
  const coordinator = await read(chain, 'BoxRegistryV2', registry, 'coordinatorOf', [before]);
  const loads = wallet.sent.filter((tx) => tx.to.toLowerCase() === coordinator.toLowerCase()).map((tx) => decoded('BoxCoordinatorV2', tx).functionName);
  expect(loads).toEqual(Array(steps.length - 1).fill('loadChunk'));
  // Every chunk is in: the box opened.
  expect((await readLocalBox(chain, coordinator)).gateOpen).toBe(true);
  await shot(page, 'open-kit-created');

  // ── 4. The BoxSpec download after Create is this box's own: its reveal list proves item 1 on chain ──
  const own = await saved(page, 'Download BoxSpec');
  expect(own.specHash).toBe(await read(chain, 'BoxCoordinatorV2', coordinator, 'specHash'));
  const entries = own.revealList.items.map((item) => ({ ...item, id: Number(item.id), traitsPacked: BigInt(item.traitsPacked) }));
  const tree = buildBoxTree(entries.map((entry) => boxLeaf(entry, N)), N);
  expect(tree.root).toBe(spec.revealRoot);
  const collection = await read(chain, 'BoxCoordinatorV2', coordinator, 'roleAddress', [4n]);
  const [first] = entries;
  await browserContractCall(page, chain, 'BoxCollectionV2', collection, 'reveal', [1n, first.traitsPacked, first.imageSha256, first.avatarSha256, first.modelSha256, first.salt, tree.proof(1)]);
  const [revealed, , imageHash] = await read(chain, 'BoxCollectionV2', collection, 'traitsOf', [1n]);
  expect(revealed).toBe(true);
  expect(imageHash.toLowerCase()).toBe(first.imageSha256.toLowerCase());
  // The kit's own picture for house 1: the same bytes the kit committed, under the new salt; its model too.
  expect(first.imageSha256.toLowerCase()).toBe(file.revealList.items[0].imageSha256.toLowerCase());
  expect(first.modelSha256.toLowerCase()).toBe(file.revealList.items[0].modelSha256.toLowerCase());
  expect(first.modelSha256).not.toBe(`0x${'0'.repeat(64)}`);
});

const V2 = 'link-marines-v2';
const MARINES = 420;
const V2_FILES = join(ROOT, '.cache/core-v2-local/kits', V2);

test('SH-EX-LMV2 open kit: Link Marines version 2 in LINK loads its 420 marines, Create makes the box, and every marine reveals from its own download', async ({ page }) => {
  test.setTimeout(900_000);
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
  const chain = description();
  const actor = chain.accounts.actor.toLowerCase();
  // This chain's LINK listing, bound as the Sepolia tLINK listing is (scripts/kits README, "Binding the setup").
  const listings = await read(chain, 'BoxFactoryV2', chain.factory, 'listingRegistry');
  const count = Number(await read(chain, 'ListingRegistry', listings, 'listingCount'));
  const linked = [];
  for (let id = 0; id < count; id += 1) {
    const listing = await read(chain, 'ListingRegistry', listings, 'listing', [id]);
    if (listing.token.toLowerCase() === chain.link.toLowerCase()) linked.push({ id, listing });
  }
  expect(linked, 'one local LINK listing').toHaveLength(1);
  const [{ id: listingId, listing }] = linked;
  const bindings = join(ROOT, '.cache/core-v2-local/kits', `${V2}-bindings.json`);
  mkdirSync(join(ROOT, '.cache/core-v2-local/kits'), { recursive: true });
  writeFileSync(bindings, `${JSON.stringify({ priceListing: { id: String(listingId), token: chain.link, raise: listing.raise.toString() } }, null, 2)}\n`);
  execFileSync(process.execPath, [fileURLToPath(new URL('./kit-files.mjs', import.meta.url)), V2, V2_FILES, '--bindings', bindings], { cwd: ROOT, stdio: 'pipe', timeout: 300_000 });
  const settings = join(V2_FILES, `${V2}-boxspec-v2.json`);
  const file = JSON.parse(readFileSync(settings, 'utf8'));
  expect(file.format).toBe('squarehole.boxspec/2'); expect(keccak256(file.encoded)).toBe(file.specHash);
  const [kit] = decodeAbiParameters([specAbi()], file.encoded);
  expect([kit.n, kit.artMode, file.revealList.items.length]).toEqual([MARINES, 1, MARINES]);
  expect([kit.pricing.listingId, kit.pricing.token.toLowerCase(), kit.raise]).toEqual([listingId, chain.link.toLowerCase(), listing.raise]);
  // The recipe (F151): both sides To items in LINK, the share of marines still inside to the box's own pool (Depth, 3),
  // 2.5% royalties into the fee handling.
  for (const side of [kit.buyers, kit.sellers]) {
    expect([side.a.leg, side.a.dest, side.a.destParams]).toEqual([1, 8, encodeAbiParameters([{ type: 'uint8' }], [3])]);
  }
  expect(decodeAbiParameters([{ type: 'uint16' }, { type: 'uint8' }], kit.addOns.find((addOn) => addOn.id === 4).params)).toEqual([250, 1]);
  const items = [...Array.from({ length: MARINES }, (_, i) => join(V2_FILES, 'items', `${i + 1}.png`)), join(V2_FILES, 'items', 'traits.csv')];
  // Valueless local test funds: the LINK stand-in mints to anyone (LocalQuoteMocks.sol).
  const mint = await rpc(chain.rpcUrl, 'eth_sendTransaction', [{ from: chain.accounts.actor, to: chain.link,
    data: encodeFunctionData({ abi: parseAbi(['function mint(address to, uint256 amount)']), functionName: 'mint', args: [chain.accounts.actor, listing.raise * 10n] }) }]);
  await waitLocalReceipt(chain.rpcUrl, mint);
  const wallet = await testWallet(page, chain, { create: true });
  const next = () => page.getByRole('button', { name: 'Next', exact: true }).click();

  // ── 1. Load settings: the bound file, then its 420 numbered marines and traits.csv ──
  await page.goto('/create/v2-basics');
  await page.locator('#create-load-settings').setInputFiles(settings);
  await expect(page.getByText(`Item pictures · ${MARINES}`)).toBeVisible({ timeout: 120_000 });
  await page.locator('#create-load-items').setInputFiles(items);
  const loaded = page.locator('[data-loaded-setup]');
  await expect(loaded).toContainText('From the loaded setup.', { timeout: 300_000 });
  await expect(loaded).toContainText(`${MARINES} items`);
  await expect(page.locator('[data-load-problem]')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(kit.tokenName);
  await expect(page.getByRole('textbox', { name: 'Ticker' })).toHaveValue(kit.tokenSymbol);
  await expect(page.getByRole('radio', { name: /^LINK\b/ })).toBeChecked();
  await shot(page, 'lmv2-loaded');

  // ── 2. The kit's contents, fees and deadline as loaded; the creator confirms the rights ──
  await next();
  await expect(page.getByRole('status').filter({ hasText: new RegExp(`^${MARINES} items`) })).toBeVisible();
  await next();
  for (const side of ['buyers', 'sellers']) {
    const group = page.locator(`#create-v2-${side}`);
    for (const name of ['To items', 'Claimed in LINK', 'Grow the pool in the vault']) await expect(group.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true');
  }
  await shot(page, 'lmv2-fees');
  await next(); await next();
  await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check();
  await next();
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  // LINK: the exact approval first, then createBox, then the table and the texts in chunks.
  const plan = page.locator('.sh-v2-send').getByRole('listitem');
  await expect(plan.first()).toHaveText(/^Approve [0-9.]+ LINK$/);
  const steps = await plan.allTextContents();
  expect(steps[1]).toBe('Create the box');
  expect(steps.slice(2).every((label) => /^Load (items|texts) \d+\/\d+$/.test(label)), steps.join(' | ')).toBe(true);
  expect(steps.length).toBeGreaterThanOrEqual(4);
  expect(wallet.requests, 'navigation and loading never ask the wallet').toEqual([]);
  await shot(page, 'lmv2-overview');

  // ── 3. Create through the page's own buttons ──
  const registry = await read(chain, 'BoxFactoryV2', chain.factory, 'registry');
  const before = await read(chain, 'BoxRegistryV2', registry, 'boxCount');
  await connect(page);
  const mark = saveMark(wallet);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('[data-create-status]')).toHaveText(`Created · ${steps.length}/${steps.length}`, { timeout: 300_000 });
  // SH-192: the press saved the box file through the save window before the wallet was asked (the approval included).
  expectBoxFileSaved(wallet, mark);
  expect(await read(chain, 'BoxRegistryV2', registry, 'boxCount')).toBe(before + 1n);
  // The exact approval: this listing's creation payment in LINK, to the factory.
  const q = await read(chain, 'BoxFactoryV2', chain.factory, 'boxQParameters', [kit.pricing.listingId, kit.raise]);
  expect(wallet.sent[0].to.toLowerCase()).toBe(chain.link.toLowerCase());
  const approval = decodeFunctionData({ abi: erc20Abi, data: wallet.sent[0].data });
  expect([approval.functionName, approval.args[0].toLowerCase(), approval.args[1]]).toEqual(['approve', chain.factory.toLowerCase(), q.bootstrapQ + kit.creatorBuy]);
  const spec = wallet.sent.map((tx) => { try { return decoded('BoxFactoryV2', tx); } catch { return null; } }).find((call) => call?.functionName === 'createBox').args[0];
  // The kit's setup, field by field, LINK listing and raise included: only the creator's own (owner, payee) and the new
  // box's salts differ.
  for (const key of ['boxType', 'tokenName', 'tokenSymbol', 'collectionName', 'collectionSymbol', 'description', 'n', 'firstId', 'artMode', 'metadataTable',
    'coverSha256', 'collectionCoverSha256', 'pricing', 'raise', 'deadlineDays', 'buyers', 'sellers', 'addOns', 'contentsParams', 'pickFeeBps', 'creatorBuy', 'openAt', 'generatorHash']) {
    expect(spec[key], key).toEqual(kit[key]);
  }
  expect(spec.revealRoot).not.toBe(kit.revealRoot); expect(spec.revealListId).not.toBe(kit.revealListId);
  expect([spec.marketplaceOwner.toLowerCase(), spec.creatorFeeRecipient.toLowerCase()]).toEqual([actor, actor]);
  const coordinator = await read(chain, 'BoxRegistryV2', registry, 'coordinatorOf', [before]);
  const loads = wallet.sent.filter((tx) => tx.to.toLowerCase() === coordinator.toLowerCase()).map((tx) => decoded('BoxCoordinatorV2', tx).functionName);
  expect(loads).toEqual(Array(steps.length - 2).fill('loadChunk'));
  // Every chunk is in: the box opened.
  expect((await readLocalBox(chain, coordinator)).gateOpen).toBe(true);
  await shot(page, 'lmv2-created');

  // ── 4. The BoxSpec download after Create is this box's own: its reveal list proves marine 1 on chain ──
  const own = await saved(page, 'Download BoxSpec');
  expect(own.specHash).toBe(await read(chain, 'BoxCoordinatorV2', coordinator, 'specHash'));
  const entries = own.revealList.items.map((item) => ({ ...item, id: Number(item.id), traitsPacked: BigInt(item.traitsPacked) }));
  const tree = buildBoxTree(entries.map((entry) => boxLeaf(entry, MARINES)), MARINES);
  expect(tree.root).toBe(spec.revealRoot);
  const collection = await read(chain, 'BoxCoordinatorV2', coordinator, 'roleAddress', [4n]);
  const [first] = entries;
  await browserContractCall(page, chain, 'BoxCollectionV2', collection, 'reveal', [1n, first.traitsPacked, first.imageSha256, first.avatarSha256, first.modelSha256, first.salt, tree.proof(1)]);
  const [revealed, , imageHash] = await read(chain, 'BoxCollectionV2', collection, 'traitsOf', [1n]);
  expect(revealed).toBe(true);
  expect(imageHash.toLowerCase()).toBe(first.imageSha256.toLowerCase());
  // The kit's own picture for marine 1: the same bytes the kit committed, under the new salt.
  expect(first.imageSha256.toLowerCase()).toBe(file.revealList.items[0].imageSha256.toLowerCase());

  // ── 5. The other 419 from the same download, as open-reveals.json asks: the reviewed reader checks the file (canonical
  // spec, hash, ids 1..420, list hash and root), the box's registry record binds it, and each call is checked ──
  const { spec: checked, specHash, list, tree: proofs } = readOpenBoxSpec(own);
  const record = await localClient(chain).readContract({ address: registry, abi: registryV2Abi, functionName: 'recordOf', args: [before] });
  expect(record.specHash.toLowerCase()).toBe(specHash.toLowerCase());
  const target = collectionTargetV2(chain.chainId, record, chain.accounts.actor);
  expect(target.collection.toLowerCase()).toBe(collection.toLowerCase());
  const [root, size, firstId] = await Promise.all(['revealRoot', 'collectionSize', 'firstId'].map((fn) => read(chain, 'BoxCollectionV2', collection, fn)));
  expect([root.toLowerCase(), size, firstId]).toEqual([checked.revealRoot.toLowerCase(), BigInt(MARINES), 1n]);
  for (const [i, item] of list.items.entries()) {
    const [, , already] = await read(chain, 'BoxCollectionV2', collection, 'revealState', [BigInt(item.id)]);
    if (already) { expect(item.id).toBe('1'); continue; }
    const call = checkedRevealCallV2(target, BigInt(item.id), { traitsPacked: BigInt(item.traitsPacked), imageHash: item.imageSha256,
      avatarHash: item.avatarSha256, modelHash: item.modelSha256, salt: item.salt, proof: proofs.proof(i + 1) }, { root, size, firstId }, chain.accounts.actor);
    await waitLocalReceipt(chain.rpcUrl, await rpc(chain.rpcUrl, 'eth_sendTransaction', [{ from: chain.accounts.actor, to: call.to, data: call.data, gas: hex(TX_GAS) }]));
  }
  expect(await read(chain, 'BoxCollectionV2', collection, 'revealedCount')).toBe(BigInt(MARINES));
  // Every marine shows the kit's own picture: the twelve rank pictures as the kit assigned them, under this box's salts.
  for (const [i, item] of file.revealList.items.entries()) {
    const [shown, , image] = await read(chain, 'BoxCollectionV2', collection, 'traitsOf', [BigInt(i + 1)]);
    expect(shown).toBe(true);
    expect(image.toLowerCase(), `marine ${i + 1}`).toBe(item.imageSha256.toLowerCase());
  }
});
