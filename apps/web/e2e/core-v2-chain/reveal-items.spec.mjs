// SH-203: the creator's Reveal items view on the local chain, through the page. A creator makes an open collection of
// 41 items (two batches: a batch holds at most 40 reveals), opens Reveal items from the box page, prepares (the plan:
// two transactions and the most they can cost, nothing sent), starts, and reloads while the first batch waits for its
// confirmation. The reloaded view (`?view=reveal`) reads the copy of the box file this browser kept at Create, shows the send it
// is checking, and once the chain makes it final, a fresh Prepare and Start reveal the last item. Every item is then
// revealed and final on chain, and the reveal sent exactly two Multicall3 transactions.
//
// Written by SH-203; NOT RUN YET (the machine ran the line gates; the integrator runs it). Assumptions it states as
// assertions: the run waits for one block after inclusion (reveal-items.ts REVEAL_CONFIRMATION_BLOCKS), and anvil mines
// only on a transaction, so the first batch waits until the spec mines; anvil's finalized head trails its latest by 64
// blocks. The local stack has no Multicall3; the spec puts viem's pinned Multicall3 code at the canonical address
// (anvil_setCode), as the keeper's gas test uses the same bytecode. Runs after create-v2-send (the core-v2-* specs count
// the nine example boxes first; this adds one more through the page).
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { shLimit } from '../../../../vitest.timeouts.mjs';
import { decodeFunctionData, multicall3Abi } from 'viem';
import { makePng } from '../../../../packages/artwork/src/test-support/images.ts';
import { ROOT, rpc } from '../../../../packages/chain/scripts/lib/core-v2-local-runtime.mjs';
import { boxPath, decoded, description, expectBoxFileSaved, indexCaughtUp, read, saveMark, testWallet } from './helpers.mjs';

test.describe.configure({ mode: 'serial' });
const SHOTS = join(ROOT, '.cache/core-v2-local/sh203');
const shot = async (page, name) => { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };
const ITEMS = 41;
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

/** Forty-one different item pictures (1.png … 41.png) and their traits. */
function artFiles() {
  const lines = ['id,Colour'];
  const files = Array.from({ length: ITEMS }, (_, i) => {
    lines.push(`${i + 1},${['Red', 'Teal', 'Gold', 'Plum'][i % 4]}`);
    return { name: `${i + 1}.png`, mimeType: 'image/png', buffer: Buffer.from(makePng({ width: 80 + i, height: 80, decodable: true })) };
  });
  return [...files, { name: 'traits.csv', mimeType: 'text/csv', buffer: Buffer.from(`${lines.join('\n')}\n`) }];
}

/** viem's pinned Multicall3 at its canonical address: its creation code run once by eth_call gives the runtime code. */
async function installMulticall3(chain) {
  if ((await rpc(chain.rpcUrl, 'eth_getCode', [MULTICALL3, 'latest'])) !== '0x') return;
  const constants = readFileSync(fileURLToPath(new URL('./constants/contracts.js', import.meta.resolve('viem'))), 'utf8');
  const creation = /export const multicall3Bytecode = '(0x[0-9a-fA-F]+)'/.exec(constants)?.[1];
  expect(creation, 'viem ships the Multicall3 creation code').toBeTruthy();
  const runtime = await rpc(chain.rpcUrl, 'eth_call', [{ data: creation }, 'latest']);
  await rpc(chain.rpcUrl, 'anvil_setCode', [MULTICALL3, runtime]);
  expect(await rpc(chain.rpcUrl, 'eth_getCode', [MULTICALL3, 'latest'])).toBe(runtime);
}

/** Anvil's finalized head trails its latest by 64 blocks: mine past it. */
const finalize = (chain) => rpc(chain.rpcUrl, 'anvil_mine', ['0x50']);

