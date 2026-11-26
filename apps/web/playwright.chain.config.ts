import { defineConfig, devices } from '@playwright/test';
import { TERMS_ACCEPTED } from './e2e/terms-state';

/**
 * Chain E2E (SH-C): the app against a real local Square Hole deployment. `e2e/chain/chain-server.mjs` starts anvil on
 * SH_E2E_CHAIN_PORT (default 8561, this repository's anvil range is 8550-8599), deploys and seeds with the contracts'
 * scripts, builds the app against that chain's manifest (dist-chain/) and serves it on E2E_CHAIN_APP_PORT (5393).
 * The tests share one chain, so they run in order in one worker. Run: `pnpm e2e:chain`.
 */
const PORT = Number(process.env.E2E_CHAIN_APP_PORT ?? 5393);

export default defineConfig({
  testDir: './e2e/chain',
  outputDir: './e2e/.artifacts-chain',
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  // Every spec starts with the current Terms accepted (F19).
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure', storageState: TERMS_ACCEPTED },
  webServer: {
    command: 'node e2e/chain/chain-server.mjs',
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 600_000,
    stdout: 'pipe',
  },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
});
