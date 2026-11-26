import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { localOptions } from '../../../../../packages/chain/scripts/lib/core-v2-local-runtime.mjs';
import { TERMS_ACCEPTED } from '../../terms-state.ts';

// SH-ARWEAVE-PICTURES-WEB: the real flow once against the local core-v2 chain stack, with ONE REAL Arweave upload
// (Turbo's free tier: permanent and public). Opt-in only: the test skips unless SH_ARWEAVE_LIVE=1, no other config
// matches this file, and the stack is started with SH_ARWEAVE_PICTURES=1, which no other suite sets. Run it only when an
// upload is meant:
//   SH_ARWEAVE_LIVE=1 pnpm --filter @squarehole/web exec playwright test --config e2e/core-v2-chain/arweave/playwright.config.mjs
const ports = localOptions();
export default defineConfig({
  testDir: '.',
  testMatch: ['arweave-pictures.e2e.mjs'],
  outputDir: fileURLToPath(new URL('../../../../../.cache/core-v2-arweave/playwright', import.meta.url)),
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 600_000,
  globalTimeout: 1_200_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${ports.appPort}`, storageState: TERMS_ACCEPTED, actionTimeout: 30_000, navigationTimeout: 30_000, trace: 'retain-on-failure' },
  // Without SH_ARWEAVE_LIVE=1 the test skips, so no stack is started for it.
  webServer: process.env.SH_ARWEAVE_LIVE !== '1' ? undefined : {
    command: 'node --experimental-transform-types --no-warnings=ExperimentalWarning ../../scripts/dev-core-v2-local.mjs --e2e',
    cwd: fileURLToPath(new URL('../../../', import.meta.url)),
    env: { ...process.env, SH_ARWEAVE_PICTURES: '1' },
    url: `http://127.0.0.1:${ports.appPort}`,
    reuseExistingServer: false,
    timeout: 600_000,
    stdout: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
  projects: [{ name: 'arweave-local', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } }],
});
