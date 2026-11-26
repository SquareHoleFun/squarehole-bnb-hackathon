import { expect } from '@playwright/test';
import { erc20Abi, formatUnits, zeroAddress, zeroHash } from 'viem';
import { localClient, readLocalBox, mineTo } from '../../../../../packages/chain/scripts/local-core-v2-chain.mjs';
import { priceSymbol } from '../../../../../packages/chain/scripts/create-example-v2.mjs';
import { boxCurve } from '../../../../../packages/box-spec/src/layout-v2.ts';
import { read, call, balance, events } from './chain.mjs';
import { feeAuditor, graduate, fail, paySafes } from './accounting.mjs';
import { assertPaid, proRata } from './support.mjs';
import { boxPath, openDetails, recordedRaise } from '../helpers.mjs';
import { currentCard, listedCard } from './feed.mjs';

const r = (chain, box, fn, args = []) => read(chain, 'BoxCoordinatorV2', box.coordinator, fn, args);
const receiver = (chain, box, fn, args = []) => read(chain, 'BoxReceiverV2', box.receiver, fn, args);
const token = (chain, box, fn, args = []) => read(chain, 'BoxTokenV2', box.token, fn, args);
const gasOf = receipt => receipt.gasUsed * receipt.effectiveGasPrice;
// The box page names its price coin by the coin's own name (record-v2.ts, price-coin.ts; SH-BOX-LIFE-VIEW § 3): ETH for
// the native coin, a listed coin by its symbol() as the local coins answer it (TEST_* keys their stand-ins).
const coinName = (box, symbol) => (box.p.toLowerCase() === zeroAddress ? 'ETH' : priceSymbol(symbol));
const amountText = (box, amount, symbol) => `${formatUnits(amount, box.decimals)} ${coinName(box, symbol)}`;

async function pageState(page, chain, example, box, evidence) {
  const card = await currentCard(chain, box.token, evidence);
  const at = await readLocalBox(chain, box.coordinator, BigInt(card.asOf.block));
  const p = (await read(chain, 'BoxCoordinatorV2', box.coordinator, 'q', [], BigInt(card.asOf.block))).toLowerCase();
  expect(p).toBe(box.p.toLowerCase());
  expect(card.row.record.q.toLowerCase()).toBe(p);
  expect(p === zeroAddress).toBe(example.priceCoin.symbol === 'ETH');
  if (p !== zeroAddress) {
    // The pricing coin's own ERC-20 metadata; the local base LocalPriceCoin declares neither function, its coins do.
    const metadata = functionName => localClient(chain).readContract({ address: p, abi: erc20Abi, functionName });
    // Local issuer faucets retain their names; TEST_* keys use their actual stand-in symbols.
    expect(await metadata('symbol')).toBe(priceSymbol(example.priceCoin.symbol));
    expect(BigInt(await metadata('decimals'))).toBe(BigInt(example.priceCoin.decimals));
  }
  expect(card.graduated).toBe(at.graduated); expect(card.failed !== null).toBe(at.failed);
  expect(BigInt(card.row.record.raise)).toBe(BigInt(example.raise.amount));
  await page.goto(boxPath(chain, box.token));
  await expect(page.locator('.sh-v2-page')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(example.name);
  // SH-255 round 3 (D18): the picture's header (past its loading heading, itself a header now) before any check.
  await expect(page.locator('header.sh-bpic-head')).toBeVisible();
  await expect(page.locator('header.sh-bpic-head')).toContainText(at.failed ? 'Closed' : at.graduated ? 'Graduated' : example.ticker);
  await expect(page.getByRole('button', { name: /^(buy|sell|swap)$/i })).toHaveCount(0);
  // SH-255: the recorded raise behind the Raise sheet's (?) (once the Fees card's Fee details).
  expect(await recordedRaise(page)).toContain(`Recorded raise: ${amountText(box, at.raise, example.priceCoin.symbol)}`);
  return at;
}

/**
 * The SHA-256 of the bytes an <img> draws. The site draws a chain box's picture only from a blob URL of gateway
 * bytes it verified against the spec (box-pictures.ts); a placeholder, a data URL or an undecodable picture fails.
 */
async function drawn(img) {
  await expect(img).toHaveCount(1);
  await img.scrollIntoViewIfNeeded();
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute('src', /^blob:/);
  return img.evaluate(async node => {
    await node.decode();
    if (!node.complete || node.naturalWidth === 0 || node.naturalHeight === 0) throw new Error('picture not drawn');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await (await fetch(node.src)).arrayBuffer()));
    return `0x${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}`;
  });
}

