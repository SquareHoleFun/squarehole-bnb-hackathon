import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { localOptions } from '../../../../../packages/chain/scripts/lib/core-v2-local-runtime.mjs';
import { TERMS_ACCEPTED } from '../../terms-state.ts';

// SH-V21-FE13: one fresh local chain, the real indexer and the site; the browser creates a shop and lives it (give,
// pick, the curator's addition). Its own stack (stack.mjs): the core-v2-chain suite's serves only the committed
// pictures, so a box created in the browser would have no pictures there (until SH-NO-PICTURE-GATE it was not even
// listed). The suite's port variables, one worker.
// SH-V21-FE14 adds fees-life.e2e.mjs on the same stack: Into the shop and The Alchemist, created in the browser.
const ports = localOptions();
export default defineConfig({
  testDir: '.',
  testMatch: ['shop-life.e2e.mjs', 'fees-life.e2e.mjs'],
  outputDir: fileURLToPath(new URL('../../../../../.cache/core-v2-shop/playwright', import.meta.url)),
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 900_000,
  globalTimeout: 1_800_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${ports.appPort}`, storageState: TERMS_ACCEPTED, actionTimeout: 30_000, navigationTimeout: 30_000, trace: 'retain-on-failure' },
  webServer: {
    command: 'node --experimental-transform-types --no-warnings=ExperimentalWarning e2e/core-v2-chain/shop/stack.mjs',
    cwd: fileURLToPath(new URL('../../../', import.meta.url)),
    url: `http://127.0.0.1:${ports.appPort}`,
    reuseExistingServer: false,
    timeout: 900_000,
    stdout: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
  projects: [{ name: 'shop-local', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
});
