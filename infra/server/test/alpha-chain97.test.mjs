// SH-275: the alpha's sign-in and starter on chain 97 (BNB Chain Testnet, the hackathon build), beside Sepolia's,
// whose values and behaviour stay as they were (its own suites, unchanged, hold that; this file adds the pins below).
import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ALPHA_CHAINS, alphaChain } from '../services/alpha/chains.mjs';
import { createChain, STARTER, SEPOLIA, BNB_TESTNET } from '../services/alpha/sender/chain.mjs';
import { createSender, validateClaim } from '../services/alpha/sender/engine.mjs';
import { claimMessage } from '../services/alpha/message.mjs';
import { senderSettings } from '../services/alpha-sender.mjs';
import { createAlphaApi } from '../services/alpha-api.mjs';
import { loadConfig } from '../services/alpha/server.mjs';
import { account, claim, desk, token, id, scratch, fakeChain, viem } from './fixtures/alpha-sender/helpers.mjs';
import { cycle } from './fixtures/alpha-sender/cycle.mjs';
import { origin, publicKey, jwt, identity, directories, instant, issuer } from './fixtures/alpha/helpers.mjs';

const TBNB_STARTER = 15n * 10n ** 15n; // 0.015 tBNB (SH-284b)
const requestedAt = '2026-10-29T12:00:00.000Z';
/** A claim file as chain 97's intake writes it: the chain-97 text, signed by the tester's wallet. */
const claim97 = n => claim(n, { message: claimMessage({ handle: `tester${n}`, xId: String(n), address: account(n).address, id: id(n),
  requestedAt, origin: 'https://test-app.example.org' }, 97) });