/**
 * Each created box is shown with its own pictures: the feed card's cover and its coin's logo, and the box page's
 * header icon, a square slot, its logo (SH-BOX-PICTURE-FIT: a square slot shows the logo, a card the cover).
 */
async function ownPictures(page, chain, box, evidence) {
  const logo = box.spec.coverSha256.toLowerCase();
  // A token or pile box commits no collection cover; the site then shows its logo as the box picture.
  const cover = (box.spec.collectionCoverSha256 === zeroHash ? box.spec.coverSha256 : box.spec.collectionCoverSha256).toLowerCase();
  const listed = await listedCard(chain, box.token);
  await page.goto('/');
  const card = page.locator(`.sh-box-card a.sh-box-card__link[href="${boxPath(chain, box.token)}" i]`);
  await expect(card).toHaveCount(1);
  const shown = { feedCover: await drawn(card.locator('.sh-box-cover img')), feedLogo: await drawn(card.locator('img.sh-box-coin--logo')) };
  await page.goto(boxPath(chain, box.token));
  await expect(page.locator('.sh-v2-page')).toBeVisible();
  // SH-224: the box page's picture is the header's big picture (BoxHeader), its logo for every box but the Genesis box.
  shown.pageLogo = await drawn(page.locator('header.sh-bpic-head .sh-box-cover img'));
  expect(shown).toEqual({ feedCover: cover, feedLogo: logo, pageLogo: logo });
  evidence.pictures = { logo, cover, ...shown, listedAt: listed.asOf, verified: listed.verified };
}

async function swap(chain, box, buy, actor, amount) {
  expect(amount).toBeGreaterThan(0n);
  const graduated = await r(chain, box, 'graduated');
  const curve = boxCurve(box.raise, false);
  const limit = graduated ? 0n : buy ? curve.sqrtPriceEndX96 : curve.sqrtPriceStartX96;
  const key = await read(chain, 'BoxHookV2', box.hook, 'poolKey');
  const asset = buy ? box.p : box.token;
  if (asset !== zeroAddress) await call(chain, 'LocalERC20', asset, 'approve', [chain.swapper, amount], actor);
  const before = await token(chain, box, 'balanceOf', [actor]);
  const receipt = await call(chain, 'PriceLimitSwapper', chain.swapper, 'swap', [key, buy, -amount, limit], actor, buy && box.p === zeroAddress ? amount : 0n);
  if (asset !== zeroAddress) await call(chain, 'LocalERC20', asset, 'approve', [chain.swapper, 0n], actor);
  const after = await token(chain, box, 'balanceOf', [actor]);
  expect(buy ? after - before : before - after).toBeGreaterThan(0n);
  return receipt;
}

/**
 * F137: after graduation a sale's 1% T fee reaches the sellers' side only through the hook's public sellFees() step,
 * one step per block within 49 ticks (our keeper presses it hourly as a fallback). Press until what waits is below
 * the step minimum, which skips; if nothing was sold yet, `trade` adds fees first. Returns the P sold.
 */
async function sellFees(chain, box, evidence, trade) {
  let sold = 0n;
  for (let step = 0; step < 64; step++) {
    const receipt = await call(chain, 'BoxHookV2', box.hook, 'sellFees');
    const [event] = events(receipt, 'BoxHookV2', box.hook, 'FeesSold');
    if (event) {
      sold += event.pOut;
      (evidence.feesSold ??= []).push({ hash: receipt.transactionHash, tIn: event.tIn, pOut: event.pOut, tip: event.tip });
      continue;
    }
    if (sold > 0n || !trade) return sold;
    await trade();
  }
  return sold;
}

async function confirm(page, label, group = 'Confirm transaction') {
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.getByRole('group', { name: group, exact: true }).getByRole('button', { name: 'Confirm', exact: true }).click();
}
async function paid(chain, box, quote, action, actor = chain.accounts.actor, asset = box.p) {
  const before = await balance(chain, asset, actor);
  const receipt = await action();
  expect(receipt.status).toBe('success');
  assertPaid({ before, after: await balance(chain, asset, actor), quote, gas: gasOf(receipt), native: asset === zeroAddress });
  return receipt;
}

