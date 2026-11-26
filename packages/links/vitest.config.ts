import { defineProject } from 'vitest/config';
import { shTestTimeouts } from '../../vitest.timeouts.mjs';

export default defineProject({
  test: { ...shTestTimeouts(), name: 'links', environment: 'node', include: ['src/**/*.test.ts'] },
});
