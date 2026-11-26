import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { unguardedTempCalls } from '../gates/tmp-parents.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('SH-200: tests and helpers create .cache/tmp before mkdtempSync', () => {
  // Scan all owned source trees, including untracked additions; never open environment files, vendored trees or build output.
  const files = globSync('{apps,packages,infra,scripts,examples}/**/*.{js,mjs,cjs,ts,tsx,mts,cts,jsx}', {
    cwd: root, exclude: ['**/node_modules/**', '**/.*', '**/dist*/**', '**/coverage/**', 'packages/contracts/lib/**'],
  });
  const failures = [];
  for (const file of files) {
    if (!/\.[cm]?[jt]sx?$/.test(file) || file.split('/').some(part => /^\.env(?:\.|$)/.test(part))
      || /^(?:square-hole-core-v2|square-hole-handoff)\/|^packages\/contracts\/lib\//.test(file)) continue;
    const source = readFileSync(new URL(file, new URL('../../', import.meta.url)), 'utf8');
    if (source.includes('mkdtempSync') && source.includes('.cache/tmp')) failures.push(...unguardedTempCalls(source, file));
  }
  assert.deepEqual(failures, []);
});

test('temp guard checks path, order, recursive creation and lexical scope, ignoring comments', () => {
  const allocate = "const dir = mkdtempSync(resolve('.cache/tmp/case-'));";
  const mkdir = "mkdirSync('.cache/tmp', { recursive: true });";
  for (const source of [allocate, `${allocate}${mkdir}`, `// ${mkdir}\n${allocate}`,
    `function unrelated() { ${mkdir} } ${allocate}`, `if (flag) { ${mkdir} } ${allocate}`,
    `${mkdir.replace('true', 'false')}${allocate}`, `${mkdir.replace('.cache/tmp', '.cache/elsewhere')}${allocate}`]) {
    assert.equal(unguardedTempCalls(source, 'fixture.ts').length, 1, source);
  }
  for (const source of [`${mkdir}${allocate}`, `function fixture() { ${mkdir}${allocate} }`,
    `${mkdir}test('one', () => { ${allocate} });`,
    "const parent = resolve('.cache/tmp'); mkdirSync(parent, { recursive: true }); mkdtempSync(join(parent, 'case-'));",
    "mkdirSync('.cache/tmp', { recursive: true }); mkdtempSync(`.cache/tmp/${prefix}`);",
    "import { mkdtempSync as temp, mkdirSync as make } from 'node:fs'; make('.cache/tmp', { recursive: true }); temp('.cache/tmp/case-');",
    "mkdirSync(new URL('../.cache/tmp/', import.meta.url), { recursive: true }); mkdtempSync(fileURLToPath(new URL('../.cache/tmp/case-', import.meta.url)));",
    "// mkdtempSync('.cache/tmp/fake-');\nconst text = `mkdtempSync('.cache/tmp/fake-')`;",
  ]) assert.deepEqual(unguardedTempCalls(source, 'fixture.ts'), [], source);
  assert.equal(unguardedTempCalls("const parent = '.cache/tmp'; mkdtempSync(join(parent, 'case-'));", 'fixture.ts').length, 1);
  assert.equal(unguardedTempCalls("import { mkdtempSync as temp } from 'node:fs'; temp('.cache/tmp/case-');", 'fixture.ts').length, 1);
});
