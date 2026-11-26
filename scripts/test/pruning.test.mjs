import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { emptyForgeStub } from '../gates/pruning.mjs';

const stub = 'pragma solidity 0.8.26; import {Test} from "forge-std/Test.sol"; contract Deferred is Test { function test_deferred() public { vm.skip(true); } }';
test('pruning proof accepts only wholly empty stubs; any setup or executing check refuses deletion', () => {
  assert.deepEqual(emptyForgeStub(stub), ['test_deferred']);
  for (const source of [stub.replace('vm.skip(true);', 'assertEq(1, 1); vm.skip(true);'), stub.replace('vm.skip(true);', 'if (condition) vm.skip(true);'),
    stub.replace('function test_deferred()', 'function setUp() public {} function test_deferred()'), stub.replace('vm.skip(true);', 'vm.skip(false);')]) assert.equal(emptyForgeStub(source), null);
});
test('reviewed empty stubs and never-discovered UI specs are removed; executable and protected candidates stay', () => {
  const removed = JSON.parse(readFileSync('scripts/gates/pruned-tests.json'));
  for (const { path } of [...removed.forge, ...removed.e2e]) assert.equal(existsSync(path), false, path);
  for (const path of ['packages/contracts/test/box-v2/m1-40a/VaultCount.t.sol', 'packages/contracts/test/box-v2/existing-nfts/SetPoolGas.t.sol',
    'packages/contracts/test/box-v2/existing-nfts/SetVault.t.sol', 'packages/contracts/test/box-v2/rc6-cow/ForkCow.t.sol',
    'apps/web/e2e/f74-polish-shots.spec.ts', 'apps/web/e2e/pair-detail.spec.ts', 'apps/web/e2e/acceptance/oracle.spec.ts',
    'packages/domain/src/tx-state.test.ts', 'packages/domain/src/feed-golden.test.ts']) assert.ok(existsSync(path), path);
});
