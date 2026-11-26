import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../main.mjs';
import { connection, snapshot, pendingKeys } from '../chain.mjs';
import { fixture, read, v, abi, ticket1, ticket2, backed, r0, time, manifest } from './model.mjs';

function vector(name) {
  const text = read('packages/contracts/test/box/backup/HeaderVectors.sol');
  const raw = `0x${text.match(new RegExp(`${name} = hex"([\\da-f]+)"`))[1]}`;
  const names = ['parentHash', 'sha3Uncles', 'miner', 'stateRoot', 'transactionsRoot', 'receiptsRoot', 'logsBloom',
    'difficulty', 'number', 'gasLimit', 'gasUsed', 'timestamp', 'extraData', 'mixHash', 'nonce', 'baseFeePerGas',
    'withdrawalsRoot', 'blobGasUsed', 'excessBlobGas', 'parentBeaconBlockRoot', 'requestsHash'];
  const integers = new Set(['difficulty', 'number', 'gasLimit', 'gasUsed', 'timestamp', 'baseFeePerGas', 'blobGasUsed', 'excessBlobGas']);
  const fields = v.fromRlp(raw);
  const block = Object.fromEntries(names.map((name, i) => [name,
    integers.has(name) ? v.toHex(fields[i] === '0x' ? 0n : BigInt(fields[i])) : fields[i]]));
  return { raw, block: { ...block, hash: v.keccak256(raw) } };
}
const heartbeat = m => ['--heartbeat-hour', String(m.now / 3600n % 24n), '--mailer-env', 'MAIL_URL,MAIL_TOKEN'];
const kinds = m => m.sent.map(s => s.functionName);

test('#6: the heartbeat proves the parent header; a refusal alerts once and still posts', async () => {
  for (const [name, rawHeaders, line, code] of [
    ['SEPOLIA', false, 'backup header refused', 1],
    ['MAINNET', false, 'header fields ok', 0],
    ['SEPOLIA', true, 'header raw ok', 0],
  ]) {
    const data = vector(name);
    const m = fixture({ block: BigInt(data.block.number) + 1n, rawHeaders });
    m.blocks.set(m.block - 1n, data);
    assert.equal(await main([...m.args, ...heartbeat(m)], m.io), code);
    assert.deepEqual(kinds(m), ['postRound', 'acceptGraduationWord']);
    const text = JSON.parse(m.mail[0].init.body).text;
    assert.ok(text.startsWith(`drand-rescue alive\n${line}\n`));
    assert.equal(m.err, code ? 'backup header refused\n' : '');
    assert.equal(m.calls.filter(c => c.method === 'debug_getRawHeader').length, 1);
    for (const secret of [m.env.RESCUE_RPC, m.env.MAIL_TOKEN, m.env.RESCUE_KEY]) assert.ok(!text.includes(secret));
    m.safe();
  }
});

test('#6: the heartbeat probes before discovery even when box 0 is not deployed; other hours do not probe', async () => {
  for (const active of [false, true]) {
    const m = fixture();
    const args = ['--rpc-env', 'RESCUE_RPC', '--manifest', manifest({ status: 'awaiting-broadcast' }), ...heartbeat(m)];
    if (!active) args[args.indexOf('--heartbeat-hour') + 1] = String((m.now / 3600n + 1n) % 24n);
    assert.equal(await main(args, m.io), 0);
    assert.equal(m.calls.filter(c => c.method === 'eth_getBlockByNumber' && c.params[0] !== 'latest').length, active ? 1 : 0);
    assert.equal(m.calls.filter(c => c.method === 'debug_getRawHeader').length, active ? 1 : 0);
    const probe = m.calls.findIndex(c => c.method === 'debug_getRawHeader');
    if (active) assert.equal(probe, 3);
  }
});

