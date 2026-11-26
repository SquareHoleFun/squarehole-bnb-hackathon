import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { buildListingKit } from '../kit.mjs';
import { Market } from '../market.mjs';
import { Reader } from '../rpc.mjs';
import { parseInput } from '../config.mjs';
import { fakeRpc, input, A, H, PLAIN } from './rpc.mjs';
const { parseAbi, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, toFunctionSelector, decodeFunctionData, keccak256 } =
  createRequire(new URL('../../../packages/burn-bot/package.json', import.meta.url))('viem');
const Q = 1n << 96n;
const v4Abi = parseAbi([
  'event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)',
  'event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)',
  'function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)', 'function getLiquidity(bytes32) view returns (uint128)',
  'function quoteExactInput((address exactCurrency,(address intermediateCurrency,uint24 fee,int24 tickSpacing,address hooks,bytes hookData)[] path,uint128 exactAmount) params) returns (uint256,uint256)',
]);
const v2Abi = parseAbi(['event Sync(uint112 reserve0,uint112 reserve1)',
  'function getReserves() view returns (uint112,uint112,uint32)', 'function getPair(address,address) view returns (address)',
  'function getPool(address,address,uint24) view returns (address)',
  'function factory() view returns (address)', 'function token0() view returns (address)', 'function token1() view returns (address)']);
const poolKey = [A(4), PLAIN, 3000n, 60n, A(0)];
function log(abi, eventName, indexed, data, block, address) {
  return { address, blockNumber: `0x${BigInt(block).toString(16)}`, blockHash: H(block), logIndex: '0x0', removed: false,
    topics: encodeEventTopics({ abi, eventName, args: indexed }), data };
}
function setup(kind, missing = false, hooks = A(0)) {
  const key = [...poolKey.slice(0, 4), hooks];
  const id = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], key));
  const rpc = fakeRpc(), original = rpc.request.bind(rpc);
  rpc.request = async (method, params) => {
    if (method === 'eth_call') {
      const { to, data } = params[0];
      if (kind === 'v4' && to === A(21) && data.startsWith(toFunctionSelector('getPool(address,address,uint24)'))) {
        return encodeFunctionResult({ abi: v2Abi, functionName: 'getPool', result: A(0) });
      }
      if (kind === 'v4' && to === A(25) && !data.startsWith(toFunctionSelector('poolManager()'))) {
        const { functionName } = decodeFunctionData({ abi: v4Abi, data });
        const result = functionName === 'getLiquidity' ? 10n ** 30n : [BigInt(params[1]) < 700n ? Q : 2n * Q, 0, 0, 3000];
        return encodeFunctionResult({ abi: v4Abi, functionName, result });
      }
      if (kind === 'v4' && to === A(26) && data.startsWith(toFunctionSelector('quoteExactInput((address,(address,uint24,int24,address,bytes)[],uint128))'))) {
        const { args } = decodeFunctionData({ abi: v4Abi, data });
        expect(typeof args[0].exactAmount).toBe('bigint');
        return encodeFunctionResult({ abi: v4Abi, functionName: 'quoteExactInput', result: [args[0].exactAmount * 997n / 4000n, 120000n] });
      }
      if (kind === 'v2' && [A(20), A(21), A(500)].includes(to)) {
        const { functionName } = decodeFunctionData({ abi: v2Abi, data });
        const result = functionName === 'getPair' ? A(500) : functionName === 'getPool' ? A(0)
          : functionName === 'getReserves' ? [10n ** 22n, (BigInt(params[1]) < 700n ? 1n : 3n) * 10n ** 22n, 0]
            : functionName === 'factory' ? A(20) : functionName === 'token0' ? A(4) : PLAIN;
        return encodeFunctionResult({ abi: v2Abi, functionName, result });
      }
    }
    if (method === 'eth_getLogs') {
      const filter = params[0], first = BigInt(filter.fromBlock), last = BigInt(filter.toBlock);
      const event = filter.topics[0];
      if (kind === 'v4' && filter.address === A(24)) {
        const initTopics = encodeEventTopics({ abi: v4Abi, eventName: 'Initialize' });
        if (event === initTopics[0] && first <= 1n && last >= 1n) return [log(v4Abi, 'Initialize', { id, currency0: A(4), currency1: PLAIN },
          encodeAbiParameters([{ type: 'uint24' }, { type: 'int24' }, { type: 'address' }, { type: 'uint160' }, { type: 'int24' }], [3000n, 60n, hooks, Q, 0n]), 1, A(24))];
        if (!missing && event === encodeEventTopics({ abi: v4Abi, eventName: 'Swap' })[0] && first <= 700n && last >= 700n) return [log(v4Abi, 'Swap', { id, sender: A(42) },
          encodeAbiParameters([{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }], [1n, -1n, Q * 2n, 10n ** 30n, 13863n, 3000n]), 700, A(24))];
      }
      if (kind === 'v2' && !missing && filter.address === A(500) && first <= 700n && last >= 700n) return [log(v2Abi, 'Sync', {},
        encodeAbiParameters([{ type: 'uint112' }, { type: 'uint112' }], [10n ** 22n, 3n * 10n ** 22n]), 700, A(500))];
    }
    return original(method, params);
  };
  return { rpc, config: { ...input(), tokens: [input().tokens[0]] } };
}

