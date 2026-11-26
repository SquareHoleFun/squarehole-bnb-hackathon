import { defineProject } from 'vitest/config';
import { shTestTimeouts } from '../../vitest.timeouts.mjs';

export default defineProject({
  test: { ...shTestTimeouts(), name: 'box-spec', environment: 'node', include: ['src/**/*.test.ts', 'test/set-v2/**/*.test.ts'] },
});
