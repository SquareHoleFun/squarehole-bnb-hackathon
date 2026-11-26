/**
 * F166 (SH-ALPHA-ONBOARDING): "Set me up" to its end, on desktop and phone, against the local 31337 alpha
 * (scripts/dev-alpha-local.mjs --e2e, whose build carries Privy's stand-in for this). The wallet is the one the stand-in
 * makes in the browser; it signs the claim with no window and sends the first drip through anvil, which the test lets
 * send for that address (`anvil_impersonateAccount`), as Privy's own service sends a made wallet's transactions. Our
 * server is played by the test (its claim text is the server's own builder, every signature is checked), and the test
 * plays the sender on the chain: it admits the wallet on tETH and sends it 0.05 SepETH, minutes apart as the live
 * sender does today (the admission first) or in one block as it will, and writes the receipt when it likes.
 *
 * Af2 (the founder, 2026-11-01): the run goes on in the background while the tester browses, its chip in the top bar,
 * and reads the coins from the chain: the drip goes as soon as the admission and the SepETH are both there, before the
 * sender's receipt. The manual path's faucet card follows the same rule with a real browser wallet of the tester's own.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { encodeFunctionData, parseAbi, verifyMessage } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { claimMessage } from '../../../../infra/server/services/alpha/message.mjs';
import { assertLocalRpc, hex, rpc, waitLocalReceipt } from '../../../../packages/chain/scripts/lib/core-v2-local-runtime.mjs';
import { balanceOf, ETHER, sendFrom, stackOf } from './helpers.mjs';

const TETH = parseAbi(['function admit(address[] accounts)']);
const STARTER = 5n * 10n ** 16n;
const TESTER = Object.freeze({ handle: 'ada_builds', xId: '1849302217654321001' });
const WORDS = Object.freeze({
  // SH-198 (SH-ALPHA-LIMITS § 5): setup and the faucet show the claim's real state, no ETA; this server's queued claim has
  // no position.
  title: 'Get set up', start: 'Set me up', finish: 'Finish setup', close: 'Close', queued: 'Claim queued.',
  done: 'You’re set up.',
});

/**
 * Our server for this test (the alpha-access suite runs the real one): an approved tester, the claim text from the
 * server's own builder for the address asked, each claim's signature checked, then the claim queued until `sent`.
 */
async function alphaServer(page) {
  const state = { claim: null, claims: [], asked: [] };
  await page.route(/^http:\/\/127\.0\.0\.1:\d+\/alpha\//, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    state.asked.push(`${request.method()} ${url.pathname.replace(/[0-9a-f-]{36}$/, '<id>')}`);
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(body) });
    if (url.pathname === '/alpha/me') return json(200, { status: 'approved', handle: TESTER.handle, claim: state.claim });
    if (url.pathname === '/alpha/claim/message') {
      const address = url.searchParams.get('address');
      const id = randomUUID();
      const requestedAt = new Date().toISOString();
      state.pending = { id, address, requestedAt, message: claimMessage({ handle: TESTER.handle, xId: TESTER.xId, address, id, requestedAt, origin: 'https://test-app.squarehole.fun' }) };
      return json(200, { id, address, message: state.pending.message, requestedAt });
    }
    if (url.pathname === '/alpha/claim' && request.method() === 'POST') {
      const body = request.postDataJSON();
      const pending = state.pending;
      if (!pending || body.message !== pending.message || body.address !== pending.address) return json(400, { error: 'claim message mismatch' });
      if (!(await verifyMessage({ address: body.address, message: body.message, signature: body.signature }))) return json(400, { error: 'invalid signature' });
      state.claims.push({ ...pending, signature: body.signature });
      state.claim = { id: pending.id, status: 'queued', admitTx: null, sendTx: null, reason: null, at: null };
      return json(202, state.claim);
    }
    if (url.pathname === `/alpha/claim/${state.claim?.id}`) return json(200, state.claim);
    return json(404, { error: 'not found' });
  });
  return {
    state,
    /** The sender's receipt: sent, with its two transactions. */
    sent: (admitTx, sendTx) => { state.claim = { id: state.claim.id, status: 'sent', admitTx, sendTx, reason: null, at: new Date().toISOString() }; },
  };
}

