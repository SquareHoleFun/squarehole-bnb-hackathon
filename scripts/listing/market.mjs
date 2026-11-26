import { ceil, decodeEventLog, encodeAbiParameters, encodePacked, keccak256, lower, need, parseAbi, Q96, Q128, toEventSelector, toHex, WEEK, ZERO } from './common.mjs';

const initializeAbi = parseAbi(['event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)']);
const swapAbi = {
  v2: parseAbi(['event Sync(uint112 reserve0,uint112 reserve1)']),
  v3: parseAbi(['event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)']),
  v4: parseAbi(['event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)']),
};
const keyTypes = [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }];
const v4Quote = 'function quoteExactInput((address exactCurrency,(address intermediateCurrency,uint24 fee,int24 tickSpacing,address hooks,bytes hookData)[] path,uint128 exactAmount) params) returns (uint256 amountOut,uint256 gasEstimate)';
const v3Quote = 'function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)';
// viem's encoder accepts bigint for narrow integers too: even fee tiers stay out of Number.
const abiInt = v => BigInt(v);
const reserves = (sqrt, liquidity) => {
  need(sqrt > 0n && liquidity > 0n, 'pool has no active liquidity');
  return { reserve0: liquidity * Q96 / sqrt, reserve1: liquidity * sqrt / Q96, sqrtPriceX96: sqrt, liquidity };
};
function ratio(pool, from) {
  need(pool.reserve0 > 0n && pool.reserve1 > 0n, 'zero pool depth');
  const n = pool.sqrtPriceX96 ? pool.sqrtPriceX96 ** 2n : pool.reserve1;
  const d = pool.sqrtPriceX96 ? Q96 ** 2n : pool.reserve0;
  return from === pool.token0 ? [n, d] : [d, n];
}

export function enumerateRoutes(pools, token, weth) {
  const routes = [];
  function walk(path, hops) {
    const current = path[path.length - 1];
    if (current === weth) { if (hops.length) routes.push({ path, pools: hops }); return; }
    if (hops.length === 3) return;
    for (const pool of pools) {
      const next = pool.token0 === current ? pool.token1 : pool.token1 === current ? pool.token0 : null;
      if (next && !path.includes(next)) walk([...path, next], [...hops, pool]);
    }
  }
  walk([token], []); return routes;
}
export async function rankRoutes(routes, reference, quote, rejected = []) {
  const ranked = [];
  for (const route of routes) {
    let failedPool;
    try {
      let quotedOut = reference, spotN = 1n, spotD = 1n;
      for (let i = route.pools.length - 1; i >= 0; i--) {
        const p = route.pools[i], from = route.path[i];
        failedPool = { kind: p.kind, id: p.id };
        const [n, d] = ratio(p, from);
        spotN *= n; spotD *= d;
      }
      const spotOut = reference * spotN / spotD;
      need(spotOut > 0n, 'route too small');
      for (let i = 0; i < route.pools.length; i++) {
        const p = route.pools[i], from = route.path[i];
        failedPool = { kind: p.kind, id: p.id };
        if (p.kind === 'v2') {
          const rin = from === p.token0 ? p.reserve0 : p.reserve1;
          const rout = from === p.token0 ? p.reserve1 : p.reserve0;
          quotedOut = quotedOut * 997n * rout / (rin * 1000n + quotedOut * 997n);
        } else quotedOut = await quote(p, from, quotedOut);
        need(quotedOut > 0n, 'zero route quote');
      }
      ranked.push({ ...route, referenceAmount: reference, quotedOut, spotOut,
        impactBps: spotOut > quotedOut ? ceil((spotOut - quotedOut) * 10000n, spotOut) : 0n });
    } catch {
      rejected.push({ path: route.path, pools: route.pools.map(p => ({ kind: p.kind, id: p.id })),
        failedPool, reason: 'reference quote or spot price unavailable' });
    }
  }
  return ranked.sort((a, b) => {
    // Compare exact loss fractions before display rounding; virtual reserves never affect rank.
    const lossA = a.spotOut > a.quotedOut ? a.spotOut - a.quotedOut : 0n;
    const lossB = b.spotOut > b.quotedOut ? b.spotOut - b.quotedOut : 0n;
    const delta = lossA * b.spotOut - lossB * a.spotOut;
    return delta !== 0n ? delta < 0n ? -1 : 1 : a.quotedOut !== b.quotedOut ? a.quotedOut > b.quotedOut ? -1 : 1
      : a.pools.map(p => p.id).join().localeCompare(b.pools.map(p => p.id).join());
  });
}

