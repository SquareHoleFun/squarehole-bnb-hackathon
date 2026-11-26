import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectTestWallet } from './test-wallet';

const here = path.dirname(fileURLToPath(import.meta.url));
// Needs a local chain seeded by scripts/seed-local.mjs (it writes public/local/addresses.json and seed.json).
const RPC = process.env.PILE_RPC ?? 'http://127.0.0.1:8581';
const SHOTS = process.env.PILE_SHOTS ?? path.join(here, '../../../hackathon/evidence/SH-265');
const seed = JSON.parse(fs.readFileSync(path.join(here, '../public/local/seed.json'), 'utf8')) as {
  token: string;
  pile: string;
  unlisted: string;
  emptyPile: string;
};
const pile = seed.pile;
const Q = '?addresses=local/addresses.json';
test.describe.configure({ mode: 'serial' });

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}
const call = async (method: string, params: unknown[]) => {
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = (await res.json()) as { result: unknown; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result;
};
const word = (n: bigint) => n.toString(16).padStart(64, '0');
const addr = (a: string) => a.slice(2).toLowerCase().padStart(64, '0');
const mint = async (from: string, to: string, tokens: bigint) =>
  call('eth_sendTransaction', [{ from, to: seed.token, data: '0x40c10f19' + addr(to) + word(tokens * 10n ** 18n) }]); // mint(to, v)
const done = (page: Page, box: string, label: string) =>
  expect(page.getByTestId(box).getByTestId('tx-status')).toContainText(`${label}: done`, { timeout: 30_000 });

// Each press ends in its dialog with Close: it is pressed before the test's next action.
test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByTestId('press-close'), (close) => close.click());
});

for (const size of [
  { name: '1440', width: 1440, height: 900 },
  { name: '390', width: 390, height: 844 },
] as const) {
  test(`pile panel and home, ${size.name}`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    page.on('console', (m) => console.log('PAGE', m.type(), m.text()));
    page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
    await page.goto(`/${Q}#/`);
    await expect(page.getByTestId('piles')).toBeVisible({ timeout: 20_000 });
    await shot(page, `home-${size.name}-dark`);
    await page.goto(`/${Q}#/pile/${pile}`);
    // Seeded: 0.05 + 0.0123 in, then 10,000 of 1,250,000 handed in for 0.0004984 out.
    await expect(page.getByTestId('pile-size')).toContainText('0.0618');
    await expect(page.getByTestId('circulating')).toContainText('1,240,000');
    await expect(page.getByTestId('pile-activity').locator('li')).toHaveCount(3);
    await shot(page, `pile-${size.name}-dark`);
  });
}

test('finding 11: no wallet request on load or navigation; the first one is at Connect', async ({ page }) => {
  await injectTestWallet(page, RPC, 0);
  await page.goto(`/${Q}#/`);
  await expect(page.getByTestId('piles')).toBeVisible();
  await page.goto(`/${Q}#/pile/${pile}`);
  await expect(page.getByTestId('pile-size')).toBeVisible();
  await page.evaluate(() => (window.location.hash = '#/'));
  await expect(page.getByTestId('piles')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __wallet: { requests: string[] } }).__wallet.requests)).toEqual([]);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('account')).toBeVisible();
  expect((await page.evaluate(() => (window as unknown as { __wallet: { requests: string[] } }).__wallet.requests))[0]).toBe('eth_requestAccounts');
});

test('findings 2 and 4: a pile the deployment does not name is read only; an empty pile offers no redemption', async ({ page }) => {
  await injectTestWallet(page, RPC, 0);
  await page.goto(`/${Q}#/pile/${seed.unlisted}`);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('pile-panel')).toHaveAttribute('data-writable', 'no');
  await expect(page.getByTestId('read-only')).toBeVisible();
  await expect(page.getByTestId('redeem-box')).toHaveCount(0);
  await expect(page.getByTestId('redeem')).toHaveCount(0);
  await page.goto(`/${Q}#/pile/${seed.emptyPile}`); // the same page: the wallet stays connected
  await expect(page.getByTestId('pile-panel')).toHaveAttribute('data-writable', 'yes');
  await page.getByTestId('redeem-amount').fill('1000');
  await expect(page.getByTestId('redeem-refusal')).toHaveText('The pile is empty.');
  await expect(page.getByTestId('redeem')).toBeDisabled();
});

