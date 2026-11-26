/**
 * SH-V21-FE13, chain-backed: the browser creates a shop through the create flow (Shop template, its settings, the
 * BoxSpec download), the factory creates exactly that spec, the creator funds the seed and the box graduates, then the
 * box page gives two items, picks one and, as the curator, adds a collection, each through the page and the shared
 * sender, checked against the chain after every step. Real anvil, factory, shop, indexer and site; the wallet is this
 * Playwright context's own. Steps the site does not offer (createBox, the seed, the fill) are the test's node-side sends,
 * from the same unlocked accounts. SH_EVIDENCE_SCREENSHOTS=1 writes the pages at 1440 px and 375 px to SH_EVIDENCE_OUT
 * (default: a folder in the system's temporary directory), outside the repository: in run 1 the site was the dev server,
 * and a file written into the worktree reloaded its modules mid-test. The stack now serves a build (stack.mjs).
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { decodeAbiParameters, decodeFunctionData, encodeFunctionData, formatUnits, getAddress } from 'viem';
import { makePng } from '../../../../../packages/artwork/src/test-support/images.ts';
import { shopConfigV2 } from '../../../../../packages/chain/src/core/v2/m2-spec-v2.ts';
import { artifact, readLocalBox } from '../../../../../packages/chain/scripts/lib/core-v2-local-manifest.mjs';
import { mineTo, rpc } from '../../../../../packages/chain/scripts/lib/core-v2-local-runtime.mjs';
import { writeExampleArt } from '../../../../../packages/chain/scripts/lib/core-v2-local-example-art.mjs';
import { localClient, recipe } from '../../../../../packages/chain/scripts/local-core-v2-chain.mjs';
import { E18, boxPath, call, download, labelOf, read, salts, send, shots } from './life.mjs';
import { ART, CHAIN_FILE } from './support.mjs';
import { WALLET_NAME, shopWallet } from './wallet.mjs';

const NAME = 'Curio Corner';
const TICKER = 'CURIO';
const GIVE_IDS = [300n, 301n];
const panel = (page) => page.getByRole('region', { name: 'Shop' });
const section = (page, name) => panel(page).locator('section', { has: page.getByRole('heading', { name, level: 3 }) });
const figure = (scope, label) => scope.locator('dt', { hasText: new RegExp(`^${label}$`) }).locator('xpath=following-sibling::dd[1]');
const said = (page) => panel(page).locator('.sh-v2-shop-actions > [role="status"]');
/** Confirm in the page, then wait for the panel's one line: what was confirmed, or why nothing was. */
async function confirm(page) {
  await page.getByRole('group', { name: 'Confirm transaction' }).getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(said(page)).toBeVisible({ timeout: 60_000 });
}

