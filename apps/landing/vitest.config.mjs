import { defineProject } from 'vitest/config';
import { shTestTimeouts } from '../../vitest.timeouts.mjs';

// The landing page's checks: the host redirect (functions/_middleware.js) and the static files in public/.
export default defineProject({
  test: { ...shTestTimeouts(), name: 'landing', environment: 'node', include: ['test/**/*.test.js'] },
});
