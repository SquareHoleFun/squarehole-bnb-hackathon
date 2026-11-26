import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { shLimit } from '../../vitest.timeouts.mjs';

// Replay the real setup callbacks with a child-process double. No art build or wall-clock sleep
// is needed to prove which budget owns a cold build, including a test selected with Vitest -t.
function suite(path) {
  const text = readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const hooks = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'beforeAll') hooks.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  const run = (code, context) => vm.runInNewContext(ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText, context);
  return { source, hooks, run };
}

test('af3: reveal download builds in setup with the full cold-build budget', () => {
  const { source, hooks, run } = suite('packages/chain/scripts/reveal-open-v2.test.ts');
  assert.equal(hooks.length, 1);
  let builds = 0, setup;
  const result = run(`let download; ${hooks[0].getText(source)}; setup(); download;`, {
    process, shLimit, root: '/repo', join, mkdirSync() {},
    execFileSync() { builds++; return '{"prepared":true}'; },
    beforeAll(callback, timeout) { assert.equal(timeout, shLimit(600_000)); setup = callback; },
    setup() { setup(); },
  });
  assert.equal(result.prepared, true);
  assert.equal(builds, 1);
});

test('af3: any open-kit assertion reads prepared settings without starting a build', () => {
  const { source, hooks, run } = suite('apps/web/src/features/create/v2/kit-settings.test.ts');
  assert.equal(hooks.length, 1, 'each kit needs a setup hook, even when only a later assertion is selected');
  const settings = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'settingsOf');
  const map = source.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(declaration => declaration.name.getText(source) === 'builtSettings'));
  for (const kit of ['rent-free', 'bag-holders', 'link-marines-v2', 'exit-liquidity']) {
    let builds = 0, setup;
    const context = {
      process, shLimit, ROOT: '/repo', row: { kit, open: true },
      execFileSync() { builds++; return `settings:${kit}`; },
      beforeAll(callback, timeout) { assert.equal(timeout, shLimit(600_000)); setup = callback; },
    };
    const access = run(`${map.getText(source)}\n${settings.getText(source)}\n${hooks[0].getText(source)}; ({ read: () => settingsOf(row) });`, context);
    assert.throws(() => access.read(), /setup|prepared/i, 'an assertion cannot silently do cold preparation');
    assert.equal(builds, 0);
    setup();
    assert.equal(builds, 1);
    assert.equal(access.read(), `settings:${kit}`);
    assert.equal(access.read(), `settings:${kit}`);
    assert.equal(builds, 1);
  }
});
