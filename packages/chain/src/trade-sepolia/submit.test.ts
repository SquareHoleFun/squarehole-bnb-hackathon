/** F156: the guarded submission boundary against local RPC and wallet doubles. */
import { decodeFunctionData, encodeFunctionData, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { WalletContextChangedError } from '../write/executor';
import { required, fixture as tradeFixture, USER as TRADE_USER, COIN as TRADE_COIN, ROUTER as TRADE_ROUTER } from './test-support';
import { TRADE_ABI, SEPOLIA_TRADE_DEPLOYMENT, submitTradeWriteSepolia, type TradeCall } from './index';

describe('SH-ALPHA-TRADE-CALLS exact send boundary', () => {
  const hash = `0x${'12'.repeat(32)}`;
  async function ready(phase = 3, p: Hex = TRADE_COIN, side: 'buy' | 'sell' = 'buy', network = 31337) {
    const f = tradeFixture({ phase, p, allowance: 100n });
    f.state.chainId = network;
    if (network === 11155111) f.state.manager = SEPOLIA_TRADE_DEPLOYMENT.poolManager;
    const result = await f.prepare(side, 100n);
    if (!result.ok) throw new Error(result.reason);
    const sent: unknown[] = [];
    let chainId = network;
    let account = TRADE_USER as string;
    const wallet: import('../write/eip1193').Eip1193Request = async request => {
      if (request.method === 'eth_chainId') return `0x${chainId.toString(16)}`;
      if (request.method === 'eth_accounts') return [account];
      if (request.method === 'eth_sendTransaction') { sent.push(request.params); return hash; }
      throw new Error(request.method);
    };
    const send = (call = required(result.plan.call), gasLimit = result.plan.gasLimit) => submitTradeWriteSepolia({
      rpc: f.rpc, wallet, chainId: network, plan: result.plan, call, from: TRADE_USER, gasLimit,
    });
    return { ...f, plan: result.plan, wallet, sent, send, changeWallet: (chain: number, who = TRADE_USER) => { chainId = chain; account = who; } };
  }
  it('allows each route and exact/reset approvals through the existing sender', async () => {
    for (const phase of [2, 3, 5]) for (const p of [TRADE_COIN, '0x0000000000000000000000000000000000000000'] as const) for (const side of ['buy', 'sell'] as const) {
      const f = await ready(phase, p, side);
      for (const call of [required(f.plan.call), ...f.plan.approvals, ...(f.plan.revoke ? [f.plan.revoke] : [])]) expect(await f.send(call)).toBe(hash);
      expect(f.sent.length).toBeGreaterThan(0);
    }
  });
  it('allows Sepolia while ignoring the local deployment override', async () => {
    const f = await ready(2, TRADE_COIN, 'buy', 11155111);
    expect(f.plan.deployment).toEqual({ ...SEPOLIA_TRADE_DEPLOYMENT, chainId: 11155111 });
    expect(await f.send()).toBe(hash);
    expect(f.sent[0]).toEqual([expect.objectContaining({ chainId: '0xaa36a7' })]);
    f.state.phase = 3;
    expect(await f.prepare('buy', 100n)).toEqual({ ok: false, reason: 'helper_code_hash_mismatch' });
  });
  it('refuses address, selector, spender, amount, value and calldata changes without opening the wallet', async () => {
    const f = await ready();
    const approval = required(f.plan.approvals[0]);
    const mutants: TradeCall[] = [
      { ...required(f.plan.call), to: TRADE_ROUTER }, { ...required(f.plan.call), data: '0xdeadbeef' },
      { ...required(f.plan.call), data: `${required(f.plan.call).data}00` }, { ...required(f.plan.call), value: 100n },
      { ...approval, data: encodeFunctionData({ abi: TRADE_ABI, functionName: 'approve', args: [TRADE_ROUTER, 100n] }) },
      { ...approval, data: encodeFunctionData({ abi: TRADE_ABI, functionName: 'approve', args: [f.plan.deployment.poolSwapTest, 101n] }) },
      { ...approval, value: 1n },
    ];
    const decoded = decodeFunctionData({ abi: TRADE_ABI, data: required(f.plan.call).data });
    if (decoded.functionName !== 'swap') throw new Error('expected pool call');
    const [key, params, settings] = decoded.args;
    for (const args of [
      [key, { ...params, amountSpecified: -101n }, settings, '0x'],
      [key, { ...params, zeroForOne: false }, settings, '0x'],
      [key, { ...params, sqrtPriceLimitX96: 4295128740n }, settings, '0x'],
      [{ ...key, hooks: TRADE_COIN }, params, settings, '0x'],
      [key, params, { ...settings, takeClaims: true }, '0x'],
      [key, params, settings, '0x1234'],
    ]) mutants.push({ ...required(f.plan.call), data: encodeFunctionData({ abi: TRADE_ABI, functionName: 'swap', args: args as never }) });
    for (const call of mutants) await expect(f.send(call)).rejects.toThrow('call_not_allowed');
    const eth = await ready(2, '0x0000000000000000000000000000000000000000');
    await expect(eth.send({ ...required(eth.plan.call), value: 0n })).rejects.toThrow('call_not_allowed');
    expect(f.sent).toEqual([]);
    expect(eth.sent).toEqual([]);
    const window = await ready(2);
    const buy = decodeFunctionData({ abi: TRADE_ABI, data: required(window.plan.call).data });
    if (buy.functionName !== 'buy') throw new Error('expected router call');
    for (const args of [[101n, buy.args[1], TRADE_USER, buy.args[3]], [100n, 1n, TRADE_USER, buy.args[3]], [100n, buy.args[1], TRADE_COIN, buy.args[3]], [100n, buy.args[1], TRADE_USER, buy.args[3] + 1n]]) {
      await expect(window.send({ ...required(window.plan.call), data: encodeFunctionData({ abi: TRADE_ABI, functionName: 'buy', args: args as never }) })).rejects.toThrow('call_not_allowed');
    }
  });
  it('rechecks the RPC, helper code, wallet chain and account, gas and read freshness', async () => {
    const f = await ready();
    f.state.code = '0x6002';
    await expect(f.send()).rejects.toThrow('helper_code_hash_mismatch');
    await expect(f.send(required(f.plan.approvals[0]))).rejects.toThrow('helper_code_hash_mismatch');
    f.state.chainId = 1;
    await expect(f.send()).rejects.toThrow('rpc_chain_mismatch');
    let good = await ready();
    good.changeWallet(1);
    await expect(good.send()).rejects.toBeInstanceOf(WalletContextChangedError);
    good = await ready();
    good.changeWallet(31337, TRADE_COIN);
    await expect(good.send()).rejects.toBeInstanceOf(WalletContextChangedError);
    good.changeWallet(31337);
    good.state.phase = 4;
    await expect(good.send()).rejects.toThrow('phase_changed');
    good.state.phase = 3;
    await expect(good.send(required(good.plan.call), 3_999_999n)).rejects.toThrow('invalid_gas_limit');
    await expect(good.send(required(good.plan.call), 17_000_000n)).rejects.toThrow('invalid_gas_limit');
    good.state.timestamp += 121n;
    await expect(good.send()).rejects.toThrow('stale_read');
    expect(await good.send(required(good.plan.revoke))).toBe(hash); // revoking remains possible after a quote expires
    expect(f.sent).toEqual([]);
  });
  it('refuses non-string and merely case-equal call fields, and sends canonical bytes', async () => {
    const f = await ready();
    const call = required(f.plan.call);
    for (const changed of [
      { data: `0x${call.data.slice(2).toUpperCase()}` },
      { to: { toLowerCase: () => call.to.toLowerCase() } },
      { data: { toLowerCase: () => call.data.toLowerCase() } },
      { to: new String(call.to) },
    ]) await expect(f.send({ ...call, ...changed } as TradeCall)).rejects.toThrow('call_not_allowed');
    await f.send();
    expect(f.sent).toEqual([[{ to: call.to, data: call.data, from: f.plan.from, value: '0x0', gas: `0x${f.plan.gasLimit.toString(16)}`, chainId: '0x7a69',
      // SH-SEND-FEES: the RPC's 1-wei tip is below the floor, so the send offers 0.01 gwei over twice the 1-wei base fee.
      maxFeePerGas: '0x989682', maxPriorityFeePerGas: '0x989680' }]]);
  });
  it('consumes a trade once, including concurrent sends, while approvals and revoke remain repeatable', async () => {
    const f = await ready();
    const results = await Promise.allSettled([f.send(), f.send()]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    await expect(f.send()).rejects.toThrow('trade_already_submitted');
    expect(f.sent).toHaveLength(1);
    for (const call of [required(f.plan.approvals[0]), required(f.plan.revoke)]) {
      await f.send(call); await f.send(call);
    }
  });
  it('binds submission to the build target chain, even if the plan and both providers agree on another chain', async () => {
    const f = await ready(2);
    await expect(submitTradeWriteSepolia({ rpc: f.rpc, wallet: f.wallet, chainId: 11155111, plan: f.plan, call: required(f.plan.call), from: TRADE_USER, gasLimit: f.plan.gasLimit })).rejects.toThrow('plan_chain_mismatch');
    expect(f.sent).toEqual([]);
  });
  it('binds the submitting account to the router recipient', async () => {
    const f = await ready(2);
    await expect(submitTradeWriteSepolia({ rpc: f.rpc, wallet: f.wallet, chainId: f.plan.chainId, plan: f.plan, call: required(f.plan.call), from: TRADE_COIN, gasLimit: f.plan.gasLimit })).rejects.toThrow('account_mismatch');
    expect(f.sent).toEqual([]);
  });
  it.each(['phase', 'expiry'])('refuses exact approval after %s changes', async kind => {
    const f = await ready();
    if (kind === 'phase') f.state.phase = 5; else f.state.timestamp += 120n;
    await expect(f.send(required(f.plan.approvals[0]))).rejects.toThrow(kind === 'phase' ? 'phase_changed' : 'stale_read');
    expect(f.sent).toEqual([]);
  });
  it('refuses a replaced plan block hash', async () => {
    const f = await ready(2);
    const rpc: import('../write/eip1193').Eip1193Request = async r => {
      const value = await f.rpc(r);
      return r.method === 'eth_getBlockByNumber' ? { ...(value as object), hash: `0x${'cd'.repeat(32)}` } : value;
    };
    await expect(submitTradeWriteSepolia({ rpc, wallet: f.wallet, chainId: f.plan.chainId, plan: f.plan, call: required(f.plan.call), from: TRADE_USER, gasLimit: f.plan.gasLimit })).rejects.toThrow('stale_read');
    expect(f.sent).toEqual([]);
  });
  it('rejects hand-typed plans and a main-chain plan, and snapshots the call before awaits', async () => {
    const f = await ready();
    await expect(submitTradeWriteSepolia({ rpc: f.rpc, wallet: f.wallet, chainId: f.plan.chainId, plan: { ...f.plan, chainId: 1 }, call: required(f.plan.call), from: TRADE_USER, gasLimit: f.plan.gasLimit })).rejects.toThrow('chain_not_allowed');
    await expect(submitTradeWriteSepolia({ rpc: f.rpc, wallet: f.wallet, chainId: f.plan.chainId, plan: { ...f.plan }, call: required(f.plan.call), from: TRADE_USER, gasLimit: f.plan.gasLimit })).rejects.toThrow('unverified_plan');
    const call = { ...required(f.plan.call) };
    const pending = f.send(call);
    call.value = 999n;
    expect(await pending).toBe(hash);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toEqual([expect.objectContaining({ value: '0x0', chainId: '0x7a69' })]);
  });
});
