import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { bareTestLimits, compareChangedLimits, root, testFiles, testLimits, unsetLimit } from '../gates/test-limits.mjs';

const imports = `import { it, test, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';\n`;

for (const code of [
  `it('plain', () => {}, 30_000);`,
  `test.only('only', () => {}, 15_000);`,
  `it.skip('skip', () => {}, 120_000);`,
  `test.concurrent.fails('fails', () => {}, 600_000);`,
  `it.each([1, 2])('row %s', () => {}, 30_000);`,
  `test.for([1, 2])('row %s', { timeout: 30_000 }, () => {});`,
  `it.each\`a | b\n1 | 2\`('row', () => {}, 30_000);`,
  `test.skipIf(true)('conditional', { timeout: 30_000 }, () => {});`,
  `it.runIf(true).each([1])('conditional row', () => {}, 30_000);`,
  `test('options last', () => {}, { timeout: 30_000 });`,
  `test('quoted option', { 'timeout': 30_000 }, () => {});`,
  `test('computed option', { ['timeout']: 30_000 }, () => {});`,
  `beforeAll(() => {}, 30_000);`,
  `beforeEach(() => {}, 30_000);`,
  `afterAll(() => {}, 30_000);`,
  `afterEach(() => {}, 30_000);`,
  `vi.setConfig({ testTimeout: 30_000 });`,
  `vi.setConfig({ hookTimeout: 30_000 });`,
  `test('parentheses', () => {}, (30_000));`,
  `test('type wrapper', () => {}, 30_000 as number);`,
]) test(`refuses a bare limit: ${code}`, () => {
  assert.equal(bareTestLimits('fixture.test.ts', imports + code).length, 1);
});

test('recognizes imported aliases, namespaces and Vitest globals', () => {
  for (const code of [
    `import { test as check } from 'vitest'; check('alias', () => {}, 30_000);`,
    `import { beforeAll as setup } from 'vitest'; setup(() => {}, 30_000);`,
    `import { vi as mock } from 'vitest'; mock.setConfig({ testTimeout: 30_000 });`,
    `import * as v from 'vitest'; v.test.only('namespace', () => {}, 30_000);`,
    `import * as v from 'vitest'; v.beforeAll(() => {}, 30_000);`,
    `import * as v from 'vitest'; v.vi.setConfig({ testTimeout: 30_000 });`,
    `import { test } from 'vitest'; const check = test.extend({}); check('extended', () => {}, 30_000);`,
    `import { test } from 'vitest'; const check = test; check('alias', () => {}, 30_000);`,
    `it('global', () => {}, 30_000);`,
  ]) assert.equal(bareTestLimits('fixture.test.ts', code).length, 1, code);
});

test('accepts helper limits in every position and leaves unrelated numbers alone', () => {
  const code = imports + `
    const LIMIT = shLimit(30_000);
    it('plain', () => {}, shLimit(30_000));
    test.each([30_000])('row', { timeout: shLimit(30_000) }, () => {});
    test('options last', () => {}, { timeout: LIMIT });
    const handler = () => {};
    test('named callback', { timeout: shLimit(30_000) }, handler);
    beforeAll(() => {}, shLimit(30_000));
    beforeEach(() => {}, LIMIT);
    afterAll(() => {}, shLimit(30_000));
    afterEach(() => {}, LIMIT);
    vi.setConfig({ testTimeout: shLimit(30_000), hookTimeout: LIMIT });
    it('ordinary', () => { expect(30_000).toBe(30_000); });
    waitFor(() => {}, { timeout: 30_000 });
    fetchThing({ timeout: 30_000 });
    const text = "it('string', () => {}, 30_000)";
    // it('comment', () => {}, 30_000);
  `;
  assert.deepEqual(bareTestLimits('fixture.test.ts', code), []);
  assert.equal(testLimits('fixture.test.ts', code).limits.length, 10);
});

