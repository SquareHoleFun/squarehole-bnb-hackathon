import { expect, test } from '@playwright/test';
import { makePng } from '../../../../packages/artwork/src/test-support/images.ts';
import { localClient, claimLocalFailureAfterYear } from '../../../../packages/chain/scripts/local-core-v2-chain.mjs';
import { description, testWallet, openBox, boxPath, read, readLocalBox, feedCard, assertNumbers,
  formatUnits, connectClaimWallet, confirm, decoded, browserContractCall } from './helpers.mjs';

test.describe.configure({ mode: 'serial' });
let chain;
test.beforeAll(() => { chain = description(); });

test('SH-V2-E2E-LOCAL feed: nine real factory boxes, no wallet request', async ({ page }) => {
  const wallet = await testWallet(page, chain);
  await page.goto('/');
  for (const [name, coordinator] of Object.entries(chain.boxes)) {
    const state = await readLocalBox(chain, coordinator);
    await expect(page.locator(`a[href="${boxPath(chain, state.token)}"]`).first(), name).toBeVisible();
    const card = await feedCard(chain, state.token);
    expect(card.verified).toBe(true);
    expect(card.graduated).toBe(state.graduated);
    expect(card.failed !== null).toBe(state.failed);
  }
  const registry = await read(chain, 'BoxFactoryV2', chain.factory, 'registry');
  expect(await read(chain, 'BoxRegistryV2', registry, 'boxCount')).toBe(9n);
  expect(wallet.requests).toEqual([]);
});

test('CQ11-A/B/E plain: real curve, fees, full-range graduation and deepen', async ({ page }) => {
  const wallet = await testWallet(page, chain);
  const state = await openBox(page, chain, 'plain', wallet);
  // SH-255: the phase in the picture's header (the old header's state band said Graduated; its chip row now does).
  await expect(page.locator('header.sh-bpic-head .sh-bpic-phase')).toHaveText('Graduated');
  await assertNumbers(page, chain, state);
  expect(state.graduated).toBe(true); expect(state.failed).toBe(false);
  expect(state.pairedLiquidity).toBeGreaterThan(BigInt(chain.checkpoints['before-deepen'].plain.pairedLiquidity));
  expect(state.saleFeesPending).toBe(0n);
  expect(state.collectedFees.buyersP, 'plain buyer P booked in Collected').toBeGreaterThan(0n);
  expect(state.collectedFees.sellersP, 'plain seller P booked in Collected').toBeGreaterThan(0n);
  expect(state.creatorP).toBe(0n); expect(state.fitOwed).toBe(0n); expect(state.platformOwed).toBe(0n);
  expect(await localClient(chain).getBalance({ address: chain.fit }), 'FIT custody received real ETH').toBeGreaterThan(0n);
});

test('M2/F127 holders: page and real owner claim, never a pushed payout', async ({ page }) => {
  const wallet = await testWallet(page, chain);
  const state = await openBox(page, chain, 'holders', wallet);
  // SH-255: the side's pick in the picture's Where the fees go (the Fees card's row before it).
  await expect(page.locator('.sh-bpic-ledger-place', { hasText: /^To holders/ }).first()).toBeVisible();
  await assertNumbers(page, chain, state);
  const batch = 1n;
  const credit = await read(chain, 'HolderLedgerV2', state.holderLedger, 'claimable', [batch, chain.accounts.actor]);
  expect(credit).toBeGreaterThan(0n);
  const before = await localClient(chain).getBalance({ address: chain.accounts.actor });
  // The current page has no M2 claim button. This explicit browser test-wallet call exercises the frozen claim API.
  const receipt = await browserContractCall(page, chain, 'HolderLedgerV2', state.holderLedger, 'claim', [batch, chain.accounts.actor]);
  expect(await read(chain, 'HolderLedgerV2', state.holderLedger, 'claimable', [batch, chain.accounts.actor])).toBe(0n);
  const after = await localClient(chain).getBalance({ address: chain.accounts.actor });
  expect(after + receipt.gasUsed * receipt.effectiveGasPrice - before).toBe(credit);
  // F137: the curve sale's batch (2) is settled but carries no P: its 1% fee is T, burned at graduation or failure.
  expect(await read(chain, 'BoxReceiverV2', state.receiver, 'holderBatchClosed', [2n])).toBe(true);
  expect(await read(chain, 'BoxReceiverV2', state.receiver, 'holderBatchPaid', [2n])).toBe(0n);
  expect(await read(chain, 'HolderLedgerV2', state.holderLedger, 'claimable', [2n, chain.accounts.actor])).toBe(0n);
  expect(decoded('HolderLedgerV2', wallet.sent[0]).functionName).toBe('claim');
});