async function creatorClaim(page, chain, example, box, wallet, evidence) {
  const quote = await receiver(chain, box, 'creatorP');
  expect(quote).toBeGreaterThan(0n);
  await pageState(page, chain, example, box, evidence);
  await page.getByRole('region', { name: 'Your claims' }).getByRole('button', { name: 'Claim all', exact: true }).click();
  const confirmation = page.getByRole('group', { name: 'Confirm Claim all', exact: true });
  const row = confirmation.locator('li').filter({ hasText: 'Creator fees' });
  await expect(row).toContainText(amountText(box, quote, example.priceCoin.symbol));
  await expect(confirmation).toContainText('1 signature');
  const receipt = await paid(chain, box, quote, () => wallet.uiCall('BoxReceiverV2', box.receiver, 'claimCreator', [box.p, chain.accounts.actor],
    () => confirmation.getByRole('button', { name: 'Confirm', exact: true }).click()));
  expect(await receiver(chain, box, 'creatorP')).toBe(0n);
  evidence.creatorClaim = { quote, hash: receipt.transactionHash };
}

async function holdersClaim(page, chain, example, box, wallet, evidence) {
  let selected;
  const safe = example.contents.kind === 'shop' ? chain.junkyard.safe : null;
  const safeBefore = safe ? await balance(chain, box.p, safe) : null;
  const end = await read(chain, 'BoxHookV2', box.hook, 'currentTradeBatch', [true]);
  for (let batch = 1n; batch < end; batch++) {
    if (!(await receiver(chain, box, 'holderBatchClosed', [batch]))) continue;
    let complete = false;
    for (let step = 0; step < 100; step++) {
      await call(chain, 'HolderLedgerV2', box.holderLedger, 'settleBatch', [batch, 64n]);
      [complete] = await read(chain, 'HolderLedgerV2', box.holderLedger, 'batchState', [batch]);
      if (complete) break;
    }
    expect(complete, 'bounded settlement must complete').toBe(true);
    const actor = await read(chain, 'HolderLedgerV2', box.holderLedger, 'claimable', [batch, chain.accounts.actor]);
    const backup = await read(chain, 'HolderLedgerV2', box.holderLedger, 'claimable', [batch, chain.accounts.backup]);
    const state = await read(chain, 'HolderLedgerV2', box.holderLedger, 'batchState', [batch]);
    const safeCredit = safe ? await read(chain, 'HolderLedgerV2', box.holderLedger, 'claimable', [batch, safe]) : 0n;
    expect(actor + backup + safeCredit + state[3]).toBe(await receiver(chain, box, 'holderBatchPaid', [batch]));
    if (!selected && actor > 0n && (!safe || safeCredit > 0n)) selected = { batch, quote: actor };
  }
  expect(selected, 'a real holder credit must exist').toBeDefined();
  await pageState(page, chain, example, box, evidence);
  await page.getByText('Fee share details', { exact: true }).click();
  await page.getByRole('textbox', { name: 'Check a batch' }).fill(String(selected.batch));
  const button = page.getByRole('button', { name: `Claim batch ${selected.batch}`, exact: true });
  await expect(button.locator('..')).toContainText(amountText(box, selected.quote, example.priceCoin.symbol));
  const receipt = await paid(chain, box, selected.quote, () => wallet.uiCall('HolderLedgerV2', box.holderLedger, 'claim', [selected.batch, chain.accounts.actor],
    () => confirm(page, `Claim batch ${selected.batch}`, 'Confirm claim')));
  expect(await read(chain, 'HolderLedgerV2', box.holderLedger, 'claimable', [selected.batch, chain.accounts.actor])).toBe(0n);
  evidence.holderClaim = { ...selected, hash: receipt.transactionHash };
  if (safe) {
    expect(await balance(chain, box.p, safe)).toBe(safeBefore); // settling and another holder's claim never push gold
    const { claimSafeGold } = await import('./junkyard-create.mjs');
    await claimSafeGold(chain, box, selected.batch, evidence);
  }
}

