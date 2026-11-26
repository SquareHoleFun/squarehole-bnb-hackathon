/**
 * SSE fan-out load test: opens N local connections to a running gateway, then measures, per event, the delay from
 * the gateway's write (`: gw <ms>` stamp) to each client's receipt, the spread across clients, and the gateway's
 * own fan-out time and memory (/metrics, which answers direct local requests only). Events come either from the live
 * indexer (one per Sepolia block) or, with `--synthetic <n>`, from frames this script appends to the store's Redis
 * stream, each the size of a real block event. Local only (loopback, no TLS): an upper bound on what one core can do.
 *
 * Synthetic frames are not real block events, so they must never reach real viewers: synthetic mode requires its own
 * `--namespace` (and refuses the default one), and the gateway under test runs with the same `SH_REDIS_NAMESPACE`
 * (e.g. `SH_ROLE=gateway SH_REDIS_NAMESPACE=load-test SH_INDEXER_PORT=5397`).
 *
 * Each connection sends its own CF-Connecting-IP (198.18.0.0/15, the benchmarking range), as viewers behind the local
 * proxy would, so the gateway's per-address cap applies per simulated viewer (`--one-ip` sends none).
 *
 *   ulimit -n 20000; pnpm --filter @squarehole/indexer measure:fanout -- --clients 2000 --events 5 --out …
 *   ulimit -n 20000; pnpm --filter @squarehole/indexer measure:fanout -- --origin http://127.0.0.1:5397 \
 *     --namespace load-test --clients 2000 --synthetic 20 --interval 500 --out …
 */
import { writeFileSync } from 'node:fs';
import { Agent } from 'node:http';
import { poolTargetFromEnv } from '../src/config';
import { encodeFrame, eventId } from '../src/frame';
import { RedisStore } from '../src/store/redis-store';
import { openSse, type SseConnection } from '../test/sse-client';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const origin = arg('origin', 'http://127.0.0.1:5393');
// The pool of the service under test (`SH_POOL_TARGET`, default `sepolia-full`).
const TARGET = poolTargetFromEnv();
const base = `${origin}/v1/pools/${TARGET.chainId}/${TARGET.poolId}`;
const clients = Number(arg('clients', '2000'));
const events = Number(arg('events', '5'));
const synthetic = Number(arg('synthetic', '0'));
const intervalMs = Number(arg('interval', '500'));
const redisUrl = arg('redis', 'redis://127.0.0.1:5395/0');
const namespace = arg('namespace', '');
const oneIp = process.argv.includes('--one-ip');
const out = arg('out', '');

if (synthetic > 0 && !/^[a-z0-9-]{1,32}$/.test(namespace)) {
  process.stderr.write('synthetic mode needs --namespace <name> (not the live one); run the gateway under test with SH_REDIS_NAMESPACE=<name>\n');
  process.exit(2);
}

/** A distinct address per simulated viewer in 198.18.0.0/15 (RFC 2544 benchmarking). */
const viewerIp = (i: number): string => `198.${18 + ((i >> 16) & 1)}.${(i >> 8) & 255}.${i & 255}`;

interface Metrics { clients: number; rssBytes: number; heapUsedBytes: number; lastFanoutMs: number; maxFanoutMs: number; lastFanoutClients: number; eventsBroadcast: number; droppedSlowClients: number; droppedStalledClients: number; refusedPerIp: number; refusedFull: number; lastSeq: number | null }
const metrics = async (): Promise<Metrics> => (await (await fetch(`${origin}/metrics`)).json()) as Metrics;

const before = await metrics();
const agent = new Agent({ keepAlive: true, maxSockets: Number.POSITIVE_INFINITY });
const perEvent = new Map<string, number[]>();
const connections: SseConnection[] = [];
const connectStarted = performance.now();
const connectTimes: number[] = [];
let failed = 0;

