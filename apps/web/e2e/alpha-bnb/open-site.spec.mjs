/**
 * SH-275: the alpha on the BNB Chain testnet site, in a browser, on a local chain 97 (SH-260's plain rehearsal replayed,
 * with the indexer over it: stack.mjs), with Privy's stand-in (the real Privy app answers only the live site's address).
 * Our sign-in service and its sender are played by the test, with the service's own claim text builder and each
 * signature checked, as e2e/alpha-trade/setup.spec.mjs plays them; automatic approval means a signed-in visitor is
 * simply approved. What it proves:
 * - the open site: a visitor without a sign-in sees the site, plus ONE entry in the top bar, the join page's own button
 *   text, leading to the join page (with the BNB notice; the production build's join-only output is checked apart);
 * - "Set me up" on chain 97 to its end: the stand-in's made wallet, the claim, the starter (0.015 tBNB, sent here as the
 *   sender sends it), the first drip from the open faucet, the chip's ticks, the toast in tBNB;
 * - the made wallet's sends go through the site's send rules: the chain's gas price read through the site's RPC before
 *   each send, both EIP-1559 fields and no legacy price, under the 5 gwei ceiling (packages/chain/src/write/executor.ts);
 * - one buy on a demo box (the rehearsal's box priced in the native coin, graduated) with the made wallet.
 * Every chain call goes to the local anvil: the profile's two read endpoints are routed there, and anything else that
 * would leave the machine is refused.
 */
import { expect, test } from '@playwright/test';
import { erc20Abi } from 'viem';
import {
  CEILING, COORDINATOR, STARTER, TETH, WORDS, alphaServer, browse, client, hex, localChain, madeAddress, phaseOf, problemsReport, rpc,
  sendLocal, sitePage, stack, ticks, tradeBox,
} from './helpers.mjs';

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) console.warn(`[${testInfo.project.name}] ${testInfo.title.slice(0, 40)}: ${problemsReport(page)}`);
});

/** Each send: both EIP-1559 fields, no legacy price, at least the chain's price and under the ceiling; a price read before it. */
async function sendRules(s, order, sent) {
  const price = BigInt(await rpc(s.rpcUrl, 'eth_gasPrice'));
  expect(price).toBeGreaterThan(0n);
  for (const tx of sent) {
    expect(tx.gasPrice).toBeUndefined();
    const [tip, max] = [BigInt(tx.maxPriorityFeePerGas), BigInt(tx.maxFeePerGas)];
    expect(tip).toBeGreaterThanOrEqual(price);
    expect(max).toBeGreaterThanOrEqual(tip);
    expect(tip).toBeLessThanOrEqual(CEILING);
  }
  // The chain's price is read through the site's RPC before every send (the read right before the wallet is asked).
  const sends = order.flatMap((method, at) => (method === 'SEND' ? [at] : []));
  expect(sends).toHaveLength(sent.length);
  let from = 0;
  for (const at of sends) { expect(order.slice(from, at)).toContain('eth_gasPrice'); from = at + 1; }
}

async function sendStarter(s, made) {
  await rpc(s.rpcUrl, 'anvil_impersonateAccount', [made]);
  const [funder] = await rpc(s.rpcUrl, 'eth_accounts');
  return sendLocal(s.rpcUrl, { from: funder, to: made, value: hex(STARTER), gas: hex(100_000n) });
}

test('the open site: no sign-in, the site as it is plus one entry in the join page’s own words; the join page with the BNB notice; no desk', async ({ page }) => {
  const s = stack();
  const server = await alphaServer(page, { signedIn: false });
  await sitePage(page, s, { signedIn: false });
  await localChain(page, s);
  const me = page.waitForResponse((response) => new URL(response.url()).pathname === '/alpha/me');
  await page.goto('/');
  expect((await me).status()).toBe(401);
  // The dev server compiles the pages on their first request: the first page may take a while.
  await expect(page.getByRole('heading', { name: 'Boxes', level: 1 })).toBeVisible({ timeout: 120_000 });
  const entry = page.getByRole('banner').getByRole('link', { name: WORDS.entry });
  await expect(entry).toBeVisible();
  await expect(entry).toHaveAttribute('href', '/join');
  // Nothing else of the alpha on the page: no welcome sheet, no chip.
  await expect(page.getByRole('region', { name: WORDS.title })).toHaveCount(0);
  await expect(page.locator('.sh-setup-chip')).toHaveCount(0);
  // Only who is signed in was asked (the dev server's StrictMode runs the shell's effect twice: once per run).
  expect(server.state.asked.length).toBeGreaterThanOrEqual(1);
  expect(new Set(server.state.asked)).toEqual(new Set(['GET /alpha/me']));
  await entry.click();
  await expect(page).toHaveURL(/\/join$/);
  // The live stack's server answers /join with the join page (lane n's Caddy routes); Vite's dev server serves it at
  // its folder's address.
  if (!(await page.getByRole('heading', { name: 'Square Hole alpha', level: 1 }).isVisible().catch(() => false))) await page.goto('/join/');
  await expect(page.getByRole('heading', { name: 'Square Hole alpha', level: 1 })).toBeVisible({ timeout: 120_000 });
  const join = page.locator('main.sh-join');
  await expect(join).toContainText('BNB Chain test network');
  await expect(join.getByRole('button', { name: WORDS.entry })).toBeVisible();
  await expect(join).not.toContainText(/Sepolia|SepETH/);
});

