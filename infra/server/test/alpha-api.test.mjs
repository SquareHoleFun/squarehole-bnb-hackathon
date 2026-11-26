import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
const { test } = process.env.VITEST ? await import('vitest') : await import('node:test');
import { createSender, validateClaim } from '../services/alpha/sender/engine.mjs';
import { scratch, fakeChain } from './fixtures/alpha-sender/helpers.mjs';
import { createAlphaApi } from '../services/alpha-api.mjs';
import { wallet, otherWallet, origin, issuer, instant, publicKey, jwk, jwt, identity, deskToken, directories } from './fixtures/alpha/helpers.mjs';

test('SH-196: durable acceptance time is distinct from the signed challenge time', async () => {
  const f = fixture();
  try {
    const cookie = await f.approved(), c = await f.challenge(cookie);
    f.time(instant + 1234); assert.equal((await f.claim(cookie, c)).status, 202);
    const payload = JSON.parse(readFileSync(join(f.queueDir, `${c.id}.json`), 'utf8'));
    assert.equal(payload.requestedAt, c.requestedAt);
    assert.equal(payload.acceptedAt, new Date(instant + 1234).toISOString());
    assert.equal(await validateClaim(payload, c.id), null);
    f.restart(); assert.equal(JSON.parse(readFileSync(join(f.queueDir, `${c.id}.json`), 'utf8')).acceptedAt, payload.acceptedAt);
  } finally { f.close(); }
});

test('SH-196: waiting status holds account/address uniqueness and final receipts take precedence', async () => {
  const f = fixture();
  try {
    const cookie = await f.approved(), c = await f.challenge(cookie);
    assert.equal((await f.claim(cookie, c)).status, 202);
    const waiting = { v: 1, id: c.id, status: 'waiting', admitTx: null, sendTx: null,
      reason: 'insufficient float for starter and gas', at: new Date(instant).toISOString() };
    const path = join(f.receiptsDir, `${c.id}.progress.json`);
    writeFileSync(path, JSON.stringify(waiting)); f.restart();
    assert.deepEqual((await (await f.request('/alpha/me', { cookie })).json()).claim, waiting);
    assert.deepEqual(await (await f.request(`/alpha/claim/${c.id}`, { cookie })).json(), waiting);
    assert.equal((await f.request(`/alpha/claim/message?address=${otherWallet.address}`, { cookie })).status, 409);
    const stranger = await f.approved('999');
    assert.equal((await f.request(`/alpha/claim/${c.id}`, { cookie: stranger })).status, 404);
    const other = await f.challenge(stranger);
    assert.equal((await f.claim(stranger, other)).status, 409);
    writeFileSync(path, JSON.stringify({ ...waiting, sendTx: `0x${'ab'.repeat(32)}` }));
    assert.equal((await f.request(`/alpha/claim/${c.id}`, { cookie })).status, 503);
    const sent = { ...waiting, status: 'sent', reason: null, sendTx: `0x${'cd'.repeat(32)}` };
    writeFileSync(join(f.receiptsDir, `${c.id}.json`), JSON.stringify(sent));
    assert.deepEqual(await (await f.request(`/alpha/claim/${c.id}`, { cookie })).json(), sent);
  } finally { f.close(); }
});

