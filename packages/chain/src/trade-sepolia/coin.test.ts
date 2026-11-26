import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeErrorResult, encodeFunctionData, encodeFunctionResult, encodeAbiParameters, keccak256, parseAbi, toHex, zeroAddress, type Address, type Hex } from 'viem';
import type { Eip1193Request } from '../write/eip1193';
import { Q96, MIN_SQRT_PRICE, MAX_SQRT_PRICE } from '../../../box-spec/src/v4-math';
import { simulatePoolSwap } from './pool';
import { deferredChainRpc, required, USER, COIN, POOL, MANAGER, CODE } from './test-support';
import { prepareFaucetSepolia, preparePairSwapSepolia, readCoinStateSepolia, submitCoinWriteSepolia,
  SEPOLIA_COIN_DEPLOYMENT, decodeTradeRevert, TRADE_ABI, type CoinPlan, type TradeCall } from './index';
import { ethParityManifest } from '../../../keeper/src/income-parity-manifest';

const TETH = '0x0000000000000000000000000000000000000011';
const PAIRS = '0x0000000000000000000000000000000000000012';
const ABI = parseAbi(['function open() view returns (bool)', 'function admitted(address) view returns (bool)',
  'function nextDripAt(address) view returns (uint256)', 'function dailyRemaining() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)', 'function drip()', 'function manager() view returns (address)']);
const HASH = `0x${'ab'.repeat(32)}`;
function coinFixture(reverse = false) {
  const teth: Address = reverse ? COIN : TETH;
  const coin: Address = reverse ? TETH : COIN;
  const deployment = { chainId: 31337, status: 'deployed' as const, teth: { address: teth, codeHash: keccak256(CODE) },
    pairHelper: { address: PAIRS, codeHash: keccak256(CODE) }, poolSwapTest: POOL, poolManager: MANAGER, poolSwapTestCodeHash: keccak256(CODE),
    pairs: [{ coin, symbol: 'tUSDC', decimals: 6, fee: '3000', tickSpacing: 60, hooks: zeroAddress, tickLower: -887220, tickUpper: 887220 }] };
  const key = { currency0: TETH, currency1: COIN, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
  const id = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [TETH, COIN, 3000, 60, zeroAddress]));
  const base = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [id, 6n]));
  const state = { open: false, admitted: true, nextDripAt: 0n, dailyRemaining: 500n * 10n ** 18n, balanceOf: 10n ** 30n,
    allowance: 10n ** 18n, timestamp: 1000n, hash: HASH, chainId: 31337, code: CODE as Hex, manager: MANAGER as Hex, estimate: 476738n, mismatch: false };
  const storage: Record<string, bigint> = { [base]: Q96 | (3000n << 208n), [toHex(BigInt(base) + 3n, { size: 32 })]: 1000n * 10n ** 18n };
  for (let word = -58; word <= 57; word++) storage[keccak256(encodeAbiParameters([{ type: 'int256' }, { type: 'uint256' }], [BigInt(word), BigInt(base) + 5n]))] = 0n;
  const load = async (slot: Hex) => required(storage[slot]);
  const calls: { method: string; params?: unknown }[] = [];
  const rpc: Eip1193Request = async r => {
    calls.push(r);
    if (r.method === 'eth_chainId') return toHex(state.chainId);
    if (r.method === 'eth_getBlockByNumber') return { number: '0x10', hash: state.hash, timestamp: toHex(state.timestamp), baseFeePerGas: '0x1', transactions: [] };
    if (r.method === 'eth_getCode') return state.code;
    if (r.method === 'eth_estimateGas') return toHex(state.estimate);
    if (r.method === 'eth_maxPriorityFeePerGas') return '0x1';
    if (r.method === 'eth_getBalance') return toHex(10n ** 21n);
    if (r.method !== 'eth_call') throw new Error(r.method);
    const [call] = r.params as [{ data: Hex }];
    const decoded = decodeFunctionData({ abi: [...ABI, ...TRADE_ABI], data: call.data });
    let result: unknown;
    if (decoded.functionName === 'extsload') result = toHex(await load(decoded.args[0]), { size: 32 });
    else if (decoded.functionName === 'swap') {
      const [, p] = decoded.args;
      const q = await simulatePoolSwap(load, base, p.zeroForOne, -p.amountSpecified, p.sqrtPriceLimitX96, 3000n);
      const d0 = p.zeroForOne ? -q.input : q.output;
      const d1 = p.zeroForOne ? q.output : -q.input;
      result = BigInt.asIntN(256, BigInt.asUintN(128, d0) << 128n | BigInt.asUintN(128, d1)) + (state.mismatch ? 1n : 0n);
    } else if (decoded.functionName === 'drip') return '0x';
    else result = state[decoded.functionName as keyof typeof state];
    return encodeFunctionResult({ abi: [...ABI, ...TRADE_ABI], functionName: decoded.functionName, result: result as never });
  };
  const options = { rpc, chainId: 31337, from: USER, localDeployment: deployment } as const;
  const faucet = () => prepareFaucetSepolia(options);
  const swap = (input: Address = teth, output: Address = coin, amountIn = state.allowance, toleranceBps = 200n) => preparePairSwapSepolia({ ...options, input, output, amountIn, toleranceBps });
  const sent: unknown[] = [];
  const wallet: Eip1193Request = async r => {
    if (r.method === 'eth_chainId') return '0x7a69';
    if (r.method === 'eth_accounts') return [USER];
    if (r.method === 'eth_sendTransaction') { sent.push(r.params); return HASH; }
    throw new Error(r.method);
  };
  const send = (plan: CoinPlan, call = required(plan.call), gasLimit = plan.gasLimit) => submitCoinWriteSepolia({ ...options, wallet, plan, call, gasLimit });
  return { state, options, deployment, rpc, calls, faucet, swap, send, sent, key, base, storage, teth, coin, wallet };
}
async function planOf(result: Awaited<ReturnType<typeof prepareFaucetSepolia>>): Promise<CoinPlan> {
  if (!result.ok) throw new Error(result.reason);
  return result.plan;
}

