import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { portsFromEnv, ROOT } from './support.mjs';
import { TERMS_ACCEPTED } from '../../terms-state.ts';

const ports = portsFromEnv();
export default defineConfig({
  testDir: '..', testMatch: 'examples.spec.mjs',
  outputDir: fileURLToPath(new URL('.cache/examples-e2e/playwright', ROOT)),
  // A cold build may use the full 30-minute Forge allowance. Keep 5 minutes for
  // deployment/indexer startup and an hour for the browser suite.
  // SH-229: twenty minutes for one life (4 before) and an hour for all of them (30 minutes before). On the Linux
  // laptop of 2026-11-10 the lives take 53 s to 2.8 min, the Junkyard's, the longest, 6.5 min (it was cut off at 4),
  // and all fourteen together 28 minutes; the limits only bound a life or a run that hangs.
  workers: 1, fullyParallel: false, retries: 0, timeout: 1_200_000, globalTimeout: 5_700_000,
  expect: { timeout: 30_000 },
  reporter: [['list'], [fileURLToPath(new URL('./reporter.mjs', import.meta.url))]],
  use: { baseURL: `http://127.0.0.1:${ports.appPort}`, storageState: TERMS_ACCEPTED,
    actionTimeout: 30_000, navigationTimeout: 30_000, trace: 'retain-on-failure' },
  webServer: { command: 'node --experimental-transform-types --no-warnings=ExperimentalWarning e2e/core-v2-chain/examples/stack.mjs',
    cwd: fileURLToPath(new URL('apps/web/', ROOT)), url: `http://127.0.0.1:${ports.appPort}`,
    reuseExistingServer: false, timeout: 2_100_000, stdout: 'pipe', gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 } },
  projects: [{ name: 'examples-local', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } }],
});
