import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { shLimit } from '../../../vitest.timeouts.mjs';

test('SH-ALPHA-REHEARSAL local guards and manifest block commitments', () => {
  const run = spawnSync(process.execPath, ['--experimental-transform-types', '--test',
    'packages/chain/scripts/lib/alpha-local.test.mjs', 'packages/chain/scripts/alpha-rehearsal.scenarios.test.mjs'], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8', timeout: 30_000,
  });
  expect(run.error).toBeUndefined();
  expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
}, shLimit(40_000));
