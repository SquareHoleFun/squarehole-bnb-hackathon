import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, decodeFunctionData, encodeFunctionData, http, type Abi, type Address, type Hex } from 'viem';
import { injectTestWallet } from './test-wallet';

// Presses while a write is pending, on the token-quote fork (scripts/flap-usdt-fork.sh). A press is a list of steps in
// a native modal dialog; every wallet request checks the counters and the chain state its step needs.
const here = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.PILE_RPC ?? 'http://127.0.0.1:8581';
const local = JSON.parse(fs.readFileSync(path.join(here, '../public/local/addresses.json'), 'utf8')) as { flap: { tokenQuote: { quote: Address } } };
const USD = local.flap.tokenQuote.quote;
const launcherAbi = JSON.parse(fs.readFileSync(path.join(here, '../../flap/abi/TokenCurveLauncher.json'), 'utf8')) as Abi;
const erc20 = [
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [] },
] as const;
const chain = createPublicClient({ transport: http(RPC) });
const Q = '?addresses=local/addresses.json';
type W = { __wallet: { requests: string[]; onNext(m: string, f: () => Promise<void> | void): void } };

// Independent tests: one failing does not skip the others.
test.describe.configure({ mode: 'default' });

let me: Address;
let other: Address;
let shared: Address;

/** A transaction from a development account of the fork (it signs for them), waited for. */
async function send(from: Address, to: Address, data: Hex) {
  const hash = (await chain.request({ method: 'eth_sendTransaction' as never, params: [{ from, to, data }] as never })) as Hex;
  expect((await chain.waitForTransactionReceipt({ hash })).status).toBe('success');
}
const mintTo = (who: Address, whole: bigint) => send(who, USD, encodeFunctionData({ abi: erc20, functionName: 'mint', args: [who, whole * 10n ** 18n] }));
const allowance = (owner: Address, spender: Address) => chain.readContract({ address: USD, abi: erc20, functionName: 'allowance', args: [owner, spender] });
const costToComplete = (launcher: Address) => chain.readContract({ address: launcher, abi: launcherAbi, functionName: 'costToComplete' }) as Promise<bigint>;

/** Another account completes the sale (the sale launches). */
async function otherLaunches(launcher: Address) {
  const cost = await costToComplete(launcher);
  await mintTo(other, cost / 10n ** 18n + 10n);
  await send(other, USD, encodeFunctionData({ abi: erc20, functionName: 'approve', args: [launcher, cost] }));
  await send(other, launcher, encodeFunctionData({ abi: launcherAbi, functionName: 'complete', args: [cost] }));
}
/** Another account buys on the curve: the rest costs less. Returns the new completion cost. */
async function otherBuys(launcher: Address) {
  await mintTo(other, 300n);
  const spend = 200n * 10n ** 18n;
  await send(other, USD, encodeFunctionData({ abi: erc20, functionName: 'approve', args: [launcher, spend] }));
  await send(other, launcher, encodeFunctionData({ abi: launcherAbi, functionName: 'buy', args: [spend, 1n] }));
  return costToComplete(launcher);
}

async function createSale(browser: Browser, info: TestInfo): Promise<Address> {
  const page = await browser.newPage({ baseURL: info.project.use.baseURL });
  await page.addLocatorHandler(page.getByTestId('press-close'), (close) => close.click());
  await injectTestWallet(page, RPC, 2);
  await page.goto(`/${Q}#/flap/create`);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('create-review')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('create').click();
  await expect(page).toHaveURL(/#\/flap\/0x[0-9a-fA-F]{40}$/, { timeout: 120_000 });
  const launcher = page.url().split('/').pop() as Address;
  await page.close();
  return launcher;
}

async function openSale(page: Page, launcher: Address) {
  await injectTestWallet(page, RPC, 2);
  await page.goto(`/${Q}#/flap/${launcher}`);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('flap-sale')).toHaveAttribute('data-trusted', 'yes', { timeout: 30_000 });
}
const requests = (page: Page) => page.evaluate(() => (window as unknown as W).__wallet.requests.slice(0));
const holdNext = (page: Page, method: string, ms: number) =>
  page.evaluate(([m, t]) => (window as unknown as W).__wallet.onNext(m as string, () => new Promise((r) => setTimeout(r, t as number))), [method, ms] as const);

