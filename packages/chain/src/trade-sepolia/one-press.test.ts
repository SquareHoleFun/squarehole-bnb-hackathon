/**
 * SH-ONE-PRESS-TRADE: what the trade calls give the one press. A plan that still needs its exact approval carries the
 * figures the person sees before the press (the pool's replayed quote; for a window buy the router's own `quote` and
 * the replay of what it swaps), equal to the figures of the plan made once the approval is in place. A read the RPC did
 * not answer is `rpc_failed` (the page tries it again quietly), never "could not simulate".
 */
import { boxCurve } from '../../../box-spec/src/layout-v2';
import { getTickAtSqrtPrice } from '../../../box-spec/src/v4-math';
import { decodeFunctionData, encodeErrorResult, type Abi, type AbiFunction, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { launchRouterV2Abi } from '../core/v2/abi-v2';
import { RpcShapeError, type Eip1193Request } from '../write/eip1193';
import { RpcRequestError } from '../write/rpc';
import { TRADE_ABI, TRADE_ERRORS } from './abi';
import { simulatePoolSwap } from './pool';
import { isReadFailure } from './revert';
import { failureReason, prepareTradeSepolia, TradeRefusedError } from './trade';
import { COIN, COORDINATOR, fixture, LOCAL, ROUTER, USER } from './test-support';

const ETHER = 10n ** 18n;
const figures = (plan: { expectedInput: bigint | null; expectedOutput: bigint | null; expectedSqrtPriceX96: bigint | null }) =>
  [plan.expectedInput, plan.expectedOutput, plan.expectedSqrtPriceX96];

describe('a plan that needs its approval carries the figures the person sees before the one press', () => {
  it.each([[3, 'buy'], [3, 'sell'], [5, 'buy'], [5, 'sell']] as const)('a pool trade in phase %i (%s): the replay’s figures, equal to the plan made after the approval', async (phase, side) => {
    const amount = ETHER / 100n;
    const f = fixture({ p: COIN, phase, allowance: 0n });
    const before = await f.prepare(side, amount);
    if (!before.ok) throw new Error(before.reason);
    expect(before.plan.reason).toBe('approval_required');
    expect(before.plan.call).toBeNull();
    // No simulation of a call and no gas estimate before the approval: the figures come from the pool's storage.
    expect(f.calls.filter((c) => c.method === 'eth_estimateGas')).toEqual([]);
    expect(f.calls.filter((c) => c.method === 'eth_call').map((c) => decodeFunctionData({ abi: TRADE_ABI, data: (c.params as [{ data: Hex }])[0].data }).functionName)).not.toContain('swap');
    expect(before.plan.expectedOutput).toBeGreaterThan(0n);
    f.state.allowance = amount;
    const after = await f.prepare(side, amount);
    if (!after.ok) throw new Error(after.reason);
    expect(after.plan.call).not.toBeNull();
    expect(figures(before.plan)).toEqual(figures(after.plan));
  });

  it('a window buy with an ERC-20 price coin: the router’s own split at the plan block, and the replay of what it swaps to the curve’s end', async () => {
    const amount = ETHER / 100n;
    const taxPips = 931_974n;
    const f = fixture({ p: COIN, phase: 2, allowance: 0n, taxPips });
    const before = await f.prepare('buy', amount);
    if (!before.ok) throw new Error(before.reason);
    expect(before.plan.reason).toBe('approval_required');
    // The router was asked its `quote` for this amount, at the plan block; nothing was simulated or estimated.
    const quotes = f.calls.filter((c) => c.method === 'eth_call').map((c) => c.params as [{ to: string; data: Hex }, string])
      .filter(([call]) => decodeFunctionData({ abi: TRADE_ABI, data: call.data }).functionName === 'quote');
    expect(quotes.map(([call, block]) => [call.to, decodeFunctionData({ abi: TRADE_ABI, data: call.data }).args, block])).toEqual([[ROUTER, [amount], '0x10']]);
    expect(f.calls.filter((c) => c.method === 'eth_estimateGas')).toEqual([]);
    const swapIn = amount - (amount * taxPips + 999_999n) / 1_000_000n;
    const replay = await simulatePoolSwap(async (slot) => { const v = f.storage[slot]; if (v === undefined) throw new Error(slot); return v; }, f.base, true, swapIn, boxCurve(10n ** 18n, false).sqrtPriceEndX96);
    expect(before.plan.expectedOutput).toBe(replay.output);
    expect(before.plan.expectedInput).toBeNull();
    // The window's tax leaves nothing to swap: refused before any approval, as the router would revert.
    const all = fixture({ p: COIN, phase: 2, allowance: 0n, taxPips: 1_000_000n });
    expect(await all.prepare('buy', amount)).toEqual({ ok: false, reason: 'amount_too_small' });
  });

  it('the router’s `quote` fragment is the generated router ABI’s own', () => {
    const own = (abi: Abi) => abi.find((item): item is AbiFunction => item.type === 'function' && item.name === 'quote');
    const strip = (fn: AbiFunction | undefined) => fn && { name: fn.name, stateMutability: fn.stateMutability, inputs: fn.inputs.map((i) => i.type), outputs: fn.outputs.map((o) => [o.type, o.name]) };
    expect(strip(own(TRADE_ABI as Abi))).toEqual(strip(own(launchRouterV2Abi as Abi)));
    expect(strip(own(TRADE_ABI as Abi))).toEqual({ name: 'quote', stateMutability: 'view', inputs: ['uint256'], outputs: [['uint256', 'tax'], ['uint256', 'swapIn']] });
  });

  it('a pool trade that cannot be priced is refused before the approval, not after it', async () => {
    const curve = boxCurve(10n ** 18n, false);
    // The curve's end is already reached: no buy is possible, so no approval is asked for.
    const f = fixture({ p: COIN, allowance: 0n, spot: curve.sqrtPriceEndX96 });
    expect(await f.prepare('buy', ETHER / 100n)).toEqual({ ok: false, reason: 'price_limit_unavailable' });
  });
});

describe('a read the RPC did not answer is rpc_failed, never "could not simulate" (item 2)', () => {
  // What publicnode answered for a read at the block it had just named (the probe in SH-ONE-PRESS-TRADE), what the fork
  // answered when its upstream read was reset, and a request that never reached the RPC.
  const blockNotFound = new RpcRequestError('block not found: 0xb7b937', -32001, undefined);
  const upstreamReset = new RpcRequestError('failed to get storage for 0x5B39…: connection reset', -32603, undefined);
  const transport = new RpcRequestError('eth_call could not reach the RPC', null, undefined);
  const limited = new RpcRequestError('RPC HTTP 429', null, undefined);
  const malformed = new RpcShapeError('eth_call result is not hex data');

  it.each([['block not found', blockNotFound], ['an upstream reset', upstreamReset], ['transport', transport], ['a rate limit', limited], ['a malformed answer', malformed]] as const)('%s', (_name, error) => {
    expect(isReadFailure(error)).toBe(true);
    expect(failureReason(error)).toBe('rpc_failed');
  });

  it('a revert stays the contract’s answer: decoded when known, else read_or_simulation_failed', () => {
    const known = new RpcRequestError('execution reverted', 3, encodeErrorResult({ abi: TRADE_ERRORS, errorName: 'PriceLimitAlreadyExceeded', args: [2n, 1n] }));
    expect(failureReason(known)).toBe('price_limit_already_exceeded');
    // A revert with data no ABI here knows, with code 3 and without data, or geth's -32000: never a read failure.
    for (const error of [new RpcRequestError('execution reverted', 3, '0xdeadbeef'), new RpcRequestError('execution reverted', 3, undefined),
      new RpcRequestError('execution reverted', -32000, undefined), new RpcRequestError('internal', -32603, '0x12345678aa'), new Error('invalid pool state')]) {
      expect(isReadFailure(error)).toBe(false);
      expect(failureReason(error)).toBe('read_or_simulation_failed');
    }
    expect(failureReason(new TradeRefusedError('balance_low'))).toBe('balance_low');
  });

  it('a plan whose one read at the named block fails says rpc_failed, and the same plan a moment later is made', async () => {
    const f = fixture({ p: COIN, allowance: 0n });
    let failed = 0;
    const rpc: Eip1193Request = async (request) => {
      if (request.method === 'eth_call' && failed === 0) { failed += 1; throw { code: -32001, message: 'block not found: 0x10' }; }
      return f.rpc(request);
    };
    const prepare = () => prepareTradeSepolia({ rpc, chainId: 31337, coordinator: COORDINATOR, from: USER, side: 'buy', amountIn: ETHER / 100n, localDeployment: LOCAL });
    expect(await prepare()).toEqual({ ok: false, reason: 'rpc_failed' });
    expect((await prepare()).ok).toBe(true);
  });
});

describe('af1: the plan made after the approval carries the pressed quote\'s bound, never a looser one', () => {
  const amount = ETHER / 100n;
  const swapLimitOf = (call: { data: Hex } | null) => {
    const decoded = decodeFunctionData({ abi: TRADE_ABI, data: (call as { data: Hex }).data });
    if (decoded.functionName !== 'swap') throw new Error('swap expected');
    return decoded.args[1].sqrtPriceLimitX96;
  };
  /** Another buyer moves the fixture pool's price by `ppm` millionths of its square root, its tick with it. */
  const move = (f: ReturnType<typeof fixture>, ppm: bigint) => {
    const spot = (f.storage[f.base] as bigint) & ((1n << 160n) - 1n);
    const moved = spot * (1_000_000n + ppm) / 1_000_000n;
    f.storage[f.base] = moved | (BigInt.asUintN(24, BigInt(getTickAtSqrtPrice(moved))) << 160n) | (10000n << 208n);
    return moved;
  };

  it('a pool buy: the plan before the approval names the limit its call will carry', async () => {
    const f = fixture({ p: COIN, allowance: 0n });
    const before = await f.prepare('buy', amount);
    if (!before.ok) throw new Error(before.reason);
    f.state.allowance = amount;
    const after = await f.prepare('buy', amount);
    if (!after.ok) throw new Error(after.reason);
    expect(before.plan.priceLimitX96).not.toBeNull();
    expect(before.plan.priceLimitX96).toBe(after.plan.priceLimitX96);
    expect(swapLimitOf(after.plan.call)).toBe(after.plan.priceLimitX96);
    expect(after.plan.minimumOutput).toBeNull();
  });

  it('the price moved against the buyer within the tolerance: the plan\'s own limit would be looser; it carries the pressed one, and still fills whole', async () => {
    const f = fixture({ p: COIN, allowance: amount });
    const pressed = await f.prepare('buy', amount);
    if (!pressed.ok) throw new Error(pressed.reason);
    move(f, -4_000n);
    const own = await f.prepare('buy', amount);
    if (!own.ok) throw new Error(own.reason);
    const floor = { sqrtPriceLimitX96: pressed.plan.priceLimitX96, minimumOutput: null };
    const bound = await prepareTradeSepolia({ rpc: f.rpc, chainId: 31337, coordinator: COORDINATOR, from: USER, side: 'buy', amountIn: amount, localDeployment: LOCAL, floor });
    if (!bound.ok) throw new Error(bound.reason);
    // A buy moves the price down: the own limit is lower (looser) than the pressed one.
    expect(own.plan.priceLimitX96 as bigint).toBeLessThan(pressed.plan.priceLimitX96 as bigint);
    expect(swapLimitOf(bound.plan.call)).toBe(pressed.plan.priceLimitX96);
    expect(bound.plan.priceLimitX96).toBe(pressed.plan.priceLimitX96);
    expect([bound.plan.expectedInput, bound.plan.expectedOutput]).toEqual([own.plan.expectedInput, own.plan.expectedOutput]);
  });

  it('a pressed limit the price has nearly reached binds: the plan fills in part to it; one already passed refuses', async () => {
    const f = fixture({ p: COIN, allowance: amount });
    const pressed = await f.prepare('buy', amount);
    if (!pressed.ok) throw new Error(pressed.reason);
    const limit = pressed.plan.priceLimitX96 as bigint;
    const spot = (f.storage[f.base] as bigint) & ((1n << 160n) - 1n);
    // The price just above the pressed limit: little room is left before it.
    move(f, ((limit + 1n) * 1_000_000n) / spot - 1_000_000n + 1n);
    const floor = { sqrtPriceLimitX96: limit, minimumOutput: null };
    const prepare = () => prepareTradeSepolia({ rpc: f.rpc, chainId: 31337, coordinator: COORDINATOR, from: USER, side: 'buy', amountIn: amount, localDeployment: LOCAL, floor });
    const bound = await prepare();
    if (!bound.ok) throw new Error(bound.reason);
    expect(swapLimitOf(bound.plan.call)).toBe(limit);
    expect(bound.plan.expectedInput as bigint).toBeLessThan(amount);
    move(f, -20_000n);
    expect(await prepare()).toEqual({ ok: false, reason: 'price_limit_already_exceeded' });
  });

  it('a window buy: the minimum is the pressed one when that is higher; below it the plan refuses before anything is sent', async () => {
    const f = fixture({ p: COIN, phase: 2, allowance: amount, output: 1_000_000n });
    const prepare = (minimumOutput: bigint) => prepareTradeSepolia({ rpc: f.rpc, chainId: 31337, coordinator: COORDINATOR, from: USER, side: 'buy', amountIn: amount,
      localDeployment: LOCAL, floor: { sqrtPriceLimitX96: null, minimumOutput } });
    const own = await f.prepare('buy', amount);
    if (!own.ok) throw new Error(own.reason);
    expect(own.plan.minimumOutput).toBe(980_000n);
    const pressed = await prepare(990_000n);
    if (!pressed.ok) throw new Error(pressed.reason);
    expect(decodeFunctionData({ abi: TRADE_ABI, data: (pressed.plan.call as { data: Hex }).data }).args[1]).toBe(990_000n);
    expect(pressed.plan.minimumOutput).toBe(990_000n);
    // A lower pressed minimum never loosens the plan's own.
    const lower = await prepare(1n);
    if (!lower.ok) throw new Error(lower.reason);
    expect(lower.plan.minimumOutput).toBe(980_000n);
    expect(await prepare(1_000_001n)).toEqual({ ok: false, reason: 'insufficient_output' });
  });

  it('a floor that is not bigints or nulls, or outside the price range, is refused', async () => {
    const f = fixture({ p: COIN, allowance: amount });
    const prepare = (floor: unknown) => prepareTradeSepolia({ rpc: f.rpc, chainId: 31337, coordinator: COORDINATOR, from: USER, side: 'buy', amountIn: amount, localDeployment: LOCAL, floor: floor as never });
    expect(await prepare({ sqrtPriceLimitX96: 5, minimumOutput: null })).toEqual({ ok: false, reason: 'invalid_floor' });
    expect(await prepare({ sqrtPriceLimitX96: 1n, minimumOutput: null })).toEqual({ ok: false, reason: 'invalid_floor' });
  });
});
