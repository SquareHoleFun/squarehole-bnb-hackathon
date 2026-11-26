/**
 * SH-275, SH-277: the BNB Chain testnet alpha suite's shared parts (open-site.spec.mjs, top-bar.spec.mjs): the local
 * chain 97 and its index (stack.mjs), the page's chain routed there, the sign-in service played by the test, the
 * stand-in's settings.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, verifyMessage } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { claimMessage } from '../../../../infra/server/services/alpha/message.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const stack = () => JSON.parse(readFileSync(resolve(ROOT, '.cache/alpha-bnb/stack.json'), 'utf8'));
/** The profile's read endpoints (packages/chain/src/config/testnet-profile.ts), routed to the local chain. */
export const READ_ENDPOINTS = ['https://bsc-testnet-rpc.publicnode.com', 'https://bsc-prebsc-dataseed.bnbchain.org'];
export const TETH = '0x860822580d4eb2529de0c74c3e2b1d6d7c183302';
export const COORDINATOR = [{ type: 'function', name: 'token', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }];
export const STARTER = 15n * 10n ** 15n; // 0.015 tBNB, the starter on chain 97 (SH-284b)
export const CEILING = 5_000_000_000n;
export const TESTER = Object.freeze({ handle: 'ada_builds', xId: '1849302217654321001' });
export const WORDS = Object.freeze({ entry: 'Sign in with X', title: 'Get set up', start: 'Set me up', close: 'Close' });

export const client = (url) => createPublicClient({ transport: http(url, { retryCount: 0 }) });
export async function rpc(url, method, params = []) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error('local chain only');
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}
export const hex = (value) => `0x${value.toString(16)}`;
export async function sendLocal(url, tx) {
  const hash = await rpc(url, 'eth_sendTransaction', [tx]);
  for (let i = 0; i < 100; i += 1) {
    const receipt = await rpc(url, 'eth_getTransactionReceipt', [hash]);
    if (receipt) { if (receipt.status !== '0x1') throw new Error(`reverted: ${hash}`); return receipt; }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no receipt: ${hash}`);
}

/**
 * The page's chain: the profile's read endpoints answered by the local chain (each method recorded in order, with the
 * stand-in's sends, which go to the local chain directly); every other request off the machine refused.
 */
export async function localChain(page, s) {
  const order = [];
  // What went wrong in the page, printed when a test fails (the browser's errors, failed requests, the chain's refusals).
  const problems = [];
  page.on('pageerror', (error) => problems.push(`page error: ${String(error).slice(0, 300)}`));
  page.on('console', (message) => { if (message.type() === 'error') problems.push(`console: ${message.text().slice(0, 300)}`); });
  page.on('requestfailed', (request) => { if (!/privy|walletconnect/.test(request.url())) problems.push(`failed: ${request.method()} ${request.url().slice(0, 120)} ${request.failure()?.errorText ?? ''}`); });
  problemsOf.set(page, problems);
  const census = new Map();
  censusOf.set(page, census);
  page.on('request', (request) => { const key = `${request.method()} ${new URL(request.url()).origin}${request.url().includes('/alpha/') ? new URL(request.url()).pathname : ''}`; census.set(key, (census.get(key) ?? 0) + 1); });
  page.on('worker', (worker) => problems.push(`worker: ${worker.url().slice(0, 120)}`));
  for (const endpoint of READ_ENDPOINTS) {
    await page.route(`${endpoint}/**`, async (route) => {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      try { const body = route.request().postDataJSON(); for (const call of Array.isArray(body) ? body : [body]) order.push(call.method); } catch { /* not JSON-RPC */ }
      try {
        const response = await route.fetch({ url: s.rpcUrl, headers: { 'content-type': 'application/json' } });
        const body = await response.text();
        if (/"error"/.test(body)) problems.push(`rpc answer: ${body.slice(0, 200)}`);
        return await route.fulfill({ status: response.status(), contentType: 'application/json', headers: cors, body });
      } catch (error) {
        problems.push(`rpc route: ${String(error).slice(0, 200)}`);
        return route.abort();
      }
    });
  }
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (route) => (READ_ENDPOINTS.some((e) => route.request().url().startsWith(e)) ? route.fallback() : route.abort()));
  const sent = [];
  orderOf.set(page, order);
  page.on('request', (request) => {
    if (!request.url().startsWith(s.rpcUrl) || request.method() !== 'POST') return;
    try { const body = request.postDataJSON(); for (const call of Array.isArray(body) ? body : [body]) if (call.method === 'eth_sendTransaction') { sent.push(call.params[0]); order.push('SEND'); } } catch { /* not JSON-RPC */ }
  });
  return { order, sent, problems };
}
const problemsOf = new WeakMap();
/** What went wrong in a failed test's page, for its log. */
export const problemsReport = (page) => `problems:\n${(problemsOf.get(page) ?? []).slice(0, 40).join('\n')}\norder tail: ${JSON.stringify(orderOf.get(page)?.slice(-30) ?? [])}\nrequests: ${JSON.stringify([...(censusOf.get(page) ?? new Map())])}`;
const orderOf = new WeakMap();
const censusOf = new WeakMap();

