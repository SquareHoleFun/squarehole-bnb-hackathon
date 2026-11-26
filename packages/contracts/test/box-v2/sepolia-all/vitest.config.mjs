import { defineConfig } from 'vitest/config';
import { shTestTimeouts } from '../../../../../vitest.timeouts.mjs';

export default defineConfig({
  test: { ...shTestTimeouts(), include: ['packages/contracts/test/box-v2/sepolia-all/*.test.ts'] },
});
