import { DatabaseSync } from 'node:sqlite';
import { chmod, mkdtemp, mkdir, open, readFile, readdir, stat, writeFile, utimes, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { StateStore, runOnce } from '../runtime.mjs';
import { configure } from '../config.mjs';
import { readJournal, readJson, latestBackup } from '../collect.mjs';
import { LANDING_HEADERS } from '../policy.mjs';
import { NOW, options, healthy } from './support.mjs';
const dir = () => mkdtemp(resolve('.cache/tmp/monitor-test-'));
const entry = { sequence: '1', entryHash: `0x${'1'.repeat(64)}`, previousHash: `0x${'0'.repeat(64)}`, record: { recordedUtc: new Date(Number(NOW) * 1000).toISOString(), chainId: '11155111' } };
describe('filesystem and runtime integration', () => {
  it('reads bounded journal tail, rejects incomplete append and ignores partial/empty backups', async () => {
    const d = await dir(), j = join(d, 'journal.jsonl');
    await writeFile(j, `${'x'.repeat(70000)}\n${JSON.stringify(entry)}\n`);
    expect((await readJournal(j)).record).toEqual(entry.record);
    await writeFile(j, JSON.stringify(entry)); await expect(readJournal(j)).rejects.toThrow();
    const b = join(d, 'backups'); await mkdir(b);
    await writeFile(join(b, 'history-20261013T033000Z.dump.partial'), 'PGDMP incomplete');
    await expect(latestBackup(b)).rejects.toThrow();
    const complete = join(b, 'history-20261012T033000Z.dump'); await writeFile(complete, 'PGDMP fake test archive');
    await utimes(complete, Number(NOW - 86400n), Number(NOW - 86400n));
    expect((await latestBackup(b)).modifiedAt).toBe(String(NOW - 86400n));
    await writeFile(join(b, 'history-20261013T033000Z.dump'), ''); await expect(latestBackup(b)).rejects.toThrow();
    const link = join(d, 'link'); await symlink(j, link); await expect(readJson(link)).rejects.toThrow();
  });
  it('reads the actual burn-bot SQLite schema including a newer WAL without writing it', async () => {
    const d = await dir(), path = join(d, 'journal.sqlite');
    const db = new DatabaseSync(path);
    try {
      db.exec('PRAGMA journal_mode = WAL; CREATE TABLE journal (sequence INTEGER PRIMARY KEY, line TEXT NOT NULL);');
      db.prepare('INSERT INTO journal(line) VALUES (?)').run(JSON.stringify(entry) + '\n');
      await utimes(path, Number(NOW - 86400n), Number(NOW - 86400n));
      await utimes(path + '-wal', Number(NOW), Number(NOW));
      const before = await readFile(path + '-wal');
      expect(await readJournal(path)).toEqual({ modifiedAt: String(NOW), record: entry.record });
      expect(await readFile(path + '-wal')).toEqual(before);
      expect(db.prepare('SELECT count(*) AS n FROM journal').get().n).toBe(1);
    } finally { db.close(); }
  });
  for (const active of [false, true]) it(`reads a ${active ? 'live' : 'closed'} WAL journal with the installed unit's filesystem permissions`, async () => {
    // POSIX permissions reproduce the relevant read-only mount boundary without a listener,
    // root privileges or systemd. Run as an ordinary user on Linux as well as macOS.
    expect(process.getuid()).not.toBe(0);
    const service = await readFile('infra/server/systemd/squarehole-monitor.service', 'utf8');
    const writable = service.split('\n').filter(x => x.startsWith('ReadWritePaths=')).flatMap(x => x.slice(15).split(/\s+/)).map(x => x.replace(/^-/, ''));
    const sidecarsWritable = writable.includes('/var/lib/squarehole/burn-bot');
    const d = await dir(), path = join(d, 'journal.sqlite');
    let db = new DatabaseSync(path);
    try {
      db.exec('PRAGMA journal_mode = WAL; CREATE TABLE journal (sequence INTEGER PRIMARY KEY, line TEXT NOT NULL);');
      db.prepare('INSERT INTO journal(line) VALUES (?)').run(JSON.stringify({ ...entry, record: { ...entry.record, recordedUtc: '2026-10-12T00:00:00.000Z' } }) + '\n');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      // The newest committed entry exists only in WAL while the writer is active.
      db.prepare('INSERT INTO journal(line) VALUES (?)').run(JSON.stringify({ ...entry, sequence: '2' }) + '\n');
      if (!active) {
        db.close(); db = null;
        expect(await readdir(d)).toEqual(['journal.sqlite']);
      }
      await utimes(path, Number(NOW - 86400n), Number(NOW - 86400n));
      if (active) await utimes(path + '-wal', Number(NOW), Number(NOW));
      const beforeDb = await readFile(path), beforeWal = active ? await readFile(path + '-wal') : null;
      await chmod(path, 0o400);
      if (active) for (const suffix of ['-wal', '-shm']) await chmod(path + suffix, sidecarsWritable ? 0o600 : 0o400);
      await chmod(d, sidecarsWritable ? 0o700 : 0o500);
      // Prove the database cannot be opened for writes by the test reader.
      await expect(open(path, 'r+')).rejects.toMatchObject({ code: 'EACCES' });
      const result = await readJournal(path);
      expect(result.record).toEqual(entry.record);
      // Opening a closed journal can create an empty WAL; that is not bot activity.
      expect(result.modifiedAt).toBe(String(active ? NOW : NOW - 86400n));
      expect(await readFile(path)).toEqual(beforeDb);
      if (active) expect(await readFile(path + '-wal')).toEqual(beforeWal);
      expect(service).toContain('ProtectSystem=strict');
      if (!active) expect(service).toContain('ReadOnlyPaths=-/var/lib/squarehole/burn-bot/journal.sqlite');
    } finally {
      await chmod(d, 0o700); await chmod(path, 0o600);
      for (const name of await readdir(d)) await chmod(join(d, name), 0o600);
      db?.close();
    }
    // A subsequent bot invocation can still use the monitor-created sidecars.
    const nextWriter = new DatabaseSync(path);
    try {
      nextWriter.prepare('INSERT INTO journal(line) VALUES (?)').run(JSON.stringify({ ...entry, sequence: '3' }) + '\n');
      expect(nextWriter.prepare('SELECT count(*) AS n FROM journal').get().n).toBe(3);
    } finally { nextWriter.close(); }
  });
  it('persists private dedup state across process restarts and refuses corruption', async () => {
    const d = await dir(), store = new StateStore(d);
    expect(await store.load()).toEqual({ version: 1, channels: {} });
    const state = { version: 1, channels: { mailer: { signature: '', notifiedAt: String(NOW), lastClearDay: String(NOW / 86400n) } } };
    await store.save(state); expect(await new StateStore(d).load()).toEqual(state);
    expect((await stat(join(d, 'state.json'))).mode & 0o777).toBe(0o600);
    await writeFile(join(d, 'state.json'), '{}'); await expect(store.load()).rejects.toThrow();
  });
  it('runs all checks through injected ports and preserves independent notifier failure', async () => {
    const c = configure(options, {}), o = healthy(LANDING_HEADERS), state = { version: 1, channels: {} };
    const send = vi.fn(), store = { load: async () => state, save: vi.fn() };
    let out = await runOnce(c, {}, { collect: async () => o, senders: { mailer: send }, store, now: NOW });
    expect(out.code).toBe(0); expect(send).toHaveBeenCalledTimes(1);
    o.view.drand.complete = false;
    out = await runOnce(c, {}, { collect: async () => o, senders: { mailer: send, smtp: async () => { throw new Error('FAKE_TEST_SECRET'); } }, store, now: NOW + 1n });
    expect(out.code).toBe(2); expect(out.failedChannels).toEqual(['smtp']);
    expect(JSON.stringify(out)).not.toContain('FAKE_TEST');
    expect(send.mock.calls.at(-1)[0]).toContain('drand: unknown');
  });
});
describe('configuration and offline entrypoints', () => {
  it('requires explicit mainnet opt-in and exact raw decimal strings', () => {
    const main = { ...options, keeperIdentity: options.keeperIdentity.replace('11155111:', '1:') };
    expect(() => configure(main, { SH_MONITOR_CHAIN_ID: '1' })).toThrow();
    expect(configure(main, { SH_MONITOR_CHAIN_ID: '1', SH_MONITOR_ALLOW_MAINNET: '1' }).chainId).toBe('1');
    for (const c of [{ totalWeiPerDay: 100 }, { maxFeePerGasWei: '3000000001' }, { diskUsedPercent: '101' }, { queueCount: '1e2' }, { unexpected: true }]) expect(() => configure({ ...options, ...c }, {})).toThrow();
    expect(() => configure({ ...options, apiUrl: 'http://example.invalid' }, {})).toThrow();
  });
  it('parses checked-in JSON and both systemd units, runs both script dry-runs without I/O', async () => {
    const config = JSON.parse(await readFile('infra/server/monitor/config.example.json', 'utf8'));
    expect(configure(config, {}).chainId).toBe('11155111');
    const env = { PATH: process.env.PATH, SH_MONITOR_RPC_URL: 'https://example.invalid/FAKE_TEST_SECRET', SH_MONITOR_MAILER_TOKEN: 'FAKE_TEST_SECRET' };
    for (const cmd of [['node', ['infra/server/monitor/main.mjs']], ['bash', ['infra/server/monitor/check.sh']]]) {
      const stdout = execFileSync(cmd[0], [...cmd[1], '--dry-run', '--config', 'infra/server/monitor/config.example.json'], { env, encoding: 'utf8' });
      expect(stdout).toContain('dry-run'); expect(stdout).toContain('18 checks'); expect(stdout).not.toContain('FAKE_TEST');
    }
    // Minimal INI parser catches broken sections/assignments; systemd's own verifier remains a host check.
    const unit = async file => {
      const sections = {}; let current;
      for (const line of (await readFile(file, 'utf8')).split('\n').filter(x => x && !x.startsWith('#'))) {
        const s = /^\[([A-Za-z]+)\]$/.exec(line);
        if (s) { current = sections[s[1]] ??= {}; continue; }
        expect(current).toBeDefined(); const m = /^([A-Za-z]+)=(.*)$/.exec(line); expect(m).not.toBeNull(); current[m[1]] = m[2];
      }
      return sections;
    };
    const service = await unit('infra/server/systemd/squarehole-monitor.service');
    const timer = await unit('infra/server/systemd/squarehole-monitor.timer');
    expect(service.Service.ExecStart).toContain('check.sh --run');
    expect(service.Service.EnvironmentFile).toBe('/etc/squarehole/monitor.env');
    expect(timer.Timer.OnCalendar).toBe('*-*-* *:*:00 UTC'); expect(timer.Timer.Persistent).toBe('true');
    expect(service.Service.ProtectSystem).toBe('strict');
  });
});
