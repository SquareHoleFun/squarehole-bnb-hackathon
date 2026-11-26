/**
 * SH-ONE-PRESS-TRADE: one press per trade, in a browser, at 1440×900 and on a phone (390×844), against the local 31337
 * alpha (playwright.alpha-trade.config.ts), on the test-coin page's swap card (tETH for tUSDC). Each test has an account
 * of its own (anvil sends from it as from its unlocked ones; W hands it tETH, no mint), so no test meets another's. The
 * box page's own one press is in trade-box.spec.mjs. What each proves:
 * - an approval needed: one press, two sends (the exact approval, then the swap), and the ticks to done;
 * - no approval needed (it is already exact): one press, one send, no ticks;
 * - the plan made after the approval is past the person's tolerance (another swap landed meanwhile): no swap is sent;
 *   the line and the new quote, whose own press sends it;
 * - a browser wallet: one press, the wallet asks twice, the second time by itself once the approval is mined;
 * - the in-flight rule: a press's send held in the wallet holds the account on every page of the visit; a box page
 *   follows it to its receipt, and the press whose page has gone never sends its swap;
 * - a swap that reaches the chain after the price passed its limit: the decoded revert, said with the tolerance.
 * SH_EVIDENCE_SCREENSHOTS=one-press writes the swap card's states to docs/evidence/SH-ONE-PRESS-TRADE/.
 */
import { expect, test } from '@playwright/test';
import { decodeFunctionData, encodeFunctionData, erc20Abi } from 'viem';
import { allowanceOf, balanceOf, boxPath, chain, ETHER, freshAccount, pairSwap, pressShot, sendFrom, stackOf, testWallet, ticksOf, tradeBox } from './helpers.mjs';

test.describe.configure({ mode: 'serial' });

const TOKEN_ABI = [{ type: 'function', name: 'token', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }];
const card = (page, name) => page.getByRole('region', { name });
const transactions = (page) => page.getByRole('list', { name: 'Transactions' });
const swapRow = (page, text) => transactions(page).locator('li', { hasText: text });

/** The test-coin page for a new account of this test's, connected, its swap card on tUSDC. */
async function openSwap(page, testInfo, name, { hold = false, approved = 0n } = {}) {
  const stack = stackOf();
  const account = await freshAccount(stack, testInfo, name, { teth: 10n * ETHER });
  // An approval already in place, exactly what the swap needs (an earlier press that stopped after it).
  if (approved > 0n) await sendFrom(stack, account, stack.assets.teth, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [stack.localDeployment.poolSwapTest, approved] }));
  const wallet = await testWallet(page, stack, { account, hold });
  await page.goto('/test-coins');
  await page.getByRole('region', { name: 'Test coins' }).getByRole('button', { name: 'Connect wallet' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect a browser wallet' });
  await dialog.getByRole('button', { name: /Alpha test wallet/ }).click();
  await expect(dialog).toHaveCount(0);
  const swap = card(page, 'Swap');
  await swap.getByRole('combobox', { name: 'Coin' }).selectOption({ label: 'tUSDC' });
  return { stack, account, wallet, swap, go: swap.getByRole('button', { name: 'Swap', exact: true }) };
}

/** The amount, and the quote it gets: the press's button ready, what the swap gets on show. */
async function quote(swap, go, amount) {
  await swap.getByRole('textbox', { name: 'Amount in tETH' }).fill(amount);
  await expect(go).toBeEnabled({ timeout: 60_000 });
  await expect(swap.locator('.sh-trade-box__out')).toHaveText(/^≈ /);
  return swap.locator('.sh-trade-box__out').textContent();
}

test('an approval needed: one press, two sends (the exact approval, then the swap); the ticks to done', async ({ page }, testInfo) => {
  const { stack, account, wallet, swap, go } = await openSwap(page, testInfo, 'two-sends');
  const helper = stack.localDeployment.poolSwapTest;
  await quote(swap, go, '1');
  // One button: no Approve, no ticks before the press.
  await expect(swap.getByRole('button', { name: /^Approve/ })).toHaveCount(0);
  await expect(swap.getByRole('list', { name: 'Progress' })).toHaveCount(0);
  const usdcBefore = await balanceOf(stack, stack.assets.usdc, account);
  await go.click();
  await expect(swapRow(page, /^Swap confirmed: 1 tETH/)).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => ticksOf(swap)).toEqual([['approve', 'done'], ['trade', 'done']]);
  // Two sends from the one press: the exact approval of 1 tETH to PoolSwapTest, then the swap through it.
  expect(wallet.sent.map((tx) => tx.to.toLowerCase())).toEqual([stack.assets.teth, helper].map((a) => a.toLowerCase()));
  expect(decodeFunctionData({ abi: erc20Abi, data: wallet.sent[0].data }).args).toEqual([helper, ETHER]);
  expect(await allowanceOf(stack, stack.assets.teth, account, helper)).toBe(0n);
  expect(await balanceOf(stack, stack.assets.usdc, account)).toBeGreaterThan(usdcBefore);
  await expect(transactions(page)).toContainText('Approval confirmed');
});

