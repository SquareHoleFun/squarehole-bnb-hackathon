// SH-TA-33: the items panel on a real local every-item box (ten revealed items, item 1 already out with the actor).
// Through the page's own buttons and the browser test wallet: take one item out for box tokens, see it in the wallet's
// list with its hash-checked picture, put it back. Named to run after the core-v2-* specs and Create, so their counts
// and numbers never see this test's moves.
//
// SH-235 (part 2): a box whose fees burn (no item ledger, no `m3`), made through Create with 40 open items and revealed
// through Reveal items (the pattern of reveal-items.spec.mjs). Take out items 1 to 12 through the page: page one of the
// vault list then shows 13 to 24 (before SH-235 it stayed on 1 to 12 and emptied); reload: all twelve are under Yours
// (before, Yours was gone after a reload). Adds one box through the page, as reveal-items.spec.mjs does.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { multicall3Abi } from 'viem';
import { shLimit } from '../../../../vitest.timeouts.mjs';
import { makePng } from '../../../../packages/artwork/src/test-support/images.ts';
import { ROOT, rpc } from '../../../../packages/chain/scripts/lib/core-v2-local-runtime.mjs';
import { callLocal, mineTo, recipe } from '../../../../packages/chain/scripts/local-core-v2-chain.mjs';
import { boxPath, decoded, description, expectBoxFileSaved, followedIndexer, formatUnits, indexCaughtUp, read, readLocalBox, saveMark, testWallet } from './helpers.mjs';

const SHOTS = join(ROOT, '.cache/core-v2-local/ta33');
/** The panel itself (a full-page shot repeats the fixed shell bar mid-page). */
const shot = async (panel, name) => { mkdirSync(SHOTS, { recursive: true }); await panel.screenshot({ path: join(SHOTS, `${name}.png`) }); };
const fee = (principal, bps) => (bps === 0n ? 0n : (principal * bps + 9_999n) / 10_000n);
const figure = (panel, label) => panel.locator('dt', { hasText: new RegExp(`^${label}$`) }).locator('xpath=following-sibling::dd[1]');

/** The picture really drew: an <img> whose verified bytes decoded. */
async function drawn(picture) {
  await expect(picture).toBeVisible();
  expect(await picture.evaluate((node) => node.tagName)).toBe('IMG');
  await expect.poll(() => picture.evaluate(async (node) => {
    try { await node.decode(); } catch { return false; }
    return node.complete && node.naturalWidth > 0;
  })).toBe(true);
}

