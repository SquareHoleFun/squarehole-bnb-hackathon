import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { healthcheck, posterHealthy, staleAfterMs } from '../src/healthcheck';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const entry = ['--experimental-transform-types', '--no-warnings=ExperimentalWarning', '--import', '../chain/scripts/register-ts.mjs', 'src/healthcheck.ts'];
const scratch = async () => {
  const root = fileURLToPath(new URL('../../../.cache/lane/cow-poster', import.meta.url)); await mkdir(root, { recursive: true });
  return mkdtemp(`${root}/healthcheck-`);
};
const NOW = 1_800_000_000_000;
const CYCLE = 600_000;
const disabled = { enabled: false, mode: 'dry-run' } as const;
const dryRun = { enabled: true, mode: 'dry-run' } as const;
const live = { enabled: true, mode: 'live' } as const;
const done = (mode: 'dry-run' | 'live', age = 0) => ({ phase: 'idle', mode, chainId: 11155111, startedAt: NOW - age - 5_000, completedAt: NOW - age, updatedAt: NOW - age, targets: 3, posted: 0, skipped: 1, errors: 0 });

describe('the poster smoke check (smoke-services.sh runs it in the container)', () => {
  it('a disabled poster is healthy while its disabled record is current', () => {
    expect(posterHealthy({ phase: 'disabled', mode: 'dry-run', updatedAt: NOW - 30_000 }, disabled, NOW, CYCLE)).toBe(true);
    expect(posterHealthy({ phase: 'disabled', mode: 'dry-run', updatedAt: NOW - 30_000 }, disabled, NOW, CYCLE, 'disabled')).toBe(true);
    expect(posterHealthy({ phase: 'disabled', mode: 'dry-run', updatedAt: NOW - staleAfterMs(CYCLE) - 1 }, disabled, NOW, CYCLE)).toBe(false);
    // The flags say disabled, so a record of an enabled run is not this worker's state.
    expect(posterHealthy(done('dry-run'), disabled, NOW, CYCLE)).toBe(false);
    expect(posterHealthy({ phase: 'disabled', mode: 'dry-run', updatedAt: NOW }, disabled, NOW, CYCLE, 'dry-run')).toBe(false);
  });

  it('an enabled poster is healthy only after a completed cycle in the mode its flags select', () => {
    expect(posterHealthy(done('dry-run'), dryRun, NOW, CYCLE, 'dry-run')).toBe(true);
    expect(posterHealthy(done('live', 60_000), live, NOW, CYCLE, 'live')).toBe(true);
    expect(posterHealthy(done('live'), dryRun, NOW, CYCLE)).toBe(false);
    expect(posterHealthy(done('dry-run'), dryRun, NOW, CYCLE, 'live')).toBe(false);
    // The first cycle still running, and a cycle ended by a failed RPC read: no completed cycle in the record.
    const running = { phase: 'running', mode: 'dry-run', chainId: 11155111, startedAt: NOW - 5_000, updatedAt: NOW, targets: 3, posted: 0, skipped: 0, errors: 0 };
    expect(posterHealthy(running, dryRun, NOW, CYCLE)).toBe(false);
    expect(posterHealthy({ ...running, phase: 'idle', errors: 1 }, dryRun, NOW, CYCLE)).toBe(false);
    expect(posterHealthy({ ...done('dry-run'), phase: 'disabled' }, dryRun, NOW, CYCLE)).toBe(false);
  });

  it('refuses stale, future, stopped, fatal and malformed records', () => {
    for (const bad of [null, 'idle', {}, done('dry-run', staleAfterMs(CYCLE) + 1), { ...done('dry-run'), updatedAt: NOW + 1 },
      { phase: 'stopped', stage: 'cycle', updatedAt: NOW }, { phase: 'fatal', stage: 'manifest', updatedAt: NOW },
      { ...done('dry-run'), updatedAt: String(NOW) }, { ...done('dry-run'), completedAt: NOW + 1 }]) {
      expect(posterHealthy(bad, dryRun, NOW, CYCLE)).toBe(false);
    }
  });

  it('reads only the flags and the health file; a bad argument is a usage error', async () => {
    const dir = await scratch(); const file = `${dir}/health.json`;
    const env = { SH_COW_HEALTH_FILE: file, SH_SERVICE_ENABLED: '1', SH_COW_RPC_URL: 'secret-rpc-token' };
    expect(healthcheck([], env, NOW)).toMatchObject({ code: 1, line: 'cow-poster: no health record yet\n' });
    await writeFile(file, JSON.stringify(done('dry-run')));
    expect(healthcheck(['dry-run'], env, NOW)).toEqual({ code: 0, line: 'cow-poster: dry-run; health current\n' });
    expect(healthcheck(['live'], env, NOW).code).toBe(1);
    expect(healthcheck(['typo'], env, NOW).code).toBe(2);
    expect(healthcheck(['dry-run', 'extra'], env, NOW).code).toBe(2);
    expect(healthcheck([], { ...env, SH_SERVICE_ENABLED: 'yes' }, NOW).code).toBe(1);
    expect(healthcheck([], { ...env, SH_COW_CYCLE_MS: '0' }, NOW).code).toBe(1);
    // A shorter cycle shortens the staleness bound, as in the Dockerfile's own check.
    expect(healthcheck([], { ...env, SH_COW_CYCLE_MS: '1000' }, NOW + 62_001).code).toBe(1);
  });

  it('the real entry exits by the record and never prints the RPC URL', async () => {
    const dir = await scratch(); const file = `${dir}/health.json`;
    const run = (env: Record<string, string>, ...args: string[]) => spawnSync(process.execPath, [...entry, ...args],
      { cwd, encoding: 'utf8', env: { SH_COW_HEALTH_FILE: file, SH_COW_RPC_URL: 'secret-rpc-token', ...env } });
    await writeFile(file, JSON.stringify({ phase: 'disabled', mode: 'dry-run', updatedAt: Date.now() }));
    const ok = run({}, 'disabled');
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toBe('cow-poster: disabled; health current\n');
    expect(run({ SH_SERVICE_ENABLED: '1' }, 'dry-run').status).toBe(1);
    expect(run({}, 'nope').status).toBe(2);
    await writeFile(file, JSON.stringify({ ...done('live'), completedAt: Date.now(), updatedAt: Date.now() }));
    const enabled = run({ SH_SERVICE_ENABLED: '1', SH_SERVICE_MODE: 'live' }, 'live');
    expect(enabled.status, enabled.stderr).toBe(0);
    for (const result of [ok, enabled]) expect(result.stdout + result.stderr).not.toContain('secret-rpc-token');
  });
});
