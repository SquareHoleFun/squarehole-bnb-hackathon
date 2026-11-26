import { describe, expect, it } from 'vitest';
import { decodeFunctionData, toHex, type Address } from 'viem';
import { prepareTradeSepolia, submitTradeWriteSepolia, TRADE_ABI, type TradeOptions } from './index';
import { COIN, COORDINATOR, LOCAL, POOL, ROUTER, USER, deferredChainRpc, fixture, required } from './test-support';
import type { Eip1193Request } from '../write/eip1193';

describe('af1 box preparation and submission context', () => {
  it.each([11155111, 1])('refuses a deferred chain reply changed to %i', async chainId => {
    const f = fixture({ phase: 2 }), gate = deferredChainRpc(f.rpc);
    const options = { rpc: gate.rpc, chainId: 31337, coordinator: COORDINATOR, from: USER,
      side: 'buy', amountIn: 100n, localDeployment: { ...LOCAL } } satisfies TradeOptions;
    const pending = prepareTradeSepolia(options);
    await gate.started;
    options.chainId = chainId;
    gate.resolve(toHex(chainId));
    expect(await pending).toEqual({ ok: false, reason: 'rpc_chain_mismatch' });
    expect(f.calls).toEqual([]);
  });
  it.each([2, 3, 5])('copies every option and deployment field before phase %i reads and simulations', async phase => {
    const f = fixture({ phase, p: COIN, allowance: 100n }), gate = deferredChainRpc(f.rpc);
    const deployment = { ...LOCAL, poolSwapTest: POOL as Address };
    const options: { -readonly [K in keyof TradeOptions]: TradeOptions[K] } = {
      rpc: gate.rpc, chainId: 31337, coordinator: COORDINATOR, from: USER, side: 'buy', amountIn: 100n,
      toleranceBps: 200n, localDeployment: deployment,
    };
    const pending = prepareTradeSepolia(options);
    await gate.started;
    options.rpc = async () => { throw new Error('replacement RPC must be unused'); };
    options.chainId = 1; options.from = COIN; options.coordinator = USER;
    options.side = 'sell'; options.amountIn = 1n; options.toleranceBps = 2000n;
    deployment.poolSwapTest = USER; options.localDeployment = undefined;
    gate.resolve('0x7a69');
    const result = await pending;
    if (!result.ok) throw new Error(result.reason);
    const baseline = await fixture({ phase, p: COIN, allowance: 100n }).prepare('buy', 100n);
    if (!baseline.ok) throw new Error(baseline.reason);
    expect(result.plan).toEqual(baseline.plan);
    expect(result.plan).toMatchObject({ chainId: 31337, from: USER, coordinator: COORDINATOR, side: 'buy', amountIn: 100n,
      toleranceBps: 200n, deployment: { chainId: 31337, poolSwapTest: POOL } });
    expect(Object.isFrozen(result.plan.deployment)).toBe(true);
    expect(decodeFunctionData({ abi: TRADE_ABI, data: required(result.plan.approvals[0]).data }).args)
      .toEqual([phase === 2 ? ROUTER : POOL, 100n]);
  });
  it('independently requires an allowed chain, matching deployment chain and pinned Sepolia helper', async () => {
    const f = fixture({ phase: 2 }), result = await f.prepare();
    if (!result.ok) throw new Error(result.reason);
    const plan = result.plan, reads = f.calls.length;
    const wallet: Eip1193Request = async () => { throw new Error('wallet must be unused'); };
    for (const [changed, reason] of [
      [{ ...plan, chainId: 1 }, 'chain_not_allowed'],
      [{ ...plan, chainId: 11155111 }, 'deployment_chain_mismatch'],
      [{ ...plan, chainId: 11155111, deployment: { ...plan.deployment, chainId: 11155111 } }, 'deployment_not_pinned'],
    ] as const) await expect(submitTradeWriteSepolia({ rpc: f.rpc, wallet, chainId: changed.chainId, from: USER,
      plan: changed, call: required(plan.call), gasLimit: plan.gasLimit })).rejects.toThrow(reason);
    expect(f.calls).toHaveLength(reads);
  });
});
