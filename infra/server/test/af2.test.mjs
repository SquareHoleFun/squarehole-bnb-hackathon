import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shLimit } from '../../../vitest.timeouts.mjs';
import { execFileSync, spawnSync } from './local-command.mjs';
import { shipFixture } from './ship-fixture.mjs';
import { realFixture, snapshot } from './af2-fixture.mjs';

const scriptOf = lane => lane === 'alpha' ? 'ship-alpha.sh' : 'ship.sh';
const argsOf = (f, lane) => lane === 'app' ? ['--app', 'sepolia', '--config', f.config, f.commit] : [f.commit];
const records = file => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
// What this observes (review R3-L1): ssh, scp, rsync and curl started through the inherited PATH by any process of
// the run, at any depth (plain name, `command`, `env`, Node execFile or spawn). It does not observe a transport
// started by an absolute path, under a reset PATH, or networking done by Node itself; the ship helpers use none.
// So an empty log means: no transfer through a PATH transport. It is a recorder, not an offline sandbox.
const noTransfers = f => expect(records(join(f.trace, 'effects'))).toEqual([]);
const normalized = value => value.replace(/ship(?:-alpha)?\.(?:DRY-RUN|[A-Za-z0-9]+)/g, 'ship.WORK')
  .replace(/(squarehole-app-[a-f0-9]{40})-\d+\.tar/g, '$1-PID.tar');
// Pipeline processes can enter their stand-ins in either order; the pipeline's place in the plan is fixed.
function pipelineOrder(calls) {
  const ordered = [...calls];
  for (let i = 0; i < ordered.length - 1; i++) {
    const [a, b] = [ordered[i], ordered[i + 1]];
    if ((a.tool === 'node' && a.args[0]?.endsWith('/archive.mjs') && b.tool === 'git' && b.args.includes('archive')) ||
      (a.tool === 'cut' && b.tool === 'du') || (a.tool === 'sed' && b.tool === 'git' && b.args[0] === 'show')) {
      [ordered[i], ordered[i + 1]] = [b, a];
      i++;
    }
  }
  return ordered.map(call => ({ ...call, args: call.args.map(normalized) }));
}

