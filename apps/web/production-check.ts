/**
 * `pnpm check:production` (SH-V2-FE6): build the production site (`SH_BUILD=production`, with the caller's other build
 * variables, as `pnpm build:production` takes them) and fail on any trace of the Demo or of a local chain in what would
 * be uploaded. Every shipped text file is scanned (scripts, styles, HTML, the public NFT metadata, the headers file).
 * The check's build adds hidden source maps (no reference in the files, so every shipped file is byte for byte the
 * shipped build's); they are only read to name the source line behind a finding, and the check moves them (each
 * chunk's own, nothing else) out of the scanned folder at once, into the build's run folder in the check's own root
 * (`HOME`, apps/web/.cache/production-check, a new run folder for every build), so the scanned folder is exactly what
 * would be uploaded. The check deletes nothing (fix round af3): old runs stay until someone clears the root by hand.
 * `--same-as <dir>` then compares a build about to be uploaded (`apps/web/dist`) with the scanned one, file by file,
 * every file of every kind, and fails on any difference.
 *
 * The build is Vite's own `build()` with the flags `vite build --sourcemap hidden --outDir <dir> --emptyOutDir` passes,
 * run in a child process with the build's environment (`BUILDER`): the same bytes as the command line, and the
 * bundler's module list besides (each chunk's modules), which the trade rule reads (`judgeModules`).
 *
 * What counts:
 * - `demo` / `mock`: the word in any casing, alone or as a part of a name (`Demo`, `DEMO_LISTINGS`, `isDemo`,
 *   `USDC-DEMO`), never inside another word ("demonstrate"). It fails in text: a string or template literal, a regular
 *   expression, HTML, JSON, a quoted CSS value: every word a visitor can meet and every piece of data. A name in code
 *   (a property key such as `isDemo` or `demoState`, a CSS class or custom property) is listed as a note: the shared
 *   record and token names keep their spelling, and no visitor sees them.
 * - `demo-address`: an invented address: the Demo's boxes, wallets and tokens start 0xde0… (0xde00…, 0xde02…,
 *   0xde07…), its FIT target and listings are the zero address with a short tail (0x000…f17e, 0x000…2ae0). A zero
 *   address with a tail of 0xff or less (a precompile, the 0x…01 placeholder owner of a draft) and the 0x…dead burn
 *   address are not invented.
 * - `local-rpc`: a loopback host (localhost, 127.0.0.1, 0.0.0.0, [::1]) or `anvil`, the local chains' words.
 * - `fixture-address`: an address found only in a test fixture (the recorded and invented deployment manifests, the
 *   mock providers' data), never in a source file the app ships.
 * - `placeholder` (SH-V2-FE7): an open item of the legal drafts, `[COUNSEL: …]`, `[FOUNDER: …]`, `[ENGINEERING: …]` or a
 *   joint one: a fact the production Terms or privacy notice do not have yet. The site cannot ship while one is left;
 *   the check lists each, for the founder and counsel to fill or strike.
 * - `trade` (F156, SH-ALPHA-BUILD-SWITCH): a trace of the Sepolia alpha's trade code: the trade slot's marker
 *   (`TRADE_SLOT_MARKER`, src/features/trade-sepolia/TradeSlot.tsx), Uniswap's PoolSwapTest on Sepolia
 *   (`POOL_SWAP_TEST`, in any letter case, with or without its 0x), the selectors of PoolSwapTest's `swap` and of a box
 *   launch router's `buy`, or the trade folders' name, `trade-sepolia`. Where it may be depends on the build target
 *   (`SH_TARGET`, as the build reads it): the mainnet build holds none, anywhere. The Sepolia build holds them only in
 *   lazily loaded chunks, scripts that only a dynamic import reaches: never in index.html, in what index.html loads at
 *   first paint (the entry, the scripts it imports statically, its preloads and styles) or in any other file; and one
 *   of those chunks holds the slot's marker, so the switch is shown on there as well as off on mainnet. Each run also
 *   builds the other target (the twin, in the build's run folder, `twinOf`) and holds it to the same rule: a Sepolia
 *   ship proves the mainnet build has no trade code, a mainnet check that the Sepolia build keeps it lazy. `--no-build`
 *   builds and checks no twin.
 *   Fix round af1 (XR-ALPHA-SWITCH): the markers are looked for in the raw bytes of every file, whatever its name, not
 *   only in the text files the other rules read; and the bundler's module list must agree: a mainnet build holds no
 *   module from a `trade-sepolia` folder under apps/web/src or packages/<name>/src, a Sepolia build holds them in lazily
 *   loaded chunks only, and the list names exactly the scripts the folder holds (a stale or missing list fails).
 *   SH-252: the one exception, the explainer's copied scripts under `examples/`, each only by the committed examples
 *   manifest's SHA-256 (`exampleScriptsOf`); the verdict line counts them.
 *   F161 (4), SH-ALPHA-SITE: Privy's SDK is trade code too. The hosts of Privy's service (`auth.privy.io`,
 *   `privy.systems`) are trade markers, and every module of a `@privy-io/*` package or of a package only Privy's SDK
 *   brings into the install (`privyOnlyPackages`: WalletConnect's, Coinbase's wallet SDK, hCaptcha, Turnstile and the
 *   rest of its own tree) is a trade module: none in a mainnet build, and in a Sepolia build only in lazily loaded
 *   chunks. Every HTML page of the output counts for "first paint", the alpha's join and desk pages
 *   (build/alpha-pages.ts) as well as index.html.
 * - `alpha` (F161 (4), SH-ALPHA-SITE): the Sepolia alpha's own pages and calls: the paths of our alpha-api
 *   (`/alpha/`, `/desk/api/`), the join and desk pages (`join/`, `desk/` in the output) and any module of an
 *   `alpha-sepolia` folder. A mainnet build holds none of them; the Sepolia build must hold both pages, each with its
 *   own notices copy. `standin`: the browser suites' Privy stand-in (`/__standin/`, a trade folder's `test-support`
 *   module) fails in every production build.
 * - `reveal-seam` (SH-203, SH-202 af3): the reveal session's test seam. Its production module
 *   (src/features/core/v2/reveal-test-seam.ts) is an inert lookup; the installer, the override registry and the
 *   authorization helper live in test support (`reveal-test-seam.test-support.ts`), which Vitest swaps in. No production
 *   build holds a module of the app's test support (`*.test-support.*` or a `test-support/` folder under apps/web/src),
 *   and no shipped script names the installer, the authorization helper or the test-support module. The seam module
 *   itself passes only when the code the build rendered for it is inert (fix round af1: judged on that code, never on
 *   its path). Every build the run makes is held to the rule: the caller's, its twin, and the caller's target once more
 *   with Vite's `--mode test` (the seam build, in the run folder, `seamOf`): a test mode cannot switch the seam on.
 * - `source-map`: a source map in the scanned folder. The check's own maps live in its run folder; one in the folder
 *   would be uploaded, with every source file in it.
 * - `packed`: a compressed file (gzip, brotli, zip, zstd, bzip2, xz, 7z, by name or by its first bytes): the scan cannot
 *   read inside one, so it fails instead of trusting it. Formats that compress their own content (pictures, fonts)
 *   are scanned as their bytes.
 * The last seven fail wherever they are, text or code.
 *
 * SH-025 / G07: both builds also require third-party-notices.txt at the output root. It must name each bundled npm
 * package by name/version with an allowed license and intact text references, and include the packaged font
 * with its complete OFL-1.1 text and copyright. --no-build applies this requirement to the scanned build too.
 *
 * `ALLOWANCES` (below) names the few traces apps/web cannot remove itself: text in another package's code or data.
 * Each is matched by its source file (the source maps name it) and rule, and carries its reason and who removes it; one
 * with a `max` covers at most that many findings. The check reports every allowance it used, one over its `max` as
 * failing, and one that matched nothing as stale. Since SH-V2-FE7 the legal texts need none: the production build
 * ships the production Terms and privacy notice, which name no Demo.
 *
 * Run: `node apps/web/production-check.ts [--out <dir>] [--no-build] [--notes] [--same-as <dir>]` (Node 24 strips the
 * types). `--out` must lie inside apps/web by its real path (default `.production/check/dist`). `--no-build` scans it as
 * it is: it reads the module list and maps of the run that `--out`'s pointer names (fix round af3), and fails unless
 * the list names every file of the folder with the same SHA-256, for the same target and the same `--out` (fix round
 * af2, af3).
 *
 * Exit codes: 0 clean; 1 any Demo, local-chain, invented or fixture finding, a trade marker or module where its target
 * allows none (in the build or its twin), a Sepolia build without its trade slot, a twin or module list missing, a source
 * map or a compressed file in the folder, missing or incomplete production notices in either build, or an upload that
 * differs; 3 only the legal drafts' open placeholders are left (SH-V2-FE7), so a pipeline can tell "waiting for counsel"
 * from a new trace.
 */
import ts from 'typescript';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, realpathSync, writeFileSync, type Stats } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseAst } from 'vite';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
/** Under a `dist` folder, so git and lint ignore it (.gitignore `dist/`). */
export const DEFAULT_OUT_DIR = join(HERE, '.production/check/dist');

export type RuleId = 'demo' | 'mock' | 'demo-address' | 'local-rpc' | 'fixture-address' | 'placeholder' | 'trade' | 'alpha' | 'standin' | 'source-map' | 'packed';

/** Where a match sits: in text (copy, data, a URL) or in code (a name). */
export type Place = 'text' | 'code';

export interface Finding {
  readonly rule: RuleId;
  readonly place: Place;
  /** The shipped file, relative to the output directory. */
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly match: string;
  readonly excerpt: string;
  /** The source line behind it, when a source map names one. */
  readonly source?: { readonly file: string; readonly line: number };
  /** The text it sits in (a string literal's content), to find its source when the map has no mapping there. */
  readonly literal?: string;
}

