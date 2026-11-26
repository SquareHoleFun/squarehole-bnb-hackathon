import { defineConfig, devices } from '@playwright/test';
import { TERMS_ACCEPTED } from './e2e/terms-state';

/**
 * F161 (4), SH-ALPHA-SITE: the Sepolia alpha's tester access in a browser, on desktop and on a phone: the join page,
 * the sign-in with X, pending, approved, removed, the Claim card with a browser wallet and with the wallet Privy makes,
 * and the founder's desk. The build is a development build with the trade opt-in and the Privy stand-in
 * (`SH_SEPOLIA_TRADE=1 SH_ALPHA_STANDIN=1`; every production build refuses the stand-in), served by the suite's edge
 * (e2e/alpha-access/edge.mjs): the test host's Caddy routes and headers with the alpha switch on, in front of the real
 * alpha-api, with Cloudflare Access, X and Privy, and the sender played by the edge. privy-sdk.spec.mjs runs the join
 * page with Privy's real SDK instead (the probe page), its service stood in at the network. Privy's service is never
 * asked. Port 5546 (E2E_ALPHA_ACCESS_PORT).
 *
 *   pnpm --filter @squarehole/web e2e:alpha-access
 *   SH_EVIDENCE_SCREENSHOTS=1 ... also writes docs/evidence/SH-ALPHA-SITE/<screen>-<width>.png
 */
const port = Number(process.env.E2E_ALPHA_ACCESS_PORT ?? 5546);
const OUT_DIR = '.cache/alpha-access/dist';

export default defineConfig({
  testDir: './e2e/alpha-access',
  outputDir: './e2e/.artifacts/alpha-access',
  // Each test has its own alpha-api state (the edge_tenant cookie); one worker all the same, as every suite here.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure', storageState: TERMS_ACCEPTED },
  webServer: {
    // The site, then the Privy probe (the join page with Privy's real SDK, e2e/alpha-access/probe), then the edge.
    command: `pnpm exec vite build --outDir ${OUT_DIR} --emptyOutDir && pnpm exec vite build --config e2e/alpha-access/probe/vite.config.ts && node e2e/alpha-access/edge.mjs`,
    url: `http://127.0.0.1:${port}/join/`,
    reuseExistingServer: false,
    timeout: 600_000,
    stdout: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    env: {
      EDGE_PORT: String(port),
      EDGE_DIST: OUT_DIR,
      SH_SEPOLIA_TRADE: '1',
      SH_ALPHA_STANDIN: '1',
      // A development build, with nothing local and nothing the calling shell exports.
      SH_BUILD: '',
      SH_TARGET: '',
      SH_LOCAL_MANIFEST: '',
      // Embedded, never read (no local manifest): the port the main suite names for "nothing runs here".
      SH_LOCAL_RPC_URL: 'http://127.0.0.1:8599',
      SH_CORE_LOCAL_MANIFEST: '',
      SH_CORE_LOCAL_RPC_URL: '',
      SH_CORE_LOCAL_INDEXER_ORIGIN: '',
      SH_CORE_LOCAL_ART_GATEWAYS: '',
      SH_CORE_SEPOLIA_MANIFEST: '',
      SH_CORE_SEPOLIA_INDEXER_ORIGIN: '',
      SH_SET_LOCAL_MANIFEST: '',
      SH_ALPHA_LOCAL_MANIFEST: '',
      SH_SEPOLIA_INDEXER_ORIGIN: '',
      SH_ARWEAVE_PICTURES: '',
      SH_FIT_MARKET: 'none',
    },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
  ],
});
