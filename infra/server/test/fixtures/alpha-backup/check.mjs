// Docker-only fixture actions, plus a source-only plan. Never mounts installed state or settings.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const action = process.argv[2];
const sha = data => createHash('sha256').update(data).digest('hex');
const dbPath = '/alpha/state/alpha.sqlite';
const files = {
  'queue/q1.json': 'queue fixture\n', 'receipts/r1.json': 'receipt fixture\n',
  'sender/journal.json': 'sender fixture\n', 'sender/sender.lock': 'sender retained marker\n',
};
// The backup's own lock and its leftover marker in withheld/ are never snapshot data (SH-210 af1).
const markers = /(^|\/)pictures\.json\.(lock|backup-lock)$/;
// A file mode is read from the service source that sets it, with a pattern that must match exactly once.
// If the source changes shape, the fixture fails here instead of checking a stale constant.
const pinnedMode = (text, pattern, what) => {
  const found = [...text.matchAll(new RegExp(pattern, 'g'))];
  assert.equal(found.length, 1, `${what}: the source pattern ${pattern} no longer matches exactly once; update the fixture`);
  return parseInt(found[0][1], 8);
};
export function sourcePlan() {
  const install = readFileSync('infra/server/install.sh', 'utf8');
  const compose = readFileSync('infra/server/compose.yaml', 'utf8');
  const server = readFileSync('infra/server/services/alpha/server.mjs', 'utf8');
  const senderSource = file => readFileSync(`infra/server/services/alpha/sender/${file}`, 'utf8');
  const user = name => {
    const block = compose.split(`\n  ${name}:\n`)[1]?.split(/\n {2}[\w-]+:\n/)[0];
    const match = block?.match(/^ {4}user: "(\d+):(\d+)"$/m);
    assert.ok(match, `explicit Compose user required for ${name}`);
    return match.slice(1).map(Number);
  };
  assert.deepEqual(user('alpha-api'), [0, 0]);
  const apiUid = Number(server.match(/process\.setuid\((\d+)\)/)?.[1]);
  const apiGid = Number(server.match(/process\.setgid\((\d+)\)/)?.[1]);
  const readGid = Number(server.match(/process\.setgroups\(\[(\d+)\]\)/)?.[1]);
  assert.ok(apiUid && apiGid && readGid, 'explicit API privilege drop required');
  const dirs = {};
  for (const line of install.split('\n')) {
    const m = line.match(/^install -d -m (0?[0-7]{3,4}) -o root -g (root|\d+) (.+)$/);
    if (!m) continue;
    for (const [target, source] of Object.entries({ '/alpha': '$base/alpha', '/alpha/state': '$base/alpha/state',
      '/alpha/queue': '$base/alpha/queue', '/alpha/receipts': '$base/alpha/receipts',
      '/withheld': '$base/withheld', '/backup': '/var/backups/squarehole' })) {
      if (m[3].split(' ').some(word => word.replaceAll('"', '') === source)) dirs[target] = { uid: 0, gid: m[2] === 'root' ? 0 : Number(m[2]), mode: parseInt(m[1], 8) };
    }
  }
  assert.equal(Object.keys(dirs).length, 6, 'installer directory commands changed');
  assert.ok(install.includes(`setfacl -m u:${apiUid}:rwx "$base/alpha/queue"`), 'review queue ACL changes');
  // setfacl gives the queue a rwx mask, visible as group bits in stat (2770 on the server).
  // This fixture checks the backup's read access. It does not exercise the API writer ACL.
  dirs['/alpha/queue'].mode |= 0o070;
  assert.equal(dirs['/alpha/state'].gid, apiGid);
  assert.equal(dirs['/alpha/queue'].gid, readGid);
  const sender = user('alpha-sender');
  assert.equal(sender[0], 0);
  assert.equal(sender[1], readGid);
  assert.match(compose.split('\n  alpha-sender:\n')[1].split(/\n {2}[\w-]+:\n/)[0], /nocopy: true/);
  // nocopy makes a root-owned volume; alpha-sender.mjs sets its mode on startup.
  const senderFolder = pinnedMode(readFileSync('infra/server/services/alpha-sender.mjs', 'utf8'), 'fchmodSync\\(stateFd, 0o([0-7]{3,4})\\)', 'sender state folder mode');
  dirs['/sender'] = { uid: sender[0], gid: 0, mode: senderFolder };
  const modes = {
    // The API publishes queue files with this mode; its process umask gives the database and its sidecars 0666 minus the mask.
    queue: pinnedMode(readFileSync('infra/server/services/alpha/files.mjs', 'utf8'), "openSync\\(temporary, 'wx', 0o([0-7]{3,4})\\)", 'API queue file mode'),
    database: 0o666 & ~pinnedMode(server, 'process\\.umask\\(0o([0-7]{3,4})\\)', 'API process umask'),
    receipt: pinnedMode(senderSource('engine.mjs'), 'atomicWrite\\(receiptPath\\(e\\.id\\), e\\.outcome, 0o([0-7]{3,4})\\)', 'sender receipt mode'),
    senderState: pinnedMode(senderSource('store.mjs'), 'export function atomicWrite\\(file, value, mode = 0o([0-7]{3,4})\\)', 'sender journal mode'),
    senderLock: pinnedMode(senderSource('store.mjs'), "openSync\\(lock, 'wx', 0o([0-7]{3,4})\\)", 'sender lock mode'),
  };
  return { dirs, apiUid, apiGid, readGid, sender, modes };
}