test('finding 1 and 9: a deployment file that fails its check stops the page with the reason', async ({ page }) => {
  await page.goto('/?addresses=local/bad.json#/');
  await expect(page.getByTestId('blocked')).toContainText('chainId: must be 97');
  await expect(page.getByTestId('rail-flap')).toHaveCount(0);
});

test('redeem from the page: refusals, approve, redeem, numbers read back', async ({ page }) => {
  await injectTestWallet(page, RPC, 0);
  await page.goto(`/${Q}#/pile/${pile}`);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('account')).toBeVisible();
  const box = page.getByTestId('redeem-box');
  await box.getByTestId('redeem-amount').fill('1.0000000000000000001');
  await expect(box.getByTestId('redeem-refusal')).toHaveText('Too many decimals.');
  await box.getByTestId('redeem-amount').fill('99999999');
  await expect(box.getByTestId('redeem-refusal')).toHaveText('More than you hold.');
  await box.getByTestId('redeem-amount').fill('124,000');
  await expect(box.getByTestId('redeem-refusal')).toHaveText('That is not a number.');
  await box.getByTestId('redeem-amount').fill('124000');
  // 0.0618016 * 124000 / 1240000 = 0.00618016 exactly
  const review = box.getByTestId('redeem-review').locator('.amount');
  await expect(review.first()).toHaveAttribute('title', '0.00618016 BNB');
  // guard 0.5%: 0.00618016 * 9950 / 10000 = 0.0061492592
  await expect(review.nth(1)).toHaveAttribute('title', '0.0061492592 BNB');
  // From the press until the wallet answers, the amount and the guard cannot change (the press approves, then redeems).
  await page.evaluate(() =>
    (window as unknown as { __wallet: { onNext(m: string, f: () => Promise<void>): void } }).__wallet.onNext('eth_sendTransaction', () => new Promise((r) => setTimeout(r, 2000))),
  );
  await box.getByTestId('redeem').click();
  await expect(box.getByTestId('redeem-amount')).toBeDisabled();
  await expect(box.getByTestId('redeem-guard')).toBeDisabled();
  await done(page, 'redeem-box', 'Redeem');
  await expect(box.getByTestId('redeem-amount')).toBeEnabled();
  // Re-read finding 1: every transaction the page handed over names its sender and chain 97.
  const sent = await page.evaluate(() => (window as unknown as { __wallet: { sent: { from?: string; chainId?: string }[] } }).__wallet.sent);
  expect(sent.length).toBeGreaterThanOrEqual(2);
  for (const t of sent) expect(t).toMatchObject({ chainId: '0x61' });
  expect(new Set(sent.map((t) => t.from?.toLowerCase())).size).toBe(1);
  await expect(page.getByTestId('pile-size').locator('.amount').first()).toHaveAttribute('title', '0.05562144 BNB');
  await expect(page.getByTestId('pile-delta')).toContainText('−0.00618');
  await expect(page.getByTestId('paid-out').locator('.amount')).toHaveAttribute('title', '0.00667856 BNB');
  await expect(page.getByTestId('pile-activity').locator('li')).toHaveCount(4);
});

test('when reads are refused, the last numbers stay on screen with their age', async ({ page }) => {
  await page.goto(`/${Q}#/pile/${pile}`);
  const size = page.getByTestId('pile-size').locator('.amount').first();
  await expect(size).toHaveAttribute('title', '0.05562144 BNB');
  // The endpoint starts refusing every read, as a rate limit does.
  await page.route((url) => url.port === new URL(RPC).port, (route) => route.fulfill({ status: 429, body: 'rate limited' }));
  await expect(page.getByTestId('stale')).toBeVisible({ timeout: 40_000 });
  await expect(page.getByTestId('stale')).toContainText('Numbers from');
  await expect(page.getByTestId('age')).toBeVisible();
  await expect(size).toHaveAttribute('title', '0.05562144 BNB');
  await shot(page, 'pile-stale-1440');
  await page.unroute((url) => url.port === new URL(RPC).port);
});

