import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { main } from '../main.mjs';
import { fixture, ticket, ticket1, ticket2, r0, time, answer, manifest, v, source } from './model.mjs';

async function run(m, extra = [], args = m.args) {
  const code = await main([...args, ...extra], m.io);
  m.safe();
  return code;
}
const kinds = m => m.sent.map(s => s.functionName);

test('a: keys come from counters, never logs; accepted/all-settled and empty slots', async () => {
  const m = fixture();
  const t = m.tickets.get(ticket1);
  Object.assign(t.state, { drawsRequested: 7n, drawsSettled: 3n });
  for (const key of [4n, 5n, 6n, 7n]) t.requests.set(key, { requestedAt: time(r0) - 12n, round: r0 });
  assert.equal(await run(m, [], m.args.slice(0, 4)), 0);
  const keys = new Set(m.calls.filter(c => c.method === 'eth_call').map(c => {
    try { const d = v.decodeFunctionData({ abi: v.parseAbi(['function requestOf(address,uint256) view returns(uint64,uint64)']), data: c.params[0].data }); return String(d.args[1]); }
    catch { return null; }
  }).filter(x => x !== null));
  assert.deepEqual([...keys], ['0', '4', '5', '6', '7']);
  for (const state of [{ wordAcceptedAt: 1n }, { slots: 0n }]) {
    const n = fixture();
    Object.assign(n.tickets.get(ticket1).state, state);
    n.tickets.get(ticket1).phase = 3;
    assert.equal(await run(n), 0);
    assert.equal(n.sent.length, 0);
  }
});

test('b: graduation request at days 0, 29, 31, 45, never Drawing or terminal', async () => {
  for (const day of [0n, 29n, 31n, 45n]) {
    const m = fixture({ now: time(r0) + day * 86400n });
    const t = m.tickets.get(ticket1);
    t.gate = time(r0); t.state.wordRequestedAt = 0n;
    assert.equal(await run(m), 0);
    assert.deepEqual(kinds(m), ['requestGraduationWord']);
    assert.equal(m.sent[0].value ?? 0n, 0n);
  }
  for (const terminal of [false, true]) {
    const m = fixture();
    const t = m.tickets.get(ticket1);
    t.state.wordRequestedAt = 0n;
    if (terminal) t.state.terminalAt = 1n; else t.phase = 3;
    assert.equal(await run(m), terminal ? 1 : 0);
    assert.equal(m.sent.length, 0);
    if (terminal) assert.match(m.out + m.err, /terminal/);
  }
});

test('c: deduplicate across keys and tickets; earliest deadline orders posts', async () => {
  const m = fixture({ now: time(r0) + 3610n });
  const t = m.tickets.get(ticket1);
  t.state.wordAcceptedAt = 1n; t.phase = 3;
  t.state.drawsRequested = 3n;
  t.requests = new Map([[1n, { round: r0, requestedAt: time(r0) - 10n }],
    [2n, { round: r0 + 1n, requestedAt: time(r0) - 20n }],
    [3n, { round: r0, requestedAt: time(r0) - 10n }]]);
  m.tickets.set(ticket2, ticket());
  assert.equal(await run(m, ['--tickets', ticket2]), 0);
  assert.deepEqual(m.sent.filter(s => s.functionName === 'postRound').map(s => s.args[0]), [r0 + 1n, r0]);
});

test('d: timely posted words survive deadline; late posts are silent; silent head isolates consumer', async () => {
  const m = fixture({ now: time(r0) + 608400n });
  m.posted.set(r0, time(r0) + 604788n); // exactly requestedAt + 7 days
  assert.equal(await run(m), 0);
  assert.deepEqual(kinds(m), ['acceptGraduationWord']);
  const late = fixture({ now: time(r0) + 604801n });
  late.posted.set(r0, time(r0) + 604789n);
  assert.equal(await run(late), 1);
  assert.equal(late.sent.length, 0);
  const blocked = fixture({ now: time(r0) + 604801n });
  const t = blocked.tickets.get(ticket1);
  t.state.drawsRequested = 1n;
  t.requests.set(1n, { round: r0 + 1n, requestedAt: blocked.now - 100n });
  const other = ticket();
  other.state.wordRequestedAt = blocked.now - 100n;
  other.requests.set(0n, { round: r0 + 1n, requestedAt: blocked.now - 100n });
  blocked.tickets.set(ticket2, other);
  assert.equal(await run(blocked, ['--tickets', ticket2]), 1);
  assert.deepEqual(blocked.sent.filter(s => s.functionName === 'postRound').map(s => s.args[0]), [r0 + 1n]);
  assert.match(blocked.out + blocked.err, /silent/);
});

