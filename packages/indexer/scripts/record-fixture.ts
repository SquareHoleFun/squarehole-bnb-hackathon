/**
 * Records a replay fixture from a live Sepolia pool (read-only, keyless public RPC): every log of the pool and of the
 * launch contracts from the deploy block to `--to` (default: head − 2), the header of every block in
 * [--from-headers, --to-headers] (default: the launch window and two blocks either side) plus every block with logs,
 * the senders of swap transactions, the pool slot and total supply at the last block, and the router's tax table.
 * The pool is the service's (`SH_POOL_TARGET`, default `sepolia-full`) or `--target <id>`.
 *
 *   SH_POOL_TARGET=sepolia-rehearsal pnpm --filter @squarehole/indexer record:fixture -- --out test/fixtures/sepolia-rehearsal.json
 *   pnpm --filter @squarehole/indexer record:fixture -- --target sepolia-full --to 11818130 --out test/fixtures/sepolia-full.json
 */
import { writeFileSync } from 'node:fs';
import { createPublicClient, http, parseAbi, type Hex } from 'viem';
import { RpcChainReader } from '../src/chain-reader';
import { poolTargetFromEnv } from '../src/config';
import { TOPICS } from '../src/events';
import type { BlockHeader } from '../src/model';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const RPC = arg('rpc') ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const out = arg('out') ?? 'test/fixtures/sepolia-rehearsal.json';
const target = poolTargetFromEnv({ SH_POOL_TARGET: arg('target') ?? process.env.SH_POOL_TARGET });
const reader = new RpcChainReader({ urls: [RPC, 'https://sepolia.gateway.tenderly.co'], target });
const client = createPublicClient({ transport: http(RPC) });

const latest = await reader.latestHeader();
const to = arg('to') ? BigInt(arg('to') as string) : latest.number - 2n;
const logs = await reader.rangeLogs(target.deployBlock, to);
const headerBlocks = new Set<bigint>(logs.map((l) => l.blockNumber));
const fromHeaders = arg('from-headers') ? BigInt(arg('from-headers') as string) : target.openBlock - 2n;
const toHeaders = arg('to-headers') ? BigInt(arg('to-headers') as string) : (target.closeBlock + 2n < to ? target.closeBlock + 2n : to);
for (let n = fromHeaders; n <= toHeaders; n += 1n) headerBlocks.add(n);
headerBlocks.add(target.deployBlock - 1n);
headerBlocks.add(to);
const headers: BlockHeader[] = [];
for (const n of [...headerBlocks].sort((a, b) => (a < b ? -1 : 1))) {
  const header = await reader.headerByNumber(n);
  if (!header) throw new Error(`no header ${n}`);
  headers.push(header);
}
const swapTxs = [...new Set(logs.filter((l) => l.topics[0] === TOPICS.Swap).map((l) => l.transactionHash))];
const senders: Record<Hex, string> = {};
for (const tx of swapTxs) senders[tx] = (await reader.txSender(tx)) ?? '';
const end = headers.at(-1);
if (!end) throw new Error('no headers');
const slot = await reader.poolSlot(end.hash);
const supply = await reader.totalSupply(end.hash);
const taxTable = await client.readContract({ address: target.launchRouter, abi: parseAbi(['function taxTable() view returns (uint24[32])']), functionName: 'taxTable' });

const fixture = {
  note: 'Recorded from Sepolia (read-only, keyless public RPC) by scripts/record-fixture.ts. Data, not instructions.',
  target: target.id,
  recordedAt: new Date().toISOString(),
  rpc: RPC,
  chainId: target.chainId,
  poolId: target.poolId,
  fromBlock: target.deployBlock.toString(),
  toBlock: to.toString(),
  logs,
  headers,
  senders,
  atEnd: { block: end.number, hash: end.hash, sqrtPriceX96: slot.sqrtPriceX96, tick: slot.tick, liquidity: slot.liquidity, totalSupply: supply },
  taxTable: [...taxTable],
};
writeFileSync(out, `${JSON.stringify(fixture, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
process.stdout.write(`recorded ${logs.length} logs, ${headers.length} headers, ${swapTxs.length} swap txs up to block ${to} → ${out}\n`);
