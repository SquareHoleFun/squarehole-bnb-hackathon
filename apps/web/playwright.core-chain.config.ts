import { defineConfig, devices } from '@playwright/test';
import { TERMS_ACCEPTED } from './e2e/terms-state';

/**
 * The live core v1 suite (S10a § 7.3; `pnpm e2e:core-chain`): the app against core v1 and box 0 on a local twin chain.
 * `e2e/core-chain/core-chain-server.mjs` starts anvil on SH_E2E_CORE_CHAIN_PORT (default 8559) with core v1 deployed,
 * builds the app against that chain's core manifest (dist-core-chain/) and serves it on E2E_PORT (default 5397); the
 * spec runs box 0's life stage by stage with the core service (SH_E2E_CORE_GATEWAY_PORT, default 5398; hot state in
 * memory) and the history writer on a throwaway Postgres socket. One chain, so one worker, in order.
 */
const PORT = Number(process.env.E2E_PORT ?? 5397);

export default defineConfig({
  testDir: './e2e/core-chain',
  outputDir: './e2e/.artifacts-core-chain',
  fullyParallel: false,
  workers: 1,
  timeout: 600_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure', storageState: TERMS_ACCEPTED },
  webServer: {
    command: 'node e2e/core-chain/core-chain-server.mjs',
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 600_000,
    stdout: 'pipe',
  },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } }],
});
