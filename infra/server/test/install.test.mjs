import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = resolve('infra/server/app/install.sh');
const hash = (text) => createHash('sha256').update(text).digest('hex');
function fixture(fault = '') {
  mkdirSync('.cache/tmp', { recursive: true });
  const dir = mkdtempSync(resolve('.cache/tmp/app-install-'));
  const artifact = join(dir, 'artifact');
  const base = join(dir, 'state');
  const bin = join(dir, 'bin');
  const stack = join(dir, 'stack');
  for (const path of [artifact, base, bin, stack, join(artifact, 'public/assets')]) mkdirSync(path, { recursive: true });
  const commit = 'a'.repeat(40);
  const release = { id: 'b'.repeat(64), commit, chain: '11155111', mainHost: 'app.example.org', testHost: 'test.example.org' };
  const files = { 'release.json': JSON.stringify(release), 'app.site.caddy': '# fake test site', 'app.cors.caddy': '# fake test cors', 'public/index.html': 'offline app', 'public/assets/app-abcdefgh.js': 'offline js' };
  for (const [name, body] of Object.entries(files)) writeFileSync(join(artifact, name), body);
  writeFileSync(join(artifact, 'SHA256SUMS'), Object.entries(files).map(([name, body]) => `${hash(body)}  ${name}\n`).join(''));
  writeFileSync(join(stack, 'Caddyfile'), 'import /srv/app/current/*.site.caddy\nimport /srv/app/current/*.cors.caddy\n');
  writeFileSync(join(stack, 'compose.yaml'), '/srv/squarehole/app:/srv/app:ro\n');
  const fake = (name, text) => writeFileSync(join(bin, name), `#!/usr/bin/env bash\nset -eu\n${text}\n`, { mode: 0o755 });
  fake('id', 'echo 0');
  fake('flock', '[[ ${APP_FAULT:-} != lock ]]');
  fake('docker', 'echo "$*" >> "$APP_CALLS"\nif [[ $* == *" validate "* && ${APP_FAULT:-} == validate ]]; then exit 1; fi\nif [[ $* == *" reload "* && ${APP_FAULT:-} == reload && ! -f $APP_ONCE ]]; then touch "$APP_ONCE"; exit 1; fi');
  // install.sh's `mv -Tf` (GNU, as on the server) is BSD's `mv -fh` on a Mac, the same single rename of a link; GNU mv
  // (Linux) takes -Tf as it is.
  if (process.platform === 'darwin') fake('mv', 'if [[ ${1:-} == -Tf ]]; then shift; exec /bin/mv -fh "$@"; fi\nexec /bin/mv "$@"');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, SH_APP_BASE: base, SH_STACK_DIR: stack, APP_FAULT: fault, APP_CALLS: join(dir, 'calls'), APP_ONCE: join(dir, 'once') };
  const run = (...args) => spawnSync('bash', [script, artifact, commit, ...args], { encoding: 'utf8', env });
  return { dir, artifact, base, release, run };
}