async function withdrawItem(chain, box, wallet) {
  const principal = await read(chain, 'BoxVaultV2', box.vault, 'quoteWithdraw', [1n]);
  const bps = await read(chain, 'BoxVaultV2', box.vault, 'pickFeeBps');
  const amount = principal + (principal * BigInt(bps) + 9999n) / 10000n;
  const before = await token(chain, box, 'balanceOf', [chain.accounts.actor]);
  await wallet.call('BoxTokenV2', box.token, 'approve', [box.vault, amount]);
  const time = (await localClient(chain).getBlock()).timestamp;
  await wallet.call('BoxVaultV2', box.vault, 'withdraw', [1n, amount, time + 3600n]);
  expect(before - await token(chain, box, 'balanceOf', [chain.accounts.actor])).toBe(amount);
  const collection = await r(chain, box, 'collection');
  expect((await read(chain, 'BoxCollectionV2', collection, 'ownerOf', [1n])).toLowerCase()).toBe(chain.accounts.actor.toLowerCase());
}

async function itemClaim(page, chain, example, box, wallet, evidence) {
  const count = await receiver(chain, box, 'itemFundingCount');
  for (let step = 0; step < 100; step++) {
    await call(chain, 'ItemLedgerV2', box.itemLedger, 'sync', [32n]);
    if (await read(chain, 'ItemLedgerV2', box.itemLedger, 'fundingCursor') === count
        && await read(chain, 'ItemLedgerV2', box.itemLedger, 'lifecycleCursor') === await read(chain, 'BoxVaultV2', box.vault, 'itemLifecycleCount')) break;
  }
  expect(await read(chain, 'ItemLedgerV2', box.itemLedger, 'fundingCursor')).toBe(count);
  const credit = await read(chain, 'ItemLedgerV2', box.itemLedger, 'itemCredit', [1n]);
  const quote = credit[0] + credit[1]; expect(quote).toBeGreaterThan(0n);
  await pageState(page, chain, example, box, evidence);
  const button = page.getByRole('button', { name: 'Claim item 1', exact: true });
  await expect(button.locator('..')).toContainText(amountText(box, quote, example.priceCoin.symbol));
  const receipt = await paid(chain, box, quote, () => wallet.uiCall('ItemLedgerV2', box.itemLedger, 'claim', [[1n], chain.accounts.actor],
    () => confirm(page, 'Claim item 1', 'Confirm claim')));
  expect(await read(chain, 'ItemLedgerV2', box.itemLedger, 'itemCredit', [1n])).toEqual([0n, 0n]);
  evidence.itemClaim = { quote, hash: receipt.transactionHash };
}

/** v2.1 step 2: an item's credit in the box token, bought with the T sides' pending fees, claimed through the page with claimT. */
async function itemClaimT(page, chain, example, box, wallet, collect, evidence) {
  const { swapStepMinQ } = await read(chain, 'BoxFactoryV2', chain.factory, 'boxQParameters', [box.spec.pricing.listingId, box.raise]);
  const ready = async () => (await receiver(chain, box, 'rewardsPendingByKind')).some(pending => pending >= swapStepMinQ);
  // Real trading fees only: accumulate until one purchase can run, never inject receiver funds.
  for (let step = 0; step < 32 && !(await ready()); step++) {
    const before = await token(chain, box, 'balanceOf', [chain.accounts.actor]);
    await swap(chain, box, true, chain.accounts.actor, box.raise / 10n); await collect();
    const bought = await token(chain, box, 'balanceOf', [chain.accounts.actor]) - before;
    await swap(chain, box, false, chain.accounts.actor, bought / 2n); await sellFees(chain, box, evidence); await collect();
  }
  expect(await ready()).toBe(true);
  const purchase = await call(chain, 'BoxReceiverV2', box.receiver, 'buyBack', [zeroAddress]);
  const [rewards] = events(purchase, 'BoxReceiverV2', box.receiver, 'RewardsBought');
  // RewardsBought(choice 8 = Items in T, side, spentP, boughtT, ledgerT, burnT, tipP): Keep credits every bought T.
  expect(rewards, 'a purchase of T for the items').toBeDefined(); expect(rewards.choice).toBe(8); expect(rewards.tipP).toBe(0n);
  expect(rewards.boughtT).toBeGreaterThan(0n); expect(rewards.ledgerT + rewards.burnT).toBe(rewards.boughtT);
  const count = await receiver(chain, box, 'itemFundingCount');
  for (let step = 0; step < 100; step++) {
    await call(chain, 'ItemLedgerV2', box.itemLedger, 'sync', [32n]);
    if (await read(chain, 'ItemLedgerV2', box.itemLedger, 'fundingCursor') === count
        && await read(chain, 'ItemLedgerV2', box.itemLedger, 'lifecycleCursor') === await read(chain, 'BoxVaultV2', box.vault, 'itemLifecycleCount')) break;
  }
  const credit = await read(chain, 'ItemLedgerV2', box.itemLedger, 'itemCreditT', [1n]);
  const quote = credit[0] + credit[1]; expect(quote).toBeGreaterThan(0n);
  await pageState(page, chain, example, box, evidence);
  const label = `Claim item 1 in ${example.ticker}`;
  const button = page.getByRole('button', { name: label, exact: true });
  await expect(button.locator('..')).toContainText(`${formatUnits(quote, 18)} ${example.ticker}`);
  const before = await token(chain, box, 'balanceOf', [chain.accounts.actor]);
  const receipt = await wallet.uiCall('ItemLedgerV2', box.itemLedger, 'claimT', [[1n], chain.accounts.actor], () => confirm(page, label, 'Confirm claim'));
  expect(receipt.status).toBe('success');
  expect(await token(chain, box, 'balanceOf', [chain.accounts.actor]) - before).toBe(quote);
  expect(await read(chain, 'ItemLedgerV2', box.itemLedger, 'itemCreditT', [1n])).toEqual([0n, 0n]);
  evidence.itemClaimT = { purchase: { ...rewards, hash: purchase.transactionHash }, quote, hash: receipt.transactionHash };
}

