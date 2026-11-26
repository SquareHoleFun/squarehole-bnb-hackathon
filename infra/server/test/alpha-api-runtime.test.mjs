import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const { test } = process.env.VITEST ? await import('vitest') : await import('node:test');
import { loadConfig, readCookieKey, cookieFileAllowed, httpHandler } from '../services/alpha/server.mjs';
import { accessVerifier } from '../services/alpha/auth.mjs';
import { createAlphaApi } from '../services/alpha-api.mjs';
import { purgePlan, executePurge } from '../services/alpha/purge.mjs';
import { publicKey, directories, origin, issuer, instant, jwk, deskToken, jwt, identity, wallet } from './fixtures/alpha/helpers.mjs';
const composeOf = () => JSON.parse(execFileSync('ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.load_file(ARGV[0], aliases: true))', 'infra/server/compose.yaml'], { encoding: 'utf8' }));

test('runtime config is disabled by default and requires public inputs and fixed mounted key path', () => {
  assert.deepEqual(loadConfig({}), { enabled: false });
  assert.throws(() => loadConfig({ SH_ALPHA_ENABLED: 'yes' }));
  assert.throws(() => loadConfig({ SH_ALPHA_ENABLED: '1' }));
  const env = { SH_ALPHA_ENABLED: '1', SH_ALPHA_ORIGIN: origin, SH_ALPHA_PRIVY_APP_ID: 'fixture-app', SH_ALPHA_PRIVY_VERIFICATION_KEY: publicKey.replaceAll('\n', '\\n'), SH_ALPHA_COOKIE_KEY_FILE: '/run/alpha-config/cookie.key', SH_ALPHA_ACCESS_TEAM: issuer, SH_ALPHA_ACCESS_AUD: 'fixture-desk' };
  assert.equal(loadConfig(env).signupCap, 100);
  assert.equal(loadConfig(env).signupsClosed, false);
  assert.equal(loadConfig({ ...env, SH_ALPHA_SIGNUP_CAP: '50', SH_ALPHA_SIGNUPS_CLOSED: '1' }).signupCap, 50);
  assert.equal(loadConfig({ ...env, SH_ALPHA_SIGNUPS_CLOSED: '1' }).signupsClosed, true);
  for (const cap of ['0', '-1', '1.5', '1e3', '9007199254740993']) assert.throws(() => loadConfig({ ...env, SH_ALPHA_SIGNUP_CAP: cap }));
  assert.throws(() => loadConfig({ ...env, SH_ALPHA_SIGNUPS_CLOSED: 'true' }));
  assert.equal(loadConfig(env).privyPublicKey, publicKey);
  assert.equal(loadConfig(env).dbPath, '/srv/squarehole/alpha/state/alpha.sqlite');
  for (const key of ['/etc/passwd', '/run/alpha-config/../elsewhere', '/run/alpha-config/nested/cookie.key']) assert.throws(() => loadConfig({ ...env, SH_ALPHA_COOKIE_KEY_FILE: key }));
  assert.throws(() => loadConfig({ ...env, SH_ALPHA_ORIGIN: 'http://test.example.org' }));
});
test('HMAC key requires a root-only bounded regular file; no symlink or permissive modes', () => {
  assert.equal(cookieFileAllowed({ uid: 0, mode: 0o100600, size: 65, isFile: () => true }), true);
  for (const changed of [{ uid: 1000 }, { mode: 0o100640 }, { mode: 0o100644 }, { size: 4096 }, { isFile: () => false }]) assert.equal(cookieFileAllowed({ uid: 0, mode: 0o100600, size: 65, isFile: () => true, ...changed }), false);
  const f = directories(), path = join(f.root, 'fixture-cookie.key');
  writeFileSync(path, `${'07'.repeat(32)}\n`, { mode: 0o600 });
  // Fixture is owned by this test user; production ownership is checked above and by the default reader.
  assert.equal(readCookieKey(path, () => true).toString('hex'), '07'.repeat(32));
  chmodSync(path, 0o644); assert.throws(() => readCookieKey(path));
  symlinkSync(path, join(f.root, 'link')); assert.throws(() => readCookieKey(join(f.root, 'link'), () => true));
});
test('Access caches keys, refreshes a rotation, coalesces requests and fails closed after expiry', async () => {
  let now = instant, calls = 0, broken = false;
  const verify = accessVerifier({ issuer, audience: 'fixture-desk', now: () => now, fetch: async () => {
    calls++; if (broken) throw new Error('offline'); return new Response(JSON.stringify({ keys: [{ ...jwk, kid: calls === 1 ? 'fixture' : 'rotated' }] }));
  } });
  await Promise.all(Array.from({ length: 8 }, () => verify(deskToken()))); assert.equal(calls, 1);
  now += 31000; await verify(deskToken({}, undefined, { kid: 'rotated' })); assert.equal(calls, 2);
  broken = true; now += 300001;
  await assert.rejects(verify(deskToken({}, undefined, { kid: 'rotated' })));
  await assert.rejects(verify(deskToken({}, undefined, { kid: 'rotated' }))); assert.equal(calls, 3);
});
test('Access rejects oversized keys, wrong algorithm, weak or private keys, non-app tokens', async () => {
  for (const keys of [{ keys: [{ ...jwk, d: 'fake' }] }, { keys: [{ ...jwk, alg: 'HS256' }] }, { keys: [jwk, jwk] }, 'x'.repeat(65537)]) {
    const verify = accessVerifier({ issuer, audience: 'fixture-desk', now: () => instant, fetch: async () => new Response(typeof keys === 'string' ? keys : JSON.stringify(keys)) });
    await assert.rejects(verify(deskToken()));
  }
  const verify = accessVerifier({ issuer, audience: 'fixture-desk', now: () => instant, fetch: async () => new Response(JSON.stringify({ keys: [jwk] })) });
  await assert.rejects(verify(deskToken({ type: 'org' })));
  assert.throws(() => accessVerifier({ issuer: 'https://untrusted.example', audience: 'fixture' }));
});
test('committed claim is recovered after queue I/O failure without releasing uniqueness', async () => {
  const f = directories(), cfg = { ...f, origin, privyAppId: 'fixture-app', privyPublicKey: publicKey, cookieKey: Buffer.alloc(32, 7), accessIssuer: issuer, accessAudience: 'fixture-desk' };
  const deps = { now: () => instant, fetch: async () => new Response(JSON.stringify({ keys: [jwk] })) };
  let api = createAlphaApi(cfg, { ...deps, publish: () => { throw new Error('fixture disk failure'); } });
  const request = (path, method = 'GET', headers = {}, body) => api.handle(new Request(`${origin}${path}`, { method, headers: { origin, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }));
  try {
    const login = await request('/alpha/session', 'POST', { 'privy-id-token': jwt(identity()) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    await request('/desk/api/decide', 'POST', { 'Cf-Access-Jwt-Assertion': deskToken() }, { xId: '123456789012345678', decision: 'approve' });
    const c = await (await request(`/alpha/claim/message?address=${wallet.address}`, 'GET', { cookie })).json();
    const signed = { address: wallet.address, message: c.message, signature: await wallet.signMessage({ message: c.message }) };
    assert.equal((await request('/alpha/claim', 'POST', { cookie }, signed)).status, 503);
    assert.equal((await request('/alpha/claim', 'POST', { cookie }, signed)).status, 409);
    api.close(); api = createAlphaApi(cfg, deps);
    assert.equal(JSON.parse(readFileSync(join(f.queueDir, `${c.id}.json`))).id, c.id);
    assert.equal((await request(`/alpha/claim/${c.id}`, 'GET', { cookie })).status, 200);
  } finally { api.close(); }
});
test('purge requires thirty days, enumerates only alpha records, refuses symlinks and defaults to a plan', () => {
  const f = directories();
  writeFileSync(join(f.root, 'state/alpha.sqlite'), 'fixture database');
  writeFileSync(join(f.queueDir, '12345678-1234-4123-8123-123456789012.json'), 'fixture claim');
  const endedAt = '2026-09-29T12:00:00.000Z';
  assert.throws(() => purgePlan(f.root, endedAt, instant - 1));
  assert.throws(() => purgePlan(f.root, 'nonsense', instant));
  const plan = purgePlan(f.root, endedAt, instant); assert.equal(plan.files.length, 2);
  const erased = []; executePurge(plan, { uid: 0, stopped: true, now: instant, erase: path => erased.push(path) }); assert.equal(erased.length, 2);
  assert.throws(() => executePurge(plan, { uid: 1000, stopped: true, erase: () => assert.fail() }));
  assert.throws(() => executePurge(plan, { uid: 0, stopped: false, erase: () => assert.fail() }));
  symlinkSync(f.queueDir, join(f.root, 'state/link')); assert.throws(() => purgePlan(f.root, endedAt, instant));
  const other = directories(); mkdirSync(join(other.root, 'state/unknown')); assert.throws(() => purgePlan(other.root, endedAt, instant));
});
test('compose isolates alpha-api immediately after cards; install grants queue write and receipt read', () => {
  const compose = composeOf(), service = compose.services['alpha-api'];
  assert.ok(service); const names = Object.keys(compose.services); assert.equal(names[names.indexOf('cards') + 1], 'alpha-api');
  assert.equal(service.ports, undefined); assert.deepEqual(service.networks, ['alpha']); assert.equal(service.read_only, true);
  const mounts = service.volumes; assert.ok(mounts.every(m => !/keeper|sender|db\.env/.test(m.source)));
  assert.equal(mounts.find(m => m.source.endsWith('/queue')).read_only, false);
  assert.equal(mounts.find(m => m.source.endsWith('/receipts')).read_only, true);
  assert.deepEqual(service.cap_drop, ['ALL']); assert.deepEqual(service.cap_add, ['SETUID', 'SETGID']);
  assert.ok(compose.services.caddy.networks.includes('alpha')); assert.ok(!compose.services.postgres.networks.includes('alpha'));
  const install = readFileSync('infra/server/install.sh', 'utf8');
  assert.match(install, /setfacl -m u:2101:rwx/); assert.doesNotMatch(install, /u:2102:rwx/); // Root sender owns receipts; the API only has group read.
  assert.match(install, /install -d -m 2770 -o root -g 2101/);
});

test('HTTP adapter carries cookie headers and limits bodies without opening a listener', async () => {
  const { Readable } = await import('node:stream');
  const { httpHandler } = await import('../services/alpha/server.mjs');
  const invoke = async (incoming, api) => {
    const response = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
    await httpHandler(api, origin)(incoming, response); return response;
  };
  const incoming = Readable.from([Buffer.from('{}')]);
  Object.assign(incoming, { url: '/alpha/session', method: 'POST', headers: { 'content-length': '2' }, rawHeaders: ['Origin', origin, 'privy-id-token', 'fixture-token', 'Content-Type', 'application/json'] });
  const result = await invoke(incoming, { handle: async request => {
    assert.equal(request.url, `${origin}/alpha/session`); assert.equal(request.headers.get('privy-id-token'), 'fixture-token'); assert.equal(await request.text(), '{}');
    return new Response('{}', { headers: { 'set-cookie': 'fixture-only', 'cache-control': 'no-store' } });
  } });
  assert.equal(result.status, 200); assert.equal(result.headers['set-cookie'], 'fixture-only');
  assert.equal((await invoke({ url: '/alpha/claim', headers: { 'content-length': '20000' } }, { handle: () => assert.fail() })).status, 413);
});

test('queue crash after rename preserves the published bytes and receipt reads reject symlinks', async () => {
  const { publishClaim, receipt } = await import('../services/alpha/files.mjs');
  const f = directories(), id = '12345678-1234-4123-8123-123456789012', payload = JSON.stringify({ id, fixture: 'immutable' });
  publishClaim(f.queueDir, payload); const path = join(f.queueDir, `${id}.json`);
  const { statSync } = await import('node:fs'); const before = statSync(path).mtimeMs;
  publishClaim(f.queueDir, payload); assert.equal(statSync(path).mtimeMs, before);
  assert.throws(() => publishClaim(f.queueDir, JSON.stringify({ id, fixture: 'different' })));
  assert.equal(readFileSync(path, 'utf8'), `${payload}\n`);
  symlinkSync(path, join(f.receiptsDir, `${id}.json`)); assert.throws(() => receipt(f.receiptsDir, id));
});

test('section 6 receipts accept ISO UTC with or without fractional seconds, but reject rollover dates', async () => {
  const { receipt } = await import('../services/alpha/files.mjs');
  const f = directories(), id = '12345678-1234-4123-8123-123456789012', path = join(f.receiptsDir, `${id}.json`);
  for (const at of ['2026-10-29T12:00:00Z', '2026-10-29T12:00:00.1Z', '2026-10-29T12:00:00.123456Z']) {
    const value = { v: 1, id, status: 'refused', admitTx: null, sendTx: null, reason: 'fixture cap', at };
    writeFileSync(path, JSON.stringify(value)); assert.deepEqual(receipt(f.receiptsDir, id), value);
  }
  writeFileSync(path, JSON.stringify({ v: 1, id, status: 'sent', admitTx: null, sendTx: null, reason: null, at: '2026-02-31T12:00:00Z' }));
  assert.throws(() => receipt(f.receiptsDir, id));
});


test('SH-198 HTTP adapter preserves both session and returning Set-Cookie headers separately', async () => {
  const { Readable } = await import('node:stream');
  const incoming = Object.assign(Readable.from([]), { url: '/alpha/session', method: 'POST', headers: {}, rawHeaders: ['Origin', origin] });
  const headers = new Headers();
  headers.append('set-cookie', '__Host-alpha_session=fixture-session; Secure');
  headers.append('set-cookie', '__Host-alpha_returning=fixture-marker; Secure');
  let status, sent;
  await httpHandler({ handle: async () => new Response('{}', { headers }) }, origin)(incoming, {
    writeHead: (code, headers) => { status = code; sent = headers; }, end: () => {},
  });
  assert.equal(status, 200);
  assert.deepEqual(sent['set-cookie'], ['__Host-alpha_session=fixture-session; Secure', '__Host-alpha_returning=fixture-marker; Secure']);
});
