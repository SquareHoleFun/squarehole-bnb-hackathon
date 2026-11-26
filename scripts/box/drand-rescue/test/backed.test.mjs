import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, ticket, ticket1, ticket2, source, backed, r0, time, v, abi } from './model.mjs';
import { connection, snapshot } from '../chain.mjs';
import { main } from '../main.mjs';

const model = options => fixture({ tickets: new Map([[ticket1, ticket({ source: backed })]]), ...options });
const state = async m => {
  const conn = connection(m.io, m.env.RESCUE_RPC);
  return snapshot(conn, m.chain, [...m.tickets.keys()], await conn.block());
};
const calls = (m, name) => m.calls.filter(c => c.method === 'eth_call').filter(c => v.decodeFunctionData({ abi, data: c.params[0].data }).functionName === name);

test('source rule accepts only the two pinned sources and verifies the backed DRAND and both code pins', async () => {
  for (const variant of ['good', 'plain', 'drand', 'backed-code', 'drand-code', 'other']) {
    const m = model();
    if (variant === 'plain') m.tickets.get(ticket1).source = source;
    if (variant === 'drand') m.drand = ticket2;
    if (variant === 'backed-code') m.backedCode = '0x6000';
    if (variant === 'drand-code') m.code = '0x6000';
    if (variant === 'other') m.tickets.get(ticket1).source = ticket2;
    const s = await state(m);
    if (['good', 'plain'].includes(variant)) {
      assert.equal(s.tickets.length, 1, s.notices.join('\n'));
      assert.equal(s.tickets[0].drand.toLowerCase(), source);
      for (const name of ['requestOf', 'wordOf']) assert.equal(calls(m, name)[0].params[0].to.toLowerCase(), variant === 'plain' ? source : backed);
    } else assert.deepEqual(s.notices, [`tickets=${ticket1} refused source pin`], variant);
    m.safe();
  }
});

test('posts shared by plain and backed tickets go once to DRAND and require its receipt', async () => {
  const m = model();
  m.tickets.set(ticket2, ticket());
  assert.equal(await main([...m.args, '--tickets', ticket2], m.io), 0, m.err);
  const posts = m.sent.filter(s => s.functionName === 'postRound');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].to.toLowerCase(), source);
  assert.equal(m.sent.filter(s => s.functionName === 'acceptGraduationWord').length, 2);
  const wrong = model();
  wrong.rpcHook = (method, params) => {
    if (method === 'eth_getTransactionReceipt') {
      const r = wrong.receipts.get(params[0]);
      return { ...r, logs: r.logs.map(log => ({ ...log, address: backed })) };
    }
  };
  assert.equal(await main(wrong.args, wrong.io), 1);
  assert.match(wrong.err, /RoundPosted missing from receipt/);
  assert.equal(wrong.sent.length, 1);
});

test('started rounds get no post or conditional accept and read backup once per round per snapshot', async () => {
  const m = model();
  m.backups.set(r0, [m.now - 1n, 356n, 0n, v.zeroHash]);
  const t = m.tickets.get(ticket1);
  t.state.drawsRequested = 1n;
  t.requests.set(1n, { requestedAt: time(r0), round: r0 });
  const s = await state(m);
  const { plan } = await import('../plan.mjs');
  assert.deepEqual(plan(s, { now: true, delay: 0n }), []);
  assert.equal(calls(m, 'backupOf').length, 1);
  assert.equal(s.tickets[0].keys[0].deadline, time(r0) - 12n + 604800n);
  m.now = time(r0) + 604801n;
  const silent = await state(m);
  assert.equal(silent.tickets[0].blocked, true);
  assert.match(silent.notices[0], /silent deadline=/);
});