test('M2 shop: seeded custody, give/pick receipts and exact T balance', async ({ page }) => {
  const wallet = await testWallet(page, chain);
  const state = await openBox(page, chain, 'shop', wallet);
  // SH-255: the phase in the picture's header (the old header's state band said Graduated; its chip row now does).
  await expect(page.locator('header.sh-bpic-head .sh-bpic-phase')).toHaveText('Graduated');
  await assertNumbers(page, chain, state);
  expect(await read(chain, 'HostileCollection', chain.nft, 'ownerOf', [100n])).toBe(chain.accounts.actor);
  expect(await read(chain, 'ShopVaultV2', state.vault, 'budgetT')).toBe(10005n * 10n ** 17n);
  expect(state.actorT + 5n * 10n ** 17n).toBe(BigInt(chain.checkpoints['before-shop'].shop.actorT));
  expect(await read(chain, 'ShopVaultV2', state.vault, 'inside')).toBe(10n);
  expect(await read(chain, 'ShopVaultV2', state.vault, 'seedReady')).toBe(true);
});

test('LOCAL-COINS CQ11-D/E creation: nine price coins (the Junkyard\'s local gold included) and the real USDC raise, no transaction', async ({ page }) => {
  const wallet = await testWallet(page, chain);
  const registry = await read(chain, 'BoxFactoryV2', chain.factory, 'registry');
  const listingRegistry = await read(chain, 'BoxFactoryV2', chain.factory, 'listingRegistry');
  const before = await read(chain, 'BoxRegistryV2', registry, 'boxCount');
  // JY-01 lists a second local gold (the Junkyard's, with issuer controls) after the first eight; both show as PAXG.
  expect(await read(chain, 'ListingRegistry', listingRegistry, 'listingCount')).toBe(9);
  const listing = await read(chain, 'ListingRegistry', listingRegistry, 'listing', [1]);
  await page.goto('/create/v2-basics');
  for (const symbol of ['ETH', 'USDC', 'LINK', 'WBTC', 'NVDAon', 'AAPLon', 'PAXG', 'XAUt']) {
    await expect(page.getByRole('radio', { name: new RegExp(`^${symbol}\\b`) }).first()).toBeVisible();
  }
  await page.getByRole('radio', { name: /^USDC\b/ }).check();
  expect(listing.decimals).toBe(6);
  const raise = `${formatUnits(listing.raise, listing.decimals)} USDC`;
  await expect(page.locator('[data-pricing-card]')).toContainText(raise);
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Local Preview');
  await page.getByRole('textbox', { name: 'Ticker' }).fill('PREVIEW');
  await page.locator('#create-logo').setInputFiles({ name: 'preview.png', mimeType: 'image/png', buffer: Buffer.from(makePng({ width: 512, height: 512, decodable: true })) });
  // The logo is read (sniffed, shrunk, hashed) before Next may leave the step, as in create-v2-send.spec.mjs.
  await expect(page.locator('#create-logo-action')).toHaveText('Change');
  const next = () => page.getByRole('button', { name: 'Next', exact: true }).click();
  await next(); await page.getByRole('radio', { name: /^Token/ }).check();
  await next(); await next();
  await expect(page.locator('main')).toContainText(raise);
  await next(); await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check(); await next();
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  await expect(page.locator('main')).toContainText(raise);
  expect(await read(chain, 'ListingRegistry', listingRegistry, 'listing', [1])).toEqual(listing);
  expect(await read(chain, 'BoxRegistryV2', registry, 'boxCount')).toBe(before);
  expect(wallet.requests).toEqual([]); expect(wallet.sent).toEqual([]);
});

test('LOCAL-COINS-B: real stock class and gold raises in the picker', async ({ page }) => {
  const wallet = await testWallet(page, chain);
  const listings = await read(chain, 'BoxFactoryV2', chain.factory, 'listingRegistry');
  await page.goto('/create/v2-basics');
  for (const [id, symbol] of [[4, 'NVDAon'], [5, 'AAPLon'], [6, 'PAXG'], [7, 'XAUt']]) {
    const row = await read(chain, 'ListingRegistry', listings, 'listing', [id]);
    await page.getByRole('radio', { name: new RegExp(`^${symbol}\\b`) }).first().check();
    await expect(page.locator('[data-pricing-card]')).toContainText(`${formatUnits(row.raise, row.decimals)} ${symbol}`);
    if (id <= 5) {
      expect(row.class).toBe(4); // ListingClass.STOCK from the actual registry.
      await expect(page.locator('[data-pricing-card]')).toContainText('Stock-linked: may not be offered to US persons.');
    } else {
      expect(row.decimals).toBe(id === 6 ? 18 : 6);
    }
  }
  for (const [name, id] of [['stock', 4], ['gold', 6]]) {
    const state = await readLocalBox(chain, chain.boxes[name]);
    expect(state.graduated).toBe(true);
    expect(await read(chain, 'BoxCoordinatorV2', state.coordinator, 'pricingListingId')).toBe(id);
    expect(state.raise).toBe((await read(chain, 'ListingRegistry', listings, 'listing', [id])).raise);
    expect(state.collectedFees.buyersP).toBeGreaterThan(0n);
    expect(state.collectedFees.sellersP).toBeGreaterThan(0n);
  }
  expect(wallet.requests).toEqual([]); expect(wallet.sent).toEqual([]);
});