/** v2.1 step 1: after graduation anyone eats the pending price coin; LINK records no checked burn, so it is locked at 0xdEaD. */
async function eatPrice(page, chain, example, box, evidence) {
  const pending = await receiver(chain, box, 'eatPendingP'); expect(pending).toBeGreaterThan(0n);
  const DEAD = '0x000000000000000000000000000000000000dEaD';
  const dead = await balance(chain, box.p, DEAD);
  const receipt = await call(chain, 'BoxReceiverV2', box.receiver, 'eatPriceCoin');
  const [eaten] = events(receipt, 'BoxReceiverV2', box.receiver, 'PriceCoinEaten');
  expect(eaten, 'the eat receipt').toBeDefined();
  expect([eaten.amount, eaten.total, eaten.burned]).toEqual([pending, pending, false]);
  expect(await balance(chain, box.p, DEAD) - dead).toBe(pending);
  expect(await receiver(chain, box, 'eatPendingP')).toBe(0n); expect(await receiver(chain, box, 'eatenP')).toBe(pending);
  await pageState(page, chain, example, box, evidence);
  const panel = page.getByRole('region', { name: 'Eaten', exact: true });
  await expect(panel.locator('.sh-v2-value')).toHaveText(`${formatUnits(pending, box.decimals)} ${example.priceCoin.symbol}`);
  await expect(panel).toContainText('Locked');
  evidence.eaten = { pending, hash: receipt.transactionHash };
}

async function burn(chain, box, evidence) {
  const before = await token(chain, box, 'totalSupply');
  let spent = 0n; let burned = 0n;
  for (let step = 0; step < 12 && burned === 0n; step++) {
    const receipt = await call(chain, 'BoxReceiverV2', box.receiver, 'buyBack', [zeroAddress]);
    for (const event of events(receipt, 'BoxReceiverV2', box.receiver, 'BoughtBack')) {
      spent += event.pSpent; burned += event.tBurned;
      expect(event.tip).toBe(0n); expect(event.tBurned).toBe(event.tBought);
    }
  }
  expect(spent).toBeGreaterThan(0n); expect(burned).toBeGreaterThan(0n);
  expect(await token(chain, box, 'totalSupply')).toBe(before - burned);
  evidence.burn = { before, spent, burned, after: before - burned };
}

