import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { expectOf, timeoutOf, workersOf } from './playwright-workers';
import { productionTarget } from './e2e/production/production-target';
import { PRODUCTION_INDEXER } from './e2e/production/production-origin';
import { PRODUCTION_TERMS_ACCEPTED, TEST_NETWORK_NOTICE_ACCEPTED } from './e2e/terms-state';

/**
 * The production site's smoke test (SH-V2-FE6; `pnpm e2e:production`, part of `pnpm check:production`): the
 * `SH_BUILD=production` build, served by `vite preview` on its own port (5397), with a Sepolia deployment to show.
 *
 * Sepolia's committed core manifest is the `awaiting-broadcast` placeholder, so a bare production build has no box to
 * show. This build names a recorded one instead (SH_CORE_SEPOLIA_MANIFEST): the main suite's core v1 + v2 fixture
 * (e2e/fixtures/core-local, recorded on a twin with Sepolia's chain id), written here as a Sepolia manifest. Its
 * indexer origin is an https host under the reserved `.test` name that nothing serves; e2e/production answers it and
 * the keyless Sepolia RPC from recorded fixtures inside the browser and aborts every other request leaving the
 * machine, so no test reaches a network. `pnpm check:production` scans the build its caller's variables name (the bare
 * one by default), never this fixture build. production-gate.spec.ts starts with no accepted Terms; every other spec
 * starts with the production Terms accepted (their own version, SH-V2-FE7).
 *
 * SH-TA-02: the build follows the caller's `SH_TARGET` (apps/web/build-target.ts), so `SH_TARGET=sepolia pnpm
 * check:production` tests the Sepolia test site, whose legal pages show the test network notice: every spec then
 * starts with that notice accepted, the main site's Terms specs are skipped and production-test-network.spec.ts runs.
 * F156: production-trade.spec.ts follows the target as well (no trade code loaded on mainnet; the Sepolia build loads
 * its trade slot lazily, on a v2 box page only).
 */
const TARGET = productionTarget();
const PORT = Number(process.env.E2E_PRODUCTION_PORT ?? 5397);
const OUT_DIR = '.production/e2e/dist';

const FIXTURE_DIR = join(tmpdir(), 'squarehole-production-e2e');
const SEPOLIA_MANIFEST = join(FIXTURE_DIR, 'core-sepolia-manifest.json');
const recorded = JSON.parse(readFileSync(fileURLToPath(new URL('./e2e/fixtures/core-local/manifest-11155111.json', import.meta.url)), 'utf8')) as Record<string, unknown>;
mkdirSync(FIXTURE_DIR, { recursive: true });
writeFileSync(SEPOLIA_MANIFEST, `${JSON.stringify({ ...recorded, network: 'sepolia' }, null, 2)}\n`);

export default defineConfig({
  testDir: './e2e/production',
  outputDir: './e2e/.artifacts/production',
  fullyParallel: true,
  // SH-195: SH_E2E_WORKERS sets the worker count; unset, Playwright's default (playwright-workers.ts).
  workers: workersOf(),
  // SH_E2E_TIMEOUT raises the per-test limit on a slower machine; unset, Playwright's 30 s (playwright-workers.ts).
  timeout: timeoutOf(),
  // SH-219: SH_E2E_EXPECT_TIMEOUT raises one expectation's wait on a slower machine; unset, Playwright's 5 s.
  ...expectOf(),
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure', storageState: TARGET === 'sepolia' ? TEST_NETWORK_NOTICE_ACCEPTED : PRODUCTION_TERMS_ACCEPTED },
  webServer: {
    command: `pnpm exec vite build --outDir ${OUT_DIR} --emptyOutDir && pnpm exec vite preview --outDir ${OUT_DIR} --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      SH_BUILD: 'production',
      SH_TARGET: TARGET,
      SH_CORE_SEPOLIA_MANIFEST: SEPOLIA_MANIFEST,
      SH_CORE_SEPOLIA_INDEXER_ORIGIN: PRODUCTION_INDEXER,
      // A production build refuses every local variable: make sure none comes in from the calling shell.
      SH_LOCAL_MANIFEST: '',
      SH_LOCAL_RPC_URL: '',
      SH_CORE_LOCAL_MANIFEST: '',
      SH_CORE_LOCAL_RPC_URL: '',
      SH_CORE_LOCAL_INDEXER_ORIGIN: '',
      SH_CORE_LOCAL_ART_GATEWAYS: '',
      SH_SET_LOCAL_MANIFEST: '',
      // F156: and the trade opt-in, which a production build refuses as well: the target alone switches the trade code.
      SH_SEPOLIA_TRADE: '',
      SH_FIT_MARKET: 'none',
      // A preview that is never uploaded: let the production Terms' open placeholders through (placeholder-guard.ts).
      SH_ALLOW_PLACEHOLDERS: '1',
    },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
  ],
});
