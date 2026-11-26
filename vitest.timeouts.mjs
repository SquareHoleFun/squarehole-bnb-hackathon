/**
 * SH_TEST_TIMEOUT (opt-in, whole milliseconds): the default testTimeout and hookTimeout of every vitest config that
 * spreads `shTestTimeouts()` into its `test` block, for a slower machine (the Linux laptop of 2026-11-10 needs more
 * than vitest's 5 s on several suites). Unset or empty: `{}`, so vitest's own defaults (5 s per test, 10 s per hook)
 * hold exactly as before. Explicit test and hook limits use `shLimit` to keep the same opt-in floor.
 *
 * Each project config needs the spread: vitest does not pass a root config's `test` options to file-based projects,
 * and `--hookTimeout` on the command line does not reach them either.
 */
export function shTestTimeouts(env = process.env) {
  const raw = env.SH_TEST_TIMEOUT;
  if (raw === undefined || raw === '') return {};
  if (!/^[1-9][0-9]{0,9}$/.test(raw) || Number(raw) > 2_147_483_647) {
    throw new Error(`SH_TEST_TIMEOUT must be a whole number of milliseconds from 1 to 2147483647, got ${JSON.stringify(raw)}`);
  }
  const ms = Number(raw);
  return { testTimeout: ms, hookTimeout: ms };
}

/** Keep an explicit test or hook limit, raising it only when the slower-machine opt-in is larger. */
export function shLimit(ms, env = process.env) {
  const { testTimeout } = shTestTimeouts(env);
  return testTimeout === undefined ? ms : Math.max(ms, testTimeout);
}

/**
 * The same opt-in for Testing Library's waits (`findBy*`, `waitFor`; 1 s by default) in the jsdom suites: a tenth of
 * SH_TEST_TIMEOUT, never under the default 1000 ms, so a wait that never succeeds still fails with its own message
 * before the test's timeout. Unset: undefined, and the web config adds no setup file.
 */
export function shAsyncUtilTimeout(env = process.env) {
  const { testTimeout } = shTestTimeouts(env);
  return testTimeout === undefined ? undefined : Math.max(1000, Math.round(testTimeout / 10));
}
