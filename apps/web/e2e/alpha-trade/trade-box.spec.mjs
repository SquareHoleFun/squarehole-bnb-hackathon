/**
 * F156 / F157 Q1 (SH-ALPHA-TRADE-BOX): the buy/sell box on a v2 box page, at 1440×900 and on a phone (390×844), on a
 * fresh local 31337 alpha (playwright.alpha-trade.config.ts). Each test makes its own boxes and moves the chain's clock
 * forward only, so the tests run one after another on one chain. What each proves:
 * - browsing (the feed, both boxes, settings) asks the wallet nothing, and a box before its open shows one line;
 * - a window buy with ETH shows the launch tax in large type with its step's end, a router revert as its one line
 *   (AmountTooSmall from the plan's own simulation), and goes through the box's launch router;
 * - on the curve, a tETH buy is one press (SH-ONE-PRESS-TRADE): its exact approval first, then the buy, whose request
 *   follows by itself and fills in part after another tester's buy (the price limit), says so in its row with the
 *   chain's own figure, then offers the revocation of what is left; a sale approves the box token exactly and fills;
 * - on the curve with ETH, a buy the quote expects whole fills in part after another tester's buy: its row says so,
 *   and what left the wallet (gas aside) is the row's figure, the rest paid back in the same transaction;
 * - a stale read stops the box: no quote, no wallet request, one line; current again, the quote comes back;
 * - a buy past the curve's end fills in part and closes the curve: one line until graduate(); then pool sales.
 * SH_EVIDENCE_SCREENSHOTS=1 writes the box in every state to docs/evidence/screenshots/sh-alpha-trade-box/.
 */
import { expect, test } from '@playwright/test';
import { parseUnits } from 'viem';
import { ETHER, allowanceOf, balanceOf, boxPath, chain, competingPoolBuy, connect, graduate, newBox, phaseOf, press, pressShot, rpcMethods, shot, stackOf, testWallet, ticksOf, tradeBox, warp } from './helpers.mjs';

const TOKEN_ABI = [{ type: 'function', name: 'token', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }];

test.describe.configure({ mode: 'serial' });

const amountField = (page, unit) => tradeBox(page).getByRole('textbox', { name: `Amount in ${unit}` });
const status = (page) => tradeBox(page).getByRole('status');
const receipts = (page) => tradeBox(page).getByRole('list', { name: 'Transactions' });
/** The box's row of its buy (one buy per test here). */
const buyRow = (page) => receipts(page).locator('li', { hasText: /^Buy / });

test('browsing asks the wallet nothing; a box before its open shows one line', async ({ page }, testInfo) => {
  const stack = stackOf();
  const wallet = await testWallet(page, stack);
  const upcoming = await newBox(stack, 'eth', { openIn: 3_600n });
  for (const coordinator of Object.values(stack.boxes)) {
    const token = await chain(stack).readContract({ address: coordinator, abi: TOKEN_ABI, functionName: 'token' });
    await page.goto('/');
    await expect(page.locator(`a[href="${boxPath(token)}"]`).first()).toBeVisible();
    await page.locator(`a[href="${boxPath(token)}"]`).first().click();
    await expect(tradeBox(page)).toBeVisible();
    await page.goto('/settings');
    await page.goBack();
    await expect(tradeBox(page)).toBeVisible();
  }
  await page.goto(boxPath(upcoming.token));
  await expect(tradeBox(page)).toHaveText(/^Buy and sellOpens \d+ \w+, \d\d:\d\d UTC\.$/);
  await expect(tradeBox(page).getByRole('textbox')).toHaveCount(0);
  await shot(page, testInfo, 'upcoming');
  await shot(page, testInfo, 'upcoming-page', { whole: true });
  expect(wallet.requests, 'navigation never asks the wallet anything').toEqual([]);
});

