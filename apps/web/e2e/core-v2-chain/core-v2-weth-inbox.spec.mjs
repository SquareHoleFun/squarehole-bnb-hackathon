import { expect, test } from '@playwright/test';
import { decodeFunctionData, encodeFunctionData, erc20Abi, parseAbi, zeroAddress } from 'viem';
import { artifact } from '../../../../packages/chain/scripts/lib/core-v2-local-manifest.mjs';
import { localClient } from '../../../../packages/chain/scripts/local-core-v2-chain.mjs';
import { send } from '../../../../packages/chain/scripts/lib/core-v2-local-runtime.mjs';
import { boxPath, description, feedCard, read, readLocalBox, testWallet } from './helpers.mjs';

/**
 * SH-RC7 open items 14 and 29 (SH-V21-RC6-INT P3.6, P3.10 item 6, P5.8 item 6) on the local stack. The USDC box's income
 * inbox offers WETH, its sale list's coin with the release's 0.05 WETH lot. `observe(WETH)` and `refreshOrder(WETH)` wrap
 * the inbox's ETH first, so ETH counts toward WETH's lot (as our keeper counts it): the page must not call a WETH balance
 * below one lot when ETH beside it makes a whole lot (item 29), and on this stack's WETH, an ERC-20 like WETH9, the
 * order registers (item 14; the local twin's MockWETH had no approve or allowance, so the refresh reverted
 * TokenUnreadable). Runs last in the suite: it adds coins to the USDC box's inbox that no other spec reads.
 *
 * SH-RC7-SITE-INBOX (rc7 open item 11): the box page's guarded public controls on the real inbox. Below one lot with no
 * clock, the WETH row offers "Start clock" (observe), and its press starts the clock on chain; with a whole lot in WETH
 * and ETH it offers "Refresh · 1 lot", whose press wraps the ETH and registers the order, after which neither shows.
 * The controls show only after the page read the inbox's own state (its recorded approval, hour and spent capacity in
 * storage among them) and dry-ran the call against this chain.
 */
const WETH9 = parseAbi(['function deposit() payable']);

async function usdcInbox(chain) {
  const coordinator = chain.boxes.usdc;
  const box = await readLocalBox(chain, coordinator);
  const inbox = await read(chain, 'BoxCoordinatorV2', coordinator, 'roleAddress', [8n]);
  const weth = await read(chain, 'BoxRoyaltyRouterV2', inbox, 'weth');
  const client = localClient(chain);
  const balances = async () => ({
    weth: await client.readContract({ abi: erc20Abi, address: weth, functionName: 'balanceOf', args: [inbox] }),
    eth: await client.getBalance({ address: inbox }),
  });
  return { box, inbox, weth, lot: await read(chain, 'BoxRoyaltyRouterV2', inbox, 'lotSize', [weth]), balances };
}

/** The box page once the indexer has read the chain's latest block; its Inbox details opened. */
async function openInbox(page, chain, token) {
  await feedCard(chain, token);
  await page.goto(boxPath(chain, token));
  await expect(page.locator('.sh-v2-page')).toBeVisible();
  await page.locator('details > summary').filter({ hasText: /^Inbox$/ }).click();
}
const coinRow = (page, coin) => page.locator(`[data-coin="${coin.toLowerCase()}"]`);
/**
 * The wallet requests that ask the user something. After a press connected the test wallet, a later page load in the
 * same browser reads the remembered connection silently (F135's exception: `eth_accounts`, here with `eth_chainId`).
 */