test('no approval needed (it is already exact): one press, one send, no ticks', async ({ page }, testInfo) => {
  const { stack, wallet, swap, go } = await openSwap(page, testInfo, 'one-send', { approved: ETHER });
  await quote(swap, go, '1');
  await go.click();
  await expect(swapRow(page, /^Swap confirmed: 1 tETH/)).toBeVisible({ timeout: 60_000 });
  expect(wallet.sent.map((tx) => tx.to.toLowerCase())).toEqual([stack.localDeployment.poolSwapTest.toLowerCase()]);
  await expect(swap.getByRole('list', { name: 'Progress' })).toHaveCount(0);
});

test('the plan made after the approval is past the tolerance: no swap is sent; the line, and the new quote with its own press', async ({ page }, testInfo) => {
  const { stack, wallet, swap, go } = await openSwap(page, testInfo, 'moved', { hold: true });
  const helper = stack.localDeployment.poolSwapTest;
  const shown = await quote(swap, go, '1');
  await go.click();
  await expect.poll(() => wallet.asked.length, { timeout: 60_000 }).toBe(1);
  // While the approval waits in the wallet, another tester swaps 100 tETH for tUSDC: the price moves far past 2%.
  await pairSwap(stack, stack.accounts.owner, stack.assets.teth, stack.assets.usdc, 100n * ETHER);
  wallet.confirm();
  await expect(swap.getByRole('status')).toHaveText('Price moved over your 2% tolerance. Check the new quote.', { timeout: 60_000 });
  await expect.poll(() => ticksOf(swap)).toEqual([['approve', 'done'], ['trade', 'stopped']]);
  // The new quote, with its own press; nothing more was asked of the wallet.
  await expect(go).toBeEnabled({ timeout: 60_000 });
  await expect(swap.locator('.sh-trade-box__out')).not.toHaveText(shown ?? '');
  await page.waitForTimeout(1_500);
  expect(wallet.asked).toHaveLength(1);
  await pressShot(page, testInfo, 'price-moved', swap);
  // That press sends the swap the person now sees, alone: the approval is in place.
  await go.click();
  await expect.poll(() => wallet.asked.length, { timeout: 60_000 }).toBe(2);
  expect(wallet.asked[1].to.toLowerCase()).toBe(helper.toLowerCase());
  wallet.confirm();
  await expect(swapRow(page, /^Swap confirmed: 1 tETH/)).toBeVisible({ timeout: 60_000 });
});

test('a browser wallet: one press, and the wallet asks twice; the second request comes by itself once the approval is mined', async ({ page }, testInfo) => {
  const { stack, wallet, swap, go } = await openSwap(page, testInfo, 'browser', { hold: true });
  const helper = stack.localDeployment.poolSwapTest;
  await quote(swap, go, '1');
  // The one press.
  await go.click();
  await expect.poll(() => wallet.asked.length, { timeout: 60_000 }).toBe(1);
  expect(wallet.asked[0].to.toLowerCase()).toBe(stack.assets.teth.toLowerCase());
  await expect(swap.getByRole('button', { name: 'Confirm in your wallet…' })).toBeVisible();
  await expect.poll(() => ticksOf(swap)).toEqual([['approve', 'active'], ['trade', 'waiting']]);
  await pressShot(page, testInfo, 'swap-approving', swap);
  wallet.confirm();
  // Mined, the plan made again; the swap's request comes to the wallet with no second press on the page.
  await expect.poll(() => wallet.asked.length, { timeout: 60_000 }).toBe(2);
  expect(wallet.asked[1].to.toLowerCase()).toBe(helper.toLowerCase());
  await expect.poll(() => ticksOf(swap)).toEqual([['approve', 'done'], ['trade', 'active']]);
  await expect(swap.getByRole('button', { name: 'Confirm in your wallet…' })).toBeVisible();
  await pressShot(page, testInfo, 'swap-mid-press', swap);
  wallet.confirm();
  await expect(swapRow(page, /^Swap confirmed: 1 tETH/)).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => ticksOf(swap)).toEqual([['approve', 'done'], ['trade', 'done']]);
  await pressShot(page, testInfo, 'swap-done', swap);
  expect(wallet.requests.filter((method) => method === 'eth_sendTransaction')).toHaveLength(2);
});

