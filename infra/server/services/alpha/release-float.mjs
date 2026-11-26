import { realpathSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { getAddress, SEPOLIA } from './sender/chain.mjs';
import { readBounded, openStore, validateJournal, atomicWrite, uuid } from './sender/store.mjs';
import { validateClaim } from './sender/engine.mjs';
import { receipt } from './files.mjs';
import { FLOAT_REASON } from './sender/settings.mjs';

const requireProof = ok => { if (!ok) throw new Error('unsigned float release proof refused'); };
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const readJournal = (state, mode, identity) => {
  const file = join(state, mode === 'live' ? 'journal.json' : 'journal.dry.json');
  try { return validateJournal(JSON.parse(readBounded(file, 32 * 1024 * 1024)), `${identity}:${mode}`); }
  catch (error) { if (mode === 'dry-run' && error.code === 'ENOENT') return null; throw error; }
};

/** One historical no-send outcome only. No RPC, key, signing, queue rewrite or receipt deletion. */
export async function releaseFloat({ id, dbPath, queue, receipts, state, address, teth,
  execute = false, servicesStopped = false, reviewed }, { checkpoint = () => {} } = {}) {
  requireProof(typeof id === 'string' && uuid.test(id));
  requireProof(!execute || (servicesStopped && typeof reviewed === 'string' && /^[a-f0-9]{64}$/.test(reviewed)));
  const identity = `${SEPOLIA}:${getAddress(address)}:${getAddress(teth)}`;
  // Refuse missing databases and symlinks, rather than letting SQLite create a replacement history.
  requireProof(lstatSync(dbPath).isFile());
  const db = new DatabaseSync(dbPath, { readOnly: !execute, allowExtension: false });
  let lock, transaction = false;
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
    // The live journal must exist even when inspecting a dry-run outcome. An absent signing history is not proof.
    const live = readJournal(state, 'live', identity), dry = readJournal(state, 'dry-run', identity);
    if (execute) {
      lock = openStore(state, `${identity}:live`, 'live');
      db.exec('BEGIN IMMEDIATE'); transaction = true;
    }
    const row = db.prepare('SELECT * FROM claims WHERE id = ?').get(id);
    requireProof(row?.reserved === 1 && row.published === 1);
    const payload = readBounded(join(queue, `${id}.json`), 16384);
    requireProof(payload.trim() === row.payload);
    const claim = JSON.parse(payload);
    requireProof(await validateClaim(claim, id) === null && claim.xId === row.xId && claim.address.toLowerCase() === row.address.toLowerCase());
    const outcome = receipt(receipts, id);
    requireProof(outcome && ['refused', 'failed'].includes(outcome.status) && outcome.reason === FLOAT_REASON
      && outcome.admitTx === null && outcome.sendTx === null);
    const journals = [['live', live], ['dry-run', dry]].filter(([, journal]) => journal);
    const matches = journals.flatMap(([mode, journal]) => journal.entries.filter(e => e.id === id).map(entry => ({ mode, journal, entry })));
    requireProof(matches.length === 1);
    const { mode, journal, entry } = matches[0];
    requireProof(!Object.hasOwn(entry, 'admit') && !Object.hasOwn(entry, 'send')
      && JSON.stringify(entry.outcome) === JSON.stringify(outcome));
    // Unknown fields could carry signing evidence from another release. Fail closed rather than discard them.
    const allowed = ['id', 'reserved', 'xId', 'address', 'days', 'needsAdmit', 'quote', 'outcome', 'floatRelease'];
    requireProof(Object.keys(entry).every(key => allowed.includes(key)));
    if (entry.reserved) requireProof(entry.xId === claim.xId && entry.address.toLowerCase() === claim.address.toLowerCase());
    if (entry.floatRelease) requireProof(entry.floatRelease.reason === FLOAT_REASON && entry.reserved === false);
    // No other accepted attempt for this identity or wallet in either history, and no conflicting API reservation.
    for (const [, j] of journals) requireProof(!j.entries.some(e => e.id !== id
      && (e.reserved || e.admit || e.send || e.outcome?.status === 'sent')
      && (e.xId === claim.xId || e.address?.toLowerCase() === claim.address.toLowerCase())));
    requireProof(!db.prepare('SELECT id FROM claims WHERE id <> ? AND reserved = 1 AND (xId = ? OR address = ? COLLATE NOCASE)').get(id, row.xId, row.address));
    const review = fingerprint({ row, payload, outcome, live, dry });
    const plan = { claimId: id, journal: mode, action: 'release unsigned float outcome; request a fresh signed claim', review };
    if (!execute) return { ...plan, executed: false };
    requireProof(reviewed === review);
    // Re-read under both locks: a concurrent sender/API update invalidates the reviewed plan.
    requireProof(fingerprint(readJournal(state, 'live', identity)) === fingerprint(live)
      && fingerprint(readJournal(state, 'dry-run', identity)) === fingerprint(dry));
    const released = { id, reserved: false, outcome,
      floatRelease: entry.floatRelease ?? { reason: FLOAT_REASON, review, at: new Date().toISOString() } };
    journal.entries[journal.entries.indexOf(entry)] = released;
    validateJournal(journal, `${identity}:${mode}`);
    // Release the sender first. A crash here leaves the API reservation held. A new reviewed plan safely finishes it.
    atomicWrite(join(state, mode === 'live' ? 'journal.json' : 'journal.dry.json'), journal);
    await checkpoint('sender-released');
    const result = db.prepare('UPDATE claims SET reserved = 0 WHERE id = ? AND reserved = 1 AND payload = ?').run(id, row.payload);
    requireProof(result.changes === 1);
    db.exec('COMMIT'); transaction = false;
    return { ...plan, executed: true };
  } finally {
    if (transaction) db.exec('ROLLBACK');
    db.close(); lock?.close();
  }
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    'claim-id': { type: 'string' }, 'api-db': { type: 'string' }, queue: { type: 'string' }, receipts: { type: 'string' },
    'sender-state': { type: 'string' }, 'desk-address': { type: 'string' }, teth: { type: 'string' },
    execute: { type: 'boolean', default: false }, 'services-stopped': { type: 'boolean', default: false }, reviewed: { type: 'string' },
  }, strict: true, allowPositionals: false });
  const required = ['claim-id', 'api-db', 'queue', 'receipts', 'sender-state', 'desk-address', 'teth'];
  requireProof(required.every(key => typeof values[key] === 'string' && values[key].length));
  const result = await releaseFloat({ id: values['claim-id'], dbPath: values['api-db'], queue: values.queue,
    receipts: values.receipts, state: values['sender-state'], address: values['desk-address'], teth: values.teth,
    execute: values.execute, servicesStopped: values['services-stopped'], reviewed: values.reviewed });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && import.meta.url === (() => { try { return pathToFileURL(realpathSync(process.argv[1])).href; } catch { return ''; } })()) {
  main().catch(() => { process.stderr.write('float release refused; check stopped services, complete histories and the reviewed plan\n'); process.exitCode = 1; });
}
