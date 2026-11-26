import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { privyFixes } from '../../../build/privy-fixes';
import { privyTrims } from '../../../build/privy-trims';

/**
 * F161 (4), SH-ALPHA-SITE: the Privy probe's build (probe.tsx): the join page's own plugins (build/alpha-pages.ts:
 * Privy's turned-off features trimmed, its provider's cookie fix, React) and the literals of a Sepolia trade build
 * without the stand-in, so the join page's door opens privy-live.tsx. Served by the alpha-access suite's edge at
 * /__probe/.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/__probe/',
  publicDir: false,
  logLevel: 'warn',
  plugins: [privyTrims(), privyFixes(), react()],
  define: {
    'import.meta.env.SH_PRODUCTION': 'false',
    'import.meta.env.SH_TEST_NETWORK': 'false',
    'import.meta.env.SH_SEPOLIA_TRADE': 'true',
    'import.meta.env.SH_ALPHA_STANDIN': 'false',
  },
  build: {
    outDir: fileURLToPath(new URL('../../../.cache/alpha-access/probe', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
  },
});