test.beforeAll(async ({ browser }, info) => {
  const accounts = (await chain.request({ method: 'eth_accounts' as never })) as Address[];
  me = accounts[2]!;
  other = accounts[4]!;
  await mintTo(me, 20_000n);
  shared = await createSale(browser, info);
});

test('Tab cannot reach a control behind the dialog; the page behind it cannot take focus', async ({ page }) => {
  await openSale(page, shared);
  await page.getByTestId('buy-amount').fill('50');
  await expect(page.getByTestId('buy-review')).toBeVisible({ timeout: 30_000 });
  await holdNext(page, 'eth_sendTransaction', 5_000);
  await page.getByTestId('buy').click();
  await expect(page.getByTestId('press')).toBeVisible();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    const where = await page.evaluate(() => {
      const a = document.activeElement;
      return !a || a === document.body ? 'body' : a.closest('dialog') ? 'dialog' : (a.getAttribute('data-testid') ?? a.tagName);
    });
    expect(['dialog', 'body']).toContain(where);
  }
  // The page behind is inert: a control there cannot even be focused, so Enter cannot press it.
  const focused = await page.evaluate(() => {
    const b = document.querySelector<HTMLElement>('[data-testid="launch"]');
    b?.focus();
    return document.activeElement === b;
  });
  expect(focused).toBe(false);
  await expect(page.getByTestId('press-final')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('press-close').click();
});

test('no Cancel once step 1 went to the wallet, also between the steps', async ({ page }) => {
  await openSale(page, shared);
  await page.getByTestId('buy-amount').fill('60');
  await expect(page.getByTestId('buy-review')).toBeVisible({ timeout: 30_000 });
  // Step 1 (the approval) waits in the wallet; then step 2's own account check waits too.
  await page.evaluate(() => {
    const w = (window as unknown as W).__wallet;
    w.onNext('eth_sendTransaction', async () => {
      await new Promise((r) => setTimeout(r, 3_000));
      w.onNext('eth_accounts', () => new Promise((r) => setTimeout(r, 3_000)));
    });
  });
  await page.getByTestId('buy').click();
  await expect(page.getByTestId('press-title')).toContainText('1 Approve');
  await expect(page.getByTestId('press-step').first()).toHaveAttribute('data-state', 'wallet');
  await expect(page.getByTestId('press-cancel')).toHaveCount(0);
  await expect(page.getByTestId('press-step').first()).toHaveAttribute('data-state', 'confirmed', { timeout: 30_000 });
  await expect(page.getByTestId('press-cancel')).toHaveCount(0);
  await expect(page.getByTestId('press-final')).toHaveText('Step 1 confirmed. Step 2 confirmed.', { timeout: 60_000 });
  await page.getByTestId('press-close').click();
  await expect(page.getByTestId('press')).toBeHidden();
});

test('a sale that launches between the approval and the buy: step 2 is not sent, the allowance shows with Remove approval', async ({ page, browser }, info) => {
  const sale = await createSale(browser, info);
  await page.exposeFunction('raceLaunch', () => otherLaunches(sale));
  await openSale(page, sale);
  await page.getByTestId('buy-amount').fill('300');
  await expect(page.getByTestId('buy-review')).toBeVisible({ timeout: 30_000 });
  // After the approval is sent, at step 2's own account check: another account completes the sale.
  await page.evaluate(() => {
    const w = (window as unknown as W).__wallet;
    w.onNext('eth_sendTransaction', () => w.onNext('eth_accounts', () => (window as unknown as { raceLaunch(): Promise<void> }).raceLaunch()));
  });
  const before = (await requests(page)).length;
  await page.getByTestId('buy').click();
  await expect(page.getByTestId('press-final')).toHaveText('Step 1 confirmed. Step 2 was not sent: the sale has launched.', { timeout: 90_000 });
  expect((await requests(page)).slice(before).filter((m) => m === 'eth_sendTransaction')).toHaveLength(1);
  expect((await allowance(me, sale)) > 0n).toBe(true);
  await page.getByTestId('press-close').click();
  await expect(page.getByTestId('sale-phase')).toHaveText('Launched', { timeout: 30_000 });
  const line = page.locator(`[data-testid="allowance"][data-spender="${sale}"]`);
  await expect(line).toContainText('Allowed to this sale', { timeout: 30_000 });
  await line.getByTestId('remove-approval').click();
  await expect(page.getByTestId('press-final')).toHaveText('Remove approval for this sale confirmed.', { timeout: 60_000 });
  expect(await allowance(me, sale)).toBe(0n);
  await page.getByTestId('press-close').click();
});