test('e: backstop exact boundary, --now, and acceptance after own post', async () => {
  for (const [offset, extra, expected] of [[3599n, [], []], [3600n, [], ['postRound', 'acceptGraduationWord']],
    [0n, ['--now'], ['postRound', 'acceptGraduationWord']]]) {
    const m = fixture({ now: time(r0) + offset });
    assert.equal(await run(m, extra), 0);
    assert.deepEqual(kinds(m), expected);
  }
  for (const offset of [3599n, 3600n]) {
    const m = fixture({ now: time(r0) + offset });
    m.posted.set(r0, time(r0));
    assert.equal(await run(m), 0);
    assert.deepEqual(kinds(m), offset === 3599n ? [] : ['acceptGraduationWord']);
  }
});

test('f: sequential relays, 500/timeout/wrong round then valid; headers and timeout', async () => {
  const m = fixture();
  m.relay = (_url, init, n) => {
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.accept, 'application/json');
    assert.match(init.headers['User-Agent'], /^[ -~]+$/);
    assert.ok(init.signal);
    if (n === 1) return new Response('', { status: 500 });
    if (n === 2) throw new DOMException('timed out', 'TimeoutError');
    if (n === 3) return Response.json(answer(r0 + 1n));
    return Response.json(answer(r0));
  };
  assert.equal(await run(m), 0);
  assert.deepEqual(m.relays.map(r => new URL(r.url).origin), [
    'https://api.drand.sh', 'https://api2.drand.sh', 'https://api3.drand.sh', 'https://drand.cloudflare.com',
  ]);
  assert.equal(m.sent[0].args[1].length, 194);
});

test('f: invalid pairing fails over; 404/425, bad JSON, streaming >8KiB all fail over', async () => {
  const m = fixture();
  let checked = false;
  m.simulate = fn => { if (fn === 'postRound' && !checked) { checked = true; return 'InvalidSignature'; } };
  assert.equal(await run(m), 0);
  assert.equal(m.relays.length, 2);
  const bad = fixture();
  bad.relay = (_url, _init, n) => [
    new Response('', { status: 404 }), new Response('', { status: 425 }),
    new Response('{'), new Response(' '.repeat(8193)),
  ][n - 1];
  assert.equal(await run(bad), 1);
  assert.equal(bad.relays.length, 4);
  assert.equal(bad.sent.length, 0);
});

test('g: fee boundaries, urgent override, acceptance never urgent', async () => {
  for (const [left, base, extra, sends, exit] of [
    [259140n, 4000000000n, [], 1, 0], [259200n, 4000000000n, [], 0, 0],
    [255600n, 26000000000n, [], 0, 1], [255600n, 26000000000n, ['--urgent-max-fee-wei', '60000000000'], 1, 0],
  ]) {
    const m = fixture({ now: time(r0) - 12n + 604800n - left, base });
    assert.equal(await run(m, extra), exit);
    assert.equal(m.sent.length, sends);
    if (sends) assert.equal(m.sent[0].maxFeePerGas, 2n * base + m.tip);
    assert.match(m.out, /waiting.*fee|fee.*waiting/);
  }
  const accept = fixture({ base: 4000000000n });
  accept.posted.set(r0, time(r0));
  assert.equal(await run(accept), 0);
  assert.equal(accept.sent.length, 0);
});

test('g: ceil gas padding, transaction/block cap, run cap and balance stop further sends', async () => {
  for (const [estimate, blockLimit, expected] of [[100001n, 30000000n, 150002n],
    [16000000n, 30000000n, 16777216n], [100001n, 140000n, 140000n]]) {
    const m = fixture({ gas: estimate, gasLimit: blockLimit });
    assert.equal(await run(m), 0);
    assert.equal(m.sent[0].gas, expected);
  }
  for (const mode of ['cap', 'balance']) {
    const m = fixture({ balance: mode === 'balance' ? 450006n : 10n ** 20n });
    // One padded send at maxFee 3 wei consumes all of the allowance.
    m.rpcHook = method => method === 'eth_getBalance' && m.sent.length ? '0x0' : undefined;
    assert.equal(await run(m, mode === 'cap' ? ['--max-run-wei', '450006'] : []), 1);
    assert.equal(m.sent.length, 1);
  }
});

