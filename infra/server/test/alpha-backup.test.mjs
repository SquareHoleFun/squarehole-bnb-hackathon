import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
const { snapshot, refusalLine } = await import(process.env.SH_FORGET_BACKUP_MODULE ?? new URL('../services/alpha/backup.mjs', import.meta.url).href);
import { latestAlphaBackup } from '../monitor/collect.mjs';
import { shLimit } from '../../../vitest.timeouts.mjs';

function fixture() {
  mkdirSync('.cache/tmp', { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp/alpha-backup-'));
  const alpha = join(root, 'alpha'), sender = join(root, 'sender'), withheld = join(root, 'withheld');
  for (const dir of [alpha, sender, withheld, join(alpha, 'state'), join(alpha, 'queue'), join(alpha, 'receipts')]) mkdirSync(dir);
  const db = new DatabaseSync(join(alpha, 'state/alpha.sqlite'));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE claims(id TEXT); INSERT INTO claims VALUES('committed-in-wal');");
  for (const [path, text] of [[join(alpha, 'queue/claim.json'), 'queue'], [join(alpha, 'receipts/claim.progress.json'), 'waiting'],
    [join(sender, 'journal.json'), 'signed bytes'], [join(sender, 'journal.dry.json'), 'dry history'], [join(sender, 'sender.lock'), 'retained lock'],
    [join(withheld, 'pictures.json'), '[]'], [join(withheld, 'pictures.json.last-lock'), 'operator history']]) writeFileSync(path, text);
  return { root, alpha, sender, withheld, db, output: join(root, 'alpha-20261111T000000Z'), stopped: true, now: Date.parse('2026-11-11T00:00:00Z') };
}

it('backs up committed WAL with SQLite, restores independently, and retains queue, receipts, both journals and withholding', async () => {
  const f = fixture();
  try {
    expect(statSync(join(f.alpha, 'state/alpha.sqlite-wal')).size).toBeGreaterThan(0);
    // Uncommitted data must not escape into a backup. Other stores are quiescent as required by the wrapper.
    f.db.exec("BEGIN; INSERT INTO claims VALUES('uncommitted');");
    // Use a second connection for the snapshot: it sees only committed WAL pages.
    const inventory = await snapshot(f);
    f.db.exec('ROLLBACK');
    const restored = new DatabaseSync(join(f.output, 'state/alpha.sqlite'));
    try { expect(restored.prepare('SELECT id FROM claims').all()).toEqual([{ id: 'committed-in-wal' }]); }
    finally { restored.close(); }
    expect(inventory.map(f => f.path)).toEqual(expect.arrayContaining(['queue/claim.json', 'receipts/claim.progress.json',
      'sender/journal.json', 'sender/journal.dry.json', 'sender/sender.lock', 'withheld/pictures.json', 'withheld/pictures.json.last-lock', 'state/alpha.sqlite']));
    expect(existsSync(join(f.output, 'state/alpha.sqlite-wal'))).toBe(false);
    expect(readFileSync(join(f.output, 'sender/journal.json'), 'utf8')).toBe('signed bytes');
    expect(statSync(f.output).mode & 0o777).toBe(0o700);
    expect(inventory.every(file => (statSync(join(f.output, file.path)).mode & 0o777) === 0o600)).toBe(true);
    expect(await latestAlphaBackup(f.root)).toEqual({ modifiedAt: String(f.now / 1000) });
  } finally { f.db.close(); }
});

it('refuses running services, overwrite, symlinks and a withholding writer; partial copies never look completed', async () => {
  const f = fixture();
  try {
    await expect(snapshot({ ...f, stopped: false })).rejects.toThrow();
    writeFileSync(join(f.withheld, 'pictures.json.lock'), 'writer');
    await expect(snapshot(f)).rejects.toThrow();
    expect(existsSync(f.output)).toBe(false);
    await expect(latestAlphaBackup(f.root)).rejects.toThrow();
    await expect(snapshot(f)).rejects.toThrow();
    const other = fixture();
    try {
      symlinkSync(join(other.sender, 'journal.json'), join(other.alpha, 'queue/link'));
      await expect(snapshot(other)).rejects.toThrow();
      expect(existsSync(other.output)).toBe(false);
    } finally { other.db.close(); }
  } finally { f.db.close(); }
});

it('nightly installation invokes the stopped-service wrapper with no credentials or network in its backup container', () => {
  const wrapper = readFileSync('infra/server/alpha-backup.sh', 'utf8');
  expect(wrapper).toContain('docker compose stop --timeout 60 alpha-api alpha-sender');
  expect(wrapper).toContain('trap resume EXIT');
  // The installed wrapper sources its flags from the installed copy, not from the current release (SH-210 af2).
  expect(wrapper).toContain('source /usr/local/sbin/squarehole-alpha-backup-flags.sh\n');
  expect(wrapper).not.toMatch(/source \.\//);
  expect(readFileSync('infra/server/alpha-backup-flags.sh', 'utf8')).toContain('--network none');
  expect(wrapper).not.toContain('/etc/squarehole');
  expect(readFileSync('infra/server/pg-backup.sh', 'utf8')).toContain('/usr/local/sbin/squarehole-alpha-backup');
  expect(readFileSync('infra/server/install.sh', 'utf8')).toContain('"$release/infra/server/alpha-backup.sh" /usr/local/sbin/squarehole-alpha-backup');
});


it('repeats successfully with no pictures.json, excludes backup markers, and keeps complete hashes and private outputs', async () => {
  const f = fixture();
  // Use a fresh empty withholding folder; an uninitialized list is valid on the server.
  f.withheld = join(f.root, 'empty-withheld'); mkdirSync(f.withheld);
  try {
    for (const suffix of ['-first', '-second']) {
      const output = f.output + suffix;
      const files = await snapshot({ ...f, output });
      const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
      expect(manifest.files).toEqual(files);
      for (const file of files) {
        expect(file.sha256).toBe(createHash('sha256').update(readFileSync(join(output, file.path))).digest('hex'));
        expect(statSync(join(output, file.path)).mode & 0o777).toBe(0o600);
      }
      expect(existsSync(join(f.withheld, 'pictures.json.lock'))).toBe(false);
      expect(readFileSync(join(f.withheld, 'pictures.json.backup-lock'), 'utf8')).toBe('alpha backup\n');
      expect(existsSync(output + '.partial')).toBe(false);
      for (const marker of ['pictures.json.lock', 'pictures.json.backup-lock']) {
        expect(files.some(f => f.path === `withheld/${marker}`)).toBe(false);
        expect(existsSync(join(output, 'withheld', marker))).toBe(false);
      }
    }
  } finally { f.db.close(); }
});

it('refusals name the step and system call on one line, never the error message or file contents', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.withheld, 'pictures.json.lock'), 'private operator text');
    let caught;
    try { await snapshot(f); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: 'EEXIST', syscall: 'open', backupStep: 'lock withheld/pictures.json.lock' });
    expect(refusalLine(caught)).toBe('alpha backup refused; step="lock withheld/pictures.json.lock"; code="EEXIST"; syscall="open"; partial copy retained\n');
    expect(refusalLine(Object.assign(new Error('private\ncontents'), {
      code: 'EPERM', syscall: 'open', backupStep: 'copy queue/name\nline.json',
    }))).toBe('alpha backup refused; step="file operation"; code="EPERM"; syscall="open"; partial copy retained\n');
    expect(refusalLine({ backupStep: 'open state/alpha.sqlite read-only', code: 'ERR_SQLITE_ERROR', errcode: 14 })).toContain('syscall="sqlite"; sqliteCode=14');
    expect(existsSync(f.output + '.partial')).toBe(true);
    expect(existsSync(f.output)).toBe(false);
  } finally { f.db.close(); }
});