/** A word in any casing, alone or as a part of a longer name, never inside another word. */
const wordPart = (word: string): RegExp => {
  const lower = word.toLowerCase();
  const title = `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
  const upper = lower.toUpperCase();
  return new RegExp(`(?:(?<![A-Za-z0-9])(?:${lower}|${title}|${upper})|(?<=[a-z0-9])(?:${title}|${upper}))s?(?![a-z])`, 'g');
};

// --- the trade markers (F156, SH-ALPHA-BUILD-SWITCH) ------------------------------------------------------------------

/** The Sepolia alpha's trade slot (src/features/trade-sepolia/TradeSlot.tsx exports the same string; a test pins it). */
export const TRADE_SLOT_MARKER = 'sh-trade-slot-f156';
/** Uniswap v4's PoolSwapTest on Sepolia, the alpha's pool trades (docs/design/sepolia-alpha-v1.md, "Chain facts"). */
export const POOL_SWAP_TEST = '0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe';
/**
 * PoolSwapTest's `swap((address,address,uint24,int24,address),(bool,int256,uint160),(bool,bool),bytes)` and a box
 * launch router's `buy(uint256,uint256,address,uint256)` (a test pins both against their signatures).
 */
export const TRADE_SELECTORS: readonly string[] = Object.freeze(['0x2229d0b4', '0x8945257c']);
/** The folders the trade code lives in (apps/web/src/features/trade-sepolia, packages/chain/src/trade-sepolia). */
export const TRADE_FOLDER = 'trade-sepolia';
/** F161 (4), SH-ALPHA-SITE: the hosts of Privy's service, which only Privy's SDK names (the alpha's sign-in, the made wallet). */
export const PRIVY_HOSTS: readonly string[] = Object.freeze(['auth.privy.io', 'privy.systems']);
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Any of them, in any letter case; the address also without its 0x (inside calldata or a padded word). */
export const TRADE_PATTERN = new RegExp([TRADE_SLOT_MARKER, `(?:0x)?${POOL_SWAP_TEST.slice(2)}`, ...TRADE_SELECTORS, TRADE_FOLDER, ...PRIVY_HOSTS.map(escaped)].join('|'), 'gi');
/** F161 (4), SH-ALPHA-SITE: the paths of our alpha-api, which only the Sepolia alpha's pages call. */
export const ALPHA_PATTERN = /\/alpha\/|\/desk\/api\//g;
/** The browser suites' Privy stand-in (features/trade-sepolia/test-support/privy-standin.ts): never in a production build. */
export const STANDIN_PATTERN = /\/__standin\//g;

export const RULES: readonly { readonly id: Exclude<RuleId, 'fixture-address'>; readonly pattern: RegExp }[] = Object.freeze([
  { id: 'demo', pattern: wordPart('demo') },
  { id: 'mock', pattern: wordPart('mock') },
  // A whole address (not a longer hash, not 1e18's 0xde0b6b3a7640000) or one built from the prefix in a template; or
  // the zero address with a tail above 0xff (not 0x…dead).
  { id: 'demo-address', pattern: /0x[dD][eE]0(?:[0-9a-fA-F]{37}(?![0-9a-fA-F])|[0-9a-fA-F]{0,36}(?=\$\{))|0x0{32}(?!0{6})(?!0000[dD][eE][aA][dD](?![0-9a-fA-F]))[0-9a-fA-F]{8}(?![0-9a-fA-F])/g },
  // A loopback host (not a longer host name such as localhost.example), or the local chains' word.
  { id: 'local-rpc', pattern: /(?<![A-Za-z0-9.-])(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?![A-Za-z0-9-]|\.[A-Za-z0-9])|\[::1\]|(?<![A-Za-z0-9])[Aa]nvil(?![a-z])/g },
  // A legal draft's open item, whole (features/legal/terms-common.ts PLACEHOLDER): never the pages' own pattern for it.
  { id: 'placeholder', pattern: /\[(?:COUNSEL|FOUNDER|ENGINEERING)\b[^\]]*\]/g },
  // F156: a trace of the Sepolia alpha's trade code; where it may be depends on the target (`judgeTrade`, below).
  { id: 'trade', pattern: TRADE_PATTERN },
  // F161 (4): the alpha's own calls (allowed in a Sepolia build only, `judgeAlpha`) and the suites' stand-in (never).
  { id: 'alpha', pattern: ALPHA_PATTERN },
  { id: 'standin', pattern: STANDIN_PATTERN },
]);
/** The trade rule alone. */
export const TRADE_RULES: typeof RULES = Object.freeze(RULES.filter((rule) => rule.id === 'trade'));
/** The twin's scan: the trade rule and the alpha's two (F161 (4)). */
export const TWIN_RULES: typeof RULES = Object.freeze(RULES.filter((rule) => rule.id === 'trade' || rule.id === 'alpha' || rule.id === 'standin'));

const ADDRESS = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
const ZERO = `0x${'0'.repeat(40)}`;

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) starts.push(index + 1);
  return starts;
}

function position(starts: readonly number[], offset: number): { line: number; column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: offset - (starts[low] ?? 0) };
}

/** [start, end) offsets of a file's text: string and template literals and regular expressions in a script (not a
 * property's key), quoted values in a style sheet, and all of any other file. */
export function textRanges(text: string, file: string): Array<readonly [number, number]> {
  const ext = extname(file).toLowerCase();
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    // A script the parser cannot read is all text: every match in it counts (fix round af1, any name and syntax).
    try { return scriptTextRanges(text); } catch { return [[0, text.length]]; }
  }
  if (ext === '.css') return [...text.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g)].map((m) => [m.index, m.index + m[0].length] as const);
  return [[0, text.length]];
}

type AstNode = { readonly type: string; readonly start: number; readonly end: number; readonly [key: string]: unknown };
const isNode = (value: unknown): value is AstNode => typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';

function scriptTextRanges(code: string): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  const keys = new Set<AstNode>();
  const stack: unknown[] = [parseAst(code)];
  while (stack.length > 0) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    if (!isNode(value)) continue;
    // A property's or a class member's own name is code, even when written as a string ("data-demo": …).
    if ((value.type === 'Property' || value.type === 'MethodDefinition' || value.type === 'PropertyDefinition') && value.computed !== true && isNode(value.key)) keys.add(value.key);
    if (value.type === 'TemplateElement' || (value.type === 'Literal' && (typeof value.value === 'string' || value.regex !== undefined) && !keys.has(value))) {
      ranges.push([value.start, value.end]);
    }
    for (const [key, child] of Object.entries(value)) if (key !== 'type' && typeof child === 'object' && child !== null) stack.push(child);
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

/** The text range holding `offset`, or null (code). */
function rangeAt(ranges: ReadonlyArray<readonly [number, number]>, offset: number): readonly [number, number] | null {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const range = ranges[mid] as readonly [number, number];
    if (offset < range[0]) high = mid - 1;
    else if (offset >= range[1]) low = mid + 1;
    else return range;
  }
  return null;
}

/** Whether a finding counts: a word in text, or any address or loopback host anywhere (before the allowances). */
export const fails = (finding: Pick<Finding, 'rule' | 'place'>): boolean => (finding.rule === 'demo' || finding.rule === 'mock' ? finding.place === 'text' : true);

// --- allowances -----------------------------------------------------------------------------------------------------

/** A trace apps/web cannot remove itself (SH-V2-FE6 evidence, "Integrator requests"). */
export interface Allowance {
  /** The source behind the finding, repository-relative (as the source maps name it), or a pattern for it. */
  readonly source: string | RegExp;
  readonly rules: readonly RuleId[];
  /** Only these matched words (default: any match of the rules). */
  readonly match?: RegExp;
  /**
   * Only findings in one of these text literals, whole: a string's content (its quotes cut) or a regular expression as
   * the build prints it (default: any literal). A finding outside a literal, or in any other one, is not covered.
   */
  readonly literals?: readonly string[];
  /** At most this many findings (default: any number); more fail, all of them, so a new one is never let through. */
  readonly max?: number;
  /**
   * F161 (4): only for builds of these targets (default: both). An allowance for code only a Sepolia build carries
   * (Privy's SDK) is neither used nor reported stale on mainnet.
   */
  readonly targets?: readonly Target[];
  /** Why it ships for now, and who removes it. */
  readonly reason: string;
}

export const ALLOWANCES: readonly Allowance[] = Object.freeze([
  {
    source: 'packages/chain/src/core/v2/open-reveal-json-v2.ts',
    rules: ['demo'],
    match: /^demo$/,
    literals: ['demo'],
    max: 1,
    reason: 'The shared BoxSpec JSON reader keeps the top-level field named `demo` in KEPT_KEYS (open-reveal-json-v2.ts). This one parser key is neither a label nor a mode; changes to the shared file format belong to packages/chain.',
  },
  {
    source: 'packages/box-spec/src/generated/box-spec.v1.ts',
    rules: ['demo'],
    match: /^demo$/,
    reason: 'BoxSpec v1\'s rules data: `demo` is the name of one of its networks (NETWORKS, OFFERED_ON), a key the factory check reads, never shown. Generated in packages/box-spec.',
  },
  {
    source: 'packages/artwork/src/attributes.ts',
    rules: ['demo'],
    max: 3,
    reason: 'The traits parser\'s limit message ("This demo accepts at most …"); the production site rewrites it to "This site accepts …" before showing it (art-files.ts). The source wording is packages/artwork\'s.',
  },
  {
    source: /^packages\/links\/src\/(?:box|fit)-links\.ts$/,
    rules: ['demo'],
    max: 3,
    reason: 'The link builders\' reason for the Demo network ("Demo: nothing is deployed…"), reached only for a Demo box, which the production site has none of. Removing the branch is packages/links\'s.',
  },
  {
    source: /^packages\/design\/art\/(?:misfits\/)?manifest\.json$/,
    rules: ['demo', 'mock'],
    reason: 'The design package\'s art registries record every picture with its use ("Demo box cover: …", "ORCHARD demo avatar") and its source in the box mock-up; the Demo pictures ship with them, though no production page shows one. Splitting the Demo art out is packages/design\'s.',
  },
  {
    source: /^packages\/chain\/src\/(?:config\/networks|write\/chains)\.ts$/,
    rules: ['local-rpc'],
    reason: 'The chain package\'s network and wallet tables define the local anvil chain (31337, http://127.0.0.1:8545) beside Sepolia; the production site never selects or offers it. Splitting the local chain out is packages/chain\'s.',
  },
  {
    source: /^node_modules\/\.pnpm\/react-router@[^/]+\/node_modules\/react-router\//,
    rules: ['local-rpc'],
    match: /^localhost$/,
    reason: 'react-router\'s placeholder base for parsing paths (`new URL("http://localhost")`), not an RPC.',
  },
  // F161 (4), SH-ALPHA-SITE: Privy's SDK and the libraries it alone brings, in the Sepolia build's lazily loaded chunks
  // only (the join page's sign-in, the Claim card's made wallet). Each is pinned to the package version reviewed here,
  // so an update of Privy's SDK makes it stale and its new findings fail until they are read again.
  {
    source: /^node_modules\/\.pnpm\/@privy-io\+react-auth@3\.51\.0_[^/]+\/node_modules\/@privy-io\/react-auth\/dist\/esm\/(?:index-CaWn8tEz|toViemAccount-BQS52mmk)\.mjs$/,
    rules: ['local-rpc'],
    match: /^(?:localhost|127\.0\.0\.1)$/,
    targets: ['sepolia'],
    max: 6,
    reason: 'Privy\'s SDK tells a page served from localhost apart (`["localhost","127.0.0.1"].includes(location.hostname)`, `origin.startsWith("http://localhost")`), to relax its own checks for developers; it reads no RPC there. Privy\'s code.',
  },
  {
    source: /^node_modules\/\.pnpm\/@simplewebauthn\+browser@13\.3\.0\/node_modules\/@simplewebauthn\/browser\/esm\/helpers\/isValidDomain\.js$/,
    rules: ['local-rpc'],
    match: /^localhost$/,
    targets: ['sepolia'],
    max: 2,
    reason: 'WebAuthn\'s own rule that localhost is a valid relying-party domain (passkeys, a Privy sign-in method the alpha keeps off); no RPC. @simplewebauthn/browser\'s code, which Privy\'s SDK brings.',
  },
  {
    source: /^node_modules\/\.pnpm\/secure-password-utilities@0\.2\.1\/node_modules\/secure-password-utilities\/esm\/wordlists\.js$/,
    rules: ['local-rpc'],
    match: /^anvil$/,
    targets: ['sepolia'],
    max: 2,
    reason: 'A diceware word list of Privy\'s password helper (wallet recovery by password, off in the alpha) holds the English word "anvil"; not the local chain. secure-password-utilities\' data, which Privy\'s SDK brings.',
  },
  {
    source: /^node_modules\/\.pnpm\/@headlessui\+react@2\.2\.10_[^/]+\/node_modules\/@headlessui\/react\/dist\/hooks\/use-transition\.js$/,
    rules: ['mock'],
    match: /^mocks?$/,
    targets: ['sepolia'],
    max: 8,
    reason: 'Headless UI\'s warning for test environments without animations names the `jsdom-testing-mocks` package and its `mockAnimationsApi()`; no visitor reads it on a page and no mock data ships. @headlessui/react\'s code, which Privy\'s SDK brings.',
  },
  {
    source: 'packages/chain/src/core/v2/box-links-v2.ts',
    rules: ['local-rpc'],
    match: /^localhost$/,
    // Fix round 1 (F2): the two refusals only, whole; a local URL in that file is still a finding.
    literals: ['localhost', '/\\.(?:localhost|local|internal|test|invalid|example|onion|arpa)$/'],
    max: 2,
    reason: 'The shared box-links canonicalizer (LINKS-SRV and LINKS-WEB, docs/design/box-links-v2.md § 3) refuses a website on localhost or a .localhost name: a refusal list the page and the server share, never an RPC or a host the site reads. Its rules live once, in packages/chain.',
  },
]);

/** F161 (4): the allowances a build of `target` is held to. */
export const allowancesFor = (target: Target, allowances: readonly Allowance[] = ALLOWANCES): readonly Allowance[] => allowances.filter((allowance) => allowance.targets === undefined || allowance.targets.includes(target));

const sourceMatches = (pattern: string | RegExp, file: string): boolean => (typeof pattern === 'string' ? file === pattern : pattern.test(file));
/** A text literal without its one pair of surrounding quotes (a template element has none). */
const literalBody = (literal: string): string => literal.replace(/^([`'"])([\s\S]*)\1$/, '$2');
const literalMatches = (allowed: readonly string[] | undefined, literal: string | undefined): boolean =>
  allowed === undefined || (literal !== undefined && allowed.includes(literalBody(literal)));

/** The allowance a counting finding falls under, or null. */
export function allowanceFor(finding: Finding, allowances: readonly Allowance[] = ALLOWANCES): Allowance | null {
  const source = finding.source?.file;
  if (source === undefined) return null;
  return allowances.find((allowance) => allowance.rules.includes(finding.rule) && sourceMatches(allowance.source, source) && (!allowance.match || allowance.match.test(finding.match))
    && literalMatches(allowance.literals, finding.literal)) ?? null;
}

export interface Judgement {
  /** The findings that fail the check: no allowance covers them, or theirs is over its `max`. */
  readonly failing: Finding[];
  readonly allowed: Array<{ readonly finding: Finding; readonly allowance: Allowance }>;
  readonly notes: Finding[];
  /** Allowances that matched nothing. */
  readonly stale: Allowance[];
  /** Allowances that matched more than their `max` (their findings fail). */
  readonly over: Array<{ readonly allowance: Allowance; readonly count: number }>;
}

/** The findings that fail the check, the ones an allowance covers (with their allowance), and the notes. */
export function judge(findings: readonly Finding[], allowances: readonly Allowance[] = ALLOWANCES): Judgement {
  const uncovered: Finding[] = [];
  const covered: Array<{ finding: Finding; allowance: Allowance }> = [];
  const notes: Finding[] = [];
  for (const finding of findings) {
    if (!fails(finding)) notes.push(finding);
    else {
      const allowance = allowanceFor(finding, allowances);
      if (allowance) covered.push({ finding, allowance });
      else uncovered.push(finding);
    }
  }
  const counts = new Map<Allowance, number>();
  for (const { allowance } of covered) counts.set(allowance, (counts.get(allowance) ?? 0) + 1);
  const over = [...counts].filter(([allowance, count]) => allowance.max !== undefined && count > allowance.max).map(([allowance, count]) => ({ allowance, count }));
  const capped = new Set(over.map((entry) => entry.allowance));
  return {
    failing: [...uncovered, ...covered.filter((entry) => capped.has(entry.allowance)).map((entry) => entry.finding)],
    allowed: covered.filter((entry) => !capped.has(entry.allowance)),
    notes,
    stale: allowances.filter((allowance) => !counts.has(allowance)),
    over,
  };
}

/** Every finding in one shipped file's text. `fixtureAddresses` are lower case; `rules` all of them unless named. */
export function scanText(text: string, file: string, fixtureAddresses: ReadonlySet<string> = new Set(), rules: typeof RULES = RULES): Finding[] {
  const findings: Finding[] = [];
  const starts = lineStarts(text);
  let ranges: Array<readonly [number, number]> | null = null;
  const add = (rule: RuleId, index: number, match: string) => {
    const { line, column } = position(starts, index);
    const excerpt = text.slice(Math.max(0, index - 40), index + match.length + 40).replace(/\s+/g, ' ');
    ranges ??= textRanges(text, file);
    const range = rangeAt(ranges, index);
    const literal = range && range[1] - range[0] < text.length ? text.slice(range[0], range[1]) : undefined;
    findings.push({ rule, place: range ? 'text' : 'code', file, line, column, match, excerpt, ...(literal ? { literal } : {}) });
  };
  for (const { id, pattern } of rules) for (const found of text.matchAll(new RegExp(pattern.source, pattern.flags))) add(id, found.index, found[0]);
  if (fixtureAddresses.size > 0) {
    for (const found of text.matchAll(ADDRESS)) if (fixtureAddresses.has(found[0].toLowerCase())) add('fixture-address', found.index, found[0]);
  }
  return findings.sort((a, b) => a.line - b.line || a.column - b.column);
}

// --- source maps (only to name the source behind a finding) ---------------------------------------------------------

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** One generated line's segments: [generated column, source index, original line, original column] (absolute, 0-based). */
export function decodeMappings(mappings: string): number[][][] {
  const lines: number[][][] = [];
  let source = 0;
  let originalLine = 0;
  let originalColumn = 0;
  for (const encodedLine of mappings.split(';')) {
    const segments: number[][] = [];
    let column = 0;
    for (const encoded of encodedLine.split(',')) {
      if (encoded === '') continue;
      const values: number[] = [];
      let value = 0;
      let shift = 0;
      for (const char of encoded) {
        const digit = BASE64.indexOf(char);
        if (digit < 0) throw new Error(`Invalid source map character ${char}`);
        value += (digit & 31) << shift;
        if (digit & 32) shift += 5;
        else {
          values.push(value & 1 ? -(value >>> 1) : value >>> 1);
          value = 0;
          shift = 0;
        }
      }
      column += values[0] ?? 0;
      if (values.length >= 4) {
        source += values[1] ?? 0;
        originalLine += values[2] ?? 0;
        originalColumn += values[3] ?? 0;
        segments.push([column, source, originalLine, originalColumn]);
      }
    }
    lines.push(segments);
  }
  return lines;
}

export interface SourceMapLike {
  readonly sources: readonly string[];
  readonly mappings: string;
  readonly sourcesContent?: readonly (string | null)[];
}

/**
 * Where a piece of text came from when the map has no mapping at it (a JSON module's strings, inlined as data): the
 * source whose content holds the same words around the match. Null when none or several do.
 */
/** The words around a match in a literal (its quotes cut), or null when the literal does not hold the match. */
function wordsAround(literal: string, match: string): string | null {
  const body = literal.replace(/^[`'"]|[`'"]$/g, '');
  const at = body.indexOf(match);
  return at < 0 ? null : body.slice(Math.max(0, at - 24), at + match.length + 24);
}

export function sourceHolding(map: SourceMapLike, literal: string, match: string): { file: string; line: number } | null {
  const words = wordsAround(literal, match);
  if (words === null) return null;
  const holders = (map.sourcesContent ?? []).flatMap((content, index) => (content?.includes(words) ? [index] : []));
  if (holders.length !== 1) return null;
  const index = holders[0] as number;
  const content = map.sourcesContent?.[index] ?? '';
  const file = map.sources[index];
  return file === undefined ? null : { file, line: content.slice(0, content.indexOf(words)).split('\n').length };
}

/**
 * The same search on disk, for data a map does not list at all (a JSON module read by one of its sources): the JSON
 * files in the folders of the map's sources. Paths are the map's own (relative to `mapDir`).
 */
export function jsonHolding(map: SourceMapLike, mapDir: string, literal: string, match: string): { file: string; line: number } | null {
  const words = wordsAround(literal, match);
  if (words === null) return null;
  const folders = new Set(map.sources.map((source) => dirname(resolve(mapDir, source.replace(/\?.*$/, '')))));
  const holders: { file: string; line: number }[] = [];
  for (const folder of folders) {
    if (!existsSync(folder) || folder.includes(`${'node_modules'}`)) continue;
    for (const name of readdirSync(folder)) {
      if (!name.endsWith('.json')) continue;
      const content = readFileSync(join(folder, name), 'utf8');
      const index = content.indexOf(words);
      if (index >= 0) holders.push({ file: relative(mapDir, join(folder, name)), line: content.slice(0, index).split('\n').length });
    }
  }
  return holders.length === 1 ? (holders[0] as { file: string; line: number }) : null;
}

const spaced = (text: string): string => text.replace(/\s+/g, ' ');

/**
 * The source to name: the nearest mapping's, unless that source does not hold the words (whitespace runs counted as one
 * space, as JSX text that wraps across lines ends up in the bundle) and a JSON file does: a JSON module's strings are
 * inlined with no mapping of their own, so the nearest one belongs to some other module. A code file found holding the
 * same words never outranks the mapping (it could be an allowed file that happens to repeat a sentence).
 */
export function chooseSource(map: SourceMapLike, mapped: { file: string; line: number } | null, holder: { file: string; line: number } | null, literal: string, match: string): { file: string; line: number } | null {
  if (holder === null || mapped === null) return mapped ?? holder;
  if (mapped.file === holder.file || !holder.file.replace(/\?.*$/, '').endsWith('.json')) return mapped;
  const words = wordsAround(literal, match);
  const content = map.sourcesContent?.[map.sources.indexOf(mapped.file)] ?? '';
  return words !== null && spaced(content).includes(spaced(words)) ? mapped : holder;
}

/** The source file and 1-based line behind a generated position (1-based line, 0-based column), or null. */
export function originalOf(map: SourceMapLike, decoded: number[][][], line: number, column: number): { file: string; line: number } | null {
  const segments = decoded[line - 1] ?? [];
  let best: number[] | null = null;
  for (const segment of segments) {
    if ((segment[0] ?? 0) <= column) best = segment;
    else break;
  }
  if (best === null) return null;
  const file = map.sources[best[1] ?? -1];
  return file === undefined ? null : { file, line: (best[2] ?? 0) + 1 };
}

// --- the shipped files ----------------------------------------------------------------------------------------------

/** The text files the rules read as text (by name, in any letter case); every other file is scanned as bytes only. */
const TEXT = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.htm', '.json', '.svg', '.txt', '.xml', '.webmanifest', '']);
const isText = (file: string): boolean => TEXT.has(extname(file).toLowerCase());

function walk(dir: string): string[] {
  return readdirSync(dir).sort().flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/**
 * Fix round af1: a file the byte scan cannot read inside, a general-purpose compressed one, by its name or its first
 * bytes (gzip, zip, zstd, bzip2, xz, 7z; brotli has no signature, so `.br` goes by name).
 */
const PACKED_NAME = /\.(?:gz|tgz|br|zip|jar|zst|bz2|xz|7z|lz4?|lzma|z)$/i;
const PACKED_MAGIC: readonly (readonly number[])[] = [
  [0x1f, 0x8b],
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x28, 0xb5, 0x2f, 0xfd],
  [0x42, 0x5a, 0x68, -1, 0x31, 0x41, 0x59, 0x26, 0x53, 0x59],
  [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00],
  [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
];
export const isPacked = (file: string, bytes: Uint8Array): boolean =>
  PACKED_NAME.test(file) || PACKED_MAGIC.some((magic) => bytes.length >= magic.length && magic.every((byte, index) => byte < 0 || bytes[index] === byte));

/** A finding a whole file makes (a source map or a compressed file in the scanned folder). */
const fileFinding = (rule: 'source-map' | 'packed', file: string, why: string): Finding => ({ rule, place: 'code', file, line: 1, column: 0, match: file, excerpt: why });

/**
 * Every finding in an output directory. The text rules read the text files; the trade markers are looked for in the
 * raw bytes of every file as well (latin1: one character per byte, so no byte hides), whatever its name. A source map or
 * a compressed file is a finding itself. Source maps for the attribution are read from `maps` (the check's own build
 * moves them into its run folder, `newRun`), each resolved from the place it was written; without `maps`, none.
 */
export function scanDirectory(outDir: string, fixtureAddresses: ReadonlySet<string> = new Set(), rules: typeof RULES = RULES, maps: string | null = null): Finding[] {
  const trade = rules.find((rule) => rule.id === 'trade');
  return walk(outDir).flatMap((path) => {
    const file = relative(outDir, path);
    if (extname(path).toLowerCase() === '.map') return [fileFinding('source-map', file, 'a source map in the folder: it would ship every source file in it')];
    const bytes = readFileSync(path);
    const found: Finding[] = [];
    if (isPacked(file, bytes)) found.push(fileFinding('packed', file, 'a compressed file: the scan cannot read inside it'));
    const text = isText(file) ? attributed(scanText(bytes.toString('utf8'), file, fixtureAddresses, rules), outDir, file, maps) : [];
    found.push(...text);
    if (trade) {
      // The same markers in the raw bytes: in a text file they are the text scan's (ASCII survives decoding), so only a
      // surplus counts again; in any other file every one does.
      const raw = bytes.toString('latin1');
      const matches = [...raw.matchAll(new RegExp(trade.pattern.source, trade.pattern.flags))];
      const known = text.filter((finding) => finding.rule === 'trade').length;
      const starts = matches.length > known ? lineStarts(raw) : [];
      for (const match of matches.slice(known)) {
        const { line, column } = position(starts, match.index);
        found.push({ rule: 'trade', place: 'code', file, line, column, match: match[0], excerpt: raw.slice(Math.max(0, match.index - 40), match.index + match[0].length + 40).replace(/[^\x20-\x7e]+/g, ' ') });
      }
    }
    return found;
  });
}

/** Names the source behind each text finding from the file's source map, when the check's build left one. */
function attributed(findings: Finding[], outDir: string, file: string, maps: string | null): Finding[] {
  const mapPath = [...(maps === null ? [] : [join(maps, `${file}.map`)]), join(outDir, `${file}.map`)].find((candidate) => existsSync(candidate));
  if (findings.length === 0 || mapPath === undefined) return findings;
  const map = JSON.parse(readFileSync(mapPath, 'utf8')) as SourceMapLike;
  const decoded = decodeMappings(map.mappings);
  // A map's sources are relative to where the build wrote it: beside the file in the output folder.
  const mapDir = dirname(join(outDir, file));
  return findings.map((finding) => {
    // The nearest mapping, unless its source does not hold the text and exactly one JSON file does (inlined data).
    const mapped = originalOf(map, decoded, finding.line, finding.column);
    const holder = finding.literal ? (sourceHolding(map, finding.literal, finding.match) ?? jsonHolding(map, mapDir, finding.literal, finding.match)) : null;
    const source = finding.literal ? chooseSource(map, mapped, holder, finding.literal, finding.match) : mapped;
    return source ? { ...finding, source: { file: relative(ROOT, resolve(mapDir, source.file.replace(/\?.*$/, ''))), line: source.line } } : finding;
  });
}

// --- fixture addresses ----------------------------------------------------------------------------------------------

/** The recorded and invented deployments the tests use, and the mock providers' data: never part of a shipped site. */
export const FIXTURE_FILES: readonly string[] = Object.freeze([
  'packages/chain/src/test-support/manifest-31337.json',
  'packages/providers/src/fixtures/feed.json',
  'packages/providers/src/fixtures/accounts.json',
  'packages/providers/src/fixtures/pair-details.json',
  'apps/web/e2e/fixtures/fit-market-31337.json',
  'apps/web/e2e/fixtures/fit-live-31337.json',
  'apps/web/e2e/fixtures/core-local/manifest-11155111.json',
]);

/** Where a real address may also live: the app's and the packages' shipped sources, and the committed deployments. */
const SHIPPED_ROOTS = ['apps/web/src', 'apps/web/fit-markets', 'packages/artwork/src', 'packages/box-spec/src', 'packages/cards/src', 'packages/chain/src', 'packages/contracts/deployments', 'packages/design/src', 'packages/domain/src', 'packages/indexer/src', 'packages/links/src'];
const NOT_SHIPPED = /(?:\.test\.|\.spec\.|[\\/](?:test-support|test|tests|fixtures|e2e|mock|__traces__)[\\/]|demo|mock)/i;

/** Addresses that appear in a fixture and in no shipped source file (lower case). */
export function fixtureOnlyAddresses(root: string = ROOT): Set<string> {
  const addresses = (text: string) => new Set([...text.matchAll(ADDRESS)].map((m) => m[0].toLowerCase()));
  const fixture = new Set<string>();
  for (const file of FIXTURE_FILES) for (const address of addresses(readFileSync(join(root, file), 'utf8'))) fixture.add(address);
  for (const dir of SHIPPED_ROOTS) {
    const base = join(root, dir);
    if (!existsSync(base)) continue;
    for (const path of walk(base)) {
      if (!/\.(?:ts|tsx|json)$/.test(path) || NOT_SHIPPED.test(relative(root, path))) continue;
      for (const address of addresses(readFileSync(path, 'utf8'))) fixture.delete(address);
    }
  }
  fixture.delete(ZERO);
  return fixture;
}

// --- where a shipped file loads, and the trade rule (F156) ----------------------------------------------------------

/**
 * The build target this check holds a build to: `SH_TARGET` as apps/web/build-target.ts `buildTargetOf` reads it for a
 * production build, which the build itself applies (this file runs on Node alone and imports no app module; a test
 * pins the two agree).
 */
export type Target = 'mainnet' | 'sepolia';
export function targetOf(env: Readonly<Record<string, string | undefined>>): Target {
  const value = env.SH_TARGET ?? '';
  if (value === '' || value === 'mainnet') return 'mainnet';
  if (value === 'sepolia') return 'sepolia';
  throw new Error(`SH_TARGET must be unset, "mainnet" or "sepolia" (got "${value}")`);
}

export interface LoadGraph {
  /**
   * Every HTML page and what it loads at first paint: its scripts, preloads and styles, and every script they import
   * statically. The pages are index.html and, in a Sepolia build, the alpha's join/index.html and desk/index.html
   * (F161 (4)): every `.html` file of the output, so a page added later is a first paint too.
   */
  readonly firstPaint: ReadonlySet<string>;
  /** Scripts that only a dynamic import reaches (lazily loaded chunks), and the scripts only they import. */
  readonly lazy: ReadonlySet<string>;
}

/** A shipped file's path relative to the output directory, with forward slashes (the graph's keys). */
const outputPath = (file: string): string => file.split(sep).join('/');

/** An output file a reference names, from the output file `from`: null for another origin, a data URL or a bare name. */
function referencedFile(reference: string, from: string): string | null {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:|^\/\//.test(reference)) return null;
  const path = reference.split(/[?#]/)[0] ?? '';
  if (path.startsWith('/')) return posix.normalize(path.slice(1));
  if (!path.startsWith('./') && !path.startsWith('../')) return null;
  const resolved = posix.join(posix.dirname(from), path);
  return resolved.startsWith('../') ? null : resolved;
}

/** The scripts, preloads and styles an HTML file names (`src` and `href` of its script and link elements). */
export function htmlReferences(html: string): string[] {
  return [...html.matchAll(/<(?:script|link)\b[^>]*?\s(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1] as string);
}

/** A script's imports, in source order: the static ones (`import`/`export … from`) and the dynamic `import()` of a fixed path. */
export function importsOf(code: string): { readonly static: string[]; readonly dynamic: string[] } {
  const found = { static: [] as Array<readonly [number, string]>, dynamic: [] as Array<readonly [number, string]> };
  const stack: unknown[] = [parseAst(code)];
  while (stack.length > 0) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    if (!isNode(value)) continue;
    const source = value.source;
    if ((value.type === 'ImportDeclaration' || value.type === 'ExportNamedDeclaration' || value.type === 'ExportAllDeclaration') && isNode(source) && typeof source.value === 'string') found.static.push([value.start, source.value]);
    if (value.type === 'ImportExpression' && isNode(source)) {
      // The build writes `import(\`./chunk.js\`)`: a template with no expression is as fixed as a string.
      const quasis = source.type === 'TemplateLiteral' && Array.isArray(source.expressions) && source.expressions.length === 0 ? source.quasis : null;
      const fixed = source.type === 'Literal' ? source.value : Array.isArray(quasis) && isNode(quasis[0]) ? (quasis[0].value as { cooked?: unknown } | undefined)?.cooked : undefined;
      if (typeof fixed === 'string') found.dynamic.push([value.start, fixed]);
    }
    for (const [key, child] of Object.entries(value)) if (key !== 'type' && typeof child === 'object' && child !== null) stack.push(child);
  }
  const ordered = (list: Array<readonly [number, string]>) => list.sort((a, b) => a[0] - b[0]).map(([, path]) => path);
  return { static: ordered(found.static), dynamic: ordered(found.dynamic) };
}

/** Where each shipped file loads: from every HTML page's references through the scripts' static and dynamic imports. */
export function loadGraph(outDir: string): LoadGraph {
  const present = (file: string): boolean => existsSync(join(outDir, file)) && statSync(join(outDir, file)).isFile();
  const cache = new Map<string, { readonly static: string[]; readonly dynamic: string[] }>();
  const edges = (file: string) => {
    let known = cache.get(file);
    if (!known) {
      const imports = /\.m?js$/.test(file) ? importsOf(readFileSync(join(outDir, file), 'utf8')) : { static: [], dynamic: [] };
      const named = (list: readonly string[]) => list.map((reference) => referencedFile(reference, file)).filter((path): path is string => path !== null && present(path));
      known = { static: named(imports.static), dynamic: named(imports.dynamic) };
      cache.set(file, known);
    }
    return known;
  };
  const firstPaint = new Set<string>();
  const pages = existsSync(outDir) ? walk(outDir).map((path) => outputPath(relative(outDir, path))).filter((file) => /\.html?$/i.test(file)) : [];
  const queue = pages.flatMap((html) => [html, ...htmlReferences(readFileSync(join(outDir, html), 'utf8')).map((reference) => referencedFile(reference, html)).filter((path): path is string => path !== null && present(path))]);
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (firstPaint.has(file)) continue;
    firstPaint.add(file);
    queue.push(...edges(file).static);
  }
  const lazy = new Set<string>();
  const pending = [...firstPaint].flatMap((file) => edges(file).dynamic);
  while (pending.length > 0) {
    const file = pending.shift() as string;
    if (firstPaint.has(file) || lazy.has(file)) continue;
    lazy.add(file);
    pending.push(...edges(file).static, ...edges(file).dynamic);
  }
  return { firstPaint, lazy };
}

/** Where a shipped file loads, for a finding's line. */
export const loadOf = (graph: LoadGraph, file: string): 'first paint' | 'lazy' | 'not loaded by a script' =>
  graph.firstPaint.has(outputPath(file)) ? 'first paint' : graph.lazy.has(outputPath(file)) ? 'lazy' : 'not loaded by a script';

export interface TradeJudgement {
  readonly target: Target;
  /** The trade findings that fail: every one in a mainnet build; in the Sepolia build, each outside a lazily loaded script. */
  readonly failing: Finding[];
  /** The Sepolia build's trade findings in lazily loaded scripts (where they belong). */
  readonly lazy: Finding[];
  /** The Sepolia build: whether a lazily loaded script holds the trade slot's marker (the switch is on there). */
  readonly slot: boolean;
}

/** The trade rule (see the header): where a build of `target` may hold the trade markers. */
export function judgeTrade(findings: readonly Finding[], target: Target, graph: LoadGraph): TradeJudgement {
  const trade = findings.filter((finding) => finding.rule === 'trade');
  if (target === 'mainnet') return { target, failing: trade, lazy: [], slot: false };
  const lazy = trade.filter((finding) => /\.m?js$/.test(finding.file) && graph.lazy.has(outputPath(finding.file)));
  return { target, failing: trade.filter((finding) => !lazy.includes(finding)), lazy, slot: lazy.some((finding) => finding.match.toLowerCase() === TRADE_SLOT_MARKER) };
}

/** What a trade judgement says, line by line: `ok` when nothing fails. */
export function tradeReport(judgement: TradeJudgement, graph: LoadGraph, what: string): { readonly ok: boolean; readonly lines: string[] } {
  const lines = judgement.failing.map((finding) => `${formatFinding(finding)}\n    (${loadOf(graph, finding.file)})`);
  const missing = judgement.target === 'sepolia' && !judgement.slot;
  if (missing) lines.push(`${what}: the Sepolia build holds no trade slot (${TRADE_SLOT_MARKER}) in a lazily loaded chunk: the switch is off there, or the slot left its module`);
  if (judgement.failing.length > 0) lines.push(`${what}: ${judgement.failing.length} trade ${judgement.failing.length === 1 ? 'marker' : 'markers'} where ${judgement.target === 'mainnet' ? 'a mainnet build holds none' : 'only a lazily loaded chunk may hold one'}`);
  if (lines.length === 0) {
    const files = [...new Set(judgement.lazy.map((finding) => outputPath(finding.file)))].sort();
    lines.push(judgement.target === 'mainnet' ? `${what}: no trade marker` : `${what}: ${judgement.lazy.length} trade ${judgement.lazy.length === 1 ? 'marker' : 'markers'}, all in lazily loaded chunks (${files.join(', ')}), the trade slot among them`);
  }
  return { ok: !missing && judgement.failing.length === 0, lines };
}

// --- the command ----------------------------------------------------------------------------------------------------

export function formatFinding(finding: Finding): string {
  const where = finding.source ? ` ← ${finding.source.file}:${finding.source.line}` : '';
  return `${`${finding.rule} ${finding.place}`.padEnd(20)} ${finding.file}:${finding.line}:${finding.column}${where}\n    …${finding.excerpt}…`;
}

/** F161 (4): the global registry key build/alpha-pages.ts hands the alpha pages' chunks to (`Symbol.for` of it). */
export const ALPHA_PAGES_REGISTRY_KEY = 'squarehole.alpha-pages';

/**
 * The bundler's account of one built chunk: its file in the output folder and the modules in it (absolute ids, as the
 * bundler resolved them, so every spelling of an import ends as the file it reached).
 */
export interface BuiltChunk {
  readonly fileName: string;
  readonly moduleIds: readonly string[];
  /**
   * The seam and its dependencies as rendered (`modules[id].code`, null when absent).
   * Keys use the same written ids as the module list. Dependencies may live in other chunks.
   */
  readonly seamCode?: Readonly<Record<string, string | null>>;
  /** Resolved dependencies of the seam and every module it reaches, across chunk boundaries. */
  readonly seamDependencies?: Readonly<Record<string, readonly string[]>>;
  /** Rolldown runtime, when offered in modules[id].code. An empty record means it was not offered. */
  readonly seamRuntime?: Readonly<Record<string, string | null>>;
}

/** Keep the rendered dependency closure, including empty or missing code so judgement fails closed. */
export function recordSeamChunks(chunks: readonly (BuiltChunk & { readonly modules?: Readonly<Record<string, { readonly code?: string | null }>> })[],
  dependencies: Readonly<Record<string, readonly string[]>>): BuiltChunk[] {
  const rendered = new Map(chunks.flatMap((chunk) => Object.entries(chunk.modules ?? {}).map(([id, module]) => [id, module.code ?? null] as const)));
  const seamRuntime = Object.fromEntries([...rendered].filter(([id]) => id === '\0rolldown/runtime.js'));
  const unlisted = Object.keys(dependencies).filter((id) => repoPathOf(id) === REVEAL_SEAM_MODULE && !chunks.some((chunk) => chunk.moduleIds.includes(id)));
  return chunks.map((chunk, index) => {
    const seamCode: Record<string, string | null> = {};
    const seamDependencies: Record<string, readonly string[]> = {};
    const visit = (id: string): void => {
      if (Object.hasOwn(seamCode, id)) return;
      seamCode[id] = rendered.get(id) ?? null;
      if (dependencies[id] === undefined) return;
      seamDependencies[id] = dependencies[id];
      dependencies[id].forEach(visit);
    };
    chunk.moduleIds.filter((id) => repoPathOf(id) === REVEAL_SEAM_MODULE).forEach(visit);
    // A re-export may render no module of its own. Its resolved implementation still needs a judgement.
    if (index === 0) unlisted.forEach(visit);
    return { fileName: chunk.fileName, moduleIds: chunk.moduleIds, seamCode, seamDependencies, seamRuntime };
  });
}

/**
 * The check's build (fix round af1): Vite's own `build()` with the flags `vite build --sourcemap hidden --outDir <dir>
 * --emptyOutDir` passes, so the output is the command line's byte for byte (`--same-as` holds the upload to it); it also
 * writes each chunk's modules to the list file. Run as `node --input-type=module -e BUILDER -- <out> <list>` in apps/web.
 */
const BUILDER = [
  "import { writeFileSync } from 'node:fs';",
  "import { build } from 'vite';",
  // The ids go to disk repository-relative (`moduleIdOf`, this file's own): a list never holds a personal path.
  `import { recordSeamChunks, writtenChunks } from ${JSON.stringify(import.meta.url)};`,
  'const [listFile, options, mode] = process.argv.slice(1);',
  // F161 (4), SH-ALPHA-SITE: the alpha's join and desk pages are builds of their own inside this one
  // (build/alpha-pages.ts `ALPHA_PAGES_REGISTRY`); each hands its chunks here, so the list names their scripts too.
  `const pages = { chunks: [] }; globalThis[Symbol.for(${JSON.stringify(ALPHA_PAGES_REGISTRY_KEY)})] = pages;`,
  // SH-203: the seam build passes `--mode test` as the command line would; the others pass no mode.
  'const dependencies = {};',
  "const seamGraph = { name: 'record-reveal-seam', generateBundle() { for (const id of this.getModuleIds()) { const info = this.getModuleInfo(id); if (info) dependencies[id] = [...info.importedIds, ...info.dynamicallyImportedIds]; } } };",
  "const result = await build({ ...(mode ? { mode } : {}), plugins: [seamGraph], build: JSON.parse(options) });",
  "const chunks = [...(Array.isArray(result) ? result : [result]).flatMap((output) => output.output ?? []).filter((item) => item.type === 'chunk'), ...pages.chunks];",
  'writeFileSync(listFile, JSON.stringify(writtenChunks(recordSeamChunks(chunks, dependencies))));',
].join('\n');

const isChunk = (item: unknown): item is BuiltChunk => typeof item === 'object' && item !== null && typeof (item as BuiltChunk).fileName === 'string'
  && Array.isArray((item as BuiltChunk).moduleIds) && (item as BuiltChunk).moduleIds.every((id) => typeof id === 'string')
  && ((item as BuiltChunk).seamCode === undefined || (typeof (item as BuiltChunk).seamCode === 'object' && (item as BuiltChunk).seamCode !== null
    && Object.values((item as BuiltChunk).seamCode as object).every((code) => code === null || typeof code === 'string')))
  && ((item as BuiltChunk).seamRuntime === undefined || (typeof (item as BuiltChunk).seamRuntime === 'object' && (item as BuiltChunk).seamRuntime !== null
    && Object.values((item as BuiltChunk).seamRuntime as object).every((code) => code === null || typeof code === 'string')))
  && ((item as BuiltChunk).seamDependencies === undefined || (typeof (item as BuiltChunk).seamDependencies === 'object' && (item as BuiltChunk).seamDependencies !== null
    && Object.values((item as BuiltChunk).seamDependencies as object).every((ids) => Array.isArray(ids) && ids.every((id) => typeof id === 'string'))));

/** The chunks the builder wrote (its raw list); null when there is none or it is not one. */
export function readChunks(path: string): BuiltChunk[] | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return Array.isArray(value) && value.every(isChunk) ? value : null;
  } catch {
    return null;
  }
}

// --- the check's own folders (fix round af2, F1; fix round af3, F1) --------------------------------------------------

/**
 * Everything the check writes for itself lives under one root inside apps/web, git-ignored (`.cache/`): each run's
 * module list and source maps, and its twin's build, in a run folder it makes new each time (`mkdtemp`, so no earlier
 * folder is ever reused); and per `--out` a pointer, written atomically, that names its latest run for `--no-build`.
 * Fix round af3: the check deletes nothing at all. Old runs stay where they are; the root may be cleared by hand (the
 * server runbook says so). `--out` must lie inside apps/web by its real path, clear of apps/web's own folders, so the
 * one emptying left, Vite's `--emptyOutDir` of `--out` itself (as at `dd6e1af75`), stays inside apps/web as well.
 */
export interface Home {
  /** The folder every `--out` lies inside: apps/web. */
  readonly web: string;
  /** The check's own root, inside it. */
  readonly owned: string;
}
export const HOME: Home = { web: HERE, owned: join(HERE, '.cache/production-check') };

const within = (path: string, folder: string): boolean => path.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`);
const statOf = (path: string): Stats | null => {
  try { return lstatSync(path); } catch { return null; }
};
const digest = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** A path's real path: its nearest existing ancestor's, with the rest joined on (links resolved, nothing created). */
export function realPathOf(path: string): string {
  const rest: string[] = [];
  let at = resolve(path);
  while (statOf(at) === null) {
    const up = dirname(at);
    if (up === at) break;
    rest.unshift(basename(at));
    at = up;
  }
  return join(realpathSync(at), ...rest);
}

/** The `--out` a run may use, as its real path: strictly inside apps/web, and clear of its own folders and the check's root. */
export function outOf(requested: string, home: Home): string {
  const web = realpathSync(home.web);
  const out = realPathOf(requested);
  if (!within(out, web)) throw new Error(`--out must lie inside ${home.web}: its real path ${out} does not`);
  for (const kept of [realPathOf(home.owned), ...['src', 'public', 'e2e', 'functions', 'fit-markets', 'node_modules'].map((name) => join(web, name))]) {
    if (out === kept || within(out, kept) || within(kept, out)) throw new Error(`--out may not be, hold or lie inside ${kept}`);
  }
  return out;
}

/** `--out`'s path inside apps/web: what a pointer and a module list record of it (never a personal path). */
export const outPathOf = (out: string, home: Home): string => relative(realpathSync(home.web), out).split(sep).join('/');
/** One `--out`'s key: its name and a hash of its path inside apps/web. */
const outKeyOf = (out: string, home: Home): string => `${basename(out) || 'out'}-${digest(outPathOf(out, home))}`;

/** The check's storage folders, each by its canonical path, every part of it a real folder (fix round af4, F1). */
export interface Storage {
  readonly owned: string;
  readonly runs: string;
  readonly pointers: string;
}

/**
 * Fix round af4, F1: the check's storage, reached from apps/web's real path one name at a time: `.cache`,
 * `production-check`, then `runs` and `pointers`. Each part that exists must be a real folder, never a link, not even
 * one that stays inside apps/web; all of them are checked before anything is made, written or read. With `create`, the
 * missing ones are then made one by one (`mkdir`, never recursive) and checked again; without it, a missing part means
 * there is no storage yet (null). Records are made, published and read only through the folders this returns.
 */
export function storageOf(home: Home, create: boolean): Storage | null {
  const web = realpathSync(home.web);
  const rel = relative(home.web, home.owned);
  const owned = rel.split(sep);
  if (rel === '' || isAbsolute(rel) || owned.includes('..')) throw new Error(`the check's root ${home.owned} does not lie inside ${home.web}`);
  const chains = [owned, [...owned, 'runs'], [...owned, 'pointers']];
  const checked = (path: string): boolean => {
    const stat = statOf(path);
    if (stat === null) return false;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`the check's folder ${relative(web, path).split(sep).join('/')} is ${stat.isSymbolicLink() ? 'a link' : 'no folder'}: nothing of the check's is made, written or read through it`);
    }
    return true;
  };
  let complete = true;
  for (const chain of chains) {
    let at = web;
    for (const part of chain) {
      at = join(at, part);
      if (!checked(at)) {
        complete = false;
        break;
      }
    }
  }
  if (!complete && !create) return null;
  if (!complete) {
    for (const chain of chains) {
      let at = web;
      for (const part of chain) {
        at = join(at, part);
        if (statOf(at) === null) mkdirSync(at);
        checked(at);
      }
    }
  }
  return { owned: join(web, ...owned), runs: join(web, ...owned, 'runs'), pointers: join(web, ...owned, 'pointers') };
}