test('h: idempotent simulation races are quiet skips', async () => {
  for (const failure of ['RoundKnown', 'WordAlreadyRequested', 'WordAlreadyAccepted']) {
    const m = fixture();
    if (failure === 'WordAlreadyRequested') m.tickets.get(ticket1).state.wordRequestedAt = 0n;
    if (failure === 'WordAlreadyAccepted') m.posted.set(r0, time(r0));
    m.simulate = () => failure;
    assert.equal(await run(m), 0);
    assert.equal(m.sent.length, 0);
  }
});

test('i: source address, runtime and chain pins refuse', async () => {
  for (const mode of ['address', 'code', 'chain']) {
    const m = fixture();
    if (mode === 'address') m.tickets.get(ticket1).source = ticket2;
    if (mode === 'code') m.code = '0x6000';
    if (mode === 'chain') m.chain = 31337n;
    assert.equal(await run(m), 1);
    assert.equal(m.sent.length, 0);
  }
});

test('manifest discovery by version field, awaiting broadcast, missing default, invalid metadata/code', async () => {
  const m = fixture();
  assert.equal(await run(m, ['--manifest', manifest()], ['--rpc-env', 'RESCUE_RPC', '--key-env', 'RESCUE_KEY', '--yes']), 0);
  assert.deepEqual(kinds(m), ['postRound', 'acceptGraduationWord']);
  // A chain whose manifest still awaits the broadcast (Sepolia's committed file is deployed since 2026-10-21).
  const pending = fixture();
  assert.equal(await run(pending, ['--manifest', manifest({ status: 'awaiting-broadcast' })], ['--rpc-env', 'RESCUE_RPC']), 0);
  assert.match(pending.out, /box 0 not deployed on chain 11155111/);
  // Sepolia's default is the committed (deployed) manifest: its registry's code is pinned against the chain, which this
  // fixture's chain does not hold, so it refuses and sends nothing.
  const committed = fixture();
  assert.equal(await run(committed, [], ['--rpc-env', 'RESCUE_RPC']), 1);
  assert.match(committed.out + committed.err, /refused code pin/);
  assert.equal(committed.sent.length, 0);
  // Mainnet's default is the committed awaiting-broadcast file 1.json (SH-188): nothing to rescue, nothing sent. (Before
  // it was committed, chain 1 had no default file and the rescue asked for --tickets.)
  const mainnet = fixture({ chain: 1n });
  assert.equal(await run(mainnet, [], ['--rpc-env', 'RESCUE_RPC']), 0);
  assert.match(mainnet.out, /box 0 not deployed on chain 1/);
  assert.equal(mainnet.sent.length, 0);
  for (const change of [{ schema: 'bad' }, { chainId: 1 }, { status: 'unknown' },
    { versions: [{ version: 1, registry: { address: source, codeHash: v.zeroHash } }] }]) {
    const bad = fixture();
    assert.equal(await run(bad, ['--manifest', manifest(change)], ['--rpc-env', 'RESCUE_RPC']), 1);
  }
});

test('j: provider throws, revert, Email 401 and real entrypoint never expose credentials', async () => {
  for (const mode of ['rpc', 'revert', 'mailer']) {
    const m = fixture();
    if (mode === 'rpc') m.rpcHook = () => { throw new Error(m.env.RESCUE_RPC + m.env.RESCUE_KEY + m.env.MAIL_TOKEN); };
    if (mode === 'revert') m.simulate = () => 'WordNotReady';
    if (mode === 'mailer') m.mailStatus = 401;
    assert.equal(await run(m, ['--mailer-env', 'MAIL_URL,MAIL_TOKEN']), mode === 'mailer' ? 0 : 1);
  }
  const m = fixture();
  const marker = m.env.MAIL_TOKEN.split(':')[1];
  const child = spawnSync(process.execPath, ['scripts/box/drand-rescue/rescue.mjs', '--rpc', `https://offline.invalid/${marker}`, '--unknown'],
    { encoding: 'utf8' });
  assert.equal(child.status, 2);
  assert.ok(!(child.stdout + child.stderr).includes(marker));
});

