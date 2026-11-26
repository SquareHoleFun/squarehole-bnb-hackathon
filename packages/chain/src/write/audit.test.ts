/**
 * Narrow write authority (AGENTS.md "Keep app authorization narrow"; UI-01; EXT-01):
 * - the sendable selectors are exactly createLaunch, claim, claimAsT(bytes32,…) and claimAsQWhenSoldOut, and they
 *   equal the generated ABIs' selectors;
 * - in the write lane, `eth_sendTransaction` appears only in executor.ts, and `eth_requestAccounts` and
 *   `eth_signTypedData_v4` (LINKS-WEB: a box creator's signed links, docs/design/box-links-v2.md § 5) only in
 *   injected-wallet.ts (comments excluded); no other signing method anywhere; no swap or router vocabulary appears in
 *   shipped write code;
 * - no mainnet configuration: the write chains are 31337 and 11155111 only;
 * - every ABI comes from the single generated source in packages/chain/src/abi (whose drift test and
 *   `pnpm abi:check` compare it with packages/contracts/out).
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { toFunctionSelector, type AbiFunction } from 'viem';
import { describe, expect, it } from 'vitest';
import { shLimit } from '../../../../vitest.timeouts.mjs';
import { squareHoleClaimConverterAbi as converterAbi } from '../abi/squareHoleClaimConverter';
import { squareHoleLauncherAbi as launcherAbi } from '../abi/squareHoleLauncher';
import { rewardLedgerAbi as ledgerAbi } from '../abi/rewardLedger';
import { SENDABLE_SELECTORS, SENDABLE_SIGNATURES } from './calls';
import { WRITE_CHAIN_IDS, writeChain } from './chains';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.[cm]?[jt]sx?$/.test(name) ? [path] : [];
  });
}

/** Code and string tokens without comments (JSDoc nodes, which the TypeScript AST includes as children, are skipped). */
function codeTokens(file: string): string {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const tokens: string[] = [];
  const visit = (node: ts.Node): void => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(source);
    if (children.length === 0) tokens.push(node.getText(source));
    else children.forEach(visit);
  };
  visit(source);
  return tokens.join(' ');
}

// Shipped write code: everything except tests, test support, the anvil integration test and generated ABIs.
const isShipped = (file: string): boolean => !/\.(test|spec)\.[cm]?[jt]sx?$|[/\\]test-support(?:[/\\]|\.)|[/\\]integration[/\\]|\.generated\.ts$|\.d\.[cm]?ts$/.test(file);
const SHIPPED = files(HERE).filter(isShipped);
const PACKAGE_SHIPPED = files(resolve(HERE, '..')).filter(isShipped);
const PRIMITIVE = 'internalSendChecked';
const TRADE_DIR = 'packages/chain/src/trade-sepolia/';
const EXECUTOR = join(HERE, 'executor.ts');
const COMPILER_OPTIONS: ts.CompilerOptions = { moduleResolution: ts.ModuleResolutionKind.Bundler };
const RESOLUTIONS = ts.createModuleResolutionCache(ROOT, path => path, COMPILER_OPTIONS);

