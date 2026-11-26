/**
 * Source audit (UI-01, EXT-01): no swap builder, trading provider or transaction-sending code in the app or the
 * packages. Comments are excluded (the domain contract carries a comment that forbids these very names); every
 * identifier, string, template and JSX text is scanned, so a forbidden name cannot hide in a string either.
 *
 * Stage C (ADR-0012) adds exactly two wallet requests, each allowed in ONE shipped file of the chain write side:
 * `eth_sendTransaction` in packages/chain/src/write/executor.ts (the four allowlisted calls, after "Confirm in wallet")
 * and `eth_requestAccounts` in packages/chain/src/write/injected-wallet.ts (the Connect click). Test-only code that
 * plays the wallet (tests, the chain package's test support and anvil harness) may name those two methods and nothing
 * else on the list; the chain write audit, which lists the forbidden names itself, is skipped like this file.
 *
 * F135 (SH-V2-FE10, the silent reconnect) lets apps/web/src/features/wallet/injected-adapter.ts name
 * `eth_requestAccounts` for one purpose: to ANSWER the resumed session's account request itself, with what the wallet's
 * `eth_accounts` already returned, so that the request never reaches the wallet. It never sends it
 * (browser-wallet.test.tsx pins that a resume asks the wallet no account request).
 *
 * SH-203 lets the two reveal engines name `eth_sendTransaction` for one purpose: to INTERCEPT the executor's send in
 * their wallet wrapper and forward it only after the last chain check and the durable intent (`REVEAL_SEND_INTERCEPTIONS`,
 * hash-pinned by `revealInterceptionOnly`). The executor stays the one file that issues the request.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { shLimit } from '../../../vitest.timeouts.mjs';
import { ALPHA_PATTERN } from '../production-check';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SELF = fileURLToPath(import.meta.url);
// Amendment 3 C12 / F120: burn-bot and keeper are the named ops packages that build operational
// transactions. Discover every other package source, including future packages; the whole site stays scanned.
const OPS_PACKAGES = new Set(['burn-bot', 'keeper']);
const SCANNED_DIRS = ['apps/web/src', ...readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !OPS_PACKAGES.has(entry.name) && existsSync(join(ROOT, 'packages', entry.name, 'src')))
  .map((entry) => `packages/${entry.name}/src`)];

export const FORBIDDEN_IDENTIFIERS: readonly RegExp[] = [
  /buildSwap/i,
  /swapExact/i,
  /exactInput(Single)?\b/,
  /exactOutput(Single)?\b/,
  /TradingProvider/,
  /SwapWidget/i,
  /UniversalRouter/,
  /eth_sendTransaction/,
  /eth_sendRawTransaction/,
  /eth_signTransaction/,
  /eth_requestAccounts/,
  /wallet_requestPermissions/,
  /\bsendTransaction\b/,
];

/** Shipped files that may name exactly these wallet requests (the write side's narrow surface). */
const SHIPPED_ALLOWANCE: ReadonlyMap<string, readonly string[]> = new Map([
  ['packages/chain/src/write/executor.ts', ['eth_sendTransaction']],
  ['packages/chain/src/write/injected-wallet.ts', ['eth_requestAccounts']],
  // Answered locally during a silent reconnect, never sent (see the header).
  ['apps/web/src/features/wallet/injected-adapter.ts', ['eth_requestAccounts']],
]);
/** Exact, reviewed wallet interceptors. No other function gets this exception. */
const REVEAL_SEND_INTERCEPTIONS = new Map<string, { name: string; hash: string; forward?: { name: string; hash: string }; forwardFrom?: { name: string; module: string } }>([
  ['apps/web/src/features/core/v2/reveal-items.ts', { name: 'wallet', hash: '344c3225de28dee473179c74be182567e9e80f22e69f492ae8d09fe4e55922af',
    // SH-203 af5 (R4-L6): the one function both wrappers forward through ("all reveal sends enter here"), pinned the same way.
    forward: { name: 'forwardRevealSend', hash: 'd21c30dfeece154f9590a0af441fffa7141692f22d96927368591441318d2cdd' } }],
  ['apps/web/src/features/core/v2/reveal-hidden.ts', { name: 'wallet', hash: '14ad83be0bde1dd737a4d877966ed15f655f9225815cf07e27b4efcd079fa3f8',
    // SH-203 af6 (C-L2): the name the pinned wrapper calls is the pinned function: imported from the open engine, and
    // bound nowhere else in this file.
    forwardFrom: { name: 'forwardRevealSend', module: './reveal-items' } }],
]);
// SH-258 round 4 changed two again: the hidden wrapper keeps the price reason it catches (no new call), and the vault
// wrapper runs its pending check after the price read, next to the move's record (nothing awaited between them).
// SH-258 round 3b changed all four pins: each wrapper now passes a price check (the fee reader's fresh eth_gasPrice
// against the request's own fee fields; no use of the wallet port) to run after the journal write or the vault's
// checks and before the one unchanged forward. Before changing either pin, review one forward of the intercepted request, unchanged, to the wallet port,
// and no other use of that port (apart from the non-send pass-through). The open engine's existing nonce binding
// must preserve every other request/transaction field. Review the last chain check and durable intent too.
// Normalization uses the TypeScript parser's leaf-token walk (codeTokens): comments and inter-token whitespace
// disappear; string/template contents and all syntax tokens stay. SHA-256 pins that normalized function source.
/**
 * Test-only code by its `.test-support.ts` name, outside a `test-support/` folder: the reveal tests' wallet double
 * answers the send and records what preceded it. No shipped file may import it (checked below), so it may name the two
 * wallet-double methods like any test support.
 */
const TEST_ONLY_WALLET_DOUBLES: ReadonlyMap<string, string> = new Map([
  ['apps/web/src/features/core/v2/reveal-items.test-support.ts', 'the reveal tests answer the executor send in a wallet double and trace its predecessor'],
]);
/** Wallet requests a test double answers (never sends): allowed in test-only code. */
const WALLET_DOUBLE_METHODS: readonly string[] = ['eth_sendTransaction', 'eth_requestAccounts'];

// SH-235 R3: this wrapper forwards the executor's unchanged request once, after its count check and pending-move check and write.
const ITEMS_SEND_INTERCEPTION: { path: string } & NonNullable<ReturnType<typeof REVEAL_SEND_INTERCEPTIONS.get>> = { path: 'apps/web/src/features/core/v2/vault-items.ts', name: 'guardedWallet',
  hash: 'b73d7fed1156df35b6bbef5f82523ea9f96f1eb145b7ec1b2970c498cd3a8f58' };
/** Match exactly one function by its declared name, then scan all code outside it under the normal rule. */
export function revealInterceptionOnly(path: string, text: string): boolean {
  const pin = REVEAL_SEND_INTERCEPTIONS.get(path) ?? (path === ITEMS_SEND_INTERCEPTION.path ? ITEMS_SEND_INTERCEPTION : undefined);
  if (!pin) return false;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const fn = pinnedFunction(path, source, pin);
  if (!fn) return false;
  // af5 (R4-L6): the forwarding function, where one is pinned, by the same exact method.
  if (pin.forward) {
    const forward = pinnedFunction(path, source, pin.forward);
    // af6 (C-L2): and its name bound by that declaration only (no parameter, variable or destructured name shadows it).
    if (!forward || bindingsOf(source, pin.forward.name).some((binding) => binding.parent !== forward)) return false;
    // af7 (D-L1): and never written (a function declaration can be assigned at run time).
    if (writesOf(source, pin.forward.name).length > 0) return false;
  }
  // af6 (C-L2): a wrapper that calls the pinned function by name in another file: that name is the one import of it.
  if (pin.forwardFrom) {
    const bindings = bindingsOf(source, pin.forwardFrom.name);
    const only = bindings[0]?.parent;
    if (bindings.length !== 1 || !only || !ts.isImportSpecifier(only) || only.isTypeOnly || (only.propertyName && only.propertyName.text !== pin.forwardFrom.name)) return false;
    const declaration = only.parent.parent.parent;
    if (!ts.isImportDeclaration(declaration) || declaration.importClause?.isTypeOnly || !ts.isStringLiteral(declaration.moduleSpecifier)
      || declaration.moduleSpecifier.text !== pin.forwardFrom.module) return false;
    // af7 (D-L1): and never written.
    if (writesOf(source, pin.forwardFrom.name).length > 0) return false;
  }
  const outside = text.slice(0, fn.getStart(source)) + 'undefined' + text.slice(fn.end);
  return forbiddenIn(path, outside).length === 0;
}
/**
 * SH-203 af6 (C-L2): every identifier of `source` that binds `name` (the name of a function, class, variable, parameter,
 * destructured element, import, enum or namespace declaration), in any scope.
 */
