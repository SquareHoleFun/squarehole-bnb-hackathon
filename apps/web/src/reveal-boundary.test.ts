// @vitest-environment node
import { expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { build } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const effects: Record<string, readonly string[]> = {
  'reveal-items': ['prepareRevealItems', 'runRevealItems', 'releaseUnknownRevealIntent', 'reconcileRevealItems'],
  'reveal-hidden': ['prepareHiddenReveal', 'openHiddenReveal', 'releaseUnknownHiddenOpening', 'reconcileHiddenReveal'],
  'reveal-assets': ['revealAssets'],
  'reveal-items-store': ['saveRevealIntent', 'saveRevealChanges', 'saveRevealProgress', 'readRevealProgress'],
  'reveal-indexeddb': ['indexedDBRevealStore'],
  'reveal-clock': ['releaseWait'],
  'reveal-test-seam': ['revealTestOverride', 'installRevealTestSeam'],
};
// The engine implementation composes storage and the clock. No other application module gets these edges.
const implementationEdges: Record<string, readonly string[]> = {
  'reveal-items.ts': ['reveal-items-store', 'reveal-clock', 'reveal-test-seam'],
  'reveal-hidden.ts': ['reveal-items-store', 'reveal-clock', 'reveal-test-seam'],
  'reveal-clock.ts': ['reveal-items-store'],
  'reveal-rpc.ts': ['reveal-test-seam'],
};
function violations(path: string, text: string): string[] {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true), failures: string[] = [];
  const check = (specifier: string, names?: readonly string[]) => {
    const module = basename(specifier.split(/[?#]/)[0] ?? specifier).replace(/\.[cm]?[jt]sx?$/, '');
    const importer = path === join(root, 'features/core/v2', basename(path)) ? basename(path) : '';
    if (/reveal-.*(?:\.test|test-support)/.test(specifier)) { failures.push(`${path}: test module ${specifier}`); return; }
    if (!(module in effects)) return;
    const effect = !names || names.some(name => effects[module]?.includes(name));
    if (effect && importer !== 'reveal-session.ts' && !implementationEdges[importer]?.includes(module)) {
      failures.push(`${path}: internal ${specifier} (${names?.join(',') ?? '*'})`);
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !node.importClause?.isTypeOnly) {
      const bindings = node.importClause?.namedBindings;
      check(node.moduleSpecifier.text, bindings && ts.isNamedImports(bindings)
        ? bindings.elements.filter(e => !e.isTypeOnly).map(e => (e.propertyName ?? e.name).text) : undefined);
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly) {
      check(node.moduleSpecifier.text, node.exportClause && ts.isNamedExports(node.exportClause)
        ? node.exportClause.elements.filter(e => !e.isTypeOnly).map(e => (e.propertyName ?? e.name).text) : undefined);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      const arg = node.arguments[0]; if (arg && ts.isStringLiteralLike(arg)) check(arg.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file); return failures;
}
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'test-support' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(path) && !/\.test(?:[.-]|\.)|\.test-support\./.test(path) ? [path] : [];
  });
}
it('af3 R3-M1 only the session imports reveal effects outside their implementation graph', () => {
  expect(sourceFiles(root).flatMap(path => violations(path, readFileSync(path, 'utf8')))).toEqual([]);
  for (const code of [
    "import { runRevealItems as timerSend } from './features/core/v2/reveal-items';",
    "export * from './features/core/v2/reveal-hidden';",
    "const engine = await import('./features/core/v2/reveal-assets');",
    "const engine = await import(`./features/core/v2/reveal-assets.js`);",
    "import { installRevealTestSeam } from './features/core/v2/reveal-test-seam.test-support';",
  ]) expect(violations('page.tsx', code)).toHaveLength(1);
  expect(violations('page.tsx', "import { type RevealPlan, revealItemHashes } from './features/core/v2/reveal-items';")).toEqual([]);
});

it('af3 R3-M1 a production bundle even in mode test has no seam installer or registry', async () => {
  // Isolated production module build. No app config, env files, server, manifest or network.
  const result = await build({ configFile: false, envFile: false, mode: 'test', logLevel: 'silent',
    build: { write: false, minify: false, lib: { entry: join(root, 'features/core/v2/reveal-test-seam.ts'), formats: ['es'] } } });
  const output = (Array.isArray(result) ? result : [result]).flatMap(r => 'output' in r ? r.output : []);
  const code = output.filter(o => o.type === 'chunk').map(o => o.code).join('\n');
  expect(code).not.toMatch(/installRevealTestSeam|WeakMap|overrides\.set|test-seam-disabled/);
  const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`) as Record<string, unknown>;
  expect(Object.keys(module)).toEqual(['revealTestOverride']);
  expect((module.revealTestOverride as (target: object) => unknown)({})).toBeUndefined();
});