/**
 * The page's setting for this test: the local data source, Privy's stand-in signed in (its X sign-in is the
 * alpha-access suite's), the stand-in's chain this anvil, and nothing off the machine.
 */
async function setupPage(page, stack) {
  await assertLocalRpc(stack.rpcUrl, rpc, { alpha: true });
  await page.addInitScript(() => {
    window.localStorage.setItem('squarehole.data-source.v1', JSON.stringify({ source: 'local' }));
    if (!window.localStorage.getItem('sh.standin.privy.v1')) window.localStorage.setItem('sh.standin.privy.v1', JSON.stringify({ token: 'standin', account: '1849302217654321001' }));
  });
  await page.route('**/__standin/privy/config', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ chainId: 31337, rpcUrl: stack.rpcUrl }) }));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (route) => route.abort());
}

/** The made wallet's address, from the key the stand-in keeps in this browser. */
async function madeAddress(page) {
  const key = await page.evaluate(() => JSON.parse(window.localStorage.getItem('sh.standin.privy.wallet.v1') ?? 'null'));
  return key ? privateKeyToAccount(key).address : null;
}

/** The sender's two parts on the chain, each mined on its own: W admits the address on tETH; another tester sends the SepETH. */
const admit = (stack, address) => sendFrom(stack, stack.accounts.owner, stack.assets.teth, encodeFunctionData({ abi: TETH, functionName: 'admit', args: [[address]] }));
const starter = (stack, address) => sendFrom(stack, stack.accounts.tester2, address, '0x', STARTER);
/** Both parts in ONE block (the sender's coming change): anvil holds its blocks while both are sent, then mines one. */
async function bothInOneBlock(stack, address) {
  await assertLocalRpc(stack.rpcUrl, rpc, { alpha: true });
  await rpc(stack.rpcUrl, 'evm_setAutomine', [false]);
  try {
    const admitHash = await rpc(stack.rpcUrl, 'eth_sendTransaction', [{ from: stack.accounts.owner, to: stack.assets.teth, data: encodeFunctionData({ abi: TETH, functionName: 'admit', args: [[address]] }), gas: hex(1_000_000n) }]);
    const sendHash = await rpc(stack.rpcUrl, 'eth_sendTransaction', [{ from: stack.accounts.tester2, to: address, data: '0x', value: hex(STARTER), gas: hex(100_000n) }]);
    await rpc(stack.rpcUrl, 'evm_mine', []);
    return [await waitLocalReceipt(stack.rpcUrl, admitHash), await waitLocalReceipt(stack.rpcUrl, sendHash)];
  } finally {
    await rpc(stack.rpcUrl, 'evm_setAutomine', [true]);
  }
}

/** The page's own sends to the site's RPC (the stand-in's made wallet goes through it), from now on. */
function pageSends(page, stack) {
  const sent = [];
  page.on('request', (request) => {
    if (!request.url().startsWith(stack.rpcUrl) || request.method() !== 'POST') return;
    try { const body = request.postDataJSON(); for (const call of Array.isArray(body) ? body : [body]) if (call.method === 'eth_sendTransaction') sent.push(call.params[0]); } catch { /* not JSON-RPC */ }
  });
  return sent;
}

/** The run's chip in the top bar, its ticks, its details and its phase. */
const chipOf = (page) => page.getByRole('banner').getByRole('button', { name: /^Setup: / });
const ticks = (page) => page.locator('.sh-setup-chip__tick').evaluateAll((items) => items.map((item) => item.getAttribute('data-mark')));
const phaseOf = (page) => page.locator('.sh-setup-chip').getAttribute('data-phase');
async function openDetails(page) {
  const chip = chipOf(page);
  if ((await chip.getAttribute('aria-expanded')) !== 'true') await chip.click();
  const details = page.getByRole('banner').getByRole('group', { name: WORDS.title });
  await expect(details).toBeVisible();
  return details;
}
/** A move to another page inside the app (the run goes on: a reload would end it). */
const browse = (page, path) => page.evaluate((to) => { window.history.pushState({}, '', to); window.dispatchEvent(new PopStateEvent('popstate')); }, path);
/** The gate's answer: our server's `GET /alpha/me`, then two drawn frames, so whatever it decided is on the page. */
async function gateAnswered(page, go) {
  const answer = page.waitForResponse((response) => new URL(response.url()).pathname === '/alpha/me');
  await go();
  await answer;
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

const EVIDENCE = join(dirname(fileURLToPath(import.meta.url)), '../../../../docs/evidence/SH-ALPHA-ONBOARDING');
/** The top of the page as evidence (`<name>-<width>.png`) when SH_EVIDENCE_SCREENSHOTS=1, else in the test's output. */
async function shot(page, testInfo, name) {
  const width = page.viewportSize()?.width ?? 0;
  const file = process.env.SH_EVIDENCE_SCREENSHOTS === '1' ? join(EVIDENCE, `${name}-${width}.png`) : testInfo.outputPath(`${name}-${width}.png`);
  mkdirSync(dirname(file), { recursive: true });
  await page.evaluate(() => document.fonts?.ready);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: file, scale: 'css', animations: 'disabled' });
}