test('SH-203 Reveal items: a creator reveals 41 open items in two batches, reloads in the middle, and finishes', async ({ page }) => {
  test.setTimeout(shLimit(600_000));
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
  const chain = description();
  const wallet = await testWallet(page, chain, { create: true });
  await installMulticall3(chain);
  wallet.allow(MULTICALL3, multicall3Abi, 'Multicall3');

  // ── Create through the page: an open collection priced in ETH (this browser keeps a copy of its box file) ──
  await page.goto('/create/v2-basics');
  await page.getByRole('group', { name: /^Priced in/ }).getByRole('radio', { name: /^ETH\b/ }).check();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Open Owls');
  await page.getByRole('textbox', { name: 'Ticker' }).fill('OOWL');
  await page.locator('#create-logo').setInputFiles({ name: 'owl.png', mimeType: 'image/png', buffer: Buffer.from(makePng({ width: 512, height: 512, decodable: true })) });
  await expect(page.locator('#create-logo-action')).toHaveText('Change');
  const next = () => page.getByRole('button', { name: 'Next', exact: true }).click();
  await next();
  await page.getByRole('radio', { name: 'New collection' }).check();
  await page.getByLabel('Images + traits').setInputFiles(artFiles());
  await expect(page.getByRole('status').filter({ hasText: new RegExp(`^${ITEMS} items`) })).toBeVisible();
  await page.locator('#create-collection-cover').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: Buffer.from(makePng({ width: 640, height: 640, decodable: true })) });
  await page.getByRole('radio', { name: 'Open', exact: true }).check();
  await next(); await next(); await next();
  await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check(); await next();
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  await page.getByRole('button', { name: 'Connect to create' }).click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: 'Local v2 test wallet' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const registry = await read(chain, 'BoxFactoryV2', chain.factory, 'registry');
  const before = await read(chain, 'BoxRegistryV2', registry, 'boxCount');
  const mark = saveMark(wallet);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('[data-create-status]')).toHaveText(/^Created · (\d+)\/\1$/, { timeout: shLimit(120_000) });
  // SH-192 (the line's SH-229): the press saved the box file through the save window before the wallet was asked.
  expectBoxFileSaved(wallet, mark);
  const coordinator = await read(chain, 'BoxRegistryV2', registry, 'coordinatorOf', [before]);
  const token = await read(chain, 'BoxCoordinatorV2', coordinator, 'token');
  const collection = await read(chain, 'BoxCoordinatorV2', coordinator, 'roleAddress', [4n]);
  expect(await read(chain, 'BoxCollectionV2', collection, 'revealedCount')).toBe(0n);
  expect(wallet.sendRequests(), 'Create: every send request was accepted').toBe(wallet.sent.length);
  // The indexer checks a new box within 32 blocks, and the reveal reads the box at the finalized head.
  await finalize(chain);

  // ── The box page: the creator's entry, the view, the numbers ──
  await page.goto(boxPath(chain, token));
  // SH-255: the index follows the chain first, with a limit fitting its backlog; the page check stays real.
  await indexCaughtUp(chain);
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Open Owls', { timeout: shLimit(5_000) });
    // SH-224: the page's status line (Stale, Checking, Unverified) is the header's notice now.
    // SH-255 (review R-16): the header is there (the picture's), so no notice in it is a real check.
    await expect(page.locator('header.sh-bpic-head')).toHaveCount(1, { timeout: shLimit(30_000) });
    await expect(page.locator('header.sh-bpic-head .sh-box-notice[role="status"]')).toHaveCount(0, { timeout: shLimit(5_000) });
  }).toPass({ timeout: shLimit(60_000) });
  expect(wallet.sendRequests(), 'the box page reloads send nothing').toBe(wallet.sent.length);
  const requestsBefore = wallet.requests.length;
  await page.getByRole('button', { name: 'Reveal items', exact: true }).click();
  await expect(page).toHaveURL(/[?&]view=reveal(?:&|$)/);
  const view = page.getByRole('region', { name: 'Reveal items' });
  const count = (name) => view.locator(`[data-reveal-count="${name}"]`);
  const status = view.locator('[data-reveal-status=""]');
  await expect(count('revealed')).toHaveText(`0/${ITEMS}`, { timeout: shLimit(60_000) });
  await expect(count('left')).toHaveText(String(ITEMS));
  await expect(status).toHaveText('Ready. Prepare shows the cost first.');
  expect(wallet.requests.length, 'opening the view asks the wallet nothing').toBe(requestsBefore);
  await shot(page, '01-reveal-view');

  // ── Prepare: two transactions and the most they can cost; nothing is sent ──
  const sentBefore = wallet.sent.length;
  // SH-203 af2 R2-L3: every send request counts, accepted or not; an extra refused request fails at the boundary it follows.
  const askedBefore = wallet.sendRequests();
  const sendsAre = (n, where) => {
    expect(wallet.sendRequests() - askedBefore, `${where}: send requests`).toBe(n);
    expect(wallet.sent.length - sentBefore, `${where}: accepted sends`).toBe(n);
  };
  await view.getByRole('button', { name: 'Prepare', exact: true }).click();
  const plan = view.locator('[data-reveal-plan]');
  await expect(plan).toContainText('Transactions2', { timeout: shLimit(60_000) });
  await expect(plan).toContainText(/Most it can cost[0-9.,]+ ETH/);
  sendsAre(0, 'after Prepare');
  await shot(page, '02-prepared');

  // ── Start: the first batch is included and waits for one more block (nothing mines until the spec does) ──
  await view.getByRole('button', { name: 'Start', exact: true }).click();
  await expect.poll(() => wallet.sent.length, { timeout: shLimit(60_000) }).toBe(sentBefore + 1);
  await expect(status).toHaveText('In a block. Confirming.');
  sendsAre(1, 'after the first Start');
  const first = wallet.sent.at(-1);
  expect(first.to.toLowerCase()).toBe(MULTICALL3.toLowerCase());
  expect(BigInt(first.value ?? '0x0')).toBe(0n);
  const firstCalls = decodeFunctionData({ abi: multicall3Abi, data: first.data }).args[0];
  expect(firstCalls.map((call) => decoded('BoxCollectionV2', { data: call.callData }).args[0])).toEqual(Array.from({ length: 40 }, (_, i) => BigInt(i + 1)));
  await shot(page, '03-first-batch-sent');

  // ── Reload in the middle: the view comes back with the send it checks, from this browser's kept copy ──
  await page.reload();
  await expect(view).toBeVisible({ timeout: shLimit(60_000) });
  await expect(view.locator('[data-attempt]')).toHaveCount(1, { timeout: shLimit(60_000) });
  await expect(view.locator('[data-attempt]')).toHaveAttribute('data-attempt-hash', 'saved');
  await expect(view.locator('[data-attempt]')).toContainText('40 items');
  await shot(page, '04-reloaded-checking');
  sendsAre(1, 'after the reload');

  // ── The chain makes it final: 40 revealed and final, nothing left to check ──
  await finalize(chain);
  await expect(count('revealed')).toHaveText(`40/${ITEMS}`, { timeout: shLimit(60_000) });
  await expect(count('final')).toHaveText(`40/${ITEMS}`, { timeout: shLimit(60_000) });
  await expect(view.locator('[data-attempt]')).toHaveCount(0, { timeout: shLimit(60_000) });

  // ── A fresh Prepare and Start reveal the last item ──
  await view.getByRole('button', { name: 'Prepare', exact: true }).click();
  await expect(plan).toContainText('Transactions1', { timeout: shLimit(60_000) });
  sendsAre(1, 'after the second Prepare');
  await view.getByRole('button', { name: 'Start', exact: true }).click();
  await expect.poll(() => wallet.sent.length, { timeout: shLimit(60_000) }).toBe(sentBefore + 2);
  sendsAre(2, 'after the second Start');
  // Blocks for its confirmation and its finality.
  const miner = setInterval(() => { void rpc(chain.rpcUrl, 'anvil_mine', ['0x2']).catch(() => undefined); }, 500);
  try {
    await expect(count('revealed')).toHaveText(`${ITEMS}/${ITEMS}`, { timeout: shLimit(120_000) });
    await expect(count('final')).toHaveText(`${ITEMS}/${ITEMS}`, { timeout: shLimit(120_000) });
    await expect(status).toHaveText('All items revealed.', { timeout: shLimit(120_000) });
  } finally { clearInterval(miner); }
  const second = wallet.sent.at(-1);
  expect(second.to.toLowerCase()).toBe(MULTICALL3.toLowerCase());
  expect(decodeFunctionData({ abi: multicall3Abi, data: second.data }).args[0].map((call) => decoded('BoxCollectionV2', { data: call.callData }).args[0])).toEqual([41n]);
  expect(wallet.sent.slice(sentBefore).filter((tx) => tx.to.toLowerCase() === MULTICALL3.toLowerCase()), 'exactly two reveal transactions').toHaveLength(2);
  sendsAre(2, 'at completion');
  await expect(view.getByRole('button', { name: 'Prepare', exact: true })).toHaveCount(0);
  await expect(view.getByRole('button', { name: 'Download run record', exact: true })).toBeVisible();
  await expect(view.getByRole('region', { name: 'Pictures', exact: true })).toBeVisible();
  await expect(view).not.toContainText('Waiting for the chain to make it final.');
  await expect(count('in-flight')).toHaveText('0', { timeout: shLimit(60_000) });
  expect(await read(chain, 'BoxCollectionV2', collection, 'revealedCount')).toBe(BigInt(ITEMS));
  await shot(page, '05-all-revealed');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, '06-all-revealed-phone');
  await page.setViewportSize({ width: 1280, height: 900 });

  // ── Back to the box: no entry once nothing is left to reveal ──
  await view.getByRole('button', { name: 'Back to the box', exact: true }).click();
  await expect(page).not.toHaveURL(/[?&]view=reveal/);
  sendsAre(2, 'after leaving the view');
  await expect(page.getByRole('button', { name: 'Reveal items', exact: true })).toHaveCount(0, { timeout: shLimit(60_000) });
});