function fixture(settings = {}) {
  const paths = directories();
  let now = instant, fetches = 0;
  const cfg = { ...paths, origin, privyAppId: 'fixture-app', privyPublicKey: publicKey, cookieKey: Buffer.alloc(32, 7), accessIssuer: issuer, accessAudience: 'fixture-desk', ...settings };
  const fetchKeys = async url => { assert.equal(url, `${issuer}/cdn-cgi/access/certs`); fetches++; return new Response(JSON.stringify({ keys: [jwk] })); };
  let api = createAlphaApi(cfg, { now: () => now, fetch: fetchKeys });
  const request = (path, { method = 'GET', cookie, token, desk, body, headers = {} } = {}) => api.handle(new Request(`${origin}${path}`, {
    method, headers: { ...(method === 'POST' ? { origin, 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}),
      ...(token ? { 'privy-id-token': token } : {}), ...(desk ? { 'Cf-Access-Jwt-Assertion': desk } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const login = async (xId, overrides) => {
    const response = await request('/alpha/session', { method: 'POST', token: jwt(identity(xId, overrides)) });
    return { response, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const decide = (xId, decision) => request('/desk/api/decide', { method: 'POST', desk: deskToken(), body: { xId, decision } });
  const approved = async (xId = '123456789012345678') => {
    const session = await login(xId); assert.equal((await decide(xId, 'approve')).status, 200); return session.cookie;
  };
  const challenge = async cookie => (await request(`/alpha/claim/message?address=${wallet.address}`, { cookie })).json();
  const claim = async (cookie, challenge, patch = {}) => request('/alpha/claim', { method: 'POST', cookie,
    body: { address: wallet.address, message: challenge.message, signature: await wallet.signMessage({ message: challenge.message }), ...patch } });
  return { ...paths, cfg, request, login, decide, approved, challenge, claim, fetches: () => fetches, monitor: () => api.monitor(),
    time: value => { now = value; }, close: () => api.close(), restart: () => { api.close(); api = createAlphaApi(cfg, { now: () => now, fetch: fetchKeys }); } };
}

for (const [name, change] of Object.entries({ expired: { exp: instant / 1000 - 31 }, audience: { aud: 'wrong' }, issuer: { iss: 'wrong' }, future: { nbf: instant / 1000 + 31 }, noExpiry: { exp: undefined }, noX: { linked_accounts: '[]' }, badX: { linked_accounts: [{ type: 'twitter_oauth', subject: 'not-digits', username: 'a' }] } })) {
  test(`identity refuses ${name}`, async () => { const f = fixture(); try { assert.equal((await f.login(undefined, change)).response.status, 401); } finally { f.close(); } });
}
test('identity refuses a wrong signature, algorithm, ambiguous X and malformed tokens', async () => {
  const f = fixture(); try {
    const badKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    for (const token of [jwt(identity(), badKey), jwt(identity(), undefined, { alg: 'HS256' }), 'a.b.c', jwt(identity(undefined, { linked_accounts: [...JSON.parse(identity().linked_accounts), ...JSON.parse(identity().linked_accounts)] }))]) {
      assert.equal((await f.request('/alpha/session', { method: 'POST', token })).status, 401);
    }
  } finally { f.close(); }
});
test('status sessions, approval, removal at once, reset, cookie flags and signout', async () => {
  const f = fixture(); try {
    const { response, cookie } = await f.login();
    assert.deepEqual(await response.json(), { status: 'pending', handle: 'fixture_user', claim: null });
    assert.match(response.headers.getSetCookie()[0], /^__Host-alpha_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800$/);
    assert.equal((await f.request('/alpha/check', { cookie })).status, 401);
    assert.equal((await f.decide('123456789012345678', 'approve')).status, 200);
    assert.equal((await f.request('/alpha/check', { cookie })).status, 200);
    assert.equal((await (await f.request('/alpha/me', { cookie })).json()).status, 'approved');
    assert.equal((await f.decide('123456789012345678', 'remove')).status, 200);
    assert.equal((await f.request('/alpha/check', { cookie })).status, 401);
    assert.equal((await (await f.request('/alpha/me', { cookie })).json()).status, 'removed');
    assert.equal((await (await f.login()).response.json()).status, 'removed');
    assert.equal((await f.decide('123456789012345678', 'reset')).status, 200);
    assert.equal((await (await f.request('/alpha/me', { cookie })).json()).status, 'pending');
    const out = await f.request('/alpha/signout', { method: 'POST', cookie });
    assert.equal(out.status, 200); assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await f.request('/alpha/me', { cookie })).status, 401);
  } finally { f.close(); }
});
test('clock skew is small; sessions expire and reject tampering or duplicate cookies', async () => {
  const f = fixture(); try {
    assert.equal((await f.login(undefined, { exp: instant / 1000 - 29 })).response.status, 200);
    const cookie = await f.approved();
    for (const bad of [undefined, `${cookie}x`, `${cookie}; ${cookie}`]) assert.equal((await f.request('/alpha/check', { cookie: bad })).status, 401);
    f.time(instant + 7 * 86400000);
    assert.equal((await f.request('/alpha/check', { cookie })).status, 401);
  } finally { f.close(); }
});
test('claims require approval, exact session message and EIP-191 signer/address', async () => {
  const f = fixture(); try {
    const pending = (await f.login()).cookie;
    assert.equal((await f.request(`/alpha/claim/message?address=${wallet.address}`, { cookie: pending })).status, 403);
    const cookie = await f.approved(), c = await f.challenge(cookie);
    for (const text of ['fixture_user', '123456789012345678', wallet.address, '11155111', c.id, c.requestedAt]) assert.ok(c.message.includes(text));
    assert.equal((await f.claim(cookie, c, { message: `${c.message}\n` })).status, 400);
    assert.equal((await f.claim(cookie, c, { signature: await otherWallet.signMessage({ message: c.message }) })).status, 400);
    assert.equal((await f.claim(cookie, c, { address: otherWallet.address })).status, 400);
    assert.equal((await f.claim(cookie, c, { signature: '0x00' })).status, 400);
    const second = (await f.login()).cookie;
    assert.equal((await f.claim(second, c)).status, 400);
    await f.decide('123456789012345678', 'remove');
    assert.equal((await f.claim(cookie, c)).status, 403);
    assert.deepEqual(readdirSync(f.queueDir), []);
  } finally { f.close(); }
});
test('queue is exact, atomic, durable and immutable; receipts are owner-only', async () => {
  const f = fixture(); try {
    const cookie = await f.approved(), c = await f.challenge(cookie);
    const signature = await wallet.signMessage({ message: c.message });
    const response = await f.claim(cookie, c);
    assert.equal(response.status, 202); assert.deepEqual(await response.json(), { id: c.id, status: 'queued', position: 1 });
    const path = join(f.queueDir, `${c.id}.json`), raw = readFileSync(path, 'utf8'), mtime = statSync(path).mtimeMs;
    assert.equal(statSync(path).mode & 0o777, 0o640);
    assert.deepEqual(JSON.parse(raw), { v: 1, id: c.id, xId: '123456789012345678', privyDid: 'did:privy:fixture', address: wallet.address, message: c.message, signature, requestedAt: c.requestedAt, acceptedAt: new Date(instant).toISOString() });
    assert.match(c.id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.deepEqual(readdirSync(f.queueDir), [`${c.id}.json`]);
    assert.equal((await f.claim(cookie, c)).status, 409);
    f.restart();
    assert.equal(statSync(path).mtimeMs, mtime); assert.equal(readFileSync(path, 'utf8'), raw);
    assert.deepEqual(await (await f.request(`/alpha/claim/${c.id}`, { cookie })).json(), { id: c.id, status: 'queued', position: 1 });
    const receipt = { v: 1, id: c.id, status: 'sent', admitTx: `0x${'ab'.repeat(32)}`, sendTx: `0x${'cd'.repeat(32)}`, reason: null, at: new Date(instant).toISOString() };
    writeFileSync(join(f.receiptsDir, `${c.id}.json`), JSON.stringify(receipt));
    assert.deepEqual(await (await f.request(`/alpha/claim/${c.id}`, { cookie })).json(), receipt);
    assert.equal((await (await f.request('/alpha/me', { cookie })).json()).claim.status, 'sent');
    const stranger = await f.approved('222');
    assert.equal((await f.request(`/alpha/claim/${c.id}`, { cookie: stranger })).status, 404);
    assert.equal((await f.request('/alpha/claim/not-an-id', { cookie })).status, 404);
  } finally { f.close(); }
});
test('one claim per X and address survives races, reset and restart', async () => {
  const f = fixture(); try {
    const first = await f.approved(), c = await f.challenge(first);
    const results = await Promise.all([f.claim(first, c), f.claim(first, c)]);
    assert.deepEqual(results.map(x => x.status).sort(), [202, 409]);
    const second = await f.approved('222'), d = await f.challenge(second);
    assert.equal((await f.claim(second, d)).status, 409);
    await f.decide('123456789012345678', 'reset'); await f.decide('123456789012345678', 'approve'); f.restart();
    assert.equal((await f.request(`/alpha/claim/message?address=${otherWallet.address}`, { cookie: first })).status, 409);
    assert.equal(readdirSync(f.queueDir).length, 1);
  } finally { f.close(); }
});
test('claims refuse expired/replaced challenges and malformed receipt data', async () => {
  const f = fixture(); try {
    const cookie = await f.approved(), c = await f.challenge(cookie), newer = await f.challenge(cookie);
    assert.equal((await f.claim(cookie, c)).status, 400);
    f.time(instant + 600001); assert.equal((await f.claim(cookie, newer)).status, 400);
    const fresh = await f.challenge(cookie); assert.equal((await f.claim(cookie, fresh)).status, 202);
    writeFileSync(join(f.receiptsDir, `${fresh.id}.json`), JSON.stringify({ v: 1, id: 'wrong', status: 'sent' }));
    assert.equal((await f.request(`/alpha/claim/${fresh.id}`, { cookie })).status, 503);
  } finally { f.close(); }
});
test('desk verifies Access JWTs and logs each decision with actor and time', async () => {
  const f = fixture(); try {
    await f.login();
    const wrong = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    for (const desk of [undefined, 'a.b.c', deskToken({ exp: instant / 1000 - 31 }), deskToken({ aud: ['wrong'] }), deskToken({ iss: 'wrong' }), deskToken({}, wrong)]) {
      assert.equal((await f.request('/desk/api/signups', { desk })).status, 401);
      assert.equal((await f.request('/desk/api/decide', { method: 'POST', desk, body: { xId: '123456789012345678', decision: 'approve' } })).status, 401);
    }
    for (const decision of ['approve', 'remove', 'reset']) assert.equal((await f.decide('123456789012345678', decision)).status, 200);
    const body = await (await f.request('/desk/api/signups', { desk: deskToken() })).json();
    assert.equal(body.signups[0].xId, '123456789012345678');
    assert.deepEqual(body.decisions.map(d => d.decision), ['approve', 'remove', 'reset']);
    assert.ok(body.decisions.every(d => d.actor === 'founder-fixture' && d.at === new Date(instant).toISOString()));
    assert.equal(f.fetches(), 1);
    assert.equal((await f.decide('999', 'approve')).status, 404);
    assert.equal((await f.decide('123456789012345678', 'bogus')).status, 400);
  } finally { f.close(); }
});
test('same-origin writes, bounded bodies, no cache, method and route refusal', async () => {
  const f = fixture(); try {
    const cookie = await f.approved();
    for (const headers of [{ origin: 'https://evil.example' }, { origin: '' }, { 'content-type': 'text/plain' }]) {
      assert.equal((await f.request('/alpha/signout', { method: 'POST', cookie, headers })).status, 403);
    }
    const huge = await f.request('/alpha/claim', { method: 'POST', cookie, body: { message: 'x'.repeat(20000) } });
    assert.equal(huge.status, 413);
    const response = await f.request('/alpha/me', { cookie });
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.match(response.headers.get('content-type'), /application\/json/);
    assert.equal((await f.request('/alpha/me', { method: 'POST', cookie })).status, 405);
    assert.equal((await f.request('/unknown', { cookie })).status, 404);
  } finally { f.close(); }
});

test('API also caps accepted claims at twenty per UTC day', async () => {
  const { privateKeyToAccount } = await import('./fixtures/alpha/helpers.mjs');
  const f = fixture(); try {
    const users = [];
    for (let i = 1; i <= 21; i++) users.push({ cookie: await f.approved(String(i)), account: privateKeyToAccount(`0x${i.toString(16).padStart(64, '0')}`) });
    const submit = async ({ cookie, account }) => {
      const c = await (await f.request(`/alpha/claim/message?address=${account.address}`, { cookie })).json();
      return f.request('/alpha/claim', { method: 'POST', cookie, body: { address: account.address, message: c.message, signature: await account.signMessage({ message: c.message }) } });
    };
    for (const user of users.slice(0, 20)) assert.equal((await submit(user)).status, 202);
    assert.equal((await submit(users[20])).status, 429);
    assert.equal(readdirSync(f.queueDir).length, 20);
    f.time(instant + 86400000);
    assert.equal((await submit(users[20])).status, 202);
  } finally { f.close(); }
});

test('session accepts a token header without a JSON body; signout needs no body either', async () => {
  const f = fixture(); try {
    const response = await f.request('/alpha/session', { method: 'POST', token: jwt(identity()), headers: { 'content-type': '' } });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    assert.equal((await f.request('/alpha/signout', { method: 'POST', cookie, headers: { 'content-type': '' } })).status, 200);
  } finally { f.close(); }
});


test('API text binds sender fields exactly, including short X IDs and token boundaries', async () => {
  const f = fixture(); try {
    const cookie = await f.approved('1'), c = await f.challenge(cookie);
    assert.equal((await f.claim(cookie, c)).status, 202);
    const queued = JSON.parse(readFileSync(join(f.queueDir, `${c.id}.json`), 'utf8'));
    assert.equal(await validateClaim(queued, queued.id), null);
    assert.equal(c.message, `Square Hole alpha claim\n\nI link my X account @fixture_user (X ID 1) to wallet ${wallet.address}.\nI request starter SepETH on Sepolia (chain 11155111).\nClaim ID: ${c.id}\nTime: ${c.requestedAt}\nSite: ${origin}`);
    for (const [from, to] of [['X ID 1)', 'X ID 11)'], ['X ID 1)', 'X ID _1)'],
      [c.id, `${c.id}-extra`], [wallet.address, `${wallet.address}_extra`],
      ['chain 11155111)', 'chain 11155111_extra)'], ['Sepolia', 'Sepolia_extra'], [origin, 'https://999.0.0.1']]) {
      const message = queued.message.replace(from, to);
      const signature = await wallet.signMessage({ message });
      assert.equal(await validateClaim({ ...queued, message, signature }, queued.id), 'signed message does not name this claim', to);
    }
  } finally { f.close(); }
});

test('dry receipt allows a fresh signed live ID; live identity stays reserved through reset and restart', async () => {
  const f = fixture(), p = scratch(), { chain } = fakeChain();
  const sender = mode => createSender({ queue: f.queueDir, receipts: f.receiptsDir, state: p.state,
    chain, address: wallet.address, teth: otherWallet.address, mode, now: () => instant });
  try {
    const cookie = await f.approved(), dry = await f.challenge(cookie);
    assert.equal((await f.claim(cookie, dry)).status, 202);
    const raw = readFileSync(join(f.queueDir, `${dry.id}.json`), 'utf8');
    let worker = await sender('dry-run'); try { await worker.cycle(); } finally { worker.close(); }
    assert.equal((await (await f.request(`/alpha/claim/${dry.id}`, { cookie })).json()).status, 'skipped');
    assert.equal((await f.claim(cookie, dry)).status, 409);
    f.restart();
    const live = await f.challenge(cookie);
    assert.ok(live.id, JSON.stringify(live)); assert.notEqual(live.id, dry.id);
    assert.equal((await f.claim(cookie, dry)).status, 400);
    const results = await Promise.all([f.claim(cookie, live), f.claim(cookie, live)]);
    assert.deepEqual(results.map(r => r.status).sort(), [202, 409]);
    worker = await sender('live'); try { await worker.cycle(); } finally { worker.close(); }
    assert.equal((await (await f.request(`/alpha/claim/${live.id}`, { cookie })).json()).status, 'sent');
    assert.equal(readFileSync(join(f.queueDir, `${dry.id}.json`), 'utf8'), raw);
    assert.equal(chain.sent.length, 1);
    await f.decide('123456789012345678', 'reset'); await f.decide('123456789012345678', 'approve'); f.restart();
    assert.equal((await f.request(`/alpha/claim/message?address=${wallet.address}`, { cookie })).status, 409);
    const second = await f.approved('222'), c = await f.challenge(second);
    assert.equal((await f.claim(second, c)).status, 409);
    assert.equal((await (await f.request(`/alpha/claim/${dry.id}`, { cookie })).json()).status, 'skipped');
    assert.equal((await (await f.request('/alpha/me', { cookie })).json()).claim.id, live.id);
  } finally { f.close(); }
});

test('two dry-run claims in a row from one X account both end skipped; the live claim after them is sent', async () => {
  const f = fixture(), p = scratch(), { chain } = fakeChain();
  const sender = mode => createSender({ queue: f.queueDir, receipts: f.receiptsDir, state: p.state,
    chain, address: wallet.address, teth: otherWallet.address, mode, now: () => instant });
  const run = async (mode, cookie) => {
    const c = await f.challenge(cookie);
    assert.equal((await f.claim(cookie, c)).status, 202);
    const worker = await sender(mode); try { await worker.cycle(); } finally { worker.close(); }
    return { id: c.id, receipt: await (await f.request(`/alpha/claim/${c.id}`, { cookie })).json() };
  };
  try {
    const cookie = await f.approved(), ids = new Set();
    // Live 2026-11-01: the second dry-run claim was refused "X account already claimed", final in alpha-api.
    for (let round = 0; round < 2; round++) {
      const { id, receipt } = await run('dry-run', cookie); ids.add(id);
      assert.deepEqual(receipt, { v: 1, id, status: 'skipped', admitTx: null, sendTx: null,
        reason: 'dry run; no transactions', at: new Date(instant).toISOString() });
    }
    assert.equal(ids.size, 2);
    assert.equal((await run('live', cookie)).receipt.status, 'sent');
    assert.equal(chain.sent.length, 1);
  } finally { f.close(); }
});

// What /alpha/me reports after an operator released a claim refused in dry-run (docs/runbooks/alpha-sender.md).
const meClaim = async (f, cookie) => (await (await f.request('/alpha/me', { cookie })).json()).claim;
const writeReceipt = (f, id, patch) => {
  const r = { v: 1, id, status: 'refused', admitTx: null, sendTx: null, reason: 'X account already claimed', at: new Date(instant).toISOString(), ...patch };
  writeFileSync(join(f.receiptsDir, `${id}.json`), JSON.stringify(r)); return r;
};
const reservedOf = async (f, id) => {
  const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(f.dbPath);
  try { return db.prepare('SELECT reserved FROM claims WHERE id = ?').get(id).reserved; } finally { db.close(); }
};

test('a reserved refused claim is still reported, and no fresh claim is offered', async () => {
  const f = fixture(); try {
    const cookie = await f.approved(), c = await f.challenge(cookie);
    assert.equal((await f.claim(cookie, c)).status, 202);
    const refused = writeReceipt(f, c.id);
    assert.deepEqual(await meClaim(f, cookie), refused);
    assert.equal((await f.request(`/alpha/claim/message?address=${wallet.address}`, { cookie })).status, 409);
    assert.equal(await reservedOf(f, c.id), 1);
  } finally { f.close(); }
});

test('an unreserved refused claim (an operator\'s release) reports no claim; a fresh claim is then accepted', async () => {
  const f = fixture(); try {
    const cookie = await f.approved(), c = await f.challenge(cookie);
    assert.equal((await f.claim(cookie, c)).status, 202);
    const refused = writeReceipt(f, c.id);
    const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(f.dbPath);
    try { assert.equal(db.prepare('UPDATE claims SET reserved = 0 WHERE id = ? AND reserved = 1').run(c.id).changes, 1); } finally { db.close(); }
    assert.equal(await meClaim(f, cookie), null);
    // The old claim's URL keeps its receipt; the card's fresh claim goes through and is the one reported.
    assert.deepEqual(await (await f.request(`/alpha/claim/${c.id}`, { cookie })).json(), refused);
    const fresh = await f.challenge(cookie);
    assert.notEqual(fresh.id, c.id); assert.equal((await f.claim(cookie, fresh)).status, 202);
    assert.deepEqual(await meClaim(f, cookie), { id: fresh.id, status: 'queued', position: 1 });
  } finally { f.close(); }
});

test('an unreserved dry-run skip is still reported as before', async () => {
  const f = fixture(); try {
    const cookie = await f.approved(), c = await f.challenge(cookie);
    assert.equal((await f.claim(cookie, c)).status, 202);
    const skipped = writeReceipt(f, c.id, { status: 'skipped', reason: 'dry run; no transactions' });
    assert.equal((await f.request(`/alpha/claim/message?address=${wallet.address}`, { cookie })).status, 200);
    assert.equal(await reservedOf(f, c.id), 0);
    assert.deepEqual(await meClaim(f, cookie), skipped);
  } finally { f.close(); }
});

for (const reason of ['address needs too much gas for the starter', 'address cannot receive the starter']) {
  test(`a refusal about the address ("${reason}") is released: no claim reported, a fresh claim accepted`, async () => {
    const f = fixture(); try {
      const cookie = await f.approved(), c = await f.challenge(cookie);
      assert.equal((await f.claim(cookie, c)).status, 202);
      const refused = writeReceipt(f, c.id, { reason });
      assert.equal(await meClaim(f, cookie), null);
      const fresh = await f.challenge(cookie);
      assert.notEqual(fresh.id, c.id); assert.equal(await reservedOf(f, c.id), 0);
      assert.equal((await f.claim(cookie, fresh)).status, 202);
      assert.deepEqual(await meClaim(f, cookie), { id: fresh.id, status: 'queued', position: 1 });
      assert.deepEqual(await (await f.request(`/alpha/claim/${c.id}`, { cookie })).json(), refused);
    } finally { f.close(); }
  });
}
for (const patch of [{ reason: 'address cannot receive the starter.' }, { status: 'failed', reason: 'address cannot receive the starter' },
  { sendTx: `0x${'cd'.repeat(32)}`, reason: 'address needs too much gas for the starter' }]) {
  test(`only the exact address refusal is released; this stays final: ${JSON.stringify(patch)}`, async () => {
    const f = fixture(); try {
      const cookie = await f.approved(), c = await f.challenge(cookie);
      assert.equal((await f.claim(cookie, c)).status, 202);
      writeReceipt(f, c.id, patch);
      assert.equal((await meClaim(f, cookie)).id, c.id);
      assert.equal((await f.request(`/alpha/claim/message?address=${wallet.address}`, { cookie })).status, 409);
      assert.equal(await reservedOf(f, c.id), 1);
    } finally { f.close(); }
  });
}

for (const patch of [{ status: 'sent' }, { status: 'failed' }, { status: 'refused' },
  { reason: 'other skip' }, { admitTx: `0x${'ab'.repeat(32)}` }, { sendTx: `0x${'cd'.repeat(32)}` }]) {
  test(`non-dry receipt never releases API uniqueness: ${JSON.stringify(patch)}`, async () => {
    const f = fixture(); try {
      const cookie = await f.approved(), c = await f.challenge(cookie);
      assert.equal((await f.claim(cookie, c)).status, 202);
      writeFileSync(join(f.receiptsDir, `${c.id}.json`), JSON.stringify({ v: 1, id: c.id, status: 'skipped',
        reason: 'dry run; no transactions', admitTx: null, sendTx: null, at: new Date(instant).toISOString(), ...patch }));
      f.restart();
      assert.equal((await f.request(`/alpha/claim/message?address=${wallet.address}`, { cookie })).status, 409);
    } finally { f.close(); }
  });
}


test('legacy API uniqueness migrates without losing accepted claims or their publication state', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const f = fixture();
  const cookie = await f.approved(), c = await f.challenge(cookie);
  assert.equal((await f.claim(cookie, c)).status, 202); f.close();
  const db = new DatabaseSync(f.dbPath);
  db.exec(`BEGIN; ALTER TABLE claims RENAME TO newer_claims;
    CREATE TABLE claims (id TEXT PRIMARY KEY, xId TEXT NOT NULL UNIQUE REFERENCES signups(xId),
      address TEXT NOT NULL UNIQUE COLLATE NOCASE, payload TEXT NOT NULL, acceptedAt TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0);
    INSERT INTO claims SELECT id,xId,address,payload,acceptedAt,published FROM newer_claims;
    DROP TABLE newer_claims; COMMIT;`);
  db.close();
  const api = createAlphaApi(f.cfg, { now: () => instant });
  try {
    const response = await api.handle(new Request(`${origin}/alpha/claim/${c.id}`, { headers: { cookie } }));
    assert.deepEqual(await response.json(), { id: c.id, status: 'queued', position: 1 });
    const migrated = new DatabaseSync(f.dbPath);
    try { assert.equal(migrated.prepare('SELECT reserved FROM claims WHERE id = ?').get(c.id).reserved, 1); }
    finally { migrated.close(); }
    assert.equal((await api.handle(new Request(`${origin}/alpha/claim/message?address=${wallet.address}`, { headers: { cookie } }))).status, 409);
  } finally { api.close(); }
});


for (const xId of ['0', '001', '1'.repeat(21)]) {
  test(`API rejects a noncanonical queue X ID: ${xId}`, async () => {
    const f = fixture(); try { assert.equal((await f.login(xId)).response.status, 401); } finally { f.close(); }
  });
}


test('SH-198: intake is private, cap is transactional, existing sign-ins survive closure and removed accounts cannot exceed cap on reset', async () => {
  const f = fixture({ signupCap: 2 });
  try {
    const publicState = () => f.request('/alpha/intake');
    assert.deepEqual(await (await publicState()).json(), { open: true, returning: false });
    await f.login('1'); await f.decide('1', 'approve');
    const results = await Promise.all(['2', '3'].map(x => f.login(x)));
    assert.deepEqual(results.map(r => r.response.status).sort(), [200, 429]);
    const closed = await publicState();
    assert.equal(closed.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await closed.json(), { open: false, returning: false });
    assert.equal((await f.login('1')).response.status, 200);
    assert.equal((await f.decide('1', 'remove')).status, 200);
    assert.equal((await f.login('4')).response.status, 200);
    assert.equal((await f.decide('1', 'reset')).status, 429);
    assert.equal((await f.decide('1', 'approve')).status, 429);
    f.cfg.signupsClosed = true; f.restart();
    assert.equal((await f.login('1')).response.status, 200);
    assert.equal((await f.login('5')).response.status, 429);
    const desk = await (await f.request('/desk/api/signups', { desk: deskToken() })).json();
    assert.deepEqual(desk.load, { pending: 2, approved: 0, cap: 2, claimsWaiting: 0, senderFloat: 'unknown' });
    assert.equal((await f.request('/desk/api/signups')).status, 401);
    assert.deepEqual(await (await f.request('/alpha/health')).json(), { ok: true });
  } finally { f.close(); }
});

test('SH-198: queue position, sending and health counts contain no identity; receipt wins', async () => {
  const f = fixture();
  try {
    const cookie = await f.approved(), c = await f.challenge(cookie);
    const queued = await (await f.claim(cookie, c)).json();
    assert.deepEqual(queued, { id: c.id, status: 'queued', position: 1 });
    assert.deepEqual(await (await f.request(`/alpha/claim/${c.id}`, { cookie })).json(), queued);
    const progress = { v: 1, id: c.id, status: 'sending', admitTx: null, sendTx: null, reason: null, at: new Date(instant).toISOString(), floatPausedMs: 0 };
    writeFileSync(join(f.receiptsDir, `${c.id}.progress.json`), JSON.stringify(progress));
    assert.equal((await (await f.request('/alpha/me', { cookie })).json()).claim.status, 'sending');
    const snapshot = f.monitor();
    assert.equal(snapshot.claimsWaiting, 1); assert.equal(snapshot.cap, 100);
    assert.equal(JSON.stringify(snapshot).includes(c.id), false);
    assert.equal(JSON.stringify(snapshot).includes('fixture_user'), false);
    writeFileSync(join(f.receiptsDir, `${c.id}.json`), JSON.stringify({ ...progress, floatPausedMs: undefined, status: 'failed' }));
    assert.equal(f.monitor().recentFailures, 1); assert.equal(f.monitor().claimsWaiting, 0);
  } finally { f.close(); }
});


test('SH-198: returning cookie survives signout but grants no session, cannot be forged, expires and cannot bypass the signup cap', async () => {
  const f = fixture({ signupCap: 1 });
  try {
    const login = await f.login('1');
    const marker = login.response.headers.getSetCookie()[1].split(';')[0];
    assert.match(marker, /^__Host-alpha_returning=/);
    await f.request('/alpha/signout', { method: 'POST', cookie: login.cookie });
    assert.deepEqual(await (await f.request('/alpha/intake', { cookie: marker })).json(), { open: false, returning: true });
    assert.equal((await f.request('/alpha/me', { cookie: marker })).status, 401);
    assert.deepEqual(await (await f.request('/alpha/intake', { cookie: marker + 'x' })).json(), { open: false, returning: false });
    assert.equal((await f.request('/alpha/session', { method: 'POST', cookie: marker, token: jwt(identity('2')) })).status, 429);
    f.time(instant + 30 * 86400000);
    assert.deepEqual(await (await f.request('/alpha/intake', { cookie: marker })).json(), { open: false, returning: false });
  } finally { f.close(); }
});

test('SH-198: completed float pauses are excluded from old queue age across restart', async () => {
  const { writeProgress } = await import('../services/alpha/sender/progress.mjs');
  const f = fixture();
  try {
    const cookie = await f.approved(), c = await f.challenge(cookie); await f.claim(cookie, c);
    writeProgress(f.receiptsDir, c.id, 'waiting', instant + 60000);
    f.time(instant + 7200000); f.restart();
    assert.equal(f.monitor().oldestActiveWaitSeconds, 0);
    writeProgress(f.receiptsDir, c.id, 'queued', instant + 7200000);
    assert.equal(f.monitor().oldestActiveWaitSeconds, 60);
    f.time(instant + 9000000);
    assert.equal(f.monitor().oldestActiveWaitSeconds, 1860);
    writeProgress(f.receiptsDir, c.id, 'sending', instant + 9000000);
    assert.equal(f.monitor().oldestActiveWaitSeconds, 1860);
  } finally { f.close(); }
});


test('SH-198: manual closure works below the cap and float state fails closed when stale', async () => {
  const f = fixture({ signupsClosed: true });
  try {
    assert.equal((await f.login('1')).response.status, 429);
    assert.deepEqual(await (await f.request('/alpha/intake')).json(), { open: false, returning: false });
    const path = join(f.receiptsDir, 'sender-status.json');
    writeFileSync(path, JSON.stringify({ v: 1, at: instant, lowFloat: true }));
    assert.equal(f.monitor().senderFloat, 'low');
    writeFileSync(path, JSON.stringify({ v: 1, at: instant, lowFloat: false }));
    assert.equal(f.monitor().senderFloat, 'ready');
    f.time(instant + 300001); assert.equal(f.monitor().senderFloat, 'unknown');
  } finally { f.close(); }
});

test('SH-198: queue positions follow acceptance and advance after a final receipt, without leaking another claim', async () => {
  const f = fixture();
  try {
    const first = await f.approved('1'), c = await f.challenge(first); await f.claim(first, c);
    f.time(instant + 1000);
    const second = await f.approved('2');
    const other = await (await f.request(`/alpha/claim/message?address=${otherWallet.address}`, { cookie: second })).json();
    const result = await f.request('/alpha/claim', { method: 'POST', cookie: second, body: { address: otherWallet.address,
      message: other.message, signature: await otherWallet.signMessage({ message: other.message }) } });
    assert.deepEqual(await result.json(), { id: other.id, status: 'queued', position: 2 });
    writeFileSync(join(f.receiptsDir, `${c.id}.json`), JSON.stringify({ v: 1, id: c.id, status: 'failed', reason: null,
      admitTx: null, sendTx: null, at: new Date(instant).toISOString() }));
    assert.deepEqual(await (await f.request(`/alpha/claim/${other.id}`, { cookie: second })).json(), { id: other.id, status: 'queued', position: 1 });
    f.time(instant + 3600001); assert.equal(f.monitor().recentFailures, 0);
  } finally { f.close(); }
});
