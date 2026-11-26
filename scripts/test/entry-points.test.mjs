import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// SH-V21-RC8-INT rc8.1, from the sh-growth review: Node gives import.meta.url as the real path of the started file,
// but process.argv[1] as typed. An entry check comparing the two did nothing and exited 0 when the path went
// through a symlink (macOS /tmp, a linked checkout, or the rescue host's /opt/squarehole-rescue/current).
const root = fileURLToPath(new URL('../../', import.meta.url));

/** The rescue host's own layout (infra/rescue-host/setup.sh): releases/<tag>, and current linking to it. */
function linkedRelease() {
  const dir = mkdtempSync(join(tmpdir(), 'sh-entry-'));
  mkdirSync(join(dir, 'releases'));
  symlinkSync(root, join(dir, 'releases', 'core-v21-entry'), 'dir');
  symlinkSync(join('releases', 'core-v21-entry'), join(dir, 'current'), 'dir');
  return { dir, current: join(dir, 'current') };
}
const start = (file, args = []) => spawnSync(process.execPath, [file, ...args],
  { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH } });

test('the rescue host runs when systemd starts it through /opt/squarehole-rescue/current', () => {
  const { dir, current } = linkedRelease();
  try {
    const run = start(join(current, 'infra/rescue-host/run.mjs'));
    // No private configuration in this environment: the host must say so and fail, not exit 0 silently.
    assert.equal(run.stderr, 'rescue host configuration unavailable\n');
    assert.equal(run.stdout, '');
    assert.equal(run.status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the monitor runs its dry run when started through a symlinked path', () => {
  const { dir, current } = linkedRelease();
  try {
    const run = start(join(current, 'infra/server/monitor/main.mjs'),
      ['--dry-run', '--config', join(current, 'infra/server/monitor/config.example.json')]);
    assert.equal(run.stdout, 'monitor dry-run: configuration valid; 18 checks; no probes, notifications or state writes\n'
      + 'heartbeat not configured\n');
    assert.equal(run.status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('every entry check compares import.meta.url with the real path of the started file', () => {
  const listed = spawnSync('git', ['-C', root, 'ls-files', '-z', '--', '*.mjs', '*.js', '*.cjs', '*.ts', '*.mts'],
    { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  const entries = [];
  for (const file of listed.stdout.split('\0').filter(Boolean)) {
    if (/^square-hole-(?:handoff|core-v2)\//.test(file)) continue; // the hash-checked handoff folders
    if (file === relative(root, fileURLToPath(import.meta.url))) continue; // this guard's own search line
    let text;
    try { text = readFileSync(join(root, file), 'utf8'); } catch { continue; }
    text.split('\n').forEach((line, i) => {
      if (line.includes('import.meta') && line.includes('process.argv[1]')) entries.push({ file, line: i + 1, text: line });
    });
  }
  for (const file of ['infra/rescue-host/run.mjs', 'infra/rescue-host/pack.mjs', 'infra/server/monitor/main.mjs',
    'infra/server/monitor/keeper-view.mjs', 'infra/server/app/build.mjs', 'infra/server/app/smoke.mjs',
    'apps/web/production-check.ts', 'packages/cow-poster/src/healthcheck.ts', 'packages/keeper/src/state-lock.ts',
    'scripts/box/launch-check.mjs']) assert.ok(entries.some(e => e.file === file), `${file} has an entry check`);
  const typed = entries.filter(e => !/(?:realpathSync|realPathOf)\((?:process\.argv\[1\]|started)\)/.test(e.text));
  assert.deepEqual(typed.map(e => `${e.file}:${e.line}`), []);
});


test('af1: both gate entry points execute through a symlink and remain inert on import', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sh-gate-entry-'));
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  for (const [file, args] of [['reach.mjs', ['--check']], ['verify-merge.mjs', []]]) {
    const target = join(root, 'scripts/gates', file), link = join(dir, file);
    symlinkSync(target, link);
    const run = name => spawnSync(process.execPath, [name, ...args], { cwd: root, env, encoding: 'utf8' });
    const direct = run(target), linked = run(link);
    assert.equal(direct.error, undefined); assert.equal(linked.error, undefined);
    assert.deepEqual([linked.status, linked.stdout, linked.stderr], [direct.status, direct.stdout, direct.stderr]);
    assert.ok(direct.stdout || direct.stderr, 'gate actually executed');
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(target)})`], { cwd: root, env, encoding: 'utf8' });
    assert.equal(imported.error, undefined);
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout, '');
  }
});
