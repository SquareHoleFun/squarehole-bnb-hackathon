import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { TERMS_ACCEPTED } from './e2e/terms-state';
import { expectOf, timeoutOf, workersOf } from './playwright-workers';

// Dedicated ports: another local project may already own Vite's defaults (5173/4173).
// Override per parallel worktree with E2E_PORT to avoid collisions.
const PORT = Number(process.env.E2E_PORT ?? 5392);

/**
 * The browser suite builds with the chain package's recorded local deployment manifest (a fixture) so the "Local chain"
 * data source can be chosen in the wallet and settings tests. Its RPC URL points at a port in the repository's anvil
 * range where nothing runs: chain reads fail and pages show "unavailable", never data. The demo stays the default, so
 * every demo and M1 acceptance test is unaffected. The real local chain is `playwright.chain.config.ts`.
 */
const FIXTURE_MANIFEST = fileURLToPath(new URL('../../packages/chain/src/test-support/manifest-31337.json', import.meta.url));
const FIXTURE_LOCAL_RPC_URL = 'http://127.0.0.1:8599';
/**
 * The v2 FIT market of the local chain (T19 pair page): a fixture record whose live service (127.0.0.1:8598) and RPC
 * (8599) nobody runs. e2e/fit-pair.spec.ts answers both from e2e/fixtures/fit-live-31337.json by intercepting the
 * requests in the browser; without that, the page shows its honest "unavailable" state.
 */
const FIXTURE_FIT_MARKET = fileURLToPath(new URL('./e2e/fixtures/fit-market-31337.json', import.meta.url));
/**
 * The committed Sepolia record (the full v2 deployment, neutral names), pointed at a live service on 127.0.0.1:8597
 * that nobody runs: e2e/fit-pair-sepolia.spec.ts answers it and the keyless Sepolia RPC from
 * e2e/fixtures/fit-live-11155111.json, recorded from the real service and chain. No test reaches the network.
 */
const SEPOLIA_FIT_MARKET = fileURLToPath(new URL('./fit-markets/fit-market-11155111.json', import.meta.url));
const FIXTURE_SEPOLIA_INDEXER = 'http://127.0.0.1:8597';
/**
 * Core v1 on the local twin (S10a): the core manifest recorded with box 0's life (e2e/fixtures/core-local/, written by
 * packages/indexer/scripts/record-core-fixture.ts), pointed at an indexer origin nobody runs (127.0.0.1:8596):
 * e2e/core-box.spec.ts answers it from the recorded gateway answers by intercepting the requests in the browser.
 */
const CORE_LOCAL_MANIFEST = fileURLToPath(new URL('./e2e/fixtures/core-local/manifest-11155111.json', import.meta.url));
const FIXTURE_CORE_INDEXER = 'http://127.0.0.1:8596';
/**
 * T06: the local v2 boxes' art gateway (pictures and models by raw CID), an origin nobody runs (127.0.0.1:8595):
 * e2e/core-v2-item-3d.spec.ts answers it by intercepting the requests in the browser; elsewhere a picture asked there is
 * not answered and its placeholder stays, as without a gateway.
 */
const FIXTURE_ART_GATEWAY = 'http://127.0.0.1:8595';

/**
 * The specs written only for the first handoff's pages (the M1 pair feed and its acceptance oracle, the pair detail):
 * those pages are off in every build since F134 R46B (src/routes.tsx, e2e/legacy-off.ts), so these cannot run. They stay
 * in the repository, unrun; e2e/no-demo-text.spec.ts checks where their URLs go now (e2e/legacy-off.ts).
 */
const LEGACY_SPECS = ['acceptance/**', 'feed.spec.ts', 'feed-responsive.spec.ts', 'feed-evidence.spec.ts', 'pair-detail.spec.ts'];

export default defineConfig({
  testDir: './e2e',
  // The live chain suites have their own configs (e2e:chain, e2e:core-chain, e2e:core-v2-chain) and need a running chain;
  // the production site's smoke test has its own build (e2e:production, playwright.production.config.ts).
  // SH-TA-12: the Sepolia test site's read-only pass too (e2e:sepolia-readonly, playwright.sepolia-readonly.config.ts).
  // F156 (SH-ALPHA-TRADE-BOX): the trade box's suite builds with the trade switch on, against its own local alpha chain
  // (e2e:alpha-trade, playwright.alpha-trade.config.ts); this suite's build has no trade code (no-trade-audit.spec.ts).
  // A pattern, not a glob: Playwright matches a glob anywhere in the absolute path, so 'alpha-trade/**' also ignored
  // every spec of a checkout in a folder of that name.
  // F161 (4) (SH-ALPHA-SITE): the alpha's tester access has its own build and edge (e2e:alpha-access,
  // playwright.alpha-access.config.ts).
  testIgnore: ['chain/**', 'core-chain/**', 'core-v2-chain/**', 'production/**', 'sepolia-readonly/**', /[\\/]e2e[\\/]alpha-trade[\\/]/, /[\\/]e2e[\\/]alpha-access[\\/]/, ...LEGACY_SPECS],
  outputDir: './e2e/.artifacts',
  fullyParallel: true,
  // SH-195: SH_E2E_WORKERS sets the worker count; unset, Playwright's default (playwright-workers.ts).
  workers: workersOf(),
  // SH_E2E_TIMEOUT raises the per-test limit on a slower machine; unset, Playwright's 30 s (playwright-workers.ts).
  timeout: timeoutOf(),
  // SH-219: SH_E2E_EXPECT_TIMEOUT raises one expectation's wait on a slower machine; unset, Playwright's 5 s.
  ...expectOf(),
  reporter: [['list']],
  // Every spec starts with the current Terms accepted (F19); e2e/terms-gate.spec.ts opts out.
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure', storageState: TERMS_ACCEPTED },
  webServer: {
    command: `pnpm exec vite build && pnpm exec vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      SH_LOCAL_MANIFEST: FIXTURE_MANIFEST,
      SH_LOCAL_RPC_URL: FIXTURE_LOCAL_RPC_URL,
      SH_FIT_MARKET: `${FIXTURE_FIT_MARKET},${SEPOLIA_FIT_MARKET}`,
      SH_SEPOLIA_INDEXER_ORIGIN: FIXTURE_SEPOLIA_INDEXER,
      SH_CORE_LOCAL_MANIFEST: CORE_LOCAL_MANIFEST,
      SH_CORE_LOCAL_RPC_URL: FIXTURE_LOCAL_RPC_URL,
      SH_CORE_LOCAL_INDEXER_ORIGIN: FIXTURE_CORE_INDEXER,
      SH_CORE_LOCAL_ART_GATEWAYS: FIXTURE_ART_GATEWAY,
    },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
  ],
});
