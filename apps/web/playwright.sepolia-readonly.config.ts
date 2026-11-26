import { defineConfig, devices } from '@playwright/test';
import { TEST_NETWORK_NOTICE_ACCEPTED } from './e2e/terms-state';
import { expectOf, timeoutOf, workersOf } from './playwright-workers';

/**
 * SH-TA-12: the test app's read-only pass on the real Sepolia manifest (`pnpm e2e:sepolia-readonly`). The build is the
 * Sepolia test site's release build as infra/server/app/build.mjs makes it: `SH_BUILD=production SH_TARGET=sepolia`,
 * no market record, the committed manifest packages/contracts/deployments/core-v1/11155111.json (no
 * SH_CORE_SEPOLIA_MANIFEST) and the indexer at https://api.squarehole.fun; no placeholder bypass (the test network
 * notice ships, not the drafts). e2e/sepolia-readonly answers the indexer from its own recorded answers for this
 * manifest and the keyless RPCs from the head block inside the browser, and aborts every other request: no test
 * reaches the live API or a network. `E2E_PORT` picks the preview port (default 5397, the production preview's).
 */
const PORT = Number(process.env.E2E_PORT ?? 5397);
const OUT_DIR = '.production/sepolia-readonly/dist';

export default defineConfig({
  testDir: './e2e/sepolia-readonly',
  outputDir: './e2e/.artifacts/sepolia-readonly',
  fullyParallel: true,
  // SH-195: SH_E2E_WORKERS sets the worker count; unset, Playwright's default (playwright-workers.ts).
  workers: workersOf(),
  // SH_E2E_TIMEOUT raises the per-test limit on a slower machine; unset, Playwright's 30 s (playwright-workers.ts).
  timeout: timeoutOf(),
  // SH-219: SH_E2E_EXPECT_TIMEOUT raises one expectation's wait on a slower machine; unset, Playwright's 5 s.
  ...expectOf(),
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure', storageState: TEST_NETWORK_NOTICE_ACCEPTED },
  webServer: {
    command: `pnpm exec vite build --outDir ${OUT_DIR} --emptyOutDir && pnpm exec vite preview --outDir ${OUT_DIR} --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      SH_BUILD: 'production',
      SH_TARGET: 'sepolia',
      SH_FIT_MARKET: 'none',
      SH_CORE_SEPOLIA_INDEXER_ORIGIN: 'https://api.squarehole.fun',
      SH_SEPOLIA_INDEXER_ORIGIN: 'https://api.squarehole.fun',
      // The committed manifest, and nothing local, whatever the calling shell exports.
      SH_CORE_SEPOLIA_MANIFEST: '',
      SH_LOCAL_MANIFEST: '',
      SH_LOCAL_RPC_URL: '',
      SH_CORE_LOCAL_MANIFEST: '',
      SH_CORE_LOCAL_RPC_URL: '',
      SH_CORE_LOCAL_INDEXER_ORIGIN: '',
      SH_CORE_LOCAL_ART_GATEWAYS: '',
      SH_ALLOW_PLACEHOLDERS: '',
    },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
  ],
});
