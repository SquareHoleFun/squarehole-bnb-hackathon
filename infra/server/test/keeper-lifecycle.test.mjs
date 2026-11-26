import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { STOP_BUDGET_MS } from '../services/runtime.mjs';
const scratch = () => { mkdirSync('.cache/tmp', { recursive: true }); return mkdtempSync(resolve('.cache/tmp/keeper-lifecycle-')); };
it.each(['timeout', 'signal', 'cooperative', 'startup'])('keeper releases correctly on %s', mode => {
  const dir = scratch();
  writeFileSync(join(dir, 'run.mjs'), readFileSync('infra/server/services/run.mjs'));
  writeFileSync(join(dir, 'runtime.mjs'), readFileSync('infra/server/services/runtime.mjs', 'utf8')
    .replace("'/tmp/service-health.json'", "new URL('./health.json', import.meta.url).pathname")
    .replace('CYCLE_TIMEOUT_MS = 240_000', 'CYCLE_TIMEOUT_MS = 250')
    .replace('STOP_BUDGET_MS = 45_000', 'STOP_BUDGET_MS = 50'));
  writeFileSync(join(dir, 'keeper.mjs'), `
    import { writeFileSync } from 'node:fs';
    const mode = ${JSON.stringify(mode)};
    export async function createDriver() {
      if (mode === 'startup') return new Promise(() => {});
      return { async cycle({ signal }) {
        if (mode !== 'timeout') setTimeout(() => process.kill(process.pid, 'SIGTERM'), 10);
        await new Promise(resolve => {
          if (mode === 'cooperative') signal.addEventListener('abort', resolve, { once: true });
        });
        return true;
      }, release() { writeFileSync(new URL('./released', import.meta.url), 'released'); },
      close() { writeFileSync(new URL('./closed', import.meta.url), 'closed'); } };
    }
  `);
  const run = spawnSync(process.execPath, [join(dir, 'run.mjs'), 'keeper'], { encoding: 'utf8', timeout: 2000,
    env: { PATH: process.env.PATH, SH_SERVICE_ENABLED: '1' } });
  expect(run.status, run.stderr).toBe(['timeout', 'startup'].includes(mode) ? 1 : 0);
  expect(run.stderr).toBe(['timeout', 'startup'].includes(mode) ? 'keeper: cycle timed out\n' : '');
  expect(existsSync(join(dir, 'released'))).toBe(['timeout', 'signal'].includes(mode));
  expect(existsSync(join(dir, 'closed'))).toBe(mode === 'cooperative');
});
it('stops within the keeper Compose grace period', () => {
  const compose = readFileSync('infra/server/compose.yaml', 'utf8');
  const keeper = compose.slice(compose.indexOf('\n  keeper:'), compose.indexOf('\n  burn-bot:'));
  const seconds = keeper.match(/stop_grace_period: (\d+)s/);
  expect(seconds).not.toBeNull(); expect(STOP_BUDGET_MS).toBeLessThan(Number(seconds[1]) * 1000);
});
