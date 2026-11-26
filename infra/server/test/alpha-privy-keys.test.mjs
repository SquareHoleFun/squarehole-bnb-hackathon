import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const { test } = process.env.VITEST ? await import('vitest') : await import('node:test');
import { loadConfig } from '../services/alpha/server.mjs';
import { createAlphaApi } from '../services/alpha-api.mjs';
import { privy, publicKey, jwt, identity, origin, issuer, instant, directories } from './fixtures/alpha/helpers.mjs';

// SH-ALPHA-PRIVY-KEYS: alpha-api accepts every key Privy publishes for the app (its JWKS), not only the dashboard's.
const pair = (namedCurve = 'prime256v1') => generateKeyPairSync('ec', { namedCurve });
const pem = key => key.export({ type: 'spki', format: 'pem' });
const block = base64 => `-----BEGIN PUBLIC KEY-----\n${base64}\n-----END PUBLIC KEY-----`;
const der = key => key.export({ type: 'spki', format: 'der' });
const second = pair(), stranger = pair(), secondKey = pem(second.publicKey);
// The env file's form (compose format: raw): every PEM on one line, literal \n between its lines and between keys.
const line = (...pems) => pems.map(p => p.trim()).join('\n').replaceAll('\n', '\\n');
const env = value => ({ SH_ALPHA_ENABLED: '1', SH_ALPHA_ORIGIN: origin, SH_ALPHA_PRIVY_APP_ID: 'fixture-app',
  SH_ALPHA_PRIVY_VERIFICATION_KEY: value, SH_ALPHA_COOKIE_KEY_FILE: '/run/alpha-config/cookie.key',
  SH_ALPHA_ACCESS_TEAM: issuer, SH_ALPHA_ACCESS_AUD: 'fixture-desk' });
// The service as it starts from the env file: loadConfig, then createAlphaApi on scratch state; no network.
const configOf = (value, paths = directories()) => ({ ...loadConfig(env(value)), ...paths, cookieKey: Buffer.alloc(32, 7) });
function service(value) {
  const api = createAlphaApi(configOf(value), { now: () => instant, fetch: async () => assert.fail('no network') });
  const session = async token => {
    const response = await api.handle(new Request(`${origin}/alpha/session`, { method: 'POST', headers: { origin, 'privy-id-token': token } }));
    return { status: response.status, error: (await response.json()).error };
  };
  return { session, signIn: async token => (await session(token)).status, close: () => api.close() };
}

test('a token signed by either configured key verifies, in either order; an unknown key fails', async () => {
  for (const value of [line(publicKey, secondKey), line(secondKey, publicKey)]) {
    const s = service(value);
    try {
      assert.equal(await s.signIn(jwt(identity())), 200);
      assert.equal(await s.signIn(jwt(identity(), second.privateKey)), 200);
      assert.equal(await s.signIn(jwt(identity(), stranger.privateKey)), 401);
      // The key is not chosen by the header's kid: Privy's key names are not configured.
      assert.equal(await s.signIn(jwt(identity(), second.privateKey, { alg: 'ES256', kid: 'not-configured' })), 200);
    } finally { s.close(); }
  }
});

test('the single-key configuration works unchanged', async () => {
  // As the runtime test writes it (a final literal \n), as the env example showed it (none), and unwrapped base64.
  for (const value of [publicKey.replaceAll('\n', '\\n'), line(publicKey), line(block(der(privy.publicKey).toString('base64')))]) {
    assert.equal(loadConfig(env(value)).privyPublicKey, value.replaceAll('\\n', '\n'));
    const s = service(value);
    try {
      assert.equal(await s.signIn(jwt(identity())), 200);
      assert.equal(await s.signIn(jwt(identity(), second.privateKey)), 401);
    } finally { s.close(); }
  }
});