// SH-V2-FE8: the lines come from each listed contract (its shared LocalStockControls: paused(), frozen(address)),
// never from the ticker, so no issuer is named for the local stand-ins (the review: no Ondo identity from a ticker).
test('LOCAL-COINS-B: stock issuer pause and freeze disclosures', async ({ page }) => {
  const wallet = await testWallet(page, chain);
  await page.goto('/create/v2-basics');
  const card = page.locator('[data-pricing-card]');
  for (const symbol of ['NVDAon', 'AAPLon']) {
    await page.getByRole('radio', { name: new RegExp(`^${symbol}\\b`) }).first().check();
    await expect(card).toContainText('The issuer can pause or block all its tokens at once.');
    await expect(card).toContainText('The issuer can freeze addresses, including the pool.');
    await expect(card).toContainText('Stock-linked: may not be offered to US persons.');
    await expect(card).not.toContainText('have not been checked');
  }
  // The local gold and USDC faucets have no issuer power to name: no line, and no placeholder in its place.
  for (const symbol of ['PAXG', 'XAUt', 'USDC']) {
    await page.getByRole('radio', { name: new RegExp(`^${symbol}\\b`) }).first().check();
    await expect(card).not.toContainText(/The issuer can|have not been checked|could not be read|Stock-linked/);
  }
  expect(wallet.requests).toEqual([]); expect(wallet.sent).toEqual([]);
});

test('CQ11-C/E failure: UI approval and claim conserve the real pot and caller balances', async ({ page }) => {
  const wallet = await testWallet(page, chain);
  const before = await openBox(page, chain, 'failure', wallet);
  await assertNumbers(page, chain, before);
  const amount = before.actorT / 2n;
  const quote = await read(chain, 'BoxCoordinatorV2', before.coordinator, 'quoteClaim', [amount]);
  await page.getByRole('textbox', { name: 'Coins to claim' }).fill(formatUnits(amount, 18));
  expect(wallet.requests).toEqual([]);
  await connectClaimWallet(page);
  await confirm(page, 'Approve coins');
  await expect(page.getByRole('status')).toContainText('Approval confirmed. Claim in a separate transaction.');
  expect(await read(chain, 'BoxTokenV2', before.token, 'allowance', [chain.accounts.actor, before.coordinator])).toBe(amount);
  expect(decoded('BoxTokenV2', wallet.sent[0])).toMatchObject({ functionName: 'approve', args: [before.coordinator, amount] });
  const beforeP = await localClient(chain).getBalance({ address: chain.accounts.actor });
  // The failure box is priced in the native coin: the page names it ETH (SH-BOX-LIFE-VIEW § 3), never P.
  await confirm(page, 'Claim ETH');
  await expect(page.getByRole('status')).toContainText('Confirmed. Reading the updated box');
  expect(wallet.sent).toHaveLength(2);
  expect(decoded('BoxCoordinatorV2', wallet.sent[1])).toMatchObject({ functionName: 'claim', args: [amount, chain.accounts.actor] });
  const receipt = await localClient(chain).getTransactionReceipt({ hash: wallet.sent[1].hash });
  expect(receipt.status).toBe('success');
  const after = await readLocalBox(chain, before.coordinator);
  expect(after.actorT + amount).toBe(before.actorT);
  expect(after.left + amount).toBe(before.left);
  expect(after.pot + quote).toBe(before.pot);
  const afterP = await localClient(chain).getBalance({ address: chain.accounts.actor });
  expect(afterP + receipt.gasUsed * receipt.effectiveGasPrice - beforeP).toBe(quote);
  const card = await feedCard(chain, after.token);
  expect(BigInt(card.closing.pot)).toBe(after.pot);
});

test('RC5-A: the owner still claims after 365 days and FIT gets no failed pot', async ({ page }) => {
  const wallet = await testWallet(page, chain);
  const before = await openBox(page, chain, 'failure', wallet);
  const beforeFit = await localClient(chain).getBalance({ address: chain.fit });
  const quote = await read(chain, 'BoxCoordinatorV2', before.coordinator, 'quoteClaim', [before.actorT]);
  await claimLocalFailureAfterYear(chain);
  await feedCard(chain, before.token); await page.reload();
  const after = await readLocalBox(chain, before.coordinator);
  expect(after.pot + quote).toBe(before.pot); expect(after.left + before.actorT).toBe(before.left);
  expect(await localClient(chain).getBalance({ address: chain.fit })).toBe(beforeFit);
  expect(after.actorT).toBe(0n);
  await expect(page.getByRole('region', { name: 'Failure claim' })).toBeVisible();
  expect(wallet.requests).toEqual([]);
});
