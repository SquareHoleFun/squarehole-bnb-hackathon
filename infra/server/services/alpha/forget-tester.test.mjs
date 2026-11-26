import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync, readdirSync, existsSync, mkdirSync, symlinkSync, linkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { forgetManifest } from './forget-maintenance.mjs';
import { run as runWrapper } from '../../../../scripts/test/fixtures/alpha-forget.mjs';
import { shLimit } from '../../../../vitest.timeouts.mjs';
import { openStore } from './store.mjs';
const { createSender } = await import(process.env.SH_FORGET_SENDER_ENGINE ?? new URL('./sender/engine.mjs', import.meta.url).href);
import { journalNonceFloor, validateJournal } from './sender/store.mjs';
const { createAlphaApi } = await import(process.env.SH_FORGET_API_MODULE ?? new URL('../alpha-api.mjs', import.meta.url).href);
import { scratch, claim, id, desk, token, fakeChain } from '../../test/fixtures/alpha-sender/helpers.mjs';
import { origin, issuer, instant, publicKey, jwk, jwt, identity, deskToken, wallet } from '../../test/fixtures/alpha/helpers.mjs';
const moduleURL = process.env.SH_FORGET_MODULE ?? new URL('./forget-tester.mjs', import.meta.url).href;
const { forgetTester, main } = await import(moduleURL);
const xId = '123456789012345678', otherId = xId + '9', handle = 'private_tester';
const tables = ['challenges', 'decisions', 'signins', 'returning_browsers', 'sessions', 'claims', 'signups'];
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, JSON.stringify(value));
const sql = (f, work) => { const db = new DatabaseSync(f.dbPath); try { return work(db); } finally { db.close(); } };
const digest = (selectedId, selectedHandle) => createHash('sha256').update(`${selectedId}\n${selectedHandle.toLowerCase()}\n`).digest('hex');
const record = opts => {
  const operation = id(99), completion = join(dirname(opts.state), 'command.restore');
  writeFileSync(completion, ['active', 'active', 'active', operation, digest(opts.xId, opts.handle)].join('\n') + '\n');
  return { ...opts, operation, completion };
};
const execute = (f, hooks) => forgetTester({ ...f.opts, execute: true }, hooks);
async function fixture() {
  const p = scratch(), apiDir = join(dirname(p.state), 'api'); mkdirSync(apiDir);
  const dbPath = join(apiDir, 'alpha.sqlite'), { chain } = fakeChain();
  const a = await claim(1, { xId, privyDid: 'did:privy:private', address: wallet.address });
  // A fixture signature from the actual wallet. Both the API and sender verify it later.
  a.signature = await wallet.signMessage({ message: a.message });
  const b = await claim(11, { xId: otherId });
  const dry = { ...a, id: id(3) };
  dry.message = a.message.replace(a.id, dry.id); dry.signature = await wallet.signMessage({ message: dry.message });
  const s = openStore(dbPath);
  for (const [c, h] of [[a, handle], [b, 'other_tester']]) {
    s.run('INSERT INTO signups VALUES(?,?,?,?,?,?,?,?)', c.xId, c.privyDid, h, `profile-${h}`, `https://private.example/${h}`, 'approved', c.requestedAt, c.requestedAt);
    s.run('INSERT INTO signins(xId,at) VALUES(?,?)', c.xId, c.requestedAt);
    s.run('INSERT INTO decisions(xId,decision,actor,at) VALUES(?,?,?,?)', c.xId, 'approve', `operator-${h}`, c.requestedAt);
    s.run('INSERT INTO sessions VALUES(?,?,?)', `session-${h}`, c.xId, instant + 86400000);
    s.run('INSERT INTO returning_browsers VALUES(?,?,?)', `returning-${h}`, c.xId, instant + 86400000);
    s.run('INSERT INTO challenges VALUES(?,?,?,?,?,?)', `session-${h}`, id(c === a ? 41 : 42), c.address, c.message, c.requestedAt, instant + 600000);
  }
  for (const c of [dry, a, b]) s.run('INSERT INTO claims VALUES(?,?,?,?,?,?,?)', c.id, c.xId, c.address, JSON.stringify(c), c.requestedAt, 1, c === dry ? 0 : 1);
  s.close();
  const start = mode => createSender({ ...p, chain, address: desk.address, teth: token, mode, now: () => instant });
  p.put(dry); let sender = await start('dry-run'); await sender.cycle(); sender.close();
  p.put(a); p.put(b); sender = await start('live'); await sender.cycle(); sender.close();
  const live = read(join(p.state, 'journal.json'));
  save(join(p.state, `journal.json.${id(80)}.pending`), live);
  writeFileSync(join(p.queue, `.${a.id}.${id(81)}.tmp`), JSON.stringify(a));
  save(join(p.receipts, `${a.id}.progress.json.${id(82)}.pending`), read(join(p.receipts, `${a.id}.progress.json`)));
  const opts = record({ ...p, dbPath, xId, handle, servicesStopped: true });
  return { ...p, dbPath, opts, a, b, dry, chain, start };
}
function wholeState(f) {
  return Object.fromEntries([f.queue, f.receipts, f.state, dirname(f.dbPath)].flatMap(dir => readdirSync(dir)
    .map(n => [join(dir, n), createHash('sha256').update(readFileSync(join(dir, n))).digest('hex')])));
}
function otherState(f) {
  return sql(f, db => ({ rows: Object.fromEntries(tables.map(t => [t, JSON.stringify(db.prepare(t === 'challenges'
    ? 'SELECT * FROM challenges WHERE sessionHash IN (SELECT hash FROM sessions WHERE xId = ?)'
    : `SELECT * FROM ${t} WHERE xId = ?`).all(otherId))])),
  files: Object.fromEntries([join(f.queue, `${f.b.id}.json`), join(f.receipts, `${f.b.id}.json`), join(f.receipts, `${f.b.id}.progress.json`)]
    .map(path => [path, readFileSync(path).toString('hex')])),
  entries: readdirSync(f.state).filter(n => /^journal.*(?:json|pending)$/.test(n)).map(n => [n,
    JSON.stringify(read(join(f.state, n)).entries.filter(e => e.id === f.b.id))]) }));
}
function forgotten(f) {
  sql(f, db => {
    for (const t of tables) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n, 1, t);
    const audits = db.prepare('SELECT * FROM forget_audit').all(); assert.equal(audits.length, 1);
    assert.deepEqual(Object.keys(audits[0]), ['operation', 'at', 'rows', 'files', 'uid', 'gid']);
    assert.match(audits[0].at, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(audits[0].rows, 8); assert.equal(audits[0].files, 7);
    for (const value of [xId, handle, f.a.address, f.a.signature, f.a.id]) assert.ok(!JSON.stringify(audits).includes(value), value);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
  const secrets = [xId, handle, f.a.address, f.a.signature, f.a.privyDid, f.a.id, f.dry.id];
  // The prefix account deliberately contains xId: its own rows and files remain and are checked separately.
  for (const dir of [f.queue, f.receipts, f.state, dirname(f.dbPath)]) for (const name of readdirSync(dir)) {
    const bytes = readFileSync(join(dir, name)).toString();
    for (const secret of secrets.filter(s => s !== xId)) assert.ok(!bytes.includes(secret), `${name} retains ${secret}`);
  }
  assert.ok(!existsSync(forgetManifest(f.receipts)));
}

test('complete deletion removes every table, all attempts and reservations, with count and date audit and other account byte equality', async () => {
  const f = await fixture(), before = otherState(f);
  const result = await execute(f); assert.equal(result.executed, true);
  assert.deepEqual(result, { rows: { challenges: 1, decisions: 1, signins: 1, returning_browsers: 1, sessions: 1, claims: 2, signups: 1 }, files: 7, journals: 3, executed: true });
  forgotten(f); assert.deepEqual(otherState(f), before);
  assert.equal(read(join(f.state, 'journal.json')).nonceFloor, 4);
  await assert.rejects(execute(f), /unknown X id/);
});

test('dry run and CLI plan print counts and a masked handle only and leave state bytes unchanged', async () => {
  const f = await fixture();
  const snapshot = () => Object.fromEntries([f.queue, f.receipts, f.state, dirname(f.dbPath)].flatMap(dir => readdirSync(dir)
    .map(n => [join(dir, n), createHash('sha256').update(readFileSync(join(dir, n))).digest('hex')])));
  const before = snapshot(), lines = [];
  const plan = await forgetTester(f.opts); assert.equal(plan.executed, false);
  await main(['--x-id', xId, '--handle', handle, '--api-db', f.dbPath, '--queue', f.queue, '--receipts', f.receipts,
    '--sender-state', f.state, '--services-stopped'], line => lines.push(line));
  assert.deepEqual(snapshot(), before);
  const text = JSON.stringify(plan) + lines.join(''); assert.equal(plan.handle, `pr***er [${digest(xId, handle).slice(0, 8)}]`);
  assert.ok(!text.includes(handle));
  for (const value of [xId, f.a.address, f.a.address.toLowerCase(), f.a.id, f.a.signature, f.a.privyDid, `profile-${handle}`]) assert.ok(!text.includes(value));
  assert.equal(plan.files, 7); assert.equal(plan.rows.claims, 2);
});

for (const [name, patch, reason] of [
  ['wrong handle', { handle: 'other_tester' }, /belong together/], ['unknown id', { xId: '9' }, /unknown X id/],
  ['missing id', { xId: undefined }, /separate canonical/], ['missing handle', { handle: undefined }, /separate canonical/],
  ['noncanonical id', { xId: '01' }, /separate canonical/], ['oversized id', { xId: '1'.repeat(21) }, /separate canonical/],
  ['services running', { servicesStopped: false }, /stop alpha-api/],
]) test(`refuses ${name} without deleting rows or files`, async () => {
  const f = await fixture(), before = otherState(f), bytes = wholeState(f);
  await assert.rejects(forgetTester({ ...record({ ...f.opts, ...patch, xId: patch.xId ?? f.opts.xId, handle: patch.handle ?? f.opts.handle }), ...patch, execute: true }), reason);
  assert.equal(sql(f, db => db.prepare('SELECT count(*) AS n FROM claims').get().n), 3);
  assert.deepEqual(otherState(f), before); assert.deepEqual(wholeState(f), bytes);
});

for (const status of ['queued', 'sending', 'waiting']) test(`refuses in-flight ${status}`, async () => {
  const f = await fixture(), final = join(f.receipts, `${f.a.id}.json`);
  renameSync(final, join(dirname(f.state), 'held-receipt'));
  save(join(f.receipts, `${f.a.id}.progress.json`), { v: 1, id: f.a.id, status, admitTx: null, sendTx: null,
    reason: status === 'waiting' ? 'insufficient float for starter and gas' : null, at: f.a.requestedAt });
  const before = wholeState(f);
  await assert.rejects(execute(f), /refill or reconcile with the sender/); assert.deepEqual(wholeState(f), before);
});

for (const [name, change, reason] of [
  ['sender lock', f => writeFileSync(join(f.state, 'sender.lock'), 'held'), /sender lock/],
  ['unknown table', f => sql(f, db => db.exec('CREATE TABLE extra(secret TEXT)')), /schema/],
  ['unknown column', f => sql(f, db => db.exec('ALTER TABLE signups ADD COLUMN bio TEXT')), /columns/],
  ['trigger', f => sql(f, db => db.exec('CREATE TRIGGER extra AFTER DELETE ON signups BEGIN SELECT 1; END')), /triggers/],
  ['unpublished claim', f => sql(f, db => db.exec('UPDATE claims SET published=0')), /unpublished/],
  ['unknown API state copy', f => writeFileSync(join(dirname(f.dbPath), 'alpha.sqlite.bak'), 'old private copy'), /unknown API state file/],
  ['unknown file', f => writeFileSync(join(f.state, 'journal.old'), 'old'), /unknown sender file/],
  ['missing live history', f => renameSync(join(f.state, 'journal.json'), join(dirname(f.state), 'saved-journal')), /missing sender history/],
  ['queue mismatch', f => save(join(f.queue, `${f.a.id}.json`), { ...f.a, xId: otherId }), /state does not match/],
  ['malformed receipt', f => writeFileSync(join(f.receipts, `${f.a.id}.json`), '{'), /./],
  ['symlink', f => { const path = join(f.queue, `${f.a.id}.json`); renameSync(path, path + '.original'); symlinkSync(path + '.original', path); }, /regular/],
  ['hardlink', f => linkSync(join(f.queue, `${f.a.id}.json`), join(dirname(f.state), 'linked')), /single-link/],
  ['orphan sender claim', f => { const path = join(f.state, 'journal.json'), j = read(path); j.entries[0].id = id(99); j.entries[0].outcome.id = id(99); save(path, j); }, /orphan/],
  ['unfinished sender entry', f => { const path = join(f.state, 'journal.json'), j = read(path); delete j.entries[0].outcome; save(path, j); }, /queued, sending or waiting/],
  ['unconfirmed signed hash', f => { const path = join(f.receipts, `${f.a.id}.json`), r = read(path); r.sendTx = null; save(path, r); }, /queued, sending or waiting|not final/],
]) test(`refuses unsafe ${name}`, async () => {
  const f = await fixture(); change(f); const before = wholeState(f); await assert.rejects(execute(f), reason);
  assert.deepEqual(wholeState(f), before);
  assert.ok(sql(f, db => db.prepare('SELECT xId FROM signups WHERE xId = ?').get(xId)));
});

test('both service locks cover the deletion transaction', async () => {
  const f = await fixture(); let reached = false;
  await execute(f, { checkpoint(point) {
    if (point !== 'locked') return; reached = true;
    assert.ok(existsSync(join(f.state, 'sender.lock')));
    sql(f, db => { db.exec('PRAGMA busy_timeout=0'); assert.throws(() => db.exec('BEGIN IMMEDIATE'), /locked/); });
  } }); assert.ok(reached);
});

const points = ['locked', 'manifest', ...tables.map(t => `delete:${t}`), 'committed',
  'journal:journal.dry.json', 'journal:journal.json', `journal:journal.json.${id(80)}.pending`,
  `file:queue/.${id(1)}.${id(81)}.tmp`, `file:queue/${id(1)}.json`, `file:queue/${id(3)}.json`,
  `file:receipts/${id(1)}.json`, `file:receipts/${id(1)}.progress.json`,
  `file:receipts/${id(1)}.progress.json.${id(82)}.pending`, `file:receipts/${id(3)}.json`, 'scrubbed'];
for (const point of points) test(`interruption at ${point} rolls back or resumes exactly once`, async () => {
  const f = await fixture(), before = otherState(f); let hit = false;
  await assert.rejects(execute(f, { checkpoint(p) {
    if (p === 'committed') {
      assert.equal(sql(f, db => db.prepare('SELECT count(*) AS n FROM signups WHERE xId = ?').get(xId).n), 0);
      assert.ok(existsSync(join(f.queue, `${f.a.id}.json`)), 'files must survive until commit');
    }
    if (p === point) { hit = true; throw new Error('injected interruption'); }
  } }), /injected interruption/); assert.ok(hit);
  if (['locked', 'manifest', ...tables.map(t => `delete:${t}`)].includes(point)) {
    assert.equal(sql(f, db => db.prepare('SELECT count(*) AS n FROM claims WHERE xId = ?').get(xId).n), 2);
    assert.ok(existsSync(join(f.queue, `${f.a.id}.json`)));
  }
  await execute(f); forgotten(f); assert.deepEqual(otherState(f), before);
});

test('partial manifest preparation and partial sanitized journal replacement are recoverable', async () => {
  const f = await fixture(); writeFileSync(`${forgetManifest(f.receipts)}.prepare`, '{partial private');
  await assert.rejects(execute(f, { checkpoint(p) { if (p === 'committed') throw new Error('stop'); } }), /stop/);
  writeFileSync(join(f.state, 'journal.json.forget-new'), '{partial sanitized');
  await execute(f); forgotten(f);
});

for (const point of ['delete:claims', 'committed', 'scrubbed']) test(`hard exit at ${point} adopts its own stale lock and rerun finishes`, { timeout: shLimit(30000) }, async () => {
  const f = await fixture();
  const code = `import { forgetTester } from ${JSON.stringify(moduleURL)}; await forgetTester(${JSON.stringify({ ...f.opts, execute: true })}, { checkpoint(p) { if (p === ${JSON.stringify(point)}) process.exit(77); } });`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: shLimit(30000) });
  assert.equal(child.status, 77, child.stderr); assert.ok(existsSync(join(f.state, 'sender.lock')));
  await execute(f); forgotten(f);
});