describe('af1 preparation context snapshot', () => {
  it.each([[true, 11155111], [true, 1], [false, 11155111], [false, 1]] as const)(
    'refuses a deferred chain reply for faucet=%s changed to %i', async (faucet, chainId) => {
      const f = coinFixture(); f.state.allowance = 0n;
      const gate = deferredChainRpc(f.rpc);
      const options = { ...f.options, rpc: gate.rpc, chainId: 31337, input: f.teth, output: f.coin, amountIn: 100n };
      const pending = faucet ? prepareFaucetSepolia(options) : preparePairSwapSepolia(options);
      await gate.started;
      options.chainId = chainId;
      f.state.chainId = chainId;
      gate.resolve(toHex(chainId));
      const result = await pending;
      // Exercise the reviewer's send path if a bad plan is registered, including exact pair approval.
      if (result.ok) {
        const wallet: Eip1193Request = r => r.method === 'eth_chainId' ? Promise.resolve(toHex(chainId)) : f.wallet(r);
        await expect(submitCoinWriteSepolia({ ...options, wallet, plan: result.plan,
          call: required(faucet ? result.plan.call : result.plan.approvals[0]), gasLimit: result.plan.gasLimit })).rejects.toThrow();
      }
      expect(f.sent).toEqual([]);
      expect(result).toEqual({ ok: false, reason: 'rpc_chain_mismatch' });
    });
  it.each(['faucet', 'pair', 'approval'] as const)('keeps all copied options through deferred %s preparation', async kind => {
    const f = coinFixture();
    if (kind === 'approval') f.state.allowance = 0n;
    const gate = deferredChainRpc(f.rpc);
    const options = { ...f.options, rpc: gate.rpc, chainId: 31337, from: USER as Address,
      input: f.teth, output: f.coin, amountIn: 10n ** 18n, toleranceBps: 200n };
    const pending = kind === 'faucet' ? prepareFaucetSepolia(options) : preparePairSwapSepolia(options);
    await gate.started;
    let replacementReads = 0;
    options.chainId = 1; options.from = COIN;
    options.rpc = async () => { replacementReads++; throw new Error('replacement RPC must be unused'); };
    options.input = USER; options.output = USER; options.amountIn = 1n; options.toleranceBps = 2000n;
    f.deployment.teth.address = USER; f.deployment.pairs = []; f.deployment.poolSwapTest = USER;
    options.localDeployment = { ...f.deployment, chainId: 1 };
    gate.resolve('0x7a69');
    const plan = await planOf(await pending);
    expect(plan).toMatchObject({ chainId: 31337, from: USER, deployment: { chainId: 31337, teth: { address: TETH }, poolSwapTest: POOL } });
    expect(plan.deployment.pairs).toHaveLength(1);
    expect(replacementReads).toBe(0);
    if (kind !== 'faucet') {
      expect(decodeFunctionData({ abi: TRADE_ABI, data: required(plan.approvals[0]).data }).args).toEqual([POOL, 10n ** 18n]);
      expect(plan.reason).toBe(kind === 'approval' ? 'approval_required' : null);
    }
    if (kind === 'pair') {
      const baseline = await planOf(await coinFixture().swap());
      expect(plan.call).toEqual(baseline.call); // Includes currencies, input, tolerance-derived limit and settings.
      expect(plan.expectedInput).toBe(10n ** 18n);
    }
    for (const r of f.calls) {
      if (r.method === 'eth_call' || r.method === 'eth_estimateGas') {
        const [call, block] = r.params as [{ data: Hex; from?: Address }, string];
        expect(block).toBe('0x10');
        if (call.from) expect(call.from).toBe(USER);
        if (r.method === 'eth_call') {
          const decoded = decodeFunctionData({ abi: [...ABI, ...TRADE_ABI], data: call.data });
          if (['admitted', 'nextDripAt', 'balanceOf', 'allowance'].includes(decoded.functionName)) expect(decoded.args?.[0]).toBe(USER);
        }
      }
    }
  });
  it('keeps explicit-block state reads on the copied RPC, account, deployment and block', async () => {
    const f = coinFixture(), gate = deferredChainRpc(f.rpc);
    const options = { ...f.options, rpc: gate.rpc, chainId: 31337, from: USER as Address, blockNumber: 16n };
    const pending = readCoinStateSepolia(options);
    await gate.started;
    options.chainId = 1; options.from = COIN; options.blockNumber = 17n;
    options.rpc = async () => { throw new Error('replacement RPC must be unused'); };
    f.deployment.teth.address = USER; f.deployment.pairs = [];
    gate.resolve('0x7a69');
    const state = await pending;
    expect(state.blockNumber).toBe(16n);
    expect(state.balances.map(b => b.coin)).toEqual([TETH, COIN]);
    expect(f.calls.find(r => r.method === 'eth_getBlockByNumber')?.params).toEqual(['0x10', false]);
    for (const r of f.calls.filter(r => r.method === 'eth_call')) {
      const [call, block] = r.params as [{ data: Hex }, string];
      expect(block).toBe('0x10');
      const decoded = decodeFunctionData({ abi: ABI, data: call.data });
      if (decoded.args?.length) expect(decoded.args[0]).toBe(USER);
    }
  });
  it.each([11155111, 1])('refuses an explicit-block state read whose deferred chain changes to %i', async chainId => {
    const f = coinFixture(), gate = deferredChainRpc(f.rpc);
    const options = { ...f.options, rpc: gate.rpc, chainId: 31337, blockNumber: 16n };
    const pending = readCoinStateSepolia(options);
    await gate.started;
    options.chainId = chainId;
    const refused = expect(pending).rejects.toThrow('rpc_chain_mismatch');
    gate.resolve(toHex(chainId));
    await refused;
  });
  it('independently rejects forbidden chains, mismatched deployments and unpinned Sepolia records before RPC or wallet access', async () => {
    const f = coinFixture(), plan = await planOf(await f.faucet());
    const reads = f.calls.length;
    for (const [changed, reason] of [
      [{ ...plan, chainId: 1 }, 'chain_not_allowed'],
      [{ ...plan, chainId: 11155111 }, 'deployment_chain_mismatch'],
      [{ ...plan, chainId: 11155111, deployment: { ...plan.deployment, chainId: 11155111 as const } }, 'deployment_not_pinned'],
    ] as const) await expect(submitCoinWriteSepolia({ ...f.options, chainId: changed.chainId, wallet: f.wallet,
      plan: changed, call: required(plan.call), gasLimit: plan.gasLimit })).rejects.toThrow(reason);
    expect(f.calls).toHaveLength(reads);
    expect(f.sent).toEqual([]);
  });
});

