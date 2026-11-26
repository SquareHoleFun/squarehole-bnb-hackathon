// Offline only. Decode forge -vv --json receipts; no production statistics code is imported.
import { readFileSync, writeFileSync } from 'node:fs';
import { decodeAbiParameters, decodeEventLog, parseAbi, parseAbiParameters } from 'viem';

const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const named = parseAbi(['event log_named_bytes(string key, bytes val)']);
const swapAbi = parseAbi(['event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)']);
const stages = ['launch', 'buy', 'sell', 'filled', 'graduated', 'poolBuy', 'poolSellBurn'];
const fixtures = {};
for (const suite of Object.values(input)) for (const [testName, test] of Object.entries(suite.test_results)) {
  if (test.status !== 'Success') throw new Error(`recording failed: ${testName}`);
  const data = {};
  for (const log of test.logs) {
    let value;
    try { value = decodeEventLog({ abi: named, topics: log.topics, data: log.data }).args; } catch { continue; }
    const { key, val } = value;
    if (stages.includes(key)) data[key] = decodeAbiParameters(parseAbiParameters('(bytes32[] topics,bytes data,address emitter)[]'), val)[0];
    else if (key === 'wiring') {
      const values = decodeAbiParameters(parseAbiParameters('address,address,address,address,address,address,address,uint256,bytes32,address,address'), val);
      data.wiring = Object.fromEntries(['coordinator', 'token', 'hook', 'receiver', 'poolManager', 'buyer', 'p', 'raise', 'poolId', 'registry', 'listingRegistry'].map((name, i) => [name, values[i]]));
    } else if (key.endsWith('State')) {
      const values = decodeAbiParameters(parseAbiParameters('uint256,uint256,uint160,uint256,uint256,uint256[5]'), val);
      data[key] = Object.fromEntries(['timestamp', 'supply', 'sqrtPriceX96', 'burned', 'raised', 'balances'].map((name, i) => [name, values[i]]));
    }
  }
  if (Object.keys(data).length !== 15) throw new Error('missing recorded stages');
  const expected = {};
  const candles = new Map();
  let count = 0n; let volume = 0n;
  const excluded = [data.wiring.hook, data.wiring.receiver].map(a => a.toLowerCase());
  const price = sqrt => (10n ** 36n * (1n << 192n)) / (sqrt * sqrt);
  for (const stage of stages) {
    const state = data[`${stage}State`];
    for (const log of data[stage]) {
      if (log.emitter.toLowerCase() !== data.wiring.poolManager.toLowerCase()) continue;
      let args;
      try { args = decodeEventLog({ abi: swapAbi, topics: log.topics, data: log.data }).args; } catch { continue; }
      if (args.amount0 === 0n && args.amount1 === 0n) continue;
      const external = !excluded.includes(args.sender.toLowerCase());
      const v = external ? args.amount0 < 0n ? -args.amount0 : args.amount0 : 0n;
      count += external ? 1n : 0n; volume += v;
      const start = state.timestamp / 3600n * 3600n; const p = price(args.sqrtPriceX96); const c = candles.get(start);
      candles.set(start, { start, open: c?.open ?? p, high: c && c.high > p ? c.high : p, low: c && c.low < p ? c.low : p,
        close: p, volumeP: (c?.volumeP ?? 0n) + v, tradeCount: (c?.tradeCount ?? 0n) + (external ? 1n : 0n) });
    }
    // Solidity balance reads cover every nonzero T holder in this recorded token-only life.
    if (state.balances.reduce((sum, n) => sum + n, 0n) !== state.supply) throw new Error(`unrecorded holder at ${stage}`);
    expected[stage] = { pricePPerTX18: price(state.sqrtPriceX96), marketCapP: state.supply * (1n << 192n) / (state.sqrtPriceX96 ** 2n),
      totalSupplyT: state.supply, burnedT: state.burned, holderCount: state.balances.reduce((sum, n) => sum + (n > 0n ? 1n : 0n), 0n),
      raiseProgress: ['graduated', 'poolBuy', 'poolSellBurn'].includes(stage) ? null : { raisedP: state.raised, raiseP: data.wiring.raise, progressBps: state.raised * 10000n / data.wiring.raise },
      volume24hP: volume, tradeCount: count, hourlyCandles: [...candles.values()] };
  }
  fixtures[testName.includes('Six') ? 'sixDecimals' : 'native'] = { ...data, expected };
}
if (Object.keys(fixtures).length !== 2) throw new Error('expected both price coins');
const json = JSON.stringify(fixtures, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n';
const target = new URL('./recorded.json', import.meta.url);
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== json) throw new Error('recorded fixture drift');
} else writeFileSync(target, json);
