// TA-50: a hidden-art box on the local chain, through the page: the creator saves the reveal file before Create sends
// anything, a draw pays the box token and its round's bounty, waits for its round and its settlement, and opens with the
// creator's file; the revealed picture shows only then, checked against the chain's hash. Runs after create-v2-send
// (the core-v2-* specs count the nine example boxes; this adds one more through the page).
//
// The round: the stack's life runs the chain's clock 30 days past every committed quicknet round
// (packages/contracts/test/vectors/drand-quicknet-box.json), so no real signature exists for the round a draw fixes
// now. The spec writes that round into the DrandSource exactly as `postRound` stores it (its randomness, its posting
// time, its pot credited to the poster) with anvil_setStorageAt; the BLS check itself is the contracts' own tests'.
// Everything after it is the real contracts: `wordOf`, `settle`, `openDraw` with the proof, the collection's reveal.
// SH-203: the opening goes through the reveal session (SH-202): it needs the settled draw at the finalized head (anvil's
// trails latest by 64 blocks, so the spec mines past it), Open prepares and shows the approval (the most it can cost and
// the sum with earlier sends for the item), and Confirm open sends exactly that, on a second press. Updated by SH-203;
// NOT RUN YET (the integrator runs it).
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { shLimit } from '../../../../vitest.timeouts.mjs';
import { decodeFunctionData, encodeAbiParameters, erc20Abi, keccak256, toHex } from 'viem';
import { makePng } from '../../../../packages/artwork/src/test-support/images.ts';
import { rawCidV1 } from '../../../../packages/artwork/src/misfits-commitment.ts';
import { ROOT, rpc } from '../../../../packages/chain/scripts/lib/core-v2-local-runtime.mjs';
import { sha256Hex, writeExampleArt } from '../../../../packages/chain/scripts/lib/core-v2-local-example-art.mjs';
import { callLocal, mineTo, readLocalBox, recipe } from '../../../../packages/chain/scripts/local-core-v2-chain.mjs';
import { boxPath, decoded, description, expectBoxFileSaved, followedIndexer, indexCaughtUp, read, saveMark, testWallet } from './helpers.mjs';

test.describe.configure({ mode: 'serial' });
const SHOTS = join(ROOT, '.cache/core-v2-local/ta50');
const CREATED_ART = join(ROOT, '.cache/core-v2-local/run/created-art');
const shot = async (page, name) => { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };
const ITEMS = 10;
// A real quicknet randomness (round 32654000's), standing in for the round the draw fixed.
const RANDOMNESS = JSON.parse(readFileSync(join(ROOT, 'packages/contracts/test/vectors/drand-quicknet-box.json'), 'utf8')).randomness[3];

/** Ten different item pictures (1.png … 10.png) and their traits. */
function artFiles() {
  const lines = ['id,Colour'];
  const files = Array.from({ length: ITEMS }, (_, i) => {
    lines.push(`${i + 1},${['Red', 'Teal', 'Gold', 'Plum'][i % 4]}`);
    return { name: `${i + 1}.png`, mimeType: 'image/png', buffer: Buffer.from(makePng({ width: 96 + i, height: 96, decodable: true })) };
  });
  return { files: [...files, { name: 'traits.csv', mimeType: 'text/csv', buffer: Buffer.from(`${lines.join('\n')}\n`) }], items: files.map((f) => f.buffer) };
}

