/**
 * SH-008 scene checks against a production build of the dev-only lab (never the app's ports).
 *   cd apps/web && E2E_PORT=5412 pnpm exec playwright test -c src/features/scene/e2e/playwright.config.ts
 * Projects:
 *   gpu       new headless Chromium (uses the GPU when present) — live scene, laziness, render-loop stop
 *   software  headless shell on SwiftShader — proves the GPU-free fallback keeps the poster
 * Without a GPU (CI), set SCENE_E2E_ALLOW_SOFTWARE=1 so the gpu project exercises the pipeline anyway.
 */
import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.E2E_PORT ?? 5412);
const webRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const labConfig = 'src/features/scene/scene.vite.config.ts';

export default defineConfig({
  testDir: '.',
  outputDir: '../dist/e2e-artifacts',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}/src/features/scene/`, trace: 'retain-on-failure' },
  webServer: {
    command: `pnpm exec vite build --config ${labConfig} && pnpm exec vite preview --config ${labConfig} --host 127.0.0.1 --port ${PORT} --strictPort`,
    cwd: webRoot,
    url: `http://127.0.0.1:${PORT}/src/features/scene/lab.html`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'gpu',
      grepInvert: /@software/,
      use: { ...devices['Desktop Chrome'], channel: 'chromium', viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'software',
      grep: /@software/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
});