test('Launch whose cost fell after the approval sends the lower cost, never above the approval', async ({ page, browser }, info) => {
  const sale = await createSale(browser, info);
  let lower = 0n;
  await page.exposeFunction('raceBuy', async () => {
    lower = await otherBuys(sale);
  });
  await openSale(page, sale);
  const approved = await costToComplete(sale);
  // The approval goes to the wallet; just before, another account buys: the cost read after the approval is lower.
  await page.evaluate(() => (window as unknown as W).__wallet.onNext('eth_sendTransaction', () => (window as unknown as { raceBuy(): Promise<void> }).raceBuy()));
  const fromBlock = await chain.getBlockNumber({ cacheTime: 0 });
  await page.getByTestId('launch').click();
  await expect(page.getByTestId('press-final')).toHaveText('Step 1 confirmed. Step 2 confirmed.', { timeout: 90_000 });
  expect(lower > 0n && lower < approved).toBe(true);
  // The complete() this account sent carries the lower cost.
  const to = await chain.getBlockNumber({ cacheTime: 0 });
  let sent: bigint | undefined;
  for (let n = fromBlock + 1n; n <= to; n++) {
    for (const t of (await chain.getBlock({ blockNumber: n, includeTransactions: true })).transactions) {
      if (t.from.toLowerCase() !== me.toLowerCase() || t.to?.toLowerCase() !== sale.toLowerCase()) continue;
      const d = decodeFunctionData({ abi: launcherAbi, data: t.input });
      if (d.functionName === 'complete') sent = (d.args as readonly bigint[])[0];
    }
  }
  expect(sent).toBe(lower);
  await page.getByTestId('press-close').click();
  await expect(page.getByTestId('sale-phase')).toHaveText('Launched', { timeout: 30_000 });
  // What the launch did not use stays visible, with its removal.
  expect(await allowance(me, sale)).toBe(approved - lower);
  await expect(page.locator(`[data-testid="allowance"][data-spender="${sale}"]`)).toContainText('Remove approval', { timeout: 30_000 });
});

/** Counts the page's receipt reads of `hash` at the local chain (the page reads through fetch, in batches). */
async function countReceiptReads(page: Page) {
  const seen = { n: 0, hash: '' };
  await page.route((url) => url.origin === new URL(RPC).origin, async (route) => {
    const body = route.request().postData() ?? '';
    if (seen.hash && body.includes('eth_getTransactionReceipt') && body.toLowerCase().includes(seen.hash.toLowerCase())) seen.n += 1;
    await route.continue();
  });
  return seen;
}

