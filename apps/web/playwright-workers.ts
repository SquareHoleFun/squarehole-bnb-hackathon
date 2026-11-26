/**
 * SH_E2E_WORKERS (opt-in): the worker count of the browser suites that run in parallel (`pnpm e2e`,
 * `pnpm e2e:production`, `pnpm e2e:sepolia-readonly`), a whole number such as `2` or a share of the CPUs such as
 * `25%`. Unset or empty: undefined, so Playwright's own default (half the logical CPUs) holds as before. A slower
 * machine sets fewer: on the 8-thread Linux laptop of 2026-11-10 the default four workers ran 36 of 546 tests into
 * their timeouts, and 34 of those passed with one worker. `--workers` on the command line still wins.
 */
export function workersOf(env: Readonly<Record<string, string | undefined>> = process.env): number | string | undefined {
  const raw = env.SH_E2E_WORKERS;
  if (raw === undefined || raw === '') return undefined;
  if (/^[1-9][0-9]{0,2}$/.test(raw)) return Number(raw);
  if (/^([1-9][0-9]?|100)%$/.test(raw)) return raw;
  throw new Error(`SH_E2E_WORKERS must be a whole number (1-999) or a percentage (1%-100%), got ${JSON.stringify(raw)}`);
}

/**
 * SH_E2E_TIMEOUT (opt-in, whole milliseconds): the per-test time limit of the same browser suites. Unset or empty:
 * undefined, so Playwright's own default (30 s per test) holds as before; a test's own `test.setTimeout` still wins.
 * A slower machine sets more: on the 8-thread Linux laptop the two audits that walk every route in one test
 * (`no-trade-audit.spec.ts`, `wording-audit.spec.ts`) take 28 to 35 s even alone (2026-11-10 and 2026-11-12). It may
 * only raise the limit: a value under Playwright's 30,000 ms is refused, so the opt-in can never hide a slow test on a
 * fast machine by accident nor shorten a run.
 */
export function timeoutOf(env: Readonly<Record<string, string | undefined>> = process.env): number | undefined {
  const raw = env.SH_E2E_TIMEOUT;
  if (raw === undefined || raw === '') return undefined;
  if (!/^[1-9][0-9]{4,6}$/.test(raw) || Number(raw) < 30_000) {
    throw new Error(`SH_E2E_TIMEOUT must be a whole number of milliseconds from 30000 to 9999999, got ${JSON.stringify(raw)}`);
  }
  return Number(raw);
}

/**
 * SH_E2E_EXPECT_TIMEOUT (opt-in, whole milliseconds): how long one `expect(...)` of the same browser suites waits for
 * the page. Unset or empty: undefined, so Playwright's own default (5 s) holds as before; an expectation's own
 * `{ timeout }` still wins. A slower machine sets more: on the 8-thread Linux laptop the full run of 2026-11-15 lost
 * one test of 582 to a stall of the machine (a five-step claim stood at "Claiming 4 / 5" when its 5 s ran out; the
 * same test takes 2.8 s otherwise, and its neighbours ran at their usual speed). It may only raise the limit: a value
 * under Playwright's 5,000 ms is refused, so the opt-in can never shorten a wait.
 */
export function expectTimeoutOf(env: Readonly<Record<string, string | undefined>> = process.env): number | undefined {
  const raw = env.SH_E2E_EXPECT_TIMEOUT;
  if (raw === undefined || raw === '') return undefined;
  if (!/^[1-9][0-9]{3,5}$/.test(raw) || Number(raw) < 5_000) {
    throw new Error(`SH_E2E_EXPECT_TIMEOUT must be a whole number of milliseconds from 5000 to 999999, got ${JSON.stringify(raw)}`);
  }
  return Number(raw);
}

/** The piece of a Playwright config that carries it: nothing at all when unset, so Playwright's default is untouched. */
export function expectOf(env: Readonly<Record<string, string | undefined>> = process.env): { expect?: { timeout: number } } {
  const timeout = expectTimeoutOf(env);
  return timeout === undefined ? {} : { expect: { timeout } };
}