export function bindingsOf(source: ts.SourceFile, name: string): ts.Identifier[] {
  const found: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name) {
      const parent = node.parent;
      const binds = (ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent) || ts.isClassExpression(parent)
        || ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent) || ts.isImportSpecifier(parent)
        || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isImportEqualsDeclaration(parent) || ts.isEnumDeclaration(parent)
        || ts.isModuleDeclaration(parent)) && (parent as { name?: ts.Node }).name === node;
      if (binds) found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
/**
 * SH-203 af7 (D-L1): every place `source` WRITES the name `name`: the target of a plain or compound assignment, of `++`
 * or `--`, of `delete`, of a for-in or for-of head, or a target inside a destructuring assignment; each also through
 * parentheses, `as`, `<T>`, `satisfies` and the non-null `!`. Reading and calling it are not writes.
 */
export function writesOf(source: ts.SourceFile, name: string): ts.Identifier[] {
  const wrapped = (node: ts.Node): ts.Node => {
    let outer = node;
    while (ts.isParenthesizedExpression(outer.parent) || ts.isAsExpression(outer.parent) || ts.isTypeAssertionExpression(outer.parent)
      || ts.isSatisfiesExpression(outer.parent) || ts.isNonNullExpression(outer.parent)) outer = outer.parent;
    return outer;
  };
  const assignment = (node: ts.Node): node is ts.BinaryExpression => ts.isBinaryExpression(node)
    && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
  /** `target` stands where a value is written: an assignment's left side, a loop head, or (climbing) inside a destructuring target. */
  const written = (target: ts.Node): boolean => {
    const outer = wrapped(target), parent = outer.parent;
    if (assignment(parent) && parent.left === outer) return true;
    if ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
      && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)) return true;
    if (ts.isDeleteExpression(parent)) return true;
    if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === outer) return true;
    // Inside an array or object literal: a write only when that literal is itself a destructuring target.
    if (ts.isArrayLiteralExpression(parent) || ts.isSpreadElement(parent) || ts.isSpreadAssignment(parent)
      || (ts.isShorthandPropertyAssignment(parent) && parent.name === outer) || (ts.isPropertyAssignment(parent) && parent.initializer === outer)) {
      const literal = ts.isArrayLiteralExpression(parent) ? parent : parent.parent;
      return ts.isArrayLiteralExpression(literal) || ts.isObjectLiteralExpression(literal) ? written(literal) : false;
    }
    if (ts.isObjectLiteralExpression(parent)) return written(parent);
    return false;
  };
  const found: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name && written(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
/** The one function of `source` declared as `pin.name` (a declaration, or a const bound to a function) whose normalized tokens hash to `pin.hash`; else null. */
export function pinnedFunction(path: string, source: ts.SourceFile, pin: { readonly name: string; readonly hash: string }): ts.Node | null {
  const matches: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === pin.name
      && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) matches.push(node.initializer);
    if (ts.isFunctionDeclaration(node) && node.name?.text === pin.name) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const fn = matches[0];
  if (matches.length !== 1 || !fn) return null;
  const hash = createHash('sha256').update(codeTokens(path, fn.getText(source))).digest('hex');
  return hash === pin.hash ? fn : null;
}
/** Shipped source: not a test, not test support (`*.test-support.*` or a `test-support/` folder). */
export const shippedSource = (path: string): boolean => !isTestOnly(path) && !/\.test-support\.[cm]?[jt]sx?$/.test(path);

