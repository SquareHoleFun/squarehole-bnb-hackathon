import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { shLimit } from '../../../vitest.timeouts.mjs';
import { createAlphaApi } from '../services/alpha-api.mjs';
import { createSender } from '../services/alpha/sender/engine.mjs';
import { STARTER } from '../services/alpha/sender/chain.mjs';
import { account, desk, token, scratch, fakeChain } from './fixtures/alpha-sender/helpers.mjs';
import { origin, issuer, instant, publicKey, jwk, jwt, identity, deskToken, directories } from './fixtures/alpha/helpers.mjs';
import { claimStateOf } from '../../../apps/web/src/features/alpha-sepolia/alpha-api.ts';
import { claimLine } from '../../../apps/web/src/features/alpha-sepolia/alpha-words.ts';

it('F1: empty-float intake on A and B survives restart/refill, paying the same remaining claim on C', async () => {
  const paths = directories(), { state } = scratch(), { chain } = fakeChain();
  let now = instant;
  const config = { ...paths, origin, privyAppId: 'fixture-app', privyPublicKey: publicKey,
    cookieKey: Buffer.alloc(32, 7), accessIssuer: issuer, accessAudience: 'fixture-desk' };
  const openApi = () => createAlphaApi(config, { now: () => now,
    fetch: async url => { expect(url).toBe(`${issuer}/cdn-cgi/access/certs`); return new Response(JSON.stringify({ keys: [jwk] })); } });
  let api = openApi(), sender, remaining;
  const request = (path, { method = 'GET', cookie, body, headers = {} } = {}) => api.handle(new Request(`${origin}${path}`, {
    method, headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const intake = async n => {
    const xId = String(n), signer = account(n);
    const login = await request('/alpha/session', { method: 'POST',
      headers: { 'privy-id-token': jwt(identity(xId, { iat: now / 1000, exp: now / 1000 + 3600 })) } });
    expect(login.status).toBe(200);
    const cookie = login.headers.getSetCookie()[0].split(';')[0];
    expect((await request('/desk/api/decide', { method: 'POST', body: { xId, decision: 'approve' },
      headers: { 'Cf-Access-Jwt-Assertion': deskToken({ exp: now / 1000 + 3600 }) } })).status).toBe(200);
    const challenge = await (await request(`/alpha/claim/message?address=${signer.address}`, { cookie })).json();
    const accepted = await request('/alpha/claim', { method: 'POST', cookie, body: { address: signer.address,
      message: challenge.message, signature: await signer.signMessage({ message: challenge.message }) } });
    expect(accepted.status).toBe(202);
    const claim = await accepted.json();
    expect(claim).toMatchObject({ id: challenge.id, status: 'queued' });
    return { id: claim.id, cookie };
  };
  const seen = [];
  const inspect = async () => {
    if (!remaining) return;
    const response = await request(`/alpha/claim/${remaining.id}`, { cookie: remaining.cookie });
    expect(response.status).toBe(200);
    const claim = claimStateOf(await response.json());
    expect(claim).not.toBeNull(); expect(claim.id).toBe(remaining.id);
    const me = await (await request('/alpha/me', { cookie: remaining.cookie })).json();
    expect(claimStateOf(me.claim)).toEqual(claim);
    expect(claimLine(claim)).not.toBe('Refused. Nothing was sent.');
    expect(claim.status).not.toBe('refused'); seen.push(claim.status);
    return claim;
  };
  const openSender = () => createSender({ queue: paths.queueDir, receipts: paths.receiptsDir, state,
    chain, address: desk.address, teth: token, mode: 'live', now: () => now, checkpoint: inspect });
  try {
    chain.funds = 0n;
    const first = [];
    for (let n = 1; n <= 20; n++) first.push(await intake(n));
    sender = await openSender();
    expect(await sender.cycle()).toBe(false); expect(sender.monitor().waitingClaims).toBe(20);
    expect(chain.sent).toHaveLength(0);
    now += 86400000; remaining = await intake(21);
    const queuePath = join(paths.queueDir, `${remaining.id}.json`), queued = readFileSync(queuePath, 'utf8');
    expect(JSON.parse(queued).acceptedAt).toBe(new Date(now).toISOString());
    expect((await inspect()).status).toBe('queued');
    expect(await sender.cycle()).toBe(false); expect((await inspect()).status).toBe('waiting');
    expect(sender.monitor().waitingClaims).toBe(21); expect(chain.prepares).toHaveLength(0);
    sender.close(); api.close(); api = openApi(); sender = await openSender();
    expect((await inspect()).status).toBe('waiting');
    chain.funds = STARTER * 30n;
    expect(await sender.cycle()).toBe(false);
    expect(chain.sent).toHaveLength(20); expect(sender.monitor()).toMatchObject({ dayCount: 20, queueLength: 1 });
    for (const claim of first) expect(JSON.parse(readFileSync(join(paths.receiptsDir, `${claim.id}.json`), 'utf8')).status).toBe('sent');
    expect((await inspect()).status).toBe('queued');
    expect(existsSync(join(paths.receiptsDir, `${remaining.id}.json`))).toBe(false);
    // Another cycle and another restart on B cannot exceed twenty or manufacture a final receipt.
    sender.close(); api.close(); api = openApi(); sender = await openSender();
    expect(await sender.cycle()).toBe(false); expect(chain.sent).toHaveLength(20);
    expect(sender.monitor().dayCount).toBe(20); expect((await inspect()).status).toBe('queued');
    expect(existsSync(join(paths.receiptsDir, `${remaining.id}.json`))).toBe(false);
    expect(readFileSync(queuePath, 'utf8')).toBe(queued);
    now += 86400000;
    expect(await sender.cycle()).toBe(true); expect((await inspect()).status).toBe('sent');
    expect(sender.monitor().dayCount).toBe(1); expect(chain.sent).toHaveLength(21);
    expect(chain.sent.at(-1)).toBe(account(21).address.toLowerCase());
    expect(new Set(seen)).toEqual(new Set(['queued', 'waiting', 'sending', 'sent']));
    expect(await sender.cycle()).toBe(true); expect(chain.sent).toHaveLength(21);
  } finally { sender?.close(); api.close(); }
}, shLimit(60000));
