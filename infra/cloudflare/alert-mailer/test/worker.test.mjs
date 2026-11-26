import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tokenMatches } from '../worker.mjs';
import { alert, harness, instant, messageId, request } from './helpers.mjs';

test('constant-time digest comparison handles equality, prefix, length and Unicode differences', () => {
  for (const [candidate, secret, expected] of [
    ['same', 'same', true], ['same', 'samb', false], ['same', 'xame', false],
    ['sam', 'same', false], ['same-more', 'same', false], ['é', 'é', true],
    ['é', 'aa', false], ['', '', false], ['value', undefined, false],
    [undefined, 'value', false], ['value', '', false], [null, 'value', false],
  ]) assert.equal(tokenMatches(candidate, secret), expected);
});

for (const [method, path] of [
  ['GET', '/alert'], ['HEAD', '/alert'], ['PUT', '/alert'], ['DELETE', '/alert'],
  ['OPTIONS', '/alert'], ['POST', '/'], ['POST', '/alert/'], ['POST', '/Alert'],
]) test(`${method} ${path} is 404 before auth or body parsing`, async () => {
  const h = harness();
  assert.equal((await h.fetch(new Request(`https://mailer.invalid${path}`, { method }))).status, 404);
  assert.equal(h.sent.length, 0);
});

test('202 only after send resolves, with a generated id and environment envelope', async () => {
  let complete, handed;
  const entered = new Promise(resolve => { handed = resolve; });
  const h = harness({ MAILER: { send() { handed(); return new Promise(resolve => { complete = resolve; }); } } });
  let settled = false;
  const pending = h.fetch(request()).then(response => { settled = true; return response; });
  await entered;
  assert.equal(settled, false);
  complete();
  const response = await pending;
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { id: messageId });
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const real = harness();
  await real.fetch(request());
  assert.equal(real.sent[0].from, real.env.MAIL_FROM);
  assert.equal(real.sent[0].to, real.env.MAIL_TO);
});

for (const authorization of [null, '', 'Basic monitor-test-token', 'Bearer unknown',
  'Bearer monitor-test-toke', 'Bearer monitor-test-token-extra', 'Bearer']) {
  test(`missing or invalid bearer is 401 (${authorization})`, async () => {
    const headers = { 'content-type': 'application/json' };
    if (authorization !== null) headers.authorization = authorization;
    const h = harness();
    assert.equal((await h.fetch(request(alert, { headers }))).status, 401);
    assert.equal(h.sent.length, 0);
  });
}

test('auth scheme is case insensitive and token is source-bound', async () => {
  const h = harness();
  const headers = { 'content-type': 'application/json', authorization: 'bEaReR rescue-test-token' };
  assert.equal((await h.fetch(request({ ...alert, source: 'rescue' }, { headers }))).status, 202);
  assert.equal((await h.fetch(request(alert, { headers }))).status, 401);
  assert.equal((await h.fetch(request({ ...alert, source: 'rescue' }))).status, 401);
  assert.equal(h.sent.length, 1);
});

test('missing source secrets fail closed and env token rotation takes effect immediately', async () => {
  const h = harness({ TOKEN_MONITOR: undefined, TOKEN_RESCUE: '' });
  assert.equal((await h.fetch(request())).status, 401);
  h.env.TOKEN_MONITOR = 'monitor-test-token';
  assert.equal((await h.fetch(request())).status, 202);
  h.env.TOKEN_MONITOR = 'new-test-token';
  assert.equal((await h.fetch(request())).status, 401);
  const headers = { 'content-type': 'application/json', authorization: 'Bearer new-test-token' };
  assert.equal((await h.fetch(request(alert, { headers }))).status, 202);
});

for (const body of [null, [], 1, 'text', {}, { ...alert, source: 'other' },
  { ...alert, source: 'toString' }, { ...alert, level: 'warn' }, { ...alert, level: 'DEBUG' },
  { ...alert, subject: '' }, { ...alert, subject: 1 }, { ...alert, text: '' },
  { ...alert, text: false }, { ...alert, extra: 1 }, { ...alert, subject: 'x'.repeat(121) },
  { ...alert, text: 'x'.repeat(6001) }, { ...alert, subject: 'a\rb' },
  { ...alert, subject: 'a\nb' }, { ...alert, subject: 'a\r\nBcc: injected' },
  ...Object.keys(alert).map(key => Object.fromEntries(Object.entries(alert).filter(([name]) => name !== key))),
]) test(`bad schema is 400: ${JSON.stringify(body).slice(0, 100)}`, async () => {
  const h = harness();
  assert.equal((await h.fetch(request(body))).status, 400);
  assert.equal(h.sent.length, 0);
});

