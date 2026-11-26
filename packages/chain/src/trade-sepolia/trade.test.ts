import { boxCurve } from '../../../box-spec/src/layout-v2';
import { decodeFunctionData, encodeErrorResult, encodeFunctionResult, parseAbi, zeroAddress, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { tradeGasLimit, priceLimit, SEPOLIA_TRADE_DEPLOYMENT, TRADE_ABI, decodeTradeRevert } from './index';

import { prepareTradeSepolia } from './trade';
import { required, fixture, LOCAL, COORDINATOR, COIN, TOKEN, HOOK, ROUTER, POOL, USER } from './test-support';

describe('SH-ALPHA-TRADE-CALLS builders', () => {
  it('pins the reviewed Sepolia helper, manager and runtime hash', () => {
    expect(SEPOLIA_TRADE_DEPLOYMENT).toEqual({ poolSwapTest: '0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe',
      poolManager: '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543',
      poolSwapTestCodeHash: '0xf8a61d4430eff587aa3c2fea734e3a5e54125a7e516fe1734b2c3c5f0cf1ac39' });
  });
  it.each([1, 4, 6, 0])('phase %i produces only a reason', async phase => {
    for (const side of ['buy', 'sell'] as const) expect(await fixture({ phase }).prepare(side)).toMatchObject({ ok: false, reason: expect.any(String) });
  });
  it.each([6n, 18n])('uses raw bigint amounts for a %s-decimal P', async decimals => {
    const amount = 123n * 10n ** decimals;
    for (const phase of [2, 3, 5]) for (const side of ['buy', 'sell'] as const) {
      const f = fixture({ p: COIN, phase, allowance: amount, raise: 1000n * 10n ** decimals });
      const result = await f.prepare(side, amount);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.reason);
      const { plan } = result;
      expect(plan.call).not.toBeNull();
      const decoded = decodeFunctionData({ abi: TRADE_ABI, data: required(plan.call).data });
      if (phase === 2 && side === 'buy') {
        expect(decoded).toMatchObject({ functionName: 'buy', args: [amount, 980001n, USER, 1120n] });
      } else {
        expect(decoded).toMatchObject({ functionName: 'swap', args: [
          { currency0: COIN, currency1: TOKEN, fee: 10000, tickSpacing: 60, hooks: HOOK },
          { zeroForOne: side === 'buy', amountSpecified: -amount }, { takeClaims: false, settleUsingBurn: false }, '0x',
        ] });
      }
      expect(required(plan.call).value).toBe(0n);
      expect(plan.gasLimit).toBe(4_000_000n);
      expect(decodeFunctionData({ abi: TRADE_ABI, data: required(plan.approvals[0]).data }).args).toEqual([phase === 2 && side === 'buy' ? ROUTER : POOL, amount]);
      expect(decodeFunctionData({ abi: TRADE_ABI, data: required(plan.revoke).data }).args).toEqual([phase === 2 && side === 'buy' ? ROUTER : POOL, 0n]);
      expect(required(plan.approvals[0]).to).toBe(side === 'buy' ? COIN : TOKEN);
    }
  });
  it.each([2, 3, 5])('ETH buys in phase %i carry exactly the input, with no approval', async phase => {
    const result = await fixture({ phase }).prepare();
    if (!result.ok) throw new Error(result.reason);
    expect(required(result.plan.call).value).toBe(10n ** 16n);
    expect(result.plan.approvals).toEqual([]);
    expect(result.plan.revoke).toBeNull();
  });
  it('returns exact/reset approvals without simulating until allowance is exact at a new read', async () => {
    const f = fixture({ p: COIN, phase: 2, allowance: 77n });
    const first = await f.prepare('buy', 100n);
    if (!first.ok) throw new Error(first.reason);
    expect(first.plan.call).toBeNull();
    expect(first.plan.reason).toBe('approval_required');
    expect(first.plan.approvals.map(c => decodeFunctionData({ abi: TRADE_ABI, data: c.data }).args)).toEqual([[ROUTER, 0n], [ROUTER, 100n]]);
    expect(f.calls.filter(c => c.method === 'eth_estimateGas')).toHaveLength(0);
    f.state.allowance = 100n;
    f.state.timestamp += 12n;
    const next = await f.prepare('buy', 100n);
    if (!next.ok) throw new Error(next.reason);
    expect(decodeFunctionData({ abi: TRADE_ABI, data: required(next.plan.call).data }).args).toEqual([100n, 980001n, USER, 1132n]);
    const simulated = f.calls.filter(c => c.method === 'eth_call').map(c => (c.params as [{ data: Hex }, string]));
    expect(simulated.every(([, block]) => block === '0x10')).toBe(true);
    expect(simulated.map(([c]) => decodeFunctionData({ abi: TRADE_ABI, data: c.data })).filter(c => c.functionName === 'buy')[0]?.args).toEqual([100n, 1n, USER, 1132n]);
  });
  it('refuses zero/minimum rounding, non-bigint amounts, unsafe sizes and tolerances', async () => {
    for (const amount of [0n, -1n, 1n << 127n, 1 as unknown as bigint]) expect((await fixture().prepare('buy', amount)).ok).toBe(false);
    for (const bps of [0n, 9n, 2001n, 2 as unknown as bigint]) expect((await fixture().prepare('buy', 1n, bps)).ok).toBe(false);
    expect(await fixture({ phase: 2, output: 0n }).prepare()).toMatchObject({ ok: false, reason: 'minimum_output_zero' });
  });
  it('refuses chain 1, absent local deployments, bad RPC chains and mismatched helper code', async () => {
    const f = fixture();
    const base = { rpc: f.rpc, chainId: 31337, coordinator: COORDINATOR, from: USER, side: 'buy' as const, amountIn: 100n } as const;
    expect(await prepareTradeSepolia({ ...base, chainId: 1 })).toEqual({ ok: false, reason: 'chain_not_allowed' });
    expect(await prepareTradeSepolia(base)).toEqual({ ok: false, reason: 'deployment_required' });
    f.state.chainId = 1;
    expect(await prepareTradeSepolia({ ...base, localDeployment: LOCAL })).toEqual({ ok: false, reason: 'rpc_chain_mismatch' });
    f.state.chainId = 31337;
    f.state.code = '0x6002';
    expect(await f.prepare()).toEqual({ ok: false, reason: 'helper_code_hash_mismatch' });
  });
  it('propagates a router simulation revert without constructing a sendable call', async () => {
    const f = fixture({ phase: 2 });
    const rpc: import('../write/eip1193').Eip1193Request = async request => {
      if (request.method === 'eth_call') {
        const [call] = request.params as [{ data: Hex }];
        if (decodeFunctionData({ abi: TRADE_ABI, data: call.data }).functionName === 'buy') {
          throw { data: encodeErrorResult({ abi: errors, errorName: 'WindowClosed', args: [1384n] }) };
        }
      }
      return f.rpc(request);
    };
    expect(await prepareTradeSepolia({ rpc, chainId: 31337, coordinator: COORDINATOR, from: USER, side: 'buy', amountIn: 100n, localDeployment: LOCAL }))
      .toEqual({ ok: false, reason: 'window_closed' });
  });
  it('derives and validates every pool-key field against the box contracts', async () => {
    const f = fixture();
    for (const changed of [{ currency0: COIN }, { currency1: COIN }, { hooks: COIN }, { fee: 3000 }, { tickSpacing: 10 }] as const) {
      const rpc: import('../write/eip1193').Eip1193Request = async request => {
        if (request.method === 'eth_call') {
          const [call] = request.params as [{ data: Hex }];
          if (decodeFunctionData({ abi: TRADE_ABI, data: call.data }).functionName === 'poolKey') return encodeFunctionResult({
            abi: TRADE_ABI, functionName: 'poolKey', result: { currency0: zeroAddress, currency1: TOKEN, hooks: HOOK, fee: 10000, tickSpacing: 60, ...changed },
          });
        }
        return f.rpc(request);
      };
      expect(await prepareTradeSepolia({ rpc, chainId: 31337, coordinator: COORDINATOR, from: USER, side: 'buy', amountIn: 100n, localDeployment: LOCAL }))
        .toEqual({ ok: false, reason: 'invalid_pool_key' });
    }
  });
  it('computes conservative inverse-price limits, curve caps, and tick bounds without floats', () => {
    const curve = boxCurve(10n ** 18n, false);
    const spot = (curve.sqrtPriceStartX96 + curve.sqrtPriceEndX96) / 2n;
    for (const bps of [10n, 200n, 2000n]) {
      const buy = priceLimit(spot, 'buy', bps);
      const sell = priceLimit(spot, 'sell', bps);
      expect(buy * buy * (10000n + bps)).toBeGreaterThanOrEqual(spot * spot * 10000n);
      expect((buy - 1n) ** 2n * (10000n + bps)).toBeLessThan(spot * spot * 10000n);
      expect(sell * sell * (10000n - bps)).toBeLessThanOrEqual(spot * spot * 10000n);
      expect((sell + 1n) ** 2n * (10000n - bps)).toBeGreaterThan(spot * spot * 10000n);
      expect(priceLimit(curve.sqrtPriceEndX96 + 1n, 'buy', bps, curve)).toBe(curve.sqrtPriceEndX96);
      expect(priceLimit(curve.sqrtPriceStartX96 - 1n, 'sell', bps, curve)).toBe(curve.sqrtPriceStartX96);
    }
    expect(priceLimit(4295128741n, 'buy', 200n)).toBe(4295128740n);
    expect(priceLimit(1461446703485210103287273052203988822378723970340n, 'sell', 200n)).toBe(1461446703485210103287273052203988822378723970341n);
    expect(() => priceLimit(curve.sqrtPriceStartX96, 'sell', 200n, curve)).toThrow('price_limit_unavailable');
  });
  it('buffers estimates by 20%, floors at 4M, and refuses estimates above the transaction cap', () => {
    expect(tradeGasLimit(1n)).toBe(4_000_000n);
    expect(tradeGasLimit(5_000_001n)).toBe(6_000_002n);
    expect(() => tradeGasLimit(16_000_000n)).toThrow('gas_cap');
  });
});