/** Arithmetic time average of token raw units per WETH wei for the whole route. */
export function timeWeightedRaise(route, start, end, ethRaise) {
  need(end - start === WEEK && typeof ethRaise === 'bigint' && ethRaise > 0n, 'full seven-day window required');
  const states = route.pools.map(p => ({ ...p }));
  const events = route.pools.flatMap((p, index) => p.history.map(e => ({ ...e, index })))
    .filter(e => e.timestamp >= start && e.timestamp <= end)
    .sort((a, b) => a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.index - b.index);
  let cursor = start, weightedX128 = 0n, intervals = 0;
  const integrate = until => {
    if (until === cursor) return;
    let n = 1n, d = 1n;
    for (let i = 0; i < states.length; i++) { const [out, input] = ratio(states[i], route.path[i]); n *= input; d *= out; }
    weightedX128 += ceil(n * Q128, d) * (until - cursor); cursor = until; intervals++;
  };
  for (const event of events) { integrate(event.timestamp); Object.assign(states[event.index], event); }
  integrate(end);
  const averageX128 = ceil(weightedX128, WEEK);
  return { amount: ceil(ethRaise * averageX128, Q128), ethRaise, averageX128, scale: Q128,
    startTimestamp: start, endTimestamp: end, seconds: WEEK, intervals,
    method: 'arithmetic TWAP of composite token-raw/WETH-wei; Q128 rounded up per interval and at averaging' };
}
export function roundRaise(amount, rounding) {
  need(typeof amount === 'bigint' && amount > 0n, 'bigint positive raise required');
  if (!rounding) return amount;
  const step = BigInt(rounding.increment); need(step > 0n, 'invalid rounding increment');
  if (rounding.mode === 'up') return ceil(amount, step) * step;
  if (rounding.mode === 'down') return amount / step * step;
  need(rounding.mode === 'nearest', 'invalid rounding mode');
  return ((amount + step / 2n) / step) * step;
}

