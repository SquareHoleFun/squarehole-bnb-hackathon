import { buildModeOf } from './deployments-plugin';
import { TESTNET_PROFILES, testnetNameOf, type TestnetName, type TestnetProfile } from '../../packages/chain/src/config/testnet-profile';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The build target (SH-TA-02; founder 2026-10-23: a short test network notice on the public Sepolia test site instead of
 * the draft production Terms; mainnet stays blocked until counsel fills the blanks). `SH_TARGET`, read at build time
 * beside `SH_BUILD`:
 * - unset, empty or `mainnet`: the main site. The production Terms and privacy notice ship, and the production build
 *   refuses to finish while they hold an open `[COUNSEL|FOUNDER|ENGINEERING …]` item (placeholder-guard.ts), as before.
 * - `sepolia`, with `SH_BUILD=production` only: the Sepolia test site (infra/server/app, the test host). The Terms and
 *   privacy pages show the test network notice (src/features/legal/test-network.ts) and every legal link points to it.
 *   The draft production texts are not in the bundle, so the placeholder guard, unchanged, finds nothing to refuse.
 * Any other value fails the build. The target is the only switch: no other variable, no `.env` file and no bypass picks
 * the legal text. Vite hands only `VITE_` variables to `import.meta.env`; `import.meta.env.SH_TEST_NETWORK` is this
 * module's `define`, computed from `SH_BUILD` and `SH_TARGET` alone. `SH_ALLOW_PLACEHOLDERS=1` still only lets a build
 * that is never uploaded finish: it never shows the notice.
 */
export type BuildTarget = 'mainnet' | 'sepolia';

export function buildTargetOf(env: Env): BuildTarget {
  const value = env.SH_TARGET;
  if (value === undefined || value === '' || value === 'mainnet') return 'mainnet';
  if (value === 'sepolia') {
    if (buildModeOf(env) !== 'production') throw new Error('SH_TARGET=sepolia is a production target: set SH_BUILD=production as well');
    return 'sepolia';
  }
  throw new Error(`SH_TARGET must be unset, "mainnet" or "sepolia" (got "${value}")`);
}

/**
 * SH-258: the build's test network (`SH_TESTNET`, packages/chain/src/config/testnet-profile.ts): unset, empty or
 * `sepolia` is Sepolia; `bnb` is BNB Chain testnet (97), which then fills the test-network slot everywhere (the data
 * source named `sepolia`, the test site's target `SH_TARGET=sepolia`, its trade box and test-coin page). A production
 * build of BNB Chain testnet is the test site only: with `SH_BUILD=production` it needs `SH_TARGET=sepolia`. Any other
 * value fails the build. The web build hands the name to the chain package as the define `__SH_TESTNET__`.
 */
export function testnetOf(env: Env): TestnetName {
  const name = testnetNameOf(env.SH_TESTNET);
  if (name !== 'sepolia' && buildModeOf(env) === 'production' && buildTargetOf(env) !== 'sepolia') {
    throw new Error(`SH_TESTNET=${name} is a test network: a production build of it needs SH_TARGET=sepolia (the test site)`);
  }
  return name;
}

export const testnetProfileOf = (env: Env): TestnetProfile => TESTNET_PROFILES[testnetOf(env)];

/**
 * The alpha's sign-in, invite and Privy (the join page, the welcome step): where the trade code is on and the test
 * network has them (`switches.alphaGate`: Sepolia, and BNB Chain testnet since SH-275).
 */
export const alphaGateOf = (env: Env): boolean => sepoliaTradeOf(env) && testnetProfileOf(env).switches.alphaGate;

/**
 * SH-275: the founder's desk page (`desk/index.html`) exists only for a closed alpha (Sepolia). An open-site alpha
 * (`switches.alphaOpen`, BNB Chain testnet) approves a first sign-in at once and has no desk: its build makes the join
 * page only.
 */
export const alphaDeskOf = (env: Env): boolean => alphaGateOf(env) && !testnetProfileOf(env).switches.alphaOpen;

/** Which legal text a build ships: the full drafts (development and mainnet), or the Sepolia test network notice. */
export type LegalMode = 'full' | 'test-network';

export function legalModeOf(env: Env): LegalMode {
  return buildModeOf(env) === 'production' && buildTargetOf(env) === 'sepolia' ? 'test-network' : 'full';
}

/**
 * The Sepolia alpha's trade switch (F156, SH-ALPHA-BUILD-SWITCH; docs/design/sepolia-alpha-v1.md "Build switch"): the
 * box page's buy/sell box and the test-coin page exist in Sepolia builds only. `import.meta.env.SH_SEPOLIA_TRADE`:
 * - a production build: `true` exactly for the Sepolia test site (`SH_BUILD=production SH_TARGET=sepolia`), `false` for
 *   the main site, from the target alone. A production build refuses the opt-in below (never ignores it), so no
 *   variable a shell exports moves trade code into a mainnet build, and the Sepolia build never needs one.
 * - development (`vite`, a plain `vite build`, the browser suites' builds): `false`, unless `SH_SEPOLIA_TRADE=1` opts in,
 *   to run the trade code against a local or recorded chain. Any other value fails, as a misspelt target does.
 * - vitest: never on (vite.config.ts clears the opt-in there, as it clears `SH_BUILD` and `SH_TARGET`).
 * The trade code sits in its own folders (`trade-sepolia`) and loads lazily behind this literal
 * (src/features/core/v2/TradeSlotMount.tsx): in a mainnet build the import folds away with the branch, and
 * `pnpm check:production` fails on any trade marker left (production-check.ts, the `trade` rule).
 */
