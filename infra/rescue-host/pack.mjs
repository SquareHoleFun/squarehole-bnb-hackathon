import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

// Copy only the installed viem dependency closure; never copy application packages or credentials.
// All modules in this closure are JavaScript. The tagged lockfile is shipped with the release record.
export function copyDependencies(from, destination) {
  const seen = new Map();
  function copy(name, parent, modules) {
    const require = createRequire(join(parent, 'package.json'));
    const installed = require.resolve.paths(name).map(path => join(path, name))
      .find(path => existsSync(join(path, 'package.json')));
    if (!installed) throw new Error('installed dependency missing');
    const source = realpathSync(installed);
    const canonical = source;
    const target = join(modules, name);
    mkdirSync(dirname(target), { recursive: true });
    if (seen.has(canonical)) {
      symlinkSync(relative(dirname(target), seen.get(canonical)), target);
      return;
    }
    seen.set(canonical, target);
    cpSync(source, target, { recursive: true, dereference: true,
      filter: path => path === source || !relative(source, path).split('/').includes('node_modules') });
    const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
    for (const dependency of Object.keys(pkg.dependencies ?? {})) copy(dependency, source, join(target, 'node_modules'));
  }
  copy('viem', from, destination);
}
export function pack(tag, output) {
  if (!/^core-v[\w.-]+$/.test(tag)) throw new Error('a core release tag is required');
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  const ref = `refs/tags/${tag}`;
  const commit = git(['rev-parse', '--verify', `${ref}^{commit}`]);
  if (commit !== git(['rev-parse', 'HEAD']) || git(['status', '--porcelain', '--untracked-files=no'])) {
    throw new Error('use a clean checkout of the release tag with its locked dependencies installed');
  }
  const destination = resolve(output);
  if (existsSync(destination) || existsSync(`${destination}.tar.gz`)) throw new Error('choose an unused output directory');
  mkdirSync(destination, { recursive: true });
  const archive = execFileSync('git', ['-C', repo, 'archive', '--format=tar', ref, '--',
    'scripts/box/drand-rescue', 'infra/rescue-host', 'pnpm-lock.yaml']);
  execFileSync('tar', ['-xf', '-', '-C', destination], { input: archive });
  const from = join(repo, 'packages/keeper');
  const require = createRequire(join(from, 'package.json'));
  if (require('viem/package.json').version !== '2.56.8') throw new Error('viem version refused');
  copyDependencies(from, join(destination, 'node_modules'));
  writeFileSync(join(destination, 'release.json'), `${JSON.stringify({ tag, commit, node: '24.22.1', viem: '2.56.8' }, null, 2)}\n`);
  execFileSync('tar', ['-czf', `${destination}.tar.gz`, '-C', destination, '.']);
  const hash = createHash('sha256').update(readFileSync(`${destination}.tar.gz`)).digest('hex');
  writeFileSync(`${destination}.sha256`, `${hash}  ${destination.split('/').at(-1)}.tar.gz\n`);
}
// Node gives import.meta.url as the real path, so compare it with the real path of the started file (symlinks).
function startedDirectly() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (startedDirectly()) {
  try {
    if (process.argv.length !== 4) throw new Error('usage: node infra/rescue-host/pack.mjs <release-tag> <new-output-directory>');
    pack(process.argv[2], process.argv[3]);
    process.stdout.write('rescue release packed\n');
  } catch { process.stderr.write('rescue release packaging refused\n'); process.exitCode = 1; }
}
