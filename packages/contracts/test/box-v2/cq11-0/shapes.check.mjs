import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const src = (path) => read(`packages/contracts/src/box-v2/${path}`);

test('SH-V2-INT-FIX3: authorized reserved vault event uses neutral wording', () => {
  const vault = src('interfaces/IBoxVaultV2.sol');
  assert.match(vault, /event ItemPayoutForwarded\(address indexed token, uint256 amount, address receiver\);/);
  assert.doesNotMatch(vault, /event EarnedForwarded\(/);
  assert.doesNotMatch(src('BoxVaultV2.sol'), /emit (EarnedForwarded|ItemPayoutForwarded)\(/);
});

test('CQ11-0: hook stands alone and exposes the plain pool shape', () => {
  const hook = src('interfaces/IBoxHookV2.sol');
  assert.doesNotMatch(hook, /import\s+\{IBoxHook\}/);
  for (const member of ['POOL_FEE', 'saleFeesPending', 'lastProtocolBlock', 'close', 'closedTResidue']) {
    assert.match(hook, new RegExp(`function ${member}\\(`));
  }
  assert.match(src('interfaces/ReleaseConstantsV2.sol'), /V2_POOL_FEE\s*=\s*10_000/);
  assert.match(src('interfaces/ReleaseConstantsV2.sol'), /V2_HOOK_FLAGS\s*=\s*0x2AE0/i);
});

test('CQ11-0: hook interface for box 0 is byte-identical to the supplied reference', () => {
  const path = 'packages/contracts/src/box/interfaces/IBoxHook.sol';
  const reference = execFileSync('git', ['show', `1502865eaf21061d39a663f10b7bfde6ec3429c1:${path}`], { cwd: root });
  assert.deepEqual(readFileSync(resolve(root, path)), reference);
});

test('CQ11-0: F122/F123 shapes include all Safes, hatch and one mutable raise', () => {
  const receiver = src('interfaces/IBoxReceiverV2.sol');
  for (const safe of ['FIT_SAFE', 'PLATFORM_SAFE', 'CONVERSION_SAFE']) {
    assert.match(receiver, new RegExp(`function ${safe}\\(`));
  }
  assert.match(src('interfaces/IListingRegistry.sol'), /function updateRaise\(/);
  assert.match(src('interfaces/IBoxCoordinatorV2.sol'), /function claim\(/);
  assert.match(src('interfaces/ReleaseConstantsV2.sol'), /GRADUATION_ESCAPE_DELAY\s*=\s*7 days/);
});

// CQ11-A restoration gate: a skipped row is not evidence that its behavior was exercised.
test('CQ11-A: owned launch/pool suites are restored and the real-part matrix is complete', () => {
  for (const folder of ['m1-30a', 'm1-30b']) {
    const relative = `packages/contracts/test/box-v2/${folder}`;
    for (const file of readdirSync(resolve(root, relative)).filter((name) => name.endsWith('.t.sol'))) {
      assert.doesNotMatch(read(`${relative}/${file}`), /CQ11-A:[^\n]*\n[^\n]*vm\.skip\(true\)/, file);
    }
  }
  const matrix = read('packages/contracts/test/box-v2/cq11-a/Hook.t.sol');
  assert.match(matrix, /CQ11AHookMatrixBase is CQ11ARealFixture/);
  for (const phase of ['window', 'open', 'graduated']) {
    for (const sender of ['router', 'receiver', 'other']) {
      for (const kind of ['buyExactIn', 'buyExactOut', 'saleExactIn', 'saleExactOut']) {
        assert.ok(matrix.includes(`function test_C3_${phase}_${sender}_${kind}()`));
        assert.ok(matrix.includes(`function test_C15_partial_${phase}_${sender}_${kind}()`));
      }
    }
  }
});