/** Named imports only; namespace/dynamic access and re-exports would expose the unguarded primitive. */
function primitiveEdges(path: string, text: string, parse = ts.createSourceFile): { importers: string[]; violations: string[] } {
  const targetOf = (specifier: string) => ts.resolveModuleName(specifier, resolve(ROOT, path), COMPILER_OPTIONS, ts.sys, RESOLUTIONS).resolvedModule?.resolvedFileName;
  // Preprocessing alone misses namespace exports and require inside interpolated templates.
  // Use it only for unambiguous token streams. Regex/division, JSX/generics, templates,
  // star exports and optional calls retain the original full AST walk.
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const ambiguous = new Set([ts.SyntaxKind.SlashToken, ts.SyntaxKind.SlashEqualsToken,
    ts.SyntaxKind.LessThanToken, ts.SyntaxKind.TemplateHead, ts.SyntaxKind.AsteriskToken,
    ts.SyntaxKind.QuestionDotToken]);
  let fullParse = false;
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (ambiguous.has(token)) { fullParse = true; break; }
  }
  if (!fullParse && !ts.preProcessFile(text, true, true).importedFiles.some(file => targetOf(file.fileName) === EXECUTOR)) {
    return { importers: [], violations: [] };
  }
  const source = parse(path, text, ts.ScriptTarget.Latest, true);
  const importers: string[] = [];
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    let spec: ts.Expression | undefined;
    let names: string[] | undefined;
    let namedImport = false;
    if (ts.isImportDeclaration(node)) {
      spec = node.moduleSpecifier;
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        names = bindings.elements.map(item => (item.propertyName ?? item.name).text);
        namedImport = true;
      }
    } else if (ts.isExportDeclaration(node)) {
      spec = node.moduleSpecifier;
      if (node.exportClause && ts.isNamedExports(node.exportClause)) names = node.exportClause.elements.map(item => (item.propertyName ?? item.name).text);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && node.expression.text === 'require')) spec = node.arguments[0];
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) spec = node.moduleReference.expression;
    if (spec && ts.isStringLiteralLike(spec)) {
      const target = targetOf(spec.text);
      if (target === EXECUTOR && (names === undefined || names.includes(PRIMITIVE))) {
        importers.push(path);
        if (!path.startsWith(TRADE_DIR) || !namedImport) violations.push(`${path}: ${spec.text}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { importers, violations };
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression) || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression)) expression = expression.expression;
  return expression;
}

// Resolve the public package surface separately from the direct-import fence.
function primitiveExports(entries: unknown, overrides: Record<string, string> = {}): string[] {
  const targets = (value: unknown): string[] => {
    if (value === null) return [];
    if (typeof value === 'string') return [resolve(ROOT, 'packages/chain', value)];
    if (typeof value === 'object') return Object.values(value).flatMap(targets);
    throw new Error('unresolved package export');
  };
  // Expand export patterns against actual source files as well as conditional/array targets.
  // The allowed direct importer must not itself re-export the primitive, even before a barrel forwards it.
  const roots = [resolve(ROOT, `${TRADE_DIR}submit.ts`), ...targets(entries)].flatMap(target => {
    if (!target.includes('*')) return [target];
    const [prefix, suffix = ''] = target.split('*');
    const matches = files(resolve(ROOT, 'packages/chain')).filter(path => path.startsWith(prefix ?? '') && path.endsWith(suffix));
    if (!matches.length) throw new Error('unresolved export pattern');
    return matches;
  });
  const host = ts.createCompilerHost(COMPILER_OPTIONS);
  const originalRead = host.readFile;
  host.readFile = path => overrides[relative(ROOT, path)] ?? originalRead(path);
  const program = ts.createProgram([...new Set([...roots, EXECUTOR])], COMPILER_OPTIONS, host);
  const checker = program.getTypeChecker();
  const executor = program.getSourceFile(EXECUTOR);
  if (!executor) throw new Error('missing executor');
  const module = checker.getSymbolAtLocation(executor);
  const primitive = module && checker.getExportsOfModule(module).find(s => s.name === PRIMITIVE);
  if (!primitive) throw new Error('missing primitive');
  const reaches = (symbol: ts.Symbol, seen = new Set<ts.Symbol>()): boolean => {
    if (symbol === primitive) return true;
    if (seen.has(symbol)) return false;
    seen.add(symbol);
    if (symbol.flags & ts.SymbolFlags.Alias) return reaches(checker.getAliasedSymbol(symbol), seen);
    for (const declaration of symbol.declarations ?? []) {
      const expression = ts.isVariableDeclaration(declaration) ? declaration.initializer
        : ts.isExportAssignment(declaration) ? declaration.expression : undefined;
      if (expression) {
        const source = checker.getSymbolAtLocation(unwrapExpression(expression));
        if (source && reaches(source, seen)) return true;
      }
    }
    return !!(symbol.flags & ts.SymbolFlags.Module) && checker.getExportsOfModule(symbol).some(s => reaches(s, seen));
  };
  return roots.filter(path => {
    const source = program.getSourceFile(path);
    const module = source && checker.getSymbolAtLocation(source);
    if (!module) throw new Error(`unresolved export: ${relative(ROOT, path)}`);
    return checker.getExportsOfModule(module).some(s => reaches(s));
  }).map(path => relative(ROOT, path));
}
const packageExports: unknown = JSON.parse(readFileSync(join(ROOT, 'packages/chain/package.json'), 'utf8')).exports;

/** Runtime identity covers exports constructed in ways the symbol walk cannot resolve. */
function runtimePrimitiveExports(exports: Record<string, unknown>, primitive: unknown): string[] {
  return Object.entries(exports).flatMap(([name, value]) => {
    if (value === primitive) return [name];
    if (value === null || typeof value !== 'object' && typeof value !== 'function') return [];
    return Reflect.ownKeys(value).filter(key => Reflect.get(value, key) === primitive)
      .map(key => `${name}.${String(key)}`);
  });
}

// The F156 scan reads every source file of the repository. Its 30 s limit stays; SH_TEST_TIMEOUT (opt-in, slower
// machines) may raise it, never lower it: 33 s under gate load on the 8-thread laptop (2026-11-12, line gates b2).
const F156_SCAN_MS = shLimit(30_000);

describe('write authority audit', () => {
  it('CC-5 coin preparation and guarded submit exist only on the isolated trade entry', async () => {
    const names = ['prepareFaucetSepolia', 'preparePairSwapSepolia', 'readCoinStateSepolia', 'submitCoinWriteSepolia'];
    for (const entry of Object.keys(packageExports as Record<string, unknown>)) {
      const exports = await import(`@squarehole/chain${entry === '.' ? '' : entry.slice(1)}`);
      for (const name of names) expect(typeof exports[name]).toBe(entry === './trade-sepolia' ? 'function' : 'undefined');
    }
  });

  it('the sendable selectors are exactly the four writes and match the generated ABIs', () => {
    expect(Object.values(SENDABLE_SIGNATURES).sort()).toEqual(['claim', 'claimAsQWhenSoldOut', 'claimAsT', 'createLaunch']);
    const fromAbi = (abi: readonly unknown[], name: string) =>
      (abi as AbiFunction[]).filter((f) => f.type === 'function' && f.name === name).map((f) => toFunctionSelector(f));
    const abiSelectors = new Set([...fromAbi(launcherAbi, 'createLaunch'), ...fromAbi(ledgerAbi, 'claim'), ...fromAbi(converterAbi, 'claimAsT'), ...fromAbi(converterAbi, 'claimAsQWhenSoldOut')]);
    for (const selector of SENDABLE_SELECTORS.keys()) expect(abiSelectors.has(selector)).toBe(true);
    // The token/slice overload claimAsT(address,uint256,uint256,uint256) exists in the ABI but is NOT sendable.
    expect(SENDABLE_SELECTORS.has(toFunctionSelector('claimAsT(address,uint256,uint256,uint256)'))).toBe(false);
    expect(SENDABLE_SELECTORS.size).toBe(4);
  });

  it('wallet transaction and account requests live in exactly one file each', () => {
    const where = (pattern: RegExp) => PACKAGE_SHIPPED.filter((file) => pattern.test(codeTokens(file))).map((file) => relative(HERE, file));
    expect(where(/eth_sendTransaction/)).toEqual(['executor.ts']);
    expect(where(/eth_requestAccounts/)).toEqual(['injected-wallet.ts']);
    // LINKS-WEB: the one signature the site asks for, EIP-712 v4 for a box's links; never the older typed-data forms.
    expect(where(/eth_signTypedData_v4\b/)).toEqual(['injected-wallet.ts']);
    expect(where(/eth_sendRawTransaction|eth_signTransaction|eth_sign\b|personal_sign|eth_signTypedData(?!_v4\b)|wallet_sendCalls/)).toEqual([]);
  });

  it('no swap, router or trading vocabulary in shipped write code', () => {
    const forbidden = [/buildSwap/i, /swapExact/i, /exactInput(Single)?\b/, /exactOutput(Single)?\b/, /TradingProvider/, /UniversalRouter/, /V4Router/, /SWAP_EXACT/, /Permit2/i, /\bapprove\b/];
    const findings = SHIPPED.flatMap((file) => forbidden.filter((p) => p.test(codeTokens(file))).map((p) => `${relative(ROOT, file)}: ${p.source}`));
    expect(findings).toEqual([]);
  });

  it('F156 leaves no trade entry, type, constant or folder reference in the shared executor', () => {
    const executor = readFileSync(join(HERE, 'executor.ts'), 'utf8');
    expect(executor).not.toMatch(/trade-sepolia|submitTradeWriteSepolia|TradeSubmitOptions|assertTradeWriteSepolia|TRADE_/);
    expect(executor).toContain(`export async function ${PRIMITIVE}(`);
  });

  it('F156 only the chain trade folder imports the internal primitive; no barrel exposes it', () => {
    const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0').filter(path => /\.[cm]?[jt]sx?$/.test(path));
    const edges = paths.map(path => primitiveEdges(path, readFileSync(join(ROOT, path), 'utf8')));
    expect(edges.flatMap(edge => edge.violations)).toEqual([]);
    expect(edges.flatMap(edge => edge.importers)).toEqual([`${TRADE_DIR}submit.ts`]);
  }, F156_SCAN_MS);

  it('no package export resolves to the internal sender under any alias', () => {
    expect(primitiveExports(packageExports)).toEqual([]);
  });

  it('no public entry exposes the sender by runtime identity, including defaults and object properties', async () => {
    const primitive: unknown = (await import(EXECUTOR))[PRIMITIVE];
    expect(typeof primitive).toBe('function');
    for (const entry of Object.keys(packageExports as Record<string, unknown>)) {
      const specifier = `@squarehole/chain${entry === '.' ? '' : entry.slice(1)}`;
      const exports: Record<string, unknown> = await import(specifier);
      expect(runtimePrimitiveExports(exports, primitive), specifier).toEqual([]);
    }
  });

  it('detects runtime aliases in named/default exports and one level of properties', async () => {
    const primitive: unknown = (await import(EXECUTOR))[PRIMITIVE];
    expect(typeof primitive).toBe('function');
    expect(runtimePrimitiveExports({ unchecked: primitive }, primitive)).toEqual(['unchecked']);
    expect(runtimePrimitiveExports({ default: primitive }, primitive)).toEqual(['default']);
    expect(runtimePrimitiveExports({ nested: { unchecked: primitive } }, primitive)).toEqual(['nested.unchecked']);
    expect(runtimePrimitiveExports({ default: { unchecked: primitive } }, primitive)).toEqual(['default.unchecked']);
    const hidden = Object.defineProperty({}, 'unchecked', { value: primitive });
    expect(runtimePrimitiveExports({ hidden }, primitive)).toEqual(['hidden.unchecked']);
    expect(runtimePrimitiveExports({ nested: { [Symbol('unchecked')]: primitive } }, primitive)).toEqual(['nested.Symbol(unchecked)']);
    expect(runtimePrimitiveExports({ default: () => primitive, nested: { safe: () => primitive }, absent: null }, primitive)).toEqual([]);
  });

  it.each(['new export', 'repoint wallet', 'local binding', 'constant alias', 'forwarded alias', 'star barrel', 'namespace', 'conditional'])('detects an exposed primitive: %s', kind => {
    const entries = { ...(packageExports as Record<string, unknown>) };
    const overrides: Record<string, string> = {};
    const submit = `${TRADE_DIR}submit.ts`;
    const index = `${TRADE_DIR}index.ts`;
    if (kind === 'new export') entries['./write/unchecked'] = './src/write/executor.ts';
    else if (kind === 'repoint wallet') entries['./write/wallet'] = './src/write/executor.ts';
    else if (kind === 'conditional') entries['./conditional'] = { browser: ['./src/write/executor.ts'], default: './src/index.ts' };
    else {
      overrides[submit] = readFileSync(join(ROOT, submit), 'utf8') + `\nexport { ${PRIMITIVE} as unchecked };`;
      if (kind === 'constant alias') overrides[submit] = readFileSync(join(ROOT, submit), 'utf8') + `\nconst send = ${PRIMITIVE}; export { send as unchecked };`;
      if (kind === 'forwarded alias') overrides[index] = "export { unchecked as innocuous } from './submit';";
      if (kind === 'star barrel') overrides[index] = "export * from './submit';";
      if (kind === 'namespace') overrides[index] = "export * as nested from './submit';";
    }
    const leaked = primitiveExports(entries, overrides);
    expect(leaked).not.toEqual([]);
    if (['forwarded alias', 'star barrel', 'namespace'].includes(kind)) expect(leaked).toContain(index);
  });

  describe.each([
    ['identifier', PRIMITIVE],
    ['parentheses', `(${PRIMITIVE})`],
    ['as assertion', `${PRIMITIVE} as typeof ${PRIMITIVE}`],
    ['type assertion', `<typeof ${PRIMITIVE}>${PRIMITIVE}`],
    ['satisfies', `${PRIMITIVE} satisfies typeof ${PRIMITIVE}`],
    ['non-null assertion', `${PRIMITIVE}!`],
    ['nested wrappers', `((${PRIMITIVE} as typeof ${PRIMITIVE})! satisfies typeof ${PRIMITIVE})`],
  ])('detects a primitive behind %s', (_kind, expression) => {
    it.each(['variable initializer', 'default export'])('follows the %s through the public barrel', kind => {
      const submit = `${TRADE_DIR}submit.ts`;
      const index = `${TRADE_DIR}index.ts`;
      const variable = kind === 'variable initializer';
      const declaration = variable ? `const unchecked = ${expression}; export { unchecked };` : `export default ${expression};`;
      const overrides = {
        [submit]: readFileSync(join(ROOT, submit), 'utf8') + `\n${declaration}`,
        [index]: variable ? "export { unchecked } from './submit';" : "export { default } from './submit';",
      };
      const leaked = primitiveExports(packageExports, overrides);
      expect(leaked).toContain(submit);
      expect(leaked).toContain(index);
    });
  });

  it('pins primitive imports including aliases, namespaces, dynamic loads and re-exports', () => {
    for (const text of [
      `import { ${PRIMITIVE} } from '../write/executor';`,
      `import { ${PRIMITIVE} as send } from '../write/executor.js';`,
      `export { ${PRIMITIVE} as send } from '../write/executor';`,
      "export * from '../write/executor';",
      "export * as sender from '../write/executor';",
      "import * as sender from '../write/executor';",
      "const sender = import('../write/executor');",
      "const sender = require('../write/executor');",
      "import sender = require('../write/executor');",
      "const sender = import(`../write/executor`);",
      "function load() { return require(`../write/executor`); }",
      "const sender = import('../write/exec\\u0075tor', { with: {} });",
      "const sender = r\\u0065quire('../write/executor');",
      "const sender = `${require('../write/executor')}`;",
      "const sender = require<unknown>('../write/executor');",
      "const sender = require?.('../write/executor');",
      "const pattern = /['\"]/; const sender = require('../write/executor');",
    ]) {
      expect(primitiveEdges('packages/chain/src/core/leak.ts', text).violations, text).toHaveLength(1);
    }
    expect(primitiveEdges(`${TRADE_DIR}submit.ts`, `import { ${PRIMITIVE} as send } from '../write/executor';`).violations).toEqual([]);
    expect(primitiveEdges(`${TRADE_DIR}index.ts`, `export { ${PRIMITIVE} } from '../write/executor';`).violations).toHaveLength(1);
    expect(primitiveEdges('packages/chain/src/write/index.ts', "export { submitWrite } from './executor';").importers).toEqual([]);
    expect(primitiveEdges('packages/chain/src/core/leak.ts', `// import { ${PRIMITIVE} } from '../write/executor';`).importers).toEqual([]);
  });

  it('af3 scans dependencies without building an AST unless a file can reach the executor', () => {
    const parsed: string[] = [];
    const parse: typeof ts.createSourceFile = (...args) => { parsed.push(args[0]); return ts.createSourceFile(...args); };
    const path = 'packages/chain/src/core/leak.ts';
    for (const text of [
      'export const data = [{ name: "large generated data" }];',
      "import { zeroHash } from 'viem'; export { zeroHash };",
      "// import('../write/executor')\nexport const text = \"require('../write/executor')\";",
    ]) expect(primitiveEdges(path, text, parse)).toEqual({ importers: [], violations: [] });
    expect(parsed).toEqual([]);
    expect(primitiveEdges(path, "import { internalSendChecked } from '../write/executor';", parse).violations).toHaveLength(1);
    expect(parsed).toEqual([path]);
  });

  it('write chains are the local chain and Sepolia only; mainnet has no configuration', () => {
    expect([...WRITE_CHAIN_IDS]).toEqual([31337, 11_155_111]);
    expect(() => writeChain(1)).toThrow(/no write configuration/);
    const mainnetish = SHIPPED.filter((file) => /mainnet|eth\.drpc|etherscan\.io\/(?!.*sepolia)|0x0{36}8a90/i.test(codeTokens(file)));
    expect(mainnetish.map((f) => relative(HERE, f))).toEqual([]);
  });

  it('takes every ABI from the single generated source (packages/chain/src/abi, drift-checked there)', () => {
    const everything = files(HERE);
    const local = everything.filter((file) => /abi[/\\]|\.generated\.ts$/.test(relative(HERE, file)));
    expect(local.map((file) => relative(HERE, file))).toEqual([]);
    const abiImports = everything.flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/from '([^']*abi[^']*)'/g)].map((match) => match[1] ?? ''),
    );
    expect(abiImports.length).toBeGreaterThan(0);
    expect(abiImports.filter((spec) => !/^(\.\.\/)+abi\/[A-Za-z]+$/.test(spec))).toEqual([]);
  });
});