describe('archive RPC market adapters', () => {
  it('refuses a v3 quoter that prices pools from a different factory', async () => {
    const rpc = fakeRpc(), original = rpc.request.bind(rpc);
    rpc.request = (method, params) => method === 'eth_call' && params[0].to === A(22)
      && params[0].data === toFunctionSelector('factory()') ? Promise.resolve(H(999)) : original(method, params);
    await expect(buildListingKit(input(), rpc, true)).rejects.toThrow(/v3.*factory/);
  });
  it('discovers v4 Initialize, quotes it and reconstructs a seven-day Swap TWAP', async () => {
    const { rpc, config } = setup('v4');
    const result = await buildListingKit(config, rpc, true);
    expect(result.coins[0].route.pools[0].kind).toBe('v4');
    expect(result.coins[0].eligible).toBe(true);
    expect(result.coins[0].raise.amount).toBe('10517450212500000000');
    expect(result.coins[0].raise.pools[0].updates).toHaveLength(1);
    expect(result.coins[0].route.impactBps).toBe('30');
    const { routeSchema } = await import('../../../packages/burn-bot/src/schema');
    expect(routeSchema.parse(result.runner.routes[0]).kind).toBe('v4');
  });

  it('discovers v2 reserves and Sync history, reports deepest v2 without inventing a runner format', async () => {
    const { rpc, config } = setup('v2');
    const result = await buildListingKit(config, rpc, true);
    expect(result.coins[0].eligible).toBe(true);
    expect(result.coins[0].route.pools[0].kind).toBe('v2');
    expect(result.coins[0].raise.amount).toBe('8413960170000000000');
    expect(result.runner.routes).toEqual([]);
    expect(result.runner.unavailable[0].reason).toContain('v2');
    expect(BigInt(result.coins[0].route.quotedOut)).toBe(10n ** 18n * 997n * 10n ** 22n / (3n * 10n ** 22n * 1000n + 10n ** 18n * 997n));
  });

  it.each(['v2', 'v4'])('withholds the default raise when %s logs do not reach final state', async kind => {
    const { rpc, config } = setup(kind, true);
    const result = await buildListingKit(config, rpc, true);
    expect(result.coins[0].raise.amount).toBeNull();
    expect(result.safeBatch.transactions).toEqual([]);
  });

  it('validates raw input limits before exported routes enter the runner', async () => {
    const { config } = setup('v4');
    expect(() => parseInput({ ...config, referenceAmount: '2000000000000000000' }, true)).toThrow(/reference/);
  });

  it('rejects a duplicate, removed or off-chain-block log instead of pricing it', async () => {
    const { rpc, config } = setup('v2');
    const reader = await new Reader(rpc, parseInput(config, true)).init();
    const market = await new Market(reader, config).discover();
    const original = rpc.request.bind(rpc);
    rpc.request = async (method, params) => {
      const result = await original(method, params);
      if (method === 'eth_getLogs' && result.length) return [...result, result[0]];
      return result;
    };
    await expect(market.raise({ pools: market.pools, path: [PLAIN, A(4)] }, 1n)).rejects.toThrow(/duplicate/);
  });
});