test('ignores Node and browser runners, including their global-looking calls', () => {
  for (const from of ['node:test', '@playwright/test']) {
    assert.deepEqual(bareTestLimits('fixture.test.ts', `import { test, beforeAll } from '${from}';
      test('other runner', { timeout: 30_000 }, () => {}); beforeAll(() => {}, 30_000);`), []);
  }
  assert.deepEqual(bareTestLimits('fixture.test.ts', `import check from 'node:test'; check('node', { timeout: 30_000 }, () => {});`), []);
  assert.deepEqual(bareTestLimits('fixture.test.cjs', `const { test } = require('node:test'); test('node', { timeout: 30_000 }, () => {});`), []);
  assert.deepEqual(bareTestLimits('fixture.test.ts', `import { test } from './helper'; test('unrelated', () => {}, 30_000);`), []);
});

test('reports the file, test name, numeric spelling and source line', () => {
  assert.deepEqual(bareTestLimits('apps/web/fixture.test.ts', imports + `it('scan', () => {}, 30_000);`),
    [{ file: 'apps/web/fixture.test.ts', line: 2, name: "'scan'", expression: '30_000' }]);
});

test('comparison resolves old special cases, new helpers and both conditional branches without the opt-in', () => {
  for (const expression of ['30_000', 'shLimit(30_000)', 'Math.max(30_000, shTestTimeouts().testTimeout ?? 0)']) {
    const parsed = testLimits('fixture.test.ts', imports + `const LIMIT = ${expression}; it('scan', () => {}, LIMIT);`);
    assert.equal(unsetLimit(parsed.limits[0].node, parsed.constants), 30_000);
  }
  for (const expression of ['row.open ? 120_000 : 5_000', 'shLimit(row.open ? 120_000 : 5_000)']) {
    const parsed = testLimits('fixture.test.ts', imports + `it('row', () => {}, ${expression});`);
    assert.deepEqual(unsetLimit(parsed.limits[0].node, parsed.constants), { condition: 'row.open', whenTrue: 120_000, whenFalse: 5_000 });
  }
});

test('comparison reports added and deleted files without reading missing files, and still compares existing limits', async () => {
  const before = new Map([['existing.test.ts', imports + `it('same', () => {}, 30_000);`]]);
  const after = new Map([['existing.test.ts', imports + `it('same', () => {}, shLimit(30_000));`]]);
  const read = files => file => {
    assert.ok(files.has(file), `unexpected read: ${file}`);
    return files.get(file);
  };
  const changes = 'A\0new test.test.ts\0D\0deleted.test.ts\0M\0existing.test.ts\0A\0helper.ts\0';
  const result = await compareChangedLimits(changes, read(before), read(after));
  assert.deepEqual(result.added, ['new test.test.ts']);
  assert.deepEqual(result.deleted, ['deleted.test.ts']);
  assert.deepEqual(result.rows, [{ file: 'existing.test.ts', name: "'same'", kind: 'timeout', limit: 30_000,
    before: 30_000, after: 30_000, line: 2 }]);
  after.set('existing.test.ts', imports + `it('same', () => {}, shLimit(30_001));`);
  await assert.rejects(compareChangedLimits(changes, read(before), read(after)), /unset limit changed/);
});

test('comparison propagates read failures for existing files instead of treating them as additions or deletions', async () => {
  const code = imports + `it('same', () => {}, 30_000);`;
  const denied = () => { throw new Error('read denied'); };
  await assert.rejects(compareChangedLimits('M\0existing.test.ts\0', denied, () => code), /read denied/);
  await assert.rejects(compareChangedLimits('M\0existing.test.ts\0', () => code, denied), /read denied/);
});

test('repository Vitest tests have no bare numeric test or hook limits', async () => {
  const files = await testFiles();
  assert.ok(files.length > 1000, `found ${files.length} test files`);
  assert.deepEqual(files.flatMap(file => bareTestLimits(file, readFileSync(resolve(root, file), 'utf8'))), []);
});
