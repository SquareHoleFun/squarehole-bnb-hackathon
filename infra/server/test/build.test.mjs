import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildRelease } from '../app/build.mjs';

const read = (p) => readFileSync(p, 'utf8');
function fixture() {
  mkdirSync('.cache/tmp', { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp/app-build-'));
  // The repository's tracked root .env.example comes along, as in every real clean checkout.
  for (const file of ['.env.example', 'infra/server/Caddyfile', 'apps/web/src/share/share-headers.ts', 'packages/chain/src/config/networks.ts']) {
    mkdirSync(resolve(root, file, '..'), { recursive: true });
    cpSync(file, resolve(root, file));
  }
  writeFileSync(resolve(root, '.gitignore'), '.cache/\n.env\n.env.*\n!.env.example\n');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'test: create offline hosting fixture\n\nCo-Authored-By: Codex <noreply@openai.com>'], { cwd: root });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const out = resolve(root, '.cache/release');
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, env: options.env });
    if (args.includes('vite')) {
      mkdirSync(resolve(out, 'public/assets'), { recursive: true });
      writeFileSync(resolve(out, 'public/index.html'), '<html><script src="/assets/app-abcdefgh.js"></script></html>');
      writeFileSync(resolve(out, 'public/assets/app-abcdefgh.js'), 'export const app = true;');
    }
  };
  return { root, commit, out, target: 'sepolia', configText: '', calls, run };
}