describe('CC-1 faucet and balances', () => {
  it('reads an explicit block and preserves raw balances above safe integer precision', async () => {
    const f = coinFixture();
    const state = await readCoinStateSepolia({ ...f.options, blockNumber: 16n });
    expect(state.balances.map(b => b.balance)).toEqual([10n ** 30n, 10n ** 30n]);
    expect(state.faucet).toMatchObject({ open: false, admitted: true, nextDripAt: 0n, dailyRemaining: 500n * 10n ** 18n });
    expect(f.calls.filter(c => c.method === 'eth_call' || c.method === 'eth_getCode').every(c => (c.params as unknown[])[1] === '0x10')).toBe(true);
    await expect(readCoinStateSepolia({ ...f.options, blockNumber: 'latest' as never })).rejects.toThrow('invalid_block');
  });
  it('refuses admission first, cooldown with its time, and the daily cap; accepts exact cooldown and open phase', async () => {
    const f = coinFixture();
    f.state.admitted = false; f.state.nextDripAt = 1001n; f.state.dailyRemaining = 0n;
    expect(await f.faucet()).toMatchObject({ ok: false, reason: 'not_admitted' });
    f.state.open = true;
    expect(await f.faucet()).toMatchObject({ ok: false, reason: 'cooldown_active', nextDripAt: 1001n });
    f.state.timestamp = 1001n;
    expect(await f.faucet()).toMatchObject({ ok: false, reason: 'daily_cap_reached' });
    f.state.dailyRemaining = 10n ** 18n;
    const plan = await planOf(await f.faucet());
    expect(plan.gasLimit).toBe(572086n);
    expect(plan.call).toEqual({ to: TETH, data: encodeFunctionData({ abi: ABI, functionName: 'drip' }), value: 0n });
    expect(plan.approvals).toEqual([]);
    expect(f.calls.filter(c => c.method === 'eth_estimateGas').every(c => (c.params as unknown[])[1] === '0x10')).toBe(true);
    f.state.estimate = 1n;
    expect((await planOf(await f.faucet())).gasLimit).toBe(480000n);
  });
  // sh-177: the record as the founder's sheets 1 and 2 leave Sepolia (their 2026-11-01 fork rehearsal): tETH and the
  // pair helper with their runtime code hashes, and the four pools of sheet 2 (F159), in its order.
  it('activates the deployed Sepolia record, ignores local overrides there, and still refuses a predicted record', async () => {
    const f = coinFixture();
    expect(SEPOLIA_COIN_DEPLOYMENT).toMatchObject({ chainId: 11155111, status: 'deployed',
      teth: { address: '0x7156c3e4DD23F5776c26b3F6140BC03fFb7c4D5E', codeHash: '0xd505c35f935774b06c15d563b72fc31ddab453a4c83c3e4297e2e1ba76a3ee6c' },
      pairHelper: { address: '0xCe712989F87044b24eBc6bc1Ed21EE4de0E2CBd9', codeHash: '0xace5fd2176fee84910d74ba5872b0ac88240c3ca371894cbd32fac11cb66e5eb' } });
    expect(SEPOLIA_COIN_DEPLOYMENT.pairs.map(p => [p.symbol, p.coin, p.decimals])).toEqual([
      ['tUSDC', '0x5B397F65571deF193Ba5DBE8b2a353C3963c65F6', 6], ['tNVDA', '0x2cbBAD2607fCCFEe778d959d386997862099f33B', 18],
      ['tGOLD', '0x25f276Ce776f5C9b0686250e78EA34bF7aB4C17A', 18], ['tPEPE', '0x1C5231c8BDde9ED7AA80Fe13EDb634db9Bd3E1c7', 18]]);
    expect(Object.isFrozen(SEPOLIA_COIN_DEPLOYMENT.pairs[3])).toBe(true);
    // Sepolia takes the pinned record and reads its RPC (here a 31337 one, so the read refuses), never the local override.
    expect(await prepareFaucetSepolia({ ...f.options, chainId: 11155111 })).toMatchObject({ ok: false, reason: 'rpc_chain_mismatch' });
    expect(f.calls.map(c => c.method)).toEqual(['eth_chainId']);
    f.calls.length = 0;
    // A record that says predicted (both code hashes null) stays unavailable, before any read.
    const predicted = { ...f.deployment, status: 'predicted', teth: { ...f.deployment.teth, codeHash: null }, pairHelper: { ...f.deployment.pairHelper, codeHash: null } };
    expect(await prepareFaucetSepolia({ ...f.options, localDeployment: predicted })).toMatchObject({ ok: false, reason: 'deployment_predicted' });
    expect(await prepareFaucetSepolia({ ...f.options, chainId: 1 })).toMatchObject({ ok: false, reason: 'chain_not_allowed' });
    expect(await prepareFaucetSepolia({ ...f.options, localDeployment: undefined })).toMatchObject({ ok: false, reason: 'deployment_required' });
    expect(f.calls).toEqual([]);
  });
  // F164 D3: the keeper counts tETH 1:1 like ETH through its own code pin. F156 keeps this folder out of keeper imports,
  // so the pin repeats this record; here, inside the folder, a change to one without the other fails. Both carry tETH's
  // runtime code hash since the deployed record (sh-177); a null hash in either counts nothing.
  it('keeps the keeper\'s tETH parity pin equal to this record: chain, address, 18 decimals and code hash', () => {
    expect(Object.values(ethParityManifest)).toContainEqual({ chainId: String(SEPOLIA_COIN_DEPLOYMENT.chainId),
      token: SEPOLIA_COIN_DEPLOYMENT.teth.address, decimals: '18', codeHash: SEPOLIA_COIN_DEPLOYMENT.teth.codeHash, weiPerCoin: '1000000000000000000' });
    for (const pair of SEPOLIA_COIN_DEPLOYMENT.pairs) {
      expect(ethParityManifest[`11155111:${pair.coin.toLowerCase()}`]).toMatchObject({ token: pair.coin, decimals: String(pair.decimals) });
    }
    // The two additional reviewed listings are not members of the four-pair record.
    for (const token of ['0xb1b5CDdB6Be298e9188984e53513B0db38eEa6D7', '0x86d5c2533A78077c125630d4D1D1B2321A07Eb35']) {
      expect(ethParityManifest[`11155111:${token.toLowerCase()}`]).toMatchObject({ token, decimals: '18' });
    }
  });
});

