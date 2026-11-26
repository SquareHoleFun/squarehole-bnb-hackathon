import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { decodeFunctionData, encodeErrorResult, parseAbi, toFunctionSelector, toHex, zeroAddress } from 'viem';
import * as alpha from './alpha-rehearsal.mjs';
import { ROOT } from './lib/core-v2-local-runtime.mjs';

const hook = '0x0000000000000000000000000000000000000001';
const other = '0x0000000000000000000000000000000000000002';
const errors = parseAbi([
  'error WrappedError(address target,bytes4 selector,bytes reason,bytes details)',
  'error BelowCurveFloor(uint160 sqrtPriceX96)',
  'error InsufficientAllowance(uint256 allowance,uint256 needed)',
]);
const callback = toFunctionSelector('afterSwap(address,(address,address,uint24,int24,address),(bool,int256,uint160),int256,bytes)');
const inner = encodeErrorResult({ abi: errors, errorName: 'BelowCurveFloor', args: [201n] });
const wrapped = (target = hook, selector = callback, reason = inner) => encodeErrorResult({ abi: errors,
  errorName: 'WrappedError', args: [target, selector, reason, toFunctionSelector('HookCallFailed()')] });

test('floor input follows the current price, liquidity and fees using bigint', () => {
  const state = { spot: 100n, floor: 200n, liquidity: 1n << 96n, fee: 10000n };
  // One T of margin covers per-bitmap-word fee rounding while crossing the upper edge.
  assert.equal(alpha.belowFloorSellAmount(state), 102n + 10n ** 18n);
  assert.ok(alpha.belowFloorSellAmount({ ...state, spot: 90n }) > alpha.belowFloorSellAmount(state));
  assert.ok(alpha.belowFloorSellAmount({ ...state, fee: 10990n, liquidity: 10n ** 40n })
    > alpha.belowFloorSellAmount({ ...state, liquidity: 10n ** 40n }));
  assert.throws(() => alpha.belowFloorSellAmount({ ...state, spot: 201n }), /curve state/);
});

test('floor reason must come from this hook afterSwap through v4 WrappedError', () => {
  const expected = { hook, reason: 'below_curve_floor', floor: 200n };
  assert.equal(alpha.assertAlphaHookError(wrapped(), expected).innerReason, 'below_curve_floor');
  for (const data of [inner, wrapped(other), wrapped(hook, '0x12345678'),
    wrapped(hook, callback, encodeErrorResult({ abi: errors, errorName: 'InsufficientAllowance', args: [0n, 10n ** 26n] }))]) {
    assert.throws(() => alpha.assertAlphaHookError(data, expected));
  }
  assert.throws(() => alpha.assertAlphaHookError(wrapped(), { ...expected, floor: 202n }));
});

test('failed receipt evidence retains expected and actual reasons before throwing', async () => {
  const out = mkdtempSync(join(ROOT, '.cache/alpha-af2-evidence-'));
  const r = new alpha.AlphaRun('http://127.0.0.1:8573', out);
  r.guard = async () => {};
  const data = encodeErrorResult({ abi: errors, errorName: 'InsufficientAllowance', args: [0n, 10n ** 26n] });
  r.request = async ({ method }) => method === 'eth_sendTransaction' ? '0x01' : { output: data };
  r.client = { waitForTransactionReceipt: async () => ({ status: 'reverted', from: other, blockNumber: 9n, gasUsed: 100n }) };
  await assert.rejects(r.send('pool sell below_curve_floor', other, hook, '0x', 0n, 'below_curve_floor'));
  alpha.writeAlphaEvidence(out, { complete: false, transactions: r.transactions });
  const result = JSON.parse(readFileSync(join(out, 'result.json'), 'utf8'));
  assert.equal(result.complete, false);
  assert.equal(result.transactions[0].expectedReason, 'below_curve_floor');
  assert.equal(result.transactions[0].actualReason, 'insufficient_allowance');
  assert.equal(result.transactions[0].contractReason, 'InsufficientAllowance');
  const md = readFileSync(join(out, 'transactions.md'), 'utf8');
  assert.match(md, /Expected reason.*Actual reason/);
  assert.match(md, /below_curve_floor.*insufficient_allowance/);
});

test('runner floor probe reads one block, funds the shortfall and approves its computed input', async () => {
  const token = '0x0000000000000000000000000000000000000003';
  const box = '0x0000000000000000000000000000000000000004';
  const helper = '0x0000000000000000000000000000000000000005';
  const floor = 1n << 96n;
  const spot = floor / 2n;
  const liquidity = 10n ** 27n;
  const amount = alpha.belowFloorSellAmount({ spot, floor, liquidity, fee: 10000n });
  let allowance = 0n;
  let balance = 100_000_000n * 10n ** 18n;
  const start = balance;
  let funded = 0n;
  const calls = [];
  let slotReads = 0;
  const r = {
    manifest: { localDeployment: { poolSwapTest: helper, poolManager: other } },
    snapshot: async () => 'snapshot',
    restore: async id => { assert.equal(id, 'snapshot'); allowance = 0n; balance = start; calls.push('restore'); },
    client: {
      getBlock: async () => ({ number: 118n, hash: '0xab' }),
      readContract: async args => {
        assert.equal(args.blockNumber, 118n);
        return toHex(slotReads++ === 0 ? spot | (10000n << 208n) : liquidity, { size: 32 });
      },
    },
    read: async (_name, _address, fn, _args, block) => {
      if (fn === 'hook') return hook;
      if (fn === 'poolKey') return { currency0: zeroAddress, currency1: token, fee: 10000, tickSpacing: 60, hooks: hook };
      if (fn === 'allowance') return allowance;
      assert.equal(block, 118n);
      if (fn === 'curve') return [-26880, 0, liquidity];
      if (fn === 'phase') return 3;
      if (fn === 'token') return token;
      assert.fail(`unexpected read ${fn}`);
    },
    balance: async (coin, who) => { assert.equal(coin, token); return who === box ? liquidity : balance; },
    request: async ({ method }) => { calls.push(method); },
    call: async (_step, from, _name, coin, fn, args) => {
      assert.equal(coin, token); calls.push(fn);
      if (fn === 'transfer') { assert.equal(from, box); funded = args[1]; balance += funded; }
      else { assert.equal(fn, 'approve'); assert.equal(args[0], helper); allowance = args[1]; }
    },
    send: async (_step, from, to, data, value, reason, context) => {
      assert.equal(from, other); assert.equal(to, helper); assert.equal(value, 0n);
      assert.equal(reason, 'below_curve_floor');
      assert.equal(allowance, amount); assert.equal(balance, amount);
      const abi = parseAbi(['function swap((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks),(bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96),(bool takeClaims,bool settleUsingBurn),bytes)']);
      const { args } = decodeFunctionData({ abi, data });
      assert.equal(args[1].amountSpecified, -amount);
      assert.equal(args[1].sqrtPriceLimitX96, floor + 1n);
      assert.equal(context.scenario.block, '118');
      calls.push('swap');
      return { row: { data: wrapped(hook, callback, encodeErrorResult({ abi: errors, errorName: 'BelowCurveFloor', args: [floor + 1n] })) } };
    },
  };
  await alpha.poolError(r, box, other, 'below_curve_floor', false);
  assert.equal(funded, amount - start);
  assert.equal(allowance, 0n); assert.equal(balance, start);
  assert.deepEqual(calls, ['anvil_impersonateAccount', 'anvil_setBalance', 'transfer', 'anvil_stopImpersonatingAccount', 'approve', 'swap', 'approve', 'restore']);
});
