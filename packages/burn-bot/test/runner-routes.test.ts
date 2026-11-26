import { describe, expect, it } from 'vitest';
import { decodeAbiParameters, decodeFunctionData, encodeFunctionResult, getAddress, keccak256, zeroAddress } from 'viem';
import { v4QuoterAbi } from '../../chain/src/abi/v4Quoter';
import { buildAction, describeCalls, validateManifest } from '../src/builders';
import { Bot } from '../src/bot';
import { Journal, MemoryAppendStore } from '../src/journal';
import { parseRunnerConfig } from '../src/config';
import { ViemQuoteSource } from '../src/quotes';
import { universalRouterAbi, v4SwapParams } from '../src/routes';
import { addr, hash, lot, manifest, must, snapshot } from './fixtures';

export const v4Route = {
  id: 'fit-p', version: 'v4-1', kind: 'v4' as const, tokenIn: manifest.box0.fit, tokenOut: zeroAddress,
  router: addr(40n), codeHash: keccak256('0x1234'), routerVersion: 'UniversalRouter-v2' as const,
  permit2: addr(41n), permit2CodeHash: keccak256('0x1234'),
  path: [{ intermediateCurrency: zeroAddress, fee: '8388608', tickSpacing: '200', hooks: addr(42n), hookData: '0x' }],
  maxInput: 1000n, maxDailyInput: 2000n, slippageBps: 100n, quoteLifetime: 300n,
};
export const runnerInput = () => ({
  manifest: { ...manifest, chainId: '11155111', routes: [v4Route] }, rpcEnv: 'FAKE_RPC', serviceEnv: 'FAKE_SERVICE',
  startBlock: '1', logChunk: '100', maxScanBlocks: '10000', journal: '.cache/bot.sqlite',
  quoters: [{ routeId: 'fit-p', address: addr(43n), codeHash: keccak256('0x1234'), kind: 'v4' }],
});