async function connect(page, label) {
  await page.getByRole('button', { name: label }).click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: 'Local v2 test wallet' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('TA-50 hidden art: reveal file saved before Create, a draw waits for its round and settlement, opens with the file, the picture shows', async ({ page }) => {
  test.setTimeout(shLimit(600_000));
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
  const chain = description();
  const wallet = await testWallet(page, chain, { create: true });
  const art = artFiles();
  const itemCids = new Map(art.items.map((bytes, i) => [rawCidV1(sha256Hex(bytes)), i + 1]));
  const asked = [];
  page.on('request', (request) => {
    const cid = request.url().split('/ipfs/')[1];
    if (cid && itemCids.has(cid)) asked.push(itemCids.get(cid));
  });

  // ── Create through the page: a hidden collection priced in ETH ──
  await page.goto('/create/v2-basics');
  await page.getByRole('group', { name: /^Priced in/ }).getByRole('radio', { name: /^ETH\b/ }).check();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Hidden Owls');
  await page.getByRole('textbox', { name: 'Ticker' }).fill('HOWL');
  await page.locator('#create-logo').setInputFiles({ name: 'owl.png', mimeType: 'image/png', buffer: Buffer.from(makePng({ width: 512, height: 512, decodable: true })) });
  await expect(page.locator('#create-logo-action')).toHaveText('Change');
  const next = () => page.getByRole('button', { name: 'Next', exact: true }).click();
  await next();
  await page.getByRole('radio', { name: 'New collection' }).check();
  await page.getByLabel('Images + traits').setInputFiles(art.files);
  await expect(page.getByRole('status').filter({ hasText: new RegExp(`^${ITEMS} items`) })).toBeVisible();
  await page.locator('#create-collection-cover').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: Buffer.from(makePng({ width: 640, height: 640, decodable: true })) });
  await expect(page.getByRole('button', { name: 'Collection cover Change' })).toBeAttached();
  await page.getByRole('radio', { name: 'Hidden until drawn' }).check();
  await next(); await next(); await next();
  await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check(); await next();
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  expect(wallet.requests, 'navigation never asks the wallet').toEqual([]);

  // The creator publishes the logo, the collection cover and the item pictures (the BoxSpec file carries them); the
  // local gateway serves them. The page asks for an item's picture only once the chain says it is revealed.
  const pictures = await page.evaluate(async () => {
    const { currentDraft } = await import('/src/features/create/draft.ts');
    const d = currentDraft();
    return { logo: d.cover?.data ?? '', cover: d.collectionCover?.data ?? '' };
  });
  const logo = Buffer.from(pictures.logo, 'base64'); const cover = Buffer.from(pictures.cover, 'base64');
  writeExampleArt(CREATED_ART, 'hidden-owls', [
    { role: 'logo', sha256: sha256Hex(logo), bytes: logo }, { role: 'collection cover', sha256: sha256Hex(cover), bytes: cover },
    ...art.items.map((bytes) => ({ role: 'item', sha256: sha256Hex(bytes), bytes })),
  ]);

  await connect(page, 'Connect to create');
  // A real build: hidden art saves its reveal file first; Create is not offered and nothing is sent before.
  await expect(page.getByRole('button', { name: 'Create', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-reveal-note]')).toHaveText('Keep this file safe: it proves each item later. If you lose it, only our reveal service can open items, and only if you gave it the file.');
  await shot(page, '01-save-reveal-file');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save reveal file' }).click()]);
  expect(download.suggestedFilename()).toBe('howl-reveal-file.json');
  const revealPath = join(SHOTS, 'howl-reveal-file.json');
  mkdirSync(SHOTS, { recursive: true });
  await download.saveAs(revealPath);
  const reveal = JSON.parse(readFileSync(revealPath, 'utf8'));
  expect(reveal.items.map((item) => item.imageSha256)).toEqual(art.items.map((bytes) => sha256Hex(bytes)));
  expect(wallet.sent, 'nothing is sent before the reveal file is saved').toEqual([]);
  await expect(page.locator('[data-reveal-note]')).toHaveCount(0);

  const registry = await read(chain, 'BoxFactoryV2', chain.factory, 'registry');
  const before = await read(chain, 'BoxRegistryV2', registry, 'boxCount');
  const mark = saveMark(wallet);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('[data-create-status]')).toHaveText(/^Created · (\d+)\/\1$/, { timeout: shLimit(120_000) });
  // SH-192: the press saved the box file through the save window before the wallet was asked.
  expectBoxFileSaved(wallet, mark);
  expect(decoded('BoxFactoryV2', wallet.sent[0]).functionName).toBe('createBox');
  const coordinator = await read(chain, 'BoxRegistryV2', registry, 'coordinatorOf', [before]);
  expect(await read(chain, 'BoxCoordinatorV2', coordinator, 'creator')).toBe(chain.accounts.actor);
  const [token, collection, tickets] = await Promise.all([1n, 4n, 7n].map((role) => read(chain, 'BoxCoordinatorV2', coordinator, 'roleAddress', [role])));
  expect((await read(chain, 'BoxCollectionV2', collection, 'revealRoot')).toLowerCase()).toBe(reveal.revealRoot.toLowerCase());
  await shot(page, '02-created');
  expect(wallet.sendRequests(), 'Create: every send request was accepted').toBe(wallet.sent.length);

  // ── The box fills and graduates (the example life's own fill, then anyone's graduate) ──
  const box = await readLocalBox(chain, coordinator);
  await mineTo(chain.rpcUrl, box.openAt + 384n);
  await recipe(chain, 2, coordinator);
  await callLocal(chain, 'BoxCoordinatorV2', coordinator, 'graduate', [], chain.accounts.keeper);
  expect(await read(chain, 'BoxCoordinatorV2', coordinator, 'graduated')).toBe(true);
  // The indexer checks a new box within 32 blocks; actions wait for that verified read.
  await rpc(chain.rpcUrl, 'anvil_mine', ['0x40']);

  // ── The box page: a draw ──
  await page.goto(boxPath(chain, token));
  // SH-255: the index follows the chain first, with a limit fitting its backlog; the page check stays real.
  await indexCaughtUp(chain);
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hidden Owls', { timeout: shLimit(5_000) });
    await expect(page.locator('.sh-v2-page')).toContainText('Graduated', { timeout: shLimit(5_000) });
    // SH-224: the page's status line (Stale, Checking, Unverified) is the header's notice now.
    // SH-255 (review R-16): the header is there (the picture's), so no notice in it is a real check.
    await expect(page.locator('header.sh-bpic-head')).toHaveCount(1, { timeout: shLimit(30_000) });
    await expect(page.locator('header.sh-bpic-head .sh-box-notice[role="status"]')).toHaveCount(0, { timeout: shLimit(5_000) });
  }).toPass({ timeout: shLimit(60_000) });
  expect(wallet.sendRequests(), 'the box page reloads send nothing').toBe(wallet.sent.length);
  const panel = page.getByRole('region', { name: 'Draws' });
  const drawButton = panel.getByRole('button', { name: /^Draw one · [0-9.,]+ HOWL$/ });
  await expect(drawButton).toBeVisible({ timeout: shLimit(30_000) });
  await expect(page.getByRole('button', { name: /^(buy|sell|swap)$/i })).toHaveCount(0);
  await shot(page, '03-draw-offered');
  const sentBefore = wallet.sent.length;
  // SH-203 af2 R2-L3: every send request counts, accepted or not; an extra refused request fails at the boundary it follows.
  const askedBefore = wallet.sendRequests();
  const sendsAre = (n, where) => {
    expect(wallet.sendRequests() - askedBefore, `${where}: send requests`).toBe(n);
    expect(wallet.sent.length - sentBefore, `${where}: accepted sends`).toBe(n);
  };
  await drawButton.click();
  const confirmGroup = panel.getByRole('group', { name: 'Confirm transaction' });
  await expect(confirmGroup).toContainText(/Up to [0-9.,]+ HOWL/);
  await expect(confirmGroup).toContainText(/\+ up to [0-9.]+ ETH for the random number, the unused part comes back/);
  await confirmGroup.getByRole('button', { name: 'Approve HOWL' }).click();
  await expect(panel.locator('[data-draws-message]')).toHaveText('HOWL approved. Now confirm the draw.', { timeout: shLimit(60_000) });
  await confirmGroup.getByRole('button', { name: 'Confirm draw' }).click();
  await expect(panel.locator('[data-draws-message]')).toHaveText('Drawn · waiting for its random number', { timeout: shLimit(60_000) });
  sendsAre(2, 'after the approval and the draw');
  const [approve, drawn] = wallet.sent.slice(sentBefore);
  expect(approve.to.toLowerCase()).toBe(token.toLowerCase());
  const approved = decodeFunctionData({ abi: erc20Abi, data: approve.data });
  expect(approved.functionName).toBe('approve');
  expect(approved.args[0].toLowerCase()).toBe(tickets.toLowerCase());
  expect(drawn.to.toLowerCase()).toBe(tickets.toLowerCase());
  const drawCall = decoded('BoxTicketsV2', drawn);
  expect(drawCall.functionName).toBe('draw');
  expect(drawCall.args[0]).toBe(approved.args[1]);
  expect(BigInt(drawn.value), 'the draw carries its round bounty').toBeGreaterThan(0n);
  const row = panel.locator('li[data-draw="1"]');
  await expect(row).toHaveAttribute('data-state', 'waiting-round');
  await expect(row).toContainText('Draw 1 · waiting for its random number');
  await expect(row.getByRole('img', { name: 'Draw 1 · placeholder' })).toBeVisible();
  await shot(page, '04-waiting-round');

  // ── The round is posted (see the header) and the queue settled by anyone ──
  const source = await read(chain, 'BoxTicketsV2', tickets, 'source');
  const [, round] = await read(chain, 'DrandSource', source, 'requestOf', [tickets, 1n]);
  await mineTo(chain.rpcUrl, await read(chain, 'DrandSource', source, 'roundTime', [round]));
  const pot = await read(chain, 'DrandSource', source, 'bountyOf', [round]);
  const block = await rpc(chain.rpcUrl, 'eth_getBlockByNumber', ['latest', false]);
  const slot = BigInt(keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [round, 1n])));
  await rpc(chain.rpcUrl, 'anvil_setStorageAt', [source, toHex(slot, { size: 32 }), RANDOMNESS]);
  await rpc(chain.rpcUrl, 'anvil_setStorageAt', [source, toHex(slot + 1n, { size: 32 }), toHex(BigInt(block.timestamp), { size: 32 })]);
  const owed = BigInt(keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [chain.accounts.keeper, 2n])));
  await rpc(chain.rpcUrl, 'anvil_setStorageAt', [source, toHex(owed, { size: 32 }), toHex((await read(chain, 'DrandSource', source, 'owedTo', [chain.accounts.keeper])) + pot, { size: 32 })]);
  await rpc(chain.rpcUrl, 'anvil_mine', ['0x1']);
  expect(await read(chain, 'DrandSource', source, 'beaconOf', [round])).toEqual([RANDOMNESS, BigInt(block.timestamp)]);
  expect(await read(chain, 'DrandSource', source, 'bountyOf', [round])).toBe(0n);
  const [word] = await read(chain, 'DrandSource', source, 'wordOf', [tickets, 1n]);
  expect(word).not.toBe(`0x${'0'.repeat(64)}`);
  await expect(row).toHaveAttribute('data-state', 'settling', { timeout: shLimit(30_000) });
  await expect(panel.locator('[data-draws-message]')).toHaveText('Drawn.', { timeout: shLimit(30_000) });
  await expect(row).toContainText('Draw 1 · settling');
  await shot(page, '05-settling');
  await callLocal(chain, 'BoxTicketsV2', tickets, 'settle', [8n], chain.accounts.keeper);
  const ticket = await read(chain, 'BoxTicketsV2', tickets, 'drawTicket', [1n]);
  expect(ticket.status).toBe(2);
  const itemId = ticket.itemId;
  // The drawer is the creator here; before the file is loaded the draw waits for the reveal.
  await expect(row).toHaveAttribute('data-state', 'waiting-reveal', { timeout: shLimit(30_000) });
  await expect(row).toContainText(`Item ${itemId} · waiting for the reveal`);
  await expect(row.getByRole('img', { name: `Item ${itemId} · placeholder` })).toBeVisible();
  await shot(page, '06-waiting-reveal');
  expect(asked, 'no unrevealed item picture is ever asked for').toEqual([]);

  // ── The creator loads the reveal file and opens the draw with its proof ──
  await panel.getByLabel('Reveal file').setInputFiles(revealPath);
  await expect(panel.locator('[data-reveal-file]')).toHaveText(`Reveal file · ${ITEMS} items`);
  await expect(row).toHaveAttribute('data-state', 'open');
  await shot(page, '07-file-loaded');
  // The opening session reads the settled draw at the finalized head.
  await rpc(chain.rpcUrl, 'anvil_mine', ['0x50']);
  const sentBeforeOpen = wallet.sent.length;
  // SH-237: those 80 blocks leave the indexer behind for a while, and the page holds every press while its read is
  // stale. The page learns of the lag at one of its own polls, at any moment: before Open, before Confirm open (gate aa
  // of 18 November 2026: the button came back a second after the click's own 30 s had run out), or between a check of
  // the button and the press itself (gate ab of the same day: the press landed on a button that had just been disabled
  // and was lost; nothing was sent). So the scenario first waits until the server follows the chain again: from then on
  // no poll can turn the page stale. The page may still show its last stale read until its next poll, so each press
  // also waits for its own button.
  await followedIndexer(chain);
  await expect(row.getByRole('button', { name: 'Open' })).toBeEnabled({ timeout: shLimit(120_000) });
  await row.getByRole('button', { name: 'Open' }).click();
  await expect(confirmGroup).toContainText(`Open item ${itemId}?`);
  await expect(confirmGroup).toContainText(/Most it can cost[0-9.,]+ ETH/, { timeout: shLimit(60_000) });
  await expect(confirmGroup).toContainText(/Together at most[0-9.,]+ ETH/);
  expect(wallet.sent.length, 'Open prepares; nothing is sent before Confirm open').toBe(sentBeforeOpen);
  sendsAre(2, 'after Open');
  await shot(page, '07b-opening-approval');
  const confirmOpenButton = confirmGroup.getByRole('button', { name: 'Confirm open' });
  await expect(confirmOpenButton).toBeEnabled({ timeout: shLimit(120_000) });
  await confirmOpenButton.click();
  await expect(panel.locator('[data-draws-message]')).toHaveText(`Sent · item ${itemId}.`, { timeout: shLimit(60_000) });
  expect(wallet.sent.length, 'one opening send').toBe(sentBeforeOpen + 1);
  sendsAre(3, 'after Confirm open');
  const opened = wallet.sent.at(-1);
  const openCall = decoded('BoxTicketsV2', opened);
  expect(openCall.functionName).toBe('openDraw');
  expect(openCall.args[0]).toBe(1n);
  expect(openCall.args[2].imageHash.toLowerCase()).toBe(reveal.items[Number(itemId) - 1].imageSha256.toLowerCase());
  expect(BigInt(opened.value)).toBe(0n);
  const [revealed, , imageHash] = await read(chain, 'BoxCollectionV2', collection, 'traitsOf', [itemId]);
  expect(revealed).toBe(true);
  expect(imageHash.toLowerCase()).toBe(sha256Hex(art.items[Number(itemId) - 1]));
  expect((await read(chain, 'BoxCollectionV2', collection, 'ownerOf', [itemId])).toLowerCase()).toBe(chain.accounts.actor.toLowerCase());

  // ── The revealed picture, checked against the chain's hash; only that item's picture was ever asked for ──
  await expect(row).toHaveAttribute('data-state', 'revealed', { timeout: shLimit(30_000) });
  const picture = row.getByRole('img', { name: `Item ${itemId}`, exact: true });
  await expect(picture).toBeVisible({ timeout: shLimit(30_000) });
  await expect.poll(() => picture.evaluate(async (node) => { try { await node.decode(); } catch { return false; } return node.naturalWidth > 0; })).toBe(true);
  await expect(row.locator('[data-hash-checked]')).toContainText('Hash checked');
  expect([...new Set(asked)]).toEqual([Number(itemId)]);
  sendsAre(3, 'at completion');
  await shot(page, '08-revealed');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, '09-revealed-phone');
});
