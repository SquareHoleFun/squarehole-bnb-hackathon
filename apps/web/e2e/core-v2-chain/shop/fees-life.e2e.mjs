/**
 * SH-V21-FE14, chain-backed, on the shop life's stack (stack.mjs: a fresh anvil with the release, the real indexer, an
 * art gateway for the pictures the browser commits, and the site as a build).
 *
 * 1. Into the shop: the browser creates a shop whose sellers' fees go into it up to 8x its seed; the factory creates
 *    exactly that spec; a sale before graduation pays its 1% fee in the box's coin, which the hook holds and burns at
 *    graduation (F137), so no sellers' P waits then; after graduation a sale's coin fee becomes sellers' P, waiting for
 *    the shop, only through the hook's public sellFees step (our keeper's hourly fallback, sent here from node); then
 *    anyone's shop step (the keeper's ordinary job) either buys the box's coin into the shop or, when the room left is
 *    worth less than one step, pays the share to holders; the box page shows each figure as the chain reads it.
 * 2. The Alchemist: a hookless ETH/PAXG pool in the release's PoolManager, an Alchemist action with that one-hop route,
 *    registered in the release's own directory by its lister (impersonated: on a fresh anvil only, as the platform Safe
 *    would send it) and matured for its one day. The browser offers The Alchemist for an ETH-priced PAXG pile only then,
 *    with the route its helper holds; the factory creates exactly that spec; after graduation the conversion moves the
 *    buyers' waiting ETH into the pile as PAXG from the separate keeper trigger, without waiting seven days;
 *    the pile panel shows the ETH converted, the ETH waiting, the PAXG
 *    added and the redeemable balance, each as the chain reads it.
 *
 * The page never sends: every transaction here is the test's own, from the anvil's unlocked accounts, and the browser
 * wallet is asked only to connect (a shop's curator). SH_EVIDENCE_SCREENSHOTS=1 writes the pages at 1440 px and 375 px
 * to SH_EVIDENCE_OUT (outside the repository by default).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { decodeAbiParameters, decodeEventLog, encodeAbiParameters, encodeFunctionData, erc20Abi, formatUnits, getAddress, maxUint256, toHex, zeroAddress } from 'viem';
import { makePng } from '../../../../../packages/artwork/src/test-support/images.ts';
import { alchemistSideV21, alchemistV21Abi, feeModuleDirectoryV21Abi, pileConfigV2, receiverModulesV21Abi, receiverShopV21Abi } from '../../../../../packages/chain/src/core/v2/index.ts';
import { feeChoiceV2 } from '../../../../../packages/indexer/src/core/v2/views-v2.ts';
import { artifact, readLocalBox } from '../../../../../packages/chain/scripts/lib/core-v2-local-manifest.mjs';
import { mineTo, rpc } from '../../../../../packages/chain/scripts/lib/core-v2-local-runtime.mjs';
import { writeExampleArt } from '../../../../../packages/chain/scripts/lib/core-v2-local-example-art.mjs';
import { localClient, recipe } from '../../../../../packages/chain/scripts/local-core-v2-chain.mjs';
import { E18, boxPath, call, download, figure, read, salts, send, shots } from './life.mjs';
import { ART, CHAIN_FILE } from './support.mjs';
import { WALLET_NAME, shopWallet } from './wallet.mjs';
import { deployAlchemist } from './alchemist.mjs';

const LINE = 'Fees fill the shop up to a ceiling, then go to holders.';
const WARNING = 'Whoever picks the collections decides who can sell into a budget the fees pay for.';
const logo = (width) => Buffer.from(makePng({ width, height: width, decodable: true }));
const next = (page) => page.getByRole('button', { name: 'Next', exact: true }).click();
const heading = (page) => page.getByRole('heading', { level: 1 });
const row = (scope, term) => scope.locator('.sh-newbox-row').filter({ has: scope.page().locator('dt', { hasText: new RegExp(`^${term}$`) }) }).locator('dd');
const eth = (raw) => `${formatUnits(raw, 18)} ETH`;
/** G1-INT, RC5-B: the action's dust size, the largest raw-P step a pool may pay nothing for and still stay in the box's pool depth. */
const DUST = 10n ** 9n;
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The decoded `eventName` logs a receipt carries from `address`, read with `name`'s artifact ABI. */
function eventsOf(receipt, name, address, eventName) {
  return receipt.logs.filter((log) => log.address.toLowerCase() === address.toLowerCase()).flatMap((log) => {
    try {
      const event = decodeEventLog({ abi: artifact(name).abi, data: log.data, topics: log.topics });
      return event.eventName === eventName ? [event.args] : [];
    } catch { return []; }
  });
}
/**
 * F137: after graduation a sale's 1% fee in the box's coin reaches the sellers' side only through the hook's public
 * sellFees() step, one per block within 49 ticks; below the step minimum it skips. Trade (the local life's recipe 1)
 * and press until one step sells, as the example lives and the local life do; returns that step's FeesSold.
 */