function backlog() {
  const m = fixture();
  const t = m.tickets.get(ticket1);
  Object.assign(t.state, { wordAcceptedAt: 1n, drawsRequested: 1000n });
  t.phase = 3;
  for (let key = 1n; key <= 1000n; key++) t.requests.set(key, { round: r0, requestedAt: time(r0) - 12n });
  return m;
}
test('#7: a snapshot reads the oldest 64 keys and counts all 1000 pending draws', async () => {
  const m = backlog(), conn = connection(m.io, m.env.RESCUE_RPC);
  const state = await snapshot(conn, m.chain, [ticket1], await conn.block());
  const reads = m.calls.filter(c => c.method === 'eth_call').map(c => v.decodeFunctionData({ abi, data: c.params[0].data }));
  const requests = reads.filter(c => c.functionName === 'requestOf');
  const words = reads.filter(c => c.functionName === 'wordOf');
  assert.equal(requests.length + words.length, 128);
  assert.deepEqual(requests.map(c => c.args[1]), Array.from({ length: 64 }, (_, i) => BigInt(i) + 1n));
  assert.deepEqual(words.map(c => c.args[1]), requests.map(c => c.args[1]));
  assert.equal(state.tickets[0].pending, 1000n);
  assert.ok(reads.length <= 132);
});
test('#7: unread-key output appears once across re-snapshots, without a notice or failed exit', async () => {
  const m = backlog();
  assert.equal(await main([...m.args, ...heartbeat(m)], m.io), 0);
  assert.equal(m.out.split(`tickets=${ticket1} keys read 64 of 1000\n`).length - 1, 1);
  const text = JSON.parse(m.mail[0].init.body).text;
  assert.match(text, /pending=1000 /);
  assert.doesNotMatch(text, /keys read/);
  assert.equal(m.err, '');
  assert.deepEqual(kinds(m), ['postRound']);
});
test('#7: the cap matches the keeper source and always includes the queue head', () => {
  const cap = BigInt(read('packages/keeper/src/drand.ts').match(/DRAND_KEYS_PER_TICK = (\d+)n/)[1]);
  const m = backlog(), t = m.tickets.get(ticket1);
  t.state.wordAcceptedAt = 0n;
  const keys = pendingKeys(t.state);
  assert.equal(BigInt(keys.length), cap);
  assert.equal(keys[0], 0n);
  assert.equal(keys.at(-1), 63n);
});
test('#7: each consumer has its own cap; backup reads are once per distinct round and the silent head still blocks', async () => {
  const m = backlog();
  const t = m.tickets.get(ticket1);
  t.source = backed;
  m.tickets.set(ticket2, { ...t });
  for (let key = 1n; key <= 64n; key++) t.requests.get(key).round = r0 + key - 1n;
  t.requests.get(1n).requestedAt = m.now - 604801n;
  const conn = connection(m.io, m.env.RESCUE_RPC);
  const state = await snapshot(conn, m.chain, [ticket1, ticket2], await conn.block());
  assert.deepEqual(state.tickets.map(t => [t.keys.length, t.pending, t.blocked]), [[64, 1000n, true], [64, 1000n, true]]);
  const reads = m.calls.filter(c => c.method === 'eth_call').map(c => v.decodeFunctionData({ abi, data: c.params[0].data }));
  assert.equal(reads.filter(c => c.functionName === 'backupOf').length, 64);
  assert.equal(reads.filter(c => ['requestOf', 'wordOf'].includes(c.functionName)).length, 256);
});
test('#7: the report counts an unrequested graduation word as well as unread draws', async () => {
  const m = backlog();
  const t = m.tickets.get(ticket1);
  Object.assign(t.state, { wordRequestedAt: 0n, wordAcceptedAt: 0n });
  t.phase = 2;
  assert.equal(await main([...m.args.slice(0, 4), ...heartbeat(m)], m.io), 0);
  assert.match(JSON.parse(m.mail[0].init.body).text, /pending=1001 /);
  assert.equal(m.sent.length, 0);
});

function unrequested(advance) {
  const m = fixture({ now: time(r0) - 12n });
  const t = m.tickets.get(ticket1);
  t.state.wordRequestedAt = 0n;
  t.requests.clear();
  m.wall = 0n;
  m.waits = [];
  m.io.clock = () => m.wall;
  m.io.wait = async ms => {
    m.waits.push(ms);
    m.wall += ms;
    if (advance) m.now += ms / 1000n;
  };
  return m;
}
test('#8: --now waits for the requested round using block time, then requests, posts and accepts in one run', async () => {
  const m = unrequested(true);
  assert.equal(await main([...m.args, '--now'], m.io), 0, m.err);
  assert.deepEqual(kinds(m), ['requestGraduationWord', 'postRound', 'acceptGraduationWord']);
  assert.ok(m.waits.length > 0);
  assert.ok(m.wall <= 30000n);
  assert.ok(m.calls.filter(c => c.method === 'eth_getBlockByNumber' && c.params[0] === 'latest').length > 4);
});
test('#8: stalled block time stops at 30 seconds and prints when to run again, with only the request sent', async () => {
  const m = unrequested(false);
  assert.equal(await main([...m.args, '--now'], m.io), 0);
  assert.deepEqual(kinds(m), ['requestGraduationWord']);
  assert.match(m.out, /run again after 2026-09-30T10:49:24Z/);
  assert.equal(m.wall, 30000n);
  assert.equal(m.err, '');
});
test('#8 / F2: two slow initial reads share the 30-second post-receipt budget and preserve the retry exit', async () => {
  const m = unrequested(false);
  const slowReads = [];
  m.rpcHook = async (method, params) => {
    if (m.sent.length !== 1) return;
    if (method === 'eth_getBlockByNumber' && params[0] === 'latest' && slowReads.length === 0) {
      slowReads.push('block');
      m.wall += 9000n;
    } else if (method === 'eth_call' && slowReads.length === 1
      && v.decodeFunctionData({ abi, data: params[0].data }).functionName === 'requestOf') {
      slowReads.push('requestOf');
      m.wall += 9000n;
    }
  };
  assert.equal(await main([...m.args, '--now'], m.io), 0, m.err);
  assert.deepEqual(slowReads, ['block', 'requestOf']);
  assert.deepEqual(kinds(m), ['requestGraduationWord']);
  assert.match(m.out, /run again after 2026-09-30T10:49:24Z/);
  assert.equal(m.err, '');
  assert.equal(m.wall, 30000n, `total post-receipt elapsed ${m.wall}`);
  m.safe();
});
test('#8: an hourly backstop never waits after a missing request', async () => {
  const m = unrequested(true);
  assert.equal(await main(m.args, m.io), 0);
  assert.deepEqual(kinds(m), ['requestGraduationWord']);
  assert.deepEqual(m.waits, []);
});

test('#8: a slow poll cannot extend the wait beyond its remaining wall budget', async () => {
  const { waitForRound } = await import('../wait.mjs');
  const m = unrequested(false);
  let started;
  const conn = {
    block: async (settings = {}) => {
      if (started === undefined) return { now: m.now };
      const cost = 600n;
      const budget = BigInt(settings.timeout ?? 10000);
      m.wall += cost < budget ? cost : budget;
      if (cost >= budget) throw new Error('private provider timeout');
      return { now: m.now };
    },
    read: async () => { started = m.wall; return [m.now, r0]; },
  };
  await waitForRound(m.io, conn, { to: ticket1 }, { tickets: [{ address: ticket1, source: ticket1 }] });
  assert.ok(m.wall - started <= 30000n, `elapsed ${m.wall - started}`);
  assert.match(m.out, /run again after/);
});
