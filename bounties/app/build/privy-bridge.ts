import { resolve } from 'node:path';
import { build, type Plugin, type ResolvedConfig, type Rolldown } from 'vite';
import { PRIVY_CHANGES, privyFixes } from './privy-fixes';
import { privyTrims } from './privy-trims';
import { thirdPartyNotices } from './third-party-notices';

/**
 * SH-280: the made wallet's bridge (src/lib/privy-made.tsx with Privy's SDK) as a build of its own, in the page's output
 * under `assets/privy/`, sharing no file with the page: a visitor without the site's sign-in loads exactly the files
 * the page loaded before the SDK came (one chunk of the page's own code and libraries, not those cut into pieces), and
 * a signed-in visitor loads the bridge, which brings its own copy of what it needs. The page asks for it by the address
 * this plugin hands it (`virtual:privy-bridge`), relative to the page. The bridge's build takes Privy's SDK as the
 * platform builds it (privy-trims.ts, privy-fixes.ts). The development server serves the source itself.
 */
export const BRIDGE_ID = 'virtual:privy-bridge';
const RESOLVED = `\0${BRIDGE_ID}`;
export const BRIDGE_DIR = 'assets/privy';
/**
 * The packages the platform's trims keep out of every build (privy-trims.ts: WalletConnect's under a proprietary
 * licence, with Reown's AppKit it brings; Solana's program clients without licence text). A bridge whose bundler
 * module list names any module of theirs stops the build, as the platform's `check:production` judges by that list.
 */
export const TRIMMED_PACKAGES = /[\\/]node_modules[\\/](@walletconnect|@reown|@solana-program)[\\/]/;
/** What the last build of the bridge held, for its report and the tests. */
export const bridgeReport = { modules: 0, trimmed: [] as string[] };

type Built = { readonly fileName: string; readonly source: string | Uint8Array };

/**
 * SH-280: the bridge's notices inventory's source files go here, for the page's own notices file (vite.config.ts), as
 * the platform's join page hands its sources to the app's file (apps/web/build/alpha-pages.ts). The bridge also keeps
 * its own copy at `assets/privy/third-party-notices.txt`.
 */
export const bridgeSources = new Set<string>();

export function privyBridge(): Plugin {
  let config: ResolvedConfig;
  let entry = '';
  let files: Built[] = [];
  return {
    name: 'pile-privy-bridge',
    configResolved(resolved) {
      config = resolved;
    },
    resolveId: (id) => (id === BRIDGE_ID ? RESOLVED : null),
    load(id) {
      if (id !== RESOLVED) return null;
      // Development: the module itself, from the server. A build: the bridge's entry file, relative to the page.
      return `export default ${JSON.stringify(config.command === 'serve' ? '/src/lib/privy-made.tsx' : entry)};`;
    },
    async buildStart() {
      if (config.command !== 'build') return;
      files = [];
      bridgeSources.clear();
      const result = await build({
        configFile: false,
        root: config.root,
        base: config.base,
        mode: config.mode,
        logLevel: 'warn',
        publicDir: false,
        define: { ...config.define },
        oxc: { jsx: { runtime: 'automatic', importSource: 'react' } },
        plugins: [privyTrims(), privyFixes(), thirdPartyNotices(undefined, { fileName: `${BRIDGE_DIR}/third-party-notices.txt`, changes: PRIVY_CHANGES, report: (found) => { for (const file of found) bridgeSources.add(file); } })],
        build: {
          write: false,
          outDir: config.build.outDir,
          emptyOutDir: false,
          copyPublicDir: false,
          target: config.build.target,
          minify: config.build.minify,
          assetsInlineLimit: 0,
          reportCompressedSize: false,
          chunkSizeWarningLimit: 4000,
          rolldownOptions: {
            input: { bridge: resolve(config.root, 'src/lib/privy-made.tsx') },
            preserveEntrySignatures: 'exports-only',
            output: {
              format: 'es',
              entryFileNames: `${BRIDGE_DIR}/[name]-[hash].js`,
              chunkFileNames: `${BRIDGE_DIR}/[name]-[hash].js`,
              assetFileNames: `${BRIDGE_DIR}/[name]-[hash][extname]`,
            },
          },
        },
      });
      const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[];
      const modules = new Set<string>();
      for (const item of outputs.flatMap((output) => output.output)) {
        if (!item.fileName.startsWith(`${BRIDGE_DIR}/`)) throw new Error(`the Privy bridge wrote ${item.fileName}, outside ${BRIDGE_DIR}/`);
        if (item.type === 'chunk') {
          for (const id of item.moduleIds) modules.add(id);
          files.push({ fileName: item.fileName, source: item.code });
          if (item.isEntry) entry = item.fileName;
        } else {
          files.push({ fileName: item.fileName, source: item.source });
        }
      }
      if (!entry) throw new Error('the Privy bridge build made no entry');
      const trimmed = [...modules].filter((id) => TRIMMED_PACKAGES.test(id));
      bridgeReport.modules = modules.size;
      bridgeReport.trimmed = trimmed;
      if (trimmed.length) throw new Error(`the Privy bridge holds modules the platform's trims keep out (privy-trims.ts): ${trimmed.slice(0, 5).join(', ')}`);
      this.info?.(`Privy bridge: ${modules.size} modules, none of @walletconnect, @reown or @solana-program`);
    },
    generateBundle() {
      for (const file of files) this.emitFile({ type: 'asset', fileName: file.fileName, source: file.source });
    },
  };
}
