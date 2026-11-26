import { defineProject } from 'vitest/config';
import { shTestTimeouts } from '../../vitest.timeouts.mjs';

// Unit tests only (mocked transports, no network, no anvil). The read-side anvil suite has its own config
// (vitest.integration.config.ts; `pnpm test:chain-integration`); the write-side anvil test (src/write/integration)
// skips itself unless SH_CHAIN_WRITE_INTEGRATION=1 (`pnpm test:chain-integration:write`).
export default defineProject({
  test: { ...shTestTimeouts(), name: 'chain', environment: 'node', include: ['src/**/*.test.ts', 'test/*.test.ts', 'scripts/reveal-open-v2.test.ts', 'scripts/reveal-open-v2-batch.test.ts'] },
});
