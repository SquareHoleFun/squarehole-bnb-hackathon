/**
 * Regenerates the committed posters from the real scene (SH-008).
 *
 *   cd apps/web && DEV_PORT=5411 node src/features/scene/tools/render-posters.ts
 *
 * Starts the scene lab's Vite dev server, opens poster.html?variant=… in headless Chromium,
 * captures the settled frame at 2x with transparent background as WebP, and writes
 * poster/shape-sorter-{pin,wizard}.webp. Deterministic: seeded wood grain, rest pose, fixed camera fit.
 */
import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const VARIANTS = ['pin', 'wizard'] as const;
const sceneDir = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.DEV_PORT ?? 5411);

type PosterResult = { dataUrl: string; width: number; height: number; renderer: string } | { error: string };

const server = await createServer({
  configFile: `${sceneDir}scene.vite.config.ts`,
  server: { host: '127.0.0.1', port, strictPort: true },
  logLevel: 'warn',
});
await server.listen();
// `channel: 'chromium'` = new headless mode, which uses the GPU when one is available.
const browser = await chromium.launch({ channel: 'chromium' });
try {
  for (const variant of VARIANTS) {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/src/features/scene/poster.html?variant=${variant}`);
    const handle = await page.waitForFunction(() => (window as Window & { __poster?: PosterResult }).__poster, null, {
      timeout: 60_000,
    });
    const result = (await handle.jsonValue()) as PosterResult;
    if ('error' in result) throw new Error(`Poster ${variant} failed: ${result.error}`);
    const [, base64 = ''] = result.dataUrl.split(',');
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.subarray(8, 12).toString('ascii') !== 'WEBP') throw new Error(`Poster ${variant} is not WebP`);
    const file = `${sceneDir}poster/shape-sorter-${variant}.webp`;
    await writeFile(file, bytes);
    process.stdout.write(`${variant}: ${result.width}x${result.height} ${bytes.length} bytes → ${file}\n`);
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