test('pending operation refuses a different selector and a completed operation is unknown', async () => {
  const f = await fixture();
  await assert.rejects(execute(f, { checkpoint(p) { if (p === 'committed') throw new Error('stop'); } }), /stop/);
  await assert.rejects(forgetTester({ ...f.opts, xId: otherId, handle: 'other_tester', execute: true }), /selector/);
  await assert.rejects(execute(f, { checkpoint(p) { if (p === 'complete') throw new Error('done'); } }), /done/);
  await assert.rejects(execute(f), /unknown X id/); forgotten(f);
});

test('fresh signup, approval and same-address claim pass API handlers and sender selection after forgetting', async () => {
  const f = await fixture();
  const openApi = () => createAlphaApi({ dbPath: f.dbPath, queueDir: f.queue, receiptsDir: f.receipts, origin,
    privyAppId: 'fixture-app', privyPublicKey: publicKey, cookieKey: Buffer.alloc(32, 7), accessIssuer: issuer, accessAudience: 'fixture-desk' },
  { now: () => instant, fetch: async () => new Response(JSON.stringify({ keys: [jwk] })) });
  let api = openApi();
  const old = await api.handle(new Request(origin + '/alpha/session', { method: 'POST', headers: { origin, 'privy-id-token': jwt(identity(xId)) } }));
  const oldCookies = old.headers.getSetCookie().map(c => c.split(';')[0]);
  assert.equal(old.status, 200); api.close(); api = null;
  await execute({ ...f, opts: record({ ...f.opts, handle: 'fixture_user' }) }); api = openApi();
  const request = (path, method = 'GET', headers = {}, body) => api.handle(new Request(origin + path, {
    method, headers: { origin, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  }));
  try {
    assert.equal((await request('/alpha/me', 'GET', { cookie: oldCookies[0] })).status, 401);
    assert.equal((await (await request('/alpha/intake', 'GET', { cookie: oldCookies[1] })).json()).returning, false);
    const login = await request('/alpha/session', 'POST', { 'privy-id-token': jwt(identity(xId)) });
    assert.equal(login.status, 200); assert.equal((await login.json()).status, 'pending');
    const cookie = login.headers.getSetCookie()[0].split(';')[0];
    const approved = await request('/desk/api/decide', 'POST', { 'Cf-Access-Jwt-Assertion': deskToken() }, { xId, decision: 'approve' });
    assert.equal(approved.status, 200);
    const challenge = await request(`/alpha/claim/message?address=${f.a.address}`, 'GET', { cookie }); assert.equal(challenge.status, 200);
    const c = await challenge.json();
    const accepted = await request('/alpha/claim', 'POST', { cookie }, { address: f.a.address, message: c.message, signature: await wallet.signMessage({ message: c.message }) });
    assert.equal(accepted.status, 202);
    api.close(); api = null;
    let sender = await f.start('live'); try { await sender.cycle(); } finally { sender.close(); }
    assert.equal(read(join(f.receipts, `${c.id}.json`)).status, 'sent');
    assert.equal(f.chain.sent.filter(a => a === f.a.address.toLowerCase()).length, 2);
  } finally { api?.close(); }
});

test('sender next nonce still blocks stale signing after the last transaction is forgotten', async () => {
  const f = await fixture(); await execute(f);
  // Erase only in this test fixture's other entries to isolate the retained floor.
  const file = join(f.state, 'journal.json'), j = read(file); j.entries = []; save(file, j);
  assert.equal(journalNonceFloor(j), 4);
  assert.throws(() => validateJournal({ ...j, nonceFloor: -1 }, j.identity), /journal refused/);
  f.put(await claim(9)); f.chain.latest = 0; f.chain.pending = 0;
  const sender = await f.start('live'), before = f.chain.prepares.length;
  try { await assert.rejects(sender.cycle(), /stale nonce view/); assert.equal(f.chain.prepares.length, before); }
  finally { sender.close(); }
});


test('a signup without claims can be forgotten before the sender has ever run', async () => {
  const p = scratch(), apiDir = join(dirname(p.state), 'api'); mkdirSync(apiDir);
  const dbPath = join(apiDir, 'alpha.sqlite'), s = openStore(dbPath);
  s.run('INSERT INTO signups VALUES(?,?,?,?,?,?,?,?)', xId, 'did:privy:only', handle, 'Private profile', null, 'pending', 'now', 'now'); s.close();
  const result = await forgetTester(record({ ...p, dbPath, xId, handle: handle.toUpperCase(), servicesStopped: true, execute: true }));
  assert.equal(result.executed, true); assert.equal(result.files, 0); assert.equal(result.rows.signups, 1);
});

test('a shared address reserved by another account refuses without changing that account', async () => {
  const f = await fixture();
  sql(f, db => { db.prepare('UPDATE claims SET reserved=0 WHERE xId=?').run(xId);
    db.prepare('UPDATE claims SET address=? WHERE xId=?').run(f.a.address, otherId); });
  const before = otherState(f); await assert.rejects(execute(f), /reserved by another account/); assert.deepEqual(otherState(f), before);
});

test('plan reads live WAL with a running sender and leaves application bytes unchanged', async () => {
  const f = await fixture(), db = new DatabaseSync(f.dbPath), sender = await f.start('live');
  try {
    db.exec('PRAGMA wal_autocheckpoint=0'); db.prepare('INSERT INTO signins(xId,at) VALUES(?,?)').run(xId, 'later');
    const before = readFileSync(`${f.dbPath}-wal`);
    const files = wholeState(f);
    const plan = await forgetTester({ ...f.opts, operation: undefined, completion: undefined, servicesStopped: false });
    assert.equal(plan.rows.signins, 2);
    // SQLite's shared-memory read marks are locking metadata, not application data.
    const application = state => Object.fromEntries(Object.entries(state).filter(([name]) => !name.endsWith('-shm')));
    assert.deepEqual(application(wholeState(f)), application(files));
    assert.deepEqual(readFileSync(`${f.dbPath}-wal`), before);
  } finally { db.close(); sender.close(); }
});


test('forget removes addresses and signatures from every historical attempt', async () => {
  const f = await fixture(), old = await claim(3, { xId, privyDid: 'did:privy:historical' });
  assert.notEqual(old.address, f.a.address);
  sql(f, db => db.prepare('UPDATE claims SET address=?, payload=? WHERE id=?').run(old.address, JSON.stringify(old), old.id));
  f.put(old); await execute(f);
  for (const dir of [f.queue, f.receipts, f.state, dirname(f.dbPath)]) for (const name of readdirSync(dir)) {
    const bytes = readFileSync(join(dir, name)).toString();
    for (const secret of [old.address, old.signature, old.privyDid]) assert.ok(!bytes.includes(secret), name);
  }
  assert.equal(sql(f, db => db.prepare('SELECT count(*) AS n FROM claims WHERE address=? COLLATE NOCASE').get(old.address).n), 0);
});

const apiConfig = f => ({ dbPath: f.dbPath, queueDir: f.queue, receiptsDir: f.receipts, origin,
  privyAppId: 'fixture-app', privyPublicKey: publicKey, cookieKey: Buffer.alloc(32, 7), accessIssuer: issuer, accessAudience: 'fixture-desk' });
const openApi = f => createAlphaApi(apiConfig(f), { now: () => instant, fetch: async () => new Response(JSON.stringify({ keys: [jwk] })) });
const apiRequest = (api, path, method = 'GET', headers = {}, body) => api.handle(new Request(origin + path, {
  method, headers: { origin, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
}));

test('lock then read: the first account read requires both locks', async () => {
  const f = await fixture(), prepare = DatabaseSync.prototype.prepare; let reads = 0;
  DatabaseSync.prototype.prepare = function (query, ...args) {
    if (/SELECT .*FROM signups WHERE xId/.test(query)) {
      reads++;
      assert.ok(existsSync(join(f.state, 'sender.lock')), 'account read preceded sender lock');
      sql(f, probe => { probe.exec('PRAGMA busy_timeout=0'); assert.throws(() => probe.exec('BEGIN IMMEDIATE'), /locked/); });
    }
    return prepare.call(this, query, ...args);
  };
  try { await execute(f); assert.ok(reads > 0); }
  finally { DatabaseSync.prototype.prepare = prepare; }
});

test('both service cores refuse an unfinished manifest and start after its rerun', async () => {
  const f = await fixture();
  await assert.rejects(execute(f, { checkpoint(p) { if (p === 'committed') throw new Error('stop'); } }), /stop/);
  assert.throws(() => openApi(f), /a forget run is unfinished: run it again/);
  await assert.rejects(f.start('live'), /a forget run is unfinished: run it again/);
  await execute(f);
  const api = openApi(f); api.close(); const sender = await f.start('live'); sender.close(); forgotten(f);
});

test('another operation id is never adopted and refusal leaves every byte unchanged', async () => {
  const f = await fixture();
  await assert.rejects(execute(f, { checkpoint(p) { if (p === 'committed') throw new Error('stop'); } }), /stop/);
  save(join(f.state, 'sender.lock'), { operation: id(98) });
  const before = wholeState(f);
  await assert.rejects(execute(f), /sender lock/); assert.deepEqual(wholeState(f), before);
});

test('a live forget hold cannot be adopted by a second same-selector command', async () => {
  const f = await fixture();
  await execute(f, { async checkpoint(p) {
    if (p !== 'committed') return;
    const before = wholeState(f);
    await assert.rejects(execute(f), /locked/); assert.deepEqual(wholeState(f), before);
  } }); forgotten(f);
});

test('executed CLI output contains exactly counts and no account values', async () => {
  const f = await fixture(), lines = [];
  await main(['--x-id', xId, '--handle', handle, '--api-db', f.dbPath, '--queue', f.queue, '--receipts', f.receipts,
    '--sender-state', f.state, '--services-stopped', '--execute', '--operation', f.opts.operation, '--completion', f.opts.completion], line => lines.push(line));
  assert.deepEqual(JSON.parse(lines.join('')), { rows: { challenges: 1, decisions: 1, signins: 1, returning_browsers: 1, sessions: 1, claims: 2, signups: 1 }, files: 7, journals: 3, executed: true });
  forgotten(f);
});

test('an API crash leaves no persistent startup lock', { timeout: shLimit(30000) }, async () => {
  const f = await fixture(), config = { ...apiConfig(f), cookieKey: undefined };
  const code = `import { createAlphaApi } from ${JSON.stringify(new URL('../alpha-api.mjs', import.meta.url).href)};
    createAlphaApi({ ...${JSON.stringify(config)}, cookieKey: Buffer.alloc(32, 7) }); process.kill(process.pid, 'SIGKILL');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: shLimit(30000) });
  assert.equal(result.signal, 'SIGKILL', result.stderr);
  assert.ok(!existsSync(forgetManifest(f.receipts)));
  const api = openApi(f); api.close();
});

// The review's exact 31 boundaries. Native VACUUM/power-loss recovery is SQLite's responsibility.
const killPoints = ['locked', 'manifest:fsync', 'manifest:rename', 'manifest:sync', ...tables.map(t => `delete:${t}`), 'audit', 'committed',
  'journal-write:journal.dry.json:fsync', 'journal-write:journal.dry.json:rename',
  ...points.filter(p => p.startsWith('journal:') || p.startsWith('file:')), 'truncate:first', 'vacuum', 'truncate:last', 'scrubbed', 'manifest-removed', 'complete'];
assert.equal(killPoints.length, 31);
for (const point of killPoints) test(`SIGKILL ${point}: one wrapper rerun restores activity and finishes deletion`, { timeout: shLimit(30000) }, async () => {
  const f = await fixture(), before = otherState(f), root = dirname(f.state);
  const options = { root, fixture: f.opts, args: [xId, handle] };
  const child = runWrapper({ ...options, commandStop: point });
  assert.equal(child.status, 137, child.stderr);
  assert.equal(readFileSync(join(root, 'running'), 'utf8').trim(), '');
  assert.equal(readFileSync(join(root, 'timer'), 'utf8'), 'inactive');
  if (existsSync(forgetManifest(f.receipts))) {
    assert.throws(() => openApi(f), /a forget run is unfinished: run it again/);
    await assert.rejects(f.start('live'), /a forget run is unfinished: run it again/);
  }
  const retry = runWrapper(options); assert.equal(retry.status, 0, retry.stderr);
  assert.equal(readFileSync(join(root, 'running'), 'utf8').trim(), 'alpha-api\nalpha-sender');
  assert.equal(readFileSync(join(root, 'timer'), 'utf8'), 'active');
  assert.ok(!existsSync(join(root, 'alpha-forget.restore')));
  forgotten(f); assert.deepEqual(otherState(f), before);
  const api = openApi(f); api.close(); const sender = await f.start('live'); sender.close();
});

test('operation lock adoption checks its own operation id even after the outer check', async () => {
  const { acquireSenderLock } = await import(process.env.SH_FORGET_SENDER_STORE ?? new URL('./sender/store.mjs', import.meta.url).href);
  const f = await fixture(); save(join(f.state, 'sender.lock'), { operation: id(97) });
  const before = wholeState(f);
  assert.throws(() => acquireSenderLock(f.state, { operation: id(98), recover: true }), /sender lock/);
  assert.deepEqual(wholeState(f), before);
});

test('a crash between lock publication and temporary-link removal recovers', async () => {
  const f = await fixture();
  const code = `import { forgetTester } from ${JSON.stringify(moduleURL)}; await forgetTester(${JSON.stringify({ ...f.opts, execute: true })}, { checkpoint(p) { if (p === 'locked') process.kill(process.pid, 'SIGKILL'); } });`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: shLimit(30000) });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  linkSync(join(f.state, 'sender.lock'), join(f.state, 'forget-tester.lock-prepare'));
  await execute(f); forgotten(f);
});

test('a busy database refusal preserves the entire state including lock files', async () => {
  const f = await fixture(), db = new DatabaseSync(f.dbPath);
  try {
    db.exec('BEGIN IMMEDIATE'); const before = wholeState(f);
    await assert.rejects(execute(f), /locked/); assert.deepEqual(wholeState(f), before);
  } finally { db.exec('ROLLBACK'); db.close(); }
});

test('refusal preserves a prior partial preparation and hold byte for byte', async () => {
  const f = await fixture();
  writeFileSync(`${forgetManifest(f.receipts)}.prepare`, '{partial private');
  writeFileSync(join(f.state, 'forget-tester.hold'), '');
  const before = wholeState(f);
  await assert.rejects(forgetTester(record({ ...f.opts, handle: 'wrong', execute: true })), /belong together/);
  assert.deepEqual(wholeState(f), before);
});

const wrapperIntent = f => {
  const completion = join(dirname(f.state), 'alpha-forget.restore'), operation = id(99);
  const selector = createHash('sha256').update(`${xId}\n${handle.toLowerCase()}\n`).digest('hex');
  const activity = ['active', 'active', 'inactive', operation, selector];
  writeFileSync(completion, activity.join('\n') + '\n', { mode: 0o600 });
  return { completion, operation, activity };
};
for (const point of ['completion:fsync', 'completion:rename', 'completion:sync', 'manifest-removed', 'complete']) {
  test(`wrapper receipt survives command SIGKILL ${point}`, { timeout: shLimit(30000) }, async () => {
    const f = await fixture(), before = otherState(f), intent = wrapperIntent(f);
    const opts = { ...f.opts, ...intent, execute: true };
    const code = `import { forgetTester } from ${JSON.stringify(moduleURL)}; await forgetTester(${JSON.stringify(opts)}, { checkpoint(p) { if (p === ${JSON.stringify(point)}) process.kill(process.pid, 'SIGKILL'); } });`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: shLimit(30000) });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    if (existsSync(forgetManifest(f.receipts))) await forgetTester(opts);
    const lines = readFileSync(intent.completion, 'utf8').trimEnd().split('\n');
    assert.equal(lines.length, 6, 'completion record missing');
    assert.deepEqual(lines.slice(0, 5), intent.activity);
    const receipt = JSON.parse(lines[5]);
    assert.equal(receipt.operation, intent.operation); assert.equal(receipt.v, 1);
    assert.equal(receipt.counts.executed, true); assert.equal(receipt.counts.rows.signups, 1);
    for (const value of [handle, xId, f.a.id, f.a.address, f.a.signature]) assert.ok(!lines.join('\n').includes(value));
    assert.ok(!existsSync(intent.completion + '.prepare'));
    forgotten(f); assert.deepEqual(otherState(f), before);
    const api = openApi(f); api.close(); const sender = await f.start('live'); sender.close();
  });
}
test('wrapper receipt requires its exact operation and selector before deletion', async () => {
  const f = await fixture(), intent = wrapperIntent(f), before = wholeState(f);
  for (const patch of [{ operation: id(98) }, { handle: 'wrong' }, { operation: undefined }, { completion: undefined }]) {
    await assert.rejects(forgetTester({ ...f.opts, ...intent, ...patch, execute: true }), /operation|selector/);
    assert.deepEqual(wholeState(f), before);
  }
});
test('wrapper CLI plan, run and completion receipts never contain the full handle', async () => {
  const f = await fixture(), intent = wrapperIntent(f), lines = [];
  const args = ['--x-id', xId, '--handle', handle, '--api-db', f.dbPath, '--queue', f.queue, '--receipts', f.receipts,
    '--sender-state', f.state, '--services-stopped', '--operation', intent.operation, '--completion', intent.completion];
  await main(args, line => lines.push(line));
  await main([...args, '--execute'], line => lines.push(line));
  assert.ok(lines.join('').includes('pr***er'));
  for (const text of [...lines, readFileSync(intent.completion, 'utf8'), ...readdirSync(f.receipts).map(n => readFileSync(join(f.receipts, n), 'utf8'))]) {
    assert.ok(!text.includes(handle));
  }
  forgotten(f);
});
test('short plan handles are wholly masked', async () => {
  const f = await fixture();
  for (const short of ['a', 'ab', 'abc', 'abcd']) {
    sql(f, db => db.prepare('UPDATE signups SET handle=? WHERE xId=?').run(short, xId));
    assert.equal((await forgetTester({ ...f.opts, operation: undefined, completion: undefined, handle: short })).handle, `*** [${digest(xId, short).slice(0, 8)}]`);
  }
});

test('direct execution without a wrapper operation record refuses with fixed text and no changes; plan alone works', async () => {
  const f = await fixture(), before = wholeState(f);
  const args = ['--x-id', xId, '--handle', handle, '--api-db', f.dbPath, '--queue', f.queue, '--receipts', f.receipts, '--sender-state', f.state];
  const child = spawnSync(process.execPath, [new URL(moduleURL).pathname, ...args, '--execute', '--services-stopped'], { encoding: 'utf8', timeout: shLimit(30000) });
  assert.equal(child.status, 1, child.stderr);
  assert.equal(child.stderr.replace(/^.*ExperimentalWarning.*\n(?:.*trace-warnings.*\n)?/gm, ''), 'forget refused: execution requires alpha-forget.sh and its operation record\n');
  assert.equal(child.stdout, ''); assert.deepEqual(wholeState(f), before);
  await assert.rejects(forgetTester({ ...f.opts, execute: true, completion: join(dirname(f.state), 'missing.restore') }), /execution requires alpha-forget.sh and its operation record/);
  assert.deepEqual(wholeState(f), before);
  const lines = []; await main(args, line => lines.push(line));
  assert.equal(JSON.parse(lines.join('')).executed, false); assert.deepEqual(wholeState(f), before);
});

test('similar masked handles have distinct selector fingerprints', async () => {
  const f = await fixture(), masks = [];
  for (const selected of ['private_tester', 'private_user']) {
    sql(f, db => db.prepare('UPDATE signups SET handle=? WHERE xId=?').run(selected, xId));
    const plan = await forgetTester({ ...f.opts, handle: selected, operation: undefined, completion: undefined });
    assert.equal(plan.handle, `pr***er [${digest(xId, selected).slice(0, 8)}]`); masks.push(plan.handle);
  }
  assert.notEqual(...masks);
});

test('mixed-case handle agrees between the real wrapper and command and fingerprints confirmation', async () => {
  const f = await fixture(), before = otherState(f), selected = 'PrIvAtE_TeStEr';
  const r = runWrapper({ root: dirname(f.state), fixture: f.opts, args: [xId, selected], input: selected + '\n' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stderr.includes(`Pr***Er [${digest(xId, selected).slice(0, 8)}]`));
  assert.ok(r.stdout.includes(`pr***er [${digest(xId, selected).slice(0, 8)}]`));
  forgotten(f); assert.deepEqual(otherState(f), before);
});

test('ordinary request and monitor never query forget schema or generation', async () => {
  const f = await fixture(), api = openApi(f), prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (query, ...args) {
    if (/sqlite_schema|forget_audit/.test(query)) throw new Error('injected SQLite I/O failure');
    return prepare.call(this, query, ...args);
  };
  try {
    assert.equal((await apiRequest(api, '/alpha/intake')).status, 200);
    assert.equal(api.monitor().service, 'alpha-api');
  } finally { DatabaseSync.prototype.prepare = prepare; api.close(); }
});

test('preparation alone refuses both service starts and a wrapper rerun permits both', async () => {
  const f = await fixture(); writeFileSync(`${forgetManifest(f.receipts)}.prepare`, '{partial');
  assert.throws(() => openApi(f), /a forget run is unfinished: run it again/);
  await assert.rejects(f.start('live'), /a forget run is unfinished: run it again/);
  const r = runWrapper({ root: dirname(f.state), fixture: f.opts, args: [xId, handle] });
  assert.equal(r.status, 0, r.stderr); forgotten(f);
  const api = openApi(f); api.close(); const sender = await f.start('live'); sender.close();
});

// Use every executable Bash boundary, including the two former R3-M2 post-unlink failures.
const wrapperSource = readFileSync('infra/server/alpha-forget.sh', 'utf8'), wrapperLines = wrapperSource.split('\n');
const firstStop = wrapperLines.findIndex(line => line.trim() === 'systemctl stop squarehole-pg-backup.timer') + 1;
const traced = runWrapper({ trace: true }); assert.equal(traced.status, 0, traced.stderr);
const wrapperStops = [...new Set(traced.trace)].filter(n => n >= firstStop).sort((a, b) => a - b);
for (const stopLine of wrapperStops) test(`real command wrapper stop before line ${stopLine}: one rerun preserves other account and prior activity`, { timeout: shLimit(30000) }, async () => {
  const f = await fixture(), before = otherState(f), options = { root: dirname(f.state), fixture: f.opts, args: [xId, handle] };
  const stopped = runWrapper({ ...options, stopLine }); assert.equal(stopped.status, 137, stopped.stderr);
  const r = runWrapper(options); assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(r.root, 'running'), 'utf8').trim(), 'alpha-api\nalpha-sender');
  assert.equal(readFileSync(join(r.root, 'timer'), 'utf8'), 'active');
  forgotten(f); assert.deepEqual(otherState(f), before);
});

test('never-present target plans absent and wrapper leaves every service as it is', async () => {
  const f = await fixture(), before = wholeState(f), options = { ...f.opts, xId: '9', operation: undefined, completion: undefined };
  assert.deepEqual(await forgetTester(options), { absent: true });
  const r = runWrapper({ root: dirname(f.state), fixture: f.opts, args: ['9', handle] });
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), 'alpha-forget: tester is absent; services unchanged');
  assert.ok(!r.calls.some(c => / (stop|start) /.test(c)));
  assert.deepEqual(wholeState(f), before);
  assert.equal(readFileSync(join(r.root, 'running'), 'utf8').trim(), 'alpha-api\nalpha-sender');
  assert.equal(readFileSync(join(r.root, 'timer'), 'utf8'), 'active');
});