describe('CC-2 pair plans', () => {
  it('uses simulated ending price in either address order/direction; fee 3000 and exact input', async () => {
    for (const reverse of [false, true]) for (const backwards of [false, true]) {
      const f = coinFixture(reverse);
      const input = backwards ? f.coin : f.teth, output = backwards ? f.teth : f.coin;
      const p = await planOf(await f.swap(input, output, 100n * 10n ** 18n)); // approval required
      expect(p.reason).toBe('approval_required'); expect(p.call).toBeNull();
      f.state.allowance = 100n * 10n ** 18n;
      const plan = await planOf(await f.swap(input, output));
      // SH-ONE-PRESS-TRADE: the figures shown before the approval are those of the plan made once it is in place.
      expect([p.expectedInput, p.expectedOutput, p.expectedSqrtPriceX96]).toEqual([plan.expectedInput, plan.expectedOutput, plan.expectedSqrtPriceX96]);
      const decoded = decodeFunctionData({ abi: TRADE_ABI, data: required(plan.call).data });
      if (decoded.functionName !== 'swap') throw new Error('swap expected');
      const [key, params, settings, hookData] = decoded.args;
      expect(key).toEqual(f.key); expect(params.zeroForOne).toBe(BigInt(input) < BigInt(output));
      expect(params.amountSpecified).toBe(-f.state.allowance); expect(settings).toEqual({ takeClaims: false, settleUsingBurn: false }); expect(hookData).toBe('0x');
      const price = required(plan.expectedSqrtPriceX96), limit = params.sqrtPriceLimitX96;
      expect(params.zeroForOne ? limit < price && price < Q96 : limit > price && price > Q96).toBe(true);
      const numerator = price * price * 10000n, denominator = params.zeroForOne ? 10200n : 9800n;
      expect(params.zeroForOne ? limit * limit * denominator >= numerator && (limit - 1n) ** 2n * denominator < numerator : limit * limit * denominator <= numerator && (limit + 1n) ** 2n * denominator > numerator).toBe(true);
      expect(plan.expectedInput).toBe(f.state.allowance); expect(plan.expectedOutput).toBeGreaterThan(0n);
      expect(plan.warning).toContain('partially'); expect(Object.isFrozen(plan.deployment.pairs[0])).toBe(true);
      expect(f.calls.filter(c => ['eth_call', 'eth_getCode', 'eth_estimateGas'].includes(c.method)).every(c => (c.params as unknown[])[1] === '0x10')).toBe(true);
    }
  });
  // SH-ONE-PRESS-TRADE af1: the plan made after the approval carries the pressed quote's price limit when it is tighter.
  it('carries a pressed price limit that is tighter than its own, and names its limit and amount', async () => {
    const f = coinFixture();
    const pressed = await planOf(await f.swap());
    expect([pressed.amountIn, pressed.minimumOutput]).toEqual([f.state.allowance, null]);
    const limitOf = (plan: CoinPlan) => { const d = decodeFunctionData({ abi: TRADE_ABI, data: required(plan.call).data }); if (d.functionName !== 'swap') throw new Error('swap'); return d.args[1].sqrtPriceLimitX96; };
    expect(limitOf(pressed)).toBe(pressed.priceLimitX96);
    // Another swap moved the price (tETH in: down) by 0.3% of its square root, so the plan's own limit is looser.
    const moved = Q96 * 997n / 1000n;
    f.storage[f.base] = moved | (BigInt.asUintN(24, -61n) << 160n) | (3000n << 208n);
    const own = await planOf(await f.swap());
    const bound = await planOf(await preparePairSwapSepolia({ ...f.options, input: f.teth, output: f.coin, amountIn: f.state.allowance, toleranceBps: 200n,
      floor: { sqrtPriceLimitX96: pressed.priceLimitX96, minimumOutput: null } }));
    expect(required(own.priceLimitX96)).toBeLessThan(required(pressed.priceLimitX96));
    expect(limitOf(bound)).toBe(pressed.priceLimitX96);
  });
  it('requires exact allowance, supplies reset/revoke, and selects only record pairs', async () => {
    const f = coinFixture(); f.state.allowance = 101n;
    const p = await planOf(await f.swap(TETH, COIN, 100n));
    expect(p.reason).toBe('approval_required');
    expect(p.approvals.map(c => decodeFunctionData({ abi: TRADE_ABI, data: c.data }).args)).toEqual([[POOL, 0n], [POOL, 100n]]);
    expect(p.revoke).toEqual(p.approvals[0]);
    expect(await f.swap(TETH, USER)).toMatchObject({ ok: false, reason: 'pair_not_allowed' });
    expect(await f.swap(TETH, zeroAddress)).toMatchObject({ ok: false, reason: 'pair_not_allowed' });
    f.deployment.pairs = [];
    expect(await f.swap()).toMatchObject({ ok: false, reason: 'pair_not_allowed' });
  });
  it('validates amounts, tolerance, key configuration, code, gas, balance and final simulation', async () => {
    const f = coinFixture();
    for (const n of [0n, -1n, 1n << 127n, 1 as never]) expect(await f.swap(TETH, COIN, n)).toMatchObject({ ok: false, reason: 'invalid_amount' });
    for (const bps of [9n, 2001n, 2 as never]) expect(await f.swap(TETH, COIN, 100n, bps)).toMatchObject({ ok: false, reason: 'invalid_tolerance' });
    for (const bps of [10n, 2000n]) expect((await f.swap(TETH, COIN, f.state.allowance, bps)).ok).toBe(true);
    f.state.mismatch = true;
    expect(await f.swap()).toMatchObject({ ok: false, reason: 'pool_simulation_mismatch' });
    f.state.mismatch = false; f.state.balanceOf = 0n;
    expect(await f.swap()).toMatchObject({ ok: false, reason: 'insufficient_balance' });
    f.state.balanceOf = 10n ** 30n; f.state.code = '0x6000';
    expect((await f.swap()).ok).toBe(false);
    f.state.code = CODE; f.state.estimate = 16777216n;
    expect(await f.faucet()).toMatchObject({ ok: false, reason: 'gas_cap' });
    required(f.deployment.pairs[0]).fee = '10000';
    expect(await f.swap()).toMatchObject({ ok: false, reason: 'invalid_deployment' });
  });
});

