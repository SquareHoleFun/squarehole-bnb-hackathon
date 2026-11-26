import { defineProject } from 'vitest/config';
import { shTestTimeouts } from '../../vitest.timeouts.mjs';

// Unit tests: no network. The Redis store runs the same contract suite as the memory store when SH_TEST_REDIS_URL is
// set (e.g. redis://127.0.0.1:5395/15 for the local Docker Redis); otherwise that suite is skipped.
export default defineProject({
  test: { ...shTestTimeouts(), name: 'indexer', environment: 'node', include: ['src/**/*.test.ts', 'test/**/*.test.ts'] },
});
