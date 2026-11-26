import { parseAbi } from 'viem';
/**
 * Records two volatile mainnet price histories for the poke count (ticket M1-51: "the poke job's count per box per day
 * on two volatile fork histories is reported"). A public node keeps no archive, so each history is read from the
 * pool's own v3 oracle at one pinned block: `observe` at 12-second steps over 24 hours gives the tick each block saw (a
 * v3 tick holds between trades). Where a pool's buffer covers weeks (`searchDays`), the day with the widest hourly
 * range in it is taken, so a calm day does not stand for a volatile token. Gentle: about 10 calls a pool, a second
 * apart. Writes
 * test/fixtures/poke-history.json; run by hand (`pnpm --filter @squarehole/keeper poke-history`), never in tests.
 */
import { writeFileSync } from 'node:fs';
import { createPublicClient, http, type Address } from 'viem';
import { mainnet } from 'viem/chains';
const v3PoolAbi = parseAbi(['function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)']);

const RPC = 'https://ethereum-rpc.publicnode.com';
const POOLS: readonly { name: string; pool: Address; fee: number; searchDays: number }[] = [
  { name: 'PEPE/WETH 0.3% (Uniswap v3, mainnet)', pool: '0x11950d141EcB863F01007AdD7D1A342041227b58', fee: 3_000, searchDays: 1 },
  { name: 'MOG/WETH 1% (Uniswap v3, mainnet)', pool: '0x7832310Cd0de39c4cE0A635F34d9a4B5b47fd434', fee: 10_000, searchDays: 40 },
];
const STEP = 12;
const SPAN = 86_400;
const BATCH = 901;

const client = createPublicClient({ chain: mainnet, transport: http(RPC, { retryCount: 2 }) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Mean ticks between consecutive `secondsAgos` (ascending in time), floored as Uniswap's library does. */
function means(cumulatives: readonly bigint[], step: number): number[] {
  const out: number[] = [];
  for (const [i, c] of cumulatives.entries()) {
    const prev = cumulatives[i - 1];
    if (prev === undefined) continue;
    const d = c - prev;
    const q = d / BigInt(step);
    out.push(Number(d < 0n && d % BigInt(step) !== 0n ? q - 1n : q));
  }
  return out;
}

/** The seconds-ago of the end of the day with the widest hourly tick range in the last `days` days. */
async function widestDay(pool: Address, days: number, blockNumber: bigint): Promise<number> {
  if (days <= 1) return 0;
  const agos = Array.from({ length: days * 24 + 1 }, (_, i) => (days * 24 - i) * 3_600);
  const cumulatives: bigint[] = [];
  for (let i = 0; i < agos.length - 1; i += BATCH - 1) {
    const [ticks] = await client.readContract({ address: pool, abi: v3PoolAbi, functionName: 'observe', args: [agos.slice(i, i + BATCH)], blockNumber });
    cumulatives.push(...(i === 0 ? ticks : ticks.slice(1)));
    await sleep(1_000);
  }
  const hourly = means(cumulatives, 3_600);
  let best = 0;
  let bestRange = -1;
  for (let d = 0; d < days; d++) {
    const day = hourly.slice(d * 24, d * 24 + 24);
    const range = Math.max(...day) - Math.min(...day);
    if (range > bestRange) [best, bestRange] = [d, range];
  }
  return (days - 1 - best) * 86_400;
}

async function history(pool: Address, endAgo: number, blockNumber: bigint): Promise<number[]> {
  const agos = Array.from({ length: SPAN / STEP + 1 }, (_, i) => endAgo + SPAN - i * STEP);
  const cumulatives: bigint[] = [];
  for (let i = 0; i < agos.length - 1; i += BATCH - 1) {
    const part = agos.slice(i, i + BATCH);
    const [ticks] = await client.readContract({ address: pool, abi: v3PoolAbi, functionName: 'observe', args: [part], blockNumber });
    cumulatives.push(...(i === 0 ? ticks : ticks.slice(1)));
    await sleep(1_000);
  }
  return means(cumulatives, STEP);
}

const block = await client.getBlock({ blockTag: 'latest' });
const histories = [];
for (const p of POOLS) {
  const endAgo = await widestDay(p.pool, p.searchDays, block.number);
  histories.push({ ...p, endSecondsAgo: endAgo, intervalSeconds: STEP, ticks: await history(p.pool, endAgo, block.number) });
}
const file = new URL('../test/fixtures/poke-history.json', import.meta.url);
writeFileSync(file, `${JSON.stringify({ source: RPC, block: Number(block.number), timestamp: Number(block.timestamp), spanSeconds: SPAN, histories })}\n`);
console.warn(`wrote ${histories.length} histories at block ${block.number}`);