test('a window buy with ETH: the tax in large type, a router revert as its line, the buy through the router', async ({ page }, testInfo) => {
  const stack = stackOf();
  const wallet = await testWallet(page, stack);
  const box = await newBox(stack, 'eth');
  await warp(stack, box.openAt + 1n);
  expect(await phaseOf(stack, box)).toBe(2);
  await page.goto(boxPath(box.token));
  const tax = tradeBox(page).locator('.sh-trade-box__tax-value');
  await expect(tax).toHaveText('93.20%');
  // Large type: the tax's font is at least 30 px (2.5rem on a desktop, 2rem on a phone).
  expect(BigInt(/^\d+/.exec(await tax.evaluate((element) => getComputedStyle(element).fontSize))?.[0] ?? '0')).toBeGreaterThanOrEqual(30n);
  await expect(tradeBox(page)).toContainText(/Launch tax93\.20%until \d\d:\d\d:\d\d UTC/);
  await expect(tradeBox(page)).not.toContainText('Can fill in part');
  expect(wallet.requests, 'a box page asks the wallet nothing').toEqual([]);
  await shot(page, testInfo, 'window-tax');
  await connect(page);
  expect(wallet.requests).not.toContain('eth_sendTransaction');
  // The router's own revert, from the plan's simulation: one wei is all tax, nothing left to swap (AmountTooSmall).
  await amountField(page, 'ETH').fill('0.000000000000000001');
  await expect(status(page)).toHaveText('Amount too small.');
  await shot(page, testInfo, 'revert-line');
  const before = await balanceOf(stack, box.token, stack.accounts.tester);
  await amountField(page, 'ETH').fill('0.001');
  await expect(tradeBox(page).locator('.sh-trade-box__out')).toHaveText(/^≈ /);
  await shot(page, testInfo, 'window-quote');
  await press(page, 'Buy');
  // Whole, as the router's TaxedBuy says (nothing paid back): the row says what went in.
  await expect(buyRow(page)).toHaveText(/^Buy confirmed: 0\.001 ETH/, { timeout: 60_000 });
  await expect(buyRow(page)).toHaveAttribute('data-fill', 'whole');
  await expect(buyRow(page)).toHaveAttribute('data-spent', parseUnits('0.001', 18).toString());
  await shot(page, testInfo, 'window-confirmed');
  const [buy] = wallet.sent;
  expect(wallet.sent).toHaveLength(1);
  expect(buy.to.toLowerCase()).toBe(box.router.toLowerCase());
  expect(BigInt(buy.value)).toBe(parseUnits('0.001', 18));
  expect(BigInt(buy.chainId)).toBe(31337n);
  expect(await balanceOf(stack, box.token, stack.accounts.tester)).toBeGreaterThan(before);
});