test('Set me up on chain 97 to its end, through the site’s send rules; then one buy on a demo box with the made wallet', async ({ page }, testInfo) => {
  const s = stack();
  const server = await alphaServer(page, { signedIn: true });
  await sitePage(page, s, { signedIn: true });
  const { order, sent } = await localChain(page, s);
  await page.goto('/');
  // Approved at once (the service's automatic approval): the welcome sheet offers "Set me up"; no entry in the bar.
  const sheet = page.getByRole('region', { name: WORDS.title });
  await expect(sheet).toContainText('A wallet, 0.015 tBNB for gas and 1 tETH to play with. One press.', { timeout: 120_000 });
  await expect(page.getByRole('banner').getByRole('link', { name: WORDS.entry })).toHaveCount(0);
  await sheet.getByRole('button', { name: WORDS.start }).click();
  await expect(sheet).toHaveCount(0);
  await expect.poll(() => ticks(page), { timeout: 90_000 }).toEqual(['done', 'done', 'active', 'todo']);
  const made = await madeAddress(page);
  expect(made).toMatch(/^0x[0-9a-fA-F]{40}$/);
  expect(server.state.claims.map((claim) => claim.address)).toEqual([made]);
  expect(sent).toEqual([]);

  // The sender's starter: 0.015 tBNB to the made wallet (on 97 no admission: the faucet is open). The local chain sends
  // for the made wallet's address, as Privy's service sends a made wallet's transactions.
  const starter = await sendStarter(s, made);
  await expect.poll(() => phaseOf(page), { timeout: 120_000 }).toBe('done');
  await expect.poll(() => ticks(page)).toEqual(['done', 'done', 'done', 'done']);
  expect(sent).toHaveLength(1);
  expect(sent[0].from.toLowerCase()).toBe(made.toLowerCase());
  expect(sent[0].to.toLowerCase()).toBe(TETH);
  expect(await client(s.rpcUrl).readContract({ address: TETH, abi: erc20Abi, functionName: 'balanceOf', args: [made] })).toBe(10n ** 18n);
  await expect(page.locator('.sh-setup-toast__text')).toHaveText(/^You’re set: 0\.01[0-4]\d* tBNB · 1 tETH$/);
  await page.screenshot({ path: testInfo.outputPath('setup-done.png') });
  server.sent(starter.transactionHash);

  // One buy on the demo box priced in the native coin (graduated: a pool buy), with what is left of the starter.
  const box = await client(s.rpcUrl).readContract({ address: s.boxes['box-bnb'], abi: COORDINATOR, functionName: 'token' });
  await browse(page, `/box/97/${box.toLowerCase()}`);
  await expect(tradeBox(page)).toBeVisible({ timeout: 90_000 });
  // The setup's chip in the top bar and the box page's own head (SH-273's picture) on one page.
  await expect(page.locator('.sh-setup-chip')).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('box-with-chip.png') });
  await tradeBox(page).getByRole('textbox', { name: 'Amount in BNB' }).fill('0.001');
  const buy = tradeBox(page).getByRole('button', { name: 'Buy', exact: true });
  await expect(buy).toBeEnabled({ timeout: 90_000 });
  await buy.click();
  await expect(tradeBox(page).getByRole('list', { name: 'Transactions' })).toContainText(/Buy (?:confirmed|filled)/, { timeout: 120_000 });
  await page.screenshot({ path: testInfo.outputPath('buy-done.png') });
  const token = await client(s.rpcUrl).readContract({ address: box, abi: erc20Abi, functionName: 'balanceOf', args: [made] });
  expect(token).toBeGreaterThan(0n);
  // The drip and the buy: both from the made wallet, both through the send rules.
  expect(sent.length).toBeGreaterThanOrEqual(2);
  for (const tx of sent) expect(tx.from.toLowerCase()).toBe(made.toLowerCase());
  await sendRules(s, order, sent);
  testInfo.annotations.push({ type: 'sends', description: JSON.stringify(sent.map((tx) => ({ to: tx.to, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, gas: tx.gas }))) });
  console.warn(`[${testInfo.project.name}] sends: ${JSON.stringify(sent.map((tx) => ({ to: tx.to, maxFeePerGas: BigInt(tx.maxFeePerGas).toString(), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas).toString() })))}`);
});

test('a new visit starting on Settings shows the wallet from setup in the top bar without a press', async ({ page, context }) => {
  const s = stack();
  const server = await alphaServer(context, { signedIn: true });
  await sitePage(page, s, { signedIn: true });
  await localChain(page, s);
  await page.goto('/');
  const sheet = page.getByRole('region', { name: WORDS.title });
  await sheet.getByRole('button', { name: WORDS.start }).click({ timeout: 120_000 });
  await expect.poll(() => ticks(page), { timeout: 90_000 }).toEqual(['done', 'done', 'active', 'todo']);
  const made = await madeAddress(page);
  const starter = await sendStarter(s, made);
  await expect.poll(() => phaseOf(page), { timeout: 120_000 }).toBe('done');
  server.sent(starter.transactionHash);

  await page.close();
  const returning = await context.newPage();
  // Only the first tab seeded the stand-in's sign-in. This tab reads the session and wallet saved by setup.
  await sitePage(returning, s, { signedIn: false });
  await localChain(returning, s);
  await returning.goto('/settings');
  await expect(returning.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  const name = `Wallet Privy made ${made.slice(0, 6)}…${made.slice(-4)}`;
  await expect(returning.getByRole('banner').getByRole('button', { name, exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(returning.getByRole('dialog')).toHaveCount(0);
});
