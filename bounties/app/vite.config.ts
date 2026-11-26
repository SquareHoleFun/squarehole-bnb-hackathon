import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { bridgeSources, privyBridge } from './build/privy-bridge';
import { PRIVY_CHANGES } from './build/privy-fixes';
import { thirdPartyNotices } from './build/third-party-notices';

// React through the bundler's own automatic JSX runtime: no Vite plugin needed for this small app.
// The deployment file is read at run time from `addresses.json` beside index.html, so one static build serves any
// deployment. PILE_BASE: the one setting for serving under a sub-path (the site: `/launches/`); the default './' works
// from any folder. The page contacts its own files and the read endpoints named in addresses.json, nothing else, and
// the built index.html has no inline script.

/**
 * Development server only (never in a build): a stand-in for the site's creation signer at `api/four/sign-create`,
 * for the browser tests on a local fork. PILE_SIGN_STANDIN names a CommonJS module exporting `sign(body)`.
 */
function signStandIn(): Plugin {
  return {
    name: 'pile-sign-standin',
    apply: 'serve',
    configureServer(server) {
      const modulePath = process.env.PILE_SIGN_STANDIN;
      if (!modulePath) return;
      const handler = createRequire(import.meta.url)(modulePath) as { sign(body: unknown): Promise<unknown> };
      server.middlewares.use('/api/four/sign-create', (req, res) => {
        let raw = '';
        req.on('data', (c: Buffer) => (raw += c.toString()));
        req.on('end', () => {
          void (async () => {
            try {
              const answer = await handler.sign(JSON.parse(raw));
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify(answer));
            } catch (e) {
              const err = e as { code?: string; message?: string };
              res.statusCode = err.code ? 400 : 500;
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify(err.code ? { error: err.code, message: err.message } : { error: 'INTERNAL' }));
            }
          })();
        });
      });
    },
  };
}

/**
 * SH-280: the site's Privy app id, by the platform's own route: its committed constant
 * (apps/web/src/features/alpha-sepolia/privy-config.ts `BNB_PRIVY_APP_ID`), read from that file at build time, never a
 * copy typed here. The web image's launch stage copies that one file beside this app (hackathon/stack/app.Dockerfile).
 * Without the file the page builds without Privy (the sign-in link and the browser wallet stay).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
export const PLATFORM_PRIVY_CONFIG = resolve(HERE, '../../apps/web/src/features/alpha-sepolia/privy-config.ts');
export function platformPrivyAppId(path = PLATFORM_PRIVY_CONFIG): string | null {
  if (!existsSync(path)) return null;
  const found = /export const BNB_PRIVY_APP_ID = '([a-z0-9]{20,40})';/.exec(readFileSync(path, 'utf8'));
  return found?.[1] ?? null;
}

/** The browser tests' Privy stand-in: the development server only; a build refuses the setting. */
function privyStandin(command: 'build' | 'serve'): boolean {
  const value = process.env.PILE_PRIVY_STANDIN ?? '';
  if (value !== '' && value !== '1') throw new Error('PILE_PRIVY_STANDIN must be unset or "1"');
  if (value === '1' && command === 'build') throw new Error('a build never takes the Privy stand-in: unset PILE_PRIVY_STANDIN');
  return value === '1';
}

/**
 * SH-303: the local stands' poll (their checks wait for the page's re-read after a step on the local chain). The page
 * re-reads every 30 s; a stand sets PILE_POLL_MS (1000 to 30000) for its development server; a build refuses it.
 */
function pollMs(command: 'build' | 'serve'): number | null {
  const value = process.env.PILE_POLL_MS ?? '';
  if (value === '') return null;
  if (command === 'build') throw new Error('a build never takes PILE_POLL_MS: unset it');
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1000 || n > 30000) throw new Error('PILE_POLL_MS must be a whole number of ms from 1000 to 30000');
  return n;
}

export default defineConfig(({ command }) => ({
  base: process.env.PILE_BASE ?? './',
  oxc: { jsx: { runtime: 'automatic', importSource: 'react' } },
  // SH-280: Privy's SDK in a build of its own (build/privy-bridge.ts), as the platform builds it (build/privy-trims.ts and
  // privy-fixes.ts are the platform's files, byte for byte: made-wallet.test.ts compares them).
  // SH-280: a notices file for every package the output ships (the page's and the bridge's), at the output root, with
  // the platform's build/third-party-notices.ts (byte for byte) and the change privy-fixes.ts makes to Privy's SDK.
  plugins: [signStandIn(), privyBridge(), thirdPartyNotices(undefined, { include: () => bridgeSources, changes: PRIVY_CHANGES })],
  define: {
    'import.meta.env.PILE_PRIVY_APP_ID': JSON.stringify(platformPrivyAppId() ?? ''),
    'import.meta.env.PILE_PRIVY_STANDIN': JSON.stringify(privyStandin(command)),
    'import.meta.env.PILE_POLL_MS': JSON.stringify(pollMs(command)),
  },
  server: { host: '127.0.0.1', port: 5471, strictPort: true, fs: { allow: ['..'] } },
  preview: { host: '127.0.0.1', port: 5471, strictPort: true },
  // Every asset (the logo, the fonts) is its own file: no data: address, so a strict content security policy holds.
  build: {
    outDir: 'dist',
    target: 'es2022',
    assetsInlineLimit: 0,
  },
}));