/** The fixture chain answering as chain 97: no admission contract, and the adapter's chain-97 transfer. */
function fakeChain97() {
  const f = fakeChain(), { chain } = f;
  chain.chainId = async () => 97;
  chain.admitted = vi.fn(async () => { throw new Error('fixture: chain 97 has no admission step'); });
  chain.prepare = async (kind, c, quote, at) => {
    chain.prepares.push(kind);
    const raw = await desk.signTransaction({ chainId: 97, type: 'eip1559', nonce: at, to: c.address, value: TBNB_STARTER,
      gas: BigInt(quote.sendGas), maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
    return { raw, hash: viem.keccak256(raw), nonce: at, kind };
  };
  return f;
}

describe('SH-275: the table per chain', () => {
  it("keeps Sepolia's values exactly and gives chain 97 its own", () => {
    expect(ALPHA_CHAINS[SEPOLIA]).toEqual({ starter: STARTER, dailyCap: 20, admission: true, coin: 'SepETH', network: 'Sepolia' });
    expect(STARTER).toBe(50000000000000000n);
    expect(alphaChain(BNB_TESTNET)).toEqual({ starter: TBNB_STARTER, dailyCap: 100, admission: false, coin: 'tBNB', network: 'BNB Chain Testnet' });
    for (const other of [1, 56, 31337, '97', 'constructor', 97.5]) expect(() => alphaChain(other)).toThrow('chain refused');
    expect(Object.keys(ALPHA_CHAINS).sort()).toEqual(['11155111', '97']);
  });
  it("signs Sepolia's text byte for byte as before, and chain 97's with its coin and network", async () => {
    const fields = { handle: 'tester1', xId: '1', address: account(1).address, id: id(1), requestedAt, origin };
    expect(claimMessage(fields)).toBe(`Square Hole alpha claim\n\nI link my X account @tester1 (X ID 1) to wallet ${account(1).address}.\nI request starter SepETH on Sepolia (chain 11155111).\nClaim ID: ${id(1)}\nTime: ${requestedAt}\nSite: ${origin}`);
    expect(claimMessage(fields, 11155111)).toBe(claimMessage(fields));
    expect(claimMessage(fields, 97)).toBe(`Square Hole alpha claim\n\nI link my X account @tester1 (X ID 1) to wallet ${account(1).address}.\nI request starter tBNB on BNB Chain Testnet (chain 97).\nClaim ID: ${id(1)}\nTime: ${requestedAt}\nSite: ${origin}`);
    expect(() => claimMessage(fields, 56)).toThrow('chain refused');
    const ours = await claim97(1), theirs = await claim(1);
    expect(await validateClaim(ours, id(1), 97)).toBeNull();
    expect(await validateClaim(theirs, id(1))).toBeNull();
    // A claim signed for one chain is never paid on the other.
    expect(await validateClaim(ours, id(1))).toBe('signed message does not name this claim');
    expect(await validateClaim(theirs, id(1), 97)).toBe('signed message does not name this claim');
  });
});

describe('SH-275: the sender on chain 97', () => {
  it('accepts chain 97 beside Sepolia and nothing else', () => {
    expect(senderSettings({})).toMatchObject({ chainId: 11155111, enabled: false, mode: 'dry-run' });
    expect(senderSettings({ SH_ALPHA_CHAIN_ID: '11155111' }).chainId).toBe(11155111);
    expect(senderSettings({ SH_ALPHA_CHAIN_ID: '97', SH_SERVICE_ENABLED: '1', SH_SERVICE_MODE: 'live' })).toMatchObject({ chainId: 97, enabled: true, mode: 'live' });
    for (const chain of ['1', '56', '31337', ' 97', '097', '0x61']) expect(() => senderSettings({ SH_ALPHA_CHAIN_ID: chain })).toThrow();
    expect(() => senderSettings({ SH_ALPHA_CHAIN_ID: '97', SH_SERVICE_ALLOW_MAINNET: '1' })).toThrow();
  });
  it('the adapter signs chain 97 and 0.01 tBNB; Sepolia stays 11155111 and 0.05', async () => {
    const client = { estimateFeesPerGas: async () => ({ maxFeePerGas: 200000000n, maxPriorityFeePerGas: 100000000n }),
      estimateGas: vi.fn(async () => 21000n), readContract: vi.fn() };
    const c = await claim97(1);
    const ours = createChain({ address: desk.address, teth: token, account: desk, client, chainId: 97 });
    const quote = await ours.quote(c, false);
    expect(client.estimateGas).toHaveBeenCalledWith({ account: desk.address, to: c.address, value: TBNB_STARTER });
    expect(viem.parseTransaction((await ours.prepare('send', c, quote, 0)).raw)).toMatchObject({ chainId: 97, value: TBNB_STARTER, to: c.address.toLowerCase() });
    const theirs = createChain({ address: desk.address, teth: token, account: desk, client });
    expect(viem.parseTransaction((await theirs.prepare('send', c, quote, 0)).raw)).toMatchObject({ chainId: 11155111, value: STARTER });
    expect(() => createChain({ address: desk.address, teth: token, client, chainId: 56 })).toThrow('chain refused');
  });
  it('refuses a node of another chain and names its journal by chain 97', async () => {
    const p = scratch(), { chain } = fakeChain();
    await expect(createSender({ ...p, chain, address: desk.address, teth: token, mode: 'live', chainId: 97 })).rejects.toThrow('chain 97 required');
    p.put(await claim97(1));
    const s = await createSender({ ...p, chain: fakeChain97().chain, address: desk.address, teth: token, mode: 'live', chainId: 97 });
    try {
      expect(await s.cycle()).toBe(true);
      expect(JSON.parse(readFileSync(join(p.state, 'journal.json'), 'utf8')).identity).toBe(`97:${desk.address}:${token}:live`);
      expect(s.monitor().lowFloatThresholdWei).toBe(process.env.SH_ALPHA_LOW_FLOAT_WEI ?? String(5n * TBNB_STARTER));
    } finally { s.close(); }
  });
  it('pays 0.01 tBNB per claim without an admission step, 100 a day; the 101st waits for the next day', async () => {
    const p = scratch(), { chain } = fakeChain97(), funds = chain.funds;
    for (let n = 1; n <= 101; n++) p.put(await claim97(n));
    let at = Date.parse('2026-11-26T08:00:00Z');
    const s = await createSender({ ...p, chain, address: desk.address, teth: token, mode: 'live', chainId: 97, now: () => at });
    try {
      expect(await cycle(s, { until: m => m.lastError === 'daily claim limit reached' })).toBe(false);
      const sent = readdirSync(p.receipts).filter(name => /^[0-9a-f-]{36}\.json$/.test(name));
      expect(sent).toHaveLength(100);
      for (let n = 1; n <= 100; n++) expect(p.receipt(n)).toMatchObject({ status: 'sent', admitTx: null, reason: null });
      expect(() => p.receipt(101)).toThrow();
      expect(s.monitor()).toMatchObject({ dayCount: 100, lastError: 'daily claim limit reached' });
      expect(chain.prepares).toEqual(Array(100).fill('send'));
      expect(chain.admitted).not.toHaveBeenCalled();
      expect(funds - chain.funds).toBe(100n * TBNB_STARTER);
      at = Date.parse('2026-11-27T00:00:01Z');
      expect(await cycle(s)).toBe(true);
      expect(p.receipt(101)).toMatchObject({ status: 'sent', admitTx: null });
      expect(chain.sent.at(-1)).toBe(account(101).address.toLowerCase());
      expect(funds - chain.funds).toBe(101n * TBNB_STARTER);
    } finally { s.close(); }
  }, 120000);
  it('the service reads its key as the keeper does and wants its state folder its own, on chain 97 only', () => {
    const probe = (mode, fault) => {
      const r = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings=ExperimentalWarning',
        'infra/server/test/fixtures/alpha-sender/runtime-97.mjs', mode, fault], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0); return JSON.parse(r.stdout);
    };
    for (const mode of ['dry-run', 'live']) {
      const r = probe(mode, 'none'); expect(r.refused).toBe(false);
      expect(r.events).toEqual([['chain', 97], ...(mode === 'live' ? [['keeper-key', '/run/service-config/desk.key']] : []),
        ['open', '/state'], ['mode', 0o700], ['sender', '/state', 97]]);
      // A root-owned state folder (Sepolia's) is refused here: the chain-97 sender runs as the image's user.
      const bad = probe(mode, 'owner'); expect(bad.refused).toBe(true);
      expect(bad.events.some(e => e[0] === 'sender')).toBe(false);
    }
    // A node answering as Sepolia is refused before any key or state is touched.
    const wrong = probe('live', 'sepolia-node'); expect(wrong.refused).toBe(true); expect(wrong.events).toEqual([['chain', 97]]);
  });
});

