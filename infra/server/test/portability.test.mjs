import { execFileSync, spawnSync } from './local-command.mjs';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shipFixture } from './ship-fixture.mjs';

const normalize = value => value.replace(/\/ship-portable-[^/]+/g, '/FIXTURE')
  .replace(/ship(?:-alpha)?\.(?:DRY-RUN|[A-Za-z0-9]+)/g, 'ship.WORK')
  .replace(/(squarehole-app-[a-f0-9]{40})-\d+\.tar/g, '$1-PID.tar');

describe('SH-204 offline ship plans and preflight', () => {
  it.each(['stack', 'app', 'alpha'])('%s dry run lists transfers and exact remote commands without invoking transports', lane => {
    const f = shipFixture();
    const script = lane === 'alpha' ? 'ship-alpha.sh' : 'ship.sh';
    const args = lane === 'app' ? ['--app', 'sepolia', '--config', f.config, f.commit] : [f.commit];
    const plan = f.runScript(script, ['--dry-run', ...args]);
    expect(plan.status, plan.stderr).toBe(0);
    expect(f.calls()).toEqual([]); // ssh/scp/rsync/curl stubs record every invocation, even failed ones.
    expect(plan.stdout).toContain('archive');
    expect(plan.stdout).toContain(lane === 'app' ? 'SHA256SUMS' : 'apps/landing/public/index.html');
    expect(existsSync(join(f.root, '.cache/tmp'))).toBe(false);
    const commands = plan.stdout.split('\n').filter(line => /^(scp|ssh) /.test(line));
    expect(commands).toHaveLength(2);
    expect(commands[1]).toContain('sudo');
    if (lane === 'alpha') expect(commands[1]).toContain(' < ');
    // Interpret the printed, shell-escaped plan using ONLY the recording stand-ins.
    for (const command of commands) spawnSync('bash', ['-c', command], { cwd: f.root, env: f.env, encoding: 'utf8' });
    const planned = f.calls();
    expect(planned.map(call => call.tool)).toEqual(['scp', 'ssh']);
    // The simulated real ship packs locally, then stops at the recording SSH stub. It never installs or smokes.
    const real = f.runScript(script, args);
    expect(real.status, real.stderr).toBe(78);
    const executed = f.calls().filter(call => ['scp', 'ssh'].includes(call.tool)).slice(2);
    expect(executed).toHaveLength(2);
    expect(executed.map(call => ({ ...call, args: call.args.map(normalize) }))).toEqual(planned.map(call => ({ ...call, args: call.args.map(normalize) })));
    expect(f.calls().some(call => ['curl', 'rsync'].includes(call.tool))).toBe(false);
    expect(real.stdout).toMatch(/sha256: [a-f0-9]{64}/);
    if (lane === 'alpha') expect(executed[1].input).toBe(readFileSync('infra/server/install-alpha.sh', 'utf8'));
    else expect(executed[1].input).toBe('');
    if (lane !== 'app') expect(readFileSync(join(f.trace, 'git-calls'), 'utf8')).toContain('"-c","tar.umask=0022","archive","--format=tar"');
  });

  it('plans stack and alpha from a repository subdirectory', () => {
    const f = shipFixture();
    for (const script of ['ship.sh', 'ship-alpha.sh']) {
      const result = f.runScript(script, ['--dry-run', f.commit], { cwd: join(f.root, 'apps') });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('apps/landing/public/index.html');
    }
    expect(f.calls()).toEqual([]);
  });

  it('alpha dry run retains the policy check before any transfer', () => {
    const f = shipFixture();
    writeFileSync(join(f.root, '.cache/headers'), '/*\n  Content-Security-Policy: changed\n');
    const result = f.runScript('ship-alpha.sh', ['--dry-run', f.commit]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('asks for another policy');
    expect(f.calls()).toEqual([]);
  });

  it.each(['ship.sh', 'ship-alpha.sh'])('%s stops before upload when the Git archive producer fails', script => {
    const f = shipFixture();
    const result = f.runScript(script, [f.commit], { env: { ...f.env, SHIP_FIXTURE_ARCHIVE_FAIL: '1' } });
    expect(result.status).toBe(47);
    expect(f.calls()).toEqual([]);
  });

  it('checks the Compose plugin before the app build, without invoking Docker in a dry run', () => {
    const f = shipFixture();
    const result = f.runScript('ship.sh', ['--app', 'sepolia', '--config', f.config, f.commit], { env: { ...f.env, SHIP_FIXTURE_COMPOSE_MISSING: '1' } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing tool: docker compose; Arch package: docker-compose; macOS provider: Docker Desktop');
    expect(f.calls().map(call => [call.tool, call.args])).toEqual([['docker', ['compose', 'version', '--short']]]);
    expect(existsSync(join(f.root, '.cache/tmp'))).toBe(false);
  });

  const tools = ['bash', 'git', 'node', 'ssh', 'scp', 'tar', 'gzip', 'mkdir', 'mktemp', 'cp', 'du', 'cut', 'sed', 'curl', 'awk', 'cmp', 'date', 'rm', 'sort', 'tr', 'diff', 'pnpm', 'shellcheck', 'docker'];
  it.each([
    ['ship.sh', ['--dry-run'], 'cmp', 'diffutils'],
    ['ship-alpha.sh', ['--dry-run', 'HEAD'], 'diff', 'diffutils'],
    ['app/pack.sh', ['unused', 'unused.tar.gz'], 'node', 'mise'],
    ['app/validate.sh', ['unused', '--dry-run'], 'shellcheck', 'shellcheck'],
    ['smoke-app.sh', ['unused', '--dry-run'], 'curl', 'curl'],
    ['smoke-alpha.sh', ['unused'], 'curl', 'curl'],
    ['smoke-landing.sh', ['unused'], 'cmp', 'diffutils'],
    ['test/alpha-offline-check.sh', [], 'python3', 'python'],
  ])('%s reports a missing tool before doing work', (script, args, missing, provider) => {
    mkdirSync('.cache/tmp', { recursive: true });
    const bin = mkdtempSync(resolve('.cache/tmp/preflight-bin-'));
    for (const tool of tools.filter(tool => tool !== missing)) {
      // Only command-v runs: an executable stand-in is enough for every available dependency.
      symlinkSync(process.execPath, join(bin, tool));
    }
    const bash = execFileSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim();
    const result = spawnSync(bash, [resolve('infra/server', script), ...args], { cwd: bin, env: { ...process.env, PATH: bin }, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`missing tool: ${missing}; Arch package: ${provider}`);
    expect(result.stderr).toContain('macOS provider:');
    expect(existsSync(join(bin, '.cache'))).toBe(false);
  });

  it.each([
    ['app/build.mjs', ['a'.repeat(40), 'sepolia', '/nonexistent/config.txt', '/nonexistent/out'], 'pnpm'],
    ['app/smoke.mjs', ['/nonexistent/artifact', '--dry-run'], 'curl'],
  ])('direct %s preflights before reading inputs', (script, args, missing) => {
    mkdirSync('.cache/tmp', { recursive: true });
    const bin = mkdtempSync(resolve('.cache/tmp/node-preflight-'));
    symlinkSync(process.execPath, join(bin, 'node'));
    if (missing === 'pnpm') symlinkSync(process.execPath, join(bin, 'git'));
    const result = spawnSync(process.execPath, [resolve('infra/server', script), ...args], { env: { ...process.env, PATH: bin }, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`missing tool: ${missing}`);
    expect(result.stderr).toContain('macOS provider:');
  });

  it('the runbook digest command verifies exact bytes on GNU and BSD userlands without shasum', () => {
    mkdirSync('.cache/tmp', { recursive: true });
    const root = mkdtempSync(resolve('.cache/tmp/digest-check-'));
    mkdirSync(join(root, '.cache/ipfs-check'), { recursive: true });
    const bytes = Buffer.from('offline public art fixture');
    writeFileSync(join(root, '.cache/ipfs-check/block.bin'), bytes);
    const command = readFileSync('docs/runbooks/server.md', 'utf8').split('\n').find(line => line.startsWith('test "$(openssl dgst -sha256 '));
    expect(command).toBeTruthy();
    for (const correct of [true, false]) {
      const hash = correct ? createHash('sha256').update(bytes).digest('hex') : '0'.repeat(64);
      const result = spawnSync('bash', ['-c', command], { cwd: root, env: { ...process.env, ART_SHA256: `0x${hash}` }, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(correct ? 0 : 1);
    }
  });
});


// Read only synthetic public fixture trees. atime is excluded because reading files may update it.
function diskState(root) {
  const entries = [];
  const walk = path => {
    const stat = lstatSync(path, { bigint: true });
    entries.push({ path: relative(root, path), mode: String(stat.mode), mtime: String(stat.mtimeNs),
      ctime: String(stat.ctimeNs), bytes: stat.isFile() ? readFileSync(path).toString('hex') : undefined,
      link: stat.isSymbolicLink() ? readlinkSync(path) : undefined });
    if (stat.isDirectory()) for (const child of readdirSync(path).sort()) walk(join(path, child));
  };
  walk(root);
  return entries;
}

const laneArgs = (f, lane) => lane === 'app' ? ['--app', 'sepolia', '--config', f.config, f.commit] : [f.commit];
const laneScript = lane => lane === 'alpha' ? 'ship-alpha.sh' : 'ship.sh';

describe('SH-204 af1 regressions', () => {
  it.each(['ship.sh', 'ship-alpha.sh', 'app/pack.sh', 'app/validate.sh', 'smoke-app.sh', 'smoke-alpha.sh', 'smoke-landing.sh', 'test/alpha-offline-check.sh', 'app/tools.sh'])('%s works by relative, bare, absolute and symlink paths', script => {
    const f = shipFixture();
    const work = join(f.root, '.cache/pack-input');
    const artifact = join(work, 'artifact');
    execFileSync(process.execPath, [join(f.root, 'infra/server/app/build.mjs'), f.commit, 'sepolia', f.config, artifact], { cwd: f.root, env: f.env });
    writeFileSync(join(work, 'install.sh'), '#!/usr/bin/env bash\n');
    const publicDir = join(f.root, 'apps/landing/public');
    mkdirSync(publicDir, { recursive: true });
    for (const file of ['_headers', 'index.html', '404.html']) writeFileSync(join(publicDir, file), 'offline fixture');
    const source = join(f.root, 'infra/server', script);
    const linked = join(f.bin, basename(script));
    // A relative target also checks resolution against the link's folder, not the caller's cwd.
    symlinkSync(relative(f.bin, source), linked);
    const starts = [[relative(f.root, source), f.root], [basename(source), dirname(source)], [source, f.root], [linked, f.root]];
    for (const [index, [entry, cwd]] of starts.entries()) {
      const args = script === 'ship.sh' || script === 'ship-alpha.sh' ? ['--dry-run', f.commit]
        : script === 'app/pack.sh' ? [work, join(f.root, `.cache/pack-${index}.tar.gz`)]
        : script === 'app/validate.sh' || script === 'smoke-app.sh' ? [relative(cwd, artifact), '--dry-run']
        : script === 'smoke-landing.sh' && index < 3 ? []
        : script === 'smoke-alpha.sh' || script === 'smoke-landing.sh' ? [publicDir] : [];
      const bashArgs = script === 'app/tools.sh' ? ['-c', 'source "$1"; dry_run=true; sh_command scp "two words"', 'fixture', entry] : [entry, ...args];
      const result = spawnSync('bash', bashArgs, { cwd, env: f.env, encoding: 'utf8' });
      if (script.startsWith('smoke-') && script !== 'smoke-app.sh') {
        expect(result.status, `${entry}: ${result.stderr}`).toBe(1);
        expect(result.stderr).toContain('request failed'); // The recording curl refuses before any connection.
      } else if (script.startsWith('test/')) {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('usage: alpha-offline-check.sh'); // No arguments: stop before Docker.
      } else expect(result.status, `${entry}: ${result.stderr}`).toBe(0);
    }
  });

  it('operator diagnostics and usage have no pending markers and retain the AppleDouble repair hint', () => {
    const paths = ['ship.sh', 'ship-alpha.sh', 'smoke-app.sh', 'smoke-alpha.sh', 'smoke-landing.sh',
      'app/archive.mjs', 'app/pack.mjs', 'app/check-pack.mjs', 'app/tools.mjs', 'app/tools.sh', 'app/smoke.mjs',
      'app/build.mjs', 'app/pack.sh', 'app/validate.sh', 'test/alpha-offline-check.sh',
      'test/pack.test.mjs', 'test/portability.test.mjs', 'test/ship.test.mjs', 'test/smoke.test.mjs'];
    for (const path of paths) expect(readFileSync(join('infra/server', path), 'utf8'), path).not.toContain(['[SH-204', 'wording pending]'].join(' '));
    expect(readFileSync('infra/server/app/check-pack.mjs', 'utf8')).toContain('repack with infra/server/app/pack.sh');
    const f = shipFixture();
    expect(f.runScript('ship-alpha.sh', []).stderr).toBe('usage: ship-alpha.sh [--dry-run] <commit>\n');
    for (const [script, usage] of [['archive.mjs', 'usage: archive.mjs <new tar.gz>; input: tar on stdin'], ['pack.mjs', 'usage: pack.sh <work directory> <tarball>']]) {
      const result = spawnSync(process.execPath, [resolve('infra/server/app', script)], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).toBe(`${usage}\n`);
    }
  });

  it.each([false, true])('alpha cleans only its mktemp folder with rm on exit (archive failure: %s)', archiveFailure => {
    const f = shipFixture();
    mkdirSync(join(f.root, '.cache/tmp/keep'), { recursive: true });
    writeFileSync(join(f.root, '.cache/tmp/keep/sentinel'), 'keep');
    // Record the rm argv, then remove only the folder this script just created in this fixture.
    writeFileSync(join(f.bin, 'rm'), `#!/usr/bin/env node
import { appendFileSync, rmSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.length !== 3 || args[0] !== '-rf' || args[1] !== '--' || !/^\\.cache\\/tmp\\/ship-alpha\\.[A-Za-z0-9]+$/.test(args[2])) {
  process.exit(92);
}
appendFileSync(process.env.SHIP_FIXTURE_ROOT + '-trace/rm-calls', JSON.stringify(args) + '\\n');
rmSync(args[2], { recursive: true });
`, { mode: 0o755 });
    const result = f.runScript('ship-alpha.sh', [f.commit], { env: { ...f.env, ...(archiveFailure ? { SHIP_FIXTURE_ARCHIVE_FAIL: '1' } : {}) } });
    expect(result.status, result.stderr).toBe(archiveFailure ? 47 : 78);
    const record = join(f.trace, 'rm-calls');
    expect(existsSync(record)).toBe(true);
    const calls = readFileSync(record, 'utf8').trim().split('\n').map(JSON.parse);
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 2)).toEqual(['-rf', '--']);
    expect(readdirSync(join(f.root, '.cache/tmp'))).toEqual(['keep']);
    expect(readFileSync(join(f.root, '.cache/tmp/keep/sentinel'), 'utf8')).toBe('keep');
  });

  it.each(['stack', 'app', 'alpha'])('%s dry run preserves checkout and scratch; dirty real and dry runs refuse', lane => {
    for (const existingScratch of [false, true]) {
      const f = shipFixture();
      f.env.TMPDIR = join(f.root, '.cache/tmp');
      if (existingScratch) {
        mkdirSync(join(f.root, '.cache/tmp/nested'), { recursive: true });
        writeFileSync(join(f.root, '.cache/tmp/nested/sentinel'), Buffer.from([0, 1, 255]));
      }
      const before = diskState(f.root);
      const result = f.runScript(laneScript(lane), ['--dry-run', ...laneArgs(f, lane)]);
      expect(result.status, result.stderr).toBe(0);
      expect(diskState(f.root)).toEqual(before);
      expect(readFileSync(join(f.trace, 'git-status-locks'), 'utf8').trim().split('\n').every(value => value === '0')).toBe(true);
      expect(f.calls()).toEqual([]);
      writeFileSync(join(f.root, 'leftover'), 'untracked fixture');
      const dirty = diskState(f.root);
      for (const dry of [true, false]) {
        const result = f.runScript(laneScript(lane), [...(dry ? ['--dry-run'] : []), ...laneArgs(f, lane)]);
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain('a clean checkout is required');
        expect(diskState(f.root)).toEqual(dirty);
        expect(f.calls()).toEqual([]);
      }
    }
  });

  it.each(['space', 'quote', 'newline'])('sh_command prints and replays the same %s argument through bash', kind => {
    const f = shipFixture();
    const value = { space: 'two words', quote: "one'quote", newline: 'line\nbreak' }[kind];
    const escaped = { space: 'two\\ words', quote: "one\\'quote", newline: "$'line\\nbreak'" }[kind];
    const plan = execFileSync('bash', ['-c', 'source "$1"; dry_run=true; sh_command scp "$2"', 'fixture', join(f.root, 'infra/server/app/tools.sh'), value], { cwd: f.root, env: f.env, encoding: 'utf8' });
    expect(plan).toBe(`scp ${escaped} \n`);
    execFileSync('bash', ['-c', plan], { cwd: f.root, env: f.env });
    expect(f.calls()).toEqual([{ tool: 'scp', args: [value], input: '' }]);
    // Exercise the actual ship entrypoints too, including their bare-name start.
    for (const lane of ['stack', 'app', 'alpha']) {
      const script = laneScript(lane);
      const result = spawnSync('bash', [script, '--dry-run', ...laneArgs(f, lane)], { cwd: join(f.root, 'infra/server'), env: { ...f.env, SH_SERVER_KEY: value }, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      const commands = result.stdout.split('\n').filter(line => /^(scp|ssh) /.test(line));
      expect(commands).toHaveLength(2);
      for (const command of commands) {
        const run = spawnSync('bash', ['-c', command], { cwd: f.root, env: f.env });
        expect(run.status).toBe(command.startsWith('ssh ') ? 78 : 0);
      }
      expect(f.calls().slice(-2).map(call => call.args.slice(0, 2))).toEqual([['-i', value], ['-i', value]]);
    }
  });
});
