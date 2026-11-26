// Run only with API and sender stopped. SQLite's online backup folds committed WAL pages into one restore file.
import { DatabaseSync, backup } from 'node:sqlite';
import { constants, closeSync, chmodSync, chownSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const sync = path => { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
const guard = reason => Object.assign(new Error(reason), { code: 'BACKUP_GUARD', syscall: 'validate', reason });
const regular = path => { const s = lstatSync(path); if (!s.isFile() || s.isSymbolicLink()) throw guard('regular file required'); return s; };
const annotate = (step, error) => Object.assign(new Error('alpha backup refused'), {
  backupStep: error.backupStep ?? step, code: error.code, syscall: error.syscall, errcode: error.errcode, reason: error.reason,
});
const at = (step, work) => { try { return work(); } catch (error) { throw annotate(step, error); } };

// Only operation metadata is logged. Native/SQLite error messages can contain data; never print them.
export function refusalLine(error) {
  const steps = new Set([
    'arguments', 'validate inputs', 'create partial directory', 'create state directory',
    'lock withheld/pictures.json.lock', 'write withheld/pictures.json.lock',
    'close withheld/pictures.json.lock', 'rename withheld/pictures.json.lock',
    'validate state/alpha.sqlite', 'open state/alpha.sqlite read-only', 'backup state/alpha.sqlite',
    'restore owner state/alpha.sqlite-wal', 'restore owner state/alpha.sqlite-shm',
    'check restored state/alpha.sqlite', 'validate absent state/alpha.sqlite',
    'sync state', 'write manifest.json', 'sync snapshot', 'publish snapshot',
    ...['alpha', 'state', 'sender', 'withheld'].map(kind => `validate ${kind} directory`),
    ...['queue', 'receipts', 'sender', 'withheld'].flatMap(kind => [`list ${kind}`, `sync ${kind}`, `copy ${kind} files; count=1`]),
  ]);
  // Keep af1's neutral labels for configure/close SQLite; never accept arbitrary operation text.
  const safeStep = step => steps.has(step) ? step : 'file operation';
  const fields = e => `step=${JSON.stringify(safeStep(e.backupStep ?? 'arguments'))}; code=${JSON.stringify(e.code ?? 'ERR_BACKUP')}; syscall=${JSON.stringify(e.syscall ?? 'sqlite')}${e.errcode === undefined ? '' : `; sqliteCode=${JSON.stringify(e.errcode)}`}${e.reason ? `; reason=${JSON.stringify(e.reason)}` : ''}`;
  return `alpha backup refused; ${fields(error)}${error.cleanup ? `; cleanup: ${fields(error.cleanup)}` : ''}; partial copy retained\n`;
}

export async function snapshot({ alpha, sender, withheld, output, stopped = false, now = Date.now() }) {
  at('validate inputs', () => {
    if (!stopped || existsSync(output) || existsSync(`${output}.partial`)) throw guard('stopped services and new output required');
  });
  for (const [kind, dir] of [['alpha', alpha], ['state', join(alpha, 'state')], ['sender', sender], ['withheld', withheld]]) at(`validate ${kind} directory`, () => {
    const s = lstatSync(dir); if (!s.isDirectory() || s.isSymbolicLink()) throw guard('directory required');
  });
  const stage = `${output}.partial`, inventory = [];
  at('create partial directory', () => mkdirSync(stage, { mode: 0o700 }));
  const record = path => { regular(path); chmodSync(path, 0o600); sync(path);
    inventory.push({ path: path.slice(stage.length + 1), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }); };
  const tree = (source, target, omit = []) => {
    const label = target.slice(stage.length + 1);
    const names = at(`list ${label}`, () => {
      const directory = lstatSync(source);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw guard('directory required');
      mkdirSync(target, { mode: 0o700 });
      return readdirSync(source).sort();
    });
    for (const name of names) {
      if (omit.includes(name)) continue;
      at(`copy ${label} files; count=1`, () => {
        const from = join(source, name), to = join(target, name);
        regular(from);
        // fs.copyFileSync fails here: with CHOWN as the only capability it first gives the new file to the source's
        // owner, then sets the source's mode on a file root no longer owns, which needs FOWNER (EPERM, syscall copyfile).
        // The source open is not the cause. Read plus exclusive write keeps every copy root-owned with mode 0600.
        // Recheck the opened descriptor and disallow links even if the path changed after lstat.
        const input = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          if (!fstatSync(input).isFile()) throw guard('regular file required');
          writeFileSync(to, readFileSync(input), { flag: 'wx', mode: 0o600 });
        } finally { closeSync(input); }
        record(to);
      });
    }
    at(`sync ${label}`, () => sync(target));
  };
  // The same exclusive lock used by the withholding commands. Never back up a half-completed operator edit.
  const lock = join(withheld, 'pictures.json.lock');
  const fd = at('lock withheld/pictures.json.lock', () => openSync(lock, 'wx', 0o600));
  let failure;
  try {
    at('write withheld/pictures.json.lock', () => { writeFileSync(fd, 'alpha backup\n'); fsyncSync(fd); });
    tree(join(alpha, 'queue'), join(stage, 'queue'));
    tree(join(alpha, 'receipts'), join(stage, 'receipts'));
    tree(sender, join(stage, 'sender'));
    tree(withheld, join(stage, 'withheld'), ['pictures.json.lock', 'pictures.json.backup-lock']);
    at('create state directory', () => mkdirSync(join(stage, 'state'), { mode: 0o700 }));
    const source = join(alpha, 'state/alpha.sqlite');
    if (existsSync(source)) {
      const owner = at('validate state/alpha.sqlite', () => {
        const owner = regular(source);
        for (const suffix of ['-wal', '-shm']) if (existsSync(source + suffix)) regular(source + suffix);
        return owner;
      });
      // Group read access suffices for the database and existing 0640 WAL/SHM. The 2770 parent
      // permits SQLite to create missing sidecars. Never open the source database for writing.
      const db = at('open state/alpha.sqlite read-only', () => new DatabaseSync(source, { readOnly: true }));
      let sqliteFailure;
      try {
        at('configure SQLite backup', () => db.exec('PRAGMA busy_timeout=5000;'));
        await at('backup state/alpha.sqlite', () => backup(db, join(stage, 'state/alpha.sqlite'))).catch(error => { throw annotate('backup state/alpha.sqlite', error); });
      } catch (error) { sqliteFailure = error; }
      finally {
        try { at('close source SQLite', () => db.close()); } catch (error) { sqliteFailure ??= error; }
        for (const suffix of ['-wal', '-shm']) {
          try {
            at(`restore owner state/alpha.sqlite${suffix}`, () => {
              if (!existsSync(source + suffix)) return;
              const sidecar = regular(source + suffix);
              // Newly created sidecars belong to this process: chmod BEFORE giving them away.
              // Existing service-owned 0640 sidecars already match; no FOWNER capability needed.
              if ((sidecar.mode & 0o777) !== (owner.mode & 0o777)) chmodSync(source + suffix, owner.mode & 0o777);
              if (process.getuid() === 0 && (sidecar.uid !== owner.uid || sidecar.gid !== owner.gid)) chownSync(source + suffix, owner.uid, owner.gid);
            });
          } catch (error) { sqliteFailure ??= error; }
        }
      }
      if (sqliteFailure) throw sqliteFailure;
      at('check restored state/alpha.sqlite', () => {
        const check = new DatabaseSync(join(stage, 'state/alpha.sqlite'));
        try {
          if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw guard('SQLite integrity check failed');
          check.exec('PRAGMA journal_mode=DELETE;');
        } finally { check.close(); }
        record(join(stage, 'state/alpha.sqlite'));
      });
    } else at('validate absent state/alpha.sqlite', () => {
      if (readdirSync(join(alpha, 'state')).some(n => n.startsWith('alpha.sqlite'))) throw guard('orphan SQLite sidecar');
    });
    at('sync state', () => sync(join(stage, 'state')));
    at('write manifest.json', () => {
      writeFileSync(join(stage, 'manifest.json'), JSON.stringify({ v: 1, at: new Date(now).toISOString(),
        sqlite: existsSync(source), files: inventory }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      sync(join(stage, 'manifest.json'));
    });
    at('sync snapshot', () => sync(stage));
  } catch (error) { failure = error; }
  finally {
    for (const [step, work] of [
      ['close withheld/pictures.json.lock', () => closeSync(fd)],
      ['rename withheld/pictures.json.lock', () => { renameSync(lock, join(withheld, 'pictures.json.backup-lock')); sync(withheld); }],
    ]) {
      try { at(step, work); }
      catch (error) { if (failure) failure.cleanup ??= error; else failure = error; }
    }
  }
  if (failure) throw failure;
  at('publish snapshot', () => { renameSync(stage, output); sync(resolve(output, '..')); });
  return inventory;
}

// The real path of the started file: through a linked path (a release folder behind a `current` link) a plain
// resolve() never equals import.meta.url, and the backup would silently do nothing (scripts/test/entry-points.test.mjs).
const started = () => { try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } };
if (started()) {
  try {
    const [flag, output, ...extra] = process.argv.slice(2);
    if (flag !== '--services-stopped' || !output || extra.length) throw guard('expected --services-stopped and an output path');
    await snapshot({ alpha: '/alpha', sender: '/sender', withheld: '/withheld', output, stopped: true });
    process.stdout.write('alpha backup complete; SQLite checked\n');
  } catch (error) { process.stderr.write(refusalLine(error)); process.exitCode = 1; }
}
