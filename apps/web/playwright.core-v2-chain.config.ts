import { defineConfig, devices } from '@playwright/test';
import { TERMS_ACCEPTED } from './e2e/terms-state';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

// One fresh chain and real indexer. No RPC fixtures, public network or reused server.
const port = Number(process.env.DEV_PORT ?? 5396);
// Config is loaded again in workers; inherit the parent's unique path so stale failures cannot retain a new run.
process.env.SH_CORE_V2_FAILURE_FILE ??= resolve(import.meta.dirname, '../../.cache/core-v2-local/failures', `${randomUUID()}.log`);
export default defineConfig({
  testDir: './e2e/core-v2-chain',
  testMatch: '**/*.spec.mjs',
  // The registry examples need their own stack's run file; `pnpm e2e:examples` runs them (SH-V21-FE13 finding 1).
  testIgnore: ['examples.spec.mjs'],
  outputDir: '../../.cache/core-v2-local/playwright',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  // SH-229: one hour for the suite (20 minutes before). On the Linux laptop of 2026-11-10 its 31 tests take over
  // 20 minutes; the limit only bounds a run that hangs.
  globalTimeout: 3_600_000,
  maxFailures: 1,
  expect: { timeout: 30_000 },
  reporter: [['list'], [resolve(import.meta.dirname, 'e2e/core-v2-chain/failure-reporter.mjs')]],
  use: { actionTimeout: 30_000, navigationTimeout: 30_000, baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure', storageState: TERMS_ACCEPTED },
  webServer: {
    command: 'node --experimental-transform-types --no-warnings=ExperimentalWarning ../../scripts/dev-core-v2-local.mjs --e2e',
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 600_000,
    stdout: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } }],
});
