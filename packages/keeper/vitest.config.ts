import { defineProject } from 'vitest/config';
import { shTestTimeouts } from '../../vitest.timeouts.mjs';

// Unit tests on mocks: no network, no chain. The ABI drift test reads packages/contracts/out when it exists.
export default defineProject({
  test: { ...shTestTimeouts(), name: 'keeper', environment: 'node', include: ['test/**/*.test.ts'] },
});
