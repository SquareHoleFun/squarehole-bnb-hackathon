import { defineProject } from 'vitest/config';
import { shTestTimeouts } from '../../vitest.timeouts.mjs';

export default defineProject({
  test: { ...shTestTimeouts(), name: 'cards', environment: 'node', include: ['src/**/*.test.ts'] },
});