/** The check's storage for a build: made where missing, refused (thrown) where a part is a link or no folder. */
const madeStorage = (home: Home): Storage => storageOf(home, true) as Storage;

/** A new run folder for `out`, made exclusively (`mkdtemp`) as a direct child of the checked `runs`: nothing is reused. */
export function newRun(out: string, home: Home): string {
  return mkdtempSync(join(madeStorage(home).runs, `${outKeyOf(out, home)}-`));
}

export const mapsOf = (run: string): string => join(run, 'maps');
export const listOf = (run: string): string => join(run, 'modules.json');
/** The twin's build and its record (its raw module list), inside the run. */
export const twinOf = (run: string, target: Target): { readonly out: string; readonly record: string } => ({ out: join(run, `twin-${target}`, 'dist'), record: join(run, `twin-${target}`) });
/** SH-203: the seam build's folders inside a run: the caller's target built with `--mode test`. */
export const seamOf = (run: string): { readonly out: string; readonly record: string } => ({ out: join(run, 'seam-test', 'dist'), record: join(run, 'seam-test') });

/** Where `out`'s pointer lives: the file that names its latest run. */
export const pointerOf = (out: string, home: Home): string => join(home.owned, 'pointers', `${outKeyOf(out, home)}.json`);
export const POINTER = 'squarehole.production-check.pointer/1';