/** The module specifiers a file loads at run time: imports, re-exports, dynamic imports and requires (not type-only). */
function runtimeSpecifiers(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !node.importClause?.isTypeOnly) found.push(node.moduleSpecifier.text);
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly) found.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) found.push(arg.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Every file of `files` (repository paths, forward slashes) that reaches `target` at run time, directly or through others. */
export function importersOf(target: string, files: ReadonlyMap<string, string>): Set<string> {
  const extensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
  const resolveFile = (base: string): string[] => {
    const stem = base.replace(/\.[cm]?jsx?$/, '');
    return [...new Set([base, ...extensions.map((ext) => `${stem}${ext}`), ...extensions.map((ext) => `${base}/index${ext}`)])].filter((path) => files.has(path));
  };
  const packages = [...files].filter(([path]) => /^packages\/[^/]+\/package\.json$/.test(path)).map(([path, text]) => {
    const manifest = JSON.parse(text) as { name: string; exports?: unknown; main?: string };
    return { dir: posix.dirname(path), ...manifest };
  });
  const targets = (value: unknown): string[] => typeof value === 'string' ? [value]
    : value && typeof value === 'object' ? Object.values(value).flatMap(targets) : [];
  const resolveFrom = (from: string, specifier: string): string[] => {
    if (specifier.startsWith('.')) return resolveFile(posix.normalize(posix.join(posix.dirname(from), specifier)));
    const pkg = packages.find((entry) => specifier === entry.name || specifier.startsWith(`${entry.name}/`));
    if (!pkg) return [];
    const subpath = `.${specifier.slice(pkg.name.length)}`;
    const exports = pkg.exports;
    const entries: [string, unknown][] = exports && typeof exports === 'object' && !Array.isArray(exports) && Object.keys(exports).some((key) => key.startsWith('.'))
      ? Object.entries(exports) : [['.', exports ?? pkg.main ?? './src/index.ts']];
    return entries.flatMap(([key, value]) => {
      const [prefix = '', suffix] = key.split('*');
      const wildcard = suffix !== undefined && subpath.startsWith(prefix) && subpath.endsWith(suffix)
        ? subpath.slice(prefix.length, subpath.length - suffix.length) : null;
      if (key !== subpath && wildcard === null) return [];
      return targets(value).flatMap((target) => resolveFile(posix.join(pkg.dir, wildcard === null ? target : target.replaceAll('*', wildcard))));
    });
  };
  const importers = new Map<string, Set<string>>();
  for (const [path, text] of files) {
    if (path.endsWith('/package.json')) continue;
    for (const specifier of runtimeSpecifiers(path, text)) {
      for (const resolved of resolveFrom(path, specifier)) importers.set(resolved, (importers.get(resolved) ?? new Set()).add(path));
    }
  }
  const reached = new Set<string>();
  const queue = [target];
  while (queue.length > 0) {
    for (const importer of importers.get(queue.shift() as string) ?? []) if (!reached.has(importer)) { reached.add(importer); queue.push(importer); }
  }
  return reached;
}

/** Audit tests that enumerate the forbidden names themselves. */
const AUDITS: ReadonlySet<string> = new Set(['packages/chain/src/write/audit.test.ts']);

export const isTestOnly = (path: string): boolean => /\.test\.tsx?$/.test(path) || /\/(test-support|integration)\//.test(path);

/** F156 permits trade code in exactly these two folders; the mount only opens the lazy door. */
const isTradeSource = (path: string): boolean => path.startsWith('packages/chain/src/trade-sepolia/')
  || path.startsWith('apps/web/src/features/trade-sepolia/');

/** Findings after the Stage C allowances (see the header); `path` is relative to the repository root. */
export function disallowedIn(path: string, text: string): string[] {
  if (AUDITS.has(path)) return [];
  const allowed = new Set([...(SHIPPED_ALLOWANCE.get(path) ?? []), ...(isTestOnly(path) || TEST_ONLY_WALLET_DOUBLES.has(path) ? WALLET_DOUBLE_METHODS : [])]);
  if (revealInterceptionOnly(path, text)) allowed.add('eth_sendTransaction');
  const tradePatterns = new Set(FORBIDDEN_IDENTIFIERS.slice(0, 7).map(p => p.source));
  if (isTradeSource(path)) for (const pattern of tradePatterns) allowed.add(pattern);
  return forbiddenIn(path, text).filter(pattern => !allowed.has(pattern));
}

/** Inspect actual module syntax, not comments or arbitrary strings containing a path. */
export function tradeImportsOutsideFeature(path: string, text: string): string[] {
  if (isTradeSource(path)) return [];
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const findings: string[] = [];
  const visit = (node: ts.Node): void => {
    let module: ts.Node | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) module = node.moduleSpecifier;
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) module = node.arguments[0];
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) module = node.argument.literal;
    if (module && ts.isStringLiteralLike(module) && /(?:^|\/)trade-sepolia(?:\/|$)/.test(module.text)) {
      const mount = path === 'apps/web/src/features/core/v2/TradeSlotMount.tsx'
        && ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && module.text === '../../trade-sepolia/TradeSlot';
      // SH-ALPHA-TEST-COINS: the second door, the test-coin page's route, opens the same module lazily.
      const coinRoute = path === 'apps/web/src/routes.tsx'
        && ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && module.text === './features/trade-sepolia/TradeSlot';
      // SH-ALPHA-SITE (F161 (4)): the third door, the alpha's join page, opens Privy's loader lazily (never the trade box).
      const joinDoor = path === 'apps/web/src/features/alpha-sepolia/join/JoinPage.tsx'
        && ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && module.text === '../../trade-sepolia/privy-load';
      // SH-ALPHA-ONBOARDING (F166): the fourth door, the shell's welcome step, opens the slot's module lazily too.
      const welcomeDoor = path === 'apps/web/src/shell/AlphaWelcomeMount.tsx'
        && ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && module.text === '../features/trade-sepolia/TradeSlot';
      // The switch's two audit suites read the real slot marker to check their fixtures. No trade API is allowed.
      const markerTest = (path === 'apps/web/src/build-target.test.ts' || path === 'apps/web/src/production-check.test.ts')
        && ts.isImportDeclaration(node) && module.text === './features/trade-sepolia/TradeSlot'
        && node.importClause?.name === undefined && node.importClause?.namedBindings !== undefined
        && ts.isNamedImports(node.importClause.namedBindings)
        && node.importClause.namedBindings.elements.every(item => (item.propertyName ?? item.name).text === 'TRADE_SLOT_MARKER');
      const awaited = node.parent;
      const declaration = awaited?.parent;
      const alphaRunner = path === 'packages/chain/scripts/alpha-rehearsal.mjs'
        && ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && module.text === '../src/trade-sepolia/index.ts'
        && awaited !== undefined && ts.isAwaitExpression(awaited)
        && declaration !== undefined && ts.isVariableDeclaration(declaration)
        && ts.isObjectBindingPattern(declaration.name)
        && declaration.name.elements.length === 4
        && new Set(declaration.name.elements.map(item => (item.propertyName ?? item.name).getText(source))).size === 4
        && declaration.name.elements.every(item => !item.dotDotDotToken && !item.initializer
          && ['prepareTradeSepolia', 'submitTradeWriteSepolia', 'decodeTradeRevert', 'TRADE_ABI'].includes((item.propertyName ?? item.name).getText(source)));
      if (!mount && !coinRoute && !joinDoor && !welcomeDoor && !markerTest && !alphaRunner) findings.push(`${path}: ${module.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

/** Include first-party scripts, configs and declarations; ignore generated and dependency trees via Git. */
function tradeSourceFiles(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0').filter(path => /\.[cm]?[jt]sx?$/.test(path));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path);
    return /\.[cm]?[jt]sx?$/.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

const ASSET_TRANSPORT = 'apps/web/src/features/alpha-sepolia/reveal-asset-upload.ts';
const mainnetCandidate = (path: string): boolean => shippedSource(path) && !isTradeSource(path)
  && !path.startsWith('apps/web/src/features/alpha-sepolia/');
/** Fold only the build's exact false literal branch. Other syntax stays in the conservative import graph. */
function mainnetTradeSource(path: string, text: string): string {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const edits: { start: number; end: number; text: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isConditionalExpression(node) && node.condition.getText(source) === 'import.meta.env?.SH_SEPOLIA_TRADE === true') {
      edits.push({ start: node.getStart(source), end: node.end, text: node.whenFalse.getText(source) });
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const edit of edits.reverse()) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return text;
}
function mainnetAlphaPaths(path: string, text: string): string[] {
  if (!mainnetCandidate(path)) return [];
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const code = ts.createPrinter({ removeComments: true }).printFile(source);
  return [...code.matchAll(new RegExp(ALPHA_PATTERN))].map(match => `${path}: ${match[0]}`);
}
function mainnetAssetImporters(files: ReadonlyMap<string, string>): string[] {
  const folded = new Map([...files].map(([path, text]) => [path, text.includes('SH_SEPOLIA_TRADE') ? mainnetTradeSource(path, text) : text]));
  return [...importersOf(ASSET_TRANSPORT, folded)].filter(mainnetCandidate).sort();
}

/** Every token of the file except comments (trivia), joined with spaces. */
export function codeTokens(fileName: string, text: string): string {
  const kind = fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const tokens: string[] = [];
  const visit = (node: ts.Node): void => {
    const children = node.getChildren(source);
    if (children.length === 0) {
      if (node.kind !== ts.SyntaxKind.EndOfFileToken) tokens.push(node.getText(source));
      return;
    }
    children.forEach(visit);
  };
  visit(source);
  return tokens.join(' ');
}

export function forbiddenIn(fileName: string, text: string): string[] {
  const code = codeTokens(fileName, text);
  return FORBIDDEN_IDENTIFIERS.filter((pattern) => pattern.test(code)).map((pattern) => pattern.source);
}

// The two whole-tree scans keep their 30 s limit; SH_TEST_TIMEOUT (opt-in, slower machines) may raise it, never lower
// it. The trade-isolation scan took 38.8 s in the line gates of 2026-11-12 (b4) on the 8-thread laptop.
const TREE_SCAN_MS = shLimit(30_000);

describe('no-trade source scan', () => {
  it('covers the whole site and every package source except exactly the two ops packages', () => {
    const packages = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && readdirSync(join(ROOT, 'packages', entry.name)).includes('src'))
      .map((entry) => `packages/${entry.name}/src`);
    expect(SCANNED_DIRS).toContain('apps/web/src');
    expect(packages.filter((dir) => !SCANNED_DIRS.includes(dir)).sort()).toEqual(['packages/burn-bot/src', 'packages/keeper/src']);
    expect(SCANNED_DIRS.filter((dir) => dir !== 'apps/web/src' && !packages.includes(dir))).toEqual([]);
  });

  it('detects forbidden names in code and strings, but not in comments', () => {
    expect(forbiddenIn('a.ts', 'export function buildSwapTx() {}')).toEqual(['buildSwap']);
    expect(forbiddenIn('b.ts', "request({ method: 'eth_sendTransaction' })")).toEqual(['eth_sendTransaction']);
    expect(forbiddenIn('b2.ts', 'await walletClient.sendTransaction({ to })')).toEqual(['\\bsendTransaction\\b']);
    expect(forbiddenIn('c.tsx', 'const x = <p>TradingProvider</p>;')).toEqual(['TradingProvider']);
    expect(forbiddenIn('d.ts', '// No TradingProvider, buildSwapTransaction or swapExact here.\n/* eth_requestAccounts */ export {};')).toEqual([]);
    expect(forbiddenIn('e.ts', 'const s = `x ${"swapExactTokensForTokens"}`;')).toEqual(['swapExact']);
  });

  it('finds none in apps/web/src and packages/*/src', () => {
    const files = SCANNED_DIRS.flatMap((dir) => sourceFiles(join(ROOT, dir))).filter((file) => file !== SELF);
    expect(files.length).toBeGreaterThan(50);
    const findings = files.flatMap((file) =>
      disallowedIn(relative(ROOT, file), readFileSync(file, 'utf8')).map((pattern) => `${relative(ROOT, file)}: ${pattern}`),
    );
    expect(findings).toEqual([]);
  }, TREE_SCAN_MS); // Whole-tree parsing can exceed Vitest's 5 s default during the full workspace run.

  it('allows each Stage C wallet request in exactly one shipped file, and nothing else on the list anywhere shipped', () => {
    expect(disallowedIn('packages/chain/src/write/executor.ts', "request({ method: 'eth_sendTransaction' })")).toEqual([]);
    expect(disallowedIn('packages/chain/src/write/executor.ts', "request({ method: 'eth_requestAccounts' })")).toEqual(['eth_requestAccounts']);
    expect(disallowedIn('packages/chain/src/write/claims.ts', "request({ method: 'eth_sendTransaction' })")).toEqual(['eth_sendTransaction']);
    expect(disallowedIn('apps/web/src/features/tx/x.ts', "request({ method: 'eth_sendTransaction' })")).toEqual(['eth_sendTransaction']);
    expect(disallowedIn('packages/chain/src/write/test-support/fake.ts', "method === 'eth_sendTransaction'")).toEqual([]);
    expect(disallowedIn('packages/chain/src/write/test-support/fake.ts', 'buildSwapTx()')).toEqual(['buildSwap']);
    for (const [path, methods] of SHIPPED_ALLOWANCE) {
      const code = codeTokens(path, readFileSync(join(ROOT, path), 'utf8'));
      for (const method of methods) expect(code, path).toContain(method);
    }
  });

  it('BC-092: every core v1 file S10a adds is scanned (site, links, chain readers, indexer) and names no swap, trading or wallet request', () => {
    const files = SCANNED_DIRS.flatMap((dir) => sourceFiles(join(ROOT, dir))).map((file) => relative(ROOT, file));
    const core = files.filter((file) => /^(apps\/web\/src\/features\/core|packages\/indexer\/src\/(core|history)|packages\/chain\/src\/core)\/|^packages\/links\/src\/(box-links|route-evidence-v2)\.ts$/.test(file));
    for (const expected of ['apps/web/src/features/core/RowBoxPage.tsx', 'apps/web/src/features/core/RowLinks.tsx', 'packages/links/src/box-links.ts', 'packages/chain/src/core/core-reads.ts', 'packages/indexer/src/core/core-gateway.ts', 'packages/indexer/src/core/art.ts', 'packages/indexer/src/history/pg-history.ts']) {
      expect(core).toContain(expected);
    }
    const findings = core.flatMap((file) => disallowedIn(file, readFileSync(join(ROOT, file), 'utf8')).map((pattern) => `${file}: ${pattern}`));
    expect(findings).toEqual([]);
  });

  it('the app never imports the chain package’s test support', () => {
    const app = sourceFiles(join(ROOT, 'apps/web/src')).filter((file) => !isTestOnly(relative(ROOT, file)));
    const importing = app.filter((file) => /@squarehole\/chain\/write\/test-support/.test(readFileSync(file, 'utf8')));
    expect(importing.map((file) => relative(ROOT, file))).toEqual([]);
  });

  it('af2 R2-M4: the inventory finds a side-effect JavaScript send, for every source extension', () => {
    const root = mkdtempSync(join(tmpdir(), 'sh-wallet-inventory-'));
    try {
      const src = join(root, 'apps/web/src');
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, 'Page.ts'), "import './wallet-extra.js';");
      for (const ext of ['js', 'jsx', 'mjs', 'cjs']) writeFileSync(join(src, `wallet-extra.${ext}`), "provider.request({ method: 'eth_sendTransaction', params: [tx] });");
      const files = sourceFiles(src).map((file) => relative(root, file));
      expect(files.sort()).toEqual(['Page.ts', 'wallet-extra.cjs', 'wallet-extra.js', 'wallet-extra.jsx', 'wallet-extra.mjs'].map((name) => `apps/web/src/${name}`));
      expect(files.flatMap((file) => disallowedIn(file, readFileSync(join(root, file), 'utf8')).map((rule) => `${file}: ${rule}`))).toEqual(
        ['cjs', 'js', 'jsx', 'mjs'].map((ext) => `apps/web/src/wallet-extra.${ext}: eth_sendTransaction`));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('the domain contract’s forbidding comment is still there, and is only a comment', () => {
    const typesFile = join(ROOT, 'packages/domain/src/types.ts');
    const text = readFileSync(typesFile, 'utf8');
    expect(text).toContain('No TradingProvider, buildSwapTransaction');
    expect(forbiddenIn(typesFile, text)).toEqual([]);
  });
});

describe('SH-203: the reveal engines name the send only to intercept the executor’s', () => {
  const interception = "const wallet = async request => {\n  if (request.method !== 'eth_sendTransaction') return ports.wallet(request);\n  return forwardRevealSend(chain, id, persist, () => ports.wallet(request));\n};";
  const bound = "const wallet = async request => {\n  if (request.method !== 'eth_sendTransaction') return ports.wallet(request);\n  const tx = request.params[0] as Record<string, unknown>;\n  return forwardRevealSend(chain, id, persist, () => { requested = true; return ports.wallet({ ...request, params: [{ ...tx, nonce: toQuantity(n) }] }); });\n};";
  const engines = [...REVEAL_SEND_INTERCEPTIONS.keys()];
  it('lists exactly the two engines, each with its reason, and each still has the interception shape', () => {
    expect(engines).toEqual(['apps/web/src/features/core/v2/reveal-items.ts', 'apps/web/src/features/core/v2/reveal-hidden.ts']);
    for (const [path, pin] of REVEAL_SEND_INTERCEPTIONS) {
      expect(pin.name).toBe('wallet');
      const text = readFileSync(join(ROOT, path), 'utf8');
      expect(revealInterceptionOnly(path, text), path).toBe(true);
      expect(disallowedIn(path, text), path).toEqual([]);
    }
  });
  it('allows the interception in the engines and nowhere else', () => {
    for (const path of engines) expect(disallowedIn(path, readFileSync(join(ROOT, path), 'utf8'))).toEqual([]);
    for (const path of ['apps/web/src/features/core/v2/reveal-session.ts', 'apps/web/src/features/core/v2/reveal-assets.ts',
      'apps/web/src/features/core/v2/RevealItemsV2.tsx', 'apps/web/src/features/core/v2/HiddenDrawsV2.tsx', 'apps/web/src/features/core/v2/reveal-items-extra.ts',
      'apps/web/src/features/core/v2/reveal-items.tsx', 'packages/chain/src/core/v2/reveal-items.ts', 'apps/web/src/features/core/reveal-hidden.ts']) {
      expect(disallowedIn(path, interception), path).toEqual(['eth_sendTransaction']);
    }
  });
  it('refuses an engine that builds a send of its own, compares the other way or names it twice', () => {
    for (const path of engines) {
      for (const code of [
        "const send = () => ports.wallet({ method: 'eth_sendTransaction', params: [tx] });",
        `${interception}\nconst send = () => ports.wallet({ method: 'eth_sendTransaction', params: [tx] });`,
        "const wallet = async request => {\n  if (request.method === 'eth_sendTransaction') return ports.wallet(request);\n  return 0;\n};",
        "const wallet = async request => {\n  if (request.method !== 'eth_sendTransaction') return ports.wallet(request);\n  else return ports.wallet({ method: 'eth_sendTransaction' });\n};",
        "const wallet = async request => {\n  if (request.method !== 'eth_sendTransaction') return ports.wallet({ ...request, method: 'eth_sendTransaction' });\n};",
        "const wallet = async (request, other) => {\n  if (request.method !== 'eth_sendTransaction') return ports.wallet(other);\n};",
        "const wallet = async request => {\n  if (other.method !== 'eth_sendTransaction') return ports.wallet(other);\n};",
        "const wallet = async request => {\n  await ports.wallet({ method: 'eth_accounts' });\n  if (request.method !== 'eth_sendTransaction') return ports.wallet(request);\n};",
        "const method = `eth_sendTransaction`; const wallet = async request => ports.wallet({ method, params: [] });",
      ]) expect(disallowedIn(path, code), code).toEqual(['eth_sendTransaction']);
    }
  });
  it('af1 M3: the send reaches the wallet once, unchanged, through forwardRevealSend; anything else in the send branch is refused', () => {
    for (const path of engines) {
      expect(disallowedIn(path, bound), 'even a similar body needs the exact pin').toEqual(['eth_sendTransaction']);
      for (const code of [
        // The review's two inputs: the request forwarded twice, and a substituted transaction, neither through forwardRevealSend.
        "const wallet = async request => { if (request.method !== 'eth_sendTransaction') return ports.wallet(request); await ports.wallet(request); return ports.wallet(request); };",
        "const wallet = async request => { if (request.method !== 'eth_sendTransaction') return ports.wallet(request); return ports.wallet({ ...request, params: [ownTransaction] }); };",
        // Through forwardRevealSend, but substituted, changed, doubled, conditional or with a second forward.
        "const wallet = async request => { if (request.method !== 'eth_sendTransaction') return ports.wallet(request); return forwardRevealSend(c, i, p, () => ports.wallet({ ...request, params: [ownTransaction] })); };",
        "const wallet = async request => { if (request.method !== 'eth_sendTransaction') return ports.wallet(request); const tx = request.params[0]; return forwardRevealSend(c, i, p, () => ports.wallet({ ...request, params: [{ ...tx, to: other }] })); };",
        "const wallet = async request => { if (request.method !== 'eth_sendTransaction') return ports.wallet(request); const tx = ownTransaction; return forwardRevealSend(c, i, p, () => ports.wallet({ ...request, params: [{ ...tx, nonce: n }] })); };",
        "const wallet = async request => { if (request.method !== 'eth_sendTransaction') return ports.wallet(request); return forwardRevealSend(c, i, p, () => { ports.wallet(request); return ports.wallet(request); }); };",
        "const wallet = async request => { if (request.method !== 'eth_sendTransaction') return ports.wallet(request); return forwardRevealSend(c, i, p, () => { if (x) return ports.wallet(other); return 0; }); };",
        "const wallet = async request => { if (request.method !== 'eth_sendTransaction') return ports.wallet(request); await forwardRevealSend(c, i, p, () => ports.wallet(request)); return forwardRevealSend(c, i, p, () => 0); };",
        "const wallet = async request => { if (request.method !== 'eth_sendTransaction') return ports.wallet(request); return forwardRevealSend(c, i, p, () => send(request)); };",
        "const wallet = async request => { if (request.method !== 'eth_sendTransaction') return ports.wallet(request); return forwardRevealSend(c, i, p, () => 0); };",
      ]) expect(disallowedIn(path, code), code).toEqual(['eth_sendTransaction']);
    }
  });

  it('af2 R2-M1: refuses repeats, aliases and writes before the forward', () => {
    const tail = (code: string) => interception.replace('return forwardRevealSend', `${code} return forwardRevealSend`);
    const forward = 'forwardRevealSend(chain, id, persist, () => ports.wallet(request))';
    const controls = [
      // R2's four passing examples.
      interception.replace(`return ${forward};`, `for (let i = 0; i < 2; i++) await ${forward};`),
      tail('request.params = [ownTransaction];'),
      tail('const send = ports.wallet; await send(request);'),
      bound.replace('return forwardRevealSend', 'tx.to = other; return forwardRevealSend'),
      // Other repeats and aliases use the same two call sites.
      interception.replace(`return ${forward};`, `while (again) await ${forward};`),
      interception.replace(`return ${forward};`, `do { await ${forward}; } while (again);`),
      interception.replace(`return ${forward};`, `[1, 2].map(() => ${forward});`),
      interception.replace(`return ${forward};`, `function twice() { return ${forward}; } twice(); twice();`),
      tail('await wallet(ownRequest);'),
      tail('const send = forwardRevealSend; await send(chain, id, persist, () => 0);'),
      tail('const port = ports; await port.wallet(ownTransaction);'),
      tail('const { wallet: send } = ports; await send(ownTransaction);'),
      tail("const send = ports['wallet']; await send(ownTransaction);"),
      tail('await (ports).wallet(ownTransaction);'),
      tail('const port = (ports); await port.wallet(ownTransaction);'),
      `const send = ports.wallet; ${tail('await send(request);')}`,
      tail('const copy = request; copy.params = [ownTransaction];'),
      tail('const params = request.params; params[0] = ownTransaction;'),
      tail('request = { ...request, params: [ownTransaction] };'),
      tail('Object.assign(request, { params: [ownTransaction] });'),
      tail('Object.assign(request.params[0], { to: other });'),
      tail('request.params.push(ownTransaction);'),
      tail("const params = request['params']; params[0] = ownTransaction;"),
      tail('delete request.params;'),
      bound.replace('return forwardRevealSend', 'Object.assign(tx, { to: other }); return forwardRevealSend'),
      bound.replace('return forwardRevealSend', 'delete tx.to; return forwardRevealSend'),
      bound.replace('return forwardRevealSend', '({ to: tx.to } = other); return forwardRevealSend'),
      bound.replace('return forwardRevealSend', 'for (tx.to of others) {} return forwardRevealSend'),
      `function forwardRevealSend(c, i, p, forward) { return [forward(), forward()]; } ${interception}`,
      bound.replace('return forwardRevealSend', 'const copy = tx; copy.to = other; return forwardRevealSend'),
      bound.replace('return forwardRevealSend', 'tx = { ...tx, to: other }; return forwardRevealSend'),
      interception.replace('() => ports.wallet(request)', '() => ports.wallet(other)'),
      interception.replace('() => ports.wallet(request)', '(request) => ports.wallet(request)'),
    ];
    for (const path of engines) for (const code of controls) expect(disallowedIn(path, code), code).toEqual(['eth_sendTransaction']);
  });

  it('af4 A: any edit to either pinned function fails; trivia passes; outside sends still fail', () => {
    for (const path of engines) {
      const source = readFileSync(join(ROOT, path), 'utf8');
      for (const extra of [
        "await Reflect.get(ports,'wallet')({method:request.method,params:[ownTransaction]});",
        'await helper(ports, request);', 'await helper(io, request);', 'void request;',
      ]) {
        const mutant = source.replace("if (request.method !== 'eth_sendTransaction')", `${extra} if (request.method !== 'eth_sendTransaction')`);
        expect(revealInterceptionOnly(path, mutant), extra).toBe(false);
        expect(disallowedIn(path, mutant)).toContain('eth_sendTransaction');
      }
      expect(revealInterceptionOnly(path, source.replace('async request => {', 'async  request => { /* trivia */\n'))).toBe(true);
      expect(disallowedIn(path, `${source}\nports.wallet({method: 'eth_sendTransaction'});`)).toContain('eth_sendTransaction');
      expect(revealInterceptionOnly(path, source.replace('const wallet:', 'const other:'))).toBe(false);
    }
  });

  it('af5 R4-L6: the forwarding function is pinned too: forwarding twice, any other edit or a rename fails the guard; trivia passes', () => {
    const path = 'apps/web/src/features/core/v2/reveal-items.ts';
    expect(REVEAL_SEND_INTERCEPTIONS.get(path)?.forward?.name).toBe('forwardRevealSend');
    const source = readFileSync(join(ROOT, path), 'utf8');
    expect(revealInterceptionOnly(path, source)).toBe(true);
    const body = '  await persistIntent();\n  await price();\n  return forward();\n';
    expect(source).toContain(body);
    for (const mutant of [
      // The review's M2a: the request forwarded twice.
      source.replace(body, '  await persistIntent();\n  await price();\n  await forward();\n  return forward();\n'),
      source.replace(body, '  return forward();\n'),
      source.replace(body, '  await persistIntent();\n  await price();\n  return [forward()];\n'),
      source.replace('export async function forwardRevealSend(', 'export async function forwardRevealSendOnce('),
      `${source}\nexport function forwardRevealSend() { return undefined; }`,
    ]) {
      expect(mutant).not.toBe(source);
      expect(revealInterceptionOnly(path, mutant)).toBe(false);
      expect(disallowedIn(path, mutant)).toContain('eth_sendTransaction');
    }
    expect(revealInterceptionOnly(path, source.replace(body, '  await persistIntent(); // trivia\n  await price();\n  return forward();\n'))).toBe(true);
    expect(REVEAL_SEND_INTERCEPTIONS.get('apps/web/src/features/core/v2/reveal-hidden.ts')?.forward).toBeUndefined();
  });

  it('af6 C-L2: the name both wrappers call is the pinned function: imported from the open engine, bound nowhere else', () => {
    const hidden = 'apps/web/src/features/core/v2/reveal-hidden.ts';
    const items = 'apps/web/src/features/core/v2/reveal-items.ts';
    const source = readFileSync(join(ROOT, hidden), 'utf8');
    const open = 'export async function openHiddenReveal(handle: HiddenOpeningHandle, signal: AbortSignal, authority: object = handle): Promise<{ reason: \'sent\' | HiddenWait; hash?: Hex; attempt?: string }> {';
    const imported = ' forwardRevealSend, RevealRefusal,';
    expect(source).toContain(open); expect(source).toContain(imported);
    expect(revealInterceptionOnly(hidden, source)).toBe(true);
    for (const mutant of [
      // The reviewer's A8: a local function of that name inside openHiddenReveal that forwards twice.
      source.replace(open, `${open}\n  async function forwardRevealSend(_c: unknown, _i: number, persist: () => Promise<void>, forward: () => Promise<unknown>) { await persist(); await forward(); return forward(); }`),
      source.replace(open, `${open}\n  const forwardRevealSend = async (_c: unknown, _i: number, p: () => Promise<void>, f: () => Promise<unknown>) => { await p(); await f(); return f(); };`),
      source.replace(open, `${open}\n  const { forwardRevealSend } = twice;`),
      source.replace('authority: object = handle)', 'authority: object = handle, forwardRevealSend = twice)'),
      source.replace(imported, ' RevealRefusal,').replace("import { requireRevealAuthority } from './reveal-session';", "import { requireRevealAuthority } from './reveal-session';\nimport { forwardRevealSend } from './reveal-twice';"),
      source.replace(imported, ' forwardTwice as forwardRevealSend, RevealRefusal,'),
      source.replace(imported, ' RevealRefusal,'),
      `${source}\nfunction later() { try { return 1; } catch (forwardRevealSend) { return forwardRevealSend; } }`,
    ]) {
      expect(mutant).not.toBe(source);
      expect(revealInterceptionOnly(hidden, mutant)).toBe(false);
      expect(disallowedIn(hidden, mutant)).toContain('eth_sendTransaction');
    }
    // A comment naming it changes nothing.
    expect(revealInterceptionOnly(hidden, `${source}\n// forwardRevealSend\n`)).toBe(true);
    // The open engine: its own declaration is the one binding of the name.
    const engine = readFileSync(join(ROOT, items), 'utf8');
    const run = 'export async function runRevealItems(plan: RevealPlan, ports: RevealPorts, signal: AbortSignal)';
    expect(engine).toContain(run);
    expect(revealInterceptionOnly(items, engine.replace(run, 'export async function runRevealItems(plan: RevealPlan, ports: RevealPorts, signal: AbortSignal, forwardRevealSend = twice)'))).toBe(false);
    expect(revealInterceptionOnly(items, engine)).toBe(true);
  });

  it('af7 D-L1: the forwarding function is never written in either engine; reading and calling it stay allowed', () => {
    const items = 'apps/web/src/features/core/v2/reveal-items.ts';
    const hidden = 'apps/web/src/features/core/v2/reveal-hidden.ts';
    const engine = readFileSync(join(ROOT, items), 'utf8');
    const opener = readFileSync(join(ROOT, hidden), 'utf8');
    expect(revealInterceptionOnly(items, engine)).toBe(true);
    expect(revealInterceptionOnly(hidden, opener)).toBe(true);
    const twice = 'async (c: unknown, i: number, p: () => Promise<void>, f: () => Promise<unknown>) => { await p(); await f(); return f(); }';
    for (const line of [
      // The reviewer's C1: the declaration untouched, the function reassigned through a cast.
      `(forwardRevealSend as unknown) = ${twice};`,
      // Compound, destructuring targets, ++.
      'forwardRevealSend ||= twice;',
      '[forwardRevealSend] = [twice];',
      '({ forwardRevealSend } = { forwardRevealSend: twice });',
      '({ other: forwardRevealSend } = { other: twice });',
      '(forwardRevealSend as unknown as number)++;',
      // More of the same forms.
      'forwardRevealSend = twice;', '(<unknown>forwardRevealSend) = twice;', '(forwardRevealSend satisfies unknown) = twice;',
      '(forwardRevealSend!) = twice;', '--(forwardRevealSend as unknown as number);', 'delete (forwardRevealSend as never);',
      'for (forwardRevealSend of [twice]) break;', '[...forwardRevealSend] = [twice];', '({ ...forwardRevealSend } = { twice });',
      '[forwardRevealSend = twice] = [];',
    ]) {
      for (const [path, source] of [[items, engine], [hidden, opener]] as const) {
        const mutant = `${source}\n${line}\n`;
        expect(revealInterceptionOnly(path, mutant), `${path}: ${line}`).toBe(false);
        expect(disallowedIn(path, mutant), `${path}: ${line}`).toContain('eth_sendTransaction');
      }
    }
    // Reading and calling it, also as a value in an object literal or an argument: not writes.
    for (const line of ['void forwardRevealSend;', 'const kept = { forwardRevealSend, other: forwardRevealSend };',
      'console.log(forwardRevealSend, [forwardRevealSend]);', 'const n = forwardRevealSend.length + 1;', 'other[forwardRevealSend.name] = 1;']) {
      for (const [path, source] of [[items, engine], [hidden, opener]] as const) expect(revealInterceptionOnly(path, `${source}\n${line}\n`), `${path}: ${line}`).toBe(true);
    }
  });

  it('lets only the reveal wallet double name it as test support, and no shipped file imports that double', () => {
    expect([...TEST_ONLY_WALLET_DOUBLES.keys()]).toEqual(['apps/web/src/features/core/v2/reveal-items.test-support.ts']);
    const double = 'apps/web/src/features/core/v2/reveal-items.test-support.ts';
    expect(disallowedIn(double, "if (request.method !== 'eth_sendTransaction') throw new Error('unexpected');")).toEqual([]);
    expect(disallowedIn(double, 'buildSwapTx()')).toEqual(['buildSwap']);
    expect(disallowedIn('apps/web/src/features/core/v2/reveal-other.test-support.ts', "method === 'eth_sendTransaction'")).toEqual(['eth_sendTransaction']);
    // af1 L3: over the resolved import graph of the app and every package source (imports, re-exports, dynamic imports),
    // nothing that reaches the double is shipped code.
    const files = new Map(SCANNED_DIRS.flatMap((dir) => sourceFiles(join(ROOT, dir))).map((file) => [relative(ROOT, file).split('\\').join('/'), readFileSync(file, 'utf8')] as const));
    for (const entry of readdirSync(join(ROOT, 'packages'), { withFileTypes: true })) {
      const path = `packages/${entry.name}/package.json`;
      if (entry.isDirectory() && existsSync(join(ROOT, path))) files.set(path, readFileSync(join(ROOT, path), 'utf8'));
    }
    expect(files.has(double)).toBe(true);
    const reaching = importersOf(double, files);
    expect(reaching.size, 'the reveal tests import it').toBeGreaterThan(5);
    expect([...reaching].filter(shippedSource)).toEqual([]);
  }, TREE_SCAN_MS);

  it('af2 R2-L1: package exports and their conditional or wildcard entries reach the double', () => {
    const double = 'apps/web/src/features/core/v2/reveal-items.test-support.ts';
    const files = new Map([
      [double, 'export const runFixture = () => 0;'],
      ['packages/chain/package.json', JSON.stringify({ name: '@squarehole/chain', exports: {
        './write/test-support': './src/write/test-support/index.ts',
        './conditional': { import: './src/write/test-support/index.ts', require: './src/write/test-support/index.ts' },
        './helpers/*': './src/write/test-support/*.ts',
      } })],
      ['packages/chain/src/write/test-support/index.ts', "export * from '../../../../../apps/web/src/features/core/v2/reveal-items.test-support';"],
      ['packages/links/src/direct.ts', "import { runFixture } from '@squarehole/chain/write/test-support';"],
      ['packages/links/src/conditional.ts', "export * from '@squarehole/chain/conditional';"],
      ['packages/links/src/wildcard.ts', "const load = () => import('@squarehole/chain/helpers/index');"],
      ['packages/links/src/types.ts', "import type { X } from '@squarehole/chain/write/test-support';"],
    ]);
    expect([...importersOf(double, files)].filter(shippedSource).sort()).toEqual([
      'packages/links/src/conditional.ts', 'packages/links/src/direct.ts', 'packages/links/src/wildcard.ts']);
  });

  it('af1 L3 control: a package import or a re-export through other test support reaches the double and is found', () => {
    const double = 'apps/web/src/features/core/v2/reveal-items.test-support.ts';
    const files = new Map([
      [double, 'export const runFixture = () => 0;'],
      ['packages/chain/src/write/uses-double.ts', "import { runFixture } from '../../../../apps/web/src/features/core/v2/reveal-items.test-support';"],
      ['apps/web/src/features/core/v2/relay.test-support.ts', "export * from './reveal-items.test-support.js';"],
      ['apps/web/src/features/core/v2/Page.tsx', "import { runFixture } from './relay.test-support';"],
      ['apps/web/src/features/core/v2/Lazy.tsx', "const load = () => import('./relay.test-support');"],
      ['apps/web/src/features/core/v2/OnlyTypes.tsx', "import type { X } from './reveal-items.test-support';"],
      ['apps/web/src/features/core/v2/reveal-x.test.ts', "import { runFixture } from './reveal-items.test-support';"],
    ]);
    expect([...importersOf(double, files)].filter(shippedSource).sort()).toEqual([
      'apps/web/src/features/core/v2/Lazy.tsx', 'apps/web/src/features/core/v2/Page.tsx', 'packages/chain/src/write/uses-double.ts']);
  });
});

