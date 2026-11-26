import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { fixture, ticket, ticket1, ticket2, backed, source, r0, time, v } from './model.mjs';
import { connection, snapshot } from '../chain.mjs';
import { plan } from '../plan.mjs';
import { prepare } from '../execution.mjs';
import { options } from '../options.mjs';
import { main } from '../main.mjs';

const model = overrides => fixture({ now: time(r0) + 435601n, block: 1000n, finalized: 999n,
  tickets: new Map([[ticket1, ticket({ source: backed })]]), ...overrides });
const fixing = overrides => {
  const m = model(overrides);
  m.backups.set(r0, [m.now - 7200n, 700n, 0n, v.zeroHash]);
  return m;
};
const context = async (m, extra = []) => {
  const conn = connection(m.io, m.env.RESCUE_RPC), cfg = options([...m.args, ...extra], m.env);
  const state = await snapshot(conn, m.chain, [...m.tickets.keys()], await conn.block());
  assert.deepEqual(state.notices, []);
  return { conn, cfg, state, actions: plan(state, cfg) };
};
const kinds = m => m.sent.map(s => s.functionName);
const failedRelay = () => new Response('', { status: 500 });

test('start has strict lower time, inclusive 96-second upper margin, and now drops backstop delay', async () => {
  for (const [offset, extra, count] of [[435600n, [], 0], [435601n, [], 1], [432001n, [], 0],
    [432000n, ['--now'], 0], [432001n, ['--now'], 1], [496704n, [], 1], [496705n, [], 0]]) {
    const m = model({ now: time(r0) + offset });
    const c = await context(m, extra);
    const starts = c.actions.filter(a => a.kind === 'start');
    assert.equal(starts.length, count, String(offset));
    if (!count) continue;
    const start = starts[0];
    assert.equal(start.to.toLowerCase(), backed);
    assert.equal(start.deadline, time(r0) + 496800n);
    assert.ok(c.actions.findIndex(a => a.kind === 'post') < c.actions.indexOf(start));
    const ready = await prepare(m.io, c.conn, c.cfg, source, c.state.block, start);
    assert.deepEqual(ready.action.args, [r0, m.block - 1n, m.blockData(m.block - 1n).raw]);
    assert.equal(ready.quote.urgent, true);
  }
});

test('failed post permits a start in the same run; own post prevents it; start notice names the receipt target', async () => {
  const m = model({ relay: failedRelay });
  assert.equal(await main([...m.args, '--mailer-env', 'MAIL_URL,MAIL_TOKEN'], m.io), 1, m.err);
  assert.deepEqual(kinds(m), ['startBackup']);
  const target = m.backups.get(r0)[1];
  const notice = `tickets=${ticket1} key=0 round=${r0} backup started target=${target}`;
  assert.ok(m.out.includes(notice), m.out);
  assert.ok(JSON.parse(m.mail[0].init.body).text.includes(notice));
  assert.match(m.out, /device confirmation must come within about 80 seconds/);
  assert.match(m.err, /no valid relay answer/);
  const posted = model();
  assert.equal(await main(posted.args, posted.io), 0, posted.err);
  assert.deepEqual(kinds(posted), ['postRound', 'acceptGraduationWord']);
});

test('fix waits for finality, delay, history margin and the earliest live request deadline', async () => {
  for (const [change, extra, count] of [
    [{ finalized: 699n }, ['--now'], 0], [{ finalized: 700n }, ['--now'], 1],
    [{ block: 999n }, [], 0], [{ block: 1000n }, [], 1],
    [{ block: 8883n }, ['--now'], 1], [{ block: 8884n }, ['--now'], 0],
    [{ now: time(r0) - 12n + 604800n - 96n }, ['--now'], 1],
    [{ now: time(r0) - 12n + 604800n - 95n }, ['--now'], 0],
  ]) {
    const m = fixing(change);
    const c = await context(m, extra);
    const fixes = c.actions.filter(a => a.kind === 'fix');
    assert.equal(fixes.length, count, `${JSON.stringify(change, (_, x) => typeof x === 'bigint' ? String(x) : x)}`);
    assert.equal(m.calls.filter(c => c.method === 'eth_getBlockByNumber' && c.params[0] === 'finalized').length, 1);
    if (!count) continue;
    assert.equal(fixes[0].deadline, time(r0) - 12n + 604800n);
    const ready = await prepare(m.io, c.conn, c.cfg, source, c.state.block, fixes[0]);
    assert.deepEqual(ready.action.args, [r0, m.blockData(700n).raw]);
    assert.equal(ready.quote.urgent, true);
  }
  const m = fixing();
  m.tickets.set(ticket2, ticket({ source: backed }));
  m.tickets.get(ticket2).requests.get(0n).requestedAt -= 50n;
  const c = await context(m, ['--now']);
  const fixes = c.actions.filter(a => a.kind === 'fix');
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0].deadline, time(r0) - 62n + 604800n);
  assert.equal(fixes[0].refs.length, 2);
});