for (const [layout, viewport] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
  test(`SH-TA-33 ${layout}: take an item out for box tokens, see it among yours with its picture, put it back`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const chain = description(); const wallet = await testWallet(page, chain);
    const coordinator = chain.boxes.everyItem;
    const b = await readLocalBox(chain, coordinator);
    const collection = await read(chain, 'BoxCoordinatorV2', coordinator, 'roleAddress', [4n]);
    const id = layout === 'desktop' ? 2n : 3n;
    expect(await read(chain, 'BoxVaultV2', b.vault, 'isOnShelf', [id])).toBe(true);

    await page.goto(boxPath(chain, b.token));
    const panel = page.getByRole('region', { name: 'Items in the vault' });
    await expect(panel).toBeVisible();
    // Numbers first, as the vault quotes them now.
    const principal = await read(chain, 'BoxVaultV2', b.vault, 'quoteWithdraw', [1n]);
    const take = principal + fee(principal, await read(chain, 'BoxVaultV2', b.vault, 'pickFeeBps'));
    await expect(figure(panel, 'Take one out')).toHaveText(`${formatUnits(take, 18)} ITEM`);
    await expect(figure(panel, 'In the vault')).toHaveText(String(await read(chain, 'BoxVaultV2', b.vault, 'inside')));
    const shelf = panel.getByRole('list', { name: 'In the vault' });
    await drawn(shelf.getByRole('img', { name: `Item #${id}` }));
    expect(wallet.requests, 'navigation must never touch the wallet').toEqual([]);
    await expect(page.getByRole('button', { name: /^(buy|sell|swap)$/i })).toHaveCount(0);
    if (layout === 'desktop') await shot(panel, `panel-${layout}`);

    // The first press without a wallet only opens the chooser.
    await shelf.getByRole('button', { name: `Take out item ${id}`, exact: true }).click();
    await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: 'Local v2 test wallet' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(wallet.sent).toEqual([]);
    await expect(figure(panel, 'Your ITEM')).toHaveText(`${formatUnits(b.actorT, 18)} ITEM`);

    // Take out: one press; the wallet confirms an exact approval (when the allowance is short) and the take.
    const before = await readLocalBox(chain, coordinator);
    await shelf.getByRole('button', { name: `Take out item ${id}`, exact: true }).click();
    await expect(panel.getByRole('status').filter({ hasText: `Confirmed · #${id} is in your wallet` })).toBeVisible();
    expect(await read(chain, 'BoxCollectionV2', collection, 'ownerOf', [id])).toBe(chain.accounts.actor);
    const taken = await readLocalBox(chain, coordinator);
    expect(before.actorT - taken.actorT).toBe(take);
    const calls = wallet.sent.map((tx) => ({ to: tx.to.toLowerCase(), call: decoded(tx.to.toLowerCase() === b.token.toLowerCase() ? 'BoxTokenV2' : 'BoxVaultV2', tx) }));
    expect(calls.at(-1).to).toBe(b.vault.toLowerCase()); expect(calls.at(-1).call.functionName).toBe('withdraw');
    expect(calls.at(-1).call.args[0]).toBe(id);
    expect(calls.at(-1).call.args[1]).toBe(take + (take * 100n) / 10_000n);
    for (const c of calls.slice(0, -1)) expect(c).toMatchObject({ to: b.token.toLowerCase(), call: { functionName: 'approve', args: [b.vault, take + (take * 100n) / 10_000n] } });
    for (const tx of wallet.sent) expect(BigInt(tx.value ?? '0x0')).toBe(0n);

    // It is listed among the wallet's own items, with its picture and Put back.
    const mine = panel.getByRole('list', { name: 'Your items' });
    await drawn(mine.getByRole('img', { name: `Item #${id}` }));
    await expect(mine.getByRole('button', { name: `Put back item ${id}`, exact: true })).toBeEnabled();
    await shot(panel, `taken-${layout}`);

    // Put back: approve the vault for this one item, then return it, for at least the shown amount less 1%.
    const sentBefore = wallet.sent.length;
    const backPrincipal = await read(chain, 'BoxVaultV2', b.vault, 'quoteReturn', [1n]);
    const back = backPrincipal - fee(backPrincipal, await read(chain, 'BoxVaultV2', b.vault, 'returnFeeBps'));
    await expect(figure(panel, 'One back pays')).toHaveText(`${formatUnits(back, 18)} ITEM`);
    await mine.getByRole('button', { name: `Put back item ${id}`, exact: true }).click();
    await expect(panel.getByRole('status').filter({ hasText: `Confirmed · #${id} is back in the vault` })).toBeVisible();
    expect(await read(chain, 'BoxCollectionV2', collection, 'ownerOf', [id])).toBe(b.vault);
    expect(await read(chain, 'BoxVaultV2', b.vault, 'isOnShelf', [id])).toBe(true);
    expect((await readLocalBox(chain, coordinator)).actorT - taken.actorT).toBe(back);
    const returns = wallet.sent.slice(sentBefore);
    expect(returns.map((tx) => tx.to.toLowerCase())).toEqual([collection.toLowerCase(), b.vault.toLowerCase()]);
    expect(decoded('BoxCollectionV2', returns[0])).toMatchObject({ functionName: 'approve', args: [b.vault, id] });
    const returned = decoded('BoxVaultV2', returns[1]);
    expect(returned.functionName).toBe('returnItem');
    expect(returned.args.slice(0, 2)).toEqual([id, back - (back * 100n) / 10_000n]);
    await expect(mine.getByRole('button', { name: `Put back item ${id}`, exact: true })).toHaveCount(0);
    await shot(panel, `returned-${layout}`);
  });
}

const ITEMS = 40;
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
/** Forty different item pictures (1.png … 40.png) and their traits: one reveal batch (a batch holds at most 40). */
function artFiles() {
  const lines = ['id,Colour'];
  const files = Array.from({ length: ITEMS }, (_, i) => {
    lines.push(`${i + 1},${['Red', 'Teal', 'Gold', 'Plum'][i % 4]}`);
    return { name: `${i + 1}.png`, mimeType: 'image/png', buffer: Buffer.from(makePng({ width: 72 + i, height: 72, decodable: true })) };
  });
  return [...files, { name: 'traits.csv', mimeType: 'text/csv', buffer: Buffer.from(`${lines.join('\n')}\n`) }];
}
/** viem's pinned Multicall3 at its canonical address (as reveal-items.spec.mjs installs it: the local stack has none). */
async function installMulticall3(chain) {
  if ((await rpc(chain.rpcUrl, 'eth_getCode', [MULTICALL3, 'latest'])) !== '0x') return;
  const constants = readFileSync(fileURLToPath(new URL('./constants/contracts.js', import.meta.resolve('viem'))), 'utf8');
  const creation = /export const multicall3Bytecode = '(0x[0-9a-fA-F]+)'/.exec(constants)?.[1];
  expect(creation, 'viem ships the Multicall3 creation code').toBeTruthy();
  await rpc(chain.rpcUrl, 'anvil_setCode', [MULTICALL3, await rpc(chain.rpcUrl, 'eth_call', [{ data: creation }, 'latest'])]);
}
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `#${from + i}`);

