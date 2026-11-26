// Isolated image permissions rehearsal. Only /alpha/forget-case and /sender/forget-case fixture paths.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, chmodSync, chownSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from './store.mjs';
const root = '/alpha/forget-case', state = '/sender/forget-case', dbPath = `${root}/state/alpha.sqlite`;
const id = '00000000-0000-4000-8000-000000000001', xId = '217', at = '2026-11-14T00:00:00.000Z';
const file = (path, value, uid, gid) => { writeFileSync(path, JSON.stringify(value), { mode: 0o640 }); chownSync(path, uid, gid); };
const [action] = process.argv.slice(2);
if (action === 'seed') {
  for (const [path, gid, mode] of [[root, 2103, 0o750], [`${root}/state`, 2101, 0o2770],
    [`${root}/queue`, 2103, 0o2750], [`${root}/receipts`, 2103, 0o2750], [state, 0, 0o700]]) {
    mkdirSync(path); chownSync(path, 0, gid); chmodSync(path, mode);
  }
  const db = openStore(dbPath), payload = { id, xId, address: '0x' + '11'.repeat(20) };
  db.run('INSERT INTO signups VALUES(?,?,?,?,?,?,?,?)', xId, 'did:privy:fixture', 'image_fixture', 'Fixture', null, 'approved', at, at);
  db.run('INSERT INTO claims VALUES(?,?,?,?,?,?,?)', id, xId, payload.address, JSON.stringify(payload), at, 1, 1); db.close();
  chmodSync(dbPath, 0o640); chownSync(dbPath, 2101, 2101);
  const outcome = { v: 1, id, status: 'skipped', admitTx: null, sendTx: null, reason: 'dry run; no transactions', at };
  file(`${root}/queue/${id}.json`, payload, 2101, 2103); file(`${root}/receipts/${id}.json`, outcome, 0, 2103);
  file(`${state}/journal.dry.json`, { v: 1, identity: `11155111:0x${'22'.repeat(20)}:0x${'33'.repeat(20)}:dry-run`, entries: [{ id, reserved: false, outcome }] }, 0, 0);
  chmodSync(`${state}/journal.dry.json`, 0o600);
  writeFileSync(`${root}/alpha-forget.restore`, ['inactive', 'inactive', 'inactive', '00000000-0000-4000-8000-000000000217', createHash('sha256').update(`${xId}\nimage_fixture\n`).digest('hex')].join('\n') + '\n', { mode: 0o600 });
} else if (action === 'verify') {
  const db = new DatabaseSync(dbPath);
  try { assert.equal(db.prepare('SELECT count(*) AS n FROM signups').get().n, 0); assert.equal(db.prepare('SELECT count(*) AS n FROM forget_audit').get().n, 1); }
  finally { db.close(); }
  assert.equal(existsSync(`${root}/receipts/forget-tester.json`), false);
  assert.deepEqual(readdirSync(`${root}/queue`), []); assert.deepEqual(readdirSync(`${root}/receipts`), []);
  for (const name of readdirSync(`${root}/state`)) { const s = statSync(join(root, 'state', name)); assert.equal(s.uid, 2101); assert.equal(s.gid, 2101); }
} else if (action === 'api-write') {
  assert.equal(process.getuid(), 2101);
  const db = openStore(dbPath);
  try { db.run('INSERT INTO signups VALUES(?,?,?,?,?,?,?,?)', xId, 'did:privy:fresh', 'image_fixture', 'Fresh', null, 'pending', at, at);
    assert.equal(db.get('SELECT status FROM signups WHERE xId = ?', xId).status, 'pending'); }
  finally { db.close(); }
} else throw new Error('fixture action required');
process.stdout.write(`alpha forget image ${action} checked\n`);
