/**
 * F156 (SH-ALPHA-TEST-COINS, work package G phase 2): the test-coin page in a browser, on desktop and phone, against
 * the local 31337 alpha with the alpha manifest's `coinDeployment` (scripts/dev-alpha-local.mjs --e2e). The faucet
 * refuses an account the coin has not admitted, then drips once it is admitted, with the plan's gas; a pair swap, one
 * press (SH-ONE-PRESS-TRADE), takes an exact approval and then fills in part after another swap moved the price (its row
 * says so, in the chain's own figure), and its revocation clears what it left.
 * Each project uses accounts of its own (the setup admits none of them), so the desktop and phone runs do not meet.
 */
import { expect, test } from '@playwright/test';
import { encodeFunctionData, erc20Abi, parseAbi } from 'viem';
import { allowanceOf, balanceOf, coinShot, ETHER, extraAccounts, pairSwap, sendFrom, stackOf, testWallet } from './helpers.mjs';

const TETH = parseAbi(['function admit(address[] accounts)']);
const coinsPage = (page) => page.getByRole('region', { name: 'Test coins' });
const card = (page, name) => page.getByRole('region', { name });
const transactions = (page) => page.getByRole('list', { name: 'Transactions' });

/** The page's own Connect press opens the wallet window; the tester picks the test wallet there. */
async function connectHere(page) {
  await coinsPage(page).getByRole('button', { name: 'Connect wallet' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect a browser wallet' });
  await dialog.getByRole('button', { name: /Alpha test wallet/ }).click();
  await expect(dialog).toHaveCount(0);
}

test('the faucet: an account not admitted gets no drip; admitted, one drip with the plan’s gas, then the cooldown', async ({ page }, testInfo) => {
  const stack = stackOf();
  const [account] = await extraAccounts(stack, testInfo, 'faucet');
  const wallet = await testWallet(page, stack, { account });
  await page.goto('/test-coins');
  await expect(coinsPage(page).getByText('Connect a wallet to see your test coins.')).toBeVisible();
  // Browsing asks the wallet nothing, also a quiet second after the page has drawn.
  await page.waitForTimeout(1_000);
  expect(wallet.requests).toEqual([]);
  await coinShot(page, testInfo, 'coins-connect', coinsPage(page));
  await connectHere(page);

  const faucet = card(page, 'Faucet');
  // A wallet the faucet does not admit (its switch off): one neutral line (XR-ALPHA-SITE af2: trade-words.ts
  // NOT_ON_LIST_LINE; the Claim card carries the call to sign in and claim), no drip, no facts of the faucet's.
  await expect(faucet.getByRole('status')).toHaveText('This wallet is not on the alpha list.', { timeout: 60_000 });
  await expect(faucet.getByText('Next drip')).toHaveCount(0);
  await expect(faucet.getByText('Left today')).toHaveCount(0);
  await expect(faucet.getByRole('button', { name: /^Get / })).toHaveCount(0);
  await coinShot(page, testInfo, 'coins-not-admitted', coinsPage(page), { whole: true });

  // The founder puts the account on the list (the coin's owner, W, admits it); the page reads it again on its own. Then
  // the next drip (due now) and today's cap, shared by every tester (the setup's own drips came out of it), and the drip.
  await sendFrom(stack, stack.accounts.owner, stack.assets.teth, encodeFunctionData({ abi: TETH, functionName: 'admit', args: [[account]] }));
  await expect(faucet.getByText('Next drip')).toBeVisible({ timeout: 60_000 });
  await expect(faucet.getByText('Now', { exact: true })).toBeVisible();
  await expect(faucet).toContainText(/Left today[\d,.]+ tETH/);
  await expect(faucet.getByRole('status')).toHaveCount(0);
  const drip = faucet.getByRole('button', { name: 'Get 1 tETH' });
  await expect(drip).toBeEnabled({ timeout: 60_000 });
  await coinShot(page, testInfo, 'coins-drip-ready', faucet);
  const before = await balanceOf(stack, stack.assets.teth, account);
  const asked = wallet.requests.length;
  await drip.click();
  await expect(transactions(page)).toContainText('Drip confirmed', { timeout: 60_000 });
  expect(await balanceOf(stack, stack.assets.teth, account)).toBe(before + ETHER);
  // One press, one transaction: the drip to tETH, with the plan's gas (at least 480,000).
  expect(wallet.requests.slice(asked).filter((method) => method === 'eth_sendTransaction')).toHaveLength(1);
  const sent = wallet.sent.at(-1);
  expect(sent.to.toLowerCase()).toBe(stack.assets.teth.toLowerCase());
  expect(BigInt(sent.gas)).toBeGreaterThanOrEqual(480_000n);
  // The faucet's own figure (its estimate and a fifth more), not a trade's 4M floor.
  expect(BigInt(sent.gas)).toBeLessThan(1_000_000n);
  // Cooling down: when the next drip is due (a day on), no button and no line.
  await expect(faucet).toContainText(/Next drip\d+ \w+, \d\d:\d\d UTC/, { timeout: 60_000 });
  await expect(faucet.getByRole('button', { name: /^Get / })).toHaveCount(0);
  await expect(faucet.getByRole('status')).toHaveCount(0);
  await coinShot(page, testInfo, 'coins-dripped', coinsPage(page), { whole: true });
});

test('a pair swap in one press: the exact approval, then a part fill after another swap, the revocation; then a sale back', async ({ page }, testInfo) => {
  const stack = stackOf();
  const [account] = await extraAccounts(stack, testInfo, 'swap');
  const usdc = stack.assets.usdc;
  const helper = stack.localDeployment.poolSwapTest;
  // W hands the account 50 tETH it already holds (no mint).
  await sendFrom(stack, stack.accounts.owner, stack.assets.teth, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [account, 50n * ETHER] }));
  // A browser wallet: each send waits in its window until the test answers it.
  const wallet = await testWallet(page, stack, { account, hold: true });
  await page.goto('/test-coins');
  await connectHere(page);

  const swap = card(page, 'Swap');
  await swap.getByRole('combobox', { name: 'Coin' }).selectOption({ label: 'tUSDC' });
  await swap.getByRole('textbox', { name: 'Amount in tETH' }).fill('20');
  // One button and what the swap gets, before any approval (SH-ONE-PRESS-TRADE).
  const go = swap.getByRole('button', { name: 'Swap', exact: true });
  await expect(go).toBeEnabled({ timeout: 60_000 });
  await expect(swap.getByText(/^≈ /)).toBeVisible();
  await expect(swap.getByText('Can fill in part; no deadline.')).toBeVisible();
  await expect(swap.getByRole('button', { name: /^Approve/ })).toHaveCount(0);
  await coinShot(page, testInfo, 'coins-swap-ready', swap);
  await go.click();
  // The exact approval first, to PoolSwapTest; then the swap's request follows by itself.
  await expect.poll(() => wallet.asked.length, { timeout: 60_000 }).toBe(1);
  expect(wallet.asked[0].to.toLowerCase()).toBe(stack.assets.teth.toLowerCase());
  wallet.confirm();
  await expect(transactions(page)).toContainText('Approval confirmed', { timeout: 60_000 });
  expect(await allowanceOf(stack, stack.assets.teth, account, helper)).toBe(20n * ETHER);
  await expect.poll(() => wallet.asked.length, { timeout: 60_000 }).toBe(2);
  expect(wallet.asked[1].to.toLowerCase()).toBe(helper.toLowerCase());
  // Another tester swaps tETH for tUSDC first, while the swap waits in the wallet: the price moves toward its limit.
  await pairSwap(stack, stack.accounts.owner, stack.assets.teth, usdc, 20n * ETHER);
  const usdcBefore = await balanceOf(stack, usdc, account);
  wallet.confirm();
  const swapped = transactions(page).locator('li', { hasText: /^Swap / }).first();
  await expect(swapped).toHaveText(/^Swap filled in part: [\d.,]+ of 20 tETH/, { timeout: 60_000 });
  expect(await balanceOf(stack, usdc, account)).toBeGreaterThan(usdcBefore);
  // It stopped at its price limit: part of the approval is left, and its revocation is offered. The row's figure is
  // what the chain took: the 20 tETH less what is left.
  const left = await allowanceOf(stack, stack.assets.teth, account, helper);
  expect(left).toBeGreaterThan(0n);
  expect(left).toBeLessThan(20n * ETHER);
  await expect(swapped).toHaveAttribute('data-fill', 'part');
  await expect(swapped).toHaveAttribute('data-spent', (20n * ETHER - left).toString());
  const revoke = swap.getByRole('button', { name: /^Revoke [\d.,]+ tETH$/ });
  await expect(revoke).toBeEnabled({ timeout: 60_000 });
  await coinShot(page, testInfo, 'coins-revoke', swap);
  await revoke.click();
  await expect.poll(() => wallet.asked.length, { timeout: 60_000 }).toBe(3);
  wallet.confirm();
  await expect(transactions(page)).toContainText('Approval cleared confirmed', { timeout: 60_000 });
  expect(await allowanceOf(stack, stack.assets.teth, account, helper)).toBe(0n);

  // A sale back, one press: tUSDC for tETH, its own exact approval of tUSDC, then the swap (a full fill leaves nothing
  // to revoke).
  await swap.getByRole('radio', { name: 'Sell tUSDC' }).check();
  await swap.getByRole('textbox', { name: 'Amount in tUSDC' }).fill('100');
  await expect(go).toBeEnabled({ timeout: 60_000 });
  const tethBefore = await balanceOf(stack, stack.assets.teth, account);
  await go.click();
  await expect.poll(() => wallet.asked.length, { timeout: 60_000 }).toBe(4);
  wallet.confirm();
  await expect(transactions(page).getByText('Approval confirmed')).toHaveCount(2, { timeout: 60_000 });
  await expect.poll(() => wallet.asked.length, { timeout: 60_000 }).toBe(5);
  wallet.confirm();
  const sold = transactions(page).locator('li', { hasText: /^Swap confirmed: 100 tUSDC/ });
  await expect(sold).toBeVisible({ timeout: 60_000 });
  await expect(sold).toHaveAttribute('data-fill', 'whole');
  expect(await balanceOf(stack, stack.assets.teth, account)).toBeGreaterThan(tethBefore);
  expect(await allowanceOf(stack, usdc, account, helper)).toBe(0n);
  // A full fill used the approval up: no revocation is offered. The amount clears only once the page has read what was
  // left approved, so the check waits for that first.
  await expect(swap.getByRole('textbox', { name: 'Amount in tUSDC' })).toHaveValue('', { timeout: 60_000 });
  await expect(swap.getByRole('button', { name: /^Revoke/ })).toHaveCount(0);
  await coinShot(page, testInfo, 'coins-sold', coinsPage(page), { whole: true });
  // Five sends from three presses: approve and swap, revoke, approve and swap.
  expect(wallet.requests.filter((method) => method === 'eth_sendTransaction')).toHaveLength(5);
  expect(wallet.waiting()).toBe(0);
});