test('Set me up in the background, to its end: the chip on the boxes page while the tester browses; the admission lands first, the SepETH later, and the drip goes once both are on the chain, before the sender’s receipt; the toast says the numbers', async ({ page }, testInfo) => {
  const stack = stackOf();
  const server = await alphaServer(page);
  await setupPage(page, stack);
  const sent = pageSends(page, stack);
  await page.goto('/');
  const sheet = page.getByRole('region', { name: WORDS.title });
  await sheet.getByRole('button', { name: WORDS.start }).click();
  // The sheet goes at once; the chip in the top bar shows the run.
  await expect(sheet).toHaveCount(0);
  await expect.poll(() => ticks(page), { timeout: 60_000 }).toEqual(['done', 'done', 'active', 'todo']);
  const made = await madeAddress(page);
  expect(made).toMatch(/^0x[0-9a-fA-F]{40}$/);
  expect(server.state.claims.map((claim) => claim.address)).toEqual([made]);
  await expect(page.getByRole('heading', { name: 'Boxes', level: 1 })).toBeVisible();
  await shot(page, testInfo, 'setup-chip-boxes');
  // The tester browses meanwhile; the run goes on.
  await browse(page, '/about/risks');
  await expect(page).toHaveURL(/\/about\/risks$/);
  await expect(chipOf(page)).toBeVisible();

  // The sender admits the wallet first (today's sender waits for confirmations before the SepETH): no drip yet, and the
  // line is still the claim's state on our server.
  await rpc(stack.rpcUrl, 'anvil_impersonateAccount', [made]);
  const admitted = await admit(stack, made);
  const details = await openDetails(page);
  await expect(details.getByRole('status')).toHaveText(WORDS.queued, { timeout: 30_000 });
  expect(await balanceOf(stack, null, made)).toBe(0n);
  expect(sent).toEqual([]);
  await chipOf(page).click();
  await browse(page, '/');
  await expect(page.getByRole('heading', { name: 'Boxes', level: 1 })).toBeVisible();

  // The SepETH lands minutes later: the drip goes at once, the claim still queued on our server (no receipt yet).
  const starterSent = await starter(stack, made);
  await expect.poll(() => phaseOf(page), { timeout: 90_000 }).toBe('done');
  expect(server.state.claim.status).toBe('queued');
  await expect.poll(() => ticks(page)).toEqual(['done', 'done', 'done', 'done']);
  expect(sent).toHaveLength(1);
  expect(sent[0].from.toLowerCase()).toBe(made.toLowerCase());
  expect(sent[0].to.toLowerCase()).toBe(stack.assets.teth.toLowerCase());
  expect(BigInt(sent[0].gas)).toBeGreaterThanOrEqual(480_000n);
  expect(await balanceOf(stack, stack.assets.teth, made)).toBe(ETHER);
  // The end, said once, numbers first: the chain's own figures for the made wallet.
  const toast = page.locator('.sh-setup-toast__text');
  await expect(toast).toHaveText(/^You’re set: 0\.0(?:4\d+|5) SepETH · 1 tETH$/);
  await shot(page, testInfo, 'setup-toast');
  const end = await openDetails(page);
  await expect(end.locator('.sh-setup__figures div').nth(1)).toHaveText('tETH1');
  await expect(end.getByRole('link', { name: 'Test coins' })).toHaveAttribute('href', '/test-coins');
  // The made wallet is the app's wallet now (the top bar's button shows its short address).
  await expect(page.locator('.sh-wallet-button')).toContainText(made.slice(0, 6));
  await expect(end.getByRole('button', { name: WORDS.close })).toBeEnabled();
  await shot(page, testInfo, 'setup-done');
  // The sender's receipt comes afterwards, and records the send (the run did not wait for it).
  server.sent(admitted.transactionHash, starterSent.transactionHash);
  await end.getByRole('button', { name: WORDS.close }).click();
  await expect(chipOf(page)).toHaveCount(0);
  // The app as normal: no more setup on its pages, and the test-coin page's faucet shows the drip taken.
  await page.goto('/test-coins');
  const faucet = page.getByRole('region', { name: 'Faucet' });
  await expect(faucet).toContainText(/Next drip\d+ \w+, \d\d:\d\d UTC/, { timeout: 60_000 });
  await expect(page.getByRole('region', { name: 'Claim' }).getByRole('button', { name: WORDS.start })).toHaveCount(0);
});