export class Market {
  constructor(reader, config) { this.reader = reader; this.config = config; this.pools = []; this.excluded = []; this.historyCache = new Map(); }
  async state(pool, tag = this.reader.tag) {
    const r = this.reader;
    if (pool.kind === 'v2') {
      const [reserve0, reserve1] = await r.read(pool.address, 'function getReserves() view returns (uint112,uint112,uint32)', [], tag);
      need(reserve0 > 0n && reserve1 > 0n, 'empty v2 pool'); return { reserve0, reserve1 };
    }
    if (pool.kind === 'v3') {
      const slot = await r.read(pool.address, 'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)', [], tag);
      const liquidity = await r.read(pool.address, 'function liquidity() view returns (uint128)', [], tag);
      return reserves(slot[0], liquidity);
    }
    const slot = await r.read(pool.venue.stateView.address, 'function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)', [pool.id], tag);
    const liquidity = await r.read(pool.venue.stateView.address, 'function getLiquidity(bytes32) view returns (uint128)', [pool.id], tag);
    return reserves(slot[0], liquidity);
  }
  async add(pool) {
    if (pool.kind === 'v4' && !allowedHook(this.config, pool.hooks)) {
      this.excluded.push({ id: pool.id, kind: pool.kind, hooks: pool.hooks, reason: 'v4 hook is not allowed' });
      return;
    }
    try {
      if (pool.kind !== 'v4') {
        need(await this.reader.code(pool.address) !== '0x', 'pool code missing');
        const token0 = lower(await this.reader.read(pool.address, 'function token0() view returns (address)'));
        const token1 = lower(await this.reader.read(pool.address, 'function token1() view returns (address)'));
        need(token0 === pool.token0 && token1 === pool.token1, 'pool token identity mismatch');
        need(lower(await this.reader.read(pool.address, 'function factory() view returns (address)')) === pool.venue.factory.address, 'pool factory mismatch');
        if (pool.kind === 'v3') need(BigInt(await this.reader.read(pool.address, 'function fee() view returns (uint24)')) === BigInt(pool.fee), 'pool fee mismatch');
      }
      const state = await this.state(pool);
      this.pools.push({ ...pool, ...state });
    } catch { this.excluded.push({ id: pool.id, kind: pool.kind, reason: 'pool identity, code or active liquidity unavailable' }); }
  }
  async discover() {
    const { market, bridges, weth, tokens } = this.config;
    for (const venue of Object.values(market)) for (const pin of Object.values(venue)) if (pin?.codeHash) await this.reader.pin(pin);
    for (const endpoint of [market.v3.quoter, market.v3.router]) {
      need(lower(await this.reader.read(endpoint.address, 'function factory() view returns (address)')) === market.v3.factory.address, 'v3 quoter/router factory mismatch');
    }
    need(lower(await this.reader.read(market.v4.stateView.address, 'function poolManager() view returns (address)')) === market.v4.manager.address, 'StateView manager mismatch');
    need(lower(await this.reader.read(market.v4.quoter.address, 'function poolManager() view returns (address)')) === market.v4.manager.address, 'v4 quoter manager mismatch');
    const intermediates = [...new Set([weth, ...bridges])], pairs = new Map();
    for (const from of [...tokens.map(t => t.token), ...intermediates]) for (const to of intermediates) {
      if (from === to) continue;
      const [a, b] = [from, to].sort(); pairs.set(`${a}:${b}`, [a, b]);
    }
    for (const [a, b] of pairs.values()) {
      try {
        const address = lower(await this.reader.read(market.v2.factory.address, 'function getPair(address,address) view returns (address)', [a, b]));
        if (address !== ZERO) await this.add({ kind: 'v2', id: address, address, token0: a, token1: b, fee: '3000', venue: market.v2 });
      } catch { this.excluded.push({ kind: 'v2', token0: a, token1: b, reason: 'factory lookup unavailable' }); }
      for (const fee of market.v3.fees) {
        try {
          const address = lower(await this.reader.read(market.v3.factory.address, 'function getPool(address,address,uint24) view returns (address)', [a, b, abiInt(fee)]));
          if (address !== ZERO) await this.add({ kind: 'v3', id: address, address, token0: a, token1: b, fee, venue: market.v3 });
        } catch { this.excluded.push({ kind: 'v3', token0: a, token1: b, fee, reason: 'factory lookup unavailable' }); }
      }
      try {
        const logs = await this.reader.logs(market.v4.manager.address, [toEventSelector(initializeAbi[0]), null, toHex(BigInt(a), { size: 32 }), toHex(BigInt(b), { size: 32 })], BigInt(market.v4.fromBlock));
        for (const log of logs) {
          try {
            const { args } = decodeEventLog({ abi: initializeAbi, ...log });
            need(lower(args.currency0) === a && lower(args.currency1) === b, 'v4 currency mismatch');
            need(keccak256(encodeAbiParameters(keyTypes, [a, b, args.fee, args.tickSpacing, args.hooks])) === args.id, 'v4 pool id mismatch');
            await this.add({ kind: 'v4', id: args.id, address: market.v4.manager.address, token0: a, token1: b,
              fee: args.fee.toString(), tickSpacing: args.tickSpacing.toString(), hooks: lower(args.hooks), hookData: '0x', venue: market.v4 });
          } catch {
            this.excluded.push({ kind: 'v4', id: log.topics[1], token0: a, token1: b,
              blockNumber: log.blockNumber, logIndex: log.logIndex, reason: 'Initialize identity or encoding invalid' });
          }
        }
      } catch { this.excluded.push({ kind: 'v4', token0: a, token1: b, reason: 'Initialize history unavailable or malformed' }); }
    }
    return this;
  }
  async quote(pool, from, amount) {
    if (pool.kind === 'v3') {
      const to = pool.token0 === from ? pool.token1 : pool.token0;
      const path = encodePacked(['address', 'uint24', 'address'], [from, abiInt(pool.fee), to]);
      return (await this.reader.read(pool.venue.quoter.address, v3Quote, [path, amount]))[0];
    }
    need(amount < 1n << 128n, 'v4 quote amount exceeds uint128');
    const intermediateCurrency = pool.token0 === from ? pool.token1 : pool.token0;
    const path = [{ intermediateCurrency, fee: abiInt(pool.fee), tickSpacing: abiInt(pool.tickSpacing), hooks: pool.hooks, hookData: pool.hookData }];
    return (await this.reader.read(pool.venue.quoter.address, v4Quote, [{ exactCurrency: from, path, exactAmount: amount }]))[0];
  }
  async routes(coin, reference) {
    const routes = enumerateRoutes(this.pools, coin.token, this.config.weth);
    const rejected = [];
    return { routes: await rankRoutes(routes, reference, (pool, from, amount) => this.quote(pool, from, amount), rejected),
      candidates: routes.length, rejected };
  }
  async history(pool, start) {
    const cacheKey = `${pool.kind}:${pool.id}:${start}`;
    if (!this.historyCache.has(cacheKey)) this.historyCache.set(cacheKey, this.loadHistory(pool, start));
    return this.historyCache.get(cacheKey);
  }
  async loadHistory(pool, start) {
    const block = await this.reader.atOrBefore(start);
    const state = await this.state(pool, toHex(block.number));
    const abi = swapAbi[pool.kind];
    const topics = [toEventSelector(abi[0]), ...(pool.kind === 'v4' ? [pool.id] : [])];
    const logs = await this.reader.logs(pool.address, topics, block.number + 1n);
    const history = [];
    for (const log of logs) {
      const { args } = decodeEventLog({ abi, ...log });
      const timestamp = (await this.reader.block(BigInt(log.blockNumber))).timestamp;
      history.push({ timestamp, ...(pool.kind === 'v2' ? { reserve0: args.reserve0, reserve1: args.reserve1 }
        : reserves(args.sqrtPriceX96, args.liquidity)) });
    }
    // Reconcile final price against independent state. Missing/truncated logs must not silently produce a TWAP.
    const final = { ...state, ...history.at(-1) };
    need(pool.kind === 'v2' ? final.reserve0 === pool.reserve0 && final.reserve1 === pool.reserve1
      : final.sqrtPriceX96 === pool.sqrtPriceX96, 'history does not reach snapshot price');
    return { ...pool, ...state, history, historyStartBlock: block };
  }
  async raise(route, nativeRaise) {
    const end = this.reader.end.timestamp, start = end - WEEK;
    const pools = [];
    for (const pool of route.pools) pools.push(await this.history(pool, start));
    return { ...timeWeightedRaise({ ...route, pools }, start, end, nativeRaise),
      pools: pools.map(p => ({ kind: p.kind, id: p.id, initial: { reserve0: p.reserve0, reserve1: p.reserve1, sqrtPriceX96: p.sqrtPriceX96 },
        historyStartBlock: p.historyStartBlock, updates: p.history })) };
  }
}