it('keeps the regular-file guard and a diagnosable partial on a nested directory', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.alpha, 'queue/nested'));
    await expect(snapshot(f)).rejects.toMatchObject({ backupStep: 'copy queue files; count=1', code: 'BACKUP_GUARD', syscall: 'validate', reason: 'regular file required' });
    expect(existsSync(f.output)).toBe(false);
    expect(existsSync(join(f.withheld, 'pictures.json.backup-lock'))).toBe(true);
  } finally { f.db.close(); }
});

// Run the real shell control flow, substituting only installed paths and Docker.
// History writes real temporary dump files; find is doubled so retention never deletes anything.
function wrapperRun(failure = 'backup', { history = false, running = 'alpha-api\nalpha-sender' } = {}) {
  mkdirSync('.cache/tmp', { recursive: true });
  const dir = mkdtempSync(resolve('.cache/tmp/alpha-wrapper-'));
  const wrapper = join(dir, 'alpha-backup.sh');
  const relocate = text => text.replaceAll('/srv/squarehole/current/infra/server', resolve('infra/server'))
    .replaceAll('/usr/local/sbin/squarehole-alpha-backup-flags.sh', resolve('infra/server/alpha-backup-flags.sh'))
    .replaceAll('/var/backups/squarehole', dir);
  writeFileSync(wrapper, relocate(readFileSync('infra/server/alpha-backup.sh', 'utf8')));
  const pg = join(dir, 'pg-backup.sh');
  writeFileSync(pg, relocate(readFileSync('infra/server/pg-backup.sh', 'utf8'))
    .replace('/usr/local/sbin/squarehole-alpha-backup', `bash '${wrapper}'`));
  const harness = `
    docker() {
      printf '%s\\n' "$*" >> "$CALLS"
      case "$*" in
        'compose ps --status running --services') printf '%s\\n' "$RUNNING" ;;
        'compose stop '*) [[ $FAILURE != stop ]] ;;
        'compose ps --status running --quiet '*) if [[ $FAILURE == still-running ]]; then printf 'still running\\n'; fi ;;
        'compose ps --all --quiet alpha-sender') printf 'sender-id\\n' ;;
        'inspect '*) if [[ $FAILURE == inspect ]]; then return 1; fi; printf 'sender-volume\\n' ;;
        'compose images --quiet alpha-api') printf 'alpha-image\\n' ;;
        'compose start '*) [[ $FAILURE != restart ]] ;;
        'compose exec -T postgres pg_dump '*) printf 'synthetic history dump\\n' ;;
        'compose exec -T postgres pg_restore --list') return 0 ;;
        'run '*)
          if [[ $FAILURE == signal ]]; then kill -TERM "$BASHPID"; fi
          if [[ $FAILURE != success ]]; then printf '%s\\n' 'alpha backup refused; step="copy queue files; count=1"; code="EPERM"; syscall="open"; partial copy retained' >&2; return 1; fi ;;
        *) return 99 ;;
      esac
    }
    find() { return 0; }
    export -f docker find
    bash "$SCRIPT"
  `;
  const result = spawnSync('/bin/bash', ['-c', harness], { encoding: 'utf8', timeout: shLimit(10000),
    env: { ...process.env, FAILURE: failure, RUNNING: running, CALLS: join(dir, 'calls'), SCRIPT: history ? pg : wrapper } });
  return { ...result, dir, calls: readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n') };
}

for (const failure of ['backup', 'stop', 'still-running', 'inspect', 'signal', 'restart']) {
  it(`restarts previously running services after ${failure} and preserves failure status`, () => {
    const result = wrapperRun(failure);
    expect(result.status, result.stderr).toBe(failure === 'signal' ? 143 : 1);
    expect(result.calls.at(-1)).toBe('compose start alpha-api alpha-sender');
    expect(result.calls.filter(c => c.startsWith('compose start '))).toHaveLength(1);
    if (failure === 'restart') expect(result.stderr).toContain('service restart failed');
  });
}
it('restarts only services running on entry, and preserves success', () => {
  const result = wrapperRun('success', { running: 'alpha-api' });
  expect(result.status, result.stderr).toBe(0);
  expect(result.calls.at(-1)).toBe('compose start alpha-api');
  expect(wrapperRun('backup', { running: '' }).calls.some(c => c.startsWith('compose start '))).toBe(false);
});
it('a later alpha refusal preserves the successful history dump and its log in the failing unit', () => {
  const result = wrapperRun('backup', { history: true });
  expect(result.status, result.stderr).toBe(1);
  expect(result.stdout).toMatch(/squarehole-pg-backup: wrote .*history-.*\.dump \(\d+ bytes\)/);
  expect(result.stderr).toContain('alpha backup refused; step="copy queue files; count=1"');
  const dump = result.stdout.match(/wrote (\S+\.dump)/)[1];
  expect(readFileSync(dump, 'utf8')).toBe('synthetic history dump\n');
  expect(existsSync(dump + '.partial')).toBe(false);
  expect(result.calls.at(-1)).toBe('compose start alpha-api alpha-sender');
});

// The wrapper defers TERM, INT and HUP until the running docker command ends. An external docker stub on PATH (a real
// child process, not a shell function) holds `docker run` until the test releases it, so the signal arrives while the
// wrapper is waiting for a foreground command.
for (const [signal, status] of [['SIGTERM', 143], ['SIGHUP', 129], ['SIGINT', 130]]) {
  it(`defers ${signal} until the running docker command ends, then starts the services again`, async () => {
    mkdirSync('.cache/tmp', { recursive: true });
    const dir = mkdtempSync(resolve('.cache/tmp/alpha-signal-')), bin = join(dir, 'bin');
    mkdirSync(bin);
    const calls = join(dir, 'calls');
    writeFileSync(join(bin, 'docker'), `#!/bin/bash
printf '%s\\n' "$*" >> "$CALLS"
case "$*" in
  'compose ps --status running --services') printf 'alpha-api\\nalpha-sender\\n' ;;
  'compose ps --all --quiet alpha-sender') printf 'sender-id\\n' ;;
  'inspect '*) printf 'sender-volume\\n' ;;
  'compose images --quiet alpha-api') printf 'alpha-image\\n' ;;
  'run '*)
    : > "$DIR/run-started"
    while [[ ! -e $DIR/release ]]; do sleep 0.05; done
    printf 'docker run finished\\n' >> "$CALLS" ;;
esac
`, { mode: 0o755 });
    const wrapper = join(dir, 'alpha-backup.sh');
    writeFileSync(wrapper, readFileSync('infra/server/alpha-backup.sh', 'utf8')
      .replaceAll('/srv/squarehole/current/infra/server', resolve('infra/server'))
      .replaceAll('/usr/local/sbin/squarehole-alpha-backup-flags.sh', resolve('infra/server/alpha-backup-flags.sh'))
      .replaceAll('/var/backups/squarehole', dir));
    const child = spawn('/bin/bash', [wrapper], { stdio: 'ignore', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: calls, DIR: dir } });
    const done = new Promise((res, rej) => { child.on('error', rej); child.on('close', (code, sig) => res({ code, sig })); });
    const until = async (path) => { for (let i = 0; i < 200 && !existsSync(path); i++) await new Promise(r => setTimeout(r, 50)); expect(existsSync(path)).toBe(true); };
    try {
      await until(join(dir, 'run-started'));
      child.kill(signal);
      await new Promise(r => setTimeout(r, 500));
      expect(readFileSync(calls, 'utf8')).not.toMatch(/^compose start /m); // still waiting for the docker command
      writeFileSync(join(dir, 'release'), '');
      expect(await done).toEqual({ code: status, sig: null });
      expect(readFileSync(calls, 'utf8').trim().split('\n').slice(-2)).toEqual(['docker run finished', 'compose start alpha-api alpha-sender']);
    } finally { child.kill('SIGKILL'); writeFileSync(join(dir, 'release'), ''); }
  }, shLimit(20000));
}

