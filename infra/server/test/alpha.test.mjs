// SH-LANDING-ALPHA on the integration line (SH-TA-01): the alpha tests from main's apps/landing/test (server.test.js and
// smoke.test.js), here beside the scripts they check, so apps/landing stays the live release's byte for byte. Also the
// install.sh Caddy check with the app folder mounted as compose.yaml mounts it.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { CADDYFILE, ROBOTS, ROOT, fakeBin, previewOf, scratch, scratchRepo, withScripts } from './alpha-fixture.mjs';

const read = (path) => readFileSync(`${ROOT}${path}`, 'utf8');
const caddy = read('infra/server/Caddyfile');

// Extract complete top-level Caddy blocks, without treating placeholders such as {uri} as block delimiters.
function block(name) {
  const start = caddy.indexOf(`${name} {\n`);
  expect(start, `missing Caddy block: ${name}`).toBeGreaterThanOrEqual(0);
  return caddy.slice(start + name.length + 3, caddy.indexOf('\n}', start));
}

// SH-LANDING-ALPHA: the preview at alpha.squarehole.fun, the installer that puts one on the server and the script that
// ships it. The scripts run here against scratch folders and stand-ins (fixtures/alpha.mjs): no SSH, Docker or root.
const ALPHA = 'http://alpha.squarehole.fun, https://alpha.squarehole.fun';
const headersOf = (name) => Object.fromEntries(block(name).split('\n').map((line) => line.trim())
  .filter((line) => line && line !== 'header {' && line !== '}')
  .map((line) => line.match(/^(\S+)\s+"(.*)"$/).slice(1)));