export function sepoliaTradeOf(env: Env): boolean {
  const value = env.SH_SEPOLIA_TRADE ?? '';
  if (value !== '' && value !== '1') throw new Error(`SH_SEPOLIA_TRADE must be unset or "1" (got "${value}")`);
  if (buildModeOf(env) === 'production') {
    if (value === '1') throw new Error('SH_BUILD=production takes the trade switch from SH_TARGET alone: unset SH_SEPOLIA_TRADE');
    return buildTargetOf(env) === 'sepolia';
  }
  return value === '1';
}

/**
 * F161 (4), SH-ALPHA-SITE: the browser suites' stand-in for Privy (features/trade-sepolia/test-support/privy-standin.ts;
 * Privy has no test X login, and no suite reaches Privy's service). `import.meta.env.SH_ALPHA_STANDIN` is `true` only in
 * a development build or the dev server opted in with `SH_ALPHA_STANDIN=1`, which needs the alpha's code on as well
 * (`SH_SEPOLIA_TRADE=1`); `false` in every other build. Every production build refuses the opt-in, as it refuses the
 * trade opt-in, so the stand-in never reaches a site that ships. Any other value fails.
 */
export function alphaStandinOf(env: Env): boolean {
  const value = env.SH_ALPHA_STANDIN ?? '';
  if (value !== '' && value !== '1') throw new Error(`SH_ALPHA_STANDIN must be unset or "1" (got "${value}")`);
  if (value === '') return false;
  if (buildModeOf(env) === 'production') throw new Error('SH_BUILD=production never takes the Privy stand-in: unset SH_ALPHA_STANDIN');
  if (!sepoliaTradeOf(env)) throw new Error('SH_ALPHA_STANDIN=1 is the alpha\'s stand-in: set SH_SEPOLIA_TRADE=1 as well');
  return true;
}

/**
 * The build-time literals (src/build-mode.ts, src/build-env.d.ts): `SH_PRODUCTION`, `SH_TEST_NETWORK`,
 * `SH_SEPOLIA_TRADE` and `SH_ALPHA_STANDIN`. A build defines all four either way, so the other mode's code leaves no
 * trace; the dev server and vitest define none (vitest would hand a defined `false` to the modules as the string
 * "false"), so there they are missing: the development site. One exception: the dev server opted in to the trade code
 * (`SH_SEPOLIA_TRADE=1`, which vitest never sees) gets `SH_SEPOLIA_TRADE` as `true`, and `SH_ALPHA_STANDIN` as `true`
 * when opted in to the stand-in as well.
 */
export function buildDefines(env: Env, command: 'build' | 'serve'): Record<string, string> {
  const production = buildModeOf(env) === 'production';
  const testNetwork = legalModeOf(env) === 'test-network';
  const trade = sepoliaTradeOf(env);
  const standin = alphaStandinOf(env);
  // SH-258: the test network's name for packages/chain (testnet-profile.ts reads `__SH_TESTNET__` first), defined only
  // when the shell names one; without it the chain package finds neither the define nor (in a browser) `process`, and
  // takes the default, Sepolia, so the default build's defines are exactly as before.
  const testnet = testnetOf(env);
  // Only another test network than Sepolia is defined: `SH_TESTNET=sepolia` gives the default build's defines exactly.
  const named = testnet !== 'sepolia';
  if (command !== 'build' && !production) {
    return {
      ...(trade ? { 'import.meta.env.SH_SEPOLIA_TRADE': 'true' } : {}),
      ...(standin ? { 'import.meta.env.SH_ALPHA_STANDIN': 'true' } : {}),
      ...(named ? { __SH_TESTNET__: JSON.stringify(testnet) } : {}),
      ...(testnet === 'bnb' ? { 'import.meta.env.SH_BNB': 'true' } : {}),
    };
  }
  return {
    ...(named ? { __SH_TESTNET__: JSON.stringify(testnet) } : {}),
    // SH-258 round 3: a BNB Chain testnet build folds box 0's branches away (`import.meta.env?.SH_BNB === true` at the
    // site; build/bnb-variants.ts for whole modules). Not defined in any other build: there it is missing (false).
    ...(testnet === 'bnb' ? { 'import.meta.env.SH_BNB': 'true' } : {}),
    'import.meta.env.SH_PRODUCTION': JSON.stringify(production),
    'import.meta.env.SH_TEST_NETWORK': JSON.stringify(testNetwork),
    'import.meta.env.SH_SEPOLIA_TRADE': JSON.stringify(trade),
    'import.meta.env.SH_ALPHA_STANDIN': JSON.stringify(standin),
  };
}

/** App and package sources: free of side effects in production, so a module whose exports nobody reads is dropped. */
const OWN_SOURCE = /[\\/](?:apps[\\/]web[\\/]src|packages[\\/][^\\/]+[\\/]src)[\\/].*\.(?:ts|tsx|json)$/;
const ENTRY = /[\\/]apps[\\/]web[\\/]src[\\/]main\.tsx$/;

/** The production build's `treeshake.moduleSideEffects` (vite.config.ts): false for the app's and packages' own sources. */
export const productionSideEffects = (id: string): false | undefined => (ENTRY.test(id) || !OWN_SOURCE.test(id) ? undefined : false);
