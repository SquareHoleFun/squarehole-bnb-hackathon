// Offline, one-account maintenance. No credentials, RPC or transaction signing.
import { constants, openSync, closeSync, fsyncSync, writeFileSync, renameSync, unlinkSync,
  lstatSync, readdirSync, realpathSync, existsSync, chmodSync, chownSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { forgetManifest } from './forget-maintenance.mjs';
import { xIdPattern } from './message.mjs';
import { claimProgress, receipt } from './files.mjs';
import { acquireSenderLock, readBounded, validateJournal, journalNonceFloor, uuid } from './sender/store.mjs';

const guard = (ok, reason = 'state does not match; reconcile before retrying') => {
  if (!ok) throw Object.assign(new Error(reason), { forgetGuard: true });
};
const sync = path => { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
const regular = path => {
  const s = lstatSync(path);
  guard(s.isFile() && !s.isSymbolicLink() && s.nlink === 1, 'regular single-link files required'); return s;
};
const directory = path => { guard(realpathSync(path) === resolve(path) && lstatSync(path).isDirectory(), 'real directories required'); };
const read = path => { regular(path); return JSON.parse(readBounded(path, 32 * 1024 * 1024)); };
const remove = path => { if (existsSync(path)) { regular(path); unlinkSync(path); } sync(dirname(path)); };
// Deterministic scratch names belong to the durable manifest. A partial write is overwritten on retry.
async function replace(path, value, temporary = `${path}.forget-new`, checkpoint = () => {}, label = 'journal') {
  if (existsSync(temporary)) regular(temporary);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  await checkpoint(`${label}:fsync`);
  renameSync(temporary, path); await checkpoint(`${label}:rename`);
  sync(dirname(path)); await checkpoint(`${label}:sync`);
}
const schema = {
  signups: 'xId,privyDid,handle,name,picture,status,signedUpAt,lastSignIn',
  decisions: 'seq,xId,decision,actor,at', signins: 'seq,xId,at', sessions: 'hash,xId,expires',
  returning_browsers: 'hash,xId,expires', challenges: 'sessionHash,id,address,message,requestedAt,expires',
  claims: 'id,xId,address,payload,acceptedAt,published,reserved',
  forget_audit: 'operation,at,rows,files,uid,gid',
};
const selectors = {
  challenges: 'sessionHash IN (SELECT hash FROM sessions WHERE xId = ?)',
  decisions: 'xId = ?', signins: 'xId = ?', returning_browsers: 'xId = ?',
  sessions: 'xId = ?', claims: 'xId = ?', signups: 'xId = ?',
};
function checkSchema(db) {
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(r => r.name);
  guard(Object.keys(selectors).every(t => tables.includes(t)) && tables.every(t => Object.hasOwn(schema, t)), 'unknown database schema');
  for (const table of tables) guard(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name).join(',') === schema[table], 'unknown database columns');
  guard(!db.prepare("SELECT name FROM sqlite_schema WHERE type IN ('trigger','view')").get(), 'database triggers or views require review');
}
const journalName = /^(journal(?:\.dry)?\.json)(?:\.[a-f0-9-]{36}\.pending)?$/;
function journals(state) {
  const result = [];
  for (const name of readdirSync(state).sort()) {
    regular(join(state, name));
    if (journalName.test(name)) {
      const value = read(join(state, name));
      guard(/^11155111:0x[0-9a-fA-F]{40}:0x[0-9a-fA-F]{40}:(live|dry-run)$/.test(value.identity), 'sender identity refused');
      guard(value.identity.endsWith(name.startsWith('journal.dry.') ? ':dry-run' : ':live'), 'sender mode mismatch');
      guard(Object.keys(value).every(k => ['v', 'identity', 'entries', 'nonceFloor'].includes(k)), 'unknown journal fields');
      validateJournal(value, value.identity); result.push({ name, value });
    } else guard(/^(?:sender\.lock(?:\.[a-zA-Z0-9-]+(?:\.released)?)?|(?:monitor|health)\.json(?:\.[a-f0-9-]{36}\.pending)?|forget-tester\.(?:hold|lock-prepare))$/.test(name), 'unknown sender file; reconcile first');
  }
  guard(new Set(result.map(j => j.value.identity.replace(/:(live|dry-run)$/, ''))).size <= 1, 'sender identities disagree');
  return result;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function inventory(db, opts) {
  const { xId, handle, queue, receipts, state } = opts;
  const user = db.prepare('SELECT * FROM signups WHERE xId = ?').get(xId);
  guard(user, 'unknown X id');
  guard(user.handle.toLowerCase() === handle.toLowerCase(), 'X id and handle do not belong together');
  const claims = db.prepare('SELECT * FROM claims WHERE xId = ? ORDER BY id').all(xId);
  for (const c of claims) guard(!db.prepare('SELECT id FROM claims WHERE xId <> ? AND address = ? COLLATE NOCASE AND reserved = 1').get(xId, c.address),
    'address is reserved by another account; reconcile without changing that account');
  const ids = claims.map(c => c.id), selected = new Set(ids), files = [];
  for (const c of claims) {
    guard(uuid.test(c.id) && JSON.parse(c.payload).xId === xId && JSON.parse(c.payload).id === c.id);
    const progress = claimProgress(receipts, c.id);
    guard(!['queued', 'sending', 'waiting'].includes(progress.status),
      'claim is queued, sending or waiting; refill or reconcile with the sender, wait for a final receipt, then stop both services again');
    guard(c.published === 1, 'unpublished claim; recover the API outbox first');
  }
  const js = journals(state);
  for (const { name, value } of js) for (const e of value.entries) {
    guard(e.xId !== xId || selected.has(e.id), 'orphan sender claim; reconcile first');
    if (!selected.has(e.id)) continue;
    guard(e.xId === undefined || e.xId === xId, 'claim belongs to another account');
    const c = claims.find(c => c.id === e.id);
    guard(e.address === undefined || e.address.toLowerCase() === c.address.toLowerCase());
    const final = receipt(receipts, e.id);
    // Retained atomic copies may predate the final outcome. All their signed bytes must still be final.
    guard(name.includes('.pending') || (!e.pausedReason && e.outcome && same(e.outcome, final)),
      'sender work is queued, sending or waiting; reconcile to a final receipt first');
    for (const kind of ['admit', 'send']) if (e[kind]) guard(final[`${kind}Tx`] === e[kind].hash, 'signed transaction is not final; reconcile first');
  }
  for (const c of claims) {
    const final = receipt(receipts, c.id);
    const active = js.filter(j => !j.name.includes('.pending')).flatMap(j => j.value.entries).filter(e => e.id === c.id);
    guard(active.length >= 1, 'missing sender history; reconcile first');
    for (const kind of ['admit', 'send']) if (final[`${kind}Tx`]) guard(active.some(e => e[kind]?.hash === final[`${kind}Tx`]), 'missing signed history');
  }
  for (const [area, dir] of [['queue', queue], ['receipts', receipts]]) for (const name of readdirSync(dir).sort()) {
    regular(join(dir, name));
    const match = area === 'queue'
      ? /^(?:([a-f0-9-]{36})\.json|\.([a-f0-9-]{36})\.[a-f0-9-]{36}\.tmp)$/.exec(name)
      : /^([a-f0-9-]{36})(?:\.progress)?\.json(?:\.[a-f0-9-]{36}\.pending)?$/.exec(name);
    if (area === 'receipts' && ['forget-tester.json', 'forget-tester.json.prepare'].includes(name)) continue;
    guard(match || (area === 'receipts' && /^sender-status\.json(?:\.[a-f0-9-]{36}\.pending)?$/.test(name)), 'unknown exchange file; reconcile first');
    const id = match?.[1] ?? match?.[2];
    if (id) guard(uuid.test(id));
    if (area === 'queue' && name.endsWith('.json')) {
      const payload = read(join(dir, name));
      guard(payload.xId !== xId || selected.has(id), 'orphan queue claim; reconcile first');
      if (selected.has(id)) guard(payload.id === id && payload.xId === xId && same(payload, JSON.parse(claims.find(c => c.id === id).payload)));
    }
    if (selected.has(id)) files.push({ area, name });
  }
  for (const c of claims) guard(files.some(f => f.area === 'queue' && f.name === `${c.id}.json`), 'missing queue history');
  const counts = Object.fromEntries(Object.entries(selectors).map(([table, where]) => [table,
    db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get(xId).n]));
  return { v: 1, operation: randomUUID(), xId, handle: user.handle, ids, files,
    journals: js.filter(j => j.value.entries.some(e => selected.has(e.id))).map(j => j.name),
    counts, at: new Date().toISOString().slice(0, 10), uid: process.getuid(), gid: process.getgid() };
}
const selectorDigest = (xId, handle) => createHash('sha256').update(`${xId}\n${handle.toLowerCase()}\n`).digest('hex');
function publicPlan(m, executed = false) {
  return { ...(!executed ? { handle: `${m.handle.length > 4 ? `${m.handle.slice(0, 2)}***${m.handle.slice(-2)}` : '***'} [${selectorDigest(m.xId, m.handle).slice(0, 8)}]` } : {}), rows: m.counts, files: m.files.length, journals: m.journals.length, executed };
}
function validateManifest(m, opts) {
  guard(m.v === 1 && uuid.test(m.operation) && (!opts.operation || m.operation === opts.operation) && m.xId === opts.xId && m.handle.toLowerCase() === opts.handle.toLowerCase(),
    'another forget is pending; rerun its original X id and handle before any other maintenance');
  if (m.phase === 'intent') return;
  guard(Array.isArray(m.ids) && m.ids.every(id => uuid.test(id)) && Array.isArray(m.files) && Array.isArray(m.journals));
  for (const f of m.files) guard(['queue', 'receipts'].includes(f.area) && !f.name.includes('/') && m.ids.some(id =>
    f.area === 'queue' ? f.name === `${id}.json` || new RegExp(`^\\.${id}\\.[a-f0-9-]{36}\\.tmp$`).test(f.name)
      : new RegExp(`^${id}(?:\\.progress)?\\.json(?:\\.[a-f0-9-]{36}\\.pending)?$`).test(f.name)));
  guard(m.journals.every(name => journalName.test(name)));
}
/** Hooks expose durable boundaries to local crash tests, never CLI switches. */
export async function forgetTester(opts, { checkpoint: hook = () => {} } = {}) {
  const checkpoint = async point => { try { await hook(point); } catch (error) { error.forgetInterruption = true; throw error; } };
  const { xId, handle, dbPath, queue, receipts, state, execute = false, servicesStopped = false } = opts;
  guard(typeof xId === 'string' && xIdPattern.test(xId) && typeof handle === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(handle), 'separate canonical --x-id and --handle required');
  guard((opts.operation === undefined && opts.completion === undefined) || (typeof opts.operation === 'string' && uuid.test(opts.operation) && typeof opts.completion === 'string' && resolve(opts.completion) === opts.completion), 'operation and absolute completion path required together');
  guard(!execute || (opts.operation && opts.completion && existsSync(opts.completion)), 'execution requires alpha-forget.sh and its operation record');
  guard(!execute || servicesStopped, 'stop alpha-api and alpha-sender; pass --services-stopped for execution');
  for (const path of [dirname(dbPath), queue, receipts, state]) directory(path);
  for (const name of readdirSync(dirname(dbPath))) {
    regular(join(dirname(dbPath), name));
    guard([basename(dbPath), `${basename(dbPath)}-wal`, `${basename(dbPath)}-shm`, 'monitor.json', 'monitor.json.new'].includes(name),
      'unknown API state file; reconcile retained copies first');
  }
  let restore;
  if (opts.completion) {
    regular(opts.completion);
    restore = readFileSync(opts.completion, 'utf8').trimEnd().split('\n');
    const selector = selectorDigest(xId, handle);
    guard([5, 6].includes(restore.length) && restore.slice(0, 3).every(s => ['active', 'inactive'].includes(s)) && restore[3] === opts.operation && restore[4] === selector, 'wrapper operation or selector mismatch');
  }
  const owner = regular(dbPath);
  for (const suffix of ['-wal', '-shm']) if (existsSync(dbPath + suffix)) regular(dbPath + suffix);
  const manifest = forgetManifest(receipts), preparing = `${manifest}.prepare`, holdPath = join(state, 'forget-tester.hold');
  let m = existsSync(manifest) ? read(manifest) : null;
  if (m) validateManifest(m, opts);
  const pending = Boolean(m);
  if (execute && existsSync(join(state, 'sender.lock'))) {
    let own;
    try { own = JSON.parse(readBounded(join(state, 'sender.lock'), 4096)); } catch { /* refuse an unreadable lock */ }
    guard(m && own?.operation === m.operation, 'sender lock held; stop all sender processes and follow lock recovery');
  }
  // A completed inventory is already in the private manifest.
  if (!execute && m?.counts) return publicPlan(m);
  // Read the live WAL when present. A clean closed DB needs no sidecars for inspection.
  const planPath = existsSync(`${dbPath}-wal`) ? dbPath : `${pathToFileURL(resolve(dbPath)).href}?immutable=1`;
  const initialScratch = execute && !pending ? [preparing, holdPath, join(state, 'forget-tester.lock-prepare')]
    .filter(existsSync).map(path => ({ path, stat: regular(path), bytes: readFileSync(path) })) : [];
  let db, hold, lock, transaction = false, changed = false, finished = false;
  const closeDb = () => {
    if (transaction) { db.exec('ROLLBACK'); transaction = false; }
    db?.close(); db = null;
    if (execute) for (const suffix of ['-wal', '-shm']) if (existsSync(dbPath + suffix)) {
      const sidecar = regular(dbPath + suffix);
      if ((sidecar.mode & 0o777) !== (owner.mode & 0o777)) chmodSync(dbPath + suffix, owner.mode & 0o777);
      if (process.getuid() === 0) chownSync(dbPath + suffix, owner.uid, owner.gid);
    }
  };
  try {
    // A separate SQLite file holds a kernel lock across COMMIT, VACUUM and file cleanup.
    // No PID guess is needed after a crash or a change of container PID namespace.
    if (execute && existsSync(holdPath)) regular(holdPath);
    if (execute && m) {
      hold = new DatabaseSync(holdPath); hold.exec('PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE');
      guard(existsSync(manifest) && read(manifest).operation === m.operation, 'forget state changed; rerun');
    }
    db = new DatabaseSync(execute ? dbPath : planPath, { readOnly: !execute, allowExtension: false });
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    if (execute) {
      db.exec('PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; BEGIN IMMEDIATE'); transaction = true;
      if (!m) {
        // Publish an intent before the sender lock: no stale command lock can lack its manifest.
        guard(!existsSync(manifest), 'another forget is pending; run it again');
        hold = new DatabaseSync(holdPath); hold.exec('PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE');
        m = { v: 1, phase: 'intent', operation: opts.operation ?? randomUUID(), xId, handle };
        await replace(manifest, m, preparing);
      }
      guard(existsSync(manifest) && read(manifest).operation === m.operation, 'forget state changed; rerun');
      lock = acquireSenderLock(state, { operation: m.operation, recover: pending });
      sync(state);
      await checkpoint('locked');
    }
    checkSchema(db);
    if (!execute) {
      db.exec('BEGIN'); transaction = true;
      if (!m && !existsSync(preparing) && !db.prepare('SELECT xId FROM signups WHERE xId = ?').get(xId)) return { absent: true };
      return publicPlan(inventory(db, opts));
    }
    await checkpoint('before-account-read');
    if (m.phase === 'intent') {
      const operation = m.operation;
      m = { ...inventory(db, opts), operation };
      await replace(manifest, m, preparing, checkpoint, 'manifest');
    }
    await checkpoint('manifest');
    db.exec('CREATE TABLE IF NOT EXISTS forget_audit (operation TEXT PRIMARY KEY, at TEXT NOT NULL, rows INTEGER NOT NULL, files INTEGER NOT NULL, uid INTEGER NOT NULL, gid INTEGER NOT NULL)');
    const prior = db.prepare('SELECT * FROM forget_audit WHERE operation = ?').get(m.operation);
    if (!prior) {
      const fresh = inventory(db, opts);
      for (const key of ['ids', 'files', 'journals', 'counts']) guard(same(fresh[key], m[key]), 'state changed; keep services stopped and reconcile');
      for (const [table, where] of Object.entries(selectors)) {
        const deleted = db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(xId).changes;
        guard(deleted === m.counts[table]);
        await checkpoint(`delete:${table}`);
      }
      db.prepare('INSERT INTO forget_audit VALUES(?,?,?,?,?,?)').run(m.operation, m.at,
        Object.values(m.counts).reduce((n, count) => n + count, 0), m.files.length, m.uid, m.gid);
      await checkpoint('audit');
    } else guard(!db.prepare('SELECT xId FROM signups WHERE xId = ?').get(xId), 'account recreated during maintenance; stop services');
    db.exec('COMMIT'); transaction = false; changed = true;
    await checkpoint('committed');
    for (const id of m.ids) guard(!db.prepare('SELECT id FROM claims WHERE id = ?').get(id), 'saved claim ID now belongs to an account; keep services stopped');
    const selected = new Set(m.ids);
    for (const name of m.journals) {
      const path = join(state, name), value = read(path);
      validateJournal(value, value.identity);
      guard(value.entries.every(e => !selected.has(e.id) || e.xId === undefined || e.xId === xId), 'saved journal claim belongs to another account');
      value.nonceFloor = journalNonceFloor(value);
      value.entries = value.entries.filter(e => !selected.has(e.id));
      await replace(path, value, `${path}.forget-new`, checkpoint, `journal-write:${name}`);
      await checkpoint(`journal:${name}`);
    }
    for (const f of m.files) {
      remove(join(opts[f.area], f.name));
      await checkpoint(`file:${f.area}/${f.name}`);
    }
    guard(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy === 0, 'SQLite is busy; keep services stopped and retry');
    await checkpoint('truncate:first');
    db.exec('VACUUM'); await checkpoint('vacuum');
    guard(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy === 0, 'SQLite is busy; keep services stopped and retry');
    await checkpoint('truncate:last');
    await checkpoint('scrubbed');
    db.exec('BEGIN IMMEDIATE'); transaction = true;
    lock.close(); lock = null; sync(state);
    await checkpoint('lock-released');
    hold.close(); hold = null; remove(holdPath);
    if (existsSync(preparing)) remove(preparing);
    // The wrapper's receipt must survive even a kill before CLI stdout or restore-state updates.
    if (opts.completion) {
      await replace(opts.completion, `${restore.slice(0, 5).join('\n')}\n${JSON.stringify({ v: 1, operation: m.operation, counts: publicPlan(m, true) })}\n`, `${opts.completion}.prepare`, checkpoint, 'completion');
    }
    remove(manifest); finished = true;
    await checkpoint('manifest-removed');
    await checkpoint('complete');
    return publicPlan(m, true);
  } catch (error) {
    // A validation refusal before changes must leave even lock metadata byte-identical.
    if (!error.forgetInterruption && !pending && !changed) {
      closeDb(); lock?.close(); lock = null; hold?.close(); hold = null;
      if (m) {
        remove(holdPath); remove(preparing); remove(manifest);
        for (const { path, stat, bytes } of initialScratch) {
          writeFileSync(path, bytes, { mode: stat.mode & 0o777 });
          chmodSync(path, stat.mode & 0o777);
          if (process.getuid() === 0) chownSync(path, stat.uid, stat.gid);
          sync(path); sync(dirname(path));
        }
      }
    }
    throw error;
  } finally {
    try { closeDb(); }
    finally {
      lock?.close(); if (lock) sync(state);
      hold?.close();
      // After a recoverable interruption the manifest and hold remain, with no live process lock.
      if (finished && existsSync(holdPath)) remove(holdPath);
    }
  }
}

export async function main(args = process.argv.slice(2), output = line => process.stdout.write(line)) {
  if (args.length === 1 && args[0] === '--help') {
    output('forget-tester --x-id NUMERIC_ID --handle HANDLE --api-db PATH --queue PATH --receipts PATH --sender-state PATH [--execute --services-stopped --operation UUID --completion PATH]\n'); return;
  }
  const { values } = parseArgs({ args, options: {
    'x-id': { type: 'string' }, handle: { type: 'string' }, 'api-db': { type: 'string' }, queue: { type: 'string' },
    receipts: { type: 'string' }, 'sender-state': { type: 'string' }, execute: { type: 'boolean', default: false },
    'services-stopped': { type: 'boolean', default: false }, operation: { type: 'string' }, completion: { type: 'string' },
  }, strict: true, allowPositionals: false });
  guard(['api-db', 'queue', 'receipts', 'sender-state'].every(k => typeof values[k] === 'string'), 'all state paths required');
  const result = await forgetTester({ xId: values['x-id'], handle: values.handle, dbPath: values['api-db'],
    queue: values.queue, receipts: values.receipts, state: values['sender-state'],
    operation: values.operation, completion: values.completion, execute: values.execute, servicesStopped: values['services-stopped'] });
  output(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && import.meta.url === (() => { try { return pathToFileURL(realpathSync(process.argv[1])).href; } catch { return ''; } })()) {
  main().catch(error => { process.stderr.write(`forget refused: ${error.forgetGuard ? error.message : 'state or file check failed; keep services stopped and reconcile'}\n`); process.exitCode = 1; });
}
