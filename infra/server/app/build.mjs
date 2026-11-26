import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configOf, policyOf, renderSites, requireAlphaEntries } from './config.mjs';
import { requireTools } from './tools.mjs';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function checkout(root, commit) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Supply the full reviewed commit');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (git('rev-parse', 'HEAD') !== commit) throw new Error('App shipping requires HEAD to equal the reviewed commit');
  if (git('status', '--porcelain', '--untracked-files=all')) throw new Error('App shipping requires a clean checkout');
  // Vite loads these even when the process environment is empty. Never silently embed an ignored local setting.
  // One exemption: the repository root's .env.example as committed (documentation; `vite build` in production mode
  // never loads it). It must be a regular file in HEAD's tree (mode 100644, so no symlink) whose bytes on disk equal
  // that blob, compared without Git's filters (an assume-unchanged or skip-worktree edit, CRLF conversion or a clean filter does not count). The same name anywhere else, untracked or
  // ignored, a symlink or changed bytes are refused like any other env file.
  const committedExample = () => {
    try {
      const entry = git('ls-tree', 'HEAD', '--', '.env.example').match(/^100644 blob ([0-9a-f]{40})\t\.env\.example$/);
      return Boolean(entry) && lstatSync(join(root, '.env.example')).isFile() && git('hash-object', '--no-filters', '--', '.env.example') === entry[1];
    } catch {
      return false;
    }
  };
  for (const directory of [root, join(root, 'apps/web')]) {
    for (const name of readdirSync(directory)) {
      if (!/^\.env($|\.)/.test(name)) continue;
      if (directory === root && name === '.env.example' && committedExample()) continue;
      throw new Error('Remove local Vite env files from the build checkout (move them aside)');
    }
  }
}

export function publicFiles(directory, prefix = '') {
  const files = {};
  for (const name of readdirSync(join(directory, prefix)).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (!/^[A-Za-z0-9_./-]+$/.test(path)) throw new Error('Unsupported public filename');
    const stat = lstatSync(join(directory, path));
    if (stat.isDirectory()) Object.assign(files, publicFiles(directory, path));
    else if (!stat.isFile()) throw new Error('Public build must contain regular files only');
    else if (path.endsWith('.map')) throw new Error('Public build contains a source map');
    else files[path] = sha256(readFileSync(join(directory, path)));
  }
  return files;
}

export async function buildRelease({ root, commit, out, target, configText, dryRun = false }, run = execFileSync) {
  requireTools('git', 'pnpm');
  const config = configOf(configText, target);
  checkout(root, commit);
  const headers = await policyOf(root, config);
  if (dryRun) return { ...config, commit, headers };
  if (existsSync(out)) throw new Error('App output must be a fresh directory');
  mkdirSync(out, { recursive: true });
  const publicDir = resolve(out, 'public');
  // No caller SH_*, VITE_*, NODE_OPTIONS, credentials, local manifests or placeholder bypass enters this build.
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR'].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  // configOf has checked the argument against G08; caller settings cannot select the target or legal mode.
  Object.assign(env, { SH_BUILD: 'production', SH_TARGET: target, SH_FIT_MARKET: 'none', SH_CORE_SEPOLIA_INDEXER_ORIGIN: 'https://api.squarehole.fun', SH_SEPOLIA_INDEXER_ORIGIN: 'https://api.squarehole.fun' });
  const commands = [
    ['--filter', '@squarehole/web', 'exec', 'vite', 'build', '--outDir', publicDir],
    ['check:production'],
    ['--filter', '@squarehole/web', 'check:production', '--no-build', '--same-as', publicDir],
  ];
  for (const args of commands) {
    // Avoid exposing unexpected build literals in diagnostics; a refusal never produces a ship-ready manifest.
    try { run('pnpm', args, { cwd: root, env, stdio: 'ignore' }); }
    catch { throw new Error(`App release refused by pnpm ${args.includes('vite') ? 'production build' : 'check:production'}; reproduce the check in the reviewed build environment`); }
  }
  checkout(root, commit);
  const files = publicFiles(publicDir);
  if (!files['index.html'] || !Object.keys(files).some((name) => /^assets\/.*-[\w-]{8,}\.js$/.test(name))) throw new Error('App build lacks index or fingerprinted script');
  requireAlphaEntries(config, files);
  const content = { format: 'squarehole.app-release/1', ...config, legal: 'test-network', commit, headers, files };
  const release = { ...content, id: sha256(JSON.stringify(content)) };
  const sites = renderSites(release);
  writeFileSync(join(out, 'release.json'), `${JSON.stringify(release, null, 2)}\n`, { flag: 'wx' });
  writeFileSync(join(out, 'app.site.caddy'), sites.site, { flag: 'wx' });
  writeFileSync(join(out, 'app.cors.caddy'), sites.cors, { flag: 'wx' });
  const sums = Object.entries(files).map(([name, hash]) => `${hash}  public/${name}`);
  for (const name of ['release.json', 'app.site.caddy', 'app.cors.caddy']) sums.push(`${sha256(readFileSync(join(out, name)))}  ${name}`);
  writeFileSync(join(out, 'SHA256SUMS'), `${sums.join('\n')}\n`, { flag: 'wx' });
  return release;
}

// Node gives import.meta.url as the real path, so compare it with the real path of the started file (symlinks).
function startedDirectly() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (startedDirectly()) {
  const [commit, target, configFile, out, mode] = process.argv.slice(2);
  try {
    requireTools('git', 'pnpm');
    if (!commit || !target || !configFile || !out || (mode && mode !== '--dry-run')) throw new Error('Usage: build.mjs <reviewed commit> <sepolia> <public env file> <fresh output> [--dry-run]');
    const release = await buildRelease({ root: process.cwd(), commit, target, configText: readFileSync(configFile, 'utf8'), out, dryRun: mode === '--dry-run' });
    process.stdout.write(`app-build: ${mode ? 'dry run; production checks still required' : 'production checked'}; ${release.commit}\n`);
  } catch (error) {
    // Filesystem diagnostics can contain operator input; report only our controlled errors.
    process.stderr.write(`app-build: ${error.code ? 'cannot read or write release inputs' : error.message}\n`);
    process.exitCode = 1;
  }
}