describe('runner config and hooked v4 routes', () => {
  it('requires an operator flag for chain 1, forbids URLs, numbers and unknown config fields', () => {
    expect(parseRunnerConfig(runnerInput()).manifest.chainId).toBe(11155111n);
    expect(() => parseRunnerConfig({ ...runnerInput(), manifest })).toThrow(/mainnet/);
    expect(parseRunnerConfig({ ...runnerInput(), manifest, quoters: [] }, true).manifest.chainId).toBe(1n);
    expect(() => parseRunnerConfig({ ...runnerInput(), rpcEnv: 'https://fake.invalid' })).toThrow();
    expect(() => parseRunnerConfig({ ...runnerInput(), privateKey: 'FAKE_NOT_A_KEY' })).toThrow();
    expect(() => parseRunnerConfig({ ...runnerInput(), startBlock: 1 })).toThrow();
  });
  it('quotes via eth_call with the pinned hook path then enforces Safe receipt, minOut and revocation', async () => {
    // The FIT Safe sells a non-FIT coin through the hook pool; its own FIT is only burned.
    const coinRoute = { ...v4Route, id: 'coin-v4', tokenIn: addr(15n) };
    const m = validateManifest({ ...manifest, routes: [coinRoute, v4Route] });
    const s = snapshot('fit');
    s.codeHashes[v4Route.router] = v4Route.codeHash;
    s.codeHashes[v4Route.permit2] = v4Route.permit2CodeHash;
    let calls = 0;
    const source = new ViemQuoteSource(m, [{ routeId: 'coin-v4', address: addr(43n), codeHash: keccak256('0x1234'), kind: 'v4' }], {
      getChainId: async () => 1, getCode: async () => '0x1234',
      getBlock: async () => s.block,
      call: async request => {
        calls++;
        expect(request.blockNumber).toBe(s.block.number);
        const decoded = decodeFunctionData({ abi: v4QuoterAbi, data: request.data });
        expect(decoded.functionName).toBe('quoteExactInput');
        expect(decoded.args?.[0]).toMatchObject({ exactCurrency: getAddress(addr(15n)), exactAmount: 100n,
          path: [{ hooks: getAddress(addr(42n)), fee: 8388608, tickSpacing: 200, hookData: '0x' }] });
        return { data: encodeFunctionResult({ abi: v4QuoterAbi, functionName: 'quoteExactInput', result: [200n, 400000n] }) };
      },
    }, true);
    const q = await source.quote('coin-v4', 100n, s.block);
    expect(q.quotedOut).toBe(200n);
    const draft = buildAction(m, s, lot(), { kind: 'sale', lotId: 'lot-1', amount: 100n, routeId: 'coin-v4', quote: q });
    expect(draft.minimumOut).toBe(198n);
    expect(describeCalls(draft.calls, m.routes)).toEqual(expect.arrayContaining([expect.objectContaining({
      functionName: 'execute', v4: expect.objectContaining({ recipient: 'calling-safe', swap: expect.objectContaining({ amountOutMinimum: 198n }) }),
    })]));
    const store = new MemoryAppendStore(); const bot = new Bot(m, new Journal(store));
    bot.receive(lot()); bot.plan(s, draft.request);
    expect(new Bot(m, new Journal(store)).available('lot-1')).toBe(900n);

    const swap = must(draft.calls.find(c => c.to === v4Route.router));
    const decoded = decodeFunctionData({ abi: universalRouterAbi, data: swap.data });
    expect(decoded.args[0]).toBe('0x10');
    expect(decoded.args[2]).toBe(q.deadline);
    const [actions, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], must(decoded.args[1][0]));
    expect(actions).toBe('0x070c0f');
    const [trade] = decodeAbiParameters(v4SwapParams, must(params[0]));
    expect(trade.amountIn).toBe(100n); expect(trade.amountOutMinimum).toBe(198n);
    expect(draft.calls.at(-1)?.to).toBe(addr(15n));
    expect(calls).toBe(1);
    expect(() => buildAction(m, s, lot('fit', m.box0.fit), { kind: 'sale', lotId: 'lot-1', amount: 100n, routeId: 'fit-p',
      quote: { ...q, routeId: 'fit-p', tokenIn: m.box0.fit } })).toThrow(/reserved for burn/);
  });
  it('refuses an unpinned or discontinuous hook route and unsafe slippage', () => {
    expect(() => validateManifest({ ...manifest, routes: [{ ...v4Route, slippageBps: 10000n }] })).toThrow();
    expect(() => validateManifest({ ...manifest, routes: [{ ...v4Route, path: [{ ...v4Route.path[0], intermediateCurrency: addr(13n) }] }] })).toThrow(/path/);
    expect(() => validateManifest({ ...manifest, routes: [{ ...v4Route, permit2: zeroAddress }] })).toThrow();
    expect(hash(1n)).toHaveLength(66);
  });
  it('returns native input refunds to the Safe and supports the pinned per-hop router layout', async () => {
    const { v4Calls, v4HopSwapParams } = await import('../src/routes');
    const native = validateManifest({ ...manifest, routes: [{ ...v4Route, tokenIn: zeroAddress, tokenOut: addr(13n), path: [{ ...v4Route.path[0], intermediateCurrency: addr(13n) }],
      routerVersion: 'UniversalRouter-v2-per-hop-price' }] }).routes[0];
    if (native?.kind !== 'v4') throw new Error('missing v4 route');
    const calls = v4Calls(native, 100n, 190n, 100200n);
    const decoded = decodeFunctionData({ abi: universalRouterAbi, data: must(calls[0]).data });
    expect(decoded.args[0]).toBe('0x1004');
    const [currency, recipient, minimum] = decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], must(decoded.args[1][1]));
    expect([currency, recipient, minimum]).toEqual([zeroAddress, addr(1n), 0n]);
    const [, actions] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], must(decoded.args[1][0]));
    expect(decodeAbiParameters(v4HopSwapParams, must(actions[0]))[0]).toMatchObject({ minHopPriceX36: [], amountIn: 100n, amountOutMinimum: 190n });
  });

});