test('own fix accepts immediately and announces it; other fixes keep the normal acceptance delay', async () => {
  const m = fixing();
  assert.equal(await main([...m.args, '--mailer-env', 'MAIL_URL,MAIL_TOKEN'], m.io), 0, m.err);
  assert.deepEqual(kinds(m), ['fixBackup', 'acceptGraduationWord']);
  const notice = `tickets=${ticket1} key=0 round=${r0} backup fixed`;
  assert.ok(m.out.includes(notice));
  assert.ok(JSON.parse(m.mail[0].init.body).text.includes(notice));
  const other = fixing();
  other.backups.get(r0)[2] = other.now;
  assert.equal(await main(other.args, other.io), 0);
  assert.deepEqual(kinds(other), []);
});

test('start and fix use urgent ceilings, count against run cap, and retain balance admission', async () => {
  for (const kind of ['start', 'fix']) {
    const make = overrides => kind === 'start' ? model({ relay: failedRelay, ...overrides }) : fixing(overrides);
    for (const [base, extra, sent] of [[25000000000n, [], 0], [24999999999n, [], 1],
      [25000000000n, ['--urgent-max-fee-wei', '50000000001'], 1]]) {
      const m = make({ base });
      await main([...m.args, ...extra], m.io);
      assert.equal(m.sent.filter(s => s.functionName === `${kind}Backup`).length, sent);
      assert.match(m.out, /urgent=true/);
      if (sent) assert.equal(m.sent[0].maxFeePerGas, 2n * base + 1n);
      else assert.match(m.out, /waiting on fees/);
    }
    for (const [overrides, extra, reason] of [[{}, ['--max-run-wei', '450005'], 'run spending limit reached'],
      [{ balance: 450005n }, [], 'account balance limit reached']]) {
      const m = make(overrides);
      assert.equal(await main([...m.args, ...extra], m.io), 1);
      assert.deepEqual(kinds(m), []);
      assert.ok(m.err.includes(reason), m.err);
    }
  }
  const m = fixing();
  assert.equal(await main([...m.args, '--max-run-wei', '450006'], m.io), 1);
  assert.deepEqual(kinds(m), ['fixBackup']);
  assert.match(m.err, /run spending limit reached/);
});

test('zero-balance keyless plans quote real start and fix gas and fees without a signer', async () => {
  for (const kind of ['start', 'fix']) {
    const m = (kind === 'start' ? model : fixing)({ balance: 0n, base: 1000000000n, tip: 100000000n });
    assert.equal(await main(m.args.slice(0, 4), m.io), 0, m.err);
    const line = m.out.split('\n').find(l => l.startsWith(`${kind} tickets=`));
    assert.match(line, /gas=150002 maxFee=2100000000 urgent=true totalWei=315004200000000/);
    assert.equal(m.sent.length, 0);
    for (const call of m.calls.filter(c => c.method === 'eth_estimateGas')) {
      assert.equal(call.params[0].maxFeePerGas, undefined);
    }
  }
});

test('backup receipts require the matching event, round and backed address', async () => {
  for (const kind of ['start', 'fix']) for (const mode of ['empty', 'address', 'round', 'event']) {
    const m = kind === 'start' ? model({ relay: failedRelay }) : fixing();
    m.rpcHook = (method, params) => {
      if (method !== 'eth_getTransactionReceipt') return;
      const receipt = m.receipts.get(params[0]);
      const log = { ...receipt.logs[0] };
      if (mode === 'address') log.address = source;
      if (mode === 'round') log.topics = [log.topics[0], v.toHex(r0 + 1n, { size: 32 }), ...log.topics.slice(2)];
      if (mode === 'event') log.topics = [v.zeroHash, ...log.topics.slice(1)];
      return { ...receipt, logs: mode === 'empty' ? [] : [log] };
    };
    assert.equal(await main(m.args, m.io), 1);
    assert.match(m.err, new RegExp(`Backup${kind === 'start' ? 'Started' : 'Fixed'} missing from receipt`));
    assert.equal(m.sent.length, 1);
  }
});

test('backup simulation races skip quietly; on-chain window and header failures use fixed reasons', async () => {
  const reasons = { BackupTooEarly: 'backup too early', BackupTooLate: 'backup too late',
    HeaderUnavailable: 'backup header unavailable', WrongHeader: 'backup wrong header', NoBackup: 'backup not started', BadHeader: 'backup header refused' };
  for (const failure of ['BackupAlreadyStarted', 'BackupAlreadyFixed', 'RoundAlreadyPosted', ...Object.keys(reasons)]) {
    const m = fixing();
    m.simulate = () => failure;
    assert.equal(await main(m.args, m.io), reasons[failure] ? 1 : 0, failure);
    assert.equal(m.sent.length, 0);
    assert.equal(m.err, reasons[failure] ? `fix ${reasons[failure]}\n` : '');
    m.safe();
  }
});