// The real path of the started file, as scripts/test/entry-points.test.mjs requires.
const started = () => { try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } };
if (started()) {
  if (action === 'plan') process.stdout.write(JSON.stringify(sourcePlan()) + '\n');
  else {
    const plan = JSON.parse(readFileSync('/plan.json', 'utf8'));
    const put = (path, data, mode) => writeFileSync(path, data, { flag: 'wx', mode });
    if (action === 'setup') {
      for (const [path, { uid, gid, mode }] of Object.entries(plan.dirs)) {
        mkdirSync(path, { recursive: true }); chownSync(path, uid, gid); chmodSync(path, mode);
      }
    } else if (action === 'seed-api') {
      assert.equal(process.getuid(), plan.apiUid);
      assert.equal(process.getgid(), plan.apiGid);
      put('/alpha/queue/q1.json', files['queue/q1.json'], plan.modes.queue);
      // A killed writer leaves committed pages in the WAL, like a stopped service after a crash.
      const child = spawn(process.execPath, [process.argv[1], 'wal-writer'], { stdio: ['ignore', 'pipe', 'inherit'] });
      child.stdout.once('data', () => child.kill('SIGKILL'));
      const signal = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code, signal) => code === null ? resolve(signal) : reject(new Error(`writer exited ${code}`))); });
      assert.equal(signal, 'SIGKILL');
      assert.ok(statSync(dbPath + '-wal').size > 0);
      for (const suffix of ['', '-wal', '-shm']) chmodSync(dbPath + suffix, plan.modes.database);
      // Force the backup reader to create SHM, then prove it hands it back before the second read.
      unlinkSync(dbPath + '-shm');
    } else if (action === 'seed-clean') {
      // The usual nightly state: the service user's last connection closes cleanly, so SQLite removes -wal and -shm.
      assert.equal(process.getuid(), plan.apiUid);
      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE);');
      db.close();
      for (const suffix of ['-wal', '-shm']) assert.ok(!existsSync(dbPath + suffix), `${suffix} must be gone after a clean close`);
      const s = statSync(dbPath);
      assert.deepEqual([s.uid, s.gid, s.mode & 0o777], [plan.apiUid, plan.apiGid, plan.modes.database]);
    } else if (action === 'rw-check') {
      // The API's identity must still write its own database after the backups.
      assert.deepEqual([process.getuid(), process.getgid()], [plan.apiUid, plan.apiGid]);
      assert.ok(process.getgroups().includes(plan.readGid));
      const owned = suffix => {
        if (!existsSync(dbPath + suffix)) return;
        const s = statSync(dbPath + suffix);
        assert.deepEqual([s.uid, s.gid, s.mode & 0o777], [plan.apiUid, plan.apiGid, plan.modes.database], `database${suffix}`);
      };
      for (const suffix of ['', '-wal', '-shm']) owned(suffix);
      const db = new DatabaseSync(dbPath);
      try {
        db.exec("INSERT INTO claims VALUES('written-after-backup');");
        // node:sqlite rows have no prototype, so a strict comparison with object literals fails: compare the values.
        assert.deepEqual(db.prepare("SELECT id FROM claims WHERE id = 'written-after-backup'").all().map(row => row.id), ['written-after-backup']);
        for (const suffix of ['', '-wal', '-shm']) owned(suffix);
      } finally { db.close(); }
      process.stdout.write('alpha api write after backup checked\n');
    } else if (action === 'wal-writer') {
      const db = new DatabaseSync(dbPath);
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE claims(id TEXT); INSERT INTO claims VALUES('committed-in-wal');");
      process.stdout.write('wal ready\n');
      setInterval(() => {}, 1000);
    } else if (action === 'seed-sender') {
      assert.deepEqual([process.getuid(), process.getgid()], plan.sender);
      put('/alpha/receipts/r1.json', files['receipts/r1.json'], plan.modes.receipt);
      put('/sender/journal.json', files['sender/journal.json'], plan.modes.senderState);
      put('/sender/sender.lock', files['sender/sender.lock'], plan.modes.senderLock);
    } else if (action === 'control') {
      const source = readFileSync('/check/parent-backup.mjs.txt');
      assert.equal(sha(source), '6bd081bf1b9a00748c7f257bffb1791b7cc88cab8bb31a040bfbc63656d3cac2');
      const { snapshot } = await import(`data:text/javascript;base64,${source.toString('base64')}`);
      try {
        await snapshot({ alpha: '/alpha', sender: '/sender', withheld: '/withheld', output: '/backup/alpha-control', stopped: true });
        throw new Error('parent unexpectedly passed');
      } catch (error) {
        assert.equal(error.code, 'EPERM'); assert.equal(error.syscall, 'copyfile');
        assert.equal(error.path, '/alpha/queue/q1.json');
        assert.ok(existsSync('/backup/alpha-control.partial/queue'));
        assert.ok(!existsSync('/backup/alpha-control'));
        assert.ok(existsSync('/withheld/pictures.json.backup-lock'));
        process.stderr.write('alpha backup control refused; code=EPERM; syscall=copyfile; path=/alpha/queue/q1.json\n');
        process.exitCode = 1;
      }
    } else if (action === 'verify' || action === 'verify-clean') {
      const clean = action === 'verify-clean';
      const proc = readFileSync('/proc/self/status', 'utf8');
      assert.match(proc, /^CapEff:\s+0*1$/m); // CHOWN only; notably no FOWNER or DAC override.
      assert.match(proc, /^NoNewPrivs:\s+1$/m);
      assert.deepEqual([process.getuid(), process.getgid()], [0, plan.apiGid]);
      assert.ok(process.getgroups().includes(plan.readGid));
      assert.throws(() => { const fd = openSync('/sender/journal.json', 'r+'); closeSync(fd); }, { code: 'EROFS' });
      assert.ok(!existsSync('/withheld/pictures.json'));
      assert.ok(!existsSync('/withheld/pictures.json.lock'));
      for (const [path, owner] of Object.entries({
        '/alpha/queue/q1.json': [plan.apiUid, plan.readGid, plan.modes.queue],
        '/alpha/receipts/r1.json': [...plan.sender, plan.modes.receipt],
        '/sender/journal.json': [...plan.sender, plan.modes.senderState], '/sender/sender.lock': [...plan.sender, plan.modes.senderLock],
        '/withheld/pictures.json.backup-lock': [0, plan.apiGid, 0o600],
      })) {
        const s = statSync(path);
        assert.deepEqual([s.uid, s.gid, s.mode & 0o777], owner, path);
      }
      for (const [path, expected] of Object.entries(plan.dirs)) {
        const actual = statSync(path);
        assert.deepEqual({ uid: actual.uid, gid: actual.gid, mode: actual.mode & 0o7777 }, expected, path);
      }
      for (const suffix of ['', '-wal', '-shm']) {
        // After a clean close the backup's reader creates the sidecars; the hand-back must leave them with the service user.
        if (clean && suffix && !existsSync(dbPath + suffix)) continue;
        const s = statSync(dbPath + suffix);
        assert.deepEqual([s.uid, s.gid, s.mode & 0o777], [plan.apiUid, plan.apiGid, plan.modes.database], suffix);
      }
      for (const name of process.argv.slice(3)) {
        const output = `/backup/${name}`;
        assert.ok(!existsSync(output + '.partial'));
        const manifest = JSON.parse(readFileSync(`${output}/manifest.json`, 'utf8'));
        assert.equal(manifest.sqlite, true);
        const expectedPaths = [...Object.keys(files), 'state/alpha.sqlite'].sort();
        assert.deepEqual(manifest.files.map(f => f.path).sort(), expectedPaths);
        const diskPaths = readdirSync(output, { recursive: true }).filter(p => statSync(`${output}/${p}`).isFile()).sort();
        assert.deepEqual(diskPaths, [...expectedPaths, 'manifest.json'].sort());
        assert.deepEqual([...manifest.files.map(f => f.path), ...diskPaths].filter(p => markers.test(p)), [], 'no lock or marker in a snapshot');
        for (const f of manifest.files) {
          const bytes = readFileSync(`${output}/${f.path}`);
          assert.equal(f.sha256, sha(bytes), f.path);
          if (f.path in files) assert.equal(f.sha256, sha(files[f.path]), f.path);
        }
        for (const p of ['', ...readdirSync(output, { recursive: true })]) {
          const s = statSync(`${output}/${p}`);
          assert.equal(s.mode & 0o777, s.isDirectory() ? 0o700 : 0o600, p);
        }
        const db = new DatabaseSync(`${output}/state/alpha.sqlite`, { readOnly: true });
        try {
          // Rows of node:sqlite have no prototype (first real container run, 13 November 2026): compare the values.
          assert.deepEqual(db.prepare('SELECT id FROM claims').all().map(row => row.id), ['committed-in-wal']);
          assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
        } finally { db.close(); }
      }
      process.stdout.write('alpha backup fixtures verified\n');
    } else throw new Error(`unknown fixture action: ${action}`);
  }
}
