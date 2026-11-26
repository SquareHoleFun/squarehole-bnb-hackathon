import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { main } from '../main.mjs';
import { json } from '../http.mjs';
import { fixture, ticket, ticket1, ticket2, source, accounts, r0, time, answer, abi, v } from './model.mjs';

test('relay timeout is exactly ten seconds and streaming is bounded without Content-Length', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempted;
  const started = new Promise(resolve => { attempted = resolve; });
  const m = fixture();
  m.relay = (_url, _init, n) => {
    if (n === 1) { attempted(); return new Promise(() => {}); }
    return Response.json(answer(r0));
  };
  const run = main(m.args, m.io);
  await started;
  t.mock.timers.tick(9999);
  assert.equal(m.relays.length, 1);
  t.mock.timers.tick(1);
  assert.equal(await run, 0);
  assert.equal(m.relays.length, 2);
  m.safe();
});

test('HTTP body stalls time out; oversized chunked JSON fails before reading it all', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const io = { fetch: async () => new Response(new ReadableStream({ start() {} })) };
  const stalled = json(io, 'https://relay.invalid', {}, { limit: 8192 });
  const rejection = assert.rejects(stalled);
  t.mock.timers.tick(10000);
  await rejection;
  let chunks = 0;
  const large = { fetch: async () => new Response(new ReadableStream({
    pull(controller) { chunks++; controller.enqueue(new Uint8Array(4096)); },
  })) };
  await assert.rejects(json(large, 'https://relay.invalid', {}, { limit: 8192 }));
  assert.ok(chunks <= 4);
});

test('no receipt stops at 180 seconds and does not send the next action', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let polling;
  const started = new Promise(resolve => { polling = resolve; });
  const m = fixture();
  m.rpcHook = method => { if (method === 'eth_getTransactionReceipt') { polling(); return null; } };
  const run = main(m.args, m.io);
  await started;
  t.mock.timers.tick(180000);
  assert.equal(await run, 1);
  assert.equal(m.sent.length, 1);
  assert.match(m.err, /receipt timed out/);
  m.safe();
});

test('a confirmation delay rechecks state and stops a newly silent head', async () => {
  const m = fixture();
  m.io.stdin = Readable.from((async function* () {
    m.now = time(r0) + 604801n;
    m.block++;
    yield 'yes\n';
  })());
  assert.equal(await main(m.args.slice(0, -1), m.io), 1);
  assert.equal(m.sent.length, 0);
  assert.match(m.err, /silent/);
  m.safe();
});

test('reread before acceptance observes another operator, and source pin failures stay isolated', async () => {
  const m = fixture();
  m.rpcHook = method => {
    if (method === 'eth_getBlockByNumber' && m.sent.length) m.tickets.get(ticket1).state.wordAcceptedAt = 1n;
  };
  assert.equal(await main(m.args, m.io), 0);
  assert.equal(m.sent.length, 1);
  const isolated = fixture();
  isolated.tickets.get(ticket1).source = ticket2;
  isolated.tickets.set(ticket2, ticket());
  assert.equal(await main([...isolated.args, '--tickets', ticket2], isolated.io), 1);
  assert.equal(isolated.sent.length, 2);
  assert.equal(isolated.sent[1].to.toLowerCase(), ticket2);
  m.safe(); isolated.safe();
});

test('ties sort by round, late/zero/future words cannot be accepted; delay is configurable', async () => {
  const m = fixture({ now: time(r0) + 3601n });
  m.tickets.get(ticket1).requests.get(0n).round = r0 + 1n;
  m.tickets.set(ticket2, ticket());
  assert.equal(await main([...m.args, '--tickets', ticket2, '--backstop', '0'], m.io), 0);
  assert.deepEqual(m.sent.filter(s => s.functionName === 'postRound').map(s => s.args[0]), [r0, r0 + 1n]);
  for (const mode of ['zero', 'future', 'early']) {
    const bad = fixture();
    const q = bad.tickets.get(ticket1).requests.get(0n);
    if (mode === 'zero') q.word = v.zeroHash;
    bad.posted.set(r0, mode === 'future' ? bad.now + 1n : mode === 'early' ? q.requestedAt - 1n : time(r0));
    assert.equal(await main([...bad.args, '--now'], bad.io), 0);
    assert.equal(bad.sent.length, 0);
  }
});

