import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, keccak256, parseAbi, zeroAddress } from 'viem';
import { buildAction } from '../src/builders';
import { ViemQuoteSource } from '../src/quotes';
import { addr, lot, manifest, must, quote, snapshot } from './fixtures';

const reviewed = vi.hoisted(() => ({ entries: {} as Record<string, unknown> }));
vi.mock('../src/listing-route-manifest', () => ({
  get listingRouteManifest() { return reviewed.entries; },
}));
const factoryAbi = parseAbi(['function factory() view returns (address)']);
const quoterAbi = parseAbi(['function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)']);
const factory = addr(200n), registry = addr(50n), pool = addr(201n);
const key = `1:${registry}:7:${addr(15n)}`;
function fixture() {
  const route = { ...must(manifest.routes[0]), codeHash: keccak256('0x1234') };
  if (route.kind !== 'v3') throw new Error('missing v3 fixture');
  const pin = { chainId: '1', registry, listingId: '7', p: route.tokenIn, weth: manifest.weth,
    factory, routeId: route.id, routeVersion: route.version, pools: [pool], path: [...route.path], fees: route.fees.map(String) };
  reviewed.entries = { [key]: pin };
  const m = { ...manifest, routes: [route] }, s = snapshot();
  s.codeHashes[route.router] = route.codeHash;
  const rpc = {
    getChainId: async () => 1, getCode: async () => '0x1234' as const,
    getBlock: async () => s.block,
    call: vi.fn(async (c: { to: string; data: `0x${string}`; blockNumber: bigint }) => {
      expect(c.blockNumber).toBe(s.block.number);
      if (c.to === route.router) {
        expect(decodeFunctionData({ abi: factoryAbi, data: c.data }).functionName).toBe('factory');
        return { data: encodeFunctionResult({ abi: factoryAbi, functionName: 'factory', result: factory }) };
      }
      const decoded = decodeFunctionData({ abi: quoterAbi, data: c.data });
      expect(decoded.args).toEqual([`${pin.path[0]}000bb8${manifest.weth.slice(2)}`, 100n]);
      return { data: encodeFunctionResult({ abi: quoterAbi, functionName: 'quoteExactInput', result: [200n, [], [], 100000n] }) };
    }),
  };
  const source = new ViemQuoteSource(m, [{ routeId: route.id, address: addr(43n), codeHash: keccak256('0x1234'), kind: 'v3' }], rpc, true);
  return { route, pin, m, s, rpc, source };
}
beforeEach(() => { reviewed.entries = {}; });

describe('SH-MN-07-ROUTE shared listing sale pins', () => {
  it('quotes the committed P-to-WETH path and checks the router factory at the finalized block', async () => {
    const f = fixture();
    const q = await f.source.quote(f.route.id, 100n, f.s.block);
    expect(q.quotedOut).toBe(200n);
    expect(f.rpc.call.mock.calls.some(([c]) => c.to === f.route.router)).toBe(true);
    expect(buildAction(f.m, f.s, lot(), { kind: 'sale', lotId: 'lot-1', amount: 100n, routeId: f.route.id, quote: q }).minimumOut).toBe(198n);
  });

  it.each(['path', 'fee', 'version', 'route id', 'WETH', 'manifest key', 'four hops', 'ambiguous listing'])(
    'refuses a %s mismatch before quote or Safe calldata construction', async failure => {
      const f = fixture();
      if (failure === 'path') f.route.path = [f.route.tokenIn, addr(90n), manifest.weth];
      if (failure === 'fee') f.route.fees = [500];
      if (failure === 'version') f.route.version = '2';
      if (failure === 'route id') f.route.id = 'alternate';
      if (failure === 'WETH') f.pin.weth = addr(99n);
      if (failure === 'manifest key') f.pin.listingId = '8';
      if (failure === 'four hops') {
        f.pin.path = [f.route.tokenIn, addr(90n), addr(91n), addr(92n), manifest.weth];
        f.pin.pools = [pool, addr(202n), addr(203n), addr(204n)]; f.pin.fees = ['3000', '3000', '3000', '3000'];
        f.route.path = [...f.pin.path]; f.route.fees = [3000, 3000, 3000, 3000];
      }
      if (failure === 'ambiguous listing') reviewed.entries[`1:${registry}:8:${f.pin.p}`] = { ...f.pin, listingId: '8' };
      await expect(f.source.quote(f.route.id, 100n, f.s.block)).rejects.toThrow(/listing route/);
      expect(f.rpc.call).not.toHaveBeenCalled();
      expect(() => buildAction(f.m, f.s, lot(), { kind: 'sale', lotId: 'lot-1', amount: 100n,
        routeId: f.route.id, quote: { ...quote(), routeId: f.route.id, routeVersion: f.route.version } })).toThrow(/listing route/);
    });

  it('refuses a router using a different factory even if its configured code hash is approved', async () => {
    const f = fixture();
    f.rpc.call.mockResolvedValue({ data: encodeFunctionResult({ abi: factoryAbi, functionName: 'factory', result: addr(255n) }) });
    await expect(f.source.quote(f.route.id, 100n, f.s.block)).rejects.toThrow(/listing route factory/);
    expect(f.rpc.call).toHaveBeenCalledTimes(1);
  });

  it('does not let a v4 sale bypass an existing v3 listing pin', async () => {
    const f = fixture();
    const route = { ...f.route, kind: 'v4' as const, routerVersion: 'UniversalRouter-v2' as const,
      permit2: addr(41n), permit2CodeHash: keccak256('0x1234'),
      path: [{ intermediateCurrency: zeroAddress, fee: '3000', tickSpacing: '60', hooks: zeroAddress, hookData: '0x' as const }] };
    const source = new ViemQuoteSource({ ...f.m, routes: [route] }, [], f.rpc, true);
    await expect(source.quote(route.id, 100n, f.s.block)).rejects.toThrow(/listing route/);
  });
});