it('the nightly unit allows the wrapper to finish and restart the services before systemd kills it', () => {
  const unit = readFileSync('infra/server/systemd/squarehole-pg-backup.service', 'utf8');
  const grace = Number(unit.match(/^TimeoutStopSec=(\d+)$/m)?.[1]);
  const stop = Number(readFileSync('infra/server/alpha-backup.sh', 'utf8').match(/docker compose stop --timeout (\d+) /)?.[1]);
  expect(stop).toBe(60);
  expect(grace).toBeGreaterThanOrEqual(stop + 600);
  expect(readFileSync('infra/server/alpha-backup.sh', 'utf8')).toContain("trap 'exit 129' HUP");
});

it('a queue filename never reaches a refusal error or log', async () => {
  const f = fixture(), name = '00000000-0000-4000-8000-000000000001.json';
  try {
    symlinkSync(join(f.sender, 'journal.json'), join(f.alpha, 'queue', name));
    let caught;
    try { await snapshot(f); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ backupStep: 'copy queue files; count=1', code: 'BACKUP_GUARD' });
    expect(String(caught)).not.toContain(name);
    expect(refusalLine(caught)).not.toContain(name);
    expect(refusalLine(caught)).toContain('copy queue files; count=1');
  } finally { f.db.close(); }
});