describe('SH-204 af2', () => {
  const probes = ['stack', 'app', 'alpha'].flatMap(lane => [
    [lane, 'root', ['rev-parse', '--show-toplevel'], false],
    [lane, 'commit', ['rev-parse', '--verify'], false],
    [lane, 'status', ['status'], false],
    ...(lane === 'app' ? [
      [lane, 'builder HEAD', ['rev-parse', 'HEAD'], false],
      [lane, 'builder status', ['status'], false, 2],
    ] : [
      [lane, 'inventory', ['ls-tree', '-r', '--name-only'], true],
      [lane, 'show', ['show'], false],
      [lane, 'archive', ['archive'], false],
    ]),
    ...(lane === 'alpha' ? [
      [lane, 'policy tree', ['ls-tree', '-r'], false],
      ...['index.html', '404.html', '_headers', 'styles.css'].flatMap(file => ['-t', '-s'].map(flag =>
        [lane, `${file} ${flag}`, ['cat-file', flag, `${'a'.repeat(40)}:apps/landing/public/${file}`], false])),
    ] : []),
  ]);
  it.each(probes)('af3 M1 %s refuses successful output then failure: %s', (lane, label, probe, dry, occurrence = 1) => {
    const f = shipFixture();
    const result = f.runScript(scriptOf(lane), [...(dry ? ['--dry-run'] : []), ...argsOf(f, lane)], { env: {
      ...f.env, SHIP_FIXTURE_GIT_FAIL: JSON.stringify(probe), SHIP_FIXTURE_GIT_FAIL_N: String(occurrence),
    } });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).not.toBe(0);
    const fault = JSON.parse(readFileSync(join(f.trace, 'git-fault'), 'utf8'));
    const calls = records(join(f.trace, 'git-calls')).map(call => call[0] === '-c' ? call.slice(2) : call);
    expect(calls.at(-1)).toEqual(fault);
    // Stack's manifest show follows its archive. The failed archive itself may emit partial local bytes.
    expect(calls.filter(call => call[0] === 'archive')).toHaveLength(label === 'archive' || (lane === 'stack' && label === 'show') ? 1 : 0);
    expect(f.calls().some(call => ['pnpm', 'scp', 'ssh', 'rsync', 'curl'].includes(call.tool))).toBe(false);
    noTransfers(f);
  });

  it.each(['ssh', 'scp', 'rsync', 'curl'])('af3 L1 catches a helper %s before its injected failure', tool => {
    const f = realFixture({ packScript: `#!/usr/bin/env bash\n${tool} fixture-transfer </dev/null\necho fixture helper failure >&2\nexit 48\n` });
    const result = f.runScript('ship.sh', argsOf(f, 'app'));
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(48);
    expect(result.stderr).toContain('fixture helper failure');
    expect(records(join(f.trace, 'commands')).some(call => call.tool === tool)).toBe(false);
    // The exact assertion used by the failure tests must reject the review's nested-transfer regression.
    expect(() => noTransfers(f)).toThrow();
    expect(records(join(f.trace, 'effects')).map(call => call.tool)).toEqual([tool]);
  });

  it.each(['ls-tree', 'hash-object'])('af3 M1 builder refuses failed example probe: %s', probe => {
    const f = shipFixture();
    // Virtual directory entry/stat only. No env file is created or read; Git emits fixture bytes.
    const source = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
      const list = fs.readdirSync, stat = fs.lstatSync, read = fs.readFileSync, root = process.cwd();
      fs.readdirSync = (path, ...args) => path === root ? [...list(path, ...args), '.env.example'] : list(path, ...args);
      fs.lstatSync = (path, ...args) => stat(path === root + '/.env.example' ? root + '/.cache/public-config.txt' : path, ...args);
      fs.readFileSync = (path, ...args) => { if (String(path).split('/').at(-1).startsWith('.env')) throw new Error('unexpected env read'); return read(path, ...args); };
      syncBuiltinESMExports();
      const { checkout } = await import('./infra/server/app/build.mjs'); checkout(root, process.argv[1]);`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, f.commit], { cwd: f.root,
      env: { ...f.env, SHIP_FIXTURE_GIT_FAIL: JSON.stringify([probe]) }, encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Remove local Vite env files');
    const fault = JSON.parse(readFileSync(join(f.trace, 'git-fault'), 'utf8'));
    expect(records(join(f.trace, 'git-calls')).at(-1)).toEqual(fault);
    expect(f.calls()).toEqual([]);
    noTransfers(f);
  });

  it.each(['stack', 'app', 'alpha'])('M1 %s refuses an empty failed Git status before work', lane => {
    const f = shipFixture();
    for (const dry of [true, false]) {
      const result = f.runScript(scriptOf(lane), [...(dry ? ['--dry-run'] : []), ...argsOf(f, lane)],
        { env: { ...f.env, SHIP_FIXTURE_STATUS_FAIL: '1' } });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('git status failed');
      expect(f.calls()).toEqual([]);
      noTransfers(f);
      expect(readFileSync(join(f.trace, 'git-calls'), 'utf8')).not.toContain('"archive"');
      expect(existsSync(join(f.root, '.cache/tmp'))).toBe(false);
    }
  });

  it('M1 app build checkout already rejects Git failure', () => {
    const f = shipFixture();
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      'import { checkout } from "./infra/server/app/build.mjs"; checkout(process.cwd(), process.argv[1]);', f.commit],
    { cwd: f.root, env: { ...f.env, SHIP_FIXTURE_STATUS_FAIL: '1' }, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('git status');
    expect(f.calls()).toEqual([]);
    noTransfers(f);
  });

  it.each(['stack', 'app', 'alpha'])('L1 %s complete dry plan equals the executed command trace', lane => {
    const f = realFixture();
    const before = snapshot(f.root);
    const plan = f.runScript(scriptOf(lane), ['--dry-run', ...argsOf(f, lane)]);
    expect(plan.status, plan.stderr).toBe(0);
    noTransfers(f);
    expect(snapshot(f.root)).toEqual(before);
    const file = join(f.trace, 'commands');
    const preflight = records(file);
    expect(preflight.every(call => call.tool === 'git')).toBe(true);
    expect(preflight.some(call => call.args.includes('archive'))).toBe(false);
    expect(existsSync(join(f.root, '.cache/tmp'))).toBe(false);
    const lines = plan.stdout.split('\n').filter(line => /^(docker|mkdir|mktemp|git|node|bash|cp|du|scp|ssh|tar|rm) /.test(line));
    // The full sequence, independent of the production renderer.
    const expected = lane === 'app' ? ['docker', 'mkdir', 'mktemp', 'node', 'bash', 'cp', 'bash', 'scp', 'ssh', 'bash']
      : ['mkdir', 'mktemp', 'git', 'du', ...(lane === 'stack' ? ['git'] : []), 'scp', 'ssh', 'tar', 'bash', ...(lane === 'alpha' ? ['rm'] : [])];
    expect(lines.map(line => line.split(' ')[0])).toEqual(expected);
    writeFileSync(file, '');
    for (const line of lines) {
      const replay = spawnSync(f.real.bash, ['-o', 'pipefail', '-c', line], { cwd: f.root,
        env: { ...f.env, SH_AF2_RECORD_ONLY: '1' }, encoding: 'utf8' });
      expect(replay.status, replay.stderr).toBe(0);
    }
    const planned = records(file);
    writeFileSync(file, '');
    const real = f.runScript(scriptOf(lane), argsOf(f, lane));
    expect(real.status, real.stderr).toBe(0);
    const executed = records(file).filter(call => !(call.tool === 'git' && !call.args.includes('archive') &&
      !(lane === 'stack' && call.args[0] === 'show')));
    expect(pipelineOrder(executed)).toEqual(pipelineOrder(planned));
    if (lane === 'alpha') expect(executed.find(call => call.tool === 'ssh').input).toBe(readFileSync('infra/server/install-alpha.sh', 'utf8'));
  }, shLimit(90000));

  it('L2 resolves a relative config from infra/server before changing folder', () => {
    const f = realFixture();
    for (const dry of [true, false]) {
      writeFileSync(join(f.trace, 'commands'), '');
      const result = f.runScript('ship.sh', ['--app', 'sepolia', '--config', '../../.cache/public-config.txt',
        ...(dry ? ['--dry-run'] : []), f.commit], { cwd: join(f.root, 'infra/server') });
      expect(result.status, result.stderr).toBe(0);
      const calls = records(join(f.trace, 'commands'));
      if (dry) noTransfers(f);
      else {
        expect(calls.filter(call => call.tool === 'ssh')).toHaveLength(1);
        expect(calls.find(call => call.tool === 'ssh').args).toContain('fixture@offline.invalid');
        const build = calls.find(call => call.tool === 'node' && call.args[0].endsWith('/build.mjs'));
        expect(build.args.slice(1, 4)).toEqual([f.commit, 'sepolia', `${f.root}/infra/server/../../.cache/public-config.txt`]);
        expect(resolve(build.args[3])).toBe(f.config);
      }
    }
  });

  it.each(['stack', 'app', 'alpha'])('Options %s cannot turn a dry-run spelling into execution', lane => {
    const f = shipFixture(), args = argsOf(f, lane);
    // A real file named like the flag used to turn --config --dry-run into a real ship.
    writeFileSync(join(f.root, '--dry-run'), '');
    const cases = [
      { args: ['--dry-run', ...args], ok: true }, { args: [...args, '--dry-run'], ok: true },
      { args: ['--dry-run', ...args, '--dry-run'], ok: true },
      ...['--dryrun', '--dry-rnu', '--dry-run=true', '-dry-run'].map(flag => ({ args: [flag, ...args], ok: false })),
      { args: ['--config', '--dry-run', ...args], ok: false },
      { args: ['--app', '--dry-run', ...args], ok: false },
      { args: ['--dry-run', ...args, '--config'], ok: false },
      { args: ['--dry-run', ...args, '--app'], ok: false },
      { args: ['--dry-run', '', ...args], ok: true },
      { args: ['--dry-run', ...args, '--'], ok: false },
      { args: ['--config', '', '--dry-run', ...args], ok: false },
      { args: ['--app', '', '--dry-run', ...args], ok: false },
    ];
    for (const test of cases) {
      const result = f.runScript(scriptOf(lane), test.args);
      expect(result.status === 0, test.args.join(' ') + '\n' + result.stderr).toBe(test.ok);
      expect(f.calls(), test.args.join(' ')).toEqual([]);
      noTransfers(f);
      expect(existsSync(join(f.root, '.cache/tmp'))).toBe(false);
    }
  });

  it.each(['stack', 'alpha'].flatMap(lane => ['archive', 'compressor', 'disk', 'interrupt'].map(failure => [lane, failure])))(
    '6b %s stops at the transfer boundary on %s failure', (lane, failure) => {
      const f = realFixture();
      writeFault(f, failure);
      const result = f.runScript(scriptOf(lane), argsOf(f, lane), { env: { ...f.env, SH_AF2_FAILURE: failure,
        ...(failure === 'interrupt' ? { NODE_OPTIONS: `--import=${join(f.trace, 'fault.mjs')}` } : {}) } });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).not.toBe(0);
      if (failure === 'archive') expect(result.stderr).toContain('__missing_fixture_archive_member__');
      if (failure === 'compressor') expect(result.stderr).toContain('fixture compressor failure');
      if (failure === 'disk') expect(result.stderr).toContain('fixture full disk');
      if (failure === 'interrupt') expect(result.stderr).toContain('fixture interrupt during archive write');
      const calls = records(join(f.trace, 'commands'));
      expect(calls.some(call => call.args.includes('archive'))).toBe(true);
      noTransfers(f);
    });

  it.each(['check', 'interrupt', 'disk', 'rewrite', 'replace', 'symlink'])('6b app stops at the transfer boundary on %s failure', failure => {
    const f = realFixture();
    writeFault(f, failure);
    const result = f.runScript('ship.sh', argsOf(f, 'app'), { env: { ...f.env, SH_AF2_FAILURE: failure } });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).not.toBe(0);
    if (failure === 'disk') expect(result.stderr).toContain('fixture full disk');
    if (failure === 'interrupt') expect(result.stderr).toContain('fixture interrupt during archive write');
    if (failure === 'check') expect(result.stderr).toContain('incorrect header check');
    const calls = records(join(f.trace, 'commands'));
    expect(calls.some(call => call.tool === 'bash' && call.args[0].endsWith('/pack.sh'))).toBe(true);
    noTransfers(f);
    if (['rewrite', 'replace', 'symlink'].includes(failure)) {
      expect(result.stderr).toContain('install.sh');
      expect(result.stderr).toContain('file changed while packing');
    }
  });

  it('6c alpha offline lab uses the new archive pipeline for both commits', () => {
    const f = realFixture();
    const source = readFileSync('infra/server/test/alpha-offline-check.sh', 'utf8');
    const lines = source.split('\n').filter(line => /^git .*archive /.test(line));
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toContain('-c tar.umask=0022 archive --format=tar');
    const lab = join(f.root, '.cache/lab');
    mkdirSync(lab);
    execFileSync(f.real.bash, ['-e', '-o', 'pipefail', '-c', lines.join('\n')], { cwd: f.root, env: {
      ...process.env, OLD: f.commit, NEW: f.commit, LAB: lab, here: resolve('infra/server/test'),
    } });
    for (const file of ['old', 'new']) {
      const members = execFileSync(f.real.tar, ['-tzf', join(lab, `${file}.tar.gz`)], { encoding: 'utf8' });
      expect(members).toContain('apps/landing/public/index.html');
    }
  });

  it('6a old and new Git archives preserve every member and byte; modes remove group write only', () => {
    const f = realFixture(), old = join(f.root, '.cache/old.tar.gz'), fresh = join(f.root, '.cache/new.tar.gz');
    const paths = ['infra/server/ship.sh', 'infra/server/app/pack.mjs', 'apps/landing/public'];
    execFileSync(f.real.git, ['archive', '--format=tar.gz', '-o', old, f.commit, ...paths], { cwd: f.root, env: f.env });
    execFileSync(f.real.bash, ['-o', 'pipefail', '-c', '"$1" -c tar.umask=0022 archive --format=tar "$2" "${@:5}" | "$3" "$4" "$OUT"',
      'fixture', f.real.git, f.commit, process.execPath, resolve('infra/server/app/archive.mjs'), ...paths],
    { cwd: f.root, env: { ...f.env, OUT: fresh } });
    const before = manifest(old), after = manifest(fresh);
    expect(after.map(entry => ({ ...entry, mode: 0 }))).toEqual(before.map(entry => ({ ...entry, mode: 0 })));
    expect(after.map(entry => entry.mode)).toEqual(before.map(entry => entry.mode & ~0o022));
    expect(before.some((entry, i) => entry.mode !== after[i].mode)).toBe(true);
    nativeCompare(f, old, fresh, after);
  });

  it('6a old host-tar and new app pack preserve every member and byte with canonical metadata', () => {
    const f = realFixture(), work = join(f.root, '.cache/artifact-work');
    mkdirSync(join(work, 'artifact/public'), { recursive: true });
    writeFileSync(join(work, 'artifact/public/z.txt'), Buffer.from([0, 255, 10]));
    writeFileSync(join(work, 'artifact/public/a.txt'), 'same bytes');
    writeFileSync(join(work, 'install.sh'), '#!/usr/bin/env bash\n');
    for (const name of ['artifact', 'artifact/public', 'artifact/public/z.txt', 'artifact/public/a.txt', 'install.sh']) {
      chmodSync(join(work, name), name.includes('.') ? 0o600 : 0o700);
      utimesSync(join(work, name), 1700000000, 1700000000);
    }
    const old = join(f.root, '.cache/old-app.tar.gz'), fresh = join(f.root, '.cache/new-app.tar.gz');
    const version = execFileSync(f.real.tar, ['--version'], { encoding: 'utf8' });
    execFileSync(f.real.tar, ['--no-xattrs', ...(version.includes('bsdtar') ? ['--no-mac-metadata'] : []), '-czf', old, '-C', work, 'artifact', 'install.sh'],
      { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    execFileSync(process.execPath, [resolve('infra/server/app/pack.mjs'), work, fresh]);
    const before = manifest(old), after = manifest(fresh);
    const content = entries => entries.map(({ name, type, bytes }) => ({ name, type, bytes })).sort((a, b) => a.name.localeCompare(b.name));
    expect(content(after)).toEqual(content(before));
    for (const entry of after) {
      expect([entry.uid, entry.gid, entry.mtime, entry.uname, entry.gname]).toEqual([0, 0, 0, '', '']);
      expect(entry.mode).toBe(entry.type === 'dir' || entry.name === 'install.sh' ? 0o755 : 0o644);
    }
    expect(before.every(entry => entry.mtime === 1700000000)).toBe(true);
    expect(after.map(entry => entry.name)).toEqual(after.map(entry => entry.name).sort());
    nativeCompare(f, old, fresh, after);
    // Retain measured metadata for the evidence without depending on this machine's account number/name.
    writeFileSync(resolve('.cache/tmp/af2-app-metadata.json'), JSON.stringify({ before, after }, null, 2));
  });

  it('7 both runbooks explain Linux Docker access, image preparation and incomplete session smoke', () => {
    for (const file of ['server.md', 'app-hosting.md']) {
      const text = readFileSync(`docs/runbooks/${file}`, 'utf8');
      for (const fact of ['13 November 2026', 'newgrp docker', 'next login', 'permission denied',
        'docker build -f infra/server/caddy.Dockerfile -t squarehole-caddy:2.11.6-ratelimit infra/server',
        'caddy version', 'caddy list-modules', 'http.handlers.rate_limit', 'alpha session check failed',
        'ships 13 and 14', '/join', '/v2/feed', 'CORS']) expect(text, `${file}: ${fact}`).toContain(fact);
    }
  });

  it('af3 L2 both runbooks check Arch Docker preparation in order before building', () => {
    for (const file of ['server.md', 'app-hosting.md']) {
      const text = readFileSync(`docs/runbooks/${file}`, 'utf8');
      const commands = ['sudo pacman -S --needed docker docker-compose docker-buildx', 'docker --version',
        'sudo systemctl enable --now docker', 'systemctl is-active docker', 'docker buildx version',
        'sudo usermod -aG docker "$(id -un)"', 'id -nG "$(id -un)"', 'newgrp docker', 'id -nG\n', 'docker info',
        'docker build -f infra/server/caddy.Dockerfile', 'caddy version', 'caddy list-modules'];
      let previous = -1;
      for (const command of commands) {
        const at = text.indexOf(command, previous + 1);
        expect(at, `${file}: ${command} must follow the previous check`).toBeGreaterThan(previous);
        previous = at;
      }
      expect(text).toContain('Nothing else may write to the checkout during a ship');
    }
  });
});

// Independent stdlib parser includes Git's global PAX header; real host tar also extracts both results.
function manifest(path) {
  return JSON.parse(execFileSync('python3', ['-c', `import json, sys, tarfile
with tarfile.open(sys.argv[1]) as archive:
 print(json.dumps([dict(name=m.name.rstrip('/'), type='dir' if m.isdir() else 'file', bytes='' if m.isdir() else archive.extractfile(m).read().hex(), mode=m.mode, uid=m.uid, gid=m.gid, uname=m.uname, gname=m.gname, mtime=m.mtime) for m in archive]))`, path], { encoding: 'utf8' }));
}

function nativeCompare(f, old, fresh, entries) {
  const roots = [old, fresh].map(path => {
    const directory = `${path}.extracted`;
    mkdirSync(directory);
    execFileSync(f.real.tar, ['-xzpf', path, '-C', directory]);
    return directory;
  });
  for (const entry of entries) {
    const paths = roots.map(root => join(root, entry.name));
    expect(lstatSync(paths[1]).mode & 0o777).toBe(entry.mode);
    if (entry.type === 'file') expect(readFileSync(paths[0])).toEqual(readFileSync(paths[1]));
  }
}

function writeFault(f, failure) {
  const source = ['rewrite', 'replace', 'symlink'].includes(failure) ? `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const open = fs.openSync, read = fs.readSync; let target, path, changed = false;
    fs.openSync = (file, ...args) => { const fd = open(file, ...args); if (typeof file === 'string' && file.endsWith('/install.sh') && !changed) { target = fd; path = file; } return fd; };
    fs.readSync = (fd, buffer, offset, length, position) => {
      if (fd !== target || changed) return read(fd, buffer, offset, length, position);
      const count = read(fd, buffer, offset, Math.min(length, 128), position); changed = true;
      const bytes = Buffer.alloc(fs.fstatSync(fd).size, 98);
      if (${JSON.stringify(failure)} === 'rewrite') fs.writeFileSync(path, bytes);
      else { const next = path + '.next'; if (${JSON.stringify(failure)} === 'symlink') fs.symlinkSync('artifact/release.json', next); else fs.writeFileSync(next, bytes); fs.renameSync(next, path); }
      return count;
    }; syncBuiltinESMExports();`
    : failure === 'disk' ? `import fs from 'node:fs'; import { Writable } from 'node:stream'; import { syncBuiltinESMExports } from 'node:module';
    fs.createWriteStream = () => new Writable({ write(chunk, encoding, done) { done(Object.assign(new Error('fixture full disk'), { code: 'ENOSPC' })); } }); syncBuiltinESMExports();`
    : failure === 'check' ? `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
      const read = fs.readFileSync; fs.readFileSync = (path, ...rest) => typeof path === 'string' && path.endsWith('.tar.gz') ? Buffer.from('invalid pack check') : read(path, ...rest); syncBuiltinESMExports();`
      : `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
        const write = fs.createWriteStream; fs.createWriteStream = (...args) => {
          const stream = write(...args), original = stream._write;
          stream._write = function(chunk, encoding, done) { original.call(this, chunk, encoding, error => {
            fs.writeSync(2, 'fixture interrupt during archive write\\n'); process.kill(process.pid, 'SIGINT'); done(error);
          }); }; return stream;
        }; syncBuiltinESMExports();`;
  writeFileSync(join(f.trace, 'fault.mjs'), source);
}
