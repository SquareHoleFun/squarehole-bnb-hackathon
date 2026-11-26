import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, toFunctionSelector, type Abi, type Address } from 'viem';
import { injectTestWallet } from './test-wallet';
import { formatAmount, toDecimalString } from '../src/lib/amounts';

// Needs the fork that scripts/flap-usdt-fork.sh brings up (the real chain, the token-quote factories deployed in it).
const here = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.PILE_RPC ?? 'http://127.0.0.1:8581';
const SHOTS = process.env.PILE_SHOTS ?? path.join(here, '../../../hackathon/evidence/SH-265');
const local = JSON.parse(fs.readFileSync(path.join(here, '../public/local/addresses.json'), 'utf8')) as {
  flap: { tokenQuote: { quote: Address; launcherFactory: Address } };
};
const USD = local.flap.tokenQuote.quote;
const launcherAbi = JSON.parse(fs.readFileSync(path.join(here, '../../flap/abi/TokenCurveLauncher.json'), 'utf8')) as Abi;
const pileAbi = JSON.parse(fs.readFileSync(path.join(here, '../../flap/abi/PileVault.json'), 'utf8')) as Abi;
const erc20 = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
] as const;
const chain = createPublicClient({ transport: http(RPC) });
const Q = '?addresses=local/addresses.json';
const read = <T,>(address: Address, abi: Abi, functionName: string, args: unknown[] = []) => chain.readContract({ address, abi, functionName, args }) as Promise<T>;
const usd = (who: Address) => chain.readContract({ address: USD, abi: erc20, functionName: 'balanceOf', args: [who] });
const allowance = (who: Address, spender: Address) => chain.readContract({ address: USD, abi: erc20, functionName: 'allowance', args: [who, spender] });
const label = (v: bigint) => `${toDecimalString(v, 18)} USDT (test)`;
let gasTotal = 0n;