async function royalty(chain, example, box, wallet, evidence, collect) {
  const collection = await r(chain, box, 'collection');
  const salePrice = 10n ** 18n;
  const [router, amount] = await read(chain, 'BoxCollectionV2', collection, 'royaltyInfo', [1n, salePrice]);
  expect(amount).toBe(salePrice * BigInt(example.royalties.bps) / 10000n);
  await wallet.send({ to: router, value: `0x${amount.toString(16)}` });
  // F138: anyone flushes the inbox's ETH into the receiver, which books it like a buyers' fee (keep: 10/15 to the creator).
  expect(await collect.royalty(() => call(chain, 'BoxRoyaltyRouterV2', router, 'flush'))).toBe(amount);
  expect(await balance(chain, zeroAddress, router)).toBe(0n);
  evidence.royalty = { salePrice, amount, router };
}

async function redeem(page, chain, example, box, wallet, evidence) {
  const asset = await read(chain, 'PileVaultV2', box.vault, 'asset');
  expect(asset.toLowerCase()).toBe((example.contents.seed.symbol === 'ETH' ? zeroAddress : chain.usdc).toLowerCase());
  let moved = 0n;
  if (Object.values(example.fees).some(side => side.choice === 'pile')) {
    moved = await receiver(chain, box, 'pilePendingP'); expect(moved).toBeGreaterThan(0n);
    expect(await balance(chain, asset, box.vault)).toBe(BigInt(example.contents.seed.amount));
    await call(chain, 'BoxReceiverV2', box.receiver, 'moveToPile');
    expect(await receiver(chain, box, 'pilePendingP')).toBe(0n);
  }
  const supply = await token(chain, box, 'totalSupply');
  const amount = await token(chain, box, 'balanceOf', [chain.accounts.actor]) / 4n;
  const pile = await balance(chain, asset, box.vault);
  expect(pile).toBe(BigInt(example.contents.seed.amount) + moved);
  const quote = proRata(pile, amount, supply) * (10000n - BigInt(example.contents.leaveBehindBps ?? '0')) / 10000n; expect(quote).toBeGreaterThan(0n);
  expect(await read(chain, 'PileVaultV2', box.vault, 'quoteRedeem', [amount])).toBe(quote);
  await pageState(page, chain, example, box, evidence);
  await page.getByRole('textbox', { name: `${example.ticker} to redeem` }).fill(formatUnits(amount, 18));
  const panel = page.getByRole('region', { name: 'Coin pile', exact: true });
  await expect(panel.locator('.sh-m3-quote')).toContainText(`You get${formatUnits(quote, asset === zeroAddress ? 18 : 6)} ${example.contents.seed.symbol}`);
  await wallet.uiCall('BoxTokenV2', box.token, 'approve', [box.vault, amount], () => confirm(page, 'Approve coins'));
  const receipt = await paid(chain, box, quote, () => wallet.uiCall('PileVaultV2', box.vault, 'redeem', [amount, quote, chain.accounts.actor],
    () => confirm(page, 'Redeem')), chain.accounts.actor, asset);
  expect(await token(chain, box, 'totalSupply')).toBe(supply - amount);
  expect(await balance(chain, asset, box.vault)).toBe(pile - quote);
  evidence.redemption = { supply, amount, pile, quote, hash: receipt.transactionHash };
}