test('on the curve with tETH, one press: the exact approval, then a buy that fills in part after another buyer, the revocation; then a sale', async ({ page }, testInfo) => {
  const stack = stackOf();
  // A browser wallet: each send waits in its window until the test answers it.
  const wallet = await testWallet(page, stack, { hold: true });
  const box = await newBox(stack, 'teth');
  await warp(stack, box.openAt + 400n);
  expect(await phaseOf(stack, box)).toBe(3);
  const helper = stack.localDeployment.poolSwapTest;
  await page.goto(boxPath(box.token));
  await expect(tradeBox(page).getByRole('radio', { name: 'Buy' })).toBeChecked();
  await connect(page);
  await amountField(page, 'tETH').fill('0.1');
  // Before any approval: one button, and what the buy gets (SH-ONE-PRESS-TRADE).
  const buy = tradeBox(page).getByRole('button', { name: 'Buy', exact: true });
  await expect(buy).toBeEnabled({ timeout: 60_000 });
  await expect(tradeBox(page).locator('.sh-trade-box__out')).toHaveText(/^≈ /);
  await expect(tradeBox(page)).toContainText('Can fill in part; no deadline.');
  await expect(tradeBox(page).getByRole('button', { name: /^Approve/ })).toHaveCount(0);
  await shot(page, testInfo, 'buy-ready');
  const spentBefore = await balanceOf(stack, box.p, stack.accounts.tester);
  await buy.click();
  // The exact approval first; once it is mined, the buy's request follows by itself.
  await expect.poll(() => wallet.asked.length, { timeout: 60_000 }).toBe(1);
  expect(wallet.asked[0].to.toLowerCase()).toBe(box.p.toLowerCase());
  wallet.confirm();
  await expect.poll(() => wallet.asked.length, { timeout: 60_000 }).toBe(2);
  expect(wallet.asked[1].to.toLowerCase()).toBe(helper.toLowerCase());
  expect(await allowanceOf(stack, box.p, stack.accounts.tester, helper)).toBe(ETHER / 10n);
  await expect.poll(() => ticksOf(tradeBox(page))).toEqual([['approve', 'done'], ['trade', 'active']]);
  await expect(tradeBox(page).getByRole('button', { name: 'Confirm in your wallet…' })).toBeVisible();
  await pressShot(page, testInfo, 'box-mid-press', tradeBox(page));
  // Another tester buys as much first, while the buy waits in the wallet: the price moves toward its limit, so the buy
  // stops there, in part.
  await competingPoolBuy(stack, box, ETHER / 10n);
  wallet.confirm();
  const revoke = tradeBox(page).getByRole('button', { name: /^Revoke [\d.,]+ tETH$/ });
  await expect(revoke).toBeEnabled({ timeout: 60_000 });
  const spent = spentBefore - await balanceOf(stack, box.p, stack.accounts.tester);
  expect(spent).toBeGreaterThan(0n);
  expect(spent).toBeLessThan(ETHER / 10n);
  const left = await allowanceOf(stack, box.p, stack.accounts.tester, helper);
  expect(left).toBe(ETHER / 10n - spent);
  // The quote expected all of it; the row says it filled in part, with what the chain took (the receipt's own event).
  await expect(buyRow(page)).toHaveText(/^Buy filled in part: [\d.,]+ of 0\.1 tETH/);
  await expect(buyRow(page)).toHaveAttribute('data-fill', 'part');
  await expect(buyRow(page)).toHaveAttribute('data-spent', spent.toString());
  await expect(buyRow(page)).toHaveAttribute('data-offered', (ETHER / 10n).toString());
  // The label is short (four significant digits); the approval it clears is the chain's own, read above. The spent
  // plan's estimate and warning are gone: only the revocation is on offer.
  expect(left).toBeGreaterThan(0n);
  await expect(tradeBox(page)).not.toContainText('Can fill in part');
  await expect.poll(() => ticksOf(tradeBox(page))).toEqual([['approve', 'done'], ['trade', 'done']]);
  // The page reads the box again after a mined trade (a moment of "Waits for a current verified read."): the shot once
  // the revocation can be pressed again.
  await expect(revoke).toBeEnabled({ timeout: 60_000 });
  await expect(tradeBox(page)).not.toContainText('Waits for a current verified read.');
  await pressShot(page, testInfo, 'box-done', tradeBox(page));
  await shot(page, testInfo, 'revoke');
  await revoke.click();
  await expect.poll(() => wallet.asked.length, { timeout: 60_000 }).toBe(3);
  wallet.confirm();
  await expect(receipts(page)).toContainText('Approval cleared confirmed');
  expect(await allowanceOf(stack, box.p, stack.accounts.tester, helper)).toBe(0n);
  await shot(page, testInfo, 'revoked');
  // The sale, one press: the box token, approved exactly to PoolSwapTest, then sold whole.
  await tradeBox(page).getByRole('radio', { name: 'Sell' }).check();
  const held = await balanceOf(stack, box.token, stack.accounts.tester);
  await amountField(page, 'ATETH').fill('1000');
  await expect(tradeBox(page).getByRole('button', { name: 'Sell', exact: true })).toBeEnabled({ timeout: 60_000 });
  await shot(page, testInfo, 'sell-ready');
  await press(page, 'Sell');
  await expect.poll(() => wallet.asked.length, { timeout: 60_000 }).toBe(4);
  wallet.confirm();
  await expect.poll(() => wallet.asked.length, { timeout: 60_000 }).toBe(5);
  expect(await allowanceOf(stack, box.token, stack.accounts.tester, helper)).toBe(1000n * ETHER);
  wallet.confirm();
  await expect(receipts(page)).toContainText('Sale confirmed');
  expect(held - await balanceOf(stack, box.token, stack.accounts.tester)).toBe(1000n * ETHER);
  expect(await allowanceOf(stack, box.token, stack.accounts.tester, helper)).toBe(0n);
  await shot(page, testInfo, 'sold');
  expect(wallet.sent.map((tx) => tx.to.toLowerCase())).toEqual([box.p, helper, box.p, box.token, helper].map((a) => a.toLowerCase()));
});

