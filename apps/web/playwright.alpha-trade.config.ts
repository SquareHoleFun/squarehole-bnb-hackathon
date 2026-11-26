import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';
import { TERMS_ACCEPTED } from './e2e/terms-state';

/**
 * F156 (SH-ALPHA-TRADE-BOX): the Sepolia alpha's buy/sell box in a browser, on desktop and on a phone, against a fresh
 * local 31337 alpha (scripts/dev-alpha-local.mjs --e2e: anvil with the alpha setup of SH-ALPHA-REHEARSAL, the real core
 * indexer over it, and a development build of the site with the trade switch on, served by `vite preview`). The trades
 * are real: the page's own plans and sends, mined by anvil from a test wallet's unlocked account. No RPC fixture, no
 * public network, no reused server. Ports: the site 5534 (E2E_ALPHA_PORT), the indexer 5535, anvil 8592.
 *
 *   pnpm --filter @squarehole/web e2e:alpha-trade
 *   SH_EVIDENCE_SCREENSHOTS=1 ... also writes docs/evidence/screenshots/sh-alpha-trade-box/
 */
const port = Number(process.env.E2E_ALPHA_PORT ?? 5534);
export default defineConfig({
  testDir: './e2e/alpha-trade',
  outputDir: '../../.cache/alpha-local/playwright',
  // One chain for the whole run: the tests change it (time, trades), so they run one after another.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  globalTimeout: 2_700_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: { actionTimeout: 30_000, navigationTimeout: 30_000, baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure', storageState: TERMS_ACCEPTED },
  webServer: {
    command: `node --experimental-transform-types --no-warnings=ExperimentalWarning ${resolve(import.meta.dirname, '../../scripts/dev-alpha-local.mjs')} --e2e`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 900_000,
    stdout: 'pipe',
    env: { DEV_PORT: String(port) },
    gracefulShutdown: { signal: 'SIGTERM', timeout: 20_000 },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
  ],
});