/** Names `run` as `out`'s latest, atomically: a new file in the checked `pointers`, then renamed over the pointer. */
export function writePointer(out: string, run: string, home: Home): void {
  const storage = madeStorage(home);
  const stat = statOf(run);
  if (dirname(run) !== storage.runs || stat === null || stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${run} is no run of the check's`);
  const pointer = join(storage.pointers, basename(pointerOf(out, home)));
  const temporary = `${pointer}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ schema: POINTER, out: outPathOf(out, home), run: basename(run) })}\n`, { flag: 'wx' });
  renameSync(temporary, pointer);
}

/**
 * The run `out`'s pointer names, or why it cannot be trusted: a storage folder that is a link (fix round af4), no
 * pointer, a pointer that is a link or another schema, a pointer written for another output, a run made for another
 * output, a run that is no real folder directly inside the checked `runs`, or a record in it (its module list, its maps)
 * that is a link or of another kind.
 */
export function pointedRun(out: string, home: Home): { readonly run: string } | { readonly problem: string } {
  let storage: Storage | null;
  try {
    storage = storageOf(home, false);
  } catch (error) {
    return { problem: (error as Error).message };
  }
  const shown = relative(realpathSync(home.web), pointerOf(out, home)).split(sep).join('/');
  if (storage === null) return { problem: `no pointer to this output's latest run (${shown}): the check's folders are not there` };
  const pointer = join(storage.pointers, basename(pointerOf(out, home)));
  const pointerStat = statOf(pointer);
  if (pointerStat === null) return { problem: `no pointer to this output's latest run (${shown})` };
  if (pointerStat.isSymbolicLink() || !pointerStat.isFile()) return { problem: `the pointer ${shown} is ${pointerStat.isSymbolicLink() ? 'a link' : 'no file'}` };
  type Pointer = { readonly schema?: unknown; readonly out?: unknown; readonly run?: unknown } | null;
  const read = (): Pointer | undefined => {
    try { return JSON.parse(readFileSync(pointer, 'utf8')) as Pointer; } catch { return undefined; }
  };
  const value = read();
  if (value === undefined) return { problem: `the pointer ${shown} cannot be read` };
  if (value?.schema !== POINTER) return { problem: `the pointer is not a ${POINTER}` };
  if (value.out !== outPathOf(out, home)) return { problem: `the pointer is for ${String(value.out)}, not ${outPathOf(out, home)}` };
  const name = typeof value.run === 'string' ? value.run : '';
  const key = outKeyOf(out, home);
  if (!name.startsWith(`${key}-`) || !/^[A-Za-z0-9]{6}$/.test(name.slice(key.length + 1))) return { problem: `the pointer names ${JSON.stringify(name)}, not a run made for this output` };
  const run = join(storage.runs, name);
  const stat = statOf(run);
  if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) return { problem: `the run the pointer names is no folder of the check's (${name})` };
  for (const [what, path, folder] of [['module list', listOf(run), false], ['maps', mapsOf(run), true]] as const) {
    const record = statOf(path);
    if (record !== null && (record.isSymbolicLink() || (folder ? !record.isDirectory() : !record.isFile()))) return { problem: `the run's ${what} is ${record.isSymbolicLink() ? 'a link' : `no ${folder ? 'folder' : 'file'}`}` };
  }
  return { run };
}