describe('app activation with offline system doubles', () => {
  it('checks an artifact in dry run without Docker or a switch', () => {
    const f = fixture();
    const result = f.run('--dry-run');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('dry run');
    expect(() => readFileSync(join(f.dir, 'calls'))).toThrow();
    expect(() => readlinkSync(join(f.base, 'current'))).toThrow();
  });
  it('validates before switching and reloads only Caddy, retaining immutable assets', () => {
    const f = fixture();
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(readlinkSync(join(f.base, 'current'))).toBe(`releases/${f.release.id}`);
    const calls = readFileSync(join(f.dir, 'calls'), 'utf8');
    expect(calls.indexOf(' validate ')).toBeLessThan(calls.indexOf(' reload '));
    expect(calls).toContain('--network none');
    expect(calls).not.toMatch(/compose .* (up|restart|down)/);
    expect(readFileSync(join(f.base, 'immutable/assets/app-abcdefgh.js'), 'utf8')).toBe('offline js');
  });
  it.each(['validate', 'reload', 'lock'])('keeps the previous release on %s failure', (fault) => {
    const f = fixture(fault);
    symlinkSync('releases/previous', join(f.base, 'current'));
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(readlinkSync(join(f.base, 'current'))).toBe('releases/previous');
  });
  it('rejects corrupted, traversing or symlink artifacts before Docker', () => {
    const f = fixture();
    writeFileSync(join(f.artifact, 'public/index.html'), 'tampered');
    expect(f.run('--dry-run').status).not.toBe(0);
    const g = fixture();
    writeFileSync(join(g.artifact, 'SHA256SUMS'), `${'a'.repeat(64)}  ../outside\n`);
    expect(g.run('--dry-run').status).not.toBe(0);
    const h = fixture();
    symlinkSync('../release.json', join(h.artifact, 'public/leak'));
    expect(h.run('--dry-run').status).not.toBe(0);
  });
  it('refuses a missing checksum hidden by a duplicate and an immutable URL collision', () => {
    const f = fixture();
    const sums = readFileSync(join(f.artifact, 'SHA256SUMS'), 'utf8').split('\n');
    sums[1] = sums[0];
    writeFileSync(join(f.artifact, 'SHA256SUMS'), sums.join('\n'));
    const missing = f.run('--dry-run');
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('checksum inventory');
    const g = fixture();
    mkdirSync(join(g.base, 'immutable/assets'), { recursive: true });
    writeFileSync(join(g.base, 'immutable/assets/app-abcdefgh.js'), 'previous content at same URL');
    const collision = g.run();
    expect(collision.status).not.toBe(0);
    expect(collision.stderr).toContain('immutable asset collision');
  });
  it('has valid shell syntax', () => {
    expect(() => execFileSync('bash', ['-n', script])).not.toThrow();
  });
});

// Execute the installer's actual provisioning and preflight blocks with host-command doubles.
// No server paths, credentials, Docker daemon or host ownership changes are accessed here.
function alphaInstall(enabled = '0', key = 'absent') {
  mkdirSync('.cache/tmp', { recursive: true });
  const dir = mkdtempSync(resolve('.cache/tmp/alpha-install-')), bin = join(dir, 'bin');
  mkdirSync(bin); mkdirSync(join(dir, 'secrets/alpha-sender'), { recursive: true });
  writeFileSync(join(dir, 'secrets/alpha-sender.env'), 'SH_SERVICE_ENABLED=fixture-only');
  const file = join(dir, 'secrets/alpha-sender/desk.key');
  if (key !== 'absent') writeFileSync(file, key === 'empty' ? '' : 'fixture-key-not-a-secret');
  if (key === 'symlink') symlinkSync(file, `${file}.link`);
  const fake = (name, text) => writeFileSync(join(bin, name), `#!/bin/sh\n${text}\n`, { mode: 0o755 });
  for (const name of ['install', 'chown', 'chmod', 'setfacl']) fake(name, `printf '%s %s\\n' '${name}' "$*" >> "$CALLS"`);
  fake('stat', 'printf "%s\\n" "$KEY_STAT"');
  fake('docker', 'printf \'{"services":{"alpha-sender":{"environment":{"SH_SERVICE_ENABLED":"%s"}}}}\\n\' "$ENABLED"');
  const source = readFileSync('infra/server/install.sh', 'utf8');
  const provisioning = source.slice(source.indexOf('# Alpha exchange:'), source.indexOf('if [[ ! -d $base/reveal-art'));
  const preflight = source.match(/# Enabled sender preflight\.[\s\S]*?(?=\n# 7\.)/)?.[0];
  expect(preflight, 'installer must guard activation before switching current').toBeTruthy();
  expect(source.indexOf(preflight)).toBeLessThan(source.indexOf('ln -sfn "$release"'));
  const script = `set -euo pipefail\nbase=$FIXTURE/base\nsecrets=$FIXTURE/secrets\nrelease=$FIXTURE\nlog() { printf '%s\\n' "$*"; }\n${provisioning}\n${preflight}\nprintf 'would reload\\n'`;
  mkdirSync(join(dir, 'infra/server'), { recursive: true });
  const run = spawnSync('bash', ['-c', key === 'symlink' ? script.replaceAll('$secrets/alpha-sender/desk.key', '$secrets/alpha-sender/desk.key.link') : script], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE: dir, CALLS: join(dir, 'calls'), ENABLED: enabled,
      KEY_STAT: key === 'insecure' ? '0:2103:640' : '0:0:600' },
  });
  return { ...run, calls: readFileSync(join(dir, 'calls'), 'utf8') };
}

