/** See vitest.timeouts.mjs: SH_TEST_TIMEOUT as vitest's testTimeout and hookTimeout; `{}` when it is unset. */
export function shTestTimeouts(env?: Record<string, string | undefined>): { testTimeout?: number; hookTimeout?: number };
/** An explicit test or hook limit, never below either ms or the optional SH_TEST_TIMEOUT. */
export function shLimit(ms: number, env?: Record<string, string | undefined>): number;
/** A tenth of SH_TEST_TIMEOUT (at least 1000) for Testing Library's waits; undefined when it is unset. */
export function shAsyncUtilTimeout(env?: Record<string, string | undefined>): number | undefined;