describe('F135: the adapter names the account request once, to answer it locally', () => {
  it('one string literal, inside resumedProvider, and never a request that sends it', () => {
    const file = join(ROOT, 'apps/web/src/features/wallet/injected-adapter.ts');
    const text = readFileSync(file, 'utf8');
    const literals = [...text.matchAll(/'eth_requestAccounts'/g)].map((match) => match.index ?? -1);
    expect(literals).toHaveLength(1);
    const start = text.indexOf('function resumedProvider(');
    const end = text.indexOf('\nfunction ', start + 1);
    expect(start).toBeGreaterThan(0);
    expect(literals[0]).toBeGreaterThan(start);
    expect(literals[0]).toBeLessThan(end);
    expect(text).not.toMatch(/request\(\{\s*method:\s*'eth_requestAccounts'/);
  });
});


describe('F156 trade isolation', () => {
  it('SH-203 af3: shared source has no alpha API path and mainnet cannot reach the picture transport', () => {
    const files = new Map(SCANNED_DIRS.flatMap(dir => sourceFiles(join(ROOT, dir))).map(file => [relative(ROOT, file), readFileSync(file, 'utf8')]));
    for (const entry of readdirSync(join(ROOT, 'packages'), { withFileTypes: true })) {
      const path = `packages/${entry.name}/package.json`;
      if (entry.isDirectory() && existsSync(join(ROOT, path))) files.set(path, readFileSync(join(ROOT, path), 'utf8'));
    }
    expect(files.has(ASSET_TRANSPORT)).toBe(true);
    expect([...files].flatMap(([path, text]) => /\.[cm]?[jt]sx?$/.test(path) && new RegExp(ALPHA_PATTERN).test(text) ? mainnetAlphaPaths(path, text) : [])).toEqual([]);
    expect(mainnetAssetImporters(files)).toEqual([]);
  }, TREE_SCAN_MS);

  it('SH-203 af3: moving the path into shared TS or JS, or opening the upload import, fails the source control', () => {
    const session = 'apps/web/src/features/core/v2/reveal-session.ts';
    const pathCode = 'fetch(`/alpha/asset/${chain}/${collection}/${id}/${role}`);';
    for (const path of [session, 'packages/chain/src/asset.js', 'apps/web/src/asset.mjs']) {
      expect(mainnetAlphaPaths(path, pathCode)).toEqual([`${path}: /alpha/`]);
      expect(mainnetAlphaPaths(path, 'fetch("/desk/api/upload");')).toEqual([`${path}: /desk/api/`]);
      expect(mainnetAlphaPaths(path, '/** The alpha uses /alpha/asset. */ const shared = true;')).toEqual([]);
    }
    expect(mainnetAlphaPaths(ASSET_TRANSPORT, pathCode)).toEqual([]);
    const door = "const upload = import.meta.env?.SH_SEPOLIA_TRADE === true ? import('../../alpha-sepolia/reveal-asset-upload') : undefined;";
    const files = new Map([[ASSET_TRANSPORT, pathCode], [session, door]]);
    expect(mainnetAssetImporters(files)).toEqual([]);
    for (const opened of [door.replace('SH_SEPOLIA_TRADE', 'SH_PRODUCTION'), door.replace('=== true', '=== false'),
      "const upload = import('../../alpha-sepolia/reveal-asset-upload');", "import '../../alpha-sepolia/reveal-asset-upload';",
      "export * from '../../alpha-sepolia/reveal-asset-upload';",
    ]) expect(mainnetAssetImporters(new Map(files).set(session, opened))).toEqual([session]);
    const relay = 'packages/chain/src/upload.js';
    files.set(relay, "export * from '../../../apps/web/src/features/alpha-sepolia/reveal-asset-upload';");
    // A transitive importer is caught as well as the file that opens the alpha module.
    files.set(session, "import '../../../../../../packages/chain/src/upload.js';");
    expect(mainnetAssetImporters(files)).toEqual([session, relay]);
  });

  it('scans scripts and build files as well as app and package source', () => {
    expect(tradeSourceFiles()).toContain('packages/chain/scripts/buy-v2.mjs');
    expect(tradeSourceFiles()).toContain('apps/web/build-target.ts');
    expect(tradeSourceFiles()).toContain('apps/web/src/build-env.d.ts');
  });
  it('allows trade vocabulary in exactly the chain and app trade folders', () => {
    expect(disallowedIn('packages/chain/src/trade-sepolia/trade.ts', 'function buildSwap() {}')).toEqual([]);
    expect(disallowedIn('packages/chain/src/trade-sepolia/trade.ts', "request({ method: 'eth_sendTransaction' })")).toEqual(['eth_sendTransaction']);
    expect(disallowedIn('packages/chain/src/write/executor.ts', 'export async function submitTradeWriteSepolia() { buildSwap(); }')).toEqual(['buildSwap']);
    expect(disallowedIn('packages/chain/src/write/executor.ts', 'function unrelated() { buildSwap(); }')).toContain('buildSwap');
    expect(disallowedIn('packages/chain/src/core/trade.ts', 'function buildSwap() {}')).toContain('buildSwap');
    expect(disallowedIn('apps/web/src/features/trade-sepolia/a.ts', 'function buildSwap() {}')).toEqual([]);
    for (const path of ['packages/chain/src/trade-sepolia/a.ts', 'apps/web/src/features/trade-sepolia/a.ts']) {
      expect(disallowedIn(path, "request({ method: 'eth_sendTransaction' })")).toEqual(['eth_sendTransaction']);
      expect(disallowedIn(path, "request({ method: 'eth_requestAccounts' })")).toEqual(['eth_requestAccounts']);
    }
    for (const path of ['packages/other/src/trade-sepolia/a.ts', 'apps/web/src/other/trade-sepolia/a.ts',
      'packages/chain/src/trade-sepolia-extra/a.ts', 'apps/web/src/features/trade-sepolia-extra/a.ts']) {
      expect(disallowedIn(path, 'function buildSwap() {}')).toEqual(['buildSwap']);
    }
  });
  it('catches static, dynamic, type-only, re-export and relative trade entry imports outside the lazy feature', () => {
    for (const source of [
      "import { prepareTradeSepolia } from '@squarehole/chain/trade-sepolia';",
      "export * from '@squarehole/chain/trade-sepolia';",
      "const load = () => import('@squarehole/chain/trade-sepolia');",
      "type Options = import('@squarehole/chain/trade-sepolia').TradeOptions;",
      "const mod = require('@squarehole/chain/trade-sepolia');",
      "import '../trade-sepolia/index';",
    ]) {
      expect(tradeImportsOutsideFeature('packages/chain/src/write/other.ts', source)).not.toEqual([]);
      expect(tradeImportsOutsideFeature('apps/web/src/features/trade-sepolia/BoxTrade.tsx', source)).toEqual([]);
    }
    expect(tradeImportsOutsideFeature('packages/chain/src/write/executor.ts', "const x = import('../trade-sepolia/guard');")).not.toEqual([]);
    expect(tradeImportsOutsideFeature('packages/chain/src/write/executor.ts', "export async function submitTradeWriteSepolia() { await import('../trade-sepolia/guard'); }")).not.toEqual([]);
    expect(tradeImportsOutsideFeature('packages/chain/src/write/executor.test.ts', "import '../trade-sepolia/guard';")).not.toEqual([]);
  });
  it('allows only the switch mount’s exact lazy import outside the two trade folders', () => {
    const mount = 'apps/web/src/features/core/v2/TradeSlotMount.tsx';
    expect(tradeImportsOutsideFeature(mount, "const Slot = lazy(() => import('../../trade-sepolia/TradeSlot')); ")).toEqual([]);
    for (const source of ["import '../../trade-sepolia/TradeSlot';", "const x = import('../../trade-sepolia/Other');",
      "const x = import('@squarehole/chain/trade-sepolia');"]) expect(tradeImportsOutsideFeature(mount, source)).not.toEqual([]);
  });
  it('allows only the test-coin route’s exact lazy import as the second door (SH-ALPHA-TEST-COINS)', () => {
    const routes = 'apps/web/src/routes.tsx';
    expect(tradeImportsOutsideFeature(routes, "const Page = lazy(() => import('./features/trade-sepolia/TradeSlot').then((module) => ({ default: module.TestCoinPage })));")).toEqual([]);
    for (const source of ["import { TestCoinPage } from './features/trade-sepolia/TradeSlot';", "const x = import('./features/trade-sepolia/TestCoinPage');",
      "const x = import('@squarehole/chain/trade-sepolia');", "export * from './features/trade-sepolia/TradeSlot';"]) expect(tradeImportsOutsideFeature(routes, source)).not.toEqual([]);
    // The same import anywhere else is refused.
    expect(tradeImportsOutsideFeature('apps/web/src/shell/Shell.tsx', "const Page = lazy(() => import('./features/trade-sepolia/TradeSlot'));")).not.toEqual([]);
  });
  it('lets the switch audits read only the slot marker, without authorizing any trade API', () => {
    for (const path of ['apps/web/src/build-target.test.ts', 'apps/web/src/production-check.test.ts']) {
      expect(tradeImportsOutsideFeature(path, "import { TRADE_SLOT_MARKER as marker } from './features/trade-sepolia/TradeSlot';")).toEqual([]);
      for (const source of ["import Slot from './features/trade-sepolia/TradeSlot';",
        "import { submitTradeWriteSepolia } from '@squarehole/chain/trade-sepolia';",
        "import { TRADE_SLOT_MARKER, trade } from './features/trade-sepolia/TradeSlot';"]) {
        expect(tradeImportsOutsideFeature(path, source)).toHaveLength(1);
      }
    }
  });
  it('allows only the explicit offline alpha runner to load its four public trade exports', () => {
    const runner = 'packages/chain/scripts/alpha-rehearsal.mjs';
    const load = "const { prepareTradeSepolia, submitTradeWriteSepolia, decodeTradeRevert, TRADE_ABI } = await import('../src/trade-sepolia/index.ts');";
    expect(tradeImportsOutsideFeature(runner, load)).toEqual([]);
    expect(tradeImportsOutsideFeature('packages/chain/scripts/other.mjs', load)).not.toEqual([]);
    expect(tradeImportsOutsideFeature(runner, load.replace('TRADE_ABI', 'internalSendChecked'))).not.toEqual([]);
    expect(tradeImportsOutsideFeature(runner, "const trade = await import('../src/trade-sepolia/index.ts');")).not.toEqual([]);
    expect(tradeImportsOutsideFeature(runner, "export * from '../src/trade-sepolia/index.ts';")).not.toEqual([]);
    expect(tradeImportsOutsideFeature(runner, load.replace('index.ts', 'submit.ts'))).not.toEqual([]);
  });
  it('SH-ALPHA-ONBOARDING: allows the shell’s welcome mount to open the slot’s module lazily, and nothing else, from nowhere else', () => {
    const mount = 'apps/web/src/shell/AlphaWelcomeMount.tsx';
    const door = "const Step = lazy(() => import('../features/trade-sepolia/TradeSlot').then((module) => ({ default: module.AlphaWelcome })));";
    expect(tradeImportsOutsideFeature(mount, door)).toEqual([]);
    expect(tradeImportsOutsideFeature('apps/web/src/shell/Shell.tsx', door)).not.toEqual([]);
    for (const source of ["import { AlphaWelcome } from '../features/trade-sepolia/TradeSlot';", "const x = import('../features/trade-sepolia/AlphaWelcome');",
      "const x = import('@squarehole/chain/trade-sepolia');"]) expect(tradeImportsOutsideFeature(mount, source)).not.toEqual([]);
  });
  it('SH-ALPHA-SITE: allows the join page to open Privy’s loader lazily, and nothing else of the trade folder, from nowhere else', () => {
    const page = 'apps/web/src/features/alpha-sepolia/join/JoinPage.tsx';
    const door = "const LOAD = () => import('../../trade-sepolia/privy-load');";
    expect(tradeImportsOutsideFeature(page, door)).toEqual([]);
    expect(tradeImportsOutsideFeature('apps/web/src/features/alpha-sepolia/desk/DeskPage.tsx', door)).not.toEqual([]);
    expect(tradeImportsOutsideFeature(page, "import { loadPrivyBridge } from '../../trade-sepolia/privy-load';")).not.toEqual([]);
    expect(tradeImportsOutsideFeature(page, "const LOAD = () => import('../../trade-sepolia/TradeSlot');")).not.toEqual([]);
  });
  it('has no trade entry imports outside the trade folders, the three doors and exact offline alpha runner', () => {
    const files = tradeSourceFiles().filter(file => file !== relative(ROOT, SELF));
    expect(files.flatMap(file => tradeImportsOutsideFeature(file, readFileSync(join(ROOT, file), 'utf8')))).toEqual([]);
  }, TREE_SCAN_MS);
});

// The exception is one exact wrapper, never a file-wide permission to issue a send.
it('SH-235 pins the Items interceptor and refuses a second forward, changed payload or missing count or pending-move check', () => {
  const path = ITEMS_SEND_INTERCEPTION.path; const source = readFileSync(join(ROOT, path), 'utf8');
  expect(disallowedIn(path, source)).toEqual([]);
  for (const mutant of [
    source.replace('return await io.request(request);', 'await io.request(request); return await io.request(request);'),
    source.replace('return await io.request(request);', 'return await io.request({ ...request, params: [] });'),
    // SH-258 round 4: the count check, then the price read, then the pending check next to the record.
    source.replace('const count = await counts(); checkCounts(count);', ''),
    source.replace('        pendingCheck();\n      } catch (error) { stopped = error; throw error; }', '      } catch (error) { stopped = error; throw error; }'),
    `${source}\nio.request({ method: 'eth_sendTransaction' });`,
  ]) { expect(mutant).not.toBe(source); expect(disallowedIn(path, mutant)).toEqual(['eth_sendTransaction']); }
});
