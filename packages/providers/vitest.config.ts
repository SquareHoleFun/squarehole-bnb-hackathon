import { defineProject } from 'vitest/config';
import { shTestTimeouts } from '../../vitest.timeouts.mjs';

export default defineProject({
  test: { ...shTestTimeouts(), name: 'providers', environment: 'node', include: ['src/**/*.test.ts'] },
});
