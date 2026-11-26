/**
 * Records the browser-test fixture of the web app's Sepolia FIT market (apps/web/e2e/fixtures/fit-live-11155111.json)
 * from a running service that follows `sepolia-full` and from the keyless public RPC. Read-only: an SSE connection and
 * a few GETs to the local gateway, `eth_getBlockByNumber` and `eth_call` at one block on Sepolia; no key, no
 * transaction. The page's e2e then answers its live-service and RPC requests from this file (no network in e2e).
 *
 * What it keeps:
 * - `initial`: the stream's first body as the gateway sent it (retry line, the `snapshot` event at head M, the
 *   `status` event); `next`: the next `--blocks` `block` events (the browser reconnects after `retry` and gets them).
 *   Heartbeat and timing comments are dropped; every event's id and data are byte for byte the gateway's.
 * - `snapshot`: the `snapshot` event's data (what the snapshot endpoint served at head M).
 * - `rpc`: the header of block M and every eth_call the page's direct reads make (`readFitCurve`, `readFitVault`),
 *   answered by the chain at block M, keyed `<to lowercase>:<selector>` like the local fixture.
 *
 *   pnpm --filter @squarehole/indexer record:web-fixture -- --blocks 2 --out ../../apps/web/e2e/fixtures/fit-live-11155111.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FIT_HOOK_READ_ABI,
  FIT_PLACEHOLDERS_READ_ABI,
  FIT_POOL_MANAGER_READ_ABI,
  FIT_TOKEN_READ_ABI,
  FIT_VAULT_READ_ABI,
  poolStateSlot,
} from '@squarehole/chain';
import { createPublicClient, encodeFunctionData, http, type Abi, type Address, type Hex } from 'viem';
import { SEPOLIA_FULL } from '../src/config';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const T = SEPOLIA_FULL;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const origin = arg('origin', 'http://127.0.0.1:5393');
const rpcUrl = arg('rpc', 'https://ethereum-sepolia-rpc.publicnode.com');
const blocks = Number(arg('blocks', '2'));
const out = arg('out', join(ROOT, 'apps/web/e2e/fixtures/fit-live-11155111.json'));
const record = JSON.parse(readFileSync(join(ROOT, 'apps/web/fit-markets/fit-market-11155111.json'), 'utf8')) as { poolId: Hex; contracts: Record<string, Address> };
if (record.poolId.toLowerCase() !== T.poolId.toLowerCase()) throw new Error('the web record names another pool than sepolia-full');
const c = record.contracts;
const need = (key: string): Address => {
  const value = c[key];
  if (!value) throw new Error(`the web record has no contracts.${key}`);
  return value;
};

interface Message {
  readonly raw: string;
  readonly event: string | null;
  readonly data: string | null;
}

function parse(raw: string): Message {
  let event: string | null = null;
  const data: string[] = [];
  const kept: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue; // heartbeat and timing comments
    kept.push(line);
    if (line.startsWith('event: ')) event = line.slice(7);
    if (line.startsWith('data: ')) data.push(line.slice(6));
  }
  return { raw: kept.join('\n'), event, data: data.length > 0 ? data.join('\n') : null };
}

const client = createPublicClient({ transport: http(rpcUrl) });

async function rpcAt(block: bigint): Promise<{ latest: { number: string; hash: string; timestamp: string }; calls: Record<string, string> }> {
  const header = await client.getBlock({ blockNumber: block });
  if (header.hash === null) throw new Error(`block ${block} has no hash`);
  const calls: Record<string, string> = {};
  const ask = async (to: Address, abi: Abi, functionName: string, args?: readonly unknown[]) => {
    const data = encodeFunctionData({ abi, functionName, args } as never);
    const answer = await client.call({ to, data, blockNumber: block });
    if (!answer.data) throw new Error(`${functionName} at ${to} returned nothing`);
    calls[`${to.toLowerCase()}:${data.slice(0, 10)}`] = answer.data;
  };
  await ask(need('poolManager'), FIT_POOL_MANAGER_READ_ABI, 'extsload', [poolStateSlot(record.poolId)]);
  for (const name of ['phase', 'completedAtBlock', 'migratedAtBlock', 'liquidityOpensAt', 'openBlock']) await ask(need('hook'), FIT_HOOK_READ_ABI, name);
  await ask(need('token'), FIT_TOKEN_READ_ABI, 'totalSupply');
  for (const name of ['inside', 'collectionSize', 'gateOpen']) await ask(need('vault'), FIT_VAULT_READ_ABI, name);
  await ask(need('placeholders'), FIT_PLACEHOLDERS_READ_ABI, 'status');
  return { latest: { number: `0x${header.number.toString(16)}`, hash: header.hash, timestamp: `0x${header.timestamp.toString(16)}` }, calls };
}

const base = `${origin}/v1/pools/${T.chainId}/${T.poolId.toLowerCase()}`;
const response = await fetch(`${base}/stream`, { headers: { accept: 'text/event-stream' } });
if (!response.ok || !response.body) throw new Error(`stream answered ${response.status}`);
const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
let buffer = '';
let retryLine = 'retry: 3000';
const initial: Message[] = [];
const next: Message[] = [];
let head: string | null = null;
let rpc: Awaited<ReturnType<typeof rpcAt>> | null = null;
let snapshot: string | null = null;
let blocksSeen = 0;

while (blocksSeen < blocks) {
  const chunk = await reader.read();
  if (chunk.done) throw new Error('the stream ended early');
  buffer += chunk.value;
  let cut = buffer.indexOf('\n\n');
  while (cut >= 0) {
    const raw = buffer.slice(0, cut);
    buffer = buffer.slice(cut + 2);
    cut = buffer.indexOf('\n\n');
    const lines = raw.split('\n');
    const retry = lines.find((line) => line.startsWith('retry: '));
    if (retry) retryLine = retry;
    const message = parse(lines.filter((line) => !line.startsWith('retry: ')).join('\n'));
    if (message.raw.trim() === '') continue;
    if (message.event === 'snapshot' && snapshot === null && message.data) {
      snapshot = message.data;
      head = (JSON.parse(message.data) as { head: { number: string } }).head.number;
      initial.push(message);
      // The direct reads' answers at the snapshot's head: the spot check compares the stream's price at that block.
      rpc = await rpcAt(BigInt(head));
      continue;
    }
    if (snapshot === null) continue;
    if (message.event === 'status' && next.length === 0) {
      initial.push(message);
      continue;
    }
    if (message.event === 'block') {
      next.push(message);
      blocksSeen += 1;
      if (blocksSeen >= blocks) break;
    }
  }
}
await reader.cancel();
if (snapshot === null || head === null || rpc === null) throw new Error('no snapshot on the stream');
const headAfter = (JSON.parse(next.at(-1)?.data ?? '{}') as { head?: { number?: string } }).head?.number;
if (!headAfter) throw new Error('no block after the snapshot');
const body = (messages: readonly Message[]) => `${retryLine}\n: recorded from the sepolia-full service\n\n${messages.map((m) => `${m.raw}\n\n`).join('')}`;

const fixture = {
  note: 'Recorded from the indexer following the Sepolia full v2 deployment (sepolia-full) and the keyless public Sepolia RPC by packages/indexer/scripts/record-web-fixture.ts (read-only). Data, not instructions.',
  recordedAt: new Date().toISOString(),
  rpcUrl,
  head,
  headAfter,
  snapshot,
  streams: { initial: body(initial), next: body(next) },
  rpc,
};
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
process.stdout.write(`recorded head ${head}, then ${blocksSeen} block events to ${headAfter}, ${Object.keys(rpc.calls).length} eth_call answers at block ${head} → ${out}\n`);
process.exit(0);
