import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { build, type Plugin, type ResolvedConfig, type Rolldown } from 'vite';
import { productionSideEffects } from '../build-target';
import { PRIVY_CHANGES, privyFixes } from './privy-fixes';
import { privyTrims } from './privy-trims';
import { thirdPartyNotices } from './third-party-notices';

/**
 * F161 (4), SH-ALPHA-SITE (SH-ALPHA-API integrator request 1): the Sepolia alpha's two pages besides the app, each its
 * own Vite build with its own complete asset graph, so neither ever needs a file of the private app:
 * - `join/index.html` with everything it loads under `join/assets/`: public, even to strangers (Caddy's alpha_access
 *   route serves only these files without the page lock; infra/server/Caddyfile, docs/runbooks/alpha-access.md);
 * - `desk/index.html` under `desk/assets/`: behind Cloudflare Access, for the founder.
 * One `vite build` (the release's command, infra/server/app/build.mjs) makes all three: this plugin builds the two pages
 * in memory when the app's build starts and adds their files to the app's output, so Vite writes one folder after
 * emptying it once. Each page's build has only what it needs (React, its own notices inventory), the app's build-time
 * literals and, in production, the app's tree-shaking. Their source files join the app's notices file at the output
 * root (G07), and each page also carries its own copy at `<page>/assets/third-party-notices.txt`, which the public join
 * page can link to.
 *
 * Only where the trade literal is on (vite.config.ts): the Sepolia production build, and a development build opted in
 * with `SH_SEPOLIA_TRADE=1`. A mainnet build never has either page (`pnpm check:production` refuses one).
 *
 * `pnpm check:production` builds through Vite's own `build()` and reads the bundler's module list of each chunk; these
 * pages' chunks are not in the app's result, so each build hands its chunks to the registry the check sets up for its
 * build (`ALPHA_PAGES_REGISTRY`, a global symbol). Without the registry (the plain command line) nothing is recorded.
 */
export const ALPHA_PAGES: readonly { readonly name: 'join' | 'desk'; readonly html: string; readonly assets: string }[] = Object.freeze([
  { name: 'join', html: 'join/index.html', assets: 'join/assets' },
  { name: 'desk', html: 'desk/index.html', assets: 'desk/assets' },
]);

/** Where `pnpm check:production`'s builder collects these pages' chunks: `{ chunks: { fileName, moduleIds }[] }`. */
export const ALPHA_PAGES_REGISTRY = Symbol.for('squarehole.alpha-pages');

interface Registry { chunks: { fileName: string; moduleIds: string[] }[] }
const registry = (): Registry | null => {
  const value = (globalThis as Record<symbol, unknown>)[ALPHA_PAGES_REGISTRY];
  return typeof value === 'object' && value !== null && Array.isArray((value as Registry).chunks) ? value as Registry : null;
};

export interface AlphaPagesOptions {
  /** The app's build-time literals (build-target.ts `buildDefines`), the same in each page. */
  readonly define: Readonly<Record<string, string>>;
  readonly production: boolean;
  /** The notices inventory's source files from the pages' builds go here (the app's notices file reads them). */
  readonly sources: Set<string>;
  /**
   * SH-275: whether the desk page is built (build-target.ts `alphaDeskOf`): a closed alpha's (Sepolia) yes; an open-site
   * alpha (BNB Chain testnet) has no desk, so its build makes the join page only. Unset: yes, as before.
   */
  readonly desk?: boolean;
}

type Built = { readonly fileName: string; readonly source: string | Uint8Array };

export function alphaPages(options: AlphaPagesOptions): Plugin {
  let config: ResolvedConfig;
  let files: Built[] = [];
  return {
    name: 'squarehole-alpha-pages',
    apply: 'build',
    configResolved(resolved) {
      config = resolved;
    },
    async buildStart() {
      files = [];
      options.sources.clear();
      for (const page of ALPHA_PAGES.filter((one) => one.name !== 'desk' || options.desk !== false)) {
        const result = await build({
          configFile: false,
          root: config.root,
          base: config.base,
          mode: config.mode,
          logLevel: 'warn',
          publicDir: false,
          define: { ...options.define },
          // The notices inventory runs where the app's does: in production builds (vite.config.ts).
          plugins: [privyTrims(), privyFixes(), react(), ...(options.production ? [thirdPartyNotices(undefined, { fileName: `${page.assets}/third-party-notices.txt`, changes: PRIVY_CHANGES, report: (found) => { for (const file of found) options.sources.add(file); } })] : [])],
          build: {
            write: false,
            outDir: config.build.outDir,
            assetsDir: page.assets,
            emptyOutDir: false,
            copyPublicDir: false,
            sourcemap: config.build.sourcemap,
            minify: config.build.minify,
            target: config.build.target,
            reportCompressedSize: false,
            chunkSizeWarningLimit: config.build.chunkSizeWarningLimit,
            rolldownOptions: {
              input: { [page.name]: resolve(config.root, page.html) },
              ...(options.production ? { treeshake: { moduleSideEffects: productionSideEffects }, output: { strictExecutionOrder: true } } : {}),
            },
          },
        });
        const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[];
        for (const item of outputs.flatMap((output) => output.output)) {
          if (!item.fileName.startsWith(`${page.assets}/`) && item.fileName !== page.html) throw new Error(`The ${page.name} page wrote ${item.fileName}, outside ${page.assets}/`);
          if (item.type === 'chunk') {
            files.push({ fileName: item.fileName, source: item.code });
            registry()?.chunks.push({ fileName: item.fileName, moduleIds: [...item.moduleIds] });
          } else {
            files.push({ fileName: item.fileName, source: item.source });
          }
        }
        if (!files.some((file) => file.fileName === page.html)) throw new Error(`The ${page.name} page's build made no ${page.html}`);
      }
    },
    generateBundle() {
      for (const file of files) this.emitFile({ type: 'asset', fileName: file.fileName, source: file.source });
    },
  };
}
