import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { buildModeOf, squareHoleDeployments, squareHoleProductionHead } from './deployments-plugin';
import { devServerWatch } from './dev-server-watch';
import { alphaDeskOf, alphaGateOf, alphaStandinOf, buildDefines, buildTargetOf, productionSideEffects, sepoliaTradeOf, testnetOf } from './build-target';
import { squareHolePlaceholderGuard } from './placeholder-guard';
import { thirdPartyNotices } from './build/third-party-notices';
import { alphaPages } from './build/alpha-pages';
import { testnetOutput } from './build/testnet-output';
import { bnbVariants } from './build/bnb-variants';
import { testnetProfileOfEnv } from './deployments-plugin';
import { privyTrims } from './build/privy-trims';
import { PRIVY_CHANGES, privyFixes } from './build/privy-fixes';
import { shAsyncUtilTimeout, shTestTimeouts } from '../../vitest.timeouts.mjs';

// `virtual:squarehole-deployments`: the deployment manifests and market records a build embeds (deployments-plugin.ts).
// A plain `vite build` embeds no local manifest and no market record; the dev server embeds the committed ones.
//
// `SH_BUILD=production` (SH-V2-FE6, `pnpm build:production`): the site with no Demo and no local chain. The Demo code
// folds away (`import.meta.env.SH_PRODUCTION`, src/build-mode.ts); the app's and the packages' sources count as free of
// side effects, so a Demo module nobody reads is dropped whole. `Object.freeze` is not marked pure (that would drop
// every `Object.freeze(value);` statement, deepFreeze's included): a Demo fixture that must go is a `/* @__PURE__ */`
// call. No source maps: they would ship every source file, Demo comments and all (`pnpm check:production` builds the
// same site with `--sourcemap hidden` to name the file behind a finding).
//
// The production build also refuses to finish while the legal drafts hold an open `[COUNSEL|FOUNDER|ENGINEERING …]`
// item (SH-V2-FE7, placeholder-guard.ts); `SH_ALLOW_PLACEHOLDERS=1` is for builds that are never uploaded.
//
// `SH_TARGET=sepolia` (SH-TA-02, build-target.ts): the production build for the Sepolia test site, whose legal pages
// show the test network notice instead of those drafts. Unset or `mainnet`: the main site, as above.
//
// F156 (SH-ALPHA-BUILD-SWITCH, build-target.ts `sepoliaTradeOf`): `import.meta.env.SH_SEPOLIA_TRADE`, the Sepolia alpha's
// trade code, is on in the Sepolia production build only, or where `SH_SEPOLIA_TRADE=1` opts a development build or
// the dev server in; a production build refuses that opt-in, so the mainnet build never carries the trade code.
//
// F161 (4), SH-ALPHA-SITE (build/alpha-pages.ts): where the trade literal is on, one `vite build` also makes the alpha's
// public join page (`join/index.html`, its files under `join/assets/`) and the founder's desk (`desk/index.html`,
// `desk/assets/`), each a build of its own that needs no file of the private app. `SH_ALPHA_STANDIN=1` (development
// builds with the trade opt-in only; build-target.ts `alphaStandinOf`) puts the browser suites' Privy stand-in in place
// of Privy's SDK.
//
// vitest ignores SH_BUILD and SH_TARGET (the unit tests always run the development modules, whatever the shell exports),
// and SH_ARWEAVE_PICTURES (SH-ARWEAVE-PICTURES-WEB fix round 2: an opt-in exported for the dev server or the live test
// never turns Arweave on in the unit tests; deployments-plugin.ts `arweavePictures` refuses it under Vitest as well),
// and SH_SEPOLIA_TRADE and SH_ALPHA_STANDIN the same way.
export const buildEnvOf = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => (env.VITEST ? { ...env, SH_BUILD: '', SH_TARGET: '', SH_ARWEAVE_PICTURES: '', SH_SEPOLIA_TRADE: '', SH_ALPHA_STANDIN: '', SH_TESTNET: '' } : env);
const buildEnv = buildEnvOf(process.env);
const production = buildModeOf(buildEnv) === 'production';
// Checked once here, so a misspelt target or a trade or stand-in opt-in a production build refuses fails every command,
// the dev server's included.
buildTargetOf(buildEnv);
testnetOf(buildEnv);
const tradeBuild = sepoliaTradeOf(buildEnv);
// SH-258: the alpha's join and desk pages only where the test network has the alpha (Sepolia); the trade code, and
// with it the Privy trims and fixes for any Privy code it carries, follows `SH_SEPOLIA_TRADE` whatever the network.
const alphaBuild = alphaGateOf(buildEnv);
// SH-275: the desk page only for a closed alpha (Sepolia); the open-site alpha (BNB Chain testnet) has the join page.
const deskBuild = alphaDeskOf(buildEnv);
alphaStandinOf(buildEnv);
// The join and desk pages' notices sources (build/alpha-pages.ts), for the app's own notices file at the output root.
const alphaSources = new Set<string>();

