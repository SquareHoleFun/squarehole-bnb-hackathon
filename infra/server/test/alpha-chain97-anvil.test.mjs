// SH-275 on a local Anvil as chain 97 (no external RPC, fixture keys only): sign-ins approved at once by the API in
// its chain-97 mode, their claims through the queue to the production engine and adapter (live mode, the deployed
// twelve confirmations, a throwaway signer), each paid exactly 0.015 tBNB with no admission transaction; 100 a day at
// both ends, the 101st waits for the next UTC day.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createAlphaApi } from '../services/alpha-api.mjs';
import { createSender } from '../services/alpha/sender/engine.mjs';
import { createChain } from '../services/alpha/sender/chain.mjs';
import { origin, publicKey, jwt, identity, directories } from './fixtures/alpha/helpers.mjs';
import { account, desk, token, viem } from './fixtures/alpha-sender/helpers.mjs';
import { cycle } from './fixtures/alpha-sender/cycle.mjs';
import { shLimit } from '../../../vitest.timeouts.mjs';

const TBNB_STARTER = 15n * 10n ** 15n; // 0.015 tBNB (SH-284b)
describe('SH-275: sign-in to starter on a local chain 97', () => {
  let child, pub, rpcUrl;
  const start = Date.parse('2026-11-26T08:00:00Z');
  beforeAll(async () => {
    child = spawn('anvil', ['--host', '127.0.0.1', '--port', '0', '--accounts', '0', '--chain-id', '97',
      '--timestamp', String(start / 1000)], { stdio: ['ignore', 'pipe', 'pipe'], cwd: resolve('.cache/tmp') });
    rpcUrl = await new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error('local Anvil listener did not start')), 8000);
      let output = '';
      child.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/Listening on 127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timer); done(`http://127.0.0.1:${match[1]}`); }
      });
      child.stderr.on('data', () => {});
      child.once('error', () => { clearTimeout(timer); fail(new Error('local Anvil executable unavailable')); });
      child.once('exit', () => { clearTimeout(timer); fail(new Error('local Anvil exited before listening')); });
    });
    pub = viem.createPublicClient({ transport: viem.http(rpcUrl), cacheTime: 0 });
    await pub.request({ method: 'anvil_setBalance', params: [desk.address, viem.toHex(2n * 10n ** 18n)] }); // a 2 tBNB float
  }, shLimit(30000));
  afterAll(async () => {
    if (child && child.exitCode === null) await new Promise(done => { child.once('exit', done); child.kill('SIGTERM'); });
  });

  it('approves at once, pays 0.015 tBNB per claim without admission, and holds the 101st to the next day', async () => {
    expect(await pub.getChainId()).toBe(97);
    const paths = directories(), state = join(paths.root, 'sender-state');
    let apiNow = start, senderNow = start;
    const api = createAlphaApi({ ...paths, origin, privyAppId: 'fixture-app', privyPublicKey: publicKey, cookieKey: Buffer.alloc(32, 9),
      chainId: 97, autoApprove: true, signupCap: 200 }, { now: () => apiNow, fetch: () => { throw new Error('no network'); } });
    const request = (path, { method = 'GET', cookie, token: idToken, body } = {}) => api.handle(new Request(`${origin}${path}`, { method,
      headers: { ...(method === 'POST' ? { origin, 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}),
        ...(idToken ? { 'privy-id-token': idToken } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }));
    const claimWith = async (cookie, wallet) => {
      const challenge = await (await request(`/alpha/claim/message?address=${wallet.address}`, { cookie })).json();
      return request('/alpha/claim', { method: 'POST', cookie,
        body: { address: wallet.address, message: challenge.message, signature: await wallet.signMessage({ message: challenge.message }) } });
    };
    // As deployed: twelve confirmations; Anvil mines a block per transaction, then twelve between cycles.
    const chain = createChain({ rpcUrl, address: desk.address, teth: token, account: desk, chainId: 97 });
    const sender = await createSender({ queue: paths.queueDir, receipts: paths.receiptsDir, state, chain, address: desk.address,
      teth: token, mode: 'live', chainId: 97, now: () => senderNow });
    const mine = () => pub.request({ method: 'anvil_mine', params: ['0xc', '0x1'] });
    try {
      const cookies = [];
      for (let n = 1; n <= 101; n++) {
        const signIn = await request('/alpha/session', { method: 'POST', token: jwt({ ...identity(String(n)), iat: start / 1000, exp: start / 1000 + 86400 * 2 }) });
        expect((await signIn.json()).status).toBe('approved');
        cookies[n] = signIn.headers.get('set-cookie').split(';')[0];
        const claimed = await claimWith(cookies[n], account(n));
        expect(claimed.status, `claim ${n}`).toBe(n <= 100 ? 202 : 429);
      }
      // The day's 100 accepted claims, all paid.
      expect(await cycle(sender, { mine, timeoutMs: 600000 })).toBe(true);
      expect(sender.monitor()).toMatchObject({ dayCount: 100 });
      for (let n = 1; n <= 100; n++) expect(await pub.getBalance({ address: account(n).address }), `tester ${n}`).toBe(TBNB_STARTER);
      // The API's next UTC day accepts the 101st; the sender, still on its day, holds it without a transaction.
      apiNow = Date.parse('2026-11-27T00:00:05Z');
      expect((await claimWith(cookies[101], account(101))).status).toBe(202);
      expect(await cycle(sender, { mine, until: m => m.lastError === 'daily claim limit reached' })).toBe(false);
      expect(await pub.getBalance({ address: account(101).address })).toBe(0n);
      expect(await pub.getTransactionCount({ address: desk.address })).toBe(100);
      senderNow = Date.parse('2026-11-27T00:00:10Z');
      expect(await cycle(sender, { mine, timeoutMs: 120000 })).toBe(true);
      expect(await pub.getBalance({ address: account(101).address })).toBe(TBNB_STARTER);
      expect(await pub.getTransactionCount({ address: desk.address })).toBe(101);
      // Every transaction is a chain-97 transfer of exactly the starter; none goes to an admission contract.
      const journal = JSON.parse(readFileSync(join(state, 'journal.json'), 'utf8')).entries;
      expect(journal).toHaveLength(101);
      for (const e of journal) {
        expect(e.admit).toBeUndefined(); expect(e.needsAdmit).toBe(false);
        expect(viem.parseTransaction(e.send.raw)).toMatchObject({ chainId: 97, value: TBNB_STARTER, to: e.address.toLowerCase() });
        expect(JSON.parse(readFileSync(join(paths.receiptsDir, `${e.id}.json`), 'utf8'))).toMatchObject({ status: 'sent', admitTx: null, sendTx: e.send.hash });
      }
      expect(existsSync(join(paths.receiptsDir, 'sender-status.json'))).toBe(true);
    } finally { sender.close(); api.close(); }
  }, shLimit(900000));
});
