// TA-22: Create on the page against the local chain. Runs after the core-v2-* specs (they count the nine example
// boxes); this one adds a tenth, through the page's own buttons and the browser test wallet.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeFunctionData, erc20Abi, formatUnits, getAddress, maxUint256, parseAbi, toHex, zeroAddress } from 'viem';
import { makePng } from '../../../../packages/artwork/src/test-support/images.ts';
import { ROOT, rpc, waitLocalReceipt } from '../../../../packages/chain/scripts/lib/core-v2-local-runtime.mjs';
import { sha256Hex, writeExampleArt } from '../../../../packages/chain/scripts/lib/core-v2-local-example-art.mjs';
import { artifact } from '../../../../packages/chain/scripts/lib/core-v2-local-manifest.mjs';
import { localClient, mineTo } from '../../../../packages/chain/scripts/local-core-v2-chain.mjs';
import { feeModuleDirectoryV21Abi, receiverModulesV21Abi } from '../../../../packages/chain/src/core/v2/index.ts';
import { boxPath, decoded, description, read, testWallet } from './helpers.mjs';
import { deployAlchemist } from './shop/alchemist.mjs';
import { call, send } from './shop/life.mjs';

test.describe.configure({ mode: 'serial' });
let chain;
test.beforeAll(() => { chain = description(); });
const SHOTS = join(ROOT, '.cache/core-v2-local/ta22');
// The stack's catalogue for pictures a page-created box commits (scripts/dev-core-v2-local.mjs, --e2e).
const CREATED_ART = join(ROOT, '.cache/core-v2-local/run/created-art');
const shot = async (page, name) => { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };

async function connect(page) {
  await page.getByRole('button', { name: 'Connect to create' }).click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: 'Local v2 test wallet' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('TA-22 the page creates a box: exact approval, a declined step, reload, Continue without a resend', async ({ page }) => {
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
  const wallet = await testWallet(page, chain, { create: true });
  const registry = await read(chain, 'BoxFactoryV2', chain.factory, 'registry');
  const before = await read(chain, 'BoxRegistryV2', registry, 'boxCount');
  // Valueless local test funds: the USDC stand-in mints to anyone (LocalQuoteMocks.sol).
  const mint = await rpc(chain.rpcUrl, 'eth_sendTransaction', [{ from: chain.accounts.actor, to: chain.usdc,
    data: encodeFunctionData({ abi: parseAbi(['function mint(address to, uint256 amount)']), functionName: 'mint', args: [chain.accounts.actor, 10n ** 12n] }) }]);
  await waitLocalReceipt(chain.rpcUrl, mint);

  await page.goto('/create/v2-basics');
  await page.getByRole('radio', { name: /^USDC\b/ }).check();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Local Made');
  await page.getByRole('textbox', { name: 'Ticker' }).fill('MADE');
  await page.locator('#create-logo').setInputFiles({ name: 'made.png', mimeType: 'image/png', buffer: Buffer.from(makePng({ width: 512, height: 512, decodable: true })) });
  await expect(page.locator('#create-logo-action')).toHaveText('Change');
  const next = () => page.getByRole('button', { name: 'Next', exact: true }).click();
  await next(); await page.getByRole('radio', { name: /^Token/ }).check();
  await next(); await next(); await next();
  await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check(); await next();
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  const plan = page.locator('.sh-v2-send');
  await expect(plan.getByRole('listitem')).toHaveText([/^Approve [0-9.]+ USDC$/, 'Create the box']);
  expect(wallet.requests, 'navigation never asks the wallet').toEqual([]);
  await shot(page, 'overview-connect');

  // The creator publishes the logo the page processed (the BoxSpec file carries it); here the local gateway serves it.
  const logo = Buffer.from(await page.evaluate(async () => {
    const { currentDraft } = await import('/src/features/create/draft.ts');
    return currentDraft().cover?.data ?? '';
  }), 'base64');
  writeExampleArt(CREATED_ART, 'made', [{ role: 'logo', sha256: sha256Hex(logo), bytes: logo }]);

  await connect(page);
  expect(wallet.sent).toEqual([]);
  wallet.decline('createBox');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('[data-create-error]')).toHaveText(/Declined in the wallet\./, { timeout: 60_000 });
  expect(wallet.sent).toHaveLength(1);
  const approve = decodeFunctionData({ abi: erc20Abi, data: wallet.sent[0].data });
  expect(wallet.sent[0].to.toLowerCase()).toBe(chain.usdc.toLowerCase());
  expect(approve.functionName).toBe('approve');
  expect(approve.args[0].toLowerCase()).toBe(chain.factory.toLowerCase());
  expect(await read(chain, 'BoxRegistryV2', registry, 'boxCount')).toBe(before);
  await shot(page, 'declined');

  // A reload keeps this tab's run; the chain says the approval is in, so Continue sends createBox alone.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  // The browser wallet may reconnect by itself (F135); otherwise the creator connects it again.
  const connectButton = page.getByRole('button', { name: 'Connect to create' });
  await expect(page.locator('[data-create-status]').or(connectButton)).toBeVisible();
  if (await connectButton.isVisible()) await connect(page);
  await expect(page.locator('[data-create-status]')).toHaveText('Stopped · 1/2', { timeout: 30_000 });
  await expect(plan.locator('li[data-done]')).toHaveCount(1);
  // The run is labelled by its own spec (USDC); SH-256: the reload kept the draft too, so it is still the draft's run.
  await expect(plan.getByRole('listitem')).toHaveText([/^Approve [0-9.]+ USDC$/, 'Create the box']);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('[data-create-status]')).toHaveText('Created · 2/2', { timeout: 90_000 });
  expect(wallet.sent).toHaveLength(2);
  expect(decoded('BoxFactoryV2', wallet.sent[1]).functionName).toBe('createBox');
  expect(wallet.sent.filter((tx) => tx.to.toLowerCase() === chain.usdc.toLowerCase()), 'the mined approval is never sent again').toHaveLength(1);
  expect(await read(chain, 'BoxRegistryV2', registry, 'boxCount')).toBe(before + 1n);
  const coordinator = await read(chain, 'BoxRegistryV2', registry, 'coordinatorOf', [before]);
  expect((await read(chain, 'BoxCoordinatorV2', coordinator, 'creator')).toLowerCase()).toBe(chain.accounts.actor.toLowerCase());
  const token = await read(chain, 'BoxCoordinatorV2', coordinator, 'token');
  await shot(page, 'created');

  await page.getByRole('link', { name: 'Open your box' }).click();
  await expect(page).toHaveURL(new RegExp(`${boxPath(chain, token)}$`));
  // The indexer lists the box a moment after its block.
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Local Made', { timeout: 5_000 });
  }).toPass({ timeout: 90_000 });
  await expect(page.getByRole('button', { name: /^(buy|sell|swap)$/i })).toHaveCount(0);
  await shot(page, 'box-page');
});