describe('SH-275: automatic approval on chain 97', () => {
  const base = { SH_ALPHA_ENABLED: '1', SH_ALPHA_ORIGIN: origin, SH_ALPHA_PRIVY_APP_ID: 'fixture-app',
    SH_ALPHA_PRIVY_VERIFICATION_KEY: publicKey.replaceAll('\n', '\\n'), SH_ALPHA_COOKIE_KEY_FILE: '/run/alpha-config/cookie.key' };
  it('is accepted only together with chain 97, and then needs no Access team', () => {
    expect(loadConfig({ ...base, SH_ALPHA_CHAIN_ID: '97', SH_ALPHA_AUTO_APPROVE: '1' })).toMatchObject({ chainId: 97, autoApprove: true, privyAppId: 'fixture-app', origin });
    for (const env of [{ SH_ALPHA_AUTO_APPROVE: '1' }, { SH_ALPHA_CHAIN_ID: '11155111', SH_ALPHA_AUTO_APPROVE: '1' },
      { SH_ALPHA_CHAIN_ID: '56', SH_ALPHA_AUTO_APPROVE: '1' }, { SH_ALPHA_CHAIN_ID: '97', SH_ALPHA_AUTO_APPROVE: 'yes' },
      { SH_ALPHA_CHAIN_ID: '97' }, {}]) expect(() => loadConfig({ ...base, ...env })).toThrow();
    // Sepolia's settings as today: the desk's Access team is still required, and the result names Sepolia, no auto.
    const sepolia = loadConfig({ ...base, SH_ALPHA_ACCESS_TEAM: issuer, SH_ALPHA_ACCESS_AUD: 'fixture-desk' });
    expect(sepolia).toMatchObject({ chainId: 11155111, autoApprove: false, accessIssuer: issuer });
    const paths = directories();
    expect(() => createAlphaApi({ ...paths, origin, privyAppId: 'fixture-app', privyPublicKey: publicKey, cookieKey: Buffer.alloc(32, 7),
      autoApprove: true })).toThrow();
  });
  function api(settings = {}) {
    const paths = directories();
    let now = instant;
    const a = createAlphaApi({ ...paths, origin, privyAppId: 'fixture-app', privyPublicKey: publicKey, cookieKey: Buffer.alloc(32, 7),
      chainId: 97, autoApprove: true, ...settings }, { now: () => now, fetch: () => { throw new Error('fixture: no Access fetch'); } });
    const request = (path, { method = 'GET', cookie, token, body } = {}) => a.handle(new Request(`${origin}${path}`, { method,
      headers: { ...(method === 'POST' ? { origin, 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}),
        ...(token ? { 'privy-id-token': token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }));
    const signIn = async xId => {
      const response = await request('/alpha/session', { method: 'POST', token: jwt(identity(xId)) });
      return { response, cookie: response.headers.get('set-cookie')?.split(';')[0] };
    };
    const claimWith = async (cookie, wallet) => {
      const challenge = await (await request(`/alpha/claim/message?address=${wallet.address}`, { cookie })).json();
      const response = await request('/alpha/claim', { method: 'POST', cookie,
        body: { address: wallet.address, message: challenge.message, signature: await wallet.signMessage({ message: challenge.message }) } });
      return { challenge, response };
    };
    return { ...paths, request, signIn, claimWith, time: value => { now = value; }, close: () => a.close() };
  }
  it('approves a new sign-up at once; the desk routes answer 404; the claim is chain 97 and paid 0.01 tBNB', async () => {
    const f = api();
    try {
      const { response, cookie } = await f.signIn('123456789012345678');
      expect(await response.json()).toEqual({ status: 'approved', handle: 'fixture_user', claim: null });
      expect((await f.request('/alpha/check', { cookie })).status).toBe(200);
      for (const [path, method] of [['/desk/api/signups', 'GET'], ['/desk/api/check', 'GET'], ['/desk/api/decide', 'POST'], ['/desk/api/other', 'GET']]) {
        const r = await f.request(path, { method, body: method === 'POST' ? { xId: '123456789012345678', decision: 'remove' } : undefined });
        expect(r.status, path).toBe(404);
      }
      // A second sign-in keeps the status.
      expect((await (await f.signIn('123456789012345678')).response.json()).status).toBe('approved');
      const { challenge, response: claimed } = await f.claimWith(cookie, account(7));
      expect(challenge.message).toContain('I request starter tBNB on BNB Chain Testnet (chain 97).');
      expect(claimed.status).toBe(202);
      const payload = JSON.parse(readFileSync(join(f.queueDir, `${challenge.id}.json`), 'utf8'));
      expect(await validateClaim(payload, challenge.id, 97)).toBeNull();
      // The chain-97 sender pays it from the same queue: 0.01 tBNB, no admission.
      const { chain } = fakeChain97(), state = join(f.root, 'sender-state');
      const s = await createSender({ queue: f.queueDir, receipts: f.receiptsDir, state, chain, address: desk.address, teth: token, mode: 'live', chainId: 97, now: () => instant });
      try { expect(await cycle(s)).toBe(true); } finally { s.close(); }
      expect(chain.sent).toEqual([account(7).address.toLowerCase()]);
      expect(await (await f.request(`/alpha/claim/${challenge.id}`, { cookie })).json()).toMatchObject({ status: 'sent', admitTx: null });
    } finally { f.close(); }
  });
  it('keeps the sign-up cap: a new sign-up past it is refused', async () => {
    const f = api({ signupCap: 2 });
    try {
      expect((await f.signIn('1')).response.status).toBe(200);
      expect((await f.signIn('2')).response.status).toBe(200);
      expect((await f.signIn('3')).response.status).toBe(429);
      expect((await f.signIn('1')).response.status).toBe(200);
    } finally { f.close(); }
  });
  it('takes 100 claims a day at intake; the 101st waits for the next UTC day', async () => {
    const f = api({ signupCap: 200 });
    try {
      for (let n = 1; n <= 100; n++) {
        const { cookie } = await f.signIn(String(n));
        expect((await f.claimWith(cookie, account(n))).response.status, `claim ${n}`).toBe(202);
      }
      const { cookie } = await f.signIn('101');
      const refused = (await f.claimWith(cookie, account(101))).response;
      expect(refused.status).toBe(429); expect(await refused.json()).toEqual({ error: 'daily claim cap reached' });
      // The same session (seven days) on the next UTC day: accepted.
      f.time(Date.parse('2026-10-30T00:00:01Z'));
      expect((await f.claimWith(cookie, account(101))).response.status).toBe(202);
    } finally { f.close(); }
  }, 120000);
});