describe('alpha shared folders and activation', () => {
  it('ships disabled without a desk key, sets private permissions and never creates credentials', () => {
    const r = alphaInstall(); expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('would reload');
    expect(r.calls).toMatch(/install -d -m 2750 -o root -g 2103 .*\/base\/alpha\/queue .*\/base\/alpha\/receipts/);
    expect(r.calls).toMatch(/setfacl -m u:2101:rwx .*\/alpha\/queue/);
    expect(r.calls).not.toContain('u:2102');
    expect(r.calls).toMatch(/setfacl -b -k .*\/alpha\/queue .*\/alpha\/receipts/);
    expect(r.calls).toMatch(/install -d -m 2770 -o root -g 2101 .*\/alpha\/state/);
    expect(r.calls).toMatch(/install -d -m 0700 -o root -g root .*\/secrets\/alpha-sender/);
    expect(r.calls).toMatch(/chmod 0600 .*\/alpha-sender.env/);
    expect(r.calls).toMatch(/install -d -m 0700 -o root -g root .*\/secrets\/agents/);
    for (const name of ['replies', 'statements', 'proposals', 'state']) expect(r.calls).toContain(`/base/agents/${name}`);
    expect(readFileSync('infra/server/install.sh', 'utf8')).not.toMatch(/create-desk-key|volume (rm|prune)|down --volumes/);
  });
  it.each(['absent', 'empty', 'symlink', 'insecure'])('refuses an enabled sender with %s key before reload', key => {
    const r = alphaInstall('1', key); expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('would reload');
    expect(r.stdout + r.stderr).toContain('docs/runbooks/alpha-sender.md#key-and-float');
  });
  it('allows a founder-provisioned private key without changing it', () => {
    const r = alphaInstall('1', 'present'); expect(r.status, r.stderr).toBe(0);
    expect(r.calls).not.toContain('desk.key'); expect(r.stdout).toContain('would reload');
  });
});

describe('alpha backup flags installed next to the wrapper (SH-210 af2)', () => {
  const install = readFileSync('infra/server/install.sh', 'utf8');
  it('installs the repository flags file 0644 before the wrapper that sources it by absolute path', () => {
    const flags = install.match(/^install -m 0644 "\$release\/(infra\/server\/alpha-backup-flags\.sh)" (\/usr\/local\/sbin\/\S+)/m);
    expect(flags, 'installer must copy the flags file').toBeTruthy();
    // The file the Docker check sources from the repository is the file the installer copies.
    expect(readFileSync('infra/server/test/images-start-check.sh', 'utf8')).toContain(`source "$ROOT/${flags[1]}"`);
    expect(readFileSync(flags[1], 'utf8')).toContain('alpha_backup_flags=(');
    // The installed wrapper sources exactly the installed path.
    expect(readFileSync('infra/server/alpha-backup.sh', 'utf8')).toContain(`\nsource ${flags[2]}\n`);
    expect(install.indexOf(flags[0])).toBeLessThan(install.indexOf('"$release/infra/server/alpha-backup.sh" /usr/local/sbin/squarehole-alpha-backup\n'));
    // Both are in the same step, before the switch of `current`.
    expect(install.indexOf(flags[0])).toBeLessThan(install.indexOf('ln -sfn "$release"'));
  });
});
