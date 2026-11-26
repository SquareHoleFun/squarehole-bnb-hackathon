/**
 * Live latency probe: block timestamp → SSE receive, per block, with the segments in between, plus a direct
 * websocket newHeads subscription to the same public RPC as the baseline ("what a browser reading the RPC itself
 * would see"). Read-only; run it next to a running service (`pnpm --filter @squarehole/indexer start`).
 *
 *   pnpm --filter @squarehole/indexer measure:latency -- --blocks 30 --out ../../docs/evidence/realtime-poc/latency-ws.json
 *
 * The pool is the service's (`SH_POOL_TARGET`, default `sepolia-full`) or `--target <id>`; `--base` overrides the URL.
 *
 * Segments (all on this machine's clock except the block timestamp, which is the slot start in whole seconds):
 *   arrival  = indexer saw the header − block timestamp
 *   process  = event built (logs fetched, state derived) − header seen
 *   publish  = gateway wrote the event (`: gw` stamp) − event built (Redis MULTI/EXEC + PUBLISH + gateway parse)
 *   deliver  = this client received it − gateway wrote it
 *   total    = received − block timestamp
 */
import { writeFileSync } from 'node:fs';
import { poolTargetFromEnv } from '../src/config';
import type { BlockEvent } from '../src/views';
import { openSse } from '../test/sse-client';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const target = poolTargetFromEnv({ SH_POOL_TARGET: arg('target', process.env.SH_POOL_TARGET ?? '') });
const base = arg('base', `http://127.0.0.1:5393/v1/pools/${target.chainId}/${target.poolId}`);
const blocks = Number(arg('blocks', '25'));
const out = arg('out', '');
const directWs = arg('ws', 'wss://ethereum-sepolia-rpc.publicnode.com');

interface Row {
  block: string;
  blockTs: number;
  source: string;
  rpcCalls: number;
  trades: number;
  seenAtMs: number;
  committedAtMs: number;
  gwAtMs: number | null;
  receivedAtMs: number;
  directWsAtMs: number | null;
}

const rows: Row[] = [];
const direct = new Map<string, number>();
const reorgs: unknown[] = [];

// Baseline: our own newHeads subscription straight to the public RPC.
const socket = new WebSocket(directWs);
socket.onopen = () => socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] }));
socket.onmessage = (message: MessageEvent) => {
  const at = Date.now();
  const parsed = JSON.parse(String(message.data)) as { params?: { result?: { number?: string } } };
  const number = parsed.params?.result?.number;
  if (number && !direct.has(BigInt(number).toString())) direct.set(BigInt(number).toString(), at);
};

const snapshotTimings: number[] = [];
for (let i = 0; i < 5; i += 1) {
  const started = performance.now();
  const res = await fetch(`${base}/snapshot`);
  await res.arrayBuffer();
  snapshotTimings.push(Math.round((performance.now() - started) * 10) / 10);
}

const done = new Promise<void>((resolve) => {
  const stream = openSse(`${base}/stream?snapshot=0`, {
    keep: false,
    onMessage: (message) => {
      if (message.event === 'reorg') reorgs.push(JSON.parse(message.data));
      if (message.event !== 'block') return;
      const event = JSON.parse(message.data) as BlockEvent;
      if (!event.head || !event.timing || event.head.source === 'backfill') return; // synthetic load-test frames carry neither
      rows.push({
        block: event.head.number,
        blockTs: Number(event.timing.blockTs),
        source: event.head.source,
        rpcCalls: event.timing.rpcCalls,
        trades: event.trades.length,
        seenAtMs: event.timing.seenAtMs,
        committedAtMs: event.timing.committedAtMs,
        gwAtMs: message.gwAtMs,
        receivedAtMs: message.receivedAtMs,
        directWsAtMs: null,
      });
      process.stdout.write(`block ${event.head.number} via ${event.head.source}: total ${message.receivedAtMs - Number(event.timing.blockTs) * 1_000} ms\n`);
      if (rows.length >= blocks) {
        stream.close();
        resolve();
      }
    },
  });
});
await done;
await new Promise((resolve) => setTimeout(resolve, 3_000)); // late direct heads
socket.close();
for (const row of rows) row.directWsAtMs = direct.get(row.block) ?? null;

function stats(values: readonly number[]): { n: number; min: number; p50: number; p90: number; max: number; mean: number } | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
  const mean = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
  return { n: sorted.length, min: sorted[0] ?? Number.NaN, p50: at(0.5), p90: at(0.9), max: sorted.at(-1) ?? Number.NaN, mean: Math.round(mean) };
}

const ms = (row: Row) => row.blockTs * 1_000;
const summary = {
  blocks: rows.length,
  firstBlock: rows[0]?.block,
  lastBlock: rows.at(-1)?.block,
  sources: rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.source]: (acc[r.source] ?? 0) + 1 }), {}),
  rpcCallsPerBlock: stats(rows.map((r) => r.rpcCalls)),
  arrivalMs: stats(rows.map((r) => r.seenAtMs - ms(r))),
  processMs: stats(rows.map((r) => r.committedAtMs - r.seenAtMs)),
  publishMs: stats(rows.filter((r) => r.gwAtMs !== null).map((r) => (r.gwAtMs ?? 0) - r.committedAtMs)),
  deliverMs: stats(rows.filter((r) => r.gwAtMs !== null).map((r) => r.receivedAtMs - (r.gwAtMs ?? 0))),
  totalMs: stats(rows.map((r) => r.receivedAtMs - ms(r))),
  directWsArrivalMs: stats(rows.filter((r) => r.directWsAtMs !== null).map((r) => (r.directWsAtMs ?? 0) - ms(r))),
  sseMinusDirectWsMs: stats(rows.filter((r) => r.directWsAtMs !== null).map((r) => r.receivedAtMs - (r.directWsAtMs ?? 0))),
  snapshotGetMs: snapshotTimings,
  reorgs: reorgs.length,
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (out) writeFileSync(out, `${JSON.stringify({ measuredAt: new Date().toISOString(), target: target.id, base, directWs, summary, rows, reorgs }, null, 2)}\n`);
process.exit(0);
