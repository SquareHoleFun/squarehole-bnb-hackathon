// @vitest-environment node
/**
 * SH-203: the reveal pages add no sending logic. Page code (the Reveal items view, its entry, its words, the box page
 * and the hidden draws panel) may import from the reveal session only `createRevealSession` (or the hidden panel's
 * `createHiddenOpeningSession` from hidden-draws.ts) and types; never an engine module, the journal store, IndexedDB,
 * the clock, the RPC adapter or the test seam, by any import form; and names no wallet request.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const here = fileURLToPath(new URL('.', import.meta.url));
const PAGES = ['RevealItemsV2.tsx', 'RevealEntryV2.tsx', 'RevealRecoveryV2.tsx', 'reveal-words.ts', 'V2BoxPage.tsx', 'HiddenDrawsV2.tsx'];
/** Modules page code never imports a value from (types are fine: they carry no code). */
const ENGINES = ['reveal-items', 'reveal-hidden', 'reveal-assets', 'reveal-items-store', 'reveal-indexeddb', 'reveal-clock', 'reveal-rpc', 'reveal-test-seam'];
/** The only values page code takes from the session's modules. */
const ALLOWED: Readonly<Record<string, readonly string[]>> = { 'reveal-session': ['createRevealSession'], 'hidden-draws': ['createHiddenOpeningSession'] };

export function pageViolations(path: string, text: string): string[] {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const check = (specifier: string, names: readonly string[] | undefined) => {
    const module = specifier.split('/').at(-1)?.replace(/\.[cm]?[jt]sx?$/, '') ?? specifier;
    if (/test-support|\.test(?:$|\.)/.test(specifier)) { found.push(`${path}: test module ${specifier}`); return; }
    if (ENGINES.includes(module) || ENGINES.some((engine) => module === `${engine}.test-support`)) {
      if (names === undefined || names.length > 0) found.push(`${path}: engine ${specifier} (${names?.join(',') ?? '*'})`);
      return;
    }
    if (module === 'reveal-session' && (names === undefined || names.some((name) => !ALLOWED['reveal-session']?.includes(name)))) {
      found.push(`${path}: session internals ${specifier} (${names?.join(',') ?? '*'})`);
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (!clause?.isTypeOnly) {
        const bindings = clause?.namedBindings;
        const names = bindings && ts.isNamedImports(bindings) ? bindings.elements.filter((e) => !e.isTypeOnly).map((e) => (e.propertyName ?? e.name).text) : undefined;
        // A default import or a namespace import takes the whole module.
        check(node.moduleSpecifier.text, clause?.name || (bindings && ts.isNamespaceImport(bindings)) || !clause ? undefined : names);
      }
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly) {
      check(node.moduleSpecifier.text, node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements.filter((e) => !e.isTypeOnly).map((e) => (e.propertyName ?? e.name).text) : undefined);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) check(arg.text, undefined);
    }
    if (ts.isStringLiteralLike(node) && /^eth_|^wallet_/.test(node.text)) found.push(`${path}: wallet request ${node.text}`);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

it('SH-203 page code imports only the session’s factory and types, and names no wallet request', () => {
  for (const page of PAGES) expect(pageViolations(page, readFileSync(join(here, page), 'utf8')), page).toEqual([]);
  expect(readFileSync(join(here, 'RevealItemsV2.tsx'), 'utf8')).toContain("import { createRevealSession, type RevealSession");
  expect(readFileSync(join(here, 'HiddenDrawsV2.tsx'), 'utf8')).toContain('createHiddenOpeningSession');
});

it('control: every engine, store, seam and session-internal import form fails', () => {
  for (const code of [
    "import { runRevealItems } from './reveal-items';",
    "import { prepareRevealItems as plan } from './reveal-items';",
    "import * as engine from './reveal-hidden';",
    "import engine from './reveal-assets';",
    "import './reveal-indexeddb';",
    "import { readRevealProgress } from './reveal-items-store';",
    "import { releaseWait } from './reveal-clock';",
    "import { createRevealRPC } from './reveal-rpc';",
    "import { revealTestOverride } from './reveal-test-seam';",
    "import { installRevealTestSeam } from './reveal-test-seam.test-support';",
    "import { runFixture } from './reveal-items.test-support';",
    "export { runRevealItems } from './reveal-items';",
    "export * from './reveal-hidden';",
    "const engine = await import('./reveal-assets');",
    "const engine = require('./reveal-items');",
    "import { requireRevealAuthority } from './reveal-session';",
    "import { createRevealSession, trustedRevealPresses } from './reveal-session';",
    "import * as session from './reveal-session';",
    "const send = () => request({ method: 'eth_sendTransaction' });",
    "const ask = () => request({ method: 'wallet_switchEthereumChain' });",
  ]) expect(pageViolations('page.tsx', code), code).toHaveLength(1);
  for (const code of [
    "import { createRevealSession, type RevealSessionState } from './reveal-session';",
    "import type { RevealPlan } from './reveal-items';",
    "import { type HiddenOpeningHandle } from './reveal-hidden';",
    "import type * as engine from './reveal-assets';",
  ]) expect(pageViolations('page.tsx', code), code).toEqual([]);
});
