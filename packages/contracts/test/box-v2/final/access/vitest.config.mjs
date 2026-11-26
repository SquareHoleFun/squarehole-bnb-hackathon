import { defineConfig } from 'vitest/config';
import { shTestTimeouts } from '../../../../../../vitest.timeouts.mjs';

export default defineConfig({
  test: { ...shTestTimeouts(), environment: 'node', include: ['packages/contracts/test/box-v2/final/access/*.test.ts'] },
});
