import { defineProject } from 'vitest/config';
import { shTestTimeouts } from '../../vitest.timeouts.mjs';

// Node by default; component tests opt into jsdom with `// @vitest-environment jsdom`.
export default defineProject({
  test: { ...shTestTimeouts(), name: 'design', environment: 'node', include: ['src/**/*.test.{ts,tsx}'] },
});
