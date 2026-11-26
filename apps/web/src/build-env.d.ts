/**
 * Build-time values (vite.config.ts `define`; src/build-mode.ts). Vite's client types declare `import.meta.env`; the
 * packages whose tests load the site's modules (packages/chain, through deployments.d.ts) do not have them, so `env`
 * is declared here as well (the same declaration merges with Vite's).
 */
interface ImportMetaEnv {
  /** `SH_BUILD=production`: the site with no Demo and no local chain (the literal `true`). Missing everywhere else. */
  readonly SH_PRODUCTION?: boolean;
  /**
   * `SH_BUILD=production SH_TARGET=sepolia` (SH-TA-02, build-target.ts): the Sepolia test site, whose legal pages show
   * the test network notice (the literal `true`; `false` in every other build). Missing in the dev server and vitest.
   */
  readonly SH_TEST_NETWORK?: boolean;
  /**
   * F156 (build-target.ts `sepoliaTradeOf`): the Sepolia alpha's trade code is on: the literal `true` in the Sepolia
   * production build and in a development build or dev server opted in with `SH_SEPOLIA_TRADE=1`; `false` in every
   * other build, the mainnet one included. Missing in the dev server without the opt-in and in vitest. Read it as
   * `import.meta.env?.SH_SEPOLIA_TRADE === true`, in the module itself, so the build folds the branch.
   */
  readonly SH_SEPOLIA_TRADE?: boolean;
  /** SH-258 round 3: `true` in a BNB Chain testnet build (build-target.ts `buildDefines`); missing in every other build. */
  readonly SH_BNB?: boolean;
  /**
   * F161 (4), SH-ALPHA-SITE (build-target.ts `alphaStandinOf`): the browser suites' stand-in for Privy is in this build:
   * the literal `true` only in a development build or dev server opted in with `SH_ALPHA_STANDIN=1` (and the trade
   * opt-in); `false` in every other build, production ones included. Missing in vitest. Read it as
   * `import.meta.env?.SH_ALPHA_STANDIN === true`, in the module itself.
   */
  readonly SH_ALPHA_STANDIN?: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
