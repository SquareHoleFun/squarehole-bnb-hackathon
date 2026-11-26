/**
 * Wires the pieces into one service: store, chain reader, head feed, pipeline (the indexer role) and gateway (the
 * gateway role). `SH_ROLE=all` runs both in one process (the PoC default); on a droplet one indexer and two gateway
 * processes share Redis. Logs are one JSON line each on stdout (no console.log: repo lint rule).
 */
import { RpcChainReader, type ChainReader } from './chain-reader';
import type { ServiceConfig } from './config';
import { Gateway } from './gateway/server';
import { HeadFeed } from './heads';
import { PoolIndexer } from './pipeline';
import { MemoryStore } from './store/memory-store';
import { RedisStore } from './store/redis-store';
import type { HotStore } from './store/types';

export interface RunningService {
  readonly store: HotStore;
  readonly indexer: PoolIndexer | null;
  readonly gateway: Gateway | null;
  readonly feed: HeadFeed | null;
  stop(): Promise<void>;
}

export function logLine(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...fields }, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}\n`);
}

export function createStore(config: ServiceConfig): HotStore {
  return config.store === 'redis' ? new RedisStore({ url: config.redisUrl, chainId: config.target.chainId, poolId: config.target.poolId, namespace: config.redisNamespace }) : new MemoryStore();
}

export interface StartOptions {
  readonly reader?: ChainReader;
  readonly store?: HotStore;
}

export async function startService(config: ServiceConfig, options: StartOptions = {}): Promise<RunningService> {
  const store = options.store ?? createStore(config);
  if (config.role === 'gateway' && store.kind === 'memory') throw new Error('a gateway-only process needs the Redis store');
  const timers: ReturnType<typeof setInterval>[] = [];
  let indexer: PoolIndexer | null = null;
  let feed: HeadFeed | null = null;
  let gateway: Gateway | null = null;

  if (config.role !== 'gateway') {
    const reader = options.reader ?? new RpcChainReader({ urls: config.httpUrls, target: config.target });
    indexer = new PoolIndexer({ reader, store, target: config.target, confirmations: config.confirmations });
    const running = indexer;
    feed = new HeadFeed({
      wsUrls: config.wsUrls,
      reader,
      pollMs: config.pollMs,
      silenceMs: config.wsSilenceMs,
      onHead: (header, source, seenAtMs) => running.onHead(header, source, seenAtMs),
      onStatus: (status) => logLine('feed', { ...status }),
    });
    // The heartbeat says more than "the process runs": the head viewers last got and when, whether the state matched
    // the chain, and whether a catch-up is in progress. The gateways judge freshness by it (server.ts, status).
    const beat = async (): Promise<void> => {
      const info = { ...running.heartbeatInfo(), atMs: Date.now(), feed: feed?.status().mode ?? null };
      await store.heartbeat(JSON.stringify(info)).catch((error: unknown) => console.warn(`[service] heartbeat failed: ${String(error)}`));
    };
    await beat();
    timers.push(setInterval(() => void beat(), 10_000));
    await indexer.start();
    logLine('indexer_started', { head: indexer.head()?.number, verified: indexer.metrics.verified, store: store.kind });
    feed.start();
    await beat();
    await running.refreshFinality().catch(() => undefined);
    timers.push(setInterval(() => void running.refreshFinality().catch((error: unknown) => console.warn(`[service] finality: ${String(error)}`)), 60_000));
    timers.push(setInterval(() => logLine('metrics', { ...running.metrics, head: running.head()?.number, feed: feed?.status() }), 60_000));
  }

  if (config.role !== 'indexer') {
    gateway = new Gateway({
      store,
      target: config.target,
      port: config.port,
      host: config.host,
      maxClients: config.maxClients,
      maxStreamsPerIp: config.maxStreamsPerIp,
      trustedProxies: config.trustedProxies,
      exposeDebug: config.publicDebug,
    });
    await gateway.start();
    logLine('gateway_listening', { host: config.host, port: config.port });
  }

  return {
    store,
    indexer,
    gateway,
    feed,
    async stop() {
      for (const timer of timers) clearInterval(timer);
      feed?.stop();
      indexer?.stop();
      await gateway?.stop();
      await store.close();
    },
  };
}
