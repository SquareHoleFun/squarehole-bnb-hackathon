import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { shLimit, shTestTimeouts } from '../../vitest.timeouts.mjs';

// SH-195: SH_TEST_TIMEOUT is opt-in; unset, every vitest config keeps vitest's own defaults.
const root = fileURLToPath(new URL('../../', import.meta.url));

test('unset or empty SH_TEST_TIMEOUT adds nothing to a vitest config', () => {
  assert.deepEqual(shTestTimeouts({}), {});
  assert.deepEqual(shTestTimeouts({ SH_TEST_TIMEOUT: '' }), {});
});

test('SH_TEST_TIMEOUT sets the test and the hook timeout to the same milliseconds', () => {
  assert.deepEqual(shTestTimeouts({ SH_TEST_TIMEOUT: '60000' }), { testTimeout: 60000, hookTimeout: 60000 });
  assert.deepEqual(shTestTimeouts({ SH_TEST_TIMEOUT: '2147483647' }), { testTimeout: 2147483647, hookTimeout: 2147483647 });
});

test('SH_TEST_TIMEOUT refuses anything but a whole positive number of milliseconds', () => {
  for (const raw of ['0', '-1', '1.5', '60s', ' 60000', '0x10', '1e4', '2147483648', '99999999999'])
    assert.throws(() => shTestTimeouts({ SH_TEST_TIMEOUT: raw }), /SH_TEST_TIMEOUT/, raw);
});

test('explicit limits stay exact when the opt-in is unset or empty', () => {
  for (const ms of [1, 15_000, 30_000, 60_000, 120_000, 900_000]) {
    assert.equal(shLimit(ms, {}), ms);
    assert.equal(shLimit(ms, { SH_TEST_TIMEOUT: '' }), ms);
  }
});

test('explicit limits never fall below their own value or the opt-in', () => {
  for (const ms of [15_000, 30_000, 60_000, 120_000, 900_000]) {
    assert.equal(shLimit(ms, { SH_TEST_TIMEOUT: '60000' }), Math.max(ms, 60_000));
    assert.equal(shLimit(ms, { SH_TEST_TIMEOUT: '1' }), ms);
    assert.equal(shLimit(ms, { SH_TEST_TIMEOUT: '2147483647' }), 2_147_483_647);
  }
});

test('explicit limits validate the opt-in using the same rules as defaults', () => {
  for (const raw of ['0', '-1', '1.5', '60s', ' 60000', '0x10', '1e4', '2147483648', '99999999999'])
    assert.throws(() => shLimit(30_000, { SH_TEST_TIMEOUT: raw }), /SH_TEST_TIMEOUT/, raw);
});

test('explicit limits read the current process opt-in by default', () => {
  const previous = process.env.SH_TEST_TIMEOUT;
  try {
    process.env.SH_TEST_TIMEOUT = '60000';
    assert.equal(shLimit(30_000), 60_000);
    delete process.env.SH_TEST_TIMEOUT;
    assert.equal(shLimit(30_000), 30_000);
  } finally {
    if (previous === undefined) delete process.env.SH_TEST_TIMEOUT;
    else process.env.SH_TEST_TIMEOUT = previous;
  }
});

test('every vitest config with a test block spreads shTestTimeouts() into it', () => {
  const configs = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n')
    .filter((f) => /vitest[^/]*\.config\.(ts|mts|mjs|js)$/.test(f) && f !== 'vitest.config.ts').concat('apps/web/vite.config.ts');
  assert.ok(configs.length >= 28, `found ${configs.length} configs`);
  for (const f of configs) assert.match(readFileSync(new URL(f, `file://${root}`), 'utf8'), /test: \{\s*\.\.\.shTestTimeouts\(\),/, f);
});

test("Testing Library's wait follows SH_TEST_TIMEOUT at a tenth, never under its 1000 ms default", async () => {
  const { shAsyncUtilTimeout } = await import('../../vitest.timeouts.mjs');
  assert.equal(shAsyncUtilTimeout({}), undefined);
  assert.equal(shAsyncUtilTimeout({ SH_TEST_TIMEOUT: '' }), undefined);
  assert.equal(shAsyncUtilTimeout({ SH_TEST_TIMEOUT: '60000' }), 6000);
  assert.equal(shAsyncUtilTimeout({ SH_TEST_TIMEOUT: '5000' }), 1000);
});