test('k: confirmation is exact, EOF is no, --yes bypasses, no signer only plans; bad arguments', async () => {
  for (const text of ['no\n', '', 'yes\n', ' yes\n']) {
    const m = fixture();
    m.io.stdin = Readable.from([text]);
    assert.equal(await run(m, [], m.args.slice(0, -1)), text === 'yes\n' ? 0 : 1);
    assert.equal(m.sent.length, text === 'yes\n' ? 2 : 0);
    assert.match(m.out, /yes/);
  }
  const m = fixture(); m.io.stdin = Readable.from([]);
  assert.equal(await run(m), 0);
  const dry = fixture();
  assert.equal(await run(dry, [], dry.args.slice(0, 4)), 0);
  assert.equal(dry.sent.length, 0);
  for (const field of ['tickets=', 'key=', 'round=', 'roundTime=', 'deadline=', 'left=', 'gas=', 'maxFee=', 'urgent=', 'totalWei=']) {
    assert.ok(dry.out.includes(field), field);
  }
  for (const args of [['--now', '--backstop', '3600'], ['--unknown'], ['--max-fee-wei', '-1']]) {
    const bad = fixture();
    assert.equal(await run(bad, args), 2);
    assert.match(bad.err, /usage:/);
  }
});

test('l: Ledger argv per kind, HD path, RPC environment only', async () => {
  for (const request of [false, true]) {
    const m = fixture();
    if (request) m.tickets.get(ticket1).state.wordRequestedAt = 0n;
    assert.equal(await run(m, ['--ledger', '--hd-path', "m/44'/60'/0'/0/2", '--yes'], m.args.slice(0, 4)), 0);
    assert.deepEqual(m.cast[0].args, ['wallet', 'address', '--ledger', '--hd-path', "m/44'/60'/0'/0/2"]);
    for (const call of m.cast.slice(1)) {
      const tx = m.sent[m.cast.indexOf(call) - 1];
      const signature = { postRound: 'postRound(uint256,bytes)', requestGraduationWord: 'requestGraduationWord()',
        acceptGraduationWord: 'acceptGraduationWord()' }[tx.functionName];
      assert.deepEqual(call.args, ['send', '--ledger', '--hd-path', "m/44'/60'/0'/0/2",
        '--gas-limit', '150002', '--gas-price', '3', '--priority-gas-price', '1', '--json', tx.to,
        signature, ...tx.args.map(String)]);
      assert.equal(call.opts.env.ETH_RPC_URL, m.env.RESCUE_RPC);
      assert.ok(!call.args.includes(m.env.RESCUE_RPC));
    }
  }
});

test('m: Email after send/failure; heartbeat only its UTC hour and includes waiting count', async () => {
  for (const mode of ['sent', 'failed', 'heartbeat', 'quiet']) {
    const m = fixture();
    const hour = (m.now / 3600n) % 24n;
    if (mode === 'failed') m.code = '0x';
    if (mode === 'heartbeat' || mode === 'quiet') {
      m.tickets.get(ticket1).phase = 3;
      m.tickets.get(ticket1).state.wordAcceptedAt = 1n;
    }
    const selected = mode === 'heartbeat' ? hour : (hour + 1n) % 24n;
    assert.equal(await run(m, ['--mailer-env', 'MAIL_URL,MAIL_TOKEN', '--heartbeat-hour', String(selected)]), mode === 'failed' ? 1 : 0);
    assert.equal(m.mail.length, mode === 'quiet' ? 0 : 1);
    if (m.mail.length) {
      const text = JSON.parse(m.mail[0].init.body).text;
      assert.match(text, /pending=.*nearestDeadline=.*waitingFees=/s);
      if (mode === 'heartbeat') assert.match(text, /drand-rescue alive/);
    }
  }
});

test('receipt requires success and RoundPosted, RPC error after broadcast stops the run', async () => {
  for (const options of [{ noLogs: true }, { receiptStatus: '0x0' }]) {
    const m = fixture(options);
    assert.equal(await run(m), 1);
    assert.equal(m.sent.length, 1);
  }
});