test('on the curve with ETH: a buy the quote expects whole fills in part after another buyer; its row says so, and the rest of the ETH came back in the same transaction', async ({ page }, testInfo) => {
  const stack = stackOf();
  const wallet = await testWallet(page, stack);
  const box = await newBox(stack, 'eth');
  await warp(stack, box.openAt + 400n);
  expect(await phaseOf(stack, box)).toBe(3);
  await page.goto(boxPath(box.token));
  await connect(page);
  await amountField(page, 'ETH').fill('0.01');
  await expect(tradeBox(page).getByRole('button', { name: 'Buy', exact: true })).toBeEnabled({ timeout: 60_000 });
  await expect(tradeBox(page).locator('.sh-trade-box__out')).toHaveText(/^≈ /);
  // The quote expects all of it to go in: no part-fill figure before the press.
  await expect(tradeBox(page)).not.toContainText('Fills ≈');
  const before = await balanceOf(stack, null, stack.accounts.tester);
  // Another tester buys as much first: this buy stops at its price limit, in part.
  await competingPoolBuy(stack, box, ETHER / 100n);
  await press(page, 'Buy');
  await expect(buyRow(page)).toHaveText(/^Buy filled in part: [\d.,]+ of 0\.01 ETH/, { timeout: 60_000 });
  await shot(page, testInfo, 'eth-part-fill');
  // What left the wallet, gas aside, is the row's figure: PoolSwapTest paid the rest back in the same transaction.
  const sent = wallet.sent.at(-1);
  expect(BigInt(sent.value)).toBe(ETHER / 100n);
  const receipt = await chain(stack).getTransactionReceipt({ hash: sent.hash });
  const spent = before - await balanceOf(stack, null, stack.accounts.tester) - receipt.gasUsed * receipt.effectiveGasPrice;
  expect(spent).toBeGreaterThan(0n);
  expect(spent).toBeLessThan(ETHER / 100n);
  await expect(buyRow(page)).toHaveAttribute('data-fill', 'part');
  await expect(buyRow(page)).toHaveAttribute('data-spent', spent.toString());
  await expect(buyRow(page)).toHaveAttribute('data-offered', (ETHER / 100n).toString());
  // Native ETH has no approval: nothing to revoke, and the box is ready for the next amount.
  await expect(tradeBox(page).getByRole('button', { name: /^Revoke/ })).toHaveCount(0);
  await expect(amountField(page, 'ETH')).toHaveValue('');
});

test('a stale read: the box waits, with no quote and no wallet request; current again, the quote comes back', async ({ page }, testInfo) => {
  const stack = stackOf();
  const wallet = await testWallet(page, stack);
  const box = await newBox(stack, 'eth');
  await warp(stack, box.openAt + 400n);
  await page.goto(boxPath(box.token));
  await connect(page);
  // The indexer's answer for this box, marked stale as the gateway marks it when it has not heard from the chain.
  await page.route(`${stack.origin}/v2/feed**`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.cards = body.cards.map((card) => (card.token.toLowerCase() === box.token.toLowerCase() ? { ...card, stale: true } : card));
    await route.fulfill({ response, json: body });
  });
  await expect(tradeBox(page)).toContainText('Waits for a current verified read.', { timeout: 30_000 });
  const methods = rpcMethods(page, stack);
  const asked = wallet.requests.length;
  await amountField(page, 'ETH').fill('0.001');
  await page.waitForTimeout(3_000);
  await expect(tradeBox(page).getByRole('button', { name: 'Buy', exact: true })).toBeDisabled();
  await expect(tradeBox(page).locator('.sh-trade-box__out')).toHaveText('\u2014');
  expect(methods.filter((method) => method === 'eth_estimateGas'), 'no plan is prepared while stale').toEqual([]);
  expect(wallet.requests.length, 'no wallet request while stale').toBe(asked);
  await shot(page, testInfo, 'stale');
  await shot(page, testInfo, 'stale-page', { whole: true });
  const quoting = rpcMethods(page, stack);
  await page.unroute(`${stack.origin}/v2/feed**`);
  await expect(tradeBox(page).locator('.sh-trade-box__out')).toHaveText(/^≈ /, { timeout: 30_000 });
  await expect(tradeBox(page).getByRole('button', { name: 'Buy', exact: true })).toBeEnabled();
  // What one pool quote costs the site's RPC (with whatever else the page read meanwhile), for the public endpoint's budget.
  const counts = Object.entries(quoting.reduce((all, method) => ({ ...all, [method]: (all[method] ?? 0) + 1 }), {})).map(([method, n]) => `${method} ${n}`).join(', ');
  testInfo.annotations.push({ type: 'rpc per quote', description: `${quoting.length} requests: ${counts}` });
  console.warn(`[${testInfo.project.name}] rpc per quote: ${quoting.length} requests: ${counts}`);
});