describe('reviewed production release', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('builds with a closed environment, runs the full gate, binds byte equality and packs public provenance', async () => {
    const f = fixture();
    const result = await buildRelease(f, f.run);
    expect(f.calls.map((c) => c.args)).toEqual([
      ['--filter', '@squarehole/web', 'exec', 'vite', 'build', '--outDir', resolve(f.out, 'public')],
      ['check:production'],
      ['--filter', '@squarehole/web', 'check:production', '--no-build', '--same-as', resolve(f.out, 'public')],
    ]);
    expect.soft(f.calls.every((c) => c.env.SH_BUILD === 'production' && c.env.SH_TARGET === 'sepolia' && c.env.SH_FIT_MARKET === 'none' && c.env.SH_CORE_SEPOLIA_INDEXER_ORIGIN === 'https://api.squarehole.fun' && !c.env.SH_ALLOW_PLACEHOLDERS && !c.env.VITE_FAKE_SECRET)).toBe(true);
    expect(result.id).toMatch(/^[a-f0-9]{64}$/);
    expect(result.commit).toBe(f.commit);
    expect(result.files['assets/app-abcdefgh.js']).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(read(resolve(f.out, 'release.json')))).toMatchObject({ commit: f.commit, chain: '11155111', legal: 'test-network' });
    expect(read(resolve(f.out, 'app.site.caddy'))).toContain(result.id);
    expect(read(resolve(f.out, 'SHA256SUMS'))).toContain('  public/index.html');
  });
  it.each([undefined, 'mainnet', 'sepolia', 'unexpected-target'])('ignores caller build settings and placeholder bypasses with SH_TARGET=%s', async (callerTarget) => {
    vi.stubEnv('SH_TARGET', callerTarget);
    vi.stubEnv('SH_BUILD', 'development');
    vi.stubEnv('SH_ALLOW_PLACEHOLDERS', '1');
    vi.stubEnv('VITE_FAKE_SECRET', 'obviously-fake');
    vi.stubEnv('NODE_OPTIONS', '--conditions=unreviewed');
    // F156: the trade opt-in never reaches the release build either; the Sepolia target alone turns the trade code on.
    vi.stubEnv('SH_SEPOLIA_TRADE', '1');
    const f = fixture();
    const release = await buildRelease(f, f.run);
    expect(f.calls).toHaveLength(3);
    for (const { env } of f.calls) {
      expect(env).toMatchObject({ SH_BUILD: 'production', SH_TARGET: 'sepolia', SH_FIT_MARKET: 'none' });
      for (const key of ['SH_ALLOW_PLACEHOLDERS', 'VITE_FAKE_SECRET', 'NODE_OPTIONS', 'SH_SEPOLIA_TRADE']) expect(env).not.toHaveProperty(key);
    }
    expect(release.legal).toBe('test-network');
  });
  it('stops before packaging when the required production gate fails', async () => {
    const f = fixture();
    await expect(buildRelease(f, (...args) => {
      if (args[1][0] === 'check:production') throw new Error('offline fake production check failed');
      f.run(...args);
    })).rejects.toThrow(/check:production/);
    expect(existsSync(resolve(f.out, 'release.json'))).toBe(false);
  });
  it('refuses a dirty tree, the wrong reviewed commit, and local env files before building', async () => {
    const f = fixture();
    writeFileSync(resolve(f.root, 'untracked.txt'), 'leftover');
    await expect(buildRelease(f, f.run)).rejects.toThrow(/clean/);
    const g = fixture();
    await expect(buildRelease({ ...g, commit: 'a'.repeat(40) }, g.run)).rejects.toThrow(/HEAD/);
    writeFileSync(resolve(g.root, 'apps/web/.env.production.local'), 'VITE_FAKE_SECRET=obviously-fake');
    await expect(buildRelease(g, g.run)).rejects.toThrow(/clean|env/);
    expect(f.calls).toHaveLength(0);
    expect(g.calls).toHaveLength(0);
  });
  it.each(['.env', '.env.local', '.env.production', 'apps/web/.env.production.local'])('refuses an ignored Vite env file (%s) in a clean checkout; the tracked .env.example is no such file', async (name) => {
    const f = fixture();
    await expect(buildRelease({ ...f, dryRun: true }, f.run)).resolves.toMatchObject({ commit: f.commit });
    writeFileSync(resolve(f.root, name), 'VITE_FAKE_SECRET=obviously-fake');
    expect(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: f.root, encoding: 'utf8' })).toBe('');
    await expect(buildRelease({ ...f, dryRun: true }, f.run)).rejects.toThrow(/env files/);
    expect(f.calls).toHaveLength(0);
  });
  it('accepts only the committed root .env.example: refuses the name under apps/web, an untracked root copy, a symlink and changed bytes (XR-SH-TA-13)', async () => {
    const env = (f) => buildRelease({ ...f, dryRun: true }, f.run);
    const clean = (f) => expect(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: f.root, encoding: 'utf8' })).toBe('');
    // the same name under apps/web, ignored there and untracked
    const a = fixture();
    writeFileSync(resolve(a.root, 'apps/web/.gitignore'), '.env.example\n');
    writeFileSync(resolve(a.root, '.git/info/exclude'), 'apps/web/.gitignore\n');
    writeFileSync(resolve(a.root, 'apps/web/.env.example'), 'VITE_FAKE_SECRET=obviously-fake');
    clean(a);
    await expect(env(a)).rejects.toThrow(/env files/);
    // a root .env.example that the commit does not track (ignored, untracked)
    const b = fixture();
    writeFileSync(resolve(b.root, '.gitignore'), '.cache/\n.env\n.env.*\n');
    execFileSync('git', ['rm', '-q', '--cached', '.env.example'], { cwd: b.root });
    execFileSync('git', ['commit', '-qam', 'test: untrack the example\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'], { cwd: b.root });
    b.commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: b.root, encoding: 'utf8' }).trim();
    clean(b);
    await expect(env(b)).rejects.toThrow(/env files/);
    // the committed example replaced by a symlink, hidden with assume-unchanged
    const c = fixture();
    execFileSync('git', ['update-index', '--assume-unchanged', '.env.example'], { cwd: c.root });
    execFileSync('rm', [resolve(c.root, '.env.example')]);
    execFileSync('ln', ['-s', 'infra/server/Caddyfile', resolve(c.root, '.env.example')]);
    clean(c);
    await expect(env(c)).rejects.toThrow(/env files/);
    // the committed example with changed bytes, hidden with assume-unchanged
    const d = fixture();
    execFileSync('git', ['update-index', '--assume-unchanged', '.env.example'], { cwd: d.root });
    writeFileSync(resolve(d.root, '.env.example'), 'VITE_FAKE_SECRET=obviously-fake\n');
    clean(d);
    await expect(env(d)).rejects.toThrow(/env files/);
    // a CRLF rewrite that Git's autocrlf would normalise, hidden with assume-unchanged (XR-SH-TA-13-R2)
    const n = fixture();
    execFileSync('git', ['config', 'core.autocrlf', 'input'], { cwd: n.root });
    execFileSync('git', ['update-index', '--assume-unchanged', '.env.example'], { cwd: n.root });
    writeFileSync(resolve(n.root, '.env.example'), read(resolve(n.root, '.env.example')).replace(/\n/g, '\r\n'));
    clean(n);
    await expect(env(n)).rejects.toThrow(/env files/);
    // the committed regular example alone is accepted
    const e = fixture();
    await expect(env(e)).resolves.toMatchObject({ commit: e.commit });
    expect([a, b, c, d, n, e].flatMap((f) => f.calls)).toHaveLength(0);
  });
  it.each([false, true])('refuses a mainnet target even with caller Sepolia settings (dryRun=%s)', async (dryRun) => {
    vi.stubEnv('SH_TARGET', 'sepolia');
    vi.stubEnv('SH_BUILD', 'production');
    vi.stubEnv('SH_ALLOW_PLACEHOLDERS', '1');
    const f = fixture();
    await expect(buildRelease({ ...f, target: 'mainnet', dryRun }, f.run)).rejects.toThrow(/G08/);
    expect(f.calls).toHaveLength(0);
    expect(existsSync(f.out)).toBe(false);
  });
  it('dry run checks inputs with no build, outputs, network or listener', async () => {
    const f = fixture();
    await buildRelease({ ...f, dryRun: true }, f.run);
    expect(f.calls).toHaveLength(0);
    expect(existsSync(f.out)).toBe(false);
  });
  it('checks for edits made during the build and refuses source maps', async () => {
    const f = fixture();
    await expect(buildRelease(f, (...args) => { f.run(...args); writeFileSync(resolve(f.root, 'changed.txt'), 'edit'); })).rejects.toThrow(/clean/);
    const g = fixture();
    await expect(buildRelease(g, (...args) => { g.run(...args); writeFileSync(resolve(g.out, 'public/assets/app.js.map'), '{}'); })).rejects.toThrow(/source map/);
  });
});