it('unlisted backup steps always use a neutral word, including cleanup and plausible operation names', () => {
  for (const step of ['validate private tester', 'copy queue/private-tester.json', 'open private/claim.json',
    'publish private tester', 'sync queue/private.json', 'copy queue files; count=2', 'list unknown', '', 42]) {
    const line = refusalLine({ backupStep: step, cleanup: { backupStep: step } });
    expect(line.match(/step="file operation"/g)).toHaveLength(2);
    if (typeof step === 'string' && step) expect(line).not.toContain(step);
  }
});

it('known backup steps keep af1 messages and historical identifier logs have documented retention', () => {
  const known = ['arguments', 'validate inputs', 'create partial directory', 'create state directory',
    'lock withheld/pictures.json.lock', 'write withheld/pictures.json.lock', 'close withheld/pictures.json.lock',
    'rename withheld/pictures.json.lock', 'validate state/alpha.sqlite', 'open state/alpha.sqlite read-only',
    'backup state/alpha.sqlite', 'restore owner state/alpha.sqlite-wal', 'restore owner state/alpha.sqlite-shm',
    'check restored state/alpha.sqlite', 'validate absent state/alpha.sqlite', 'sync state', 'write manifest.json',
    'sync snapshot', 'publish snapshot',
    ...['alpha', 'state', 'sender', 'withheld'].map(kind => `validate ${kind} directory`),
    ...['queue', 'receipts', 'sender', 'withheld'].flatMap(kind => [`list ${kind}`, `sync ${kind}`, `copy ${kind} files; count=1`])];
  for (const step of known) expect(refusalLine({ backupStep: step })).toContain(`step=${JSON.stringify(step)};`);
  for (const step of ['configure SQLite backup', 'close source SQLite']) expect(refusalLine({ backupStep: step })).toContain('step="file operation";');
  const retention = readFileSync('docs/runbooks/alpha-access.md', 'utf8');
  expect(retention).toContain('Earlier backup refusals may have left claim IDs');
  expect(retention).toContain('forwarded/archived logs');
  expect(retention).toContain('seven-day snapshot policy does not expire logs');
  expect(retention).toContain('30 days after the alpha ends');
});
