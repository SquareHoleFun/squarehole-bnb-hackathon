/**
 * F156 (SH-ALPHA-TRADE-BOX, SH-ALPHA-TEST-COINS): the alpha suite's chain and wallet, on the local 31337 alpha its stack runs
 * (scripts/dev-alpha-local.mjs --e2e). Every chain call is checked to go to that loopback anvil; the test wallet signs
 * nothing itself: anvil mines what its one unlocked account is asked to send. No trade module is imported here (the
 * site's own trade box does the trading); viem encodes only what the test does around it (a competing buyer's swap,
 * a graduation).
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { createPublicClient, encodeFunctionData, erc20Abi, http, keccak256, parseAbi, toBytes, zeroAddress } from 'viem';
import { createAlphaBox, mineAlpha, readAlphaStack, waitForAlphaFeed } from '../../../../packages/chain/scripts/lib/alpha-local-actions.mjs';
import { assertLocalRpc, hex, mineTo, rpc, waitLocalReceipt } from '../../../../packages/chain/scripts/lib/core-v2-local-runtime.mjs';

export const ETHER = 10n ** 18n;
const MIN_SQRT_PRICE = 4295128739n;
const COORDINATOR = parseAbi(['function token() view returns (address)', 'function hook() view returns (address)', 'function launchRouter() view returns (address)', 'function graduate()', 'function graduated() view returns (bool)']);
const HOOK = parseAbi(['function poolKey() view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks))', 'function phase() view returns (uint8)']);
// PoolSwapTest's entry, for the competing buyer only (the page's own trades come from the trade box).
const HELPER = parseAbi(['function swap((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,(bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96) params,(bool takeClaims,bool settleUsingBurn) settings,bytes hookData) payable returns (int256)']);

export const stackOf = () => readAlphaStack();
export const chain = (stack) => createPublicClient({ transport: http(stack.rpcUrl, { retryCount: 0 }) });
export const boxPath = (token) => `/box/31337/${token.toLowerCase()}`;
export const tradeBox = (page) => page.getByRole('region', { name: 'Buy and sell' });

/** A new box, made by the tester, opening `openIn` seconds from the chain's clock, once the indexer shows it verified. */
export async function newBox(stack, kind, { openIn = 150n } = {}) {
  const openAt = (await chain(stack).getBlock()).timestamp + openIn;
  const coordinator = await createAlphaBox(stack.rpcUrl, { factory: stack.factory, listingId: stack.listingIds[kind], openAt, from: stack.accounts.tester });
  const read = (functionName, address = coordinator, abi = COORDINATOR) => chain(stack).readContract({ address, abi, functionName });
  const [token, hook, router] = await Promise.all([read('token'), read('hook'), read('launchRouter')]);
  // The indexer audits a new box every 32 blocks: two periods' worth, one second each.
  await mineAlpha(stack.rpcUrl, 64);
  await waitForAlphaFeed(stack.origin, [coordinator]);
  return { kind, coordinator, token, hook, router, openAt, p: kind === 'eth' ? null : stack.assets.teth };
}

/** Moves the chain's clock to `at` with one block (never back). */
export const warp = (stack, at) => mineTo(stack.rpcUrl, at);
export const phaseOf = (stack, box) => chain(stack).readContract({ address: box.hook, abi: HOOK, functionName: 'phase' });
export const balanceOf = (stack, coin, owner) => (coin ? chain(stack).readContract({ address: coin, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }) : chain(stack).getBalance({ address: owner }));
export const allowanceOf = (stack, coin, owner, spender) => chain(stack).readContract({ address: coin, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] });

/** One transaction from an unlocked test account, mined; a revert throws. */
export async function sendFrom(stack, from, to, data, value = 0n) {
  await assertLocalRpc(stack.rpcUrl, rpc, { alpha: true });
  const hash = await rpc(stack.rpcUrl, 'eth_sendTransaction', [{ from, to, data, value: hex(value), gas: hex(15_000_000n) }]);
  return waitLocalReceipt(stack.rpcUrl, hash);
}

/**
 * Another tester buys `amount` of the box's price coin through the pool first, moving the price: tETH with an exact
 * approval and its revocation, native ETH with the value sent along (PoolSwapTest pays back what the pool did not take).
 */
export async function competingPoolBuy(stack, box, amount, from = stack.accounts.tester2) {
  const key = await chain(stack).readContract({ address: box.hook, abi: HOOK, functionName: 'poolKey' });
  const helper = stack.localDeployment.poolSwapTest;
  const swap = encodeFunctionData({ abi: HELPER, functionName: 'swap', args: [key,
    { zeroForOne: true, amountSpecified: -amount, sqrtPriceLimitX96: MIN_SQRT_PRICE + 1n }, { takeClaims: false, settleUsingBurn: false }, '0x'] });
  if (!box.p) { await sendFrom(stack, from, helper, swap, amount); return; }
  await sendFrom(stack, from, box.p, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [helper, amount] }));
  await sendFrom(stack, from, helper, swap);
  await sendFrom(stack, from, box.p, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [helper, 0n] }));
}