test('left mid-way and back: the chip offers “Finish setup”; the coins land meanwhile in one block; nothing happens until the press, which drips once, claiming nothing twice', async ({ page }) => {
  const stack = stackOf();
  const server = await alphaServer(page);
  await setupPage(page, stack);
  const sent = pageSends(page, stack);
  await page.goto('/');
  await page.getByRole('region', { name: WORDS.title }).getByRole('button', { name: WORDS.start }).click();
  await expect.poll(() => ticks(page), { timeout: 60_000 }).toEqual(['done', 'done', 'active', 'todo']);
  const made = await madeAddress(page);
  await gateAnswered(page, () => page.reload());
  await expect(chipOf(page)).toHaveAccessibleName('Setup: Finish setup');
  // The sender sends both parts in one block while the tester is away (its coming change).
  await rpc(stack.rpcUrl, 'anvil_impersonateAccount', [made]);
  const [admitted, starterSent] = await bothInOneBlock(stack, made);
  expect(admitted.blockNumber).toBe(starterSent.blockNumber);
  // Nothing goes by itself: no drip, no claim.
  expect(await balanceOf(stack, stack.assets.teth, made)).toBe(0n);
  expect(sent).toEqual([]);
  const details = await openDetails(page);
  await details.getByRole('button', { name: WORDS.finish }).click();
  await expect.poll(() => phaseOf(page), { timeout: 90_000 }).toBe('done');
  expect(server.state.claims).toHaveLength(1);
  expect(server.state.asked.filter((call) => call === 'POST /alpha/claim')).toHaveLength(1);
  expect(await madeAddress(page)).toBe(made);
  expect(sent).toHaveLength(1);
  expect(await balanceOf(stack, stack.assets.teth, made)).toBe(ETHER);
});