export default defineConfig(({ command }) => ({
  plugins: [
    // F161 (4): the Privy features the alpha turns off stay out of the bundle (build/privy-trims.ts), and Privy's
    // provider honours the alpha's no-cookie setting (build/privy-fixes.ts).
    ...(tradeBuild ? [privyTrims(), privyFixes()] : []),
    // SH-258 round 3: a BNB Chain testnet build takes the `.bnb` variants of box 0's modules (build/bnb-variants.ts).
    bnbVariants(testnetProfileOfEnv(buildEnv)),
    react(),
    squareHoleDeployments(buildEnv),
    squareHoleProductionHead(buildEnv),
    squareHolePlaceholderGuard(buildEnv, production),
    ...(alphaBuild && command === 'build' ? [alphaPages({ define: buildDefines(buildEnv, 'build'), production, sources: alphaSources, desk: deskBuild })] : []),
    // SH-258: a build for another test network writes its own security policy and leaves box 0's files out.
    testnetOutput(testnetProfileOfEnv(buildEnv), buildEnv),
    ...(production ? [thirdPartyNotices(undefined, tradeBuild ? { include: () => alphaSources, changes: PRIVY_CHANGES } : {})] : []),
  ],
  // src/build-mode.ts: literals the branches fold on before tree-shaking (build-target.ts `buildDefines`).
  define: buildDefines(buildEnv, command),
  // Root-absolute base for BrowserRouter deep links (ADR-0007). A portable hash-routed build for gateways and
  // on-chain hosting (C16) is SH-025 work.
  base: '/',
  build: {
    target: 'es2022',
    sourcemap: !production,
    // The lazy three.js chunk (~145 kB gzip) is optional decoration loaded after first paint (SH-008).
    chunkSizeWarningLimit: 600,
    ...(production
      ? { rolldownOptions: { treeshake: { moduleSideEffects: productionSideEffects }, output: { strictExecutionOrder: true } } }
      : {}),
  },
  // SH-RC7 item 30: `SH_DEV_SERVER_WATCH=off` (the core v2 chain suite and the examples) watches no file (dev-server-watch.ts).
  server: { port: Number(process.env.DEV_PORT ?? 5391), strictPort: true, ...devServerWatch(process.env) },
  preview: { port: Number(process.env.E2E_PORT ?? 5392), strictPort: true },
  test: {
    ...shTestTimeouts(),
    // SH_TEST_TIMEOUT also lengthens Testing Library's waits (vitest.timeouts.mjs); unset, no setup file at all.
    ...(shAsyncUtilTimeout() === undefined ? {} : { setupFiles: ['./src/test-support/async-util-timeout.setup.ts'] }),
    name: 'web',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    // SH-258: the unit tests run the default test network (Sepolia) whatever the shell exports; a test that needs
    // BNB Chain testnet stubs SH_TESTNET itself.
    env: { SH_TESTNET: '' },
  },
}));