async function failAndRefund(page, chain, example, box, wallet, carry, evidence) {
  await mineTo(chain.rpcUrl, await r(chain, box, 'deadline'));
  const { fixed, expected } = await fail(chain, example, box, carry, evidence);
  expect(await r(chain, box, 'failed')).toBe(true); expect(await r(chain, box, 'graduated')).toBe(false);
  const initial = await readLocalBox(chain, box.coordinator);
  const owners = [chain.accounts.actor, chain.accounts.backup];
  const coins = await Promise.all(owners.map(actor => token(chain, box, 'balanceOf', [actor])));
  expect(coins[0] + coins[1]).toBe(initial.left);
  expect(initial.pot).toBe(expected.pot);
  let totalPaid = 0n;
  evidence.refunds = [];
  for (const actor of owners) {
    const before = await pageState(page, chain, example, box, evidence);
    const amount = await token(chain, box, 'balanceOf', [actor]);
    const quote = proRata(before.pot, amount, before.left);
    expect(await r(chain, box, 'quoteClaim', [amount])).toBe(quote);
    // The exact pot as a visitor reads it: behind Claim details, opened (SH-255 round 3, D18).
    await openDetails(page.getByRole('region', { name: 'Failure claim' }), 'Claim details');
    await expect(page.getByRole('region', { name: 'Failure claim' }).getByText(`Claim pot ${amountText(box, before.pot, example.priceCoin.symbol)}`, { exact: false })).toBeVisible();
    let receipt;
    if (actor === chain.accounts.actor) {
      // Claim all's preview is an exact quote for the connected owner's full balance.
      await expect(page.getByRole('region', { name: 'Your claims' })).toContainText(amountText(box, quote, example.priceCoin.symbol));
      await page.getByRole('textbox', { name: 'Coins to claim' }).fill(formatUnits(amount, 18));
      await wallet.uiCall('BoxTokenV2', box.token, 'approve', [box.coordinator, amount], () => confirm(page, 'Approve coins'));
      receipt = await paid(chain, box, quote, () => wallet.uiCall('BoxCoordinatorV2', box.coordinator, 'claim', [amount, actor], () => confirm(page, `Claim ${coinName(box, example.priceCoin.symbol)}`)));
    } else {
      await call(chain, 'BoxTokenV2', box.token, 'approve', [box.coordinator, amount], actor);
      receipt = await paid(chain, box, quote, () => call(chain, 'BoxCoordinatorV2', box.coordinator, 'claim', [amount, actor], actor), actor);
    }
    const after = await readLocalBox(chain, box.coordinator);
    expect(after.pot).toBe(before.pot - quote); expect(after.left).toBe(before.left - amount);
    expect(after.supply).toBe(before.supply - amount);
    totalPaid += quote; evidence.refunds.push({ actor, amount, quote, hash: receipt.transactionHash });
  }
  expect(totalPaid).toBe(expected.pot);
  expect(await r(chain, box, 'claimState')).toEqual([0n, 0n]);
  evidence.failure = { fixed, totalPaid };
  await pageState(page, chain, example, box, evidence);
  await openDetails(page.getByRole('region', { name: 'Failure claim' }), 'Claim details');
  await expect(page.getByRole('region', { name: 'Failure claim' }).getByText(/^Claim pot 0 /)).toBeVisible();
}