test('Ledger signs the same start and fix arguments through cast', async () => {
  for (const kind of ['start', 'fix']) {
    const m = kind === 'start' ? model({ relay: failedRelay }) : fixing();
    await main([...m.args.slice(0, 4), '--ledger', '--yes'], m.io);
    const tx = m.sent.find(s => s.functionName === `${kind}Backup`);
    assert.ok(tx, m.err);
    const argv = m.cast.find(c => c.args.includes(`${kind}Backup(${kind === 'start' ? 'uint256,uint256,bytes' : 'uint256,bytes'})`)).args;
    assert.deepEqual(argv, ['send', '--ledger', '--gas-limit', '150002', '--gas-price', '3', '--priority-gas-price', '1', '--json', tx.to,
      `${kind}Backup(${kind === 'start' ? 'uint256,uint256,bytes' : 'uint256,bytes'})`, ...tx.args.map(String)]);
    m.safe();
  }
});

test('confirmation refreshes the start header and an expired start window sends nothing', async () => {
  for (const expires of [false, true]) {
    const m = model({ relay: failedRelay });
    m.io.stdin = Readable.from((async function* () {
      m.block += 20n;
      if (expires) m.now = time(r0) + 496705n;
      yield 'yes\n';
    })());
    await main(m.args.slice(0, -1), m.io);
    if (expires) assert.deepEqual(kinds(m), []);
    else {
      assert.deepEqual(kinds(m), ['startBackup']);
      assert.equal(m.sent[0].args[1], 1019n);
    }
  }
});

test('a fix plan tells the operator about each graduation accept it can unlock', async () => {
  const m = fixing();
  const c = await context(m);
  assert.deepEqual(c.actions.map(a => [a.kind, a.conditional ?? false]), [['fix', false], ['accept', 'fix']]);
  await main(m.args.slice(0, 4), m.io);
  assert.match(m.out, /accept after own fix tickets=/);
});

test('backup headers use the field fallback when debug is off and suppress provider text on refusal', async () => {
  for (const kind of ['start', 'fix']) {
    const m = kind === 'start' ? model({ relay: failedRelay, rawHeaders: false }) : fixing({ rawHeaders: false });
    assert.equal(await main(m.args, m.io), kind === 'start' ? 1 : 0, m.err);
    assert.ok(kinds(m).includes(`${kind}Backup`));
    m.safe();
    const bad = kind === 'start' ? model() : fixing();
    bad.rpcHook = method => {
      if (method === 'debug_getRawHeader') return '0xc0';
    };
    await main(bad.args.slice(0, 4), bad.io);
    assert.ok(bad.err.includes(`${kind} backup header refused`), bad.err);
    assert.equal(bad.sent.length, 0);
    bad.safe();
  }
});

test('on-chain model refuses a current or nine-block-old start header and accepts eight blocks', async () => {
  const { errorName } = await import('../chain.mjs');
  const { ABI } = await import('../abi.mjs');
  for (const age of [0n, 8n, 9n]) {
    const m = model(), c = await context(m);
    const number = m.block - age;
    const simulate = c.conn.client.simulateContract({ address: backed, abi: ABI, functionName: 'startBackup',
      args: [r0, number, m.blockData(number).raw], account: source, blockNumber: m.block });
    if (age === 8n) await simulate;
    else await assert.rejects(simulate, e => errorName(e) === 'HeaderUnavailable');
  }
});

test('a lost fix receipt times out without accepting or resubmitting', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const m = fixing();
  let polling;
  const started = new Promise(resolve => { polling = resolve; });
  m.rpcHook = method => { if (method === 'eth_getTransactionReceipt') { polling(); return null; } };
  const run = main(m.args, m.io);
  await started;
  t.mock.timers.tick(180000);
  assert.equal(await run, 1);
  assert.deepEqual(kinds(m), ['fixBackup']);
  assert.match(m.err, /receipt timed out/);
});

test('started backed keys share no post or post-unlocked accept with plain tickets', async () => {
  const m = fixing({ finalized: 699n });
  m.tickets.set(ticket2, ticket());
  assert.equal(await main([...m.args, '--tickets', ticket2], m.io), 0, m.err);
  assert.deepEqual(kinds(m), ['postRound', 'acceptGraduationWord']);
  assert.equal(m.sent[1].to.toLowerCase(), ticket2);
  assert.equal(m.tickets.get(ticket1).state.wordAcceptedAt, 0n);
});