/** Fix round af2, F2: the module list ties itself to the folder it describes, file by file. */
export const MODULE_LIST = 'squarehole.production-check.modules/3';
export interface ModuleList {
  readonly schema: string;
  readonly target: Target;
  /** The output folder it describes, by its path inside apps/web (fix round af3). */
  readonly out: string;
  /** Every file of the folder by its path, with its SHA-256. */
  readonly files: Readonly<Record<string, string>>;
  readonly chunks: readonly BuiltChunk[];
}

/** Every file of a folder by its path (forward slashes), with its SHA-256. */
export function filesOf(outDir: string): Record<string, string> {
  return Object.fromEntries(walk(outDir).map((path) => [outputPath(relative(outDir, path)), createHash('sha256').update(readFileSync(path)).digest('hex')]));
}

/** Writes a build's module list into its run, once (the run is new for every build). */
export function writeModuleList(run: string, outDir: string, target: Target, chunks: readonly BuiltChunk[], home: Home): void {
  const list: ModuleList = { schema: MODULE_LIST, target, out: outPathOf(outDir, home), files: filesOf(outDir), chunks };
  writeFileSync(listOf(run), `${JSON.stringify(list)}\n`, { flag: 'wx' });
}

/** A module list from its file; null when there is none or it is not one. */
export function readModuleList(path: string): ModuleList | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<ModuleList> | null;
    const files = value?.files;
    const filesOk = typeof files === 'object' && files !== null && !Array.isArray(files) && Object.values(files).every((hash) => typeof hash === 'string');
    if (value === null || typeof value.schema !== 'string' || (value.target !== 'mainnet' && value.target !== 'sepolia') || typeof value.out !== 'string' || !filesOk || !Array.isArray(value.chunks) || !value.chunks.every(isChunk)) return null;
    return value as ModuleList;
  } catch {
    return null;
  }
}

/** How a module list differs from the folder it should describe: [] when it is this folder's build, file for file. */
export function listMismatches(list: ModuleList, outDir: string, target: Target, home: Home): string[] {
  const out: string[] = [];
  if (list.schema !== MODULE_LIST) out.push(`written as ${list.schema}, not ${MODULE_LIST}`);
  if (list.target !== target) out.push(`written for the ${list.target} target, not ${target}`);
  if (list.out !== outPathOf(outDir, home)) out.push(`written for ${list.out}, not ${outPathOf(outDir, home)}`);
  const now = filesOf(outDir);
  for (const file of [...new Set([...Object.keys(list.files), ...Object.keys(now)])].sort()) {
    if (!Object.hasOwn(now, file)) out.push(`${file} is gone`);
    else if (!Object.hasOwn(list.files, file)) out.push(`${file} was added`);
    else if (now[file] !== list.files[file]) out.push(`${file} changed`);
  }
  return out;
}

/**
 * Moves the build's own source maps (`<chunk>.map` for each chunk it lists) out of the scanned folder into `maps`, at
 * the same relative path; returns how many. Any other map stays where it is, and the scan fails on it: one copied from
 * apps/web/public, say, would be uploaded.
 */