export async function runLife(page, chain, example, box, wallet, complete, evidence) {
  await ownPictures(page, chain, box, evidence); complete.add('own-pictures');
  const collect = feeAuditor(chain, example, box, evidence);
  const now = await read(chain, 'BoxHookV2', box.hook, 'windowEndsAt');
  await mineTo(chain.rpcUrl, now + 1n);
  // Two actual owners: the second buy gives the first holder fee units, then a genuine seller fee follows.
  await swap(chain, box, true, chain.accounts.actor, box.raise / 10n);
  await collect();
  await swap(chain, box, true, chain.accounts.backup, box.raise / 10n);
  const buyer = await collect(); expect(buyer.buyersP).toBeGreaterThan(0n);
  // F137: before graduation a sale pays 1% of the T it puts in; the hook holds that T and burns it at graduation or
  // failure, so the sellers' side gets no P yet.
  const manager = await receiver(chain, box, 'poolManager');
  const heldT = () => read(chain, 'PoolManager', manager, 'balanceOf', [box.hook, BigInt(box.token)]);
  const heldBefore = await heldT();
  await swap(chain, box, false, chain.accounts.actor, await token(chain, box, 'balanceOf', [chain.accounts.actor]) / 4n);
  const seller = await collect(); expect(seller.sellersP).toBe(0n);
  expect(await heldT()).toBeGreaterThan(heldBefore);
  if (example.life === 'failure') {
    await failAndRefund(page, chain, example, box, wallet, collect.carry(), evidence);
    complete.add('failure-refunds');
  } else {
    for (let step = 0; step < 8 && !(await read(chain, 'BoxHookV2', box.hook, 'closed')); step++) {
      await swap(chain, box, true, chain.accounts.actor, box.raise / 4n); await collect();
    }
    expect(await read(chain, 'BoxHookV2', box.hook, 'closed')).toBe(true);
    await graduate(chain, example, box, evidence);
    expect(await r(chain, box, 'graduated')).toBe(true); expect(await r(chain, box, 'failed')).toBe(false);
    expect(await receiver(chain, box, 'graduationSettled')).toBe(true);
    await collect();
    await call(chain, 'BoxCoordinatorV2', box.coordinator, 'claimReward', [chain.accounts.keeper]);
    complete.add('graduation');
    if (example.properties.includes('item-claim')) await withdrawItem(chain, box, wallet);
    await swap(chain, box, true, chain.accounts.backup, box.raise / 20n); await collect();
    const sellMore = async () => { await swap(chain, box, false, chain.accounts.actor, await token(chain, box, 'balanceOf', [chain.accounts.actor]) / 20n); };
    await sellMore();
    expect(await sellFees(chain, box, evidence, sellMore), 'the graduated sale fee sells for P').toBeGreaterThan(0n);
    await collect();
    if (example.properties.includes('supply-burn')) {
      const { swapStepMinQ } = await read(chain, 'BoxFactoryV2', chain.factory, 'boxQParameters', [box.spec.pricing.listingId, box.raise]);
      // USDC seller-only item burns can start below the real keeper minimum.
      // Accumulate actual trading fees until a step can execute, never inject receiver funds.
      for (let step = 0; step < 32 && await receiver(chain, box, 'buyBackP') < swapStepMinQ; step++) {
        const before = await token(chain, box, 'balanceOf', [chain.accounts.actor]);
        await swap(chain, box, true, chain.accounts.actor, box.raise / 10n); await collect();
        const bought = await token(chain, box, 'balanceOf', [chain.accounts.actor]) - before;
        await swap(chain, box, false, chain.accounts.actor, bought / 2n); await sellFees(chain, box, evidence); await collect();
      }
      expect(await receiver(chain, box, 'buyBackP')).toBeGreaterThanOrEqual(swapStepMinQ);
      await burn(chain, box, evidence); complete.add('supply-burn');
    }
    if (example.properties.includes('pool-growth')) {
      const before = await read(chain, 'BoxHookV2', box.hook, 'pairedLiquidity');
      const receipt = await call(chain, 'BoxHookV2', box.hook, 'deepen', [zeroAddress]);
      const after = await read(chain, 'BoxHookV2', box.hook, 'pairedLiquidity');
      const [deepened] = events(receipt, 'BoxHookV2', box.hook, 'Deepened');
      expect(deepened).toBeDefined(); expect(after).toBe(before + deepened.liquidity); expect(after).toBeGreaterThan(before);
      evidence.depth = { before, after, ...deepened }; complete.add('pool-growth');
    }
    if (example.properties.includes('royalty-creator')) { await royalty(chain, example, box, wallet, evidence, collect); complete.add('royalty-creator'); }
    if (example.properties.includes('creator-claim')) { await creatorClaim(page, chain, example, box, wallet, evidence); complete.add('creator-claim'); }
    if (example.properties.includes('holder-claim')) { await holdersClaim(page, chain, example, box, wallet, evidence); complete.add('holder-claim'); }
    if (example.properties.includes('price-coin-eaten')) { await eatPrice(page, chain, example, box, evidence); complete.add('price-coin-eaten'); }
    const itemsInT = Object.values(example.fees).some(side => side.choice === 'items-t');
    if (example.properties.includes('item-claim')) {
      if (itemsInT) await itemClaimT(page, chain, example, box, wallet, collect, evidence); else await itemClaim(page, chain, example, box, wallet, evidence);
      complete.add('item-claim');
    }
    if (example.properties.includes('shop-life')) {
      const { runJunkyardShop } = await import('./junkyard.mjs');
      const { runOneCollectionShop } = await import('./one-collection-shop.mjs');
      const runShop = example.id === 'junkyard' ? runJunkyardShop : runOneCollectionShop;
      await runShop(chain, example, box, evidence, async () => {
        const before = await token(chain, box, 'balanceOf', [chain.accounts.actor]);
        await swap(chain, box, true, chain.accounts.actor, box.raise / 10n);
        const bought = await token(chain, box, 'balanceOf', [chain.accounts.actor]) - before;
        await swap(chain, box, false, chain.accounts.actor, bought / 2n); await sellFees(chain, box, evidence); await collect();
      }); complete.add('shop-life');
    }
    if (example.properties.includes('pile-pro-rata')) { await redeem(page, chain, example, box, wallet, evidence); complete.add('pile-pro-rata'); }
  }
  await paySafes(chain, box, evidence); complete.add('fee-conservation');
  await pageState(page, chain, example, box, evidence); complete.add('page-state');
}