test('a buy past the curve’s end fills in part and closes the curve: one line until graduation, then pool sales', async ({ page }, testInfo) => {
  const stack = stackOf();
  await testWallet(page, stack);
  const box = await newBox(stack, 'teth');
  await warp(stack, box.openAt + 400n);
  const helper = stack.localDeployment.poolSwapTest;
  await page.goto(boxPath(box.token));
  await connect(page);
  await amountField(page, 'tETH').fill('3');
  // Before the press: the buy fills the raise (the curve's end), said as a quote with no deadline (SH-194, 8465d8f82 and
  // af2/af3), with its approval still to come.
  await expect(tradeBox(page).getByRole('button', { name: 'Buy', exact: true })).toBeEnabled({ timeout: 60_000 });
  await expect(tradeBox(page).locator('p.sh-trade-box__note')).toHaveText(/^Quote: about [\d.,]+ tETH fills the raise; the box can graduate\.$/);
  await expect(tradeBox(page).locator('p.sh-trade-box__warning')).toHaveText('No deadline.');
  await shot(page, testInfo, 'fills-in-part');
  await press(page, 'Buy');
  const revoke = tradeBox(page).getByRole('button', { name: /^Revoke [\d.,]+ tETH$/ });
  await expect(revoke).toBeEnabled({ timeout: 60_000 });
  // Its row: in part, what the chain took being the 3 tETH less what is left approved.
  const left = await allowanceOf(stack, box.p, stack.accounts.tester, helper);
  expect(left).toBeGreaterThan(0n);
  await expect(buyRow(page)).toHaveText(/^Buy filled in part: [\d.,]+ of 3 tETH/);
  await expect(buyRow(page)).toHaveAttribute('data-spent', (3n * ETHER - left).toString());
  await revoke.click();
  await expect(receipts(page)).toContainText('Approval cleared confirmed');
  expect(await allowanceOf(stack, box.p, stack.accounts.tester, helper)).toBe(0n);
  expect(await phaseOf(stack, box)).toBe(4);
  // One line now, with this session's receipts under it; no field and no button.
  await expect(tradeBox(page).locator('p.sh-trade-box__line')).toHaveText('Full. Trading resumes after graduation.', { timeout: 30_000 });
  await expect(tradeBox(page).getByRole('textbox')).toHaveCount(0);
  await expect(tradeBox(page).getByRole('button')).toHaveCount(0);
  await expect(buyRow(page)).toHaveText(/^Buy filled in part: /);
  await shot(page, testInfo, 'closed');
  await graduate(stack, box);
  expect(await phaseOf(stack, box)).toBe(5);
  await expect(tradeBox(page).getByRole('radio', { name: 'Sell' })).toBeVisible({ timeout: 30_000 });
  await tradeBox(page).getByRole('radio', { name: 'Sell' }).check();
  await amountField(page, 'ATETH').fill('1000');
  await press(page, 'Sell');
  await expect(receipts(page)).toContainText('Sale confirmed');
  await shot(page, testInfo, 'graduated-sale');
  expect(await allowanceOf(stack, box.token, stack.accounts.tester, helper)).toBe(0n);
});
