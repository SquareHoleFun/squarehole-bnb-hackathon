import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { execFileSync, spawnSync } from './local-command.mjs';
import { shipFixture } from './ship-fixture.mjs';

// A public, isolated Git repository. Plumbing creates its fixture commit without staging anything.
export function realFixture({ packScript } = {}) {
  const f = shipFixture();
  if (packScript) writeFileSync(join(f.root, 'infra/server/app/pack.sh'), packScript);
  const real = Object.fromEntries(['git', 'bash', 'node', 'tar', 'mkdir', 'mktemp', 'cp', 'du', 'cut', 'sed', 'rm'].map(name =>
    [name, execFileSync('bash', ['-c', 'command -v "$1"', 'fixture', name], { encoding: 'utf8' }).trim()]));
  mkdirSync(join(f.root, 'apps/landing/public'), { recursive: true });
  mkdirSync(join(f.root, 'packages/contracts/deployments/core-v1'), { recursive: true });
  writeFileSync(join(f.root, 'packages/contracts/deployments/core-v1/11155111.json'), '{"status":"fixture"}\n');
  const source = readFileSync('infra/server/ship.sh', 'utf8');
  for (const path of source.split('\npaths=(\n')[1].split('\n)')[0].trim().split(/\s+/)) {
    const full = join(f.root, path);
    try { lstatSync(full); } catch {
      mkdirSync(resolve(full, '..'), { recursive: true });
      writeFileSync(full, path.endsWith('.json') ? '{"status":"fixture"}\n' : 'public fixture\n');
    }
  }
  const landing = join(f.root, 'apps/landing/public');
  for (const name of ['index.html', '404.html', 'styles.css']) writeFileSync(join(landing, name), `fixture ${name}\n`);
  writeFileSync(join(landing, '_headers'), readFileSync(join(f.root, '.cache/headers')));
  writeFileSync(join(f.root, '.gitignore'), '.cache/\n');
  f.env = { ...f.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Offline fixture', GIT_AUTHOR_EMAIL: 'fixture@invalid',
    GIT_COMMITTER_NAME: 'Offline fixture', GIT_COMMITTER_EMAIL: 'fixture@invalid',
    GIT_AUTHOR_DATE: '2026-11-13T00:00:00Z', GIT_COMMITTER_DATE: '2026-11-13T00:00:00Z',
    SH_AF2_DEPTH: '0' };
  const git = (args, input) => execFileSync(real.git, args, { cwd: f.root, env: f.env, input, encoding: 'utf8' }).trim();
  git(['init', '--quiet']);
  const tree = directory => git(['mktree'], readdirSync(directory).filter(name => !['.git', '.cache'].includes(name)).sort().map(name => {
    const path = join(directory, name), stat = lstatSync(path);
    return stat.isDirectory() ? `040000 tree ${tree(path)}\t${name}\n`
      : `${stat.mode & 0o111 ? '100755' : '100644'} blob ${git(['hash-object', '-w', '--stdin'], readFileSync(path))}\t${name}\n`;
  }).join(''));
  f.commit = git(['commit-tree', tree(f.root)], 'Public offline fixture\n');
  git(['update-ref', 'HEAD', f.commit]);
  // Populate only this fixture's index from its tree, so real status can verify a clean checkout.
  git(['read-tree', 'HEAD']);
  writeFileSync(join(f.trace, 'real-tools.json'), JSON.stringify(real));
  for (const tool of [...Object.keys(real), 'ssh', 'scp', 'rsync', 'docker', 'curl', 'pnpm', 'shellcheck']) {
    const wrapper = readFileSync('infra/server/test/ship-fixtures/af2-tool.mjs', 'utf8').replace('#!/usr/bin/env node', `#!${process.execPath}`);
    writeFileSync(join(f.bin, tool), wrapper);
    chmodSync(join(f.bin, tool), 0o755);
  }
  f.real = real;
  f.runScript = (script, args, options = {}) => spawnSync(real.bash, [join(f.root, 'infra/server', script), ...args],
    { cwd: f.root, env: f.env, encoding: 'utf8', timeout: 90000, ...options });
  return f;
}

// Only used on the synthetic repository, including its index. Ordinary read atime is intentionally excluded.
export function snapshot(root) {
  const entries = [];
  const walk = path => {
    const stat = lstatSync(path, { bigint: true });
    entries.push({ path: relative(root, path), mode: String(stat.mode), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
      bytes: stat.isFile() ? readFileSync(path).toString('hex') : undefined,
      link: stat.isSymbolicLink() ? readlinkSync(path) : undefined });
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name));
  };
  walk(root);
  return entries;
}