test('the in-flight rule: a press’s send in the wallet holds the account on every page; a box page follows it, and the press whose page has gone sends no swap', async ({ page }, testInfo) => {
  const { stack, wallet, swap, go } = await openSwap(page, testInfo, 'in-flight', { hold: true });
  await quote(swap, go, '1');
  await go.click();
  await expect.poll(() => wallet.asked.length, { timeout: 60_000 }).toBe(1);
  // To a box page inside the site (no reload: the visit's one slot per account stays): the box follows the send.
  const token = await chain(stack).readContract({ address: stack.boxes.teth, abi: TOKEN_ABI, functionName: 'token' });
  await page.getByRole('link', { name: 'Square Hole home' }).click();
  await page.locator(`a[href="${boxPath(token)}"]`).first().click();
  await expect(tradeBox(page).getByRole('status')).toHaveText('Confirm or reject it in your wallet.', { timeout: 30_000 });
  wallet.confirm();
  await expect(tradeBox(page).getByRole('list', { name: 'Transactions' })).toContainText('Approval confirmed', { timeout: 60_000 });
  // The press whose page has gone stopped with its approval: no swap reached the wallet.
  await page.waitForTimeout(3_000);
  expect(wallet.asked).toHaveLength(1);
  // Back on the test-coin page, the approval is in place: the swap's own press sends it alone.
  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(/\/test-coins$/);
  const back = card(page, 'Swap');
  await back.getByRole('combobox', { name: 'Coin' }).selectOption({ label: 'tUSDC' });
  const again = back.getByRole('button', { name: 'Swap', exact: true });
  await quote(back, again, '1');
  await again.click();
  await expect.poll(() => wallet.asked.length, { timeout: 60_000 }).toBe(2);
  expect(wallet.asked[1].to.toLowerCase()).toBe(stack.localDeployment.poolSwapTest.toLowerCase());
  wallet.confirm();
  await expect(swapRow(page, /^Swap confirmed: 1 tETH/)).toBeVisible({ timeout: 60_000 });
});

test('a swap that lands after the price passed its limit: the decoded revert, said with the tolerance and what to do', async ({ page }, testInfo) => {
  const { stack, account, wallet, swap, go } = await openSwap(page, testInfo, 'past-limit', { hold: true, approved: ETHER });
  await quote(swap, go, '1');
  await go.click();
  await expect.poll(() => wallet.asked.length, { timeout: 60_000 }).toBe(1);
  // While the swap waits in the wallet, another tester's 100 tETH moves the price past the swap's limit.
  await pairSwap(stack, stack.accounts.owner, stack.assets.teth, stack.assets.usdc, 100n * ETHER);
  wallet.confirm();
  await expect(swap.getByRole('status')).toHaveText('Price moved over your 2% tolerance. Raise it or trade less.', { timeout: 60_000 });
  await expect(swapRow(page, /^Swap reverted/)).toContainText('Price already past your limit.');
  // The revert left the approval: its revocation is offered, as after any swap.
  await expect(swap.getByRole('button', { name: 'Revoke 1 tETH' })).toBeEnabled({ timeout: 60_000 });
  expect(await allowanceOf(stack, stack.assets.teth, account, stack.localDeployment.poolSwapTest)).toBe(ETHER);
  await pressShot(page, testInfo, 'tolerance-line', swap);
});
