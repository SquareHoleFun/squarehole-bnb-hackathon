import { closeSync, fchmodSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_PICTURES_FILE, parsePictures, validPictureId, validReason } from '../../../packages/indexer/src/withheld/list.mjs';

/** Operator-only, local file changes. No content retrieval, list dumps or notice text. */
function edit(args) {
  const [command, ...input] = args;
  const dry = input[0] === '--dry-run';
  const values = dry ? input.slice(1) : input;
  const [id, reason] = values;
  if (!['add', 'remove'].includes(command) || values.length !== (command === 'add' ? 2 : 1)
    || !validPictureId(id) || (command === 'add' && !validReason(reason))) throw new Error('invalid arguments');
  const file = process.env.SH_WITHHELD_FILE || DEFAULT_PICTURES_FILE;
  const lock = `${file}.lock`;
  let locked = false;
  try {
    if (!dry) {
      const fd = openSync(lock, 'wx', 0o600);
      locked = true;
      try { writeFileSync(fd, `${process.pid}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    }
    let entries;
    try { entries = parsePictures(readFileSync(file, 'utf8')); }
    catch (error) { if (error?.code === 'ENOENT') entries = []; else throw error; }
    const found = entries.find(entry => entry.id === id);
    const changed = command === 'add' ? !found || found.reason !== reason : found !== undefined;
    if (dry) {
      process.stdout.write(changed ? `Would ${command} ${id}${reason ? ` (${reason})` : ''}.\n` : 'No change needed.\n');
      return;
    }
    if (!changed) { process.stdout.write('No change needed.\n'); return; }
    const next = entries.filter(entry => entry.id !== id);
    if (command === 'add') next.push({ id, reason, since: new Date().toISOString() });
    const temporary = join(dirname(file), `.pictures-${randomUUID()}.pending`);
    const fd = openSync(temporary, 'wx', 0o644);
    try { fchmodSync(fd, 0o644); writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file);
    const parent = openSync(dirname(file), 'r');
    try { fsyncSync(parent); } finally { closeSync(parent); }
    process.stdout.write(command === 'add' ? 'Added one entry.\n' : 'Removed one entry.\n');
  } finally {
    // Preserve the lock record. A crash retains .lock and requires operator reconciliation.
    if (locked) renameSync(lock, `${file}.last-lock`);
  }
}
try { edit(process.argv.slice(2)); }
catch {
  process.stderr.write('Withheld update refused: check arguments, list validity, permissions and lock; no list printed.\n');
  process.exitCode = 1;
}