test('SH-V21-FE13 shop life: create in the browser, give two items, pick one, add a collection', async ({ page }) => {
  const chain = JSON.parse(readFileSync(CHAIN_FILE, 'utf8'));
  chain.accounts = Object.fromEntries(Object.entries(chain.accounts).map(([key, address]) => [key, getAddress(address)]));
  const { actor, deployer, keeper } = chain.accounts;
  const nft = getAddress(chain.nft);
  const wallet = await shopWallet(page, chain);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const listing = await read(chain, 'ListingRegistry', await read(chain, 'BoxFactoryV2', chain.factory, 'listingRegistry'), 'listing', [0]);

  // 1. The create flow: the Shop template, its settings, holders on both sides, a first buy for the seed.
  await test.step('create flow → BoxSpec', async () => {
    await page.goto('/create/v2-basics');
    await page.locator('[data-template="shop"]').click();
    await expect(page.locator('[data-template="shop"]')).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('radio', { name: /^ETH\b/ }).check();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill(NAME);
    await page.getByRole('textbox', { name: 'Ticker', exact: true }).fill(TICKER);
    await page.locator('#create-logo').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from(makePng({ width: 512, height: 512, decodable: true })) });
    await expect(page.locator('#create-logo-action')).toHaveText('Change');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByRole('radio', { name: /^Shop/ })).toBeChecked();
    await page.getByRole('textbox', { name: `Seed · ${TICKER}` }).fill('1000');
    for (const [i, price] of ['1', '2', '4', '8'].entries()) await page.getByRole('textbox', { name: `Tier ${i + 1}`, exact: true }).fill(price);
    await page.getByRole('textbox', { name: 'Collection 1' }).fill(nft);
    // The chain says the local collection is an ERC-721 (supportsInterface(0x80ac58cd)), as the shop will check at Create.
    await expect(page.locator('#create-v2-shop-collection-0-hint')).toHaveText('ERC-721');
    await shots(page, 'chain-create-shop-contents');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    for (const side of ['Buyers', 'Sellers']) await expect(page.getByRole('group', { name: new RegExp(`^${side}’ fees`) }).getByRole('button', { name: 'To holders' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('radio', { name: /^Now/ }).check();
    await page.getByRole('textbox', { name: 'Your ETH at start' }).fill(formatUnits(listing.raise / 100n, 18));
    await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
    expect(wallet.requests, 'navigation must never touch the wallet').toEqual([]);
    // You are the curator: the wallet the creator connects is named on the Overview, and in the spec.
    await page.getByRole('banner').locator('.sh-wallet-button').click();
    await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: WALLET_NAME }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await shots(page, 'chain-create-shop-overview');
  });
  const file = await download(page, 'Download BoxSpec');
  expect(file.format).toBe('squarehole.boxspec/2'); expect(file.demo).not.toBe(true);
  const specAbi = artifact('BoxFactoryV2').abi.find((entry) => entry.type === 'function' && entry.name === 'createBox').inputs[0];
  const [spec] = decodeAbiParameters([specAbi], file.encoded);
  const config = shopConfigV2(spec.contentsParams);
  // Exactly what was typed, encoded as the chain package encodes ShopConfigV2.
  expect(spec.boxType).toBe(4); expect(spec.n).toBe(0); expect(spec.addOns.map((a) => a.id)).toEqual([7, 8]);
  expect(config).toMatchObject({ seedT: 1000n * E18, pickBps: 20_000, weeklyBps: 1_000, collectionBps: 250, listDelay: 7 * 86_400, curator: actor });
  expect([...config.givePricesT]).toEqual([1n, 2n, 4n, 8n].map((n) => n * E18));
  expect(config.collections).toEqual([nft]); expect([...config.tiers]).toEqual([0]);
  expect(spec.buyers.a.dest).toBe(6); expect(spec.sellers.a.dest).toBe(6);
  // The logo the spec commits, as the BoxSpec file carries it (F-1), served before the box exists so the indexer's
  // first art check can pass. A shop has no collection of its own: the logo is its one picture.
  expect(file.pictures.map((picture) => picture.role)).toEqual(['logo']);
  const [logo] = file.pictures;
  expect(logo.sha256).toBe(spec.coverSha256);
  writeExampleArt(ART, 'shop-life', [{ role: 'logo', sha256: spec.coverSha256, bytes: Buffer.from(logo.base64, 'base64') }]);

  // 2. The factory creates that spec; the creator's first buy pays the seed; the box opens, fills and graduates.
  const box = await test.step('createBox, seed, open, fill, graduate', async () => {
    const q = await read(chain, 'BoxFactoryV2', chain.factory, 'boxQParameters', [spec.pricing.listingId, spec.raise]);
    const predicted = await salts(chain, spec);
    await send(chain, actor, chain.factory, encodeFunctionData({ abi: artifact('BoxFactoryV2').abi, functionName: 'createBox', args: [spec, predicted.cs, predicted.hs] }), q.bootstrapQ + spec.creatorBuy, 16_777_216n);
    expect(await read(chain, 'BoxCoordinatorV2', predicted.coordinator, 'specHash')).toBe(file.specHash);
    let state = await readLocalBox(chain, predicted.coordinator);
    expect(state.actorT, 'the first buy brought at least the seed').toBeGreaterThanOrEqual(config.seedT);
    const loader = await read(chain, 'BoxCoordinatorV2', state.coordinator, 'starterSetLoader');
    await call(chain, actor, 'BoxTokenV2', state.token, 'approve', [state.vault, config.seedT]);
    await call(chain, actor, 'ShopVaultV2', state.vault, 'fundSeed');
    await call(chain, keeper, 'StarterSetLoaderV2', loader, 'complete');
    state = await readLocalBox(chain, state.coordinator);
    expect(state.gateOpen).toBe(true);
    await mineTo(chain.rpcUrl, state.openAt + 384n);
    await recipe(chain, 2, state.coordinator);
    await call(chain, keeper, 'BoxCoordinatorV2', state.coordinator, 'graduate');
    state = await readLocalBox(chain, state.coordinator);
    expect(state.graduated).toBe(true);
    expect(await read(chain, 'ShopVaultV2', state.vault, 'budgetT')).toBe(config.seedT);
    // The starting collection takes gives 7 days after Create.
    const [, , activeAt] = await read(chain, 'ShopVaultV2', state.vault, 'collectionTerms', [nft]);
    await mineTo(chain.rpcUrl, activeAt + 1n);
    for (const id of GIVE_IDS) await call(chain, deployer, 'HostileCollection', nft, 'mint', [actor, id]);
    // The indexer checks a new box within two 32-block audits: mine past them so its actions are not held as Checking.
    await rpc(chain.rpcUrl, 'anvil_mine', ['0x48']);
    return state;
  });
  wallet.allow(box.token, 'BoxTokenV2', 'shop-life.token'); wallet.allow(box.vault, 'ShopVaultV2', 'shop-life.shop'); wallet.allow(nft, 'HostileCollection', 'local.nft');

  // 3. The box page: the week's allowance, give two items, pick one.
  const requestsBefore = wallet.requests.length;
  await page.goto(boxPath(chain, box.token));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(NAME, { timeout: 120_000 });
  await expect(panel(page)).toBeVisible();
  // Actions wait for a current verified read: past the indexer's first audit, no Checking or Unverified line.
  await expect(page.locator('main p').filter({ hasText: /^(Checking|Unverified|Stale) ·/ })).toHaveCount(0, { timeout: 120_000 });
  expect(wallet.requests.slice(requestsBefore).filter((method) => method !== 'eth_accounts' && method !== 'eth_chainId'), 'navigation sends nothing').toEqual([]);
  await expect(page.getByRole('button', { name: /^(buy|sell|swap)$/i })).toHaveCount(0);
  const week = panel(page).locator('.sh-v2-shop-week');
  await expect(figure(week, 'Left this week')).toHaveText(`100 ${TICKER}`);
  await expect(figure(week, 'Per collection')).toHaveText(`up to 25 ${TICKER}`);
  await shots(page, 'chain-shop-open', () => panel(page));
  const give = section(page, 'Give an item');
  for (const [n, id] of GIVE_IDS.entries()) {
    const typed = async () => {
      await give.getByRole('textbox', { name: 'Item number' }).fill(String(id));
      await expect(figure(give, 'You get')).toHaveText(`1 ${TICKER}`);
      await expect(give.getByRole('button', { name: 'Approve item' })).toBeEnabled({ timeout: 30_000 });
    };
    await typed();
    // Pictures at two widths, then the typed item again (the page may have been laid out anew).
    if (n === 0) { await shots(page, 'chain-shop-give', () => panel(page)); await typed(); }
    await give.getByRole('button', { name: 'Approve item' }).click();
    await expect(page.getByRole('group', { name: 'Confirm transaction' })).toContainText(`Let the shop take ${labelOf('M2 collection', nft)} #${id}?`);
    await confirm(page);
    await expect(said(page)).toHaveText('Approval confirmed. Give in a separate transaction.');
    expect(await read(chain, 'HostileCollection', nft, 'getApproved', [id])).toBe(box.vault);
    await give.getByRole('textbox', { name: 'Item number' }).fill(String(id));
    await expect(give.getByRole('button', { name: 'Give' })).toBeEnabled({ timeout: 30_000 });
    const before = await read(chain, 'BoxTokenV2', box.token, 'balanceOf', [actor]);
    await give.getByRole('button', { name: 'Give' }).click();
    await expect(page.getByRole('group', { name: 'Confirm transaction' })).toContainText(`Give ${labelOf('M2 collection', nft)} #${id} and receive 1 ${TICKER}?`);
    await confirm(page);
    await expect(said(page)).toHaveText('Confirmed. Reading the updated shop…');
    expect(await read(chain, 'HostileCollection', nft, 'ownerOf', [id])).toBe(box.vault);
    expect(await read(chain, 'BoxTokenV2', box.token, 'balanceOf', [actor]) - before).toBe(E18);
  }
  expect(await read(chain, 'ShopVaultV2', box.vault, 'budgetT')).toBe(config.seedT - 2n * E18);
  // The week's figures follow the indexer's next snapshot: 10% and 2.5% of the week's 1000, less the 2 given.
  await expect(figure(week, 'Left this week')).toHaveText(`98 ${TICKER}`, { timeout: 60_000 });
  await expect(figure(give, 'Left for this collection')).toHaveText(`23 ${TICKER}`);
  const pick = section(page, 'Pick an item');
  const items = pick.getByRole('list', { name: 'Items inside' });
  for (const id of GIVE_IDS) await expect(items.getByRole('button', { name: `${labelOf('M2 collection', nft)} #${id}, 2 ${TICKER}` })).toBeVisible({ timeout: 60_000 });
  await items.getByRole('button', { name: /#300/ }).click();
  await expect(figure(pick, 'Pick price')).toHaveText(`2 ${TICKER}`);
  await shots(page, 'chain-shop-pick', () => panel(page));
  await items.getByRole('button', { name: /#300/ }).click();
  await expect(figure(pick, 'Pick price')).toHaveText(`2 ${TICKER}`);
  await pick.getByRole('button', { name: `Approve ${TICKER}` }).click();
  await expect(page.getByRole('group', { name: 'Confirm transaction' })).toContainText(`Approve exactly 2 ${TICKER} for this pick?`);
  await confirm(page);
  await expect(said(page)).toHaveText('Approval confirmed. Pick in a separate transaction.');
  expect(await read(chain, 'BoxTokenV2', box.token, 'allowance', [actor, box.vault])).toBe(2n * E18);
  await items.getByRole('button', { name: /#300/ }).click();
  await expect(pick.getByRole('button', { name: 'Pick', exact: true })).toBeEnabled({ timeout: 30_000 });
  await pick.getByRole('button', { name: 'Pick', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Confirm transaction' })).toContainText(`Pick ${labelOf('M2 collection', nft)} #300 for 2 ${TICKER}, to your wallet?`);
  await confirm(page);
  await expect(said(page)).toHaveText('Confirmed. Reading the updated shop…');
  expect(await read(chain, 'HostileCollection', nft, 'ownerOf', [300n])).toBe(actor);
  expect(await read(chain, 'ShopVaultV2', box.vault, 'budgetT')).toBe(config.seedT);
  expect(await read(chain, 'ShopVaultV2', box.vault, 'inside')).toBe(1n);
  // One item left: the last item stays.
  await expect(pick.getByText('The last item stays.')).toBeVisible({ timeout: 60_000 });

  // 4. The curator adds a collection at tier 2 and sees when it starts taking gives.
  const deployed = await send(chain, deployer, null, artifact('HostileCollection').bytecode.object, 0n, 10_000_000n);
  const added = getAddress(deployed.contractAddress);
  const add = section(page, 'Add a collection');
  const typedAdd = async () => {
    await add.getByRole('textbox', { name: 'Collection address' }).fill(added);
    await add.getByRole('button', { name: `Tier 2 · 2 ${TICKER}` }).click();
    await expect(add.getByText(/^Takes gives from about .* UTC, 7 days after it is added\.$/)).toBeVisible();
    await expect(add.getByRole('button', { name: 'Add collection' })).toBeEnabled({ timeout: 30_000 });
  };
  await typedAdd();
  await shots(page, 'chain-shop-add', () => panel(page));
  await typedAdd();
  await add.getByRole('button', { name: 'Add collection' }).click();
  await expect(page.getByRole('group', { name: 'Confirm transaction' })).toContainText('at tier 2? It takes gives 7 days after it is added.');
  await confirm(page);
  await expect(said(page)).toHaveText('Confirmed. Reading the updated shop…');
  const [giveT, pickT, startsAt] = await read(chain, 'ShopVaultV2', box.vault, 'collectionTerms', [added]);
  const block = await localClient(chain).getBlock();
  expect([giveT, pickT]).toEqual([2n * E18, 4n * E18]);
  expect(startsAt).toBeGreaterThan(block.timestamp + 7n * 86_400n - 600n);
  expect(await read(chain, 'ShopVaultV2', box.vault, 'nextAdditionAt')).toBe(startsAt);
  // The collection list (behind its summary): the new entry waits its 7 days; the first one takes gives, with its room left.
  await panel(page).getByText('Budget and collection list', { exact: true }).click();
  const list = panel(page).getByRole('list', { name: 'Collections' });
  await expect(list).toContainText('tier 2 · 7 days to activation', { timeout: 60_000 });
  await expect(list).toContainText(`tier 1 · Active · 23 ${TICKER} left this week`);
  await shots(page, 'chain-shop-after', () => panel(page));

  // Every send went from the one account, at zero value, to the box's shop, its coin or a listed collection.
  expect(wallet.sent.map((tx) => tx.action)).toEqual(['approve', 'give', 'approve', 'give', 'approve', 'pick', 'addCollection']);
  for (const tx of wallet.sent) {
    expect(tx.from.toLowerCase()).toBe(actor.toLowerCase()); expect(BigInt(tx.value ?? '0')).toBe(0n);
    expect([box.vault, box.token, nft].map((a) => a.toLowerCase())).toContain(tx.to.toLowerCase());
  }
  expect(decodeFunctionData({ abi: artifact('ShopVaultV2').abi, data: wallet.sent[5].data }).args).toEqual([nft, 300n, 2n * E18, actor]);
  expect(errors).toEqual([]);
});
