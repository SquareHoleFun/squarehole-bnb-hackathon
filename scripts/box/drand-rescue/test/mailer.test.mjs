import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../main.mjs';
import { fixture, ticket1 } from './model.mjs';

const args = m => [...m.args, '--mailer-env', 'MAIL_URL,MAIL_TOKEN'];
test('#10: only 202 delivers; mail failure logs only status and never changes sends or exit codes', async () => {
  for (const status of [202, 200, 400, 401, 413, 429, 502]) {
    for (const failed of [false, true]) {
      const m = fixture({ mailStatus: status });
      if (failed) m.code = '0x';
      assert.equal(await main(args(m), m.io), failed ? 1 : 0);
      assert.equal(m.sent.length, failed ? 0 : 2);
      assert.equal(m.mail.length, 1);
      const { url, init } = m.mail[0];
      assert.equal(url, `${m.env.MAIL_URL}/alert`);
      assert.equal(init.method, 'POST');
      assert.deepEqual(init.headers, { 'content-type': 'application/json', authorization: `Bearer ${m.env.MAIL_TOKEN}` });
      assert.equal(init.redirect, 'error');
      const body = JSON.parse(init.body);
      assert.deepEqual(Object.keys(body).sort(), ['level', 'source', 'subject', 'text']);
      assert.equal(body.source, 'rescue');
      assert.equal(body.level, failed ? 'ALERT' : 'INFO');
      assert.ok(body.subject.length > 0 && body.subject.length <= 120);
      assert.ok(body.text.length > 0 && body.text.length <= 6000);
      assert.ok(Buffer.byteLength(init.body) <= 8192);
      if (status === 202) assert.doesNotMatch(m.err, /mailer/);
      else assert.ok(m.err.endsWith(`mailer delivery failed status=${status}\n`));
      m.safe();
    }
  }
});
test('#10: mail times out at ten seconds, aborts, never retries and keeps a successful run successful', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const m = fixture();
  m.mailer = (_url, init) => new Promise(() => {
    assert.equal(init.signal.aborted, false);
    queueMicrotask(() => t.mock.timers.tick(10000));
  });
  assert.equal(await main(args(m), m.io), 0);
  assert.equal(m.mail.length, 1);
  assert.equal(m.mail[0].init.signal.aborted, true);
  assert.deepEqual(m.sent.map(s => s.functionName), ['postRound', 'acceptGraduationWord']);
  assert.equal(m.err, 'mailer delivery failed timeout\n');
  m.safe();
});
test('#10: malformed mailer configuration never sends credentials or changes transaction work', async () => {
  for (const url of ['http://mailer.invalid', 'https://user:pass@mailer.invalid', 'not a URL']) {
    const m = fixture();
    m.env.MAIL_URL = url;
    assert.equal(await main(args(m), m.io), 0);
    assert.equal(m.sent.length, 2);
    assert.equal(m.mail.length, 0);
    assert.equal(m.err, 'mailer configuration unavailable\n');
    m.safe();
  }
});
test('#10: email carries bounded UTF-8 JSON even with many notices', async () => {
  const m = fixture();
  m.tickets.get(ticket1).state.terminalAt = 1n;
  const argv = args(m);
  for (let i = 2n; i <= 100n; i++) {
    const address = `0x${i.toString(16).padStart(40, '0')}`;
    m.tickets.set(address, m.tickets.get(ticket1));
    argv.push('--tickets', address);
  }
  assert.equal(await main(argv, m.io), 1);
  const body = JSON.parse(m.mail[0].init.body);
  assert.ok(body.text.length <= 6000);
  assert.ok(Buffer.byteLength(m.mail[0].init.body) <= 8192);
  m.safe();
});