/** Anyone may graduate a full curve (the rehearsal's "Graduate button"). */
export const graduate = (stack, box) => sendFrom(stack, stack.accounts.tester2, box.coordinator, encodeFunctionData({ abi: COORDINATOR, functionName: 'graduate' }));

/**
 * The browser's wallet: one EIP-6963 provider for the tester's account. It answers the account and the chain, and
 * passes a send to anvil (which mines it from the unlocked account) only when it is from that account, on chain 31337.
 * Every request is recorded, so a test can say nothing was asked on navigation. Also selects the local data source.
 * With `hold` (SH-ONE-PRESS-TRADE: a browser wallet's own window) each send waits until the test answers it, in order:
 * `asked` lists the sends the wallet received, `confirm()` lets the oldest one go.
 */
export async function testWallet(page, stack, { account = stack.accounts.tester, hold = false } = {}) {
  await assertLocalRpc(stack.rpcUrl, rpc, { alpha: true });
  const requests = []; const sent = []; const asked = []; const answers = [];
  await page.exposeFunction('alphaWalletRequest', async ({ method, params = [] }) => {
    requests.push(method);
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
    if (method === 'eth_chainId') return rpc(stack.rpcUrl, 'eth_chainId');
    if (method === 'wallet_switchEthereumChain') { if (BigInt(params[0]?.chainId ?? 0) !== 31337n) throw new Error('only the alpha chain'); return null; }
    if (method !== 'eth_sendTransaction') throw new Error(`the test wallet does not answer ${method}`);
    const tx = params[0];
    if (!tx || tx.from?.toLowerCase() !== account.toLowerCase() || (tx.chainId !== undefined && BigInt(tx.chainId) !== 31337n)) throw new Error('the test wallet sends only from its account, on chain 31337');
    asked.push(tx);
    if (hold) await new Promise((resolve) => { answers.push(resolve); });
    await assertLocalRpc(stack.rpcUrl, rpc, { alpha: true });
    const hash = await rpc(stack.rpcUrl, method, [tx]);
    sent.push({ ...tx, hash });
    return hash;
  });
  await page.addInitScript(() => {
    const provider = { request: (request) => window.alphaWalletRequest(request), on() {}, removeListener() {} };
    window.localStorage.setItem('squarehole.data-source.v1', JSON.stringify({ source: 'local' }));
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
      detail: { info: { uuid: '6b1f7c1e-8f2a-4b39-9d1e-3a5c2f0e7a10', name: 'Alpha test wallet', rdns: 'org.example.alpha-local', icon: 'data:image/svg+xml;base64,PHN2Zy8+' }, provider },
    })));
  });
  // Nothing leaves the machine: any other host is refused (and would fail the test that needed it).
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (route) => route.abort());
  /** The person answers the oldest send waiting in the wallet's window. */
  const confirm = () => { const next = answers.shift(); if (!next) throw new Error('no send is waiting in the wallet'); next(); };
  return { requests, sent, asked, confirm, waiting: () => answers.length };
}

/** The JSON-RPC methods the page asks the site's RPC (anvil), in order, from now on. */
export function rpcMethods(page, stack) {
  const methods = [];
  page.on('request', (request) => {
    if (!request.url().startsWith(stack.rpcUrl) || request.method() !== 'POST') return;
    try { const body = request.postDataJSON(); for (const call of Array.isArray(body) ? body : [body]) methods.push(call.method); } catch { /* not JSON-RPC */ }
  });
  return methods;
}

/** The trade box's own press opens the wallet window; the tester picks the test wallet there. */
export async function connect(page, button = /^(Buy|Sell)$/) {
  await tradeBox(page).getByRole('button', { name: button }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect a browser wallet' });
  await dialog.getByRole('button', { name: /Alpha test wallet/ }).click();
  await expect(dialog).toHaveCount(0);
}

/** The trade box's button with this name, once it can be pressed. */
export async function press(page, name) {
  const button = tradeBox(page).getByRole('button', { name, exact: typeof name === 'string' });
  await expect(button).toBeEnabled({ timeout: 60_000 });
  await button.click();
}

/** The whole page from its top: a page scrolled by a press would draw the sticky header across the middle of the shot. */
async function wholePage(page, file) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: file, fullPage: true, scale: 'css' });
}