test('SH-235 burn/burn: take out items 1 to 12, page one refills with 13 to 24; after a reload all twelve are under Yours', async ({ page }) => {
  test.setTimeout(shLimit(840_000));
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
  const chain = description();
  const wallet = await testWallet(page, chain, { create: true });
  await installMulticall3(chain);
  wallet.allow(MULTICALL3, multicall3Abi, 'Multicall3');
  const next = () => page.getByRole('button', { name: 'Next', exact: true }).click();
  const connect = async () => {
    await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: 'Local v2 test wallet' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  };

  // ── Create through the page: 40 open items, the default fees (both sides burn), a 1% pick fee ──
  await page.goto('/create/v2-basics');
  await page.getByRole('group', { name: /^Priced in/ }).getByRole('radio', { name: /^ETH\b/ }).check();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Burnt Houses');
  await page.getByRole('textbox', { name: 'Ticker' }).fill('BHSE');
  await page.locator('#create-logo').setInputFiles({ name: 'house.png', mimeType: 'image/png', buffer: Buffer.from(makePng({ width: 512, height: 512, decodable: true })) });
  await expect(page.locator('#create-logo-action')).toHaveText('Change');
  await next();
  await page.getByRole('radio', { name: 'New collection' }).check();
  await page.getByLabel('Images + traits').setInputFiles(artFiles());
  await expect(page.getByRole('status').filter({ hasText: new RegExp(`^${ITEMS} items`) })).toBeVisible();
  await page.locator('#create-collection-cover').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: Buffer.from(makePng({ width: 640, height: 640, decodable: true })) });
  await page.getByRole('radio', { name: 'Open', exact: true }).check();
  await page.getByRole('group', { name: /^Pick fee/ }).getByRole('radio', { name: '1%', exact: true }).check();
  await next(); await next(); await next();
  await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check(); await next();
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  await page.getByRole('button', { name: 'Connect to create' }).click();
  await connect();
  const registry = await read(chain, 'BoxFactoryV2', chain.factory, 'registry');
  const before = await read(chain, 'BoxRegistryV2', registry, 'boxCount');
  const mark = saveMark(wallet);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('[data-create-status]')).toHaveText(/^Created · (\d+)\/\1$/, { timeout: shLimit(120_000) });
  expectBoxFileSaved(wallet, mark);
  const coordinator = await read(chain, 'BoxRegistryV2', registry, 'coordinatorOf', [before]);
  const [token, vault, collection, itemLedger] = await Promise.all([1n, 3n, 4n, 16n].map((role) => read(chain, 'BoxCoordinatorV2', coordinator, 'roleAddress', [role])));
  expect(BigInt(itemLedger), 'fees that burn: no item ledger').toBe(0n);
  await rpc(chain.rpcUrl, 'anvil_mine', ['0x50']);

  // ── Reveal every item through the page (one batch), then the box fills and graduates ──
  await page.goto(boxPath(chain, token));
  // SH-255: the index follows the chain first, with a limit fitting its backlog; the page check stays real.
  await indexCaughtUp(chain);
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Burnt Houses', { timeout: shLimit(5_000) });
    // SH-255 (review R-16): the header is there (the picture's), so no notice in it is a real check.
    await expect(page.locator('header.sh-bpic-head')).toHaveCount(1, { timeout: shLimit(30_000) });
    await expect(page.locator('header.sh-bpic-head .sh-box-notice[role="status"]')).toHaveCount(0, { timeout: shLimit(5_000) });
  }).toPass({ timeout: shLimit(60_000) });
  await page.getByRole('button', { name: 'Reveal items', exact: true }).click();
  const reveal = page.getByRole('region', { name: 'Reveal items' });
  await reveal.getByRole('button', { name: 'Prepare', exact: true }).click();
  await expect(reveal.locator('[data-reveal-plan]')).toContainText('Transactions1', { timeout: shLimit(60_000) });
  await reveal.getByRole('button', { name: 'Start', exact: true }).click();
  const miner = setInterval(() => { void rpc(chain.rpcUrl, 'anvil_mine', ['0x2']).catch(() => undefined); }, 500);
  try {
    await expect(reveal.locator('[data-reveal-count="final"]')).toHaveText(`${ITEMS}/${ITEMS}`, { timeout: shLimit(180_000) });
  } finally { clearInterval(miner); }
  expect(await read(chain, 'BoxCollectionV2', collection, 'revealedCount')).toBe(BigInt(ITEMS));
  const box = await readLocalBox(chain, coordinator);
  await mineTo(chain.rpcUrl, box.openAt + 384n);
  await recipe(chain, 2, coordinator);
  await callLocal(chain, 'BoxCoordinatorV2', coordinator, 'graduate', [], chain.accounts.keeper);
  await rpc(chain.rpcUrl, 'anvil_mine', ['0x40']);

  // ── The Items card: take out 1 to 12, one press each ──
  await page.goto(boxPath(chain, token));
  const panel = page.getByRole('region', { name: 'Items in the vault' });
  // SH-255: the index follows the chain first, with a limit fitting its backlog; the page check stays real.
  await indexCaughtUp(chain);
  await expect(async () => {
    await page.reload();
    await expect(page.locator('.sh-v2-page')).toContainText('Graduated', { timeout: shLimit(5_000) });
    // SH-255 (review R-16): the header is there (the picture's), so no notice in it is a real check.
    await expect(page.locator('header.sh-bpic-head')).toHaveCount(1, { timeout: shLimit(30_000) });
    await expect(page.locator('header.sh-bpic-head .sh-box-notice[role="status"]')).toHaveCount(0, { timeout: shLimit(5_000) });
    await expect(panel.getByRole('button', { name: 'Take out item 1', exact: true })).toBeEnabled({ timeout: shLimit(5_000) });
  }).toPass({ timeout: shLimit(60_000) });
  const shelf = panel.getByRole('list', { name: 'In the vault' });
  const ids = (list) => list.locator('.sh-vault-item__id').allTextContents();
  expect(await ids(shelf)).toEqual(range(1, 12));
  await expect(panel.getByRole('heading', { name: 'Yours', exact: true })).toBeVisible();
  const sentBefore = wallet.sent.length;
  for (let id = 1; id <= 12; id += 1) {
    const take = shelf.getByRole('button', { name: `Take out item ${id}`, exact: true });
    await expect(take).toBeEnabled({ timeout: shLimit(60_000) });
    await take.click();
    await expect(panel.getByRole('status').filter({ hasText: `Confirmed · #${id} is in your wallet` })).toBeVisible({ timeout: shLimit(60_000) });
    expect(await read(chain, 'BoxCollectionV2', collection, 'ownerOf', [BigInt(id)])).toBe(chain.accounts.actor);
  }
  const withdrawn = wallet.sent.slice(sentBefore).filter((tx) => tx.to.toLowerCase() === vault.toLowerCase()).map((tx) => decoded('BoxVaultV2', tx));
  expect(withdrawn.map((call) => [call.functionName, call.args[0]])).toEqual(Array.from({ length: 12 }, (_, i) => ['withdraw', BigInt(i + 1)]));
  // Page one refills: the first twelve items still inside.
  await expect.poll(() => ids(shelf), { timeout: shLimit(60_000) }).toEqual(range(13, 24));
  await expect(figure(panel, 'In the vault')).toHaveText(String(ITEMS - 12));
  mkdirSync(SHOTS, { recursive: true });
  await panel.screenshot({ path: join(SHOTS, 'sh235-refilled.png') });

  // ── Reload (no memory of this visit): every one of the twelve is under Yours, from the server's inventory ──
  await followedIndexer(chain);
  const sends = wallet.sent.length;
  await page.reload();
  await expect(shelf.getByRole('button', { name: 'Take out item 13', exact: true })).toBeVisible({ timeout: shLimit(60_000) });
  await expect(panel.getByRole('heading', { name: 'Yours', exact: true })).toBeVisible();
  const mine = panel.getByRole('list', { name: 'Your items' });
  await expect.poll(async () => (await ids(mine)).map((id) => BigInt(id.slice(1))).sort((a, b) => a < b ? -1 : a > b ? 1 : 0), { timeout: shLimit(60_000) })
    .toEqual(Array.from({ length: 12 }, (_, i) => BigInt(i + 1)));
  expect(await ids(shelf)).toEqual(range(13, 24));
  expect(wallet.sent.length, 'the reload and the connection send nothing').toBe(sends);
  await panel.screenshot({ path: join(SHOTS, 'sh235-reloaded.png') });
});