test.describe.configure({ mode: 'serial' });

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const [w, h] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(SHOTS, `${name}-${w}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

/** Waits for "<label>: done" in the box's status; prints and sums the gas of every transaction of that press. */
async function done(page: Page, box: string, labelText: string, since: bigint) {
  const status = page.getByTestId(box).getByTestId('tx-status').filter({ hasText: `${labelText}: done` }).first();
  await expect(status).toBeVisible({ timeout: 90_000 });
  const href = await status.locator('a').first().getAttribute('href');
  const hash = href?.split('/tx/')[1] as `0x${string}`;
  const tx = await chain.getTransaction({ hash });
  // Every transaction of this account since the press (an approval comes before the write itself).
  const to = await chain.getBlockNumber({ cacheTime: 0 });
  for (let b = since + 1n; b <= to; b++) {
    const block = await chain.getBlock({ blockNumber: b, includeTransactions: true });
    for (const t of block.transactions) {
      if (t.from.toLowerCase() !== tx.from.toLowerCase()) continue;
      const r = await chain.getTransactionReceipt({ hash: t.hash });
      gasTotal += r.gasUsed;
      console.log(`GAS ${box} ${labelText} ${t.input.slice(0, 10)} ${r.gasUsed}`);
    }
  }
  return tx;
}

// Each press ends in its dialog with Close: it is pressed before the test's next action.
test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByTestId('press-close'), (close) => close.click());
});

test('the test token as the quote: mint, create, buy, sell back, complete, claim, trade, the tax into the pile, redeem', async ({ page }) => {
  const me = ((await chain.request({ method: 'eth_accounts' as never })) as Address[])[1]!;
  const bnb0 = await chain.getBalance({ address: me });
  await injectTestWallet(page, RPC, 1);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${Q}#/flap/create`);
  await page.getByTestId('connect').click();
  // The test token is the default quote.
  // The Visual way is the default: what the sale is paid in sits on the coin in the box's socket.
  await expect(page.getByTestId('way-visual')).toHaveAttribute('aria-current', 'true');
  await page.locator('[data-part="price"] .sh-pic-hit').first().click();
  await expect(page.getByTestId('quote-token')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('part-close').click();

  // Getting the test token: 2,000 a press, through its own public mint; the balance before and after.
  const usd0 = await usd(me);
  let b = await chain.getBlockNumber({ cacheTime: 0 });
  await page.getByTestId('mint').click();
  await done(page, 'mint-box', 'Get', b);
  await expect(page.getByTestId('mint-box').getByTestId('tx-note')).toHaveText(
    `Before: ${toDecimalString(usd0, 18)} USDT (test). After: ${toDecimalString(usd0 + 2000n * 10n ** 18n, 18)} USDT (test).`,
  );
  expect(await usd(me)).toBe(usd0 + 2000n * 10n ** 18n);
  b = await chain.getBlockNumber({ cacheTime: 0 });
  await page.getByTestId('mint').click();
  await done(page, 'mint-box', 'Get', b);
  expect(await usd(me)).toBe(usd0 + 4000n * 10n ** 18n);
  await expect(page.getByTestId('mint-balance').locator('.amount')).toHaveAttribute('title', label(usd0 + 4000n * 10n ** 18n), { timeout: 30_000 });

  // The floor in the quote's own terms: a 500 target is refused with the factory's numbers.
  await expect(page.getByTestId('create-raise')).toContainText('USDT (test)', { timeout: 30_000 });
  await page.locator('[data-part="raise"] .sh-pic-hit').first().click();
  await page.getByTestId('create-target').fill('500');
  await expect(page.getByTestId('create-floor')).toContainText('$');
  await expect(page.locator('[data-warn="raise"]')).toBeVisible();
  await page.getByTestId('create-target').fill('1700');
  await page.getByTestId('part-close').click();
  await expect(page.locator('[data-warn="raise"]')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId('create-review')).toBeVisible({ timeout: 60_000 });
  await shot(page, 'usdt-create');
  b = await chain.getBlockNumber({ cacheTime: 0 });
  await page.getByTestId('create').click();
  await expect(page).toHaveURL(/#\/flap\/0x[0-9a-fA-F]{40}$/, { timeout: 120_000 });
  const launcher = page.url().split('/').pop() as Address;
  {
    const to = await chain.getBlockNumber({ cacheTime: 0 });
    for (let n = b + 1n; n <= to; n++) {
      for (const t of (await chain.getBlock({ blockNumber: n, includeTransactions: true })).transactions) {
        if (t.from.toLowerCase() !== me.toLowerCase()) continue;
        const r = await chain.getTransactionReceipt({ hash: t.hash });
        gasTotal += r.gasUsed;
        console.log(`GAS create ${t.input.slice(0, 10)} ${r.gasUsed} value ${t.value}`);
      }
    }
  }
  expect((await read<Address>(launcher, launcherAbi, 'quote')).toLowerCase()).toBe(USD.toLowerCase());
  await expect(page.getByTestId('flap-sale')).toHaveAttribute('data-trusted', 'yes', { timeout: 30_000 });
  await expect(page.getByTestId('sale-phase')).toHaveText('Selling');

  // Buy 300: one press approves exactly cost plus fee to this launcher, then buys; the allowance is spent to zero.
  await page.getByTestId('buy-amount').fill('300');
  await expect(page.getByTestId('buy-review')).toContainText('USDT (test)', { timeout: 30_000 });
  const u1 = await usd(me);
  b = await chain.getBlockNumber({ cacheTime: 0 });
  await page.getByTestId('buy').click();
  await done(page, 'buy-box', 'Buy', b);
  expect(await allowance(me, launcher)).toBe(0n);
  const p1 = await read<{ curveBalance: bigint; feePot: bigint }>(launcher, launcherAbi, 'progress');
  expect(u1 - (await usd(me))).toBe(p1.curveBalance + p1.feePot);

  // Sell back 1,000,000 tokens.
  await page.getByTestId('sell-amount').fill('1000000');
  await expect(page.getByTestId('sell-review')).toBeVisible({ timeout: 30_000 });
  b = await chain.getBlockNumber({ cacheTime: 0 });
  await page.getByTestId('sell').click();
  await done(page, 'sell-box', 'Sell', b);
  await shot(page, 'usdt-sale-selling');

  // Launch: complete(maxCost) with the cost read at the press, approved exactly; done only on Launched.
  b = await chain.getBlockNumber({ cacheTime: 0 });
  await page.getByTestId('launch').click();
  const launchTx = await done(page, 'launch-status', 'Launch', b);
  expect(launchTx.input.slice(0, 10)).toBe(toFunctionSelector('complete(uint256)'));
  expect(await allowance(me, launcher)).toBe(0n);
  await expect(page.getByTestId('sale-phase')).toHaveText('Launched', { timeout: 30_000 });

  b = await chain.getBlockNumber({ cacheTime: 0 });
  await page.getByTestId('claim').click();
  await done(page, 'claim-box', 'Claim', b);
  const [token, , pileVault] = await read<readonly [Address, Address, Address]>(launcher, launcherAbi, 'launchInfo');

  // Pool trades token against the test token, until tax waits; then send it to the pile.
  const tokenAbi = erc20 as unknown as Abi;
  for (let round = 0; round < 6; round++) {
    await page.getByTestId('trade-buy-tab').click();
    await page.getByTestId('trade-amount').fill('100');
    await expect(page.getByTestId('trade-review')).toBeVisible({ timeout: 30_000 });
    for (const step of ['Approve', 'Buy']) {
      if (step === 'Approve' && !((await page.getByTestId('trade').textContent()) ?? '').startsWith('Approve')) continue;
      b = await chain.getBlockNumber({ cacheTime: 0 });
      await page.getByTestId('trade').click();
      await done(page, 'pool-trade', step, b);
      if (step === 'Approve') await expect(page.getByTestId('trade')).toHaveText('Buy', { timeout: 30_000 });
    }
    const held = await chain.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [me] }) as bigint;
    await page.getByTestId('trade-sell-tab').click();
    await page.getByTestId('trade-amount').fill(toDecimalString(held / 3n, 18));
    await expect(page.getByTestId('trade-review')).toBeVisible({ timeout: 30_000 });
    for (const step of ['Approve', 'Sell']) {
      if (step === 'Approve' && !((await page.getByTestId('trade').textContent()) ?? '').startsWith('Approve')) continue;
      b = await chain.getBlockNumber({ cacheTime: 0 });
      await page.getByTestId('trade').click();
      await done(page, 'pool-trade', step, b);
      if (step === 'Approve') await expect(page.getByTestId('trade')).toHaveText('Sell', { timeout: 30_000 });
    }
    if (await page.getByTestId('dispatch').isEnabled({ timeout: 10_000 }).catch(() => false)) break;
  }
  const pileBefore = await read<bigint>(pileVault, pileAbi, 'pile');
  b = await chain.getBlockNumber({ cacheTime: 0 });
  await page.getByTestId('dispatch').click();
  await done(page, 'dispatch-box', 'Send to the pile', b);
  const pileAfter = await read<bigint>(pileVault, pileAbi, 'pile');
  expect(pileAfter > pileBefore).toBe(true);
  await expect(page.getByTestId('pile-size').locator('.amount').first()).toHaveAttribute('title', label(pileAfter), { timeout: 30_000 });

  // Redeem 1,000,000 tokens: paid in the test token, exactly the quote.
  const quote = await read<bigint>(pileVault, pileAbi, 'quoteRedeem', [10n ** 24n]);
  await page.getByTestId('redeem-amount').fill('1000000');
  await expect(page.getByTestId('redeem-review').locator('.amount').first()).toHaveAttribute('title', label(quote));
  const u2 = await usd(me);
  b = await chain.getBlockNumber({ cacheTime: 0 });
  await page.getByTestId('redeem').click();
  await done(page, 'redeem-box', 'Redeem', b);
  expect((await usd(me)) - u2).toBe(quote);
  await shot(page, 'usdt-sale-launched');
  const bnbSpent = bnb0 - (await chain.getBalance({ address: me }));
  console.log(`TOTAL gas ${gasTotal}; BNB spent on the fork ${toDecimalString(bnbSpent, 18)} (salt lock + gas at the fork's price); at 0.1 gwei the gas is ${toDecimalString(gasTotal * 100_000_000n, 18)} BNB`);
});
