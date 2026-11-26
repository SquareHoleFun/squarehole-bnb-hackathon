import { defineProject } from 'vitest/config';
import { shTestTimeouts } from '../../vitest.timeouts.mjs';

export default defineProject({
  test: { ...shTestTimeouts(), name: 'burn-bot', environment: 'node', include: ['test/**/*.test.ts'] },
});
