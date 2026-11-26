import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('large capacity cases are opt-in; both runners retain the four-box default', () => {
  for (const file of ['packages/indexer/test/core/rpc-load.test.ts', 'packages/keeper/test/capacity.test.ts']) {
    const source = readFileSync(file, 'utf8');
    assert.match(source, /it\.each\(process\.env\.SH_TEST_CAPACITY === '1' \? \[50, 150\] : \[4\]\)/);
  }
});
test('ship gate includes the explicit capacity lane', () => {
  const { scripts } = JSON.parse(readFileSync('package.json'));
  assert.match(scripts['test:capacity'], /SH_TEST_CAPACITY=1/);
  for (const path of ['packages/indexer/test/core/rpc-load.test.ts', 'packages/keeper/test/capacity.test.ts']) assert.ok(scripts['test:capacity'].includes(path));
  assert.ok(scripts.verify.split(' && ').includes('pnpm test:capacity'));
});
