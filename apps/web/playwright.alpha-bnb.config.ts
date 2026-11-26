import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';
import { TERMS_ACCEPTED } from './e2e/terms-state';

/**
 * SH-275: the alpha on the BNB Chain testnet site (an open site, automatic approval) in a browser, on a LOCAL chain 97
 * forked from the public chain (e2e/alpha-bnb/stack.mjs), with Privy's stand-in on the BNB site's dev server.
 * Our sign-in service and its sender are played by the test, as e2e/alpha-trade/setup.spec.mjs plays them.
 *
 *   pnpm --filter @squarehole/web exec playwright test -c playwright.alpha-bnb.config.ts --workers=1
 */
const port = Number(process.env.E2E_ALPHA_BNB_PORT ?? 5392);
export default defineConfig({
  testDir: './e2e/alpha-bnb',
  outputDir: '../../.cache/alpha-bnb/playwright',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  globalTimeout: 2_400_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: { actionTimeout: 30_000, navigationTimeout: 60_000, baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure', storageState: TERMS_ACCEPTED },
  webServer: {
    command: `node ${resolve(import.meta.dirname, 'e2e/alpha-bnb/stack.mjs')}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 600_000,
    stdout: 'pipe',
    env: { E2E_ALPHA_BNB_PORT: String(port) },
    gracefulShutdown: { signal: 'SIGTERM', timeout: 20_000 },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
  ],
});
