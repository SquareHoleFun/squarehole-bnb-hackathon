/**
 * Vite config for the dev-only scene lab (SH-008). Not used by the app build.
 *   dev:     pnpm exec vite --config src/features/scene/scene.vite.config.ts            (DEV_PORT, default 5411)
 *   build:   pnpm exec vite build --config src/features/scene/scene.vite.config.ts      (→ src/features/scene/dist/lab)
 *   preview: pnpm exec vite preview --config src/features/scene/scene.vite.config.ts    (E2E_PORT, default 5412)
 * The build splits React, the eager accent code and the lazy three.js chunk so each can be measured.
 */
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const sceneDir = fileURLToPath(new URL('.', import.meta.url));
const webRoot = fileURLToPath(new URL('../../..', import.meta.url));

export default defineConfig({
  root: webRoot,
  base: './',
  plugins: [react()],
  build: {
    outDir: `${sceneDir}dist/lab`,
    emptyOutDir: true,
    target: 'es2022',
    reportCompressedSize: true,
    // The lazy three.js chunk is ~570 kB raw / ~145 kB gzip by design (budget: 1.5 MB compressed).
    chunkSizeWarningLimit: 600,
    rolldownOptions: {
      input: `${sceneDir}lab.html`,
      output: {
        codeSplitting: {
          groups: [
            { name: 'react-vendor', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            // The accent's eager footprint: everything the feed pays for before the lazy chunk.
            { name: 'scene-accent', test: /features[\\/]scene[\\/](index|ShapeSorterAccent|controller|gate|deps|variants)\.(ts|tsx|css)/ },
          ],
        },
      },
    },
  },
  server: { host: '127.0.0.1', port: Number(process.env.DEV_PORT ?? 5411), strictPort: true },
  preview: { host: '127.0.0.1', port: Number(process.env.E2E_PORT ?? 5412), strictPort: true },
});