describe('CC-3 exact authority and single use', () => {
  it('rejects any changed target, selector, value, spender, amount, key, direction, settings or suffix before wallet access', async () => {
    for (const faucet of [true, false]) {
      const f = coinFixture(), plan = await planOf(await (faucet ? f.faucet() : f.swap()));
      for (const call of [required(plan.call), ...plan.approvals, ...(plan.revoke ? [plan.revoke] : [])]) {
        for (const change of [{ to: USER }, { data: '0xdeadbeef' }, { data: `${call.data}00` }, { value: 1n }, { value: 0 as never }, { to: new String(call.to) as never }])
          await expect(f.send(plan, { ...call, ...change } as TradeCall)).rejects.toThrow('call_not_allowed');
      }
      if (!faucet) {
        const approval = required(plan.approvals[0]);
        for (const args of [[PAIRS, f.state.allowance], [POOL, f.state.allowance + 1n], [POOL, (1n << 256n) - 1n]] as const)
          await expect(f.send(plan, { ...approval, data: encodeFunctionData({ abi: TRADE_ABI, functionName: 'approve', args }) })).rejects.toThrow('call_not_allowed');
        const call = required(plan.call), d = decodeFunctionData({ abi: TRADE_ABI, data: call.data });
        if (d.functionName !== 'swap') throw new Error('swap');
        const [key, p, s] = d.args;
        const args = [
          [{ ...key, currency0: USER }, p, s, '0x'], [{ ...key, currency1: USER }, p, s, '0x'],
          [{ ...key, fee: 10000 }, p, s, '0x'], [{ ...key, tickSpacing: 10 }, p, s, '0x'], [{ ...key, hooks: USER }, p, s, '0x'],
          [key, { ...p, zeroForOne: !p.zeroForOne }, s, '0x'], [key, { ...p, amountSpecified: -1n }, s, '0x'],
          [key, { ...p, sqrtPriceLimitX96: MIN_SQRT_PRICE + 1n }, s, '0x'], [key, { ...p, sqrtPriceLimitX96: MAX_SQRT_PRICE - 1n }, s, '0x'],
          [key, p, { ...s, takeClaims: true }, '0x'], [key, p, { ...s, settleUsingBurn: true }, '0x'], [key, p, s, '0x01'],
        ];
        for (const a of args) await expect(f.send(plan, { ...call, data: encodeFunctionData({ abi: TRADE_ABI, functionName: 'swap', args: a as never }) })).rejects.toThrow('call_not_allowed');
      }
      await expect(f.send({ ...plan })).rejects.toThrow('unverified_plan');
      expect(f.sent).toEqual([]);
      const results = await Promise.allSettled([f.send(plan), f.send(plan)]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      await expect(f.send(plan)).rejects.toThrow('coin_already_submitted');
      expect(f.sent).toEqual([[{ to: required(plan.call).to, data: required(plan.call).data, value: '0x0', gas: toHex(plan.gasLimit), from: USER, chainId: '0x7a69',
        // SH-SEND-FEES: the RPC's 1-wei tip is below the floor, so the send offers 0.01 gwei over twice the 1-wei base fee.
        maxFeePerGas: '0x989682', maxPriorityFeePerGas: '0x989680' }]]);
    }
  });
  it('rejects stale, reorganized, wrong account/chain and small gas; revokes remain available after expiry', async () => {
    const f = coinFixture(), plan = await planOf(await f.swap());
    await expect(f.send(plan, required(plan.call), plan.gasLimit - 1n)).rejects.toThrow('invalid_gas_limit');
    for (const override of [{ chainId: 11155111 }, { from: COIN }] as const) await expect(submitCoinWriteSepolia({ ...f.options, wallet: f.wallet, plan, call: required(plan.call), gasLimit: plan.gasLimit, ...override })).rejects.toThrow();
    f.state.hash = `0x${'ff'.repeat(32)}`;
    await expect(f.send(plan)).rejects.toThrow('stale_read'); f.state.hash = HASH;
    f.state.timestamp = plan.deadline;
    await expect(f.send(plan)).rejects.toThrow('stale_read');
    await expect(f.send(plan, required(plan.approvals[0]))).rejects.toThrow('stale_read');
    await f.send(plan, required(plan.revoke)); await f.send(plan, required(plan.revoke));
    expect(f.sent).toHaveLength(2);
  });
  it('rechecks eligibility and helper wiring at submission and consumes wallet rejections', async () => {
    const f = coinFixture(), p = await planOf(await f.faucet());
    f.state.admitted = false;
    await expect(f.send(p)).rejects.toThrow('not_admitted'); f.state.admitted = true;
    const badWallet: Eip1193Request = async () => { throw new Error('wallet rejected'); };
    await expect(submitCoinWriteSepolia({ ...f.options, wallet: badWallet, plan: p, call: required(p.call), gasLimit: p.gasLimit })).rejects.toThrow('wallet rejected');
    await expect(f.send(p)).rejects.toThrow('coin_already_submitted');
    const pair = await planOf(await f.swap()); f.state.manager = USER;
    await expect(f.send(pair)).rejects.toThrow('helper_manager_mismatch');
    f.state.manager = MANAGER; f.state.chainId = 1;
    await expect(f.send(pair)).rejects.toThrow('rpc_chain_mismatch');
  });
});

it.each([
  ['NotAdmitted', [], 'not_admitted'], ['CooldownActive', [123n], 'cooldown_active'], ['DailyCapReached', [], 'daily_cap_reached'],
  ['NotAdmitter', [], 'not_admitter'], ['InvalidAdmitterLimit', [], 'invalid_admitter_limit'],
  ['AdmitterDailyCapReached', [], 'admitter_daily_cap_reached'],
  ['ERC20InsufficientAllowance', [USER, 1n, 2n], 'insufficient_allowance'], ['ERC20InsufficientBalance', [USER, 3n, 4n], 'insufficient_balance'],
  ['InsufficientAllowance', [1n, 2n], 'insufficient_allowance'], ['InsufficientBalance', [3n, 4n], 'insufficient_balance'],
] as const)('CC-4 decodes %s directly and inside WrappedError', (name, args, reason) => {
  const errors = parseAbi(['error ERC20InsufficientAllowance(address,uint256,uint256)', 'error ERC20InsufficientBalance(address,uint256,uint256)', 'error NotAdmitted()', 'error CooldownActive(uint256)', 'error DailyCapReached()',
    'error NotAdmitter()', 'error InvalidAdmitterLimit()', 'error AdmitterDailyCapReached()',
    'error InsufficientAllowance(uint256,uint256)', 'error InsufficientBalance(uint256,uint256)', 'error WrappedError(address,bytes4,bytes,bytes)']);
  const data = encodeErrorResult({ abi: errors, errorName: name, args: args as never });
  expect(decodeTradeRevert(data)).toBe(reason);
  expect(decodeTradeRevert({ cause: { data } })).toBe(reason);
  expect(decodeTradeRevert(encodeErrorResult({ abi: errors, errorName: 'WrappedError', args: [USER, '0x12345678', data, '0x'] }))).toBe(reason);
});