test('the last tokens in circulation are paid the whole pile: the quote "or more"', async ({ page }) => {
  // Holder 1 hands its tokens to holder 0, who then holds the whole circulating supply.
  const [a0, a1] = (await call('eth_accounts', [])) as string[];
  await call('eth_sendTransaction', [{ from: a1, to: seed.token, data: '0xa9059cbb' + addr(a0!) + word(240_000n * 10n ** 18n) }]);
  await injectTestWallet(page, RPC, 0);
  await page.goto(`/${Q}#/pile/${pile}`);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('circulating').locator('.amount')).toHaveAttribute('title', '1116000 PILE');
  const box = page.getByTestId('redeem-box');
  await box.getByTestId('redeem-amount').fill('1116000');
  await expect(box.getByTestId('redeem-review')).toContainText('or more');
  await box.getByTestId('redeem').click();
  await done(page, 'redeem-box', 'Redeem');
  await expect(page.getByTestId('pile-size').locator('.amount').first()).toHaveAttribute('title', '0 BNB', { timeout: 20_000 });
  await expect(page.getByTestId('paid-out').locator('.amount')).toHaveAttribute('title', '0.0623 BNB');
  await expect(page.getByTestId('circulating').locator('.amount')).toHaveAttribute('title', '0 PILE');
  await shot(page, 'pile-emptied-1440');
});

test('finding 4: the quote is read again at the press; a worse minimum is not sent', async ({ page }) => {
  const [a0, , a2] = (await call('eth_accounts', [])) as string[];
  await call('eth_sendTransaction', [{ from: a0, to: pile, value: '0x' + (10n ** 16n).toString(16) }]); // 0.01 BNB in
  await mint(a0!, a0!, 1000n);
  await injectTestWallet(page, RPC, 0);
  await page.goto(`/${Q}#/pile/${pile}`);
  await page.getByTestId('connect').click();
  const box = page.getByTestId('redeem-box');
  await box.getByTestId('redeem-amount').fill('100');
  await expect(box.getByTestId('redeem-review')).toBeVisible();
  // Someone else's tokens join the circulation between the preview and the press: each token is worth less now.
  await mint(a0!, a2!, 9000n);
  const before = await page.evaluate(() => (window as unknown as { __wallet: { requests: string[] } }).__wallet.requests.length);
  await box.getByTestId('redeem').click();
  await expect(box.getByTestId('tx-status')).toContainText('Nothing was sent: the quote moved. Check the new numbers and press again.');
  const after = await page.evaluate(() => (window as unknown as { __wallet: { requests: string[] } }).__wallet.requests.slice(0));
  expect(after.slice(before)).not.toContain('eth_sendTransaction');
  // The new numbers are read and shown; the second press sends.
  await page.waitForTimeout(1500);
  await box.getByTestId('redeem').click();
  await done(page, 'redeem-box', 'Redeem');
});