test('a receipt that does not come: "Still not confirmed", an enabled second action cannot be pressed, Check again reads it', async ({ page }) => {
  // 2 s instead of 180 s, and background receipt polling slowed to 10 minutes: only the click reads it again.
  await page.addInitScript(() => {
    (window as unknown as { __slowAfterMs: number }).__slowAfterMs = 2_000;
    (window as unknown as { __receiptPollMs: number }).__receiptPollMs = 600_000;
  });
  const reads = await countReceiptReads(page);
  await openSale(page, shared);
  await page.getByTestId('buy-amount').fill('5');
  await expect(page.getByTestId('buy')).toBeEnabled({ timeout: 30_000 });
  await chain.request({ method: 'evm_setAutomine' as never, params: [false] as never });
  try {
    await page.getByTestId('mint').click();
    await expect(page.getByTestId('press-slow')).toContainText('Still not confirmed', { timeout: 30_000 });
    await expect(page.getByTestId('press-check')).toBeVisible();
    await expect(page.getByTestId('press-leave')).toBeVisible();
    await expect(page.getByTestId('press-close')).toHaveCount(0);
    const second = await page
      .getByTestId('buy')
      .click({ timeout: 2_000 })
      .then(
        () => true,
        () => false,
      );
    expect(second).toBe(false);
    reads.hash = (await page.getByTestId('press-step').first().locator('a').getAttribute('href'))!.split('/tx/')[1]!;
  } finally {
    await chain.request({ method: 'evm_setAutomine' as never, params: [true] as never });
    await chain.request({ method: 'evm_mine' as never, params: [] as never });
  }
  await page.waitForTimeout(2_000);
  const before = reads.n;
  await expect(page.getByTestId('press-final')).toHaveCount(0); // nothing read it in the background
  await page.getByTestId('press-check').click();
  await expect(page.getByTestId('press-final')).toHaveText('Get confirmed.', { timeout: 10_000 });
  expect(reads.n).toBeGreaterThan(before);
  await page.getByTestId('press-close').click();
});

test('Leave it pending closes the dialog; the box keeps the step and its hash', async ({ page }) => {
  await page.addInitScript(() => ((window as unknown as { __slowAfterMs: number }).__slowAfterMs = 2_000));
  await openSale(page, shared);
  await chain.request({ method: 'evm_setAutomine' as never, params: [false] as never });
  try {
    await page.getByTestId('mint').click();
    await expect(page.getByTestId('press-leave')).toBeVisible({ timeout: 30_000 });
    const href = await page.getByTestId('press-step').first().locator('a').getAttribute('href');
    await page.getByTestId('press-leave').click();
    await expect(page.getByTestId('press')).toBeHidden();
    const status = page.getByTestId('mint-box').getByTestId('tx-status');
    await expect(status).toContainText('Step 1 is still pending: check it on the explorer before pressing again.');
    expect(await status.locator('a').first().getAttribute('href')).toBe(href);
  } finally {
    await chain.request({ method: 'evm_setAutomine' as never, params: [true] as never });
    await chain.request({ method: 'evm_mine' as never, params: [] as never });
  }
});

test('Stop waiting at step 2 after step 1 confirmed: the outcome is unknown, step 1 and its hash stay', async ({ page }) => {
  await openSale(page, shared);
  await page.getByTestId('buy-amount').fill('40');
  await expect(page.getByTestId('buy-review')).toBeVisible({ timeout: 30_000 });
  // The approval goes through; the buy's request then never gets an answer from the wallet.
  await page.evaluate(() => {
    const w = (window as unknown as W).__wallet;
    w.onNext('eth_sendTransaction', () => w.onNext('eth_sendTransaction', () => new Promise(() => undefined)));
  });
  await page.getByTestId('buy').click();
  await expect(page.getByTestId('press-step').nth(1)).toHaveAttribute('data-state', 'wallet', { timeout: 60_000 });
  await page.getByTestId('press-stop').click();
  await expect(page.getByTestId('press-final')).toHaveText(
    "Step 1 confirmed. Your wallet did not answer for step 2. It may still send it: check your wallet's activity before pressing again.",
  );
  await page.getByTestId('press-close').click();
  await expect(page.getByTestId('buy-box').getByTestId('tx-legs')).toContainText('confirmed');
  await expect(page.getByTestId('buy-box').getByTestId('tx-legs').locator('a')).toHaveCount(1);
});

test('the unknown outcome: the wallet was asked and returned no hash', async ({ page }) => {
  await openSale(page, shared);
  await page.evaluate(() =>
    (window as unknown as W).__wallet.onNext('eth_sendTransaction', () => {
      throw new Error('the wallet lost the answer');
    }),
  );
  await page.getByTestId('mint').click();
  await expect(page.getByTestId('press-final')).toHaveText(
    "Your wallet did not answer for step 1. It may still send it: check your wallet's activity before pressing again.",
    { timeout: 30_000 },
  );
  await page.getByTestId('press-close').click();
});

