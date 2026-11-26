import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { assertFresh, buildReachMap, GUARDS, MAP_PATH, mapText } from '../gates/reach.mjs';
import { affectedPackages, changedPaths, planMerge, selectTests } from '../gates/verify-merge.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'merge-gate-')), files = [];
  const write = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); if (!files.includes(path)) files.push(path); };
  write('package.json', JSON.stringify({ scripts: { verify: 'pnpm check:handoff && pnpm typecheck && pnpm test && pnpm test:scripts', 'test:scripts': 'node --test scripts/test/*.test.mjs' } }));
  write('packages/a/package.json', JSON.stringify({ name: '@squarehole/a', scripts: { typecheck: 'tsc --noEmit' } }));
  write('packages/a/src/types.ts', "import { readFileSync } from 'node:fs'; export type Data = ReturnType<typeof readFileSync>;");
  write('packages/a/src/value.ts', "import type { Data } from './types'; export const value = 1; // No runtime import (only types).");
  write('apps/web/e2e/current.spec.mjs', "import { test } from '@playwright/test'; test('browser', () => {});");
  write('apps/web/e2e/life.e2e.mjs', "import { test } from '@playwright/test'; test('life', () => {});");
  write('packages/a/src/value.test.ts', "import { it } from 'vitest'; import { value } from './value'; it('value', () => value);");
  write('scripts/test/fs-helper.mjs', "import { readFileSync } from 'node:fs'; export const read = path => readFileSync(path);");
  write('scripts/test/read.test.mjs', "import { test } from 'node:test'; import { read } from './fs-helper.mjs'; test('dynamic read', () => read(process.argv[2]));");
  return { root, files, write };
}
test('generated reach follows fs helpers, catches dynamic paths and includes ship node groups', () => {
  const { root, files } = fixture(), map = buildReachMap(root, files);
  assert.equal(map.tests['scripts/test/read.test.mjs'].runner, 'node');
  assert.ok(map.tests['scripts/test/read.test.mjs'].reaches.includes('*'));
  assert.deepEqual(map.tests['packages/a/src/value.test.ts'].reaches, []);
  assert.ok(map.playwright.includes('apps/web/e2e/current.spec.mjs'));
  assert.ok(map.playwright.includes('apps/web/e2e/life.e2e.mjs'));
  assert.equal(map.tests['apps/web/e2e/life.e2e.mjs'].runner, 'playwright');
  assert.ok(selectTests(map, ['some-new/unrelated-input.json']).node.includes('scripts/test/read.test.mjs'));
});
test('staleness catches source changes, helper changes, additions and removals', () => {
  const { root, files, write } = fixture();
  const save = () => write(MAP_PATH, mapText(buildReachMap(root, files)));
  save(); assert.doesNotThrow(() => assertFresh(root, buildReachMap(root, files)));
  write('scripts/test/fs-helper.mjs', "export const read = () => 'changed';");
  assert.throws(() => assertFresh(root, buildReachMap(root, files)), /stale/);
  save(); write('packages/a/src/new.test.ts', "import { it } from 'vitest'; it('new', () => {});");
  assert.throws(() => assertFresh(root, buildReachMap(root, files)), /stale/);
  save(); assert.throws(() => assertFresh(root, buildReachMap(root, files.filter(path => !path.endsWith('value.test.ts')))), /stale/);
});
test('affected typechecks include transitive consumers and never silently drop a package', () => {
  const packages = [
    { path: 'packages/a', name: 'a', dependencies: [] }, { path: 'packages/b', name: 'b', dependencies: ['a'] },
    { path: 'apps/web', name: 'web', dependencies: ['b'] }, { path: 'packages/c', name: 'c', dependencies: [] },
  ];
  assert.deepEqual(affectedPackages(packages, ['packages/a/src/a.ts']).map(pkg => pkg.name), ['a', 'b', 'web']);
  assert.equal(affectedPackages(packages, [], true).length, 4);
});
test('plans combine native Vitest related roots with guards/reach and never execute Playwright or forge', () => {
  const { root, files } = fixture(), map = buildReachMap(root, files);
  for (const path of GUARDS) map.tests[path] = { runner: 'vitest', owner: 'apps/web', reaches: [] };
  map.playwright = ['apps/web/e2e/current.spec.ts']; map.forge = ['packages/contracts/test/current.t.sol'];
  const plan = planMerge(root, map, { base: 'test', paths: ['packages/a/src/value.ts'] }, files);
  assert.equal(plan.fullFallback, false);
  const related = plan.commands.find(step => step.args.includes('related'));
  assert.ok(related.args.includes('packages/a/src/value.ts'));
  for (const guard of GUARDS) assert.ok(related.args.includes(guard));
  assert.deepEqual(plan.playwright, map.playwright); assert.deepEqual(plan.forge, map.forge);
  assert.ok(plan.commands.every(step => !step.args.includes('playwright') && step.command !== 'forge'));
  const deleted = planMerge(root, map, { base: 'test', paths: ['packages/a/src/deleted.ts'] }, files);
  assert.equal(deleted.fullFallback, true);
  assert.ok(deleted.commands.some(step => step.args[0] === 'typecheck'));
  assert.ok(deleted.commands.some(step => step.args.includes('run')));
});
test('bad base refs fail closed', () => {
  assert.throws(() => changedPaths(''), /usage/);
  assert.throws(() => changedPaths('--help'), /usage/);
  assert.throws(() => changedPaths('refs/heads/this-branch-does-not-exist-sh197'));
});
test('committed reach map is fresh', () => { assertFresh(); });
test('ship retains all original checks and the large capacity lane', () => {
  const { scripts } = JSON.parse(readFileSync('package.json'));
  for (const command of ['check:handoff', 'check:reference', 'check:launch-shape', 'check:box-spec', 'check:conformance', 'check:launch-skill', 'typecheck', 'lint', 'test', 'test:capacity', 'test:scripts', 'build']) {
    assert.ok(scripts.verify.split(' && ').includes(`pnpm ${command}`), command);
  }
});