test('finding 3: a wallet change during the preparation cancels the send; a wrong chain gets no send button', async ({ page }) => {
  await injectTestWallet(page, RPC, 0);
  await page.goto(`/${Q}#/pile/${pile}`);
  await page.evaluate(() => (window as unknown as { __wallet: { setChain(c: number): void } }).__wallet.setChain(56));
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('redeem-box').getByRole('button', { name: 'Switch to BNB Chain Testnet' })).toBeVisible();
  await expect(page.getByTestId('redeem')).toHaveCount(0);
  await page.getByTestId('redeem-box').getByRole('button', { name: 'Switch to BNB Chain Testnet' }).click();
  const box = page.getByTestId('redeem-box');
  await box.getByTestId('redeem-amount').fill('10');
  // The wallet switches to another account at the moment the page checks it before sending.
  await page.evaluate(() =>
    (window as unknown as { __wallet: { onNext(m: string, f: () => Promise<void>): void; setAccount(i: number): Promise<void> } }).__wallet.onNext('eth_accounts', () =>
      (window as unknown as { __wallet: { setAccount(i: number): Promise<void> } }).__wallet.setAccount(1),
    ),
  );
  const before = await page.evaluate(() => (window as unknown as { __wallet: { requests: string[] } }).__wallet.requests.length);
  await box.getByTestId('redeem').click();
  await expect(box.getByTestId('tx-status')).toContainText('Nothing was sent: the wallet changed.');
  const after = await page.evaluate(() => (window as unknown as { __wallet: { requests: string[] } }).__wallet.requests.slice(0));
  expect(after.slice(before)).not.toContain('eth_sendTransaction');
});

test('re-read finding 1: a wallet change after the page’s own checks, as the wallet client asks for the chain, still stops the send', async ({ page }) => {
  await injectTestWallet(page, RPC, 0);
  await page.goto(`/${Q}#/pile/${pile}`);
  await page.getByTestId('connect').click();
  const box = page.getByTestId('redeem-box');
  await box.getByTestId('redeem-amount').fill('10');
  // At the press the page asks eth_accounts and eth_chainId itself; the wallet client then asks eth_chainId again. The
  // account changes during that second answer, after every check the page made before.
  await page.evaluate(() => {
    const w = (window as unknown as { __wallet: { onNext(m: string, f: () => Promise<void> | void): void; setAccount(i: number): Promise<void> } }).__wallet;
    // armed by the page's own eth_accounts check at the press: then its eth_chainId, then the wallet client's
    w.onNext('eth_accounts', () => w.onNext('eth_chainId', () => w.onNext('eth_chainId', () => w.setAccount(1))));
  });
  const before = await page.evaluate(() => (window as unknown as { __wallet: { requests: string[] } }).__wallet.requests.length);
  await box.getByTestId('redeem').click();
  await expect(box.getByTestId('tx-status')).toContainText('Nothing was sent: the wallet changed.');
  const after = await page.evaluate(() => (window as unknown as { __wallet: { requests: string[] } }).__wallet.requests.slice(0));
  expect(after.slice(before).filter((m) => m === 'eth_chainId').length).toBeGreaterThanOrEqual(2);
  expect(after.slice(before)).not.toContain('eth_sendTransaction');
});

test('a log read that every endpoint refuses shows an error line with Try again, never "Reading…" for good', async ({ page }) => {
  // Every eth_getLogs is refused as PublicNode refuses a range above 50,000 blocks (HTTP 403 with a JSON-RPC error).
  let refused = 0;
  const local = (url: URL) => url.origin === new URL(RPC).origin;
  await page.route(
    local,
    async (route) => {
      const body = route.request().postData() ?? '';
      if (!body.includes('eth_getLogs')) return route.continue();
      refused += 1;
      const j = JSON.parse(body) as { id: number } | { id: number }[];
      const err = (id: number) => ({ jsonrpc: '2.0', id, error: { code: -32701, message: 'exceed maximum block range: 50000' } });
      await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(Array.isArray(j) ? j.map((x) => err(x.id)) : err(j.id)) });
    },
  );
  await page.goto(`/${Q}#/pile/${pile}`);
  await expect(page.getByTestId('pile-size')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('history-error')).toContainText("Could not read the pile's history.", { timeout: 30_000 });
  await expect(page.getByTestId('history-error-retry')).toBeVisible();
  expect(refused).toBeGreaterThan(0);
  // The endpoint answers again: Try again reads it, and the line goes.
  await page.unroute(local);
  await page.getByTestId('history-error-retry').click();
  await expect(page.getByTestId('history-error')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId('pile-activity').locator('li').first()).toBeVisible();
});
