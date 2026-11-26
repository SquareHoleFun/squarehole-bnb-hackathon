// For alpha.test.mjs (SH-LANDING-ALPHA, the preview at alpha.squarehole.fun; from main's apps/landing/test/fixtures,
// SH-TA-01): scratch folders, a landing as a preview carries it, scratch commits of it, and the process stand-ins
// ship-alpha.sh, install-alpha.sh and smoke-alpha.sh run against (alpha-fixtures/). Nothing here connects, listens or
// needs root.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const PUBLIC = join(ROOT, 'apps/landing/public');
export const CADDYFILE = join(ROOT, 'infra/server/Caddyfile');
export const ROBOTS = 'User-agent: *\nDisallow: /\n';

export function scratch(prefix) {
  const dir = join(ROOT, '.cache/tmp');
  mkdirSync(dir, { recursive: true });
  return mkdtempSync(join(dir, prefix));
}

// The preview's policy is the landing's with its own scripts allowed (script-src 'self': sh-landing-anim's pager.js),
// as the preview's _headers lists it. Once the landing allows them too, the two are the same.
export function withScripts(csp) {
  return csp.includes("script-src 'self'") ? csp : csp.replace("default-src 'none'; ", "default-src 'none'; script-src 'self'; ");
}

// This checkout's landing as a preview in `dir`: its top-level files and the two pictures the checks fetch (not every
// picture: the landing grows, 34 MB on sh-landing-anim), its _headers asking for the preview's policy (and changed
// further by `edit`, given the file's text).
export function previewOf(dir, edit = (headers) => headers) {
  mkdirSync(dir, { recursive: true });
  for (const entry of readdirSync(PUBLIC, { withFileTypes: true })) {
    if (entry.isFile()) cpSync(join(PUBLIC, entry.name), join(dir, entry.name));
  }
  for (const file of ['brand/mark.svg', 'art/card-1200x630.jpg'].filter((name) => existsSync(join(PUBLIC, name)))) {
    mkdirSync(join(dir, dirname(file)), { recursive: true });
    cpSync(join(PUBLIC, file), join(dir, file));
  }
  const headers = readFileSync(join(dir, '_headers'), 'utf8')
    .replace(/^( {2}Content-Security-Policy: )(.*)$/m, (_, name, csp) => name + withScripts(csp));
  writeFileSync(join(dir, '_headers'), edit(headers));
  return dir;
}

// A scratch repository with one commit per entry of `landings` (a function that changes a fresh preview folder), so
// the scripts archive real commits without touching this repository. Git's global and system settings are left out
// (a signing or hook setting there must not apply).
export function scratchRepo(landings) {
  const repo = scratch('alpha-repo-');
  const env = {
    ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  // Beside the landing, as in this repository: files that must never ship with it.
  mkdirSync(join(repo, 'apps/landing/functions'), { recursive: true });
  cpSync(join(ROOT, 'apps/landing/functions/_middleware.js'), join(repo, 'apps/landing/functions/_middleware.js'));
  writeFileSync(join(repo, 'README.md'), 'A scratch repository for the alpha tests.\n');
  const landing = join(repo, 'apps/landing/public');
  const commits = landings.map((change, index) => {
    rmSync(landing, { recursive: true, force: true });
    change(previewOf(landing));
    git('add', '--all', '.');
    git('commit', '-q', '-m', `landing ${index}`);
    return git('rev-parse', 'HEAD');
  });
  return { repo, commits, git, archive: (commit, file) => git('archive', '--format=tar.gz', '-o', file, commit, 'apps/landing/public') };
}

// curl (answering as the Caddyfile's alpha site), ssh, scp and sudo stand-ins, first on PATH; on a Mac also mv, whose
// -T (GNU, as on the server) becomes BSD's -h, the same single rename of a link, and flock (alpha-fixtures/flock.sh),
// which a Mac lacks.
export function fakeBin(dir) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const fixture = (name) => readFileSync(new URL(`./alpha-fixtures/${name}`, import.meta.url));
  writeFileSync(join(bin, 'curl'), fixture('curl-alpha.mjs'), { mode: 0o755 });
  writeFileSync(join(bin, 'ssh'), fixture('ssh.sh'), { mode: 0o755 });
  writeFileSync(join(bin, 'scp'), fixture('scp.sh'), { mode: 0o755 });
  writeFileSync(join(bin, 'sudo'), '#!/bin/sh\n# Runs its command as the caller: the tests are not root.\nexec "$@"\n', { mode: 0o755 });
  if (spawnSync('mv', ['--version']).status !== 0) {
    writeFileSync(join(bin, 'mv'), '#!/bin/sh\nif [ "$1" = -T ]; then shift; exec /bin/mv -h "$@"; fi\nexec /bin/mv "$@"\n', { mode: 0o755 });
  }
  if (spawnSync('flock', ['--version']).status !== 0) writeFileSync(join(bin, 'flock'), fixture('flock.sh'), { mode: 0o755 });
  return bin;
}