test('the manual path with a browser wallet of the tester’s own, connected from the top bar with nothing pressed first: no setup offered; claimed on today’s Claim card; the faucet waits for the coins (on the list, no SepETH yet) and lights up once both are there; the drip is the wallet’s own', async ({ page }, testInfo) => {
  const stack = stackOf();
  const server = await alphaServer(page);
  await setupPage(page, stack);
  // A fresh wallet with no SepETH: it signs the claim itself (its key in this process), and anvil sends for its address.
  const account = privateKeyToAccount(generatePrivateKey());
  await rpc(stack.rpcUrl, 'anvil_impersonateAccount', [account.address]);
  const walletAsked = [];
  await page.exposeFunction('setupManualWallet', async ({ method, params = [] }) => {
    walletAsked.push(method);
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account.address];
    if (method === 'eth_chainId') return '0x7a69';
    if (method === 'wallet_switchEthereumChain') { if (BigInt(params[0]?.chainId ?? 0) !== 31337n) throw new Error('only the alpha chain'); return null; }
    if (method === 'personal_sign') {
      const [data, from] = params;
      if (typeof from !== 'string' || from.toLowerCase() !== account.address.toLowerCase()) throw new Error('signs for its own address only');
      return account.signMessage({ message: { raw: data } });
    }
    if (method === 'eth_sendTransaction') {
      const tx = params[0];
      if (!tx || tx.from?.toLowerCase() !== account.address.toLowerCase()) throw new Error('sends from its own address only');
      await assertLocalRpc(stack.rpcUrl, rpc, { alpha: true });
      return rpc(stack.rpcUrl, 'eth_sendTransaction', [tx]);
    }
    throw new Error(`the test wallet does not answer ${method}`);
  });
  await page.addInitScript(() => {
    const provider = { request: (request) => window.setupManualWallet(request), on() {}, removeListener() {} };
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
      detail: { info: { uuid: '6b1f7c1e-8f2a-4b39-9d1e-3a5c2f0e7a11', name: 'Alpha test wallet', rdns: 'org.example.alpha-setup', icon: 'data:image/svg+xml;base64,PHN2Zy8+' }, provider } })));
  });
  await page.goto('/test-coins');
  const card = page.getByRole('region', { name: 'Claim' });
  await expect(card.getByRole('button', { name: WORDS.start })).toBeVisible();
  // The tester connects their own wallet from the top bar, without "I'll do it myself": the card goes to today's steps
  // at once, and no setup is offered (re-review wf_6b7087ec-71a).
  await page.locator('.sh-wallet-button').click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: /Alpha test wallet/ }).click();
  await expect(card.locator('dd code')).toHaveAttribute('title', account.address);
  await expect(card.getByRole('button', { name: WORDS.start })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'I’ll do it myself' })).toHaveCount(0);
  await expect(chipOf(page)).toHaveCount(0);
  // Today's steps: our server's exact text for this address, signed by the wallet itself, and queued.
  await card.getByRole('button', { name: 'Claim', exact: true }).click();
  await card.getByRole('button', { name: 'Sign and claim' }).click();
  await expect(card.getByRole('status').first()).toContainText(/queued/i);
  expect(server.state.claims.map((claim) => claim.address)).toEqual([account.address]);
  expect(await verifyMessage({ address: account.address, message: server.state.claims[0].message, signature: server.state.claims[0].signature })).toBe(true);
  expect(walletAsked).toContain('personal_sign');
  // A claim made on today's steps is the manual path on this device: no setup offered for it.
  expect(await page.evaluate(() => JSON.parse(window.localStorage.getItem('sh.alpha.setup.v1') ?? 'null')?.state)).toBe('manual');

  // The faucet waits for the coins: no button before both are on the chain; its line is the claim's state.
  const faucet = page.getByRole('region', { name: 'Faucet' });
  await expect(faucet.getByRole('status')).toHaveText(WORDS.queued, { timeout: 30_000 });
  await expect(faucet.getByRole('button', { name: /^Get / })).toHaveCount(0);
  // On the list, still no SepETH (the live sender's minutes between the two): still waiting, and no press offered.
  const admitted = await admit(stack, account.address);
  await expect(faucet.getByText('Left today')).toBeVisible({ timeout: 30_000 });
  await expect(faucet.getByRole('status')).toHaveText(WORDS.queued);
  await expect(faucet.getByRole('button', { name: /^Get / })).toHaveCount(0);
  await shot(page, testInfo, 'faucet-on-its-way');
  // The SepETH lands: the button lights up within seconds; the drip is the wallet's own send.
  const starterSent = await starter(stack, account.address);
  const get = faucet.getByRole('button', { name: 'Get 1 tETH' });
  await expect(get).toBeEnabled({ timeout: 30_000 });
  await get.click();
  await expect(faucet).toContainText(/Next drip\d+ \w+, \d\d:\d\d UTC/, { timeout: 60_000 });
  expect(await balanceOf(stack, stack.assets.teth, account.address)).toBe(ETHER);
  expect(walletAsked).toContain('eth_sendTransaction');
  server.sent(admitted.transactionHash, starterSent.transactionHash);
  // The setup is offered to nobody who took today's steps: not on the app's pages either.
  await gateAnswered(page, () => page.goto('/'));
  await expect(page.getByRole('region', { name: WORDS.title })).toHaveCount(0);
  await expect(chipOf(page)).toHaveCount(0);
  await rpc(stack.rpcUrl, 'anvil_stopImpersonatingAccount', [account.address]);
});