test('a late answer of a stopped press changes nothing of the newer press', async ({ page }) => {
  await openSale(page, shared);
  await holdNext(page, 'eth_sendTransaction', 5_000);
  await page.getByTestId('mint').click();
  await expect(page.getByTestId('press-stop')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('press-stop').click();
  await page.getByTestId('press-close').click();
  await page.getByTestId('mint').click();
  const status = page.getByTestId('mint-box').getByTestId('tx-status');
  await expect(status).toContainText('Get: done', { timeout: 30_000 });
  await page.getByTestId('press-close').click();
  const href = await status.locator('a').first().getAttribute('href');
  // The first press's wallet answers now (its transaction is sent): the page shows nothing of it.
  await page.waitForTimeout(6_000);
  await expect(page.getByTestId('press')).toBeHidden();
  expect(await status.locator('a').first().getAttribute('href')).toBe(href);
  await expect(status).toContainText('Get: done');
});

test('leaving the sale and coming back while a Buy is being prepared sends nothing', async ({ page }) => {
  await openSale(page, shared);
  await page.getByTestId('buy-amount').fill('20');
  await expect(page.getByTestId('buy-review')).toBeVisible({ timeout: 30_000 });
  await page.evaluate((back) => {
    (window as unknown as W).__wallet.onNext('eth_accounts', async () => {
      window.location.hash = '#/flap';
      await new Promise((r) => setTimeout(r, 700));
      window.location.hash = back;
      await new Promise((r) => setTimeout(r, 700));
    });
  }, `#/flap/${shared}`);
  const before = (await requests(page)).length;
  await page.getByTestId('buy').click();
  await expect(page.getByTestId('press-final')).toHaveText('Nothing was sent: the page changed.', { timeout: 30_000 });
  expect((await requests(page)).slice(before)).not.toContain('eth_sendTransaction');
  await page.getByTestId('press-close').click();
});

test('Cancel before the wallet is asked drops the press', async ({ page }) => {
  await openSale(page, shared);
  await page.getByTestId('buy-amount').fill('10');
  await expect(page.getByTestId('buy-review')).toBeVisible({ timeout: 30_000 });
  await holdNext(page, 'eth_accounts', 3_000);
  const before = (await requests(page)).length;
  await page.getByTestId('buy').click();
  await page.getByTestId('press-cancel').click();
  // Cancel ends like every other ending: its line, then Close.
  await expect(page.getByTestId('press-final')).toHaveText('Nothing was sent: cancelled.');
  await page.getByTestId('press-close').click();
  await expect(page.getByTestId('press')).toBeHidden();
  await expect(page.getByTestId('buy-box').getByTestId('tx-status')).toContainText('Nothing was sent: cancelled.', { timeout: 15_000 });
  await page.waitForTimeout(3_500); // the held account check returns: the cancelled press sends nothing
  expect((await requests(page)).slice(before)).not.toContain('eth_sendTransaction');
});

test('switching "Paid in" while a creation is pending is impossible; the sale created is the one on screen', async ({ page }) => {
  await page.addLocatorHandler(page.getByTestId('press-close'), (close) => close.click());
  await injectTestWallet(page, RPC, 2);
  await page.goto(`/${Q}#/flap/create`);
  await page.getByTestId('connect').click();
  await page.getByTestId('way-steps').click(); // where "Paid in" is in view
  await expect(page.getByTestId('quote-native')).toBeVisible();
  await expect(page.getByTestId('create-review')).toBeVisible({ timeout: 60_000 });
  await holdNext(page, 'eth_sendTransaction', 6_000);
  await page.getByTestId('create').click();
  const switched = await page
    .getByTestId('quote-native')
    .click({ timeout: 2_000 })
    .then(
      () => true,
      () => false,
    );
  expect(switched).toBe(false);
  await expect(page).toHaveURL(/#\/flap\/0x[0-9a-fA-F]{40}$/, { timeout: 120_000 });
  const created = page.url().split('/').pop() as Address;
  expect(((await chain.readContract({ address: created, abi: launcherAbi, functionName: 'quote' })) as string).toLowerCase()).toBe(USD.toLowerCase());
});