test('every identity check still applies whichever key signs', async () => {
  const s = service(line(publicKey, secondKey));
  try {
    // The error text shows which check refused, after the second key's signature verified.
    for (const [change, error] of [[{ aud: 'wrong' }, 'invalid identity'], [{ iss: 'wrong' }, 'invalid identity'],
      [{ exp: instant / 1000 - 31 }, 'expired identity'], [{ exp: undefined }, 'expired identity'],
      [{ nbf: instant / 1000 + 31 }, 'future identity'], [{ iat: instant / 1000 + 31 }, 'future identity'],
      [{ sub: 'not-a-did' }, 'request refused'], [{ linked_accounts: '[]' }, 'one X account required']]) {
      assert.deepEqual(await s.session(jwt(identity(undefined, change), second.privateKey)), { status: 401, error }, JSON.stringify(change));
    }
    for (const header of [{ alg: 'HS256' }, { alg: 'ES384' }, { alg: 'ES256', jku: 'https://example.org/keys' }, { alg: 'ES256', crit: ['exp'] }]) {
      assert.deepEqual(await s.session(jwt(identity(), second.privateKey, header)), { status: 401, error: 'invalid identity' }, JSON.stringify(header));
    }
    // Forgeries for each configured key: unsigned (alg none), HS256 keyed with the key's PEM text (as exported and
    // as the configured line holds it), and that HMAC under an ES256 header.
    const encoded = header => [header, identity()].map(v => Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
    const hmac = (header, secret) => `${encoded(header)}.${createHmac('sha256', secret).update(encoded(header)).digest('base64url')}`;
    for (const key of [publicKey, secondKey]) {
      const forged = [`${encoded({ alg: 'none', typ: 'JWT' })}.`,
        ...[key, key.trim()].flatMap(secret => [hmac({ alg: 'HS256', typ: 'JWT' }, secret), hmac({ alg: 'ES256' }, secret)])];
      for (const token of forged) assert.deepEqual(await s.session(token), { status: 401, error: 'invalid identity' }, token);
    }
  } finally { s.close(); }
});

test('an empty, damaged, repeated or oversized key set refuses before any state is opened', async () => {
  const [head, first, rest, tail] = publicKey.trim().split('\n');
  const refusals = {
    unset: undefined,
    empty: '',
    blank: '\\n \\n',
    'cut short': line(publicKey).slice(0, 80),
    'no end line': line(publicKey).replace('-----END PUBLIC KEY-----', ''),
    'damaged key': line([head, first.slice(0, 40), rest, tail].join('\n')),
    'second key cut short': `${line(publicKey)}\\n${line(secondKey).slice(0, 80)}`,
    'two keys in one block': line(block(Buffer.concat([der(privy.publicKey), der(second.publicKey)]).toString('base64'))),
    'text between keys': `${line(publicKey)}\\nsecond:\\n${line(secondKey)}`,
    'comma between keys': `${line(publicKey)},${line(secondKey)}`,
    'private key': line(second.privateKey.export({ type: 'pkcs8', format: 'pem' })),
    'RSA key': line(pem(generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey)),
    'P-384 key': line(pem(pair('secp384r1').publicKey)),
    'same key twice': line(publicKey, secondKey, publicKey),
    'five keys': line(publicKey, secondKey, ...[1, 2, 3].map(() => pem(pair().publicKey))),
  };
  for (const [name, value] of Object.entries(refusals)) {
    const paths = directories();
    assert.throws(() => createAlphaApi(configOf(value, paths), { now: () => instant }),
      error => error.status === 500 && error.message === 'request refused', name);
    assert.equal(existsSync(paths.dbPath), false, `${name}: refused before opening state`);
  }
  // The bound itself: four distinct keys start, and each of them verifies.
  const four = [privy, second, pair(), pair()], s = service(line(...four.map(k => pem(k.publicKey))));
  try { for (const k of four) assert.equal(await s.signIn(jwt(identity(), k.privateKey)), 200); } finally { s.close(); }
});

test('startup refuses a bad key set with details suppressed, and the probe then fails', () => {
  // The real server.mjs runtime under the health fixture's doubles, building the real Privy verifier.
  const start = value => JSON.parse(execFileSync(process.execPath, ['--experimental-vm-modules', '--no-warnings=ExperimentalWarning',
    'infra/server/test/fixtures/alpha/health-runtime.mjs', '1', '0:0', JSON.stringify(['--healthcheck', 'ready']), value], { encoding: 'utf8' }));
  const good = start(line(publicKey, secondKey));
  assert.equal(good.startup.exitCode, 0, good.startup.stderr);
  assert.equal(good.startup.listeners, 1); assert.equal(good.probe.exitCode, 0);
  for (const value of ['', line(publicKey, publicKey), `${line(publicKey)}\\n${line(secondKey).slice(0, 80)}`]) {
    const { startup, probe } = start(value);
    assert.equal(startup.exitCode, 1); assert.equal(startup.listeners, 0); assert.equal(startup.stdout, '');
    assert.equal(startup.stderr, 'alpha-api refused; check operator settings and mounted files; details suppressed\n');
    assert.equal(probe.exitCode, 1);
  }
});

// The founder helper: the app's JWKS, saved from Privy, in; the env line out.
const helper = (...args) => spawnSync(process.execPath, ['infra/server/services/alpha/privy-keys.mjs', ...args], { encoding: 'utf8' });
const saved = text => { const file = join(directories().root, 'jwks.json'); writeFileSync(file, text); return file; };
const jwkOf = (key, kid) => ({ ...key.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' });

test('the founder helper prints one env line with every JWKS key, which the service accepts', async () => {
  const two = helper(saved(JSON.stringify({ keys: [jwkOf(privy.publicKey, 'first'), { ...jwkOf(second.publicKey, 'second'), key_ops: ['verify'] }] })));
  assert.deepEqual([two.status, two.stderr, two.stdout], [0, '', `SH_ALPHA_PRIVY_VERIFICATION_KEY=${line(publicKey, secondKey)}\n`]);
  const s = service(two.stdout.slice('SH_ALPHA_PRIVY_VERIFICATION_KEY='.length, -1));
  try { for (const key of [privy.privateKey, second.privateKey]) assert.equal(await s.signIn(jwt(identity(), key)), 200); } finally { s.close(); }
  // One key without the optional members: the same line as the dashboard's single key.
  const one = helper(saved(JSON.stringify({ keys: [privy.publicKey.export({ format: 'jwk' })] })));
  assert.deepEqual([one.status, one.stdout], [0, `SH_ALPHA_PRIVY_VERIFICATION_KEY=${line(publicKey)}\n`]);
});

test('the helper refuses anything but 1 to 4 public P-256 signing keys, and then prints nothing', () => {
  const ok = jwkOf(second.publicKey, 'k'), keys = list => JSON.stringify({ keys: list });
  const cases = {
    'not JSON': 'x', null: 'null', 'no key list': '{}', 'empty list': keys([]),
    'five keys': keys([1, 2, 3, 4, 5].map(i => jwkOf(pair().publicKey, `k${i}`))),
    'private key': keys([{ ...second.privateKey.export({ format: 'jwk' }), kid: 'k' }]),
    'P-384 key': keys([pair('secp384r1').publicKey.export({ format: 'jwk' })]),
    'RSA key': keys([generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' })]),
    'other algorithm': keys([{ ...ok, alg: 'ES384' }]),
    'encryption key': keys([{ ...ok, use: 'enc' }]),
    'not on the curve': keys([{ ...ok, y: ok.x }]),
    'same key twice': keys([ok, { ...ok, kid: 'k2' }]),
    'over 64 KiB': keys([ok]) + ' '.repeat(65536),
    'sign among operations': keys([{ ...ok, key_ops: ['verify', 'sign'] }]),
    'sign only': keys([{ ...ok, key_ops: ['sign'] }]),
    'verify twice': keys([{ ...ok, key_ops: ['verify', 'verify'] }]),
    'no operations': keys([{ ...ok, key_ops: [] }]),
    'operations not a list': keys([{ ...ok, key_ops: 'verify' }]),
  };
  const refused = [1, '', 'privy keys refused: give the saved JWKS file of the Privy app; details suppressed\n'];
  for (const [name, text] of Object.entries(cases)) {
    const result = helper(saved(text));
    assert.deepEqual([result.status, result.stdout, result.stderr], refused, name);
  }
  for (const args of [[], [saved(keys([ok])), 'extra'], [directories().root]]) {
    const result = helper(...args);
    assert.deepEqual([result.status, result.stdout, result.stderr], refused, JSON.stringify(args));
  }
});