// Every top-level site address line, in order.
const siteLines = () => caddy.match(/^[^\s#(][^\n]* \{$/gm);

describe('alpha.squarehole.fun, the preview on the droplet', () => {
  let repo;
  beforeAll(() => {
    repo = scratchRepo([
      () => {},
      (dir) => writeFileSync(join(dir, 'index.html'), `${readFileSync(join(dir, 'index.html'), 'utf8')}<!-- round 2 -->\n`),
      (dir) => writeFileSync(join(dir, 'styles.css'), `${readFileSync(join(dir, 'styles.css'), 'utf8')}/* round 3 */\n`),
      (dir) => writeFileSync(join(dir, 'pager.js'), '// round 4\n'),
      (dir) => rmSync(join(dir, '404.html')),
      (dir) => symlinkSync('index.html', join(dir, 'home.html')),
      (dir) => writeFileSync(join(dir, '_headers'), readFileSync(join(dir, '_headers'), 'utf8').replace("img-src 'self'", "img-src 'self'; media-src 'self'")),
    ]);
    [repo.missing, repo.linked, repo.policy] = repo.commits.slice(4);
  });

  // The commit's landing as git holds it, and a folder's files hashed the same way: path to blob id.
  const treeOf = (commit) => Object.fromEntries(repo.git('ls-tree', '-r', commit, '--', 'apps/landing/public').split('\n')
    .map((line) => [line.split('\t')[1].slice('apps/landing/public/'.length), line.split(/\s/)[2]]));
  const filesOf = (dir) => {
    const paths = execFileSync('find', ['.', '-type', 'f'], { cwd: dir, encoding: 'utf8' }).trim().split('\n').map((path) => path.slice(2));
    // Whole paths: inside a repository, git reads the listed paths from its top folder, not from cwd.
    const ids = execFileSync('git', ['hash-object', '--no-filters', '--stdin-paths'], { input: paths.map((path) => join(dir, path)).join('\n'), encoding: 'utf8' }).trim().split('\n');
    return Object.fromEntries(paths.map((path, index) => [path, ids[index]]));
  };
  const tarball = (work, commit) => {
    const file = join(work, `${commit}.tar.gz`);
    if (!existsSync(file)) repo.archive(commit, file);
    return file;
  };
  // install-alpha.sh as ship-alpha.sh runs it on the server (sudo aside), on a scratch alpha folder.
  const installAlpha = (work, base, file, commit) => spawnSync('bash', [`${ROOT}infra/server/install-alpha.sh`, file, commit], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, PATH: `${fakeBin(work)}:${process.env.PATH}`, SH_ALPHA_BASE: base },
  });
  // ship-alpha.sh from the scratch repository (or a folder in it), with ssh, scp and curl stand-ins: the "server" is a
  // scratch folder. `env` comes last, so a test can point SH_ALPHA_BASE elsewhere too.
  const shipAlpha = (commit, { fault = '', env = {}, cwd = repo.repo } = {}) => {
    const server = scratch('alpha-ship-test-');
    const base = join(server, 'srv/squarehole/landing-alpha');
    mkdirSync(base, { recursive: true });
    const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('SH_')));
    const result = spawnSync('bash', [`${ROOT}infra/server/ship-alpha.sh`, commit], {
      cwd, encoding: 'utf8', timeout: 60000,
      env: {
        ...clean, PATH: `${fakeBin(server)}:${process.env.PATH}`, TMPDIR: server, FAKE_SERVER_ROOT: server, SH_ALPHA_BASE: base,
        LANDING_FIXTURE_PUBLIC: join(base, 'current'), LANDING_FIXTURE_CADDYFILE: CADDYFILE, LANDING_FIXTURE_FAULT: fault,
        LANDING_FIXTURE_TRACE: join(server, 'requests'), ...env,
      },
    });
    const recorded = (name) => (existsSync(join(server, name)) ? readFileSync(join(server, name), 'utf8') : undefined);
    return { ...result, server, base, recorded };
  };

  it('sends the landing\'s security headers with the preview\'s own scripts allowed, and noindex, on every answer', () => {
    const landing = headersOf('(landing_headers)');
    expect(headersOf('(alpha_headers)')).toEqual({
      ...landing, 'Content-Security-Policy': withScripts(landing['Content-Security-Policy']), 'X-Robots-Tag': 'noindex, nofollow',
    });
    const site = block(ALPHA);
    expect(site).toMatch(/^\timport alpha_headers$/m);
    expect(site).toMatch(/handle_errors 404 \{\n\t\timport alpha_headers\n/);
    // The preview's alone: no other site sends these headers, and alpha sends no other site's.
    expect(caddy.match(/^\s*import alpha_headers$/gm)).toHaveLength(2);
    expect(site).not.toMatch(/import (landing_headers|landing_redirect|gateway)/);
  });

  it('answers robots.txt itself with a disallow for every robot, on alpha only', () => {
    const robots = block(ALPHA).match(/@robots path \/robots\.txt\n\thandle @robots \{\n\t\trespond <<ROBOTS\n([\s\S]*?)\t\t\tROBOTS 200\n\t\}/);
    expect(robots).not.toBeNull();
    // Caddy strips the closing marker's indentation from each line and one final newline; the blank line keeps it.
    expect(robots[1].replace(/^\t\t\t/gm, '').replace(/\n$/, '')).toBe(ROBOTS);
    expect(caddy.match(/path \/robots\.txt/g)).toHaveLength(1);
  });

  it('serves the current preview, hides the Pages files, revalidates every answer, compresses, and never redirects', () => {
    const site = block(ALPHA);
    expect(site).toMatch(/^\troot \* \/srv\/landing-alpha\/current$/m);
    expect(site).toMatch(/^\theader Cache-Control "no-cache"$/m);
    expect(site).toMatch(/^\tencode zstd gzip$/m);
    expect(site).toMatch(/\t@unpublished path \/_headers \/_routes.json\n\thandle @unpublished \{\n\t\terror 404\n\t\}/);
    expect(site).toMatch(/\thandle \{\n\t\tfile_server\n\t\}/);
    expect(site).toMatch(/handle_errors 404 \{\n\t\timport alpha_headers\n\t\theader Cache-Control "no-cache"\n\t\trewrite \* \/404\.html\n\t\tfile_server \{\n\t\t\tstatus 404\n\t\t\}\n\t\}/);
    // No redirect, upstream, listing, longer cache or other host here.
    expect(site).not.toMatch(/redir|reverse_proxy|try_files|browse|max-age|squarehole\.(fun|xyz|fit)/);
    // Only its own two addresses name alpha, so neither an alias redirect nor the catch-all answers it.
    expect(siteLines().filter((line) => line.includes('alpha'))).toEqual([`${ALPHA} {`]);
    expect(siteLines().at(-1)).toBe('http:// {');
  });

  it('mounts the preview folder read-only into Caddy alone, outside the releases, made by install.sh', () => {
    const compose = read('infra/server/compose.yaml');
    expect(compose.split('\n').filter((line) => /^\s+- .*landing-alpha/.test(line))).toEqual(['      - /srv/squarehole/landing-alpha:/srv/landing-alpha:ro']);
    const caddyService = compose.slice(compose.indexOf('\n  caddy:\n'), compose.indexOf('\nnetworks:'));
    expect(caddyService).toContain('\n      - /srv/squarehole/landing-alpha:/srv/landing-alpha:ro\n');
    const install = read('infra/server/install.sh');
    expect(install.match(/^install -d -m 0755 -o root -g root (.+)$/m)[1].split(' ')).toContain('"$base/landing-alpha"');
    expect(install.indexOf('"$base/landing-alpha"')).toBeLessThan(install.indexOf('systemctl start squarehole-stack.service'));
    expect(read('infra/server/install-alpha.sh')).toContain('base=${SH_ALPHA_BASE:-/srv/squarehole/landing-alpha}');
    expect(block(ALPHA)).toContain('root * /srv/landing-alpha/current');
  });

  it('install-alpha.sh switches alpha to an unpacked commit by one rename, reuses its folder and keeps the newest three', () => {
    const work = scratch('alpha-install-test-');
    const base = join(work, 'landing-alpha');
    mkdirSync(base);
    const [a, b, c, d] = repo.commits;
    const install = (commit) => installAlpha(work, base, tarball(work, commit), commit);
    let result = install(a);
    expect(result.stderr).toBe('');
    expect(result.status, result.stdout).toBe(0);
    expect(readlinkSync(join(base, 'current'))).toBe(`releases/${a}`);
    expect(filesOf(join(base, 'current'))).toEqual(treeOf(a));
    result = install(b);
    expect(result.status, result.stderr).toBe(0);
    expect(readlinkSync(join(base, 'current'))).toBe(`releases/${b}`);
    expect(filesOf(join(base, 'current'))).toEqual(treeOf(b));
    expect(readdirSync(join(base, 'releases')).sort()).toEqual([a, b].sort());
    // Going back reuses the kept folder; two more previews keep the newest three, the current one among them.
    result = install(a);
    expect(result.stdout).toContain(`${a} was unpacked before; reused`);
    expect(readlinkSync(join(base, 'current'))).toBe(`releases/${a}`);
    expect(install(c).status).toBe(0);
    result = install(d);
    expect(result.stdout).toContain(`removed the older preview ${b}`);
    expect(readdirSync(join(base, 'releases')).sort()).toEqual([a, c, d].sort());
    expect(readlinkSync(join(base, 'current'))).toBe(`releases/${d}`);
    expect(filesOf(join(base, 'current'))).toEqual(treeOf(d));
    // Nothing half-made is left beside them (the lock file stays, as flock's do), and the caller's tarball is the caller's.
    expect(readdirSync(base).sort()).toEqual(['.lock', 'current', 'releases']);
    expect(existsSync(join(work, `${d}.tar.gz`))).toBe(true);
    // The switch is a new link renamed over the old one (no moment without `current`, as `ln -sfn` over it would leave).
    expect(read('infra/server/install-alpha.sh')).toContain('ln -sfn "releases/$commit" "$base/.current.new"\nmv -T "$base/.current.new" "$base/current"\n');
  });

  it('install-alpha.sh refuses, changing nothing, without the alpha folder, for a bad commit, or for a landing missing a file or holding a link', () => {
    const work = scratch('alpha-install-refuse-');
    const base = join(work, 'landing-alpha');
    const [a] = repo.commits;
    let result = installAlpha(work, base, tarball(work, a), a);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ship a release with SH-LANDING-ALPHA first');
    expect(existsSync(base)).toBe(false);
    mkdirSync(base);
    result = installAlpha(work, base, tarball(work, a), 'HEAD');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('the commit must be 40 hex characters');
    expect(installAlpha(work, base, tarball(work, a), a).status).toBe(0);
    for (const [commit, message] of [[repo.missing, 'landing file missing or empty: 404.html'], [repo.linked, 'not a plain file or folder: home.html']]) {
      result = installAlpha(work, base, tarball(work, commit), commit);
      expect(result.status, result.stdout).toBe(1);
      expect(result.stderr).toContain(`${message}; alpha unchanged`);
      expect(readlinkSync(join(base, 'current'))).toBe(`releases/${a}`);
      expect(readdirSync(join(base, 'releases'))).toEqual([a]);
      expect(readdirSync(base).sort()).toEqual(['.lock', 'current', 'releases']);
    }
  });

  it('install-alpha.sh refuses an upload cut short or empty by tar\'s own status, even with every landing file unpacked', () => {
    const work = scratch('alpha-install-broken-');
    const base = join(work, 'landing-alpha');
    mkdirSync(base);
    const [a, b] = repo.commits;
    expect(installAlpha(work, base, tarball(work, a), a).status).toBe(0);
    const whole = readFileSync(tarball(work, b));
    // One byte short, GNU tar (the server's) unpacks every file intact and only then fails on the missing end, so its
    // status alone can refuse it; bsdtar (a Mac's) fails having lost the last files. Either way: tar's own refusal.
    for (const [name, bytes] of [['half', whole.subarray(0, whole.length >> 1)], ['all but the last byte', whole.subarray(0, whole.length - 1)], ['empty', Buffer.alloc(0)]]) {
      const broken = join(work, 'broken.tar.gz');
      writeFileSync(broken, bytes);
      const result = installAlpha(work, base, broken, b);
      expect(result.status, `${name}: ${result.stdout}`).toBe(1);
      expect(result.stderr, name).toContain('the upload is not a complete landing archive; alpha unchanged');
      expect(readlinkSync(join(base, 'current'))).toBe(`releases/${a}`);
      expect(readdirSync(join(base, 'releases')), name).toEqual([a]);
      expect(readdirSync(base).sort()).toEqual(['.lock', 'current', 'releases']);
    }
    // The whole upload still goes in.
    expect(installAlpha(work, base, tarball(work, b), b).status).toBe(0);
    expect(filesOf(join(base, 'current'))).toEqual(treeOf(b));
  });

  it('install-alpha.sh refuses while another run holds its lock, and leaves that run\'s half-made files alone', () => {
    const work = scratch('alpha-install-lock-');
    const base = join(work, 'landing-alpha');
    mkdirSync(base);
    const [a, b] = repo.commits;
    const env = { ...process.env, PATH: `${fakeBin(work)}:${process.env.PATH}`, SH_ALPHA_BASE: base };
    expect(installAlpha(work, base, tarball(work, a), a).status).toBe(0);
    // Another run, part way through: its lock on .lock (held by this shell for the second run's whole life), its
    // unpacking folder and its new link.
    mkdirSync(join(base, `releases/${b}.new`));
    symlinkSync(`releases/${b}`, join(base, '.current.new'));
    const holder = 'exec 8>"$1/.lock" && flock -n 8 || exit 99; shift; bash "$@"';
    const result = spawnSync('bash', ['-c', holder, 'holder', base, `${ROOT}infra/server/install-alpha.sh`, tarball(work, b), b], { encoding: 'utf8', timeout: 30000, env });
    expect(result.status, result.stdout).toBe(1);
    expect(result.stderr).toContain('another install-alpha.sh is running; alpha unchanged');
    expect(readlinkSync(join(base, 'current'))).toBe(`releases/${a}`);
    expect(existsSync(join(base, `releases/${b}.new`))).toBe(true);
    expect(readlinkSync(join(base, '.current.new'))).toBe(`releases/${b}`);
    // That run over (and its lock with it), the next goes ahead and clears what it left.
    expect(installAlpha(work, base, tarball(work, b), b).status).toBe(0);
    expect(readlinkSync(join(base, 'current'))).toBe(`releases/${b}`);
    expect(readdirSync(join(base, 'releases')).sort()).toEqual([a, b].sort());
    expect(readdirSync(base).sort()).toEqual(['.lock', 'current', 'releases']);
  });

  it('ship-alpha.sh sends only the commit\'s landing with ship.sh\'s server and key, switches alpha, then checks it from outside', () => {
    const [a] = repo.commits;
    const result = shipAlpha(a);
    expect(result.stderr).toBe('');
    expect(result.status, result.stdout).toBe(0);
    const opts = ['-i', join(process.env.HOME, '.ssh/squarehole_droplet'), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes'];
    const remote = `/tmp/squarehole-alpha-${a}.tar.gz`;
    expect(result.recorded('scp-args').trim().split('\n')).toEqual([...opts, '-q', expect.stringMatching(new RegExp(`/squarehole-alpha-${a}\\.tar\\.gz$`)), `squarehole@203.0.113.10:${remote}`]);
    const entries = result.recorded('scp-entries').trim().split('\n');
    expect(entries.filter((entry) => !entry.startsWith('apps/landing/public/'))).toEqual(['apps/', 'apps/landing/']);
    expect(entries).toContain('apps/landing/public/index.html');
    expect(repo.git('ls-tree', '-r', '--name-only', a)).toContain('apps/landing/functions/_middleware.js');
    const ssh = result.recorded('ssh-args').trim().split('\n');
    expect(ssh.slice(0, -1)).toEqual([...opts, 'squarehole@203.0.113.10']);
    expect(ssh.at(-1)).toContain(`sudo env LC_ALL=C.UTF-8 bash -s -- ${remote} ${a};`);
    // The installer comes from this checkout, on standard input; on the "server" alpha switched and the upload is gone.
    expect(result.recorded('ssh-stdin')).toBe(read('infra/server/install-alpha.sh'));
    expect(readlinkSync(join(result.base, 'current'))).toBe(`releases/${a}`);
    expect(filesOf(join(result.base, 'current'))).toEqual(treeOf(a));
    expect(existsSync(join(result.server, remote))).toBe(false);
    const requests = result.recorded('requests').trim().split('\n').map((line) => new URL(line));
    expect(new Set(requests.map((url) => url.host))).toEqual(new Set(['alpha.squarehole.fun']));
    expect(result.stdout).toContain('smoke-alpha: https://alpha.squarehole.fun passed');
  });

  it('ship-alpha.sh takes ship.sh\'s server variables and reports a failed outside check after the switch', () => {
    const [, b] = repo.commits;
    const result = shipAlpha(b, { fault: 'noindex', env: { SH_SERVER: 'deploy@alpha-test.invalid', SH_SERVER_KEY: '/nonexistent/test-key' } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('smoke-alpha: https://alpha.squarehole.fun/');
    expect(result.stderr).toContain('X-Robots-Tag was');
    expect(result.recorded('scp-args')).toContain(`deploy@alpha-test.invalid:/tmp/squarehole-alpha-${b}.tar.gz`);
    expect(result.recorded('ssh-args').split('\n').slice(0, 2)).toEqual(['-i', '/nonexistent/test-key']);
    expect(readlinkSync(join(result.base, 'current'))).toBe(`releases/${b}`);
  });

  it('ship-alpha.sh stops at a failed upload before SSH, and at a refused install with the upload removed, checking nothing after either', () => {
    const [a] = repo.commits;
    const remote = `/tmp/squarehole-alpha-${a}.tar.gz`;
    let result = shipAlpha(a, { env: { LANDING_FIXTURE_SCP_FAIL: '1' } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ship-alpha.sh: the upload failed; nothing ran on the server, alpha unchanged');
    expect(result.recorded('scp-args')).toContain(`:${remote}`);
    expect(result.recorded('ssh-args')).toBeUndefined();
    expect(result.recorded('requests')).toBeUndefined();
    expect(readdirSync(result.base)).toEqual([]);
    // A server without the alpha folder (a release before SH-LANDING-ALPHA): install-alpha.sh refuses there.
    result = shipAlpha(a, { env: { SH_ALPHA_BASE: join(scratch('alpha-ship-missing-'), 'landing-alpha') } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ship a release with SH-LANDING-ALPHA first (its install.sh makes the folder); alpha unchanged');
    expect(result.stderr).toContain('ship-alpha.sh: the install on the server failed (exit 1), see above; no outside check');
    expect(result.recorded('ssh-args')).toBeDefined();
    expect(existsSync(join(result.server, remote))).toBe(false);
    expect(result.recorded('requests')).toBeUndefined();
    expect(readdirSync(result.base)).toEqual([]);
  });

  it('ship-alpha.sh run from a folder inside the repository checks and ships the landing as from its top', () => {
    const [a] = repo.commits;
    const result = shipAlpha(a, { cwd: join(repo.repo, 'apps') });
    expect(result.stderr).toBe('');
    expect(result.status, result.stdout).toBe(0);
    expect(result.recorded('scp-entries').trim().split('\n')).toContain('apps/landing/public/index.html');
    expect(filesOf(join(result.base, 'current'))).toEqual(treeOf(a));
    // The link check reads the commit's landing from there too (from a subfolder, `git ls-tree` alone lists nothing).
    const linked = shipAlpha(repo.linked, { cwd: join(repo.repo, 'apps/landing') });
    expect(linked.status).toBe(1);
    expect(linked.stderr).toContain('holds links or submodules: apps/landing/public/home.html');
    expect(linked.recorded('scp-args')).toBeUndefined();
  });

  it('ship-alpha.sh refuses, before sending anything, a landing alpha would serve with another policy, one missing a file or holding a link', () => {
    for (const [commit, message] of [
      [repo.policy, 'asks for another policy than alpha sends'], [repo.missing, 'has no apps/landing/public/404.html'], [repo.linked, 'holds links or submodules: apps/landing/public/home.html'],
    ]) {
      const result = shipAlpha(commit);
      expect(result.status, result.stdout).toBe(1);
      expect(result.stderr).toContain(message);
      expect(result.stderr).toContain('nothing was sent');
      expect(result.recorded('scp-args')).toBeUndefined();
      expect(result.recorded('ssh-args')).toBeUndefined();
      expect(readdirSync(result.base)).toEqual([]);
    }
    // The refusal names the two policies' differing lines.
    const policy = shipAlpha(repo.policy).stderr;
    expect(policy).toMatch(/alpha sends: +Content-Security-Policy: default-src 'none'; script-src 'self'; img-src 'self'; style-src/);
    expect(policy).toMatch(/_headers asks: +Content-Security-Policy: .*img-src 'self'; media-src 'self'/);
    expect(shipAlpha('no-such-commit').status).toBe(2);
  });
});

describe('install.sh checks the release Caddyfile with the folders Caddy will see (SH-TA-01)', () => {
  const install = read('infra/server/install.sh');
  const compose = read('infra/server/compose.yaml');
  const check = install.slice(install.indexOf('if ! check=$(docker run'), install.indexOf('caddy validate --config /etc/caddy/Caddyfile'));

  it('mounts the app folder at /srv/app in the check, as compose.yaml mounts it into Caddy', () => {
    expect(install).toMatch(/^base=\/srv\/squarehole$/m);
    expect(compose).toContain('\n      - /srv/squarehole/app:/srv/app:ro\n');
    expect(check).toContain('--network none');
    expect(check).toContain('\n  -v "$base/app:/srv/app:ro" \\\n');
    expect(check).toContain('\n  -v "$release/apps/landing/public:/srv/landing:ro" \\\n');
    // The Caddyfile's app imports read from that mount.
    expect(caddy.match(/^\s*import \/srv\/app\/current\/\*\.(site|cors)\.caddy$/gm)).toHaveLength(2);
  });

  it('makes the app folder before the check and the stack start, so neither mount makes it', () => {
    expect(install.match(/^install -d -m 0755 -o root -g root (.+)$/m)[1].split(' ')).toContain('"$base/app"');
    expect(install.indexOf('"$base/app"')).toBeLessThan(install.indexOf('if ! check=$(docker run'));
    expect(install.indexOf('if ! check=$(docker run')).toBeLessThan(install.indexOf('mv -T "$base/.current.new" "$base/current"'));
  });
});

// SH-LANDING-ALPHA: smoke-alpha.sh, which ship-alpha.sh runs from the caller's machine after switching the preview.
function runAlpha(publicDir, fault = '', extraEnv = {}) {
  const work = scratch('alpha-smoke-test-');
  writeFileSync(join(work, 'curl'), readFileSync(new URL('./alpha-fixtures/curl-alpha.mjs', import.meta.url)), { mode: 0o755 });
  const result = spawnSync('bash', ['infra/server/smoke-alpha.sh', publicDir], {
    cwd: ROOT, encoding: 'utf8', timeout: 20000,
    env: {
      ...process.env, PATH: `${work}:${process.env.PATH}`, TMPDIR: work, LANDING_FIXTURE_PUBLIC: publicDir, LANDING_FIXTURE_CADDYFILE: CADDYFILE,
      LANDING_FIXTURE_FAULT: fault, LANDING_FIXTURE_TRACE: join(work, 'requests'), ...extraEnv,
    },
  });
  return { ...result, work };
}

// This checkout's landing as a preview, with a script of its own as sh-landing-anim's has (pager.js).
function preview(edit) {
  const dir = previewOf(join(scratch('alpha-preview-'), 'public'), edit);
  writeFileSync(join(dir, 'pager.js'), "// the preview's own script\n");
  return dir;
}

describe('external alpha smoke check (curl fixture, no network or listener)', () => {
  it('checks alpha.squarehole.fun alone over HTTPS: files byte for byte, the headers with noindex, robots.txt and 404s', () => {
    const result = runAlpha(preview());
    expect(result.stderr).toBe('');
    expect(result.status, result.stdout).toBe(0);
    const requests = readFileSync(join(result.work, 'requests'), 'utf8').trim().split('\n').map((line) => new URL(line));
    expect(new Set(requests.map((url) => url.host))).toEqual(new Set(['alpha.squarehole.fun']));
    expect(requests.every((url) => url.protocol === 'https:')).toBe(true);
    for (const path of ['/', '/index.html', '/styles.css', '/pager.js', '/brand/mark.svg', '/art/card-1200x630.jpg', '/robots.txt', '/_headers', '/_routes.json']) {
      expect(requests.some((url) => url.pathname === path), path).toBe(true);
    }
    expect(requests.filter((url) => url.pathname.includes('__alpha-missing-'))).toHaveLength(2);
  });

  it.each([
    ['redirect', 'status 301, expected 200'], ['noindex', 'X-Robots-Tag was'], ['security', 'X-Frame-Options was'],
    ['cache', 'Cache-Control was'], ['body', 'body differs'], ['robots', 'robots.txt does not disallow all robots'],
    ['status', 'status 200, expected 404'], ['network', 'request failed'],
  ])('fails on %s drift', (fault, message) => {
    const result = runAlpha(preview(), fault);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('smoke-alpha:');
    expect(result.stderr).toContain(message);
  });

  it('passes Cloudflare Access only with a service token header file, and never prints the token', () => {
    const denied = runAlpha(preview(), 'access');
    expect(denied.status).toBe(1);
    expect(denied.stderr).toContain('Cloudflare Access answered; set SH_ACCESS_HEADERS');
    const token = join(scratch('alpha-access-'), 'token');
    writeFileSync(token, 'CF-Access-Client-Id: fixture-id.access\nCF-Access-Client-Secret: fixture-secret-not-real\n', { mode: 0o600 });
    const allowed = runAlpha(preview(), 'access', { SH_ACCESS_HEADERS: token });
    expect(allowed.stderr).toBe('');
    expect(allowed.status, allowed.stdout).toBe(0);
    expect(`${allowed.stdout}${allowed.stderr}`).not.toContain('fixture-secret-not-real');
  });

  it('with the token in use, prints no response value and keeps no response files (XR-SH-ACCESS-SMOKE F2)', () => {
    const token = join(scratch('alpha-access-'), 'token');
    writeFileSync(token, 'CF-Access-Client-Id: fixture-id.access\nCF-Access-Client-Secret: fixture-secret-not-real\n', { mode: 0o600 });
    const reflected = runAlpha(preview(), 'reflect', { SH_ACCESS_HEADERS: token });
    expect(reflected.status).toBe(1);
    expect(reflected.stderr).toContain('X-Robots-Tag differs from');
    expect(reflected.stderr).toContain('response files removed');
    expect(`${reflected.stdout}${reflected.stderr}`).not.toContain('fixture-secret');
    // The fixture records where curl was told to write each response.
    const written = (result) => readFileSync(join(result.work, 'requests.files'), 'utf8').trim().split('\n');
    expect(written(reflected).every((file) => !existsSync(file))).toBe(true);
    const parser = runAlpha(preview(), 'curl-error', { SH_ACCESS_HEADERS: token });
    expect(parser.status).toBe(1);
    expect(parser.stderr).toContain('request failed');
    expect(`${parser.stdout}${parser.stderr}`).not.toContain('fixture-');
    expect(written(parser).every((file) => !existsSync(file))).toBe(true);
    // Without the token, curl's own message still helps diagnosis.
    expect(runAlpha(preview(), 'curl-error').stderr).toContain('invalid chunk size');
    const network = runAlpha(preview(), 'network', { SH_ACCESS_HEADERS: token });
    expect(network.status).toBe(1);
    expect(written(network).every((file) => !existsSync(file))).toBe(true);
    // Without the token, a failed response is still kept for diagnosis.
    const plain = runAlpha(preview(), 'noindex');
    expect(plain.stderr).toContain('X-Robots-Tag was');
    expect(existsSync(written(plain).at(-1))).toBe(true);
  });

  it('fails when the preview asks for another policy than alpha sends', () => {
    const result = runAlpha(preview((headers) => headers.replace("img-src 'self'", "img-src 'self'; media-src 'self'")));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Content-Security-Policy was');
  });
});