const prompts = (requests) => requests.filter((method) => method !== 'eth_accounts' && method !== 'eth_chainId');
/** A press of the site's control through the test wallet: the first opens the wallet window, the second its confirmation. */
async function press(page, button) {
  await button.click();
  const dialog = page.getByRole('dialog', { name: 'Connect a browser wallet' });
  const group = page.getByRole('group', { name: 'Confirm transaction' });
  await expect(dialog.or(group)).toBeVisible();
  if (await dialog.isVisible()) {
    await dialog.getByRole('button', { name: 'Local v2 test wallet' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await button.click();
  }
  await group.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByText('Confirmed. Reading the updated box…')).toBeVisible();
}

test('SH-RC7 item 29: the WETH row counts the inbox’s ETH toward one lot', async ({ page }) => {
  const chain = description(); const wallet = await testWallet(page, chain);
  const { box, inbox, weth, lot, balances } = await usdcInbox(chain);
  expect(lot, 'the release’s WETH lot').toBe(5n * 10n ** 16n);
  const before = await balances();
  const wrapped = lot / 5n; const native = lot;
  expect(before.weth + wrapped, 'WETH alone stays below one lot').toBeLessThan(lot);
  const { actor } = chain.accounts;
  await send(chain.rpcUrl, { from: actor, to: weth, data: encodeFunctionData({ abi: WETH9, functionName: 'deposit' }), value: wrapped });
  await send(chain.rpcUrl, { from: actor, to: weth, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [inbox, wrapped] }) });
  // SH-RC7-SITE-INBOX: WETH below one lot whose clock nobody started: the page offers the public observation, and
  // reading it asked the wallet nothing. The press starts the clock on chain.
  expect(await read(chain, 'BoxRoyaltyRouterV2', inbox, 'oldestUnsoldAt', [weth]), 'no clock yet').toBe(0n);
  await openInbox(page, chain, box.token);
  await expect(page.locator('main')).toContainText(`${weth.toLowerCase()}: ${before.weth + wrapped} raw units · below one lot; waiting for observation`);
  const start = coinRow(page, weth).getByRole('button', { name: 'Start clock' });
  await expect(start).toBeVisible();
  expect(wallet.requests, 'reading and dry-running the control never asks the wallet').toEqual([]);
  await press(page, start);
  expect(await read(chain, 'BoxRoyaltyRouterV2', inbox, 'oldestUnsoldAt', [weth]), 'the clock started').toBeGreaterThan(0n);
  expect(wallet.sent.map((tx) => tx.to.toLowerCase())).toEqual([inbox.toLowerCase()]);
  wallet.requests.length = 0;
  await send(chain.rpcUrl, { from: actor, to: inbox, value: native });
  const held = await balances();
  expect(held).toEqual({ weth: before.weth + wrapped, eth: before.eth + native });
  await openInbox(page, chain, box.token);
  const main = page.locator('main');
  await expect(main).toContainText(`${zeroAddress}: ${held.eth} raw units`);
  // WETH and ETH together make a whole lot, which the next refresh wraps and offers: never "below one lot".
  await expect(main).toContainText(`${weth.toLowerCase()}: ${held.weth} raw units · for sale`);
  await expect(main).not.toContainText('below one lot');
  // SH-RC7-SITE-INBOX: the refresh would register one whole lot, so the page offers it (pressed in the next test).
  await expect(coinRow(page, weth).getByRole('button', { name: 'Refresh · 1 lot' })).toBeVisible();
  expect(prompts(wallet.requests), 'reading the inbox never asks the wallet anything').toEqual([]);
});

test('SH-RC7 item 14: a WETH inbox order registers on the local stack', async ({ page }) => {
  const chain = description(); const wallet = await testWallet(page, chain);
  const { box, inbox, weth, lot, balances } = await usdcInbox(chain);
  const before = await balances();
  expect(before.weth + before.eth, 'the first test left a whole lot in WETH and ETH').toBeGreaterThanOrEqual(lot);
  const relayer = await read(chain, 'BoxRoyaltyRouterV2', inbox, 'vaultRelayer');
  // Anyone may refresh; the inbox wraps its ETH, then approves whole lots of WETH for the VaultRelayer. SH-RC7-SITE-INBOX:
  // through the box page's own guarded control, read and dry-run first, the wallet asked only on the press.
  await openInbox(page, chain, box.token);
  const refresh = coinRow(page, weth).getByRole('button', { name: 'Refresh · 1 lot' });
  await expect(refresh).toBeVisible();
  expect(wallet.requests).toEqual([]);
  await press(page, refresh);
  expect(wallet.sent).toHaveLength(1);
  expect(decodeFunctionData({ abi: artifact('BoxRoyaltyRouterV2').abi, data: wallet.sent[0].data })).toMatchObject({ functionName: 'refreshOrder', args: [weth] });
  const total = before.weth + before.eth;
  expect(await balances()).toEqual({ weth: total, eth: 0n });
  expect(await read(chain, 'BoxRoyaltyRouterV2', inbox, 'orderRegistered', [weth])).toBe(true);
  expect(await localClient(chain).readContract({ abi: erc20Abi, address: weth, functionName: 'allowance', args: [inbox, relayer] }))
    .toBe(total / lot * lot);
  wallet.requests.length = 0;
  await openInbox(page, chain, box.token);
  await expect(page.locator('main')).toContainText(`${weth.toLowerCase()}: ${total} raw units · for sale`);
  await expect(page.locator('main')).not.toContainText(`${zeroAddress}:`);
  // Registered with its whole lot approved and its clock running: neither control would change anything now.
  await expect(coinRow(page, weth).locator('.sh-v2-history')).toBeVisible();
  await expect(coinRow(page, weth).getByRole('button')).toHaveCount(0);
  expect(prompts(wallet.requests)).toEqual([]);
});