const EVIDENCE = join(dirname(fileURLToPath(import.meta.url)), '../../../../docs/evidence/screenshots/sh-alpha-trade-box');
/** The trade box (and with `page`, the whole page) as evidence when SH_EVIDENCE_SCREENSHOTS=1, else in the test's output. */
export async function shot(page, testInfo, name, { whole = false } = {}) {
  const file = process.env.SH_EVIDENCE_SCREENSHOTS === '1' ? join(EVIDENCE, `${name}-${testInfo.project.name}.png`) : testInfo.outputPath(`${name}.png`);
  mkdirSync(dirname(file), { recursive: true });
  if (whole) await wholePage(page, file);
  else await tradeBox(page).screenshot({ path: file, scale: 'css' });
}
// --- the test-coin page (SH-ALPHA-TEST-COINS) -----------------------------------------------------------------------
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

/**
 * Anvil's unlocked accounts beyond the stack's four (owner, tester, tester2, outsider), two per project: none is admitted
 * to the faucet or holds tETH, so the desktop and phone runs of a test never meet.
 */
export async function extraAccounts(stack, testInfo, role) {
  await assertLocalRpc(stack.rpcUrl, rpc, { alpha: true });
  const all = await rpc(stack.rpcUrl, 'eth_accounts');
  const base = 4 + (testInfo.project.name === 'mobile' ? 2 : 0) + (role === 'swap' ? 1 : 0);
  if (!all[base]) throw new Error(`anvil has no account ${base}`);
  return [all[base]];
}

/** Another tester's swap of `amount` of `input` for `output` in their plain pair pool (exact approval, swap, revocation). */
export async function pairSwap(stack, from, input, output, amount) {
  const helper = stack.localDeployment.poolSwapTest;
  const zeroForOne = BigInt(input) < BigInt(output);
  const key = { currency0: zeroForOne ? input : output, currency1: zeroForOne ? output : input, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
  await sendFrom(stack, from, input, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [helper, amount] }));
  await sendFrom(stack, from, helper, encodeFunctionData({ abi: HELPER, functionName: 'swap', args: [key,
    { zeroForOne, amountSpecified: -amount, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n }, { takeClaims: false, settleUsingBurn: false }, '0x'] }));
  await sendFrom(stack, from, input, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [helper, 0n] }));
}

const COIN_EVIDENCE = join(dirname(fileURLToPath(import.meta.url)), '../../../../docs/evidence/screenshots/sh-alpha-test-coins');
/** A part of the test-coin page (and with `whole`, the page) as evidence when SH_EVIDENCE_SCREENSHOTS=1. */
export async function coinShot(page, testInfo, name, locator, { whole = false } = {}) {
  const file = process.env.SH_EVIDENCE_SCREENSHOTS === '1' ? join(COIN_EVIDENCE, `${name}-${testInfo.project.name}.png`) : testInfo.outputPath(`${name}.png`);
  mkdirSync(dirname(file), { recursive: true });
  if (whole) await wholePage(page, file);
  else await locator.screenshot({ path: file, scale: 'css' });
}
// --- one press per trade (SH-ONE-PRESS-TRADE) ------------------------------------------------------------------------

/**
 * An account of this test's own, which anvil sends from as it does for its unlocked ones (impersonated): ETH for gas,
 * and `teth` of W's tETH (no mint). Named by the project and `name`, so the desktop and phone runs never meet.
 */
export async function freshAccount(stack, testInfo, name, { teth = 0n } = {}) {
  await assertLocalRpc(stack.rpcUrl, rpc, { alpha: true });
  const account = `0x${keccak256(toBytes(`sh-one-press ${testInfo.project.name} ${name}`)).slice(-40)}`;
  await rpc(stack.rpcUrl, 'anvil_setBalance', [account, hex(10n ** 20n)]);
  await rpc(stack.rpcUrl, 'anvil_impersonateAccount', [account]);
  if (teth > 0n) await sendFrom(stack, stack.accounts.owner, stack.assets.teth, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [account, teth] }));
  return account;
}

/** The press's two ticks (Steps.tsx) in `region`, as [step, state] pairs; [] when it shows none. */
export const ticksOf = (region) => region.getByRole('list', { name: 'Progress' }).getByRole('listitem').evaluateAll(
  (items) => items.map((item) => [item.getAttribute('data-step'), item.getAttribute('data-state')]));

const PRESS_EVIDENCE = join(dirname(fileURLToPath(import.meta.url)), '../../../../docs/evidence/SH-ONE-PRESS-TRADE');
/**
 * A part of the page as SH-ONE-PRESS-TRADE's evidence, named by the viewport's width (390, 1440), when
 * SH_EVIDENCE_SCREENSHOTS is `1` or `one-press` (the second writes only these); else in the test's output.
 */
export async function pressShot(page, testInfo, name, locator) {
  const wanted = process.env.SH_EVIDENCE_SCREENSHOTS === '1' || process.env.SH_EVIDENCE_SCREENSHOTS === 'one-press';
  const file = wanted ? join(PRESS_EVIDENCE, `${name}-${page.viewportSize()?.width ?? 0}.png`) : testInfo.outputPath(`${name}.png`);
  mkdirSync(dirname(file), { recursive: true });
  await locator.screenshot({ path: file, scale: 'css' });
}