for (let i = 0; i < clients; i += 100) {
  const batch: Promise<void>[] = [];
  for (let j = i; j < Math.min(clients, i + 100); j += 1) {
    const started = performance.now();
    const connection = openSse(`${base}/stream?snapshot=0`, {
      agent,
      ...(oneIp ? {} : { headers: { 'CF-Connecting-IP': viewerIp(j) } }),
      keep: false,
      onMessage: (m) => {
        if (m.event !== 'block' || m.gwAtMs === null || !m.id) return;
        const list = perEvent.get(m.id) ?? [];
        list.push(m.receivedAtMs - m.gwAtMs);
        perEvent.set(m.id, list);
      },
    });
    connections.push(connection);
    batch.push(connection.status.then((status) => {
      if (status === 200) connectTimes.push(performance.now() - started);
      else failed += 1;
    }));
  }
  await Promise.all(batch);
}
const connectMs = performance.now() - connectStarted;
await new Promise((resolve) => setTimeout(resolve, 500));
const connected = await metrics();
process.stdout.write(`connected ${connectTimes.length}/${clients} in ${Math.round(connectMs)} ms (failed ${failed}); gateway clients ${connected.clients}, rss ${(connected.rssBytes / 1e6).toFixed(1)} MB\n`);

const fanouts: number[] = [];
const eventBytes: number[] = [];
if (synthetic > 0) {
  // A realistic payload: the gateway's current snapshot is bigger than a block event; use a block-sized slice of it.
  const snapshot = await (await fetch(`${base}/snapshot`).then((r) => (r.ok ? r : null)).catch(() => null))?.text() ?? '{"padding":"' + 'x'.repeat(4_000) + '"}';
  const store = new RedisStore({ url: redisUrl, chainId: TARGET.chainId, poolId: TARGET.poolId, namespace });
  // Continue the gateway's sequence (a jump would make it resync every client, which is not what is measured here).
  let seq = (await metrics()).lastSeq ?? Date.now();
  for (let i = 0; i < synthetic; i += 1) {
    seq += 1;
    const id = eventId(seq, 9_000_000n + BigInt(i), `0x${'5e'.repeat(32)}`);
    const event = JSON.stringify({ id, synthetic: true, padding: snapshot.slice(0, 1_800) });
    eventBytes.push(event.length);
    await store.publish(encodeFrame({ type: 'block', id, etag: '', event, snapshot: null }));
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    fanouts.push((await metrics()).lastFanoutMs);
  }
  await store.close();
} else {
  const seen = new Set<string>();
  while (seen.size < events) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    for (const [id, list] of perEvent) {
      if (!seen.has(id) && list.length >= Math.min(clients, connectTimes.length)) {
        seen.add(id);
        fanouts.push((await metrics()).lastFanoutMs);
        process.stdout.write(`event ${id}: ${list.length} clients\n`);
      }
    }
  }
}
await new Promise((resolve) => setTimeout(resolve, 1_000));
const after = await metrics();
for (const connection of connections) connection.close();
agent.destroy();

function stats(values: readonly number[]): { n: number; min: number; p50: number; p99: number; max: number } | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
  return { n: sorted.length, min: sorted[0] ?? Number.NaN, p50: at(0.5), p99: at(0.99), max: sorted.at(-1) ?? Number.NaN };
}

const all = [...perEvent.values()].flat();
const summary = {
  clients,
  connected: connectTimes.length,
  failed,
  connectTotalMs: Math.round(connectMs),
  connectEachMs: stats(connectTimes.map((t) => Math.round(t))),
  eventsMeasured: perEvent.size,
  deliveriesPerEvent: [...perEvent.values()].map((l) => l.length),
  gwToClientMs: stats(all),
  maxPerEventMs: stats([...perEvent.values()].map((l) => Math.max(...l))),
  gatewayFanoutMs: stats(fanouts),
  eventBytes: stats(eventBytes),
  gatewayRssMb: { before: +(before.rssBytes / 1e6).toFixed(1), connected: +(connected.rssBytes / 1e6).toFixed(1), after: +(after.rssBytes / 1e6).toFixed(1) },
  rssPerClientKb: +(((connected.rssBytes - before.rssBytes) / Math.max(1, connectTimes.length)) / 1e3).toFixed(1),
  droppedSlowClients: after.droppedSlowClients - before.droppedSlowClients,
  droppedStalledClients: after.droppedStalledClients - before.droppedStalledClients,
  refusedPerIp: after.refusedPerIp - before.refusedPerIp,
  refusedFull: after.refusedFull - before.refusedFull,
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (out) writeFileSync(out, `${JSON.stringify({ measuredAt: new Date().toISOString(), origin, mode: synthetic > 0 ? 'synthetic' : 'live', namespace: namespace || null, summary }, null, 2)}\n`);
process.exit(0);