async function sellGraduatedFees(chain, box) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    await recipe(chain, 1, box.coordinator);
    const receipt = await call(chain, chain.accounts.keeper, 'BoxHookV2', box.hook, 'sellFees');
    const [sold] = eventsOf(receipt, 'BoxHookV2', box.hook, 'FeesSold');
    if (sold) return sold;
  }
  throw new Error(`the graduated sale fees of ${box.coordinator} never reached the step minimum`);
}
function chainOf() {
  const chain = JSON.parse(readFileSync(CHAIN_FILE, 'utf8'));
  chain.accounts = Object.fromEntries(Object.entries(chain.accounts).map(([key, address]) => [key, getAddress(address)]));
  return chain;
}
/** The run's measured figures (raw units as decimal strings), beside the pictures, for the evidence. */
function record(name, figures) {
  const out = process.env.SH_EVIDENCE_OUT ?? join(tmpdir(), 'sh-v21-fe13-shots');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${name}.json`), `${JSON.stringify(figures, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2)}\n`);
}
/** The indexer audits every 32 blocks: mine past two audits so the page is neither Checking nor Unverified. */
const settle = (chain) => rpc(chain.rpcUrl, 'anvil_mine', ['0x48']);
/** The box page once the indexer has it current and verified. */
async function openBox(page, chain, token, name) {
  await page.goto(boxPath(chain, token));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name, { timeout: 120_000 });
  // SH-255 round 3 (D18): the picture's header is there (past its loading heading), so no notice in it is a real check.
  await expect(page.locator('header.sh-bpic-head')).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('main p').filter({ hasText: /^(Checking|Unverified|Stale) ·/ })).toHaveCount(0, { timeout: 120_000 });
}
/** Logo, factory salts and createBox exactly as the BoxSpec file says, from the creator; returns the box's roles. */
async function createFromFile(chain, file, id) {
  const specAbi = artifact('BoxFactoryV2').abi.find((entry) => entry.type === 'function' && entry.name === 'createBox').inputs[0];
  const [spec] = decodeAbiParameters([specAbi], file.encoded);
  const [picture] = file.pictures;
  expect(picture.sha256).toBe(spec.coverSha256);
  writeExampleArt(ART, id, [{ role: 'logo', sha256: spec.coverSha256, bytes: Buffer.from(picture.base64, 'base64') }]);
  const q = await read(chain, 'BoxFactoryV2', chain.factory, 'boxQParameters', [spec.pricing.listingId, spec.raise]);
  const predicted = await salts(chain, spec);
  await send(chain, chain.accounts.actor, chain.factory, encodeFunctionData({ abi: artifact('BoxFactoryV2').abi, functionName: 'createBox', args: [spec, predicted.cs, predicted.hs] }), q.bootstrapQ + spec.creatorBuy, 16_777_216n);
  expect(await read(chain, 'BoxCoordinatorV2', predicted.coordinator, 'specHash')).toBe(file.specHash);
  return { spec, state: await readLocalBox(chain, predicted.coordinator) };
}

test('SH-V21-FE14 shop fees life: Into the shop chosen in the browser; its waiting P, then the shop step, on the box page', async ({ page }) => {
  const chain = chainOf();
  const { actor, keeper } = chain.accounts;
  const wallet = await shopWallet(page, chain);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const listing = await read(chain, 'ListingRegistry', await read(chain, 'BoxFactoryV2', chain.factory, 'listingRegistry'), 'listing', [0]);
  const NAME = 'Scrap Shop'; const TICKER = 'SCRAP';

  // 1. The create flow: the Shop template, its settings, Into the shop at 8x on the sellers' side.
  await test.step('create flow → BoxSpec', async () => {
    await page.goto('/create/v2-basics');
    await page.locator('[data-template="shop"]').click();
    await page.getByRole('group', { name: /^Priced in/ }).getByRole('radio', { name: /^ETH\b/ }).check();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill(NAME);
    await page.getByRole('textbox', { name: 'Ticker', exact: true }).fill(TICKER);
    await page.locator('#create-logo').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: logo(512) });
    await expect(page.locator('#create-logo-action')).toHaveText('Change');
    await next(page);
    await page.getByRole('textbox', { name: `Seed · ${TICKER}` }).fill('1000');
    for (const [i, price] of ['1', '2', '4', '8'].entries()) await page.getByRole('textbox', { name: `Tier ${i + 1}`, exact: true }).fill(price);
    await page.getByRole('textbox', { name: 'Collection 1' }).fill(getAddress(chain.nft));
    await expect(page.locator('#create-v2-shop-collection-0-hint')).toHaveText('ERC-721');
    await next(page);
    const buyers = page.getByRole('group', { name: /^Buyers’ fees/ }); const sellers = page.getByRole('group', { name: /^Sellers’ fees/ });
    await expect(buyers.getByRole('button', { name: 'Into the shop' })).toHaveCount(0);
    await sellers.getByRole('button', { name: 'Into the shop' }).click();
    const ceiling = sellers.getByRole('group', { name: 'Ceiling' });
    await ceiling.getByRole('button', { name: /^8x/ }).click();
    await expect(ceiling.getByRole('button', { name: /^8x/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(ceiling.getByRole('button', { name: /^8x/ })).toHaveText(`8x the seed8000 ${TICKER}`);
    await expect(sellers.getByText(LINE, { exact: true })).toBeVisible();
    await expect(sellers.getByText(WARNING, { exact: true })).toBeVisible();
    await shots(page, 'chain-create-shop-fees');
    await next(page); await next(page);
    await page.getByRole('radio', { name: /^Now/ }).check();
    await page.getByRole('textbox', { name: 'Your ETH at start' }).fill(formatUnits(listing.raise / 100n, 18));
    await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check();
    await next(page);
    await expect(heading(page)).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
    expect(wallet.requests, 'navigation must never touch the wallet').toEqual([]);
    await page.getByRole('banner').locator('.sh-wallet-button').click();
    await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: WALLET_NAME }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const fees = page.getByRole('region', { name: 'Fees' });
    await expect(row(fees, 'Sellers’ fees')).toHaveText(`Into the shop · ceiling 8x the seed (8000 ${TICKER}) · paid in ${TICKER}, used as ETH`);
    await expect(fees.getByText(WARNING, { exact: true })).toBeVisible();
    await shots(page, 'chain-create-shop-fees-overview');
  });
  const file = await download(page, 'Download BoxSpec');
  // The side as the chain package writes and reads it: BuyT / BudgetOrPile with the ceiling word 8.
  const { spec, state: created } = await createFromFile(chain, file, 'fees-life-shop');
  expect(spec.sellers.a).toEqual({ leg: 2, dest: 7, legParams: '0x', destParams: toHex(8n, { size: 32 }) });
  expect(feeChoiceV2(spec.sellers)).toBe('shop');
  expect(feeChoiceV2(spec.buyers)).toBe('holders');

  // 2. Seed, opening, a curve sale (its fee is the box's coin, held and then burned: F137), collection, fill and
  //    graduation; then a graduated sale whose coin fee the hook's sellFees step sells for sellers' P, and collection.
  const box = await test.step('seed, curve sale, fill, graduate, then a graduated sale, its fee step and collection', async () => {
    const seedT = 1000n * E18;
    expect(created.actorT, 'the first buy brought at least the seed').toBeGreaterThanOrEqual(seedT);
    const loader = await read(chain, 'BoxCoordinatorV2', created.coordinator, 'starterSetLoader');
    await call(chain, actor, 'BoxTokenV2', created.token, 'approve', [created.vault, seedT]);
    await call(chain, actor, 'ShopVaultV2', created.vault, 'fundSeed');
    await call(chain, keeper, 'StarterSetLoaderV2', loader, 'complete');
    // The gate opens once the seed is in: trade after the launch window, from the opening it fixed.
    const opened = await readLocalBox(chain, created.coordinator);
    expect(opened.gateOpen).toBe(true);
    await mineTo(chain.rpcUrl, opened.openAt + 384n);
    // The ceiling is the saturating seed times the preset, as the spec fixed it.
    expect(await read(chain, 'ShopVaultV2', created.vault, 'ceilingT')).toBe(8n * seedT);
    await recipe(chain, 1, created.coordinator);
    await call(chain, keeper, 'BoxReceiverV2', created.receiver, 'collect', [keeper]);
    // F137: a curve sale pays 1% of the coins it sells; the hook holds that fee as its PoolManager claim in the box's
    // coin (realized at collection) and burns it at graduation, so no sellers' P waits for the shop yet.
    const poolManager = await read(chain, 'BoxHookV2', created.hook, 'poolManager');
    const heldT = await read(chain, 'PoolManager', poolManager, 'balanceOf', [created.hook, BigInt(created.token)]);
    expect(heldT, 'the curve sale’s fee held in the box’s coin').toBeGreaterThan(0n);
    expect(await read(chain, 'BoxReceiverV2', created.receiver, 'modulePendingP', [true]), 'no sellers’ P from a curve sale').toBe(0n);
    await recipe(chain, 2, created.coordinator);
    const graduation = await call(chain, keeper, 'BoxCoordinatorV2', created.coordinator, 'graduate');
    const [migrated] = eventsOf(graduation, 'BoxHookV2', created.hook, 'MigratedV2');
    expect(migrated?.tBurned ?? 0n, 'the held coin fee burned at graduation').toBeGreaterThanOrEqual(heldT);
    const graduated = await readLocalBox(chain, created.coordinator);
    expect(graduated.graduated).toBe(true);
    // After graduation the shop still wants fees (its budget is below the ceiling): a graduated sale's coin fee, once
    // the public sellFees step has sold it for P, is collected as sellers' P and waits for the shop.
    const feesSold = await sellGraduatedFees(chain, graduated);
    expect(feesSold.pOut, 'the graduated sale fee sold for P').toBeGreaterThan(0n);
    await call(chain, keeper, 'BoxReceiverV2', created.receiver, 'collect', [keeper]);
    const waiting = await read(chain, 'BoxReceiverV2', created.receiver, 'modulePendingP', [true]);
    expect(waiting, 'sellers’ P waiting for the shop').toBeGreaterThan(0n);
    const state = await readLocalBox(chain, created.coordinator);
    await settle(chain);
    return { ...state, waiting, heldT, burnedT: migrated.tBurned, feesSold };
  });
  wallet.allow(box.token, 'BoxTokenV2', 'fees-life.token'); wallet.allow(box.vault, 'ShopVaultV2', 'fees-life.shop');
  const requestsBefore = wallet.requests.length;

  // 3. The box page before the shop step: the fixed ceiling, the live budget, nothing from fees yet, the P waiting.
  const part = () => page.locator('section[data-shop-fees]');
  await test.step('the page: waiting for the shop step', async () => {
    await openBox(page, chain, box.token, NAME);
    await expect(part().getByRole('heading', { name: 'Fees into the shop', level: 3 })).toBeVisible();
    const pending = await read(chain, 'BoxReceiverV2', box.receiver, 'modulePendingP', [true]);
    const [budget, ceiling, feesT, wanted] = await Promise.all(['budgetT', 'ceilingT', 'feesT', 'feesWanted'].map((fn) => read(chain, 'ShopVaultV2', box.vault, fn)));
    await expect(figure(part(), 'Ceiling')).toHaveText(`${formatUnits(ceiling, 18)} ${TICKER} · 8x the seed`);
    await expect(figure(part(), 'Budget')).toHaveText(`${formatUnits(budget, 18)} ${TICKER}`);
    await expect(figure(part(), 'From fees')).toHaveText(`${formatUnits(feesT, 18)} ${TICKER}`);
    await expect(figure(part(), 'Waiting')).toHaveText(eth(pending));
    await expect(part().locator('.sh-chip')).toHaveText(wanted && budget < ceiling ? 'Filling' : 'Full');
    await expect(part().getByText(LINE, { exact: true })).toBeVisible();
    await expect(part().getByText(WARNING, { exact: true })).toBeVisible();
    await expect(page.getByText('Into the shop · ceiling 8x the seed', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Holder fee share' })).toBeVisible();
    await shots(page, 'chain-shop-fees-waiting', part);
  });

  // 4. The shop step (permissionless; the keeper's ordinary shopFees job), then the page again.
  await test.step('the shop step, and the page after it', async () => {
    const receipt = await call(chain, keeper, 'BoxReceiverV2', box.receiver, 'executeModule', [true]);
    const events = receipt.logs.filter((log) => log.address.toLowerCase() === box.receiver.toLowerCase()).flatMap((log) => {
      try { return [decodeEventLog({ abi: receiverShopV21Abi, data: log.data, topics: log.topics })]; } catch { return []; }
    });
    const toHolders = events.filter((e) => e.eventName === 'ShopHoldersFunded').reduce((sum, e) => sum + e.args.amountP, 0n);
    const spent = events.filter((e) => e.eventName === 'ShopFunded').reduce((sum, e) => sum + e.args.spentP, 0n);
    // Every raw unit waiting resolved: bought into the shop or paid to holders, nothing stranded.
    expect(spent + toHolders).toBe(box.waiting);
    expect(await read(chain, 'BoxReceiverV2', box.receiver, 'modulePendingP', [true])).toBe(0n);
    await settle(chain);
    const feesT = await read(chain, 'ShopVaultV2', box.vault, 'feesT');
    await page.reload();
    await expect(page.locator('header.sh-bpic-head')).toBeVisible({ timeout: 120_000 });
    await expect(page.locator('main p').filter({ hasText: /^(Checking|Unverified|Stale) ·/ })).toHaveCount(0, { timeout: 120_000 });
    await expect(figure(part(), 'Waiting')).toHaveText(eth(0n), { timeout: 120_000 });
    await expect(figure(part(), 'From fees')).toHaveText(`${formatUnits(feesT, 18)} ${TICKER}`);
    await expect(figure(part(), 'To holders')).toHaveText(eth(toHolders));
    await part().getByText('How fees fill the shop', { exact: true }).click();
    if (spent > 0n) await expect(part().getByText(new RegExp(`So far ${formatUnits(spent, 18)} ETH bought`))).toBeVisible();
    await shots(page, 'chain-shop-fees-after', part);
    record('fees-life-shop', { box: box.token, shop: box.vault, curveFeeHeldT: box.heldT, burnedAtGraduationT: box.burnedT,
      feesSold: box.feesSold, waitingP: box.waiting, spentP: spent, feesT, toHoldersP: toHolders, ceilingT: 8000n * E18 });
  });
  expect(wallet.requests.slice(requestsBefore).filter((method) => method !== 'eth_accounts' && method !== 'eth_chainId'), 'the box page sends nothing').toEqual([]);
  expect(wallet.sent).toEqual([]);
  expect(errors).toEqual([]);
});

test('SH-V21-FE14 Alchemist life: a registered route, offered for an ETH-priced PAXG pile, converts the buyers’ fees into the pile', async ({ page }) => {
  test.setTimeout(900_000);
  const chain = chainOf();
  const { actor, keeper } = chain.accounts;
  const wallet = await shopWallet(page, chain);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const manifest = JSON.parse(readFileSync(chain.manifest, 'utf8'));
  const release = manifest.releases[0];
  const pm = getAddress(manifest.chain.poolManager.address);
  const gold = getAddress(chain.paxg);
  const NAME = 'Lead Pile'; const TICKER = 'LEAD';

  // 1. On chain: a hookless static-fee ETH/PAXG pool in the release's PoolManager, with full-range liquidity.
  const route = [{ kind: 4, tokenIn: zeroAddress, tokenOut: gold, pool: pm, fee: 3000, tickSpacing: 60 }];
  const { module, id } = await test.step('pool, action, registration and its one day', async () => {
    const key = { currency0: zeroAddress, currency1: gold, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
    const router = artifact('PoolModifyLiquidityTest');
    const deployed = await send(chain, actor, null, `${router.bytecode.object}${encodeAbiParameters([{ type: 'address' }], [pm]).slice(2)}`, 0n, 10_000_000n);
    const liquidity = getAddress(deployed.contractAddress);
    await call(chain, actor, 'PoolManager', pm, 'initialize', [key, 2n ** 96n]);
    const coin = artifact('LocalPAXG', { sourceFile: 'LocalQuoteMocks.sol' }).abi;
    await send(chain, actor, gold, encodeFunctionData({ abi: coin, functionName: 'mint', args: [actor, 1_000n * E18] }));
    await send(chain, actor, gold, encodeFunctionData({ abi: coin, functionName: 'approve', args: [liquidity, maxUint256] }));
    await send(chain, actor, liquidity, encodeFunctionData({ abi: router.abi, functionName: 'modifyLiquidity', args: [key, { tickLower: -887_220, tickUpper: 887_220, liquidityDelta: 100n * E18, salt: toHex(0n, { size: 32 }) }, '0x'] }), 200n * E18);
    // 2. The action: the release's PoolManager and implementations, this one-hop route; its helper deploys with it.
    const module = await deployAlchemist(chain, release, pm, route, E18, DUST);
    // As addresses, not strings: the getter answers checksummed, eth_accounts (the chain file's keeper) lowercase.
    expect(getAddress(actor)).not.toBe(getAddress(keeper));
    expect(await localClient(chain).readContract({ abi: alchemistV21Abi, address: module, functionName: 'conversionTrigger' })).toBe(getAddress(keeper));
    expect(await localClient(chain).readContract({ abi: alchemistV21Abi, address: module, functionName: 'dustMax' })).toBe(DUST);
    // 3. The release's directory (its receiver's receiverCode) and its lister, which alone may register.
    const [, , directory] = await localClient(chain).readContract({ abi: receiverModulesV21Abi, address: release.implementations.receiver.address, functionName: 'receiverCode' });
    const lister = await localClient(chain).readContract({ abi: feeModuleDirectoryV21Abi, address: directory, functionName: 'lister' });
    await rpc(chain.rpcUrl, 'anvil_impersonateAccount', [lister]);
    await rpc(chain.rpcUrl, 'anvil_setBalance', [lister, toHex(10n ** 18n)]);
    const registered = await send(chain, lister, directory, encodeFunctionData({ abi: feeModuleDirectoryV21Abi, functionName: 'register', args: [module] }));
    await rpc(chain.rpcUrl, 'anvil_stopImpersonatingAccount', [lister]);
    const event = registered.logs.map((log) => { try { return decodeEventLog({ abi: feeModuleDirectoryV21Abi, data: log.data, topics: log.topics }); } catch { return null; } }).find((e) => e?.eventName === 'Registered');
    expect(event?.args.module).toBe(module);
    // 4. The one-day notice, then the row resolves.
    await mineTo(chain.rpcUrl, BigInt(event.args.readyAt) + 1n);
    const [resolved] = await localClient(chain).readContract({ abi: feeModuleDirectoryV21Abi, address: directory, functionName: 'resolve', args: [event.args.id] });
    expect(resolved).toBe(module);
    return { module, id: Number(event.args.id) };
  });

  // 5. The browser: The Alchemist only for this pair, with the route its helper holds.
  await test.step('create flow → BoxSpec', async () => {
    await page.goto('/create/v2-basics');
    await page.getByRole('group', { name: /^Priced in/ }).getByRole('radio', { name: /^ETH\b/ }).check();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill(NAME);
    await page.getByRole('textbox', { name: 'Ticker', exact: true }).fill(TICKER);
    await page.locator('#create-logo').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: logo(500) });
    await expect(page.locator('#create-logo-action')).toHaveText('Change');
    await next(page);
    await page.getByRole('radio', { name: /^Token/ }).check();
    await page.getByRole('group', { name: /^Coin pile/ }).getByRole('radio', { name: /^Coin pile/ }).check();
    // The release's PAXG, named by its address only while another listed coin is called PAXG too (the Junkyard's local
    // gold is tGOLD since cda491add, as the Alchemist create spec already allows).
    await page.getByRole('group', { name: 'Seed coin' }).getByRole('radio', { name: new RegExp(`^PAXG(?: · ${gold.slice(0, 6)}…${gold.slice(-4)})?$`) }).check();
    await page.getByRole('textbox', { name: /^Seed · PAXG/ }).fill('0');
    await page.getByRole('group', { name: 'Leave behind' }).getByRole('radio', { name: '5%' }).check();
    await next(page);
    const buyers = page.getByRole('group', { name: /^Buyers’ fees · in ETH/ });
    await buyers.getByRole('button', { name: 'The Alchemist' }).click({ timeout: 60_000 });
    const shown = buyers.locator(`[data-alchemist="${id}"]`);
    // SH-ALCHEMIST-LESS-TEXT: the route, its limits and its trigger wait behind the side's closed Details.
    await shown.getByRole('button', { name: 'Details: Alchemist, buyers’ fees' }).click();
    await expect(shown.getByText(`Route · row ${id}`)).toBeVisible();
    await expect(shown.locator('.sh-v2-route li')).toHaveText(['ETH → PAXG · Uniswap v4 · 0.3%']);
    // G1-INT: the row's dust size as the deployed module answers it (dustMax()); F153: its trigger by its short address.
    await expect(row(shown, 'Too small')).toHaveText(`${eth(DUST)} or less stays in the box’s pool depth`);
    const startedBy = `${getAddress(keeper).slice(0, 6)}…${getAddress(keeper).slice(-4)} · anyone after 7 days without a step`;
    await expect(row(shown, 'Started by')).toHaveText(startedBy);
    await shots(page, 'chain-create-alchemist-fees');
    await next(page); await next(page);
    await page.getByRole('radio', { name: /^Now/ }).check();
    await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check();
    await next(page);
    await expect(heading(page)).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
    const fees = page.getByRole('region', { name: 'Fees' });
    await expect(row(fees, 'Buyers’ fees')).toHaveText(`The Alchemist · row ${id} · in ETH`);
    // The route and its terms as a visitor reads them: behind the Fees group's Details, opened (SH-255 round 3, D18).
    const alchemistDetails = fees.getByRole('button', { name: 'Details: Alchemist' });
    if (await alchemistDetails.getAttribute('aria-expanded') !== 'true') await alchemistDetails.click();
    await expect(alchemistDetails).toHaveAttribute('aria-expanded', 'true');
    await expect(row(fees, 'Route')).toBeVisible();
    await expect(row(fees, 'Route')).toHaveText('ETH → PAXG · Uniswap v4 · 0.3%');
    await expect(row(fees, 'Too small')).toHaveText(`${eth(DUST)} or less stays in the box’s pool depth`);
    await expect(row(fees, 'Started by')).toHaveText(startedBy);
    await shots(page, 'chain-create-alchemist-overview');
    expect(wallet.requests, 'navigation must never touch the wallet').toEqual([]);
  });
  const file = await download(page, 'Download BoxSpec');
  // The factory resolves the row again at creation: it creates exactly this spec only while the row is selectable.
  const { spec, state: created } = await createFromFile(chain, file, 'fees-life-alchemist');
  expect(spec.buyers).toEqual(alchemistSideV21(id));
  expect(spec.boxType).toBe(5);
  expect(pileConfigV2(spec.contentsParams)).toEqual({ asset: gold, seedAmount: 0n, leaveBehindBps: 500n });
  const [snapshot] = await read(chain, 'BoxReceiverV2', created.receiver, 'sideModule', [false]);
  expect(getAddress(snapshot)).toBe(module);

  // 6. A trade before graduation (buyers' fees wait for the action), fill, graduation, then the conversion.
  const life = await test.step('trade, collect, fill, graduate, convert', async () => {
    await mineTo(chain.rpcUrl, created.openAt + 384n);
    const client = localClient(chain);
    const beforeFees = (await client.getBlock()).timestamp;
    await recipe(chain, 1, created.coordinator);
    await call(chain, keeper, 'BoxReceiverV2', created.receiver, 'collect', [keeper]);
    expect(await read(chain, 'BoxReceiverV2', created.receiver, 'modulePendingP', [false])).toBeGreaterThan(0n);
    await recipe(chain, 2, created.coordinator);
    await call(chain, keeper, 'BoxCoordinatorV2', created.coordinator, 'graduate');
    const waitingBefore = await read(chain, 'BoxReceiverV2', created.receiver, 'modulePendingP', [false]);
    expect((await client.getBlock()).timestamp - beforeFees, 'conversion must not rely on the seven-day fallback').toBeLessThan(604_800n);
    await expect(client.simulateContract({ abi: [...receiverModulesV21Abi, { type: 'error', name: 'ConversionTriggerOnly', inputs: [] }],
      address: created.receiver, functionName: 'executeModule', args: [false], account: actor })).rejects.toThrow(/ConversionTriggerOnly/);
    expect(await read(chain, 'BoxReceiverV2', created.receiver, 'modulePendingP', [false])).toBe(waitingBefore);
    const receipt = await call(chain, keeper, 'BoxReceiverV2', created.receiver, 'executeModule', [false]);
    const moduleEvents = receipt.logs.filter((log) => getAddress(log.address) === module).map((log) => decodeEventLog({ abi: alchemistV21Abi, data: log.data, topics: log.topics }));
    const converted = moduleEvents.find((e) => e.eventName === 'PileConverted');
    expect(converted, 'the conversion ran').toBeTruthy();
    // RC5-B: one step under the cap converts; no part of it moves to depth as dust.
    expect(moduleEvents.filter((e) => e.eventName === 'DustToDepth')).toEqual([]);
    expect(converted.args.amountIn).toBe(waitingBefore);
    expect(converted.args.amountOut).toBeGreaterThan(0n);
    expect(getAddress(converted.args.asset)).toBe(gold);
    const state = await readLocalBox(chain, created.coordinator);
    await settle(chain);
    return { state, converted: converted.args, waiting: await read(chain, 'BoxReceiverV2', created.receiver, 'modulePendingP', [false]) };
  });

  // 7. The box page: the side named, the figures apart, the route.
  await test.step('the page after the conversion', async () => {
    await openBox(page, chain, life.state.token, NAME);
    const panel = page.getByRole('region', { name: 'Coin pile' });
    // The figures as a visitor reads them: behind Pile details, opened first (round 3, D18; it was opened after them).
    const pileDetails = panel.getByRole('button', { name: 'Pile details' });
    if (await pileDetails.getAttribute('aria-expanded') !== 'true') await pileDetails.click();
    await expect(pileDetails).toHaveAttribute('aria-expanded', 'true');
    const balance = await localClient(chain).readContract({ abi: erc20Abi, address: gold, functionName: 'balanceOf', args: [life.state.vault] });
    await expect(figure(panel, 'Redeemable')).toHaveText(`${formatUnits(balance, 18)} PAXG`, { timeout: 120_000 });
    await expect(figure(panel, 'ETH converted')).toHaveText(eth(life.converted.amountIn));
    await expect(figure(panel, 'ETH waiting')).toHaveText(eth(life.waiting));
    await expect(figure(panel, 'Added by conversion')).toHaveText(`${formatUnits(life.converted.amountOut, 18)} PAXG`);
    // RC5-B: the real indexer's dust total (dustToDepthP), apart from the pile; this life moved none.
    await expect(figure(panel, 'ETH added to pool depth')).toHaveText(eth(0n));
    expect(balance).toBe(life.converted.amountOut);
    // SH-255: the checked module's name where the Fees card's row was: its line in the picture's Where the fees go.
    await expect(page.locator('.sh-bpic-ledger-place', { hasText: /^The Alchemist$/ })).toBeVisible({ timeout: 60_000 });
    await expect(panel.getByRole('list', { name: 'Conversion route' }).getByRole('listitem')).toHaveText(['ETH → PAXG · Uniswap v4 · 0.3%']);
    // G1: the cap and the trigger as the deployed module answers them (inputCap(), conversionTrigger()). F153: the trigger
    // by its short address, never called a keeper or said to send privately (here the fixture's keeper account; the page
    // cannot tell it from any other address).
    const inputCap = await localClient(chain).readContract({ abi: alchemistV21Abi, address: module, functionName: 'inputCap' });
    expect(inputCap).toBe(E18);
    const capLine = `Each step converts at most ${eth(inputCap)}; the rest waits for the next one.`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await expect(panel.getByText(new RegExp(`^${capLine}`))).toBeVisible();
    const trigger = getAddress(keeper);
    await expect(panel.getByText(new RegExp(`^Only ${escaped(`${trigger.slice(0, 6)}…${trigger.slice(-4)}`)} starts a step, until a side has waited 7 days without one;`))).toBeVisible();
    await expect(panel.getByText(/keeper|private/i)).toHaveCount(0);
    await expect(panel.getByText(new RegExp(`A step of at most ${escaped(eth(DUST))} that a pool would pay nothing for stays in this box instead, as ETH for its own pool’s next deepening`))).toBeVisible();
    await expect(panel.getByText(/Graduation and every step that goes through start the 7 days again; a refused try does not\./)).toBeVisible();
    await shots(page, 'chain-alchemist-pile', () => page.getByRole('region', { name: 'Coin pile' }));
    record('fees-life-alchemist', { box: life.state.token, pile: life.state.vault, module, row: id, deployer: actor, conversionTrigger: keeper,
      inputCapP: inputCap, dustMaxP: DUST, amountInP: life.converted.amountIn, amountOutPAXG: life.converted.amountOut, dustToDepthP: 0n, waitingP: life.waiting, pileBalance: balance });
  });
  expect(wallet.sent).toEqual([]);
  expect(errors).toEqual([]);
});
