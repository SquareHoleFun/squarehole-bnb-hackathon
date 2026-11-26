import { defineConfig } from 'vitest/config';
import { shTestTimeouts } from '../../vitest.timeouts.mjs';

// Anvil integration suite (port 8551 by default, SH_CHAIN_IT_PORT to override within 8550-8599): deploys the pinned
// contracts with packages/contracts/script/Deploy.s.sol, finalizes the manifest, runs the local end-to-end trades and
// checks the chain providers against on-chain truth, including a reorg (anvil snapshot/revert). Slow; not part of
// `pnpm test`.
export default defineConfig({
  test: {
    ...shTestTimeouts(),
    name: 'chain-integration',
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 240_000,
    hookTimeout: 900_000,
    fileParallelism: false,
  },
});