for (const level of ['INFO', 'WARN', 'ALERT', 'CRITICAL', 'EMERGENCY']) {
  test(`${level} accepts inclusive string boundaries`, async () => {
    const h = harness();
    for (const [subject, text] of [['x', 'x'], ['x'.repeat(120), 'x'.repeat(6000)]]) {
      assert.equal((await h.fetch(request({ ...alert, level, subject, text }))).status, 202);
    }
  });
}

test('lengths count Unicode code points and byte limit remains independent', async () => {
  const h = harness();
  assert.equal((await h.fetch(request({ ...alert, subject: '🔥'.repeat(120) }))).status, 202);
  assert.equal((await h.fetch(request({ ...alert, subject: '🔥'.repeat(121) }))).status, 400);
  assert.equal((await h.fetch(request({ ...alert, text: '🔥'.repeat(1000) }))).status, 202);
  assert.equal((await h.fetch(request({ ...alert, text: '🔥'.repeat(2100) }))).status, 413);
});

test('malformed JSON, missing body and invalid UTF-8 return 400', async () => {
  const h = harness();
  const invalidUtf8 = Buffer.concat([
    Buffer.from(JSON.stringify({ ...alert, text: '' }).slice(0, -2)),
    Buffer.from([0xff]), Buffer.from('"}'),
  ]);
  for (const body of ['{', '', '{"source":NaN}', null,
    invalidUtf8,
  ]) assert.equal((await h.fetch(request(alert, { body }))).status, 400);
  assert.equal(h.sent.length, 0);
});

test('requires JSON content type; accepts UTF-8 parameter and case variants', async () => {
  const h = harness();
  const absent = request();
  absent.headers.delete('content-type');
  assert.equal((await h.fetch(absent)).status, 400);
  for (const type of [null, 'text/plain', 'application/jsonx', 'application/json; charset=latin1']) {
    const headers = { authorization: 'Bearer monitor-test-token' };
    if (type) headers['content-type'] = type;
    assert.equal((await h.fetch(request(alert, { headers }))).status, 400);
  }
  for (const type of ['application/json', 'Application/JSON; charset=UTF-8', 'application/json; charset="utf-8"']) {
    const headers = { authorization: 'Bearer monitor-test-token', 'content-type': type };
    assert.equal((await h.fetch(request(alert, { headers }))).status, 202);
  }
});

test('8192 actual UTF-8 bytes accepted; 8193 refused even with a lying content-length', async () => {
  const h = harness();
  const json = JSON.stringify({ ...alert, subject: 'é' });
  const body = json + ' '.repeat(8192 - Buffer.byteLength(json));
  assert.equal((await h.fetch(request(alert, { body }))).status, 202);
  const headers = { authorization: 'Bearer monitor-test-token', 'content-type': 'application/json', 'content-length': '1' };
  assert.equal((await h.fetch(request(alert, { body: body + ' ', headers }))).status, 413);
  assert.equal(h.sent.length, 1);
});

test('streaming limit cancels overflow without waiting on cancellation', async () => {
  const h = harness();
  let canceled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(8192)); controller.enqueue(new Uint8Array(1)); },
    cancel() { canceled = true; return new Promise(() => {}); },
  });
  assert.equal((await h.fetch(request(alert, { body, duplex: 'half' }))).status, 413);
  assert.equal(canceled, true);
  assert.equal(h.sent.length, 0);
});

test('chunk boundaries can split UTF-8 and input stream errors return 400', async () => {
  const h = harness();
  const bytes = Buffer.from(JSON.stringify({ ...alert, subject: 'é🔥' }));
  const body = new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } });
  assert.equal((await h.fetch(request(alert, { body, duplex: 'half' }))).status, 202);
  const broken = new ReadableStream({ start(controller) { controller.error(new Error('private stream error')); } });
  assert.equal((await h.fetch(request(alert, { body: broken, duplex: 'half' }))).status, 400);
});

