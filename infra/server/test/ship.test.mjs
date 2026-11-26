import { describe, expect, it } from 'vitest';
import { execFileSync } from './local-command.mjs';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { shipFixture as fixture } from './ship-fixture.mjs';

describe('ship CLI', () => {
  it('plans the stack and Sepolia app without SSH, Docker, curl or builds', () => {
    const f = fixture();
    for (const args of [['--dry-run', f.commit], ['--app', 'sepolia', '--config', f.config, '--dry-run', f.commit]]) {
      const result = f.run(...args);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('dry run');
      expect(result.stderr).not.toContain('UNEXPECTED');
      expect(f.calls()).toEqual([]);
    }
  });
  it('requires the full reviewed app commit and refuses mainnet/dirty trees before side effects', () => {
    const f = fixture();
    expect(f.run('--app', 'mainnet', '--config', f.config, '--dry-run', f.commit).stderr).toContain('G08');
    expect(f.run('--app', 'sepolia', '--config', f.config, '--dry-run').stderr).toContain('reviewed');
    writeFileSync(join(f.root, 'leftover'), 'earlier edit');
    const result = f.run('--dry-run', f.commit);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('clean');
    expect(result.stderr).not.toContain('UNEXPECTED');
  });
  it('defaults the Access token file only when SH_ACCESS_HEADERS is unset (XR-SH-ACCESS-SMOKE F3)', () => {
    mkdirSync('.cache/tmp', { recursive: true });
    const home = mkdtempSync(resolve('.cache/tmp/ship-access-home-'));
    mkdirSync(join(home, '.ssh'));
    for (const script of ['infra/server/ship.sh', 'infra/server/ship-alpha.sh']) {
      const line = readFileSync(script, 'utf8').match(/^if \[\[ -z \$\{SH_ACCESS_HEADERS\+set\} .*$/m)?.[0];
      expect(line, script).toBeTruthy();
      const run = (setup) => execFileSync('bash', ['-c', `set -euo pipefail; ${setup}\n${line}\nprintf '%s' "\${SH_ACCESS_HEADERS-unset}"`], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' });
      writeFileSync(join(home, '.ssh/squarehole_access_smoke'), '');
      expect(run('unset SH_ACCESS_HEADERS')).toBe('unset');
      writeFileSync(join(home, '.ssh/squarehole_access_smoke'), 'CF-Access-Client-Id: fixture\n');
      expect(run('unset SH_ACCESS_HEADERS')).toBe(join(home, '.ssh/squarehole_access_smoke'));
      expect(run("SH_ACCESS_HEADERS=''")).toBe('');
      expect(run('SH_ACCESS_HEADERS=/elsewhere/token')).toBe('/elsewhere/token');
    }
  });
  it('keeps the existing stack archive and post-install landing smoke', () => {
    const script = readFileSync('infra/server/ship.sh', 'utf8');
    expect(script).toContain('apps/landing/public');
    expect(script).toContain('bash "$work/infra/server/smoke-landing.sh" "$work/apps/landing/public"');
    expect(script).toContain('bash infra/server/smoke-app.sh "$work/artifact"');
  });
});