describe('v4 hook policy', () => {
  it('reports a hostile-hook pool and never uses it for the raise or runner', async () => {
    const { rpc, config } = setup('v4', false, A(999));
    const result = await buildListingKit(config, rpc, true);
    expect(result.discovery.excluded).toContainEqual(expect.objectContaining({ kind: 'v4', hooks: A(999), reason: 'v4 hook is not allowed' }));
    expect(result.coins[0].route).toBeNull();
    expect(result.coins[0].raise.amount).toBeNull();
    expect(result.runner.routes).toEqual([]);
    expect(result.safeBatch.transactions).toEqual([]);
  });

  it('accepts an explicitly allowlisted hook and reports the selected policy', async () => {
    const { rpc, config } = setup('v4', false, A(999));
    config.market.v4.allowedHooks = [A(999)];
    const result = await buildListingKit(config, rpc, true);
    expect(result.coins[0].eligible).toBe(true);
    expect(result.coins[0].route.pools[0].hooks).toBe(A(999));
    expect(result.runner.routes[0].path[0].hooks).toBe(A(999));
    expect(result.discovery.allowedV4Hooks).toEqual([A(999)]);
  });
});

describe('complete discovery and persisted histories', () => {
  it('reports each refused Initialize and still evaluates the following zero-hook pool', async () => {
    const { rpc, config } = setup('v4'), original = rpc.request.bind(rpc);
    rpc.request = async (method, params) => {
      const result = await original(method, params);
      if (method !== 'eth_getLogs' || params[0].topics[0] !== encodeEventTopics({ abi: v4Abi, eventName: 'Initialize' })[0] || !result.length) return result;
      const refused = [A(998), A(999)].map((hooks, index) => {
        const id = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [...poolKey.slice(0, 4), hooks]));
        return { ...log(v4Abi, 'Initialize', { id, currency0: A(4), currency1: PLAIN },
          encodeAbiParameters([{ type: 'uint24' }, { type: 'int24' }, { type: 'address' }, { type: 'uint160' }, { type: 'int24' }], [3000n, 60n, hooks, Q, 0n]), 1, A(24)), logIndex: `0x${index}` };
      });
      const malformed = { ...result[0], topics: [...result[0].topics], logIndex: '0x2' };
      malformed.topics[1] = H(999);
      return [...refused, malformed, { ...result[0], logIndex: '0x3' }];
    };
    const result = await buildListingKit(config, rpc, true);
    expect(result.discovery.excluded).toHaveLength(3);
    expect(result.discovery.excluded.map(p => p.reason)).toEqual(['v4 hook is not allowed', 'v4 hook is not allowed', 'Initialize identity or encoding invalid']);
    expect(new Set(result.discovery.excluded.map(p => p.id)).size).toBe(3);
    expect(result.coins[0].eligible).toBe(true);
    expect(result.runner.routes[0].path[0].hooks).toBe(A(0));
  });

  it('resumes nonempty Initialize and Swap pages with the same raise and batch as an uninterrupted scan', async () => {
    const baseline = setup('v4'), expected = await buildListingKit(baseline.config, baseline.rpc, true);
    const { rpc, config } = setup('v4');
    config.maxScanBlocks = '1000'; config.logChunk = '500';
    let cursor, actual, attempts = 0;
    while (!actual && attempts++ < 5) {
      try { actual = await buildListingKit(config, rpc, true, { cursor, saveCursor: value => { cursor = structuredClone(value); } }); }
      catch (error) { expect(error.message).toMatch(/scan incomplete/); }
    }
    expect(attempts).toBeGreaterThan(1);
    expect(cursor.pages.flatMap(p => p.logs)).toHaveLength(2);
    expect(actual.coins[0].raise).toEqual(expected.coins[0].raise);
    expect(actual.safeBatch).toEqual(expected.safeBatch);
    expect(actual.runner).toEqual(expected.runner);
  });
});