for (const overrides of [
  { MAILER: undefined }, { MAILER: {} }, { EmailMessage: undefined },
  { MAIL_FROM: undefined }, { MAIL_TO: '' }, { MAIL_FROM: 'bad\r\nBcc: address' },
  { MAIL_FROM: 'sender@example.invalid\n' }, { MAIL_TO: 'receiver@example.invalid\n' },
  { MAIL_TO: 'Name <receiver@example.invalid>' }, { MAIL_FROM: 'x'.repeat(255) + '@example.invalid' },
  { EmailMessage: function EmailMessage() { throw new Error('private constructor failure'); } },
  { MAILER: { async send() { throw new Error('private binding failure'); } } },
]) test(`send/configuration failure is 502 (${Object.keys(overrides)})`, async () => {
  const response = await harness(overrides).fetch(request());
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'send failed' });
});

test('source cap allows 120, refuses 121, separates sources, resets at UTC hour', async () => {
  const h = harness();
  for (let i = 0; i < 120; i++) assert.equal((await h.fetch(request())).status, 202);
  assert.equal((await h.fetch(request())).status, 429);
  const headers = { authorization: 'Bearer rescue-test-token', 'content-type': 'application/json' };
  for (let i = 0; i < 120; i++) {
    assert.equal((await h.fetch(request({ ...alert, source: 'rescue' }, { headers }))).status, 202);
  }
  assert.equal((await h.fetch(request({ ...alert, source: 'rescue' }, { headers }))).status, 429);
  h.setTime(Date.parse('2026-10-21T12:59:59.999Z'));
  assert.equal((await h.fetch(request())).status, 429);
  h.setTime(Date.parse('2026-10-21T13:00:00.000Z'));
  assert.equal((await h.fetch(request())).status, 202);
  assert.equal(h.sent.length, 241);
  h.setTime(instant); // backwards clock cannot reset the current counter
  for (let i = 0; i < 119; i++) assert.equal((await h.fetch(request())).status, 202);
  assert.equal((await h.fetch(request())).status, 429);
});

test('concurrent sends reserve slots before await; failed sends consume their slots', async () => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const h = harness({ MAILER: { async send() { calls++; await barrier; throw new Error('send failed'); } } });
  const pending = Array.from({ length: 120 }, () => h.fetch(request()));
  assert.equal((await h.fetch(request())).status, 429);
  assert.equal(calls, 120);
  release();
  assert.ok((await Promise.all(pending)).every(response => response.status === 502));
  assert.equal((await h.fetch(request())).status, 429);
});

test('invalid requests do not spend quota; isolates have independent counters', async () => {
  const h = harness();
  for (let i = 0; i < 121; i++) assert.equal((await h.fetch(request({ ...alert, subject: '' }))).status, 400);
  for (let i = 0; i < 120; i++) assert.equal((await h.fetch(request())).status, 202);
  assert.equal((await h.fetch(request())).status, 429);
  assert.equal((await harness().fetch(request())).status, 202);
});

test('success and failures log nothing and never reflect private error details', async t => {
  const spies = ['log', 'info', 'warn', 'error', 'debug'].map(method => t.mock.method(console, method, () => {}));
  const h = harness();
  await h.fetch(request());
  h.env.MAILER.send = () => { throw new Error(`${h.env.TOKEN_MONITOR} ${h.env.MAIL_TO} ${alert.text}`); };
  const response = await h.fetch(request());
  assert.deepEqual(await response.json(), { error: 'send failed' });
  assert.ok(spies.every(spy => spy.mock.callCount() === 0));
});

test('rc8.1 review: one token configured for both sources is a configuration failure, not a forgeable source', async () => {
  // With TOKEN_MONITOR equal to TOKEN_RESCUE the bearer no longer says who sent the alert: the monitor's token
  // could send as the second poster and the reverse. The handler refuses every authenticated request with 502 and
  // sends nothing, so the deployment curl test shows the mistake; unauthenticated callers still get 401.
  const h = harness({ TOKEN_RESCUE: 'monitor-test-token' });
  for (const source of ['monitor', 'rescue']) {
    const response = await h.fetch(request({ ...alert, source }));
    assert.equal(response.status, 502, source);
    assert.deepEqual(await response.json(), { error: 'send failed' });
  }
  assert.equal(h.sent.length, 0);
  const headers = { 'content-type': 'application/json', authorization: 'Bearer unknown' };
  assert.equal((await h.fetch(request(alert, { headers }))).status, 401);
});