/** Our sign-in service, automatic approval: a stranger (401) until signed in, then approved; the claim as setup.spec plays it. */
export async function alphaServer(page, { signedIn }) {
  const state = { claim: null, claims: [], asked: [], signedIn };
  await page.route(/^http:\/\/127\.0\.0\.1:\d+\/alpha\//, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    state.asked.push(`${request.method()} ${url.pathname.replace(/[0-9a-f-]{36}$/, '<id>')}`);
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(body) });
    if (url.pathname === '/alpha/intake') return json(200, { open: true, returning: false });
    if (url.pathname === '/alpha/me') return state.signedIn ? json(200, { status: 'approved', handle: TESTER.handle, claim: state.claim }) : json(401, { error: 'sign in required' });
    if (!state.signedIn) return json(401, { error: 'sign in required' });
    if (url.pathname === '/alpha/claim/message') {
      const address = url.searchParams.get('address');
      const id = randomUUID();
      const requestedAt = new Date().toISOString();
      state.pending = { id, address, requestedAt, message: claimMessage({ handle: TESTER.handle, xId: TESTER.xId, address, id, requestedAt, origin: 'https://example.org' }) };
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
    /** The sender's receipt: sent, one transaction (no admission on 97's open faucet). */
    sent: (sendTx) => { state.claim = { id: state.claim.id, status: 'sent', admitTx: null, sendTx, reason: null, at: new Date().toISOString() }; },
  };
}

/** The test-network data source, the stand-in on the local chain, and (signed in) the stand-in's X sign-in. */
export async function sitePage(page, s, { signedIn }) {
  await page.addInitScript((standIn) => {
    window.localStorage.setItem('squarehole.data-source.v1', JSON.stringify({ source: 'sepolia' }));
    if (standIn && !window.localStorage.getItem('sh.standin.privy.v1')) window.localStorage.setItem('sh.standin.privy.v1', JSON.stringify({ token: 'standin', account: '1849302217654321001' }));
  }, signedIn);
  await page.route('**/__standin/privy/config', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ chainId: 97, rpcUrl: s.rpcUrl }) }));
}

export const madeAddress = async (page) => {
  const key = await page.evaluate(() => JSON.parse(window.localStorage.getItem('sh.standin.privy.wallet.v1') ?? 'null'));
  return key ? privateKeyToAccount(key).address : null;
};
export const ticks = (page) => page.locator('.sh-setup-chip__tick').evaluateAll((items) => items.map((item) => item.getAttribute('data-mark')));
export const phaseOf = (page) => page.locator('.sh-setup-chip').getAttribute('data-phase');
export const browse = (page, path) => page.evaluate((to) => { window.history.pushState({}, '', to); window.dispatchEvent(new PopStateEvent('popstate')); }, path);
export const tradeBox = (page) => page.getByRole('region', { name: 'Buy and sell' });