export function moveMaps(outDir: string, maps: string, chunks: readonly BuiltChunk[]): number {
  let moved = 0;
  for (const { fileName } of chunks) {
    const path = join(outDir, `${fileName}.map`);
    if (!existsSync(path)) continue;
    const target = join(maps, `${fileName}.map`);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(path, target);
    moved += 1;
  }
  return moved;
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Which build: the caller's `--out`, as it ships, the twin in a new run folder (fix round af3), or the seam build (SH-203):
 * the caller's target again, built with Vite's `--mode test`, in the run folder too.
 */
export type BuildRole = 'build' | 'twin' | 'seam';
/** The Vite mode a build runs in: the seam build's is `test`, every other one's Vite's own default. */
export const modeOf = (role: BuildRole): string | null => (role === 'seam' ? 'test' : null);

/**
 * The build's options, as `vite build` takes them from the command line. The caller's `--out` is built as
 * `--sourcemap hidden --emptyOutDir` makes it (Vite empties `--out` itself, as at `dd6e1af75`). The twin goes into a new
 * folder of a new run, so nothing is emptied there; it needs no maps (any trade marker fails it, wherever it comes from)
 * and no copy of apps/web/public, which is the same for both targets and which the caller's build is scanned with.
 */
export function buildOptionsOf(role: BuildRole, outDir: string): Readonly<Record<string, unknown>> {
  return role === 'build' ? { sourcemap: 'hidden', outDir, emptyOutDir: true } : { sourcemap: false, outDir, emptyOutDir: false, copyPublicDir: false };
}

function buildProduction(outDir: string, overrides: Readonly<Record<string, string>>, callerEnv: Env, record: string, role: BuildRole): BuiltChunk[] {
  // The production build as `pnpm build:production` makes it (the caller's build variables, SH_BUILD=production). The
  // caller's build adds hidden source maps to name the sources: they add files, never a line to a shipped one, and move
  // into the run at once. The build may finish with open legal placeholders (placeholder-guard.ts would stop it): this
  // check lists them itself, and fails on them. `overrides`: the twin's other target (F156), nothing else. `record` is a
  // folder of this run's (`newRun`, `twinOf`).
  const env = { ...callerEnv, ...overrides, SH_BUILD: 'production', SH_ALLOW_PLACEHOLDERS: '1' };
  const raw = join(record, 'chunks.json');
  const mode = modeOf(role);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', BUILDER, '--', raw, JSON.stringify(buildOptionsOf(role, outDir)), ...(mode === null ? [] : [mode])], { cwd: HERE, env, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`The production build failed (exit ${String(result.status)})`);
  const chunks = readChunks(raw);
  if (chunks === null) throw new Error(`The production build wrote no module list (${raw})`);
  if (role === 'build') {
    mkdirSync(mapsOf(record));
    moveMaps(outDir, mapsOf(record), chunks);
  }
  return chunks;
}

/** A repository path inside a trade folder: any directory named trade-sepolia under apps/web/src or packages/<name>/src. */
export const TRADE_SOURCE = /^(?:apps\/web\/src|packages\/[^/]+\/src)\/(?:[^/]+\/)*trade-sepolia\//;
/** The same reached through a workspace link in node_modules (a build that kept links would name it so). */
const LINKED_TRADE_SOURCE = /(?:^|\/)node_modules\/@squarehole\/[^/]+\/src\/(?:[^/]+\/)*trade-sepolia\//;

/** The id kinds the check writes (`moduleIdOf`). */
const ID_KINDS = ['repo', 'dependency', 'virtual', 'external', 'outside'] as const;
type IdKind = (typeof ID_KINDS)[number];

/** A personal path in a text: the repository's absolute root or the user's home folder. */
const holdsPersonalPath = (text: string, root: string, home: string): boolean => text.includes(root) || (home.length > 1 && text.includes(home));
/** A text with the repository's root written `<repo>` and the home folder `<home>`, wherever they stand in it. */
const scrubbed = (text: string, root: string, home: string): string => {
  const rooted = text.split(root).join('<repo>');
  return home.length > 1 ? rooted.split(home).join('<home>') : rooted;
};

/** An absolute file path (with what followed it, a query say) in the written form: by its path from the root, or a hash. */
function pathIdOf(path: string, rest: string, root: string): string {
  const rel = relative(root, path).split(sep).join('/');
  if (rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return `outside:${digest(path)}`;
  return `${rel.startsWith('node_modules/') ? 'dependency' : 'repo'}:${rel}${rest}`;
}

/** The path a raw id starts with, when it is a file (an absolute path or a file: URL), and what follows it. */
function filePartOf(id: string): { readonly path: string; readonly rest: string } | null {
  const cut = /[?#]/.exec(id)?.index ?? id.length;
  const head = id.slice(0, cut);
  if (isAbsolute(head)) return { path: head, rest: id.slice(cut) };
  if (head.startsWith('file:')) {
    try { return { path: fileURLToPath(head), rest: id.slice(cut) }; } catch { return null; }
  }
  return null;
}

/** Whether an id is already in the written form, and nothing personal is left in it (fix round af3, F4). */
function isWrittenId(id: string, root: string, home: string): boolean {
  const colon = id.indexOf(':');
  const kind = id.slice(0, colon) as IdKind;
  const body = id.slice(colon + 1);
  if (colon < 0 || !ID_KINDS.includes(kind) || holdsPersonalPath(body, root, home)) return false;
  if (kind === 'outside') return /^[0-9a-f]{16}$/.test(body);
  if (kind === 'virtual') return !body.startsWith('\0') && filePartOf(body) === null && (!/^(?:repo|dependency|outside):/.test(body) || isWrittenId(body, root, home));
  if (kind === 'external') return filePartOf(body) === null;
  const path = body.replace(/[?#].*$/, '');
  return path !== '' && !isAbsolute(path) && !path.split('/').includes('..') && (kind === 'dependency') === path.startsWith('node_modules/');
}

/**
 * Addendum to fix round af2, and fix round af3, F4: a bundled module's id as the check writes it and compares it, with
 * no personal path in it. `repo:<path>` is a file under the repository, by its path from the root; `dependency:<path>`
 * one under the root's node_modules, the same way; `outside:<hash>` an absolute path outside the repository, never as it
 * is; `virtual:<id>` a bundler's virtual module, its \0 dropped and a file path it starts with written as above
 * (`virtual:dependency:node_modules/x/index.js?commonjs-proxy`); `external:<id>` any other id. An id already in that form
 * is taken as it is only when it is valid (an absolute path, a step out, a personal path or a wrong kind make it raw
 * again, its body read as the id it stands for). Wherever the repository's root or the home folder is still left (in a
 * query, inside another virtual id), it is written `<repo>` or `<home>`: the path and its kind stay readable, so a trade
 * file keeps its name (`tradeModuleOf`), and no written file holds a personal path.
 */
export function moduleIdOf(id: string, root: string = ROOT, home: string = homedir()): string {
  if (isWrittenId(id, root, home)) return id;
  const prefix = /^(repo|dependency|virtual|external|outside):/.exec(id)?.[1];
  const body = prefix === undefined ? id : id.slice(prefix.length + 1);
  const virtual = prefix === 'virtual' || body.startsWith('\0');
  const raw = body.replace(/^\0+/, '');
  const file = filePartOf(raw);
  const inner = file === null ? raw : pathIdOf(file.path, file.rest, root);
  const written = virtual ? `virtual:${inner}` : file === null ? `external:${raw}` : inner;
  return scrubbed(written, root, home);
}

/** The repository path of a bundled module inside a trade folder, or null (an outside id or another virtual one is none). */
export function tradeModuleOf(id: string, root: string = ROOT): string | null {
  const normal = moduleIdOf(id, root);
  const inner = normal.startsWith('virtual:') ? normal.slice('virtual:'.length) : normal;
  const path = inner.slice(inner.indexOf(':') + 1).replace(/[?#].*$/, '');
  if (inner.startsWith('repo:')) return TRADE_SOURCE.test(path) ? path : null;
  if (inner.startsWith('dependency:')) return LINKED_TRADE_SOURCE.test(path) ? path : null;
  return null;
}

// --- Privy's SDK and the alpha's own folders (F161 (4), SH-ALPHA-SITE) ----------------------------------------------

/** An installed package's folder, repository-relative: `node_modules/.pnpm/<folder>/node_modules/<name>`. */
const PNPM_PACKAGE = /^node_modules\/\.pnpm\/[^/]+\/node_modules\/(?:@[^/]+\/)?[^/]+/;
/** The installed package a repository path lies in, or null. */
export const packageKeyOf = (path: string): string | null => PNPM_PACKAGE.exec(path)?.[0] ?? null;

/**
 * F161 (4), SH-ALPHA-SITE: the installed packages Privy's SDK brings that the site's own code does not, each by its
 * folder (`packageKeyOf`): every `@privy-io/*` package and everything only they pull in. Read from the install itself:
 * the site's own packages are those reached from apps/web's dependencies of every kind (Privy's aside) and from the
 * workspace packages they name, following each installed package's own dependencies, which pnpm links beside it in its
 * folder. Privy's are those reached from `@privy-io/react-auth` the same way, less the site's. A checkout whose links
 * lag its lockfile (an install for one workspace package only) gives a wrong answer: install the whole workspace.
 */
export function privyOnlyPackages(root: string = ROOT): Set<string> {
  const pnpm = join(root, 'node_modules', '.pnpm');
  const keyOf = (dir: string): string | null => packageKeyOf(relative(root, dir).split(sep).join('/'));
  const linked = (folder: string): string[] => {
    if (!existsSync(folder)) return [];
    return readdirSync(folder).flatMap((name) => (name.startsWith('@') ? readdirSync(join(folder, name)).map((inner) => join(folder, name, inner)) : [join(folder, name)]))
      .flatMap((path) => { try { return [realpathSync(path)]; } catch { return []; } });
  };
  // The site's own manifest names its development dependencies too: the app's code imports some of them (viem).
  const manifestDeps = (dir: string, site: boolean): string[] => {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    const names = [...new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {}), ...(site ? Object.keys(manifest.devDependencies ?? {}) : [])])];
    const skipPrivy = site;
    return names.filter((name) => !(skipPrivy && name.startsWith('@privy-io/'))).flatMap((name) => { try { return [realpathSync(join(dir, 'node_modules', name))]; } catch { return []; } });
  };
  const reach = (starts: readonly string[]): Set<string> => {
    const seen = new Set<string>();
    const workspaces = new Set<string>();
    const queue = [...starts];
    while (queue.length > 0) {
      const dir = queue.shift() as string;
      const key = keyOf(dir);
      if (key !== null) {
        if (seen.has(key)) continue;
        seen.add(key);
        // pnpm links a package's dependencies beside it: `<folder>/node_modules/<dependency>`.
        const beside = join(pnpm, key.split('/')[2] as string, 'node_modules');
        queue.push(...linked(beside).filter((other) => other !== dir));
      } else if (within(dir, root) && !workspaces.has(dir) && existsSync(join(dir, 'package.json'))) {
        workspaces.add(dir);
        queue.push(...manifestDeps(dir, false));
      }
    }
    return seen;
  };
  const web = join(root, 'apps', 'web');
  const ours = reach(manifestDeps(web, true));
  const privy = existsSync(join(web, 'node_modules', '@privy-io', 'react-auth')) ? reach([realpathSync(join(web, 'node_modules', '@privy-io', 'react-auth'))]) : new Set<string>();
  return new Set([...privy].filter((key) => !ours.has(key) || /\/node_modules\/@privy-io\//.test(key)));
}

/** The installed package of a bundled module, repository-relative, from its written id; null for any other module. */
function bundledPackageOf(id: string): string | null {
  const normal = moduleIdOf(id);
  const inner = normal.startsWith('virtual:') ? normal.slice('virtual:'.length) : normal;
  if (!inner.startsWith('dependency:')) return null;
  return packageKeyOf(inner.slice('dependency:'.length).replace(/[?#].*$/, ''));
}

/** A bundled module of Privy's SDK (`@privy-io/*` or a package only it brings), as its package; null for any other. */
export function privyModuleOf(id: string, privy: ReadonlySet<string>): string | null {
  const key = bundledPackageOf(id);
  return key !== null && (privy.has(key) || /\/node_modules\/@privy-io\//.test(key)) ? key : null;
}

/** The alpha's own folders outside the trade code: the join page, the desk, their calls (F161 (4)). */
export const ALPHA_SOURCE = /^apps\/web\/src\/(?:[^/]+\/)*alpha-sepolia\//;
/** The browser suites' stand-ins inside a trade folder: never in a production build. */
export const STANDIN_SOURCE = /^(?:apps\/web\/src|packages\/[^/]+\/src)\/(?:[^/]+\/)*trade-sepolia\/(?:[^/]+\/)*test-support\//;

/** A bundled module's repository path when it is the repository's own (`repo:`), else null. */
function repoPathOf(id: string): string | null {
  const normal = moduleIdOf(id);
  const inner = normal.startsWith('virtual:') ? normal.slice('virtual:'.length) : normal;
  return inner.startsWith('repo:') ? inner.slice('repo:'.length).replace(/[?#].*$/, '') : null;
}

/** A build's chunks with their module ids in the written form (`moduleIdOf`). */
export const writtenChunks = (chunks: readonly BuiltChunk[]): BuiltChunk[] => chunks.map((chunk) => ({ fileName: chunk.fileName, moduleIds: chunk.moduleIds.map((id) => moduleIdOf(id)),
  ...(chunk.seamRuntime === undefined ? {} : { seamRuntime: Object.fromEntries(Object.entries(chunk.seamRuntime).map(([id, code]) => [moduleIdOf(id), code])) }),
  ...(chunk.seamCode === undefined ? {} : { seamCode: Object.fromEntries(Object.entries(chunk.seamCode).map(([id, code]) => [moduleIdOf(id), code])) }),
  ...(chunk.seamDependencies === undefined ? {} : { seamDependencies: Object.fromEntries(Object.entries(chunk.seamDependencies).map(([id, deps]) => [moduleIdOf(id), deps.map((dep) => moduleIdOf(dep))])) }) }));

export interface ModuleJudgement {
  readonly ok: boolean;
  readonly lines: string[];
  /** The Sepolia build's trade-folder modules in lazily loaded chunks (`chunk ← module`). */
  readonly lazy: string[];
  /** F161 (4): how many modules of Privy's SDK the Sepolia build holds, all in lazily loaded chunks. */
  readonly privy: number;
  /** SH-252: how many scripts outside the module list the examples manifest accepted (`exampleScriptsOf`). */
  readonly examples?: number;
}

/**
 * SH-252: the explainer's own scripts, copied into the app's public files (apps/web/public/examples, made and checked by
 * apps/web/build/examples-copy.mjs). They are no bundler chunk, so no module list names them. Such a script is accepted
 * only when all three hold: its path is under `examples/`; the committed examples manifest lists it with its SHA-256;
 * the file in the build hashes to exactly that. The manifest is read from the repository, never from the build being
 * judged, and a missing, unreadable or malformed one (an entry that is no plain path inside the folder, or one without
 * a SHA-256) fails the build. The content rules read these files like every other shipped file (`scanDirectory`).
 */
export const EXAMPLES_MANIFEST = join(ROOT, 'apps/web/build/examples-manifest.json');
export const EXAMPLES_PREFIX = 'examples/';
export type ExampleScripts = { readonly ok: true; readonly scripts: ReadonlyMap<string, string> } | { readonly ok: false; readonly problem: string };

/** The examples manifest's scripts (`examples/<path>` -> SHA-256), or why it cannot be read. */
export function exampleScriptsOf(path: string = EXAMPLES_MANIFEST): ExampleScripts {
  const named = relative(ROOT, path).startsWith('..') ? path : relative(ROOT, path);
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { ok: false, problem: `the examples manifest ${named} is missing or does not parse` };
  }
  const files = typeof manifest === 'object' && manifest !== null ? (manifest as { files?: unknown }).files : undefined;
  if (typeof files !== 'object' || files === null || Array.isArray(files)) return { ok: false, problem: `the examples manifest ${named} lists no files` };
  const scripts = new Map<string, string>();
  for (const [name, entry] of Object.entries(files as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_./-]+$/.test(name) || name.startsWith('/') || name.split('/').some((part) => part === '' || part === '.' || part === '..')) {
      return { ok: false, problem: `the examples manifest ${named} names ${JSON.stringify(name)}, a path that leaves ${EXAMPLES_PREFIX}` };
    }
    const sha = typeof entry === 'object' && entry !== null ? (entry as { sha256?: unknown }).sha256 : undefined;
    if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha)) return { ok: false, problem: `the examples manifest ${named} gives ${name} no SHA-256` };
    if (/\.[mc]?js$/i.test(name)) scripts.set(`${EXAMPLES_PREFIX}${name}`, sha);
  }
  return { ok: true, scripts };
}

/** SH-252: the verdict's words for the scripts the examples manifest accepted. */
export const examplesLineOf = (accepted: number): string => `${accepted} ${accepted === 1 ? 'script' : 'scripts'} outside the module list accepted by the examples manifest`;

let privyPackagesCache: Set<string> | null = null;
/** `privyOnlyPackages` of this repository, read once per run. */
const privyPackages = (): Set<string> => (privyPackagesCache ??= privyOnlyPackages());

/**
 * Fix round af1, F2: the bundler's module list, held to the target. A mainnet build holds no module from a trade folder;
 * the Sepolia build holds them in lazily loaded chunks only. The list must also be this build's: it names exactly the
 * scripts in the folder (.js, .mjs or .cjs in any letter case), so a missing, stale or partial list fails.
 * F161 (4), SH-ALPHA-SITE: a module of Privy's SDK (`privyModuleOf`) is a trade module too; a module of an
 * `alpha-sepolia` folder may not be in a mainnet build; a trade folder's `test-support` module (the suites' stand-in)
 * may not be in any production build.
 * SH-252: a script that is no chunk passes only as one of the examples' copied scripts (`exampleScriptsOf`).
 */
export function judgeModules(chunks: readonly BuiltChunk[] | null, target: Target, graph: LoadGraph, outDir: string, what: string, privy: ReadonlySet<string> = privyPackages(),
  examples: ExampleScripts = exampleScriptsOf()): ModuleJudgement {
  if (chunks === null) return { ok: false, lines: [`${what}: no module list for this build`], lazy: [], privy: 0 };
  const listed = new Set(chunks.map((chunk) => outputPath(chunk.fileName)));
  const scripts = walk(outDir).map((path) => outputPath(relative(outDir, path))).filter((file) => /\.[mc]?js$/i.test(file));
  const lines: string[] = [];
  // SH-252: the examples' copied scripts, each by the committed manifest's SHA-256; a manifest that cannot be read fails.
  if (!examples.ok) lines.push(`${what}: ${examples.problem}, so no script outside the module list can be accepted`);
  const accepted: string[] = [];
  const unlisted = scripts.filter((file) => {
    if (listed.has(file)) return false;
    if (!file.startsWith(EXAMPLES_PREFIX) || !examples.ok) return true;
    const expected = examples.scripts.get(file);
    if (expected === undefined) lines.push(`${what}: ${file} is no chunk of this build and the examples manifest does not list it`);
    else if (createHash('sha256').update(readFileSync(join(outDir, file))).digest('hex') !== expected) {
      lines.push(`${what}: ${file} is no chunk of this build and its bytes are not the ones the examples manifest lists (${expected})`);
    } else accepted.push(file);
    return false;
  });
  const missing = [...listed].filter((file) => !scripts.includes(file));
  if (chunks.length === 0 || unlisted.length > 0 || missing.length > 0) {
    lines.push(`${what}: the module list is not this build's (${chunks.length} chunks listed; scripts it does not list: ${unlisted.join(', ') || 'none'}; chunks it lists that are not there: ${missing.join(', ') || 'none'})`);
  }
  const lazy: string[] = [];
  let privyCount = 0;
  const privyChunks = new Set<string>();
  for (const chunk of chunks) {
    for (const id of chunk.moduleIds) {
      const repo = repoPathOf(id);
      if (repo !== null && STANDIN_SOURCE.test(repo)) {
        lines.push(`${what}: stand-in module ${chunk.fileName} ← ${repo} (no production build holds one)`);
        continue;
      }
      if (repo !== null && ALPHA_SOURCE.test(repo) && target === 'mainnet') {
        lines.push(`${what}: alpha module ${chunk.fileName} ← ${repo} (a mainnet build holds none)`);
        continue;
      }
      const folder = tradeModuleOf(id);
      const module = folder ?? privyModuleOf(id, privy);
      if (module === null) continue;
      const entry = `${chunk.fileName} ← ${module}`;
      if (target === 'sepolia' && graph.lazy.has(outputPath(chunk.fileName))) {
        if (folder !== null) lazy.push(entry);
        else { privyCount += 1; privyChunks.add(chunk.fileName); }
      } else lines.push(`${what}: trade module ${entry} (${target === 'mainnet' ? 'a mainnet build holds none' : `${loadOf(graph, chunk.fileName)}, not a lazily loaded chunk`})`);
    }
  }
  if (lines.length > 0) return { ok: false, lines, lazy, privy: privyCount, examples: accepted.length };
  const modules = chunks.reduce((sum, chunk) => sum + chunk.moduleIds.length, 0);
  const privyLine = privyCount === 0 ? '' : `, and ${privyCount} modules of Privy's SDK in ${privyChunks.size} lazily loaded chunks`;
  return { ok: true, lines: [`${what}: ${modules} modules in ${chunks.length} chunks, ${lazy.length === 0 && privyCount === 0 ? 'none from a trade folder' : `trade modules in lazily loaded chunks only (${lazy.join(', ')})${privyLine}`}`, `${what}: ${examplesLineOf(accepted.length)}`], lazy, privy: privyCount, examples: accepted.length };
}

// --- the reveal session's test seam (SH-203, SH-202 af3) ----------------------------------------------------------

/** The app's test support: a `*.test-support.*` module or anything in a `test-support/` folder under apps/web/src. */
export const WEB_TEST_SUPPORT = /^apps\/web\/src\/(?:(?:[^/]+\/)*test-support\/|(?:[^/]+\/)*[^/]+\.test-support\.[cm]?[jt]sx?$)/;
/** The production seam: an inert lookup, the one reveal seam module a build may hold. */
export const REVEAL_SEAM_MODULE = 'apps/web/src/features/core/v2/reveal-test-seam.ts';
/** What only the test seam names: its installer, its authorization helper and its module (minifying keeps strings, and exported names in a chunk's exports). */
export const REVEAL_SEAM_MARKERS: readonly string[] = Object.freeze(['installRevealTestSeam', 'authorizeRevealTestTarget', 'reveal-test-seam.test-support']);

// Read every runtime export form. An unfamiliar form fails closed; type-only exports are erased.
export function revealSeamExports(text: string): readonly string[] {
  const source = ts.createSourceFile(REVEAL_SEAM_MODULE, text, ts.ScriptTarget.Latest, true);
  return source.statements.flatMap((statement) => {
    if (ts.isExportAssignment(statement)) return ['<unsupported export>'];
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) return [];
      if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) return ['<unsupported export>'];
      // Keep an alias’s local binding too: exporting the initializer under another name must still fail.
      return statement.exportClause.elements.filter(e => !e.isTypeOnly).flatMap(e =>
        e.propertyName && e.propertyName.text !== e.name.text ? [e.name.text, e.propertyName.text] : [e.name.text]);
    }
    if (!ts.canHaveModifiers(statement) || !ts.getModifiers(statement)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) return [];
    if (ts.getModifiers(statement)?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) return ['<unsupported export>'];
    if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.map(d => ts.isIdentifier(d.name) ? d.name.text : '<unsupported export>');
    if (ts.isFunctionDeclaration(statement) && statement.name) return [statement.name.text];
    return ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) ? [] : ['<unsupported export>'];
  });
}
export const REVEAL_SEAM_EXPORTS = revealSeamExports(readFileSync(join(ROOT, REVEAL_SEAM_MODULE), 'utf8'));
type SeamNode = { readonly type: string; readonly [key: string]: unknown };
const inertReturn = (node: SeamNode | null | undefined): boolean => node === null || node === undefined
  || (node.type === 'Identifier' && node.name === 'undefined')
  || (node.type === 'UnaryExpression' && node.operator === 'void' && (node.argument as SeamNode).type === 'Literal');
const inertFunction = (node: SeamNode | null | undefined): boolean => {
  if (!node || !['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(node.type) || node.async || node.generator) return false;
  if (!(node.params as SeamNode[]).every((param) => param.type === 'Identifier' && param.name !== 'undefined')) return false;
  if ((node.id as SeamNode | undefined)?.name === 'undefined') return false;
  const body = node.body as SeamNode;
  if (body.type !== 'BlockStatement') return inertReturn(body);
  const statements = body.body as SeamNode[];
  return statements.length === 0 || (statements.length === 1 && statements[0]?.type === 'ReturnStatement' && inertReturn(statements[0].argument as SeamNode | null));
};
/** Rolldown's module-local lazy initializer. Admit only its self-replacement and one inert assignment per bare var. */
function inertLazySeam(statements: readonly SeamNode[]): boolean {
  const names = new Set<string>();
  let initializer: SeamNode | undefined;
  for (const statement of statements) {
    if (statement.type === 'FunctionDeclaration' && !initializer) initializer = statement;
    else if (statement.type === 'VariableDeclaration' && statement.kind === 'var') {
      for (const declaration of statement.declarations as SeamNode[]) {
        const id = declaration.id as SeamNode;
        if (id.type !== 'Identifier' || id.name === 'undefined' || declaration.init !== null || names.has(id.name as string)) return false;
        names.add(id.name as string);
      }
    } else return false;
  }
  if (!initializer || names.size === 0 || initializer.async || initializer.generator || (initializer.params as SeamNode[]).length !== 0) return false;
  const name = (initializer.id as SeamNode).name as string;
  if (name === 'undefined' || name === '__esmMin' || names.has(name) || REVEAL_SEAM_EXPORTS.includes(name)
    || names.has('__esmMin') || REVEAL_SEAM_EXPORTS.length === 0 || !REVEAL_SEAM_EXPORTS.every((exported) => names.has(exported))) return false;
  const body = (initializer.body as SeamNode).body as SeamNode[];
  if (body.length !== 1 || body[0]?.type !== 'ReturnStatement') return false;
  const invoke = body[0].argument as SeamNode | null;
  if (invoke?.type !== 'CallExpression' || invoke.optional || (invoke.arguments as SeamNode[]).length !== 0) return false;
  const replace = invoke.callee as SeamNode;
  if (replace.type !== 'AssignmentExpression' || replace.operator !== '='
    || (replace.left as SeamNode).type !== 'Identifier' || (replace.left as SeamNode).name !== name) return false;
  const helper = replace.right as SeamNode;
  if (helper.type !== 'CallExpression' || helper.optional || (helper.callee as SeamNode).type !== 'Identifier'
    || (helper.callee as SeamNode).name !== '__esmMin') return false;
  const args = helper.arguments as SeamNode[];
  const callback = args[0];
  if (args.length !== 1 || callback?.type !== 'ArrowFunctionExpression' || callback.async
    || (callback.params as SeamNode[]).length !== 0 || (callback.body as SeamNode).type !== 'BlockStatement') return false;
  const assigned = new Set<string>();
  for (const statement of (callback.body as SeamNode).body as SeamNode[]) {
    if (statement.type !== 'ExpressionStatement') return false;
    const assignment = statement.expression as SeamNode;
    if (assignment.type !== 'AssignmentExpression' || assignment.operator !== '=' || (assignment.left as SeamNode).type !== 'Identifier') return false;
    const binding = (assignment.left as SeamNode).name as string;
    if (!names.has(binding) || assigned.has(binding) || !inertFunction(assignment.right as SeamNode)) return false;
    // No nested parameter/name may shadow the bundler helper either.
    if (JSON.stringify(assignment.right).includes('"name":"__esmMin"')) return false;
    assigned.add(binding);
  }
  return assigned.size === names.size;
}
/**
 * SH-203 af1: whether a seam module's rendered code is inert: nothing but declarations of functions that take plain
 * parameters and return nothing (an empty body, `undefined` or `void 0`), or af3's exact lazy initializer above.
 * No registry or other implementation. Empty or missing code is not proof. Judged on the module's rendered code.
 */
export function inertSeamCode(code: string | null): boolean {
  if (code === null || code.trim() === '') return false;
  let program: SeamNode;
  try { program = parseAst(code) as unknown as SeamNode; } catch { return false; }
  const statements = program.body as SeamNode[];
  if (statements.some((s) => s.type === 'VariableDeclaration' && (s.declarations as SeamNode[]).some((d) => d.init === null))) return inertLazySeam(statements);
  const bindings = new Set<string>();
  for (const statement of program.body as SeamNode[]) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration as SeamNode | null : statement;
    if (declaration?.type === 'FunctionDeclaration') bindings.add((declaration.id as SeamNode).name as string);
    if (declaration?.type === 'VariableDeclaration') for (const d of declaration.declarations as SeamNode[]) bindings.add((d.id as SeamNode).name as string);
  }
  if (bindings.size === 0 || bindings.has('undefined')) return false;
  const inertStatement = (statement: SeamNode): boolean => {
    if (statement.type === 'EmptyStatement') return true;
    if (statement.type === 'FunctionDeclaration') return inertFunction(statement);
    if (statement.type === 'VariableDeclaration') return (statement.declarations as SeamNode[]).every((d) => (d.id as SeamNode).type === 'Identifier' && inertFunction(d.init as SeamNode | null));
    if (statement.type === 'ExportNamedDeclaration') return statement.declaration ? inertStatement(statement.declaration as SeamNode)
      : statement.source === null && (statement.specifiers as SeamNode[]).every((specifier) => bindings.has((specifier.local as SeamNode).name as string));
    return false;
  };
  return (program.body as SeamNode[]).every(inertStatement);
}

/** The runtime must actually define the helper, not merely mention or import it. */
function hasLazyRuntime(code: string | null): boolean {
  if (!code) return false;
  try {
    const program = parseAst(code) as unknown as SeamNode;
    return (program.body as SeamNode[]).some((s) => {
      const d = s.type === 'ExportNamedDeclaration' ? s.declaration as SeamNode | null : s;
      return d?.type === 'VariableDeclaration' && (d.declarations as SeamNode[]).some((v) =>
        (v.id as SeamNode).type === 'Identifier' && (v.id as SeamNode).name === '__esmMin'
        && ['ArrowFunctionExpression', 'FunctionExpression'].includes((v.init as SeamNode | null)?.type ?? ''));
    });
  } catch { return false; }
}

/**
 * The `reveal-seam` rule: no module of the app's test support in any chunk (the seam's installer, registry and
 * authorization helper live in one), no shipped script naming a seam marker, and the one seam module a build may hold
 * (`REVEAL_SEAM_MODULE`) and its resolved dependencies inert by their rendered code (`inertSeamCode`).
 * Missing code or graph records fail. A re-export cannot hide its implementation in an ordinary module.
 */
export function judgeRevealSeam(chunks: readonly BuiltChunk[] | null, outDir: string, what: string): { readonly ok: boolean; readonly lines: string[] } {
  if (chunks === null) return { ok: false, lines: [`${what}: no module list for this build`] };
  const problems: string[] = [];
  let inert = 0;
  for (const chunk of chunks) {
    const roots = Object.keys(chunk.seamDependencies ?? {}).filter((id) => repoPathOf(id) === REVEAL_SEAM_MODULE);
    for (const id of new Set([...chunk.moduleIds, ...roots])) {
      const repo = repoPathOf(id);
      if (repo === null) continue;
      if (WEB_TEST_SUPPORT.test(repo)) problems.push(`${what}: test-support module ${chunk.fileName} ← ${repo} (no production build holds one)`);
      else if (repo === REVEAL_SEAM_MODULE) {
        const visited = new Set<string>();
        const inspect = (module: string): void => {
          if (visited.has(module)) return;
          visited.add(module);
          const shown = repoPathOf(module) ?? module;
          const code = chunk.seamCode?.[module];
          const deps = chunk.seamDependencies?.[module];
          if (code === undefined || code === null || code.trim() === '') problems.push(`${what}: ${chunk.fileName} ← ${shown} without its rendered code (its inertness is unknown)`);
          else if (!inertSeamCode(code)) problems.push(`${what}: ${chunk.fileName} ← ${shown} is not inert as built (more than functions returning nothing)`);
          if (deps === undefined) problems.push(`${what}: ${chunk.fileName} ← ${shown} without its resolved dependencies (its implementation is unknown)`);
          else deps.forEach(inspect);
        };
        inspect(id);
        const runtime = Object.entries(chunk.seamRuntime ?? {});
        const runtimeListed = chunks.some(c => c.moduleIds.some(module => moduleIdOf(module) === moduleIdOf('\0rolldown/runtime.js')));
        if (runtimeListed && runtime.length === 0) problems.push(`${what}: the listed Rolldown runtime has no rendered record`);
        if (runtime.length > 0 && !runtime.some(([runtimeId, code]) => moduleIdOf(runtimeId) === moduleIdOf('\0rolldown/runtime.js') && hasLazyRuntime(code))) {
          problems.push(`${what}: the recorded Rolldown runtime has no __esmMin definition`);
        }
        inert += 1;
      }
    }
  }
  const scripts = existsSync(outDir) ? walk(outDir).filter((path) => /\.[mc]?js$/i.test(path)) : [];
  for (const path of scripts) {
    const text = readFileSync(path, 'utf8');
    for (const marker of REVEAL_SEAM_MARKERS) if (text.includes(marker)) problems.push(`${what}: ${outputPath(relative(outDir, path))} names ${marker} (the reveal test seam)`);
  }
  if (problems.length > 0) return { ok: false, lines: problems };
  return { ok: true, lines: [`${what}: no test seam installer, registry or test support; ${inert === 0 ? 'no reveal seam module bundled' : 'the seam lookup only, inert as built'}`] };
}

/** SH-203: the seam build (`--mode test`), held to the `reveal-seam` rule. */
function checkSeam(run: string, target: Target, deps: CheckDeps): { readonly ok: boolean; readonly lines: string[] } {
  const seam = seamOf(run);
  const shown = relative(process.cwd(), seam.out);
  const what = `reveal-seam, the ${target} build in --mode test (${shown.startsWith('..') ? seam.out : shown})`;
  mkdirSync(seam.record);
  const chunks = writtenChunks(deps.build(seam.out, {}, seam.record, 'seam'));
  if (!existsSync(join(seam.out, 'index.html'))) return { ok: false, lines: [`${what}: not built (no index.html), so this run proves nothing about it`] };
  return judgeRevealSeam(chunks, seam.out, what);
}

/** The alpha's two pages, as build/alpha-pages.ts writes them. */
export const ALPHA_PAGES: readonly string[] = Object.freeze(['join', 'desk']);

/**
 * F161 (4), SH-ALPHA-SITE: the `alpha` and `standin` rules. A mainnet build holds no call of our alpha-api (`/alpha/`,
 * `/desk/api/`) and neither alpha page (no file under `join/` or `desk/`); the Sepolia build holds both pages. No
 * production build holds a trace of the suites' Privy stand-in.
 */
export function judgeAlpha(findings: readonly Finding[], target: Target, outDir: string, what: string): { readonly ok: boolean; readonly lines: string[] } {
  const stray = findings.filter((finding) => finding.rule === 'standin' || (finding.rule === 'alpha' && target === 'mainnet'));
  const problems = stray.map(formatFinding);
  const files = existsSync(outDir) ? walk(outDir).map((path) => outputPath(relative(outDir, path))) : [];
  for (const page of ALPHA_PAGES) {
    const own = files.filter((file) => file.startsWith(`${page}/`));
    if (target === 'mainnet' && own.length > 0) problems.push(`${what}: the alpha's ${page} page (${own.length} files under ${page}/) where a mainnet build holds none`);
    if (target === 'sepolia' && !files.includes(`${page}/index.html`)) problems.push(`${what}: the Sepolia build holds no ${page}/index.html (build/alpha-pages.ts)`);
  }
  if (stray.length > 0) problems.push(`${what}: ${stray.length} ${stray.length === 1 ? 'trace' : 'traces'} of the alpha's calls or its stand-in where ${target === 'mainnet' ? 'a mainnet build holds none' : 'no production build holds one'}`);
  if (problems.length > 0) return { ok: false, lines: problems };
  return { ok: true, lines: [target === 'mainnet' ? `${what}: no alpha page, call or stand-in` : `${what}: the join and desk pages, no stand-in`] };
}

// --- production notices (SH-025 / G07, SH-NOTICES-RELEASE-CHECK) ----------------------------------------------------

// Keep the plugin's policy: every identifier must be allowed, including both arms of OR. The parity test pins this
// list to build/third-party-notices.ts; that file is outside this ticket's owned files.
const NOTICE_LICENSES = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'OFL-1.1', '0BSD', 'Unlicense', 'CC0-1.0', 'BlueOak-1.0.0']);
function allowedNoticeLicense(expression: string): boolean {
  const tokens = expression.match(/[A-Za-z0-9.+-]+|[()]/g) ?? [];
  if (tokens.join('') !== expression.replace(/\s/g, '')) return false;
  let cursor = 0;
  const atom = (): boolean => {
    const token = tokens[cursor++];
    if (token === '(') return sequence() && tokens[cursor++] === ')';
    return token !== undefined && NOTICE_LICENSES.has(token);
  };
  const sequence = (): boolean => {
    if (!atom()) return false;
    while (tokens[cursor] === 'AND' || tokens[cursor] === 'OR') {
      cursor++;
      if (!atom()) return false;
    }
    return true;
  };
  return sequence() && cursor === tokens.length;
}

/** Package names and versions from the files the bundler resolved, including pnpm and nested metadata manifests. */
function bundledPackages(chunks: readonly BuiltChunk[]): Set<string> {
  const packages = new Set<string>();
  const seen = new Set<string>();
  for (const { moduleIds } of chunks) for (const id of moduleIds) {
    const normal = moduleIdOf(id);
    // The notices plugin inventories concrete files; virtual helpers/proxies do not contribute their own package.
    if (!/^(?:repo|dependency):/.test(normal)) continue;
    const path = normal.slice(normal.indexOf(':') + 1).replace(/[?#].*$/, '');
    if (!path.split('/').includes('node_modules')) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    const file = resolve(ROOT, path);
    if (!existsSync(file)) throw new Error(`cannot read bundled package metadata for ${path}`);
    let dir = dirname(realpathSync(file));
    let found = false;
    while (dirname(dir) !== dir && basename(dir) !== 'node_modules') {
      const manifest = join(dir, 'package.json');
      if (existsSync(manifest)) {
        let data: { name?: unknown; version?: unknown };
        try { data = JSON.parse(readFileSync(manifest, 'utf8')) as typeof data; }
        catch { throw new Error(`cannot read bundled package metadata for ${path}`); }
        // F161 (4): a subpath's own `private: true` manifest (preact/hooks) belongs to its package, as the plugin reads it.
        if (typeof data?.name === 'string' && data.name && (data as { private?: unknown }).private !== true) {
          if (typeof data.version !== 'string' || !data.version) throw new Error(`missing package version for ${data.name}`);
          packages.add(`${data.name}@${data.version}`);
          found = true;
          break;
        }
      }
      dir = dirname(dir);
    }
    if (!found) throw new Error(`missing package metadata for ${path}`);
  }
  return packages;
}

/**
 * Read the plugin's declarations and content-addressed texts, checking one build (the caller's or its twin).
 * Report the first omission in one plain line. This also runs on --no-build; its module list is trusted only after
 * the existing output/target/hash checks. CSS-only font inputs need not survive in that list, so the packaged font
 * is required independently, with the installed LICENSE's complete bytes and copyright lines.
 */
function checkNotices(outDir: string, chunks: readonly BuiltChunk[] | null, what: string): { readonly ok: boolean; readonly lines: string[] } {
  const root = checkNoticesFile(outDir, 'third-party-notices.txt', chunks, what);
  // F161 (4), SH-ALPHA-SITE: each alpha page carries its own copy, for the packages its own chunks bundle.
  const pages = ALPHA_PAGES.filter((page) => existsSync(join(outDir, page, 'index.html')))
    .map((page) => checkNoticesFile(outDir, `${page}/assets/third-party-notices.txt`, (chunks ?? []).filter((chunk) => chunk.fileName.startsWith(`${page}/`)), what));
  return { ok: root.ok && pages.every((page) => page.ok), lines: [...root.lines, ...pages.flatMap((page) => page.lines)] };
}

function checkNoticesFile(outDir: string, name: string, chunks: readonly BuiltChunk[] | null, what: string): { readonly ok: boolean; readonly lines: string[] } {
  const fail = (problem: string) => ({ ok: false, lines: [`notices, ${what}: ${name}: ${problem.replace(/[\r\n]+/g, ' ')}`] });
  const path = join(outDir, name);
  if (!existsSync(path)) return fail('missing file');
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return fail('cannot read file'); }
  if (!text.trim()) return fail('empty file');
  const headers = [...text.matchAll(/^Text: (sha256:[0-9a-f]{64})\n/gm)];
  const declarations = text.slice(0, headers[0]?.index ?? text.length);
  const entries = new Map<string, { license: string; body: string; refs: string[] }>();
  for (const entry of declarations.matchAll(/^Package: ([^\r\n]+)\n([\s\S]*?)(?=^Package: |$(?![\s\S]))/gm)) {
    const key = entry[1] as string;
    const body = entry[2] as string;
    if (!/^(?:@[^\s/@]+\/)?[^\s/@]+@[^\s@]+$/.test(key)) return fail('invalid package name or version');
    if (entries.has(key)) return fail(`duplicate package ${key}`);
    const licenses = [...body.matchAll(/^License: ([^\r\n]+)$/gm)];
    if (licenses.length !== 1) return fail(`missing license for ${key}`);
    const license = licenses[0]?.[1] ?? '';
    const own = key.startsWith('@squarehole/') && license === 'Square Hole workspace (ours)';
    if (!own && !allowedNoticeLicense(license)) return fail(`license ${JSON.stringify(license)} is not allowed for ${key}`);
    const refs: string[] = [];
    for (const line of body.split('\n').filter((line) => /^(?:License (?:file|text):|Notice file:|Source header)/.test(line))) {
      const ref = / -> (sha256:[0-9a-f]{64})$/.exec(line)?.[1];
      if (ref === undefined) return fail(`invalid text reference for ${key}`);
      refs.push(ref);
    }
    if (!own && !/^License (?:file|text): [^\r\n]+ -> sha256:[0-9a-f]{64}$/m.test(body)) return fail(`missing license text reference for ${key}`);
    entries.set(key, { license, body, refs });
  }
  let required: Set<string>;
  try { required = bundledPackages(chunks ?? []); }
  catch (error) { return fail((error as Error).message); }
  // The font is imported by packages/design/src/styles/index.css, outside the JS chunk module list.
  const fontRoot = join(ROOT, 'packages/design/node_modules/@fontsource-variable/plus-jakarta-sans');
  let font: { name: string; version: string };
  let fontText: string;
  try {
    font = JSON.parse(readFileSync(join(fontRoot, 'package.json'), 'utf8')) as typeof font;
    fontText = readFileSync(join(fontRoot, 'LICENSE'), 'utf8');
  } catch { return fail('cannot read the packaged font metadata or LICENSE'); }
  const fontKey = `${font.name}@${font.version}`;
  required.add(fontKey);
  for (const key of required) if (!entries.has(key)) return fail(`missing package ${key}`);
  const texts = new Map<string, string>();
  for (const [index, header] of headers.entries()) {
    const key = header[1] as string;
    const body = text.slice(header.index + header[0].length, headers[index + 1]?.index ?? text.length);
    // The writer appends a separator LF, plus one LF when the original text has no trailing LF. Preserve CRLF and
    // every original byte: only one of these two candidates can have the declared digest.
    const original = [body.slice(0, -1), body.slice(0, -2)].find((candidate) => candidate.trim() && `sha256:${createHash('sha256').update(candidate).digest('hex')}` === key);
    if (original === undefined) return fail(`missing or changed text ${key}`);
    if (texts.has(key)) return fail(`duplicate text ${key}`);
    texts.set(key, original);
  }
  for (const [key, entry] of entries) for (const ref of entry.refs) if (!texts.has(ref)) return fail(`missing or changed text ${ref} for ${key}`);
  const fontEntry = entries.get(fontKey) as NonNullable<ReturnType<typeof entries.get>>;
  if (fontEntry.license !== 'OFL-1.1') return fail(`missing OFL-1.1 license for ${fontKey}`);
  const fontLicenseRefs = [...fontEntry.body.matchAll(/^License file: [^\r\n]+ -> (sha256:[0-9a-f]{64})$/gm)].map((match) => match[1] as string);
  if (!fontText.trim() || !fontLicenseRefs.some((ref) => texts.get(ref) === fontText)) return fail(`missing complete OFL-1.1 text for ${fontKey}`);
  const copyrights = fontText.split(/\r?\n/).filter((line) => /^(?:Copyright\b.*(?:\d|\(c\))|©)/i.test(line));
  if (copyrights.length === 0 || copyrights.some((line) => !fontEntry.body.split('\n').includes(line))) return fail(`missing font copyright for ${fontKey}`);
  return { ok: true, lines: [] };
}

/**
 * How a build about to be uploaded differs from the scanned one: each file of any kind missing on either side or with
 * other bytes (fix round af1: source maps count too; the scanned folder has none, the check moves its own out).
 * Empty: the upload is the scanned site.
 */
export function differences(scanned: string, shipped: string): string[] {
  const listOf = (dir: string) => new Set(walk(dir).map((path) => relative(dir, path)));
  const a = listOf(scanned);
  const b = listOf(shipped);
  const out: string[] = [];
  for (const file of [...new Set([...a, ...b])].sort()) {
    if (!a.has(file)) out.push(`only in ${shipped}: ${file}`);
    else if (!b.has(file)) out.push(`missing from ${shipped}: ${file}`);
    else if (!readFileSync(join(scanned, file)).equals(readFileSync(join(shipped, file)))) out.push(`differs: ${file}`);
  }
  return out;
}

/** The distinct placeholders among some findings, each once with its count and the source it comes from. */
export function placeholderList(findings: readonly Finding[]): string[] {
  const seen = new Map<string, { count: number; source: string }>();
  for (const finding of findings) {
    if (finding.rule !== 'placeholder') continue;
    const entry = seen.get(finding.match);
    seen.set(finding.match, { count: (entry?.count ?? 0) + 1, source: entry?.source ?? finding.source?.file ?? finding.file });
  }
  return [...seen].map(([text, { count, source }]) => `  ${count > 1 ? `${count}× ` : ''}${text}  (${source})`);
}

/** Notes (names in code) per source file, the most first. */
function noteSummary(notes: readonly Finding[]): string[] {
  const counts = new Map<string, number>();
  for (const note of notes) {
    const key = note.source?.file ?? note.file;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([file, n]) => `  ${String(n).padStart(4)}  ${file}`);
}

/**
 * What a run needs from outside (fix round af1, F3): the build variables, the builds, the fixture addresses and two
 * output lines. `runCheck` takes them, so a test can stand in for the builds; the command passes `COMMAND`.
 */
export interface CheckDeps {
  readonly env: Env;
  /** apps/web, which every `--out` lies inside, and the check's own root (fix round af2, F1). */
  readonly home: Home;
  /**
   * Builds the production site into a folder; `overrides` holds only the twin's `SH_TARGET`; `record` is a folder of
   * this run's, for the build's raw list and maps; `role` says which build it is. Returns the module list.
   */
  readonly build: (outDir: string, overrides: Readonly<Record<string, string>>, record: string, role: BuildRole) => readonly BuiltChunk[];
  readonly fixtures: () => ReadonlySet<string>;
  readonly warn: (line: string) => void;
  readonly error: (line: string) => void;
}

export const COMMAND: CheckDeps = {
  env: process.env,
  home: HOME,
  build: (outDir, overrides, record, role) => buildProduction(outDir, overrides, process.env, record, role),
  fixtures: () => fixtureOnlyAddresses(),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
};

/** The other target's build (F156), held to the trade rule and the production notices requirement. */
function checkTwin(run: string, twinTarget: Target, deps: CheckDeps): { readonly ok: boolean; readonly lines: string[] } {
  const twin = twinOf(run, twinTarget);
  const shown = relative(process.cwd(), twin.out);
  const what = `the ${twinTarget} twin (${shown.startsWith('..') ? twin.out : shown})`;
  mkdirSync(twin.record);
  const chunks = writtenChunks(deps.build(twin.out, { SH_TARGET: twinTarget }, twin.record, 'twin'));
  if (!existsSync(join(twin.out, 'index.html'))) return { ok: false, lines: [`trade, ${what}: not built (no index.html), so this run proves nothing about it`] };
  const graph = loadGraph(twin.out);
  const findings = scanDirectory(twin.out, new Set(), TWIN_RULES);
  const files = findings.filter((finding) => finding.rule === 'source-map' || finding.rule === 'packed').map(formatFinding);
  const trade = tradeReport(judgeTrade(findings, twinTarget, graph), graph, `trade, ${what}`);
  const modules = judgeModules(chunks, twinTarget, graph, twin.out, `modules, ${what}`);
  // F161 (4): the alpha's pages and calls follow the twin's target too.
  const alpha = judgeAlpha(findings, twinTarget, twin.out, `alpha, ${what}`);
  const notices = checkNotices(twin.out, chunks, what);
  // SH-203 af1: the twin is held to the reveal-seam rule as well.
  const seam = judgeRevealSeam(chunks, twin.out, `reveal-seam, ${what}`);
  return { ok: files.length === 0 && trade.ok && modules.ok && alpha.ok && notices.ok && seam.ok, lines: [...files, ...trade.lines, ...modules.lines, ...alpha.lines, ...notices.lines, ...seam.lines] };
}

export function runCheck(argv: readonly string[], deps: CheckDeps = COMMAND): number {
  const outAt = argv.indexOf('--out');
  const outDir = outOf(resolve(outAt >= 0 && argv[outAt + 1] ? argv[outAt + 1] as string : DEFAULT_OUT_DIR), deps.home);
  const target = targetOf(deps.env);
  const build = !argv.includes('--no-build');
  let chunks: readonly BuiltChunk[] | null = null;
  let run: string | null = null;
  const listProblems: string[] = [];
  if (build) {
    // Fix round af3, F1: a new run folder for this build; no earlier one is reused or emptied.
    run = newRun(outDir, deps.home);
    chunks = writtenChunks(deps.build(outDir, {}, run, 'build'));
    if (!existsSync(join(outDir, 'index.html'))) throw new Error(`No build in ${outDir}`);
    writeModuleList(run, outDir, target, chunks, deps.home);
    writePointer(outDir, run, deps.home);
  } else {
    if (!existsSync(join(outDir, 'index.html'))) throw new Error(`No build in ${outDir}`);
    // Fix round af2, F2 and af3, F1: the latest run the pointer names for this output, and its list only when every
    // file is the one it hashed, for this output and this target.
    const pointed = pointedRun(outDir, deps.home);
    const list = 'run' in pointed ? readModuleList(listOf(pointed.run)) : null;
    const mismatches = list === null ? [] : listMismatches(list, outDir, target, deps.home);
    if (!('run' in pointed)) listProblems.push(`modules, this ${target} build: ${pointed.problem}`);
    else if (list === null) listProblems.push(`modules, this ${target} build: no module list in the run the pointer names`);
    else if (mismatches.length > 0) listProblems.push(`modules, this ${target} build: the module list is not this folder's build: ${mismatches.slice(0, 12).join('; ')}${mismatches.length > 12 ? `; ${mismatches.length - 12} more` : ''}`);
    else {
      chunks = list.chunks;
      run = pointed.run;
    }
  }
  const findings = scanDirectory(outDir, deps.fixtures(), RULES, run === null ? null : mapsOf(run));
  const files = walk(outDir).length;
  const graph = loadGraph(outDir);
  const tradeJudgement = judgeTrade(findings, target, graph);
  const trade = tradeReport(tradeJudgement, graph, `trade, this ${target} build`);
  const modules = listProblems.length > 0 ? { ok: false, lines: listProblems, lazy: [], privy: 0, examples: 0 } : judgeModules(chunks, target, graph, outDir, `modules, this ${target} build`);
  // F161 (4), SH-ALPHA-SITE: the alpha's pages and calls, by the target.
  const alpha = judgeAlpha(findings, target, outDir, `alpha, this ${target} build`);
  const notices = checkNotices(outDir, chunks, `this ${target} build`);
  // SH-203: the reveal test seam, in this build and in the same target built with --mode test.
  const seam = listProblems.length > 0 ? { ok: false, lines: listProblems.map((line) => line.replace(/^modules,/, 'reveal-seam,')) } : judgeRevealSeam(chunks, outDir, `reveal-seam, this ${target} build`);
  // F156: the other target, held to the trade rule and notices requirement (its other rules are its own run's).
  const twinTarget: Target = target === 'mainnet' ? 'sepolia' : 'mainnet';
  const twin = build && run !== null ? checkTwin(run, twinTarget, deps) : { ok: true, lines: [`trade, the ${twinTarget} twin: neither built nor checked (--no-build)`] };
  // SH-203: after the twin, the same target once more in --mode test.
  const seamTest = build && run !== null ? checkSeam(run, target, deps) : { ok: true, lines: [`reveal-seam, the ${target} build in --mode test: neither built nor checked (--no-build)`] };
  const { failing, allowed, notes, stale, over } = judge(findings.filter((finding) => finding.rule !== 'trade' && finding.rule !== 'alpha' && finding.rule !== 'standin'), allowancesFor(target));
  if (argv.includes('--notes')) {
    for (const note of notes) deps.warn(formatFinding(note));
    deps.warn(`Notes (Demo words as names in code, not shipped text), by source:\n${noteSummary(notes).join('\n')}`);
    for (const { finding } of allowed) deps.warn(formatFinding(finding));
  }
  const byAllowance = new Map<Allowance, number>();
  for (const { allowance } of allowed) byAllowance.set(allowance, (byAllowance.get(allowance) ?? 0) + 1);
  for (const [allowance, n] of byAllowance) deps.warn(`allowed ${String(n).padStart(3)}  ${String(allowance.source)}: ${allowance.reason}`);
  for (const allowance of stale) deps.warn(`stale allowance (matched nothing; remove it): ${String(allowance.source)}`);
  for (const { allowance, count } of over) deps.error(`allowance over its max (${count} found, at most ${String(allowance.max)}; its findings fail): ${String(allowance.source)}`);
  for (const report of [trade, modules, alpha, notices, twin, seam, seamTest]) for (const line of report.lines) (report.ok ? deps.warn : deps.error)(line);
  const tradeOk = trade.ok && modules.ok && alpha.ok && twin.ok;
  const noteLine = `${notes.length} ${notes.length === 1 ? 'name' : 'names'} in code noted, ${allowed.length} allowed (--notes lists them)`;
  const sameAt = argv.indexOf('--same-as');
  const shipped = sameAt >= 0 && argv[sameAt + 1] ? resolve(argv[sameAt + 1] as string) : null;
  if (sameAt >= 0 && shipped === null) throw new Error('--same-as needs a directory');
  const changed = shipped === null ? [] : existsSync(join(shipped, 'index.html')) ? differences(outDir, shipped) : [`no build in ${shipped}`];
  for (const line of changed) deps.error(`not the scanned build: ${line}`);
  const sameLine = shipped === null ? '' : changed.length === 0 ? `; ${relative(process.cwd(), shipped) || '.'} is the scanned build, file for file` : '';
  const tradeLine = `${target === 'mainnet' ? 'no trade marker or module, no alpha page or call' : 'trade markers and modules in lazily loaded chunks only, the alpha\'s join and desk pages'}${build ? `, the ${twinTarget} twin passing the trade rule` : ''}`;
  const seamOk = seam.ok && seamTest.ok;
  // SH-252: how many of this build's scripts the examples manifest accepted, in every verdict line.
  const examplesLine = examplesLineOf(modules.examples ?? 0);
  if (failing.length === 0 && changed.length === 0 && tradeOk && notices.ok && seamOk) {
    deps.warn(`check:production: ${files} shipped files (${target}), no Demo or local-chain trace in text, no Demo, loopback or fixture address, no open legal placeholder, ${tradeLine}; ${examplesLine}; ${noteLine}${sameLine}.`);
    return 0;
  }
  const counts = new Map<string, number>();
  const alphaFailing = findings.filter((finding) => finding.rule === 'standin' || (finding.rule === 'alpha' && target === 'mainnet'));
  for (const finding of [...failing, ...tradeJudgement.failing, ...alphaFailing]) counts.set(finding.rule, (counts.get(finding.rule) ?? 0) + 1);
  for (const finding of failing) if (finding.rule !== 'placeholder') deps.error(formatFinding(finding));
  const open = placeholderList(failing);
  if (open.length > 0) {
    deps.error(`Open items in the production Terms and privacy notice, for the founder and counsel to fill or strike (docs/evidence/SH-V2-FE10.md lists them):`);
    for (const line of open) deps.error(line);
  }
  const differ = changed.length === 0 ? '' : `; ${changed.length} ${changed.length === 1 ? 'file differs' : 'files differ'} from ${String(shipped)}`;
  const tradeFail = [...(trade.ok ? [] : ['this build fails the trade rule']), ...(modules.ok ? [] : ['its module list fails the trade rule']), ...(alpha.ok ? [] : ['this build fails the alpha rule']), ...(twin.ok ? [] : [`the ${twinTarget} twin fails the trade rule, notices requirement or reveal-seam rule`])].map((text) => `; ${text}`).join('');
  deps.error(`check:production: FAILED, ${failing.length + tradeJudgement.failing.length + alphaFailing.length} findings in ${files} shipped files (${[...counts].map(([rule, n]) => `${rule} ${n}`).join(', ') || 'none'})${differ}${tradeFail}${notices.ok ? '' : '; this build fails the notices requirement'}${seam.ok ? '' : '; this build fails the reveal-seam rule'}${seamTest.ok ? '' : '; the --mode test build fails the reveal-seam rule'}; ${examplesLine}; ${noteLine}.`);
  const onlyPlaceholders = changed.length === 0 && tradeOk && notices.ok && seamOk && failing.every((finding) => finding.rule === 'placeholder');
  if (onlyPlaceholders) deps.error(`check:production: no Demo, local-chain, invented or fixture trace, ${tradeLine}; ${examplesLine}; only the open legal placeholders are left (exit 3).`);
  return onlyPlaceholders ? 3 : 1;
}

// Node gives import.meta.url as the real path, so compare it with the real path of the started file (symlinks).
function startedDirectly(): boolean {
  try { const started = process.argv[1]; return started !== undefined && import.meta.url === pathToFileURL(realpathSync(started)).href; }
  catch { return false; }
}
if (startedDirectly()) process.exitCode = runCheck(process.argv.slice(2));