function allowedHook(config, hooks) {
  return hooks === ZERO || (config.market.v4.allowedHooks ?? []).includes(hooks);
}

export function runnerEntries(config, coin, route, reference) {
  if (route.pools.some(p => p.kind === 'v4' && !allowedHook(config, p.hooks))) return { reason: 'v4 hook is not allowed' };
  const kind = route.pools[0].kind;
  if (kind === 'v2' || route.pools.some(p => p.kind !== kind)) return { reason: 'runner does not support v2 or mixed-venue routes; see Integrator requests' };
  const venue = config.market[kind], id = `listing-${coin.token.slice(2)}-${kind}`;
  const common = { id, version: 'listing-kit-1', kind, tokenIn: coin.token, tokenOut: config.weth,
    maxInput: reference.toString(), ...config.routePolicy, router: venue.router.address, codeHash: venue.router.codeHash };
  const result = kind === 'v3'
    ? { ...common, routerVersion: 'SwapRouter-v1', path: route.path, fees: route.pools.map(p => p.fee) }
    : { ...common, routerVersion: 'UniversalRouter-v2', permit2: venue.permit2.address, permit2CodeHash: venue.permit2.codeHash,
      path: route.pools.map((p, i) => ({ intermediateCurrency: route.path[i + 1], fee: p.fee, tickSpacing: p.tickSpacing, hooks: p.hooks, hookData: p.hookData })) };
  return { route: result, quoter: { routeId: id, address: venue.quoter.address, codeHash: venue.quoter.codeHash, kind } };
}