test('accept immediately follows its own post before the next due round', async () => {
  const m = fixture({ now: time(r0) + 3610n });
  const second = ticket();
  second.state.wordRequestedAt = time(r0) - 11n;
  second.requests.set(0n, { round: r0 + 1n, requestedAt: second.state.wordRequestedAt });
  m.tickets.set(ticket2, second);
  assert.equal(await main([...m.args, '--tickets', ticket2], m.io), 0);
  assert.deepEqual(m.sent.map(s => s.functionName), [
    'postRound', 'acceptGraduationWord', 'postRound', 'acceptGraduationWord',
  ]);
  assert.equal(m.sent[1].to.toLowerCase(), ticket1);
  assert.equal(m.sent[3].to.toLowerCase(), ticket2);
  m.safe();
});

test('real fake cast on PATH receives exact argv and the RPC solely in its environment', async () => {
  const m = fixture();
  const dir = `${process.cwd()}/.cache/drand-rescue/cast-${randomBytes(6).toString('hex')}`;
  mkdirSync(dir, { recursive: true });
  // Generated at runtime: no key/token fixture is committed.
  writeFileSync(`${dir}/cast`, `#!${process.execPath}
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const expected = JSON.parse(readFileSync(new URL('./expected.json', import.meta.url)));
assert.deepEqual(process.argv.slice(2), expected.args);
assert.equal(process.env.ETH_RPC_URL, expected.rpc);
assert.ok(!process.argv.join(' ').includes(expected.rpc));
process.stdout.write(expected.output);
`, { mode: 0o755 });
  m.env.PATH = dir;
  m.io.spawn = (binary, args, opts) => {
    assert.equal(binary, 'cast');
    let output = accounts.privateKeyToAccount(m.env.RESCUE_KEY).address;
    if (args[0] === 'send') {
      const pos = args.findIndex(a => [source, ticket1].includes(a.toLowerCase()));
      const fn = args[pos + 1].split('(')[0];
      const values = fn === 'postRound' ? [BigInt(args[pos + 2]), args[pos + 3]] : [];
      const data = v.encodeFunctionData({ abi, functionName: fn, args: values });
      const hash = m.apply({ to: args[pos], data });
      output = JSON.stringify({ transactionHash: hash });
    }
    writeFileSync(`${dir}/expected.json`, JSON.stringify({ args, rpc: m.env.RESCUE_RPC, output }));
    return spawn(binary, args, opts);
  };
  assert.equal(await main([...m.args.slice(0, 4), '--ledger', '--yes'], m.io), 0);
  assert.equal(m.sent.length, 2);
  m.safe();
});

test('Email combines heartbeat and failure once, and includes ordinary fee waits', async () => {
  const m = fixture({ base: 4000000000n });
  const hour = (m.now / 3600n) % 24n;
  assert.equal(await main([...m.args, '--mailer-env', 'MAIL_URL,MAIL_TOKEN', '--heartbeat-hour', String(hour)], m.io), 0);
  assert.equal(m.mail.length, 1);
  const body = JSON.parse(m.mail[0].init.body);
  assert.match(body.text, /drand-rescue alive/);
  assert.match(body.text, /waitingFees=1/);
  assert.match(body.text, /pending=1/);
  m.safe();
});

// Review of rc8 part 1 (P1R-2): an hourly run that ends on "receipt timed out" leaves its transaction pending when the
// base fee rose past its 2 x base fee cap. The next run's chain read still shows the round unposted; with the
// 'pending' count it signed the next nonce, which waits behind the stuck one, and every later run stacked another:
// when fees fell they all mined, the first posted and each later copy reverted RoundKnown, paying its gas. The
// account's mined count makes the next run replace its own stuck transaction at the fresh fee instead.
test('a run replaces its own stuck transaction (mined nonce), never queues behind it', async () => {
  const m = fixture();
  const counts = [];
  m.rpcHook = (method, params) => {
    if (method !== 'eth_getTransactionCount') return undefined;
    counts.push(params[1]);
    return `0x${(params[1] === 'pending' ? m.nonce + 1n : m.nonce).toString(16)}`;
  };
  assert.equal(await main(m.args, m.io), 0, m.err);
  m.safe();
  assert.deepEqual(m.sent.map(s => [s.functionName, s.nonce]), [['postRound', 0], ['acceptGraduationWord', 1]]);
  assert.deepEqual(counts, ['latest', 'latest']);
});
