import { defineConfig } from '@playwright/test';

// One worker, port 5471. The local chain (anvil on 8581, seeded by scripts/seed-local.mjs) is started by the caller:
// see README "Tests". The page's dev server is started here.
export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:5471/', trace: 'off' },
  webServer: {
    command: 'npx vite --host 127.0.0.1 --port 5471 --strictPort',
    url: 'http://127.0.0.1:5471/',
    reuseExistingServer: false,
    // SH-303: on a local stand (PILE_RPC) the page re-reads every 8 s, so its checks see each step soon; never on the real chain
    env: process.env.PILE_RPC && !process.env.REAL_CHAIN ? { PILE_POLL_MS: '8000' } : {},
    timeout: 60_000,
  },
});
