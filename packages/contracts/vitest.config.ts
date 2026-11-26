import { defineConfig } from 'vitest/config';
import { shTestTimeouts } from '../../vitest.timeouts.mjs';

// Solidity package: its tests run with Foundry (`forge test`), not vitest. The pinned Uniswap submodules under lib/
// ship their own JavaScript specs, which must not be collected by the root `pnpm test` (vitest projects packages/*).
export default defineConfig({
  test: {
    ...shTestTimeouts(),
    include: [],
    passWithNoTests: true,
  },
});
