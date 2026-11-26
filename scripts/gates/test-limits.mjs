import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { shLimit } from '../../vitest.timeouts.mjs';

export const root = fileURLToPath(new URL('../../', import.meta.url));
const git = promisify(execFile);
const tests = new Set(['it', 'test']);
const hooks = new Set(['beforeAll', 'afterAll', 'beforeEach', 'afterEach']);
const factories = new Set(['each', 'for', 'skipIf', 'runIf', 'extend']);
const globals = new Set([...tests, ...hooks, 'vi', 'vitest']);

function unwrap(node) {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
    || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node))) node = node.expression;
  return node;
}

/** Inspect timeout positions only. Strings, comments, waitFor and transport options are not test limits. */
export function testLimits(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const bindings = new Map();
  const namespaces = new Set();
  const constants = new Map();
  const aliases = new Map();
  let foreignRunner = false;
  for (const node of source.statements) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const from = node.moduleSpecifier.text;
      if (['node:test', 'test', '@playwright/test', 'playwright/test'].includes(from)) foreignRunner = true;
      const names = node.importClause?.namedBindings;
      if (names && ts.isNamedImports(names)) {
        for (const name of names.elements) bindings.set(name.name.text, from === 'vitest' ? (name.propertyName ?? name.name).text : null);
      } else if (names && ts.isNamespaceImport(names) && from === 'vitest') namespaces.add(names.name.text);
      if (node.importClause?.name) bindings.set(node.importClause.name.text, null);
    }
  }
  function runnerImports(node) {
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      const from = node.arguments[0];
      if (from && ts.isStringLiteralLike(from) && ['node:test', 'test', '@playwright/test', 'playwright/test'].includes(from.text)) foreignRunner = true;
    }
    ts.forEachChild(node, runnerImports);
  }
  runnerImports(source);
  function api(node) {
    node = unwrap(node);
    if (ts.isIdentifier(node)) {
      if (aliases.has(node.text)) return aliases.get(node.text);
      const kind = bindings.has(node.text) ? bindings.get(node.text) : !foreignRunner && globals.has(node.text) ? node.text : null;
      return kind ? { kind, factory: false } : undefined;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = ts.isPropertyAccessExpression(node) ? node.name.text
        : ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;
      if (ts.isIdentifier(node.expression) && namespaces.has(node.expression.text)) return { kind: name, factory: false };
      const base = api(node.expression);
      if (base) return { ...base, method: name, factory: factories.has(name) };
    }
    if (ts.isCallExpression(node) || ts.isTaggedTemplateExpression(node)) {
      const base = api(ts.isCallExpression(node) ? node.expression : node.tag);
      if (base?.factory) return { ...base, factory: false };
    }
  }
  const limits = [];
  function add(value, call, kind, name) {
    const node = unwrap(value);
    if (!node) return;
    limits.push({ file, name, kind, line: source.getLineAndCharacterOfPosition(value.getStart(source)).line + 1,
      start: value.getStart(source), end: value.end, expression: value.getText(source),
      bare: ts.isNumericLiteral(node) || ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(unwrap(node.operand)),
      node: value, call });
  }
  function options(value, call, keys, name) {
    value = unwrap(value);
    if (!value || !ts.isObjectLiteralExpression(value)) return;
    for (const property of value.properties) {
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
      const key = ts.isComputedPropertyName(property.name) ? unwrap(property.name.expression) : property.name;
      const nameText = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined;
      if (keys.includes(nameText)) add(property.initializer ?? property.name, call, nameText, name);
    }
  }
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      constants.set(node.name.text, node.initializer);
      const target = api(node.initializer);
      if (target) aliases.set(node.name.text, target);
    }
    if (ts.isCallExpression(node)) {
      const target = api(node.expression);
      if (target && !target.factory) {
        const args = node.arguments;
        if (tests.has(target.kind)) {
          const name = args[0]?.getText(source) ?? '<unnamed>';
          options(args[1], node, ['timeout'], name);
          if (args[2] && !ts.isObjectLiteralExpression(unwrap(args[1]))) {
            if (ts.isObjectLiteralExpression(unwrap(args[2]))) options(args[2], node, ['timeout'], name);
            else if (!ts.isArrowFunction(unwrap(args[2])) && !ts.isFunctionExpression(unwrap(args[2]))) add(args[2], node, 'timeout', name);
          }
        } else if (hooks.has(target.kind) && args[1]) {
          if (ts.isObjectLiteralExpression(unwrap(args[1]))) options(args[1], node, ['timeout'], target.kind);
          else add(args[1], node, 'timeout', target.kind);
        } else if (['vi', 'vitest'].includes(target.kind) && target.method === 'setConfig') {
          options(args[0], node, ['testTimeout', 'hookTimeout'], 'vi.setConfig');
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { limits, constants, source };
}

export async function testFiles() {
  return (await git('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'apps', 'packages', 'infra', 'scripts'],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })).stdout.split('\0').filter(file => /\.(test|spec)\.[cm]?[jt]sx?$/.test(file));
}

export function bareTestLimits(file, text) {
  return testLimits(file, text).limits.filter(limit => limit.bare).map(({ file, line, name, expression }) => ({ file, line, name, expression }));
}

// A deliberately small evaluator for the comparison. Never execute a test or read process.env.
export function unsetLimit(node, constants, seen = new Set()) {
  node = unwrap(node);
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isIdentifier(node) && constants.has(node.text) && !seen.has(node.text)) {
    return unsetLimit(constants.get(node.text), constants, new Set([...seen, node.text]));
  }
  if (ts.isCallExpression(node) && node.expression.getText() === 'shLimit') {
    const value = unsetLimit(node.arguments[0], constants, seen);
    // Compare both sides of a conditional without choosing a fixture row or running test code.
    const apply = value => typeof value === 'number' ? shLimit(value, {})
      : { ...value, whenTrue: apply(value.whenTrue), whenFalse: apply(value.whenFalse) };
    return apply(value);
  }
  if (ts.isConditionalExpression(node)) return { condition: node.condition.getText(),
    whenTrue: unsetLimit(node.whenTrue, constants, seen), whenFalse: unsetLimit(node.whenFalse, constants, seen) };
  if (ts.isCallExpression(node) && node.expression.getText() === 'Math.max') return Math.max(...node.arguments.map(arg => unsetLimit(arg, constants, seen)));
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    && node.left.getText() === 'shTestTimeouts().testTimeout') return unsetLimit(node.right, constants, seen);
  throw new Error(`Cannot compare timeout expression: ${node.getText()}`);
}

/** Compare files present on both sides; report additions and deletions without reading a missing side. */
export async function compareChangedLimits(changed, readBefore, readAfter) {
  const rows = [], added = [], deleted = [];
  const entries = changed.split('\0');
  for (let i = 0; i < entries.length - 1; i += 2) {
    const status = entries[i], file = entries[i + 1];
    if (!/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) continue;
    if (status === 'A') { added.push(file); continue; }
    if (status === 'D') { deleted.push(file); continue; }
    const before = testLimits(file, await readBefore(file));
    const after = testLimits(file, await readAfter(file));
    const snapshot = parsed => parsed.limits.map(limit => ({ file, name: limit.name, kind: limit.kind, limit: unsetLimit(limit.node, parsed.constants) }));
    const oldRows = snapshot(before);
    const newRows = snapshot(after);
    assert.deepEqual(newRows, oldRows, `${file}: a test name, order, or unset limit changed`);
    rows.push(...oldRows.map((row, i) => ({ ...row, before: row.limit, after: newRows[i].limit, line: after.limits[i].line })));
  }
  return { rows, added, deleted };
}

/** List each existing changed file's limits before and after, then compare exactly. */
export async function compareLimits(ref, files = ['apps', 'packages', 'infra', 'scripts']) {
  // Treat renames as an explicit deletion and addition, not a request for a nonexistent baseline path.
  const changed = (await git('git', ['diff', '--name-status', '--no-renames', '-z', ref, '--', ...files],
    { cwd: root, encoding: 'utf8' })).stdout;
  return compareChangedLimits(changed,
    async file => (await git('git', ['show', `${ref}:${file}`], { cwd: root, encoding: 'utf8' })).stdout,
    file => readFileSync(resolve(root, file), 'utf8'));
}

// The real path of the started file: through a linked path a plain resolve() never equals import.meta.url
// (scripts/test/entry-points.test.mjs).
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  if (process.argv[2] === '--compare-ref') {
    const files = process.argv.slice(4).filter(arg => arg !== '--');
    const { rows, added, deleted } = await compareLimits(process.argv[3] ?? 'HEAD', files.length ? files : undefined);
    for (const file of added) process.stdout.write(`Not compared: added test file ${file} (no baseline).\n`);
    for (const file of deleted) process.stdout.write(`Not compared: deleted test file ${file} (no current file).\n`);
    for (const row of rows) process.stdout.write(`${JSON.stringify(row)}\n`);
    process.stdout.write(`PASS: ${rows.length} explicit limits in existing files are identical with SH_TEST_TIMEOUT unset; ${added.length} added and ${deleted.length} deleted test files were not compared.\n`);
  } else {
    const files = await testFiles();
    const violations = files.flatMap(file => bareTestLimits(file, readFileSync(resolve(root, file), 'utf8')));
    for (const item of violations) process.stderr.write(`${item.file}:${item.line}: ${item.name}: wrap ${item.expression} in shLimit()\n`);
    process.stdout.write(`Checked ${files.length} test files; ${violations.length} bare limits.\n`);
    if (violations.length) process.exitCode = 1;
  }
}