const errors = parseAbi([
  'error BuyThroughLaunchRouter(address,uint256)', 'error CurveIsClosed(uint256)', 'error CurveIsClosed()',
  'error TradingNotOpen(uint256)', 'error FailurePending(uint256)', 'error BelowCurveFloor(uint160)', 'error UnknownPool()',
  'error NotOpen(uint256)', 'error WindowClosed(uint256)', 'error Expired(uint256)', 'error WrongValue(uint256,uint256)',
  'error InsufficientOutput(uint256,uint256)', 'error AmountTooSmall()', 'error RecipientRefused(address)',
  'error WrappedError(address,bytes4,bytes,bytes)',
]);
export const REVERT_CASES = [
  ['BuyThroughLaunchRouter', [ROUTER, 1384n], 'buy_through_launch_router'], ['CurveIsClosed', [16n], 'curve_closed'],
  ['CurveIsClosed', [], 'curve_closed'], ['TradingNotOpen', [1000n], 'trading_not_open'], ['FailurePending', [2000n], 'failure_pending'],
  ['BelowCurveFloor', [123n], 'below_curve_floor'], ['UnknownPool', [], 'unknown_pool'], ['NotOpen', [1000n], 'not_open'],
  ['WindowClosed', [1384n], 'window_closed'], ['Expired', [1120n], 'expired'], ['WrongValue', [0n, 100n], 'wrong_value'],
  ['InsufficientOutput', [1n, 2n], 'insufficient_output'], ['AmountTooSmall', [], 'amount_too_small'], ['RecipientRefused', [USER], 'recipient_refused'],
] as const;
describe('trade revert reasons', () => {
  it.each(REVERT_CASES)('%s decodes directly and through v4 WrappedError', (name, args, reason) => {
    const data = encodeErrorResult({ abi: errors, errorName: name, args: args as never });
    expect(decodeTradeRevert(data)).toBe(reason);
    const wrapped = encodeErrorResult({ abi: errors, errorName: 'WrappedError', args: [HOOK, '0x12345678', data, '0xdeadbeef'] });
    expect(decodeTradeRevert({ cause: { data: wrapped } })).toBe(reason);
  });
  it('unknown and malformed errors stay unknown', () => {
    expect(decodeTradeRevert(encodeErrorResult({ abi: parseAbi(['error Error(string)']), errorName: 'Error', args: ['failure'] }))).toBe('unknown_revert');
    for (const data of ['0x', '0xdeadbeef', '0x123', null, new Error('network')]) expect(decodeTradeRevert(data)).toBe('unknown_revert');
  });
});