// SH-256 (E1): the same sequence with ONE fee changed before the press. The approval is mined and createBox declined;
// the creator changes the buyers' fee and reloads. The saved run has approvals only and its spec is no longer the
// draft's, so it is not resumed: the button reads Create, the press prepares the draft (the mined approval stays an
// allowance, read on the chain and not asked again), and the createBox the wallet gets carries the changed fee, the
// one the Overview's rows show. (A reload with the draft unchanged still reads Continue: TA-22 above.)
test('SH-256 a fee changed after a declined createBox: the press sends the Overview’s fee, never the saved run’s', async ({ page }) => {
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
  const wallet = await testWallet(page, chain, { create: true });
  const registry = await read(chain, 'BoxFactoryV2', chain.factory, 'registry');
  const before = await read(chain, 'BoxRegistryV2', registry, 'boxCount');
  const mint = await rpc(chain.rpcUrl, 'eth_sendTransaction', [{ from: chain.accounts.actor, to: chain.usdc,
    data: encodeFunctionData({ abi: parseAbi(['function mint(address to, uint256 amount)']), functionName: 'mint', args: [chain.accounts.actor, 10n ** 12n] }) }]);
  await waitLocalReceipt(chain.rpcUrl, mint);
  const next = () => page.getByRole('button', { name: 'Next', exact: true }).click();
  const heading = page.getByRole('heading', { level: 1 });
  const buyersRow = () => page.locator('.sh-newbox-row').filter({ has: page.locator('dt', { hasText: /^Buyers’ fees$/ }) }).locator('dd');

  await page.goto('/create/v2-basics');
  await page.getByRole('radio', { name: /^USDC\b/ }).check();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Fee Changed');
  await page.getByRole('textbox', { name: 'Ticker' }).fill('REFEE');
  await page.locator('#create-logo').setInputFiles({ name: 'refee.png', mimeType: 'image/png', buffer: Buffer.from(makePng({ width: 512, height: 512, decodable: true })) });
  await expect(page.locator('#create-logo-action')).toHaveText('Change');
  await next(); await page.getByRole('radio', { name: /^Token/ }).check();
  await next(); await next(); await next();
  await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check(); await next();
  await expect(heading).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  await expect(buyersRow()).toHaveText(/^Buy back and burn REFEE/);
  const logo = Buffer.from(await page.evaluate(async () => {
    const { currentDraft } = await import('/src/features/create/draft.ts');
    return currentDraft().cover?.data ?? '';
  }), 'base64');
  writeExampleArt(CREATED_ART, 'refee', [{ role: 'logo', sha256: sha256Hex(logo), bytes: logo }]);

  // Approve, then decline createBox: the saved run holds the approval only.
  await connect(page);
  wallet.decline('createBox');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('[data-create-error]')).toHaveText(/Declined in the wallet\./, { timeout: 60_000 });
  expect(wallet.sent).toHaveLength(1);

  // The creator sees the fee they did not want, changes it, and reloads.
  await page.goto('/create/v2-fees');
  await page.locator('#create-v2-buyers').getByRole('button', { name: 'Grow the pool', exact: true }).click();
  await expect(page.locator('#create-v2-buyers').getByRole('button', { name: 'Grow the pool', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.goto('/create/v2-overview');
  await page.reload();
  await expect(heading).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  const connectButton = page.getByRole('button', { name: 'Connect to create' });
  await expect(page.getByRole('button', { name: /^(Create|Continue)$/ }).or(connectButton)).toBeVisible({ timeout: 30_000 });
  if (await connectButton.isVisible()) await connect(page);
  await expect(buyersRow()).toHaveText(/^Grow the pool/);
  const press = page.getByRole('button', { name: /^(Create|Continue)$/ });
  await expect(press).toHaveText('Create', { timeout: 30_000 });
  await press.click();
  await expect(page.locator('[data-create-status]')).toHaveText(/^Created · (\d+)\/\1$/, { timeout: 90_000 });
  const create = wallet.sent.map((tx) => { try { return decoded('BoxFactoryV2', tx); } catch { return null; } }).find((c) => c?.functionName === 'createBox');
  const spec = create.args[0];
  // Grow the pool: AsPaid (1) to Depth (4); the sellers' side kept its default, Buy back and burn (BuyT 2, Eat 1).
  expect([spec.buyers.a.leg, spec.buyers.a.dest]).toEqual([1, 4]);
  expect([spec.sellers.a.leg, spec.sellers.a.dest]).toEqual([2, 1]);
  expect(spec.tokenSymbol).toBe('REFEE');
  await expect(buyersRow()).toHaveText(/^Grow the pool/);
  expect(wallet.sent.filter((tx) => tx.to.toLowerCase() === chain.usdc.toLowerCase()), 'the mined approval is not asked again').toHaveLength(1);
  expect(await read(chain, 'BoxRegistryV2', registry, 'boxCount')).toBe(before + 1n);
});

// ALCH-TEMPLATE: the "Alchemist coin pile" tile shows once an Alchemist row resolves for a listed pile coin, and fills a
// pile in that coin with The Alchemist on the buyers' side; the page then creates it. Registers a one-hop ETH → PAXG
// row as the shop suite's fee life does (shop/fees-life.e2e.mjs), and moves the chain one day for its notice.
test('ALCH-TEMPLATE Alchemist coin pile: hidden without a row, shown with one, created through the page', async ({ page }) => {
  const wallet = await testWallet(page, chain, { create: true });
  const tile = page.getByRole('button', { name: /^Alchemist coin pile/ });
  await page.goto('/create/v2-basics');
  await page.getByRole('group', { name: /^Priced in/ }).getByRole('radio', { name: /^ETH\b/ }).check();
  await expect(page.getByRole('button', { name: /^Coin pile/ })).toBeVisible();
  await expect(tile, 'no row resolves yet: the tile is hidden').toHaveCount(0);

  const manifest = JSON.parse(readFileSync(chain.manifest, 'utf8'));
  const release = manifest.releases[0];
  const pm = getAddress(manifest.chain.poolManager.address);
  const gold = getAddress(chain.paxg);
  const { actor } = chain.accounts;
  const E18 = 10n ** 18n;
  const key = { currency0: zeroAddress, currency1: gold, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
  const router = artifact('PoolModifyLiquidityTest');
  const liquidity = getAddress((await send(chain, actor, null, `${router.bytecode.object}${encodeAbiParameters([{ type: 'address' }], [pm]).slice(2)}`, 0n, 10_000_000n)).contractAddress);
  await call(chain, actor, 'PoolManager', pm, 'initialize', [key, 2n ** 96n]);
  const coinAbi = artifact('LocalPAXG', { sourceFile: 'LocalQuoteMocks.sol' }).abi;
  await send(chain, actor, gold, encodeFunctionData({ abi: coinAbi, functionName: 'mint', args: [actor, 1_000n * E18] }));
  await send(chain, actor, gold, encodeFunctionData({ abi: coinAbi, functionName: 'approve', args: [liquidity, maxUint256] }));
  await send(chain, actor, liquidity, encodeFunctionData({ abi: router.abi, functionName: 'modifyLiquidity', args: [key, { tickLower: -887_220, tickUpper: 887_220, liquidityDelta: 100n * E18, salt: toHex(0n, { size: 32 }) }, '0x'] }), 200n * E18);
  const module = await deployAlchemist(chain, release, pm, [{ kind: 4, tokenIn: zeroAddress, tokenOut: gold, pool: pm, fee: 3000, tickSpacing: 60 }], E18, 10n ** 9n);
  const client = localClient(chain);
  const [, , directory] = await client.readContract({ abi: receiverModulesV21Abi, address: release.implementations.receiver.address, functionName: 'receiverCode' });
  const lister = await client.readContract({ abi: feeModuleDirectoryV21Abi, address: directory, functionName: 'lister' });
  await rpc(chain.rpcUrl, 'anvil_impersonateAccount', [lister]);
  await rpc(chain.rpcUrl, 'anvil_setBalance', [lister, toHex(E18)]);
  const registered = await send(chain, lister, directory, encodeFunctionData({ abi: feeModuleDirectoryV21Abi, functionName: 'register', args: [module] }));
  await rpc(chain.rpcUrl, 'anvil_stopImpersonatingAccount', [lister]);
  const event = registered.logs.map((log) => { try { return decodeEventLog({ abi: feeModuleDirectoryV21Abi, data: log.data, topics: log.topics }); } catch { return null; } }).find((e) => e?.eventName === 'Registered');
  await mineTo(chain.rpcUrl, BigInt(event.args.readyAt) + 1n);
  const id = Number(event.args.id);

  await page.reload();
  await page.getByRole('group', { name: /^Priced in/ }).getByRole('radio', { name: /^ETH\b/ }).check();
  await expect(tile).toBeVisible({ timeout: 60_000 });
  await expect(tile).toContainText('Coin pile · The Alchemist');
  await shot(page, 'alch-template-row');
  await tile.click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Local Lead');
  await page.getByRole('textbox', { name: 'Ticker' }).fill('LEAD');
  await page.locator('#create-logo').setInputFiles({ name: 'lead.png', mimeType: 'image/png', buffer: Buffer.from(makePng({ width: 512, height: 512, decodable: true })) });
  await expect(page.locator('#create-logo-action')).toHaveText('Change');
  const next = () => page.getByRole('button', { name: 'Next', exact: true }).click();
  await next();
  // The label carries a short address only while two listed coins share the symbol (the local Junkyard coin is TEST_GOLD
  // since SH-EX-L3 af1); the radio's value pins the exact coin either way.
  const seedCoin = page.getByRole('group', { name: 'Seed coin' }).getByRole('radio', { checked: true });
  await expect(seedCoin).toHaveAccessibleName(new RegExp(`^PAXG(?: · ${gold.slice(0, 6)}…${gold.slice(-4)})?$`));
  await expect(seedCoin).toHaveAttribute('value', new RegExp(`^${gold}$`, 'i'));
  await page.getByRole('textbox', { name: /^Seed · PAXG/ }).fill('0');
  await next();
  const buyers = page.getByRole('group', { name: /^Buyers’ fees · in ETH/ });
  await expect(buyers.getByRole('button', { name: 'The Alchemist' })).toHaveAttribute('aria-pressed', 'true', { timeout: 60_000 });
  await expect(buyers.locator(`[data-alchemist="${id}"]`)).toBeVisible();
  await expect(page.getByRole('group', { name: /^Sellers’ fees · paid in LEAD, used as ETH/ }).getByRole('button', { name: 'Buy back and burn LEAD' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-inbox-side]')).toHaveText('Inbox money follows the buyers’ side.');
  await expect(page.locator('[data-alchemist-inbox]')).toHaveCount(0);
  await shot(page, 'alch-template-fees');
  // The Alchemist on the sellers' side only: the inbox will not feed it.
  await page.getByRole('group', { name: /^Sellers’ fees · paid in LEAD, used as ETH/ }).getByRole('button', { name: 'The Alchemist' }).click();
  await buyers.getByRole('button', { name: 'Buy back and burn LEAD' }).click();
  await expect(page.locator('[data-alchemist-inbox]')).toHaveText('The inbox will not feed the sellers’ Alchemist.');
  await shot(page, 'alch-template-sellers-only');
  await buyers.getByRole('button', { name: 'The Alchemist' }).click();
  await page.getByRole('group', { name: /^Sellers’ fees · paid in LEAD, used as ETH/ }).getByRole('button', { name: 'Buy back and burn LEAD' }).click();
  await next(); await next();
  await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check(); await next();
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  expect(wallet.requests, 'navigation never asks the wallet').toEqual([]);

  const registry = await read(chain, 'BoxFactoryV2', chain.factory, 'registry');
  const before = await read(chain, 'BoxRegistryV2', registry, 'boxCount');
  await connect(page);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('[data-create-status]')).toHaveText('Created · 1/1', { timeout: 90_000 });
  const coordinator = await read(chain, 'BoxRegistryV2', registry, 'coordinatorOf', [before]);
  expect(await read(chain, 'BoxCoordinatorV2', coordinator, 'pricingListingId')).toBe(0);
  const sent = decoded('BoxFactoryV2', wallet.sent.at(-1));
  expect(sent.functionName).toBe('createBox');
  expect(sent.args[0].boxType).toBe(5);
  expect(sent.args[0].buyers.a.dest).toBe(9);
  await shot(page, 'alch-template-created');
});

// SH-SHOP-CREATE: a shop with ten starter items and no curator, created through the page's own buttons. The genesis'
// test collection (HostileCollection, anyone mints; TEST ONLY) gives the test account ten items; after createBox the page
// approves each one to the created shop, loads the page of ten through the starter loader, then the seed; the shop then
// holds the ten, its curator is zero and its gate is open. Ids 9001 to 9010: the genesis box uses 0 to 9 and 100.
test('SH-SHOP-CREATE the page creates a shop with ten starter items and no curator', async ({ page }) => {
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
  const wallet = await testWallet(page, chain, { create: true });
  const { actor } = chain.accounts;
  const nft = getAddress(chain.nft);
  wallet.allow(nft, 'HostileCollection', 'local.nft');
  const ids = Array.from({ length: 10 }, (_, i) => 9001n + BigInt(i));
  for (const id of ids) await call(chain, actor, 'HostileCollection', nft, 'mint', [actor, id]);
  const listing = await read(chain, 'ListingRegistry', await read(chain, 'BoxFactoryV2', chain.factory, 'listingRegistry'), 'listing', [0]);

  await page.goto('/create/v2-basics');
  await page.locator('[data-template="shop"]').click();
  await page.getByRole('group', { name: /^Priced in/ }).getByRole('radio', { name: /^ETH\b/ }).check();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Local Cans');
  await page.getByRole('textbox', { name: 'Ticker', exact: true }).fill('LCANS');
  await page.locator('#create-logo').setInputFiles({ name: 'cans.png', mimeType: 'image/png', buffer: Buffer.from(makePng({ width: 512, height: 512, decodable: true })) });
  await expect(page.locator('#create-logo-action')).toHaveText('Change');
  const next = () => page.getByRole('button', { name: 'Next', exact: true }).click();
  await next();
  await page.getByRole('textbox', { name: 'Seed · LCANS' }).fill('1000');
  for (const [i, price] of ['1', '2', '4', '8'].entries()) await page.getByRole('textbox', { name: `Tier ${i + 1}`, exact: true }).fill(price);
  await page.getByRole('textbox', { name: 'Collection 1' }).fill(nft);
  await expect(page.locator('#create-v2-shop-collection-0-hint')).toHaveText('ERC-721');
  await page.getByRole('textbox', { name: 'Starter ids 1', exact: true }).fill('9001-9010');
  await page.getByRole('group', { name: /^Curator/ }).getByRole('radio', { name: /^No curator/ }).check();
  await shot(page, 'shop-starters-contents');
  await next(); await next(); await next();
  await page.getByRole('radio', { name: /^Now/ }).check();
  await page.getByRole('textbox', { name: 'Your ETH at start' }).fill(formatUnits(listing.raise / 100n, 18));
  await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check();
  await next();
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  const plan = page.locator('.sh-v2-send');
  const approvals = ids.map((_, i) => `Approve starter ${i + 1}/10`);
  await expect(plan.getByRole('listitem')).toHaveText(['Create the box', ...approvals, 'Load starter items 1/1', 'Approve the seed · 1000 LCANS', 'Fund the shop', 'Open the shop']);
  expect(wallet.requests, 'navigation never asks the wallet').toEqual([]);

  const registry = await read(chain, 'BoxFactoryV2', chain.factory, 'registry');
  const before = await read(chain, 'BoxRegistryV2', registry, 'boxCount');
  const starters = page.getByRole('region', { name: 'Contents' }).locator('.sh-newbox-row').filter({ has: page.locator('dt', { hasText: /^Starter items$/ }) }).locator('dd');
  await expect(starters).toHaveText('10 · Connect the wallet that holds the starter items.');
  await connect(page);
  // The chain answers for each item (ownerOf: the connected wallet's) before Create sends anything.
  await expect(starters).toHaveText('10', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('[data-create-status]')).toHaveText('Created · 15/15', { timeout: 240_000 });
  expect(await read(chain, 'BoxRegistryV2', registry, 'boxCount')).toBe(before + 1n);
  const coordinator = await read(chain, 'BoxRegistryV2', registry, 'coordinatorOf', [before]);
  expect((await read(chain, 'BoxCoordinatorV2', coordinator, 'creator')).toLowerCase()).toBe(actor.toLowerCase());
  const vault = await read(chain, 'BoxCoordinatorV2', coordinator, 'roleAddress', [3n]);
  const loader = await read(chain, 'BoxCoordinatorV2', coordinator, 'starterSetLoader');
  // No curator: the zero address, a fixed list. The ten items are the shop's; the loader is done; the seed arrived; the gate opened.
  expect(await read(chain, 'ShopVaultV2', vault, 'curator')).toBe(zeroAddress);
  for (const id of ids) expect(await read(chain, 'HostileCollection', nft, 'ownerOf', [id]), String(id)).toBe(vault);
  expect(await read(chain, 'StarterSetLoaderV2', loader, 'progress')).toEqual([10, `0x${'00'.repeat(32)}`, true]);
  expect(await read(chain, 'ShopVaultV2', vault, 'seedReady')).toBe(true);
  expect(await read(chain, 'BoxCoordinatorV2', coordinator, 'starterSetPending')).toBe(false);
  expect(await read(chain, 'ShopVaultV2', vault, 'inside')).toBe(10n);
  // The wallet saw createBox, then exactly approve(shop, id) on the collection for each item in order, the page, the seed.
  const sent = wallet.sent;
  expect(decoded('BoxFactoryV2', sent[0]).functionName).toBe('createBox');
  expect(sent.slice(1, 11).map((tx) => [tx.to.toLowerCase(), ...decodeFunctionData({ abi: artifact('HostileCollection').abi, data: tx.data }).args])).toEqual(ids.map((id) => [nft.toLowerCase(), vault, id]));
  expect(decoded('StarterSetLoaderV2', sent[11]).functionName).toBe('load');
  expect(sent.slice(12).map((tx) => tx.to.toLowerCase())).toEqual([(await read(chain, 'BoxCoordinatorV2', coordinator, 'token')).toLowerCase(), vault.toLowerCase(), loader.toLowerCase()]);
  expect(sent.some((tx) => tx.data.startsWith('0xa22cb465')), 'never setApprovalForAll').toBe(false);
  await shot(page, 'shop-starters-created');
});
