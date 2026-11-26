import { boxCurve } from '../../../box-spec/src/layout-v2';
import { decodeFunctionData, encodeErrorResult, encodeFunctionData, encodeFunctionResult, parseAbi, zeroAddress, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import type { Eip1193Request } from '../write/eip1193';
import { TRADE_ABI, TRADE_ERRORS } from './abi';
import { prepareTradeSepolia } from './trade';
import { decodeTradeRevert } from './revert';
import { COIN, COORDINATOR, HOOK, LOCAL, MANAGER, ROUTER, TOKEN, USER, fixture, required } from './test-support';

const prepare = (rpc: Eip1193Request, chainId = 31337) => prepareTradeSepolia({ rpc, chainId, coordinator: COORDINATOR, from: USER, side: 'buy', amountIn: 100n, localDeployment: LOCAL });
function overrideRead(rpc: Eip1193Request, target: string, name: string, result: unknown): Eip1193Request {
  return async r => {
    if (r.method === 'eth_call') {
      const [call] = r.params as [{ to: string; data: Hex }];
      const decoded = decodeFunctionData({ abi: TRADE_ABI, data: call.data });
      if (call.to.toLowerCase() === target.toLowerCase() && decoded.functionName === name) return encodeFunctionResult({ abi: TRADE_ABI, functionName: decoded.functionName, result: result as never });
    }
    return rpc(r);
  };
}
describe('af2 security preparation regressions', () => {
  it.each([
    [COORDINATOR, 'token', zeroAddress], [COORDINATOR, 'hook', ROUTER],
    [COORDINATOR, 'poolManager', COIN], [COORDINATOR, 'q', TOKEN],
    [HOOK, 'coordinator', COIN], [HOOK, 'token', COIN], [HOOK, 'q', COIN], [HOOK, 'poolManager', COIN],
    [ROUTER, 'coordinator', COIN], [ROUTER, 'token', COIN], [ROUTER, 'q', COIN], [ROUTER, 'poolManager', COIN],
    [ROUTER, 'hook', COIN], [HOOK, 'launchRouter', COIN],
  ])('refuses incorrect wiring %s.%s', async (target, name, value) => {
    expect(await prepare(overrideRead(fixture().rpc, target, name, value))).toEqual({ ok: false, reason: 'invalid_box_wiring' });
  });
  it('refuses a consistently wired but unpinned manager', async () => {
    const f = fixture({ phase: 2 }); f.state.manager = COIN;
    expect(await prepare(f.rpc)).toEqual({ ok: false, reason: 'invalid_box_wiring' });
  });
  it('refuses reversed coin order even if all box contracts agree', async () => {
    const f = fixture({ phase: 2, p: '0xff00000000000000000000000000000000000000', allowance: 100n });
    expect(await prepare(f.rpc)).toEqual({ ok: false, reason: 'invalid_box_wiring' });
  });
  it('checks the helper manager as well as its runtime hash', async () => {
    expect(await prepare(overrideRead(fixture().rpc, LOCAL.poolSwapTest, 'manager', COIN))).toEqual({ ok: false, reason: 'helper_manager_mismatch' });
  });
  it('requires registry membership at the plan block, even for a router buy', async () => {
    const f = fixture({ phase: 2 }); f.state.chainId = 11155111; f.state.manager = '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543';
    const calls: unknown[] = [];
    const rpc: Eip1193Request = async r => {
      if (r.method === 'eth_call') {
        const [call, block] = r.params as [{ to: string; data: Hex }, string];
        if (call.to.toLowerCase() === '0x5d2866ef084d801ae734d3a2a6e4f7179898737c') {
          calls.push([call, block]);
          expect(decodeFunctionData({ abi: parseAbi(['function boxIdOf(address) view returns (bool,uint256)']), data: call.data }).args).toEqual([COORDINATOR]);
          expect(block).toBe('0x10');
          return encodeFunctionResult({ abi: parseAbi(['function boxIdOf(address) view returns (bool,uint256)']), functionName: 'boxIdOf', result: [false, 0n] });
        }
      }
      return f.rpc(r);
    };
    expect(await prepare(rpc, 11155111)).toEqual({ ok: false, reason: 'unregistered_box' });
    expect(calls).toHaveLength(1);
  });
  it('ETH-box sells and every approval carry zero native value', async () => {
    const result = await fixture({ allowance: 100n }).prepare('sell', 100n);
    if (!result.ok) throw new Error(result.reason);
    expect(required(result.plan.call).value).toBe(0n);
    expect([...result.plan.approvals, required(result.plan.revoke)].map(c => c.value)).toEqual([0n, 0n]);
  });
  it('a larger allowance must be reset, and cannot produce a trade', async () => {
    const result = await fixture({ p: COIN, allowance: 101n }).prepare('buy', 100n);
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan.call).toBeNull();
    expect(result.plan.approvals.map(c => decodeFunctionData({ abi: TRADE_ABI, data: c.data }).args?.[1])).toEqual([0n, 100n]);
  });
  it('rounds router minimum output upwards and preserves the quote in the plan', async () => {
    const result = await fixture({ phase: 2, output: 101n }).prepare();
    if (!result.ok) throw new Error(result.reason);
    expect(decodeFunctionData({ abi: TRADE_ABI, data: required(result.plan.call).data }).args?.[1]).toBe(99n);
    expect(result.plan).toMatchObject({ expectedOutput: 101n, expectedSqrtPriceX96: null });
  });
  it('runs the final simulation after the successful router quote', async () => {
    const f = fixture({ phase: 2 });
    let buys = 0;
    const rpc: Eip1193Request = async r => {
      if (r.method === 'eth_call' && decodeFunctionData({ abi: TRADE_ABI, data: (r.params as [{ data: Hex }])[0].data }).functionName === 'buy' && ++buys === 2) {
        throw { data: encodeErrorResult({ abi: TRADE_ERRORS, errorName: 'AmountTooSmall' }) };
      }
      return f.rpc(r);
    };
    expect(await prepare(rpc)).toEqual({ ok: false, reason: 'amount_too_small' });
    expect(buys).toBe(2);
  });
  it('pins gas estimation to the plan block', async () => {
    const f = fixture({ phase: 2 }); await f.prepare();
    expect(f.calls.find(c => c.method === 'eth_estimateGas')?.params).toEqual([expect.any(Object), '0x10']);
  });
  it('wrapped unknown errors remain unknown', () => {
    const data = encodeErrorResult({ abi: TRADE_ERRORS, errorName: 'WrappedError', args: [HOOK, '0x12345678', '0xdeadbeef', '0x'] });
    expect(decodeTradeRevert(data)).toBe('unknown_revert');
  });
  it.each([
    ['PriceLimitAlreadyExceeded', [1n, 2n], 'price_limit_already_exceeded'],
    ['PriceLimitOutOfBounds', [1n], 'price_limit_out_of_bounds'],
  ])('decodes %s', (errorName, args, reason) => {
    const abi = parseAbi(['error PriceLimitAlreadyExceeded(uint160,uint160)', 'error PriceLimitOutOfBounds(uint160)']);
    expect(decodeTradeRevert(encodeErrorResult({ abi, errorName, args } as never))).toBe(reason);
  });
  it('the fixture refuses a storage read at anything except Solidity-derived slots', async () => {
    await expect(fixture().rpc({ method: 'eth_call', params: [{ to: MANAGER, data: encodeFunctionData({ abi: TRADE_ABI, functionName: 'extsload', args: [`0x${'00'.repeat(32)}`] }) }, '0x10'] })).rejects.toThrow();
  });
  it('masks packed slot0 to 160 price bits on sells as well as buys', async () => {
    const f = fixture({ allowance: 100n });
    expect(required(f.storage[f.base]) >> 160n).toBeGreaterThan(0n);
    const result = await f.prepare('sell', 100n);
    expect(result.ok).toBe(true);
  });
  it('refuses a final helper simulation that disagrees with the replay', async () => {
    expect(await prepare(overrideRead(fixture().rpc, LOCAL.poolSwapTest, 'swap', 1n))).toEqual({ ok: false, reason: 'pool_simulation_mismatch' });
  });
  it('reaches both curve caps in a prepared pool call', async () => {
    const curve = boxCurve(10n ** 18n, false);
    for (const side of ['buy', 'sell'] as const) {
      const f = fixture({ allowance: 100n, spot: side === 'buy' ? curve.sqrtPriceEndX96 + 1n : curve.sqrtPriceStartX96 - 1n });
      const result = await f.prepare(side, 100n);
      if (!result.ok) throw new Error(result.reason);
      const call = decodeFunctionData({ abi: TRADE_ABI, data: required(result.plan.call).data });
      if (call.functionName !== 'swap') throw new Error('expected swap');
      expect(call.args[1].sqrtPriceLimitX96).toBe(side === 'buy' ? curve.sqrtPriceEndX96 : curve.sqrtPriceStartX96);
    }
  });
});
