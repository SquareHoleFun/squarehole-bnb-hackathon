import { defineConfig } from 'vitest/config';
import { shTestTimeouts } from '../../../../../../../vitest.timeouts.mjs';

// This review's tests live in the ticket-owned Solidity folder, outside workspace src globs.
export default defineConfig({
  test: {
    ...shTestTimeouts(),
    environment: 'node',
    include: ['packages/contracts/test/box/audit/regress/access/*.test.ts'],
  },
});
