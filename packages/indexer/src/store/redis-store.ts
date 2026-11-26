/**
 * Redis hot store (ioredis). Keys under `sh:v1:{chainId}:pool:{poolId}:` (storeKeys); one MULTI/EXEC per block, with
 * the frame appended to a capped Redis Stream inside it, so a gateway never hears of a block before its snapshot is
 * readable and a reader never sees two blocks mixed. The stream replaces pub/sub: a gateway reads it with XREAD BLOCK
 * from the last id it saw, so frames written while it reconnects are read afterwards instead of lost.
 *
 * Suggested server settings (docker run in the design doc): appendonly yes, appendfsync everysec, maxmemory 256mb,
 * maxmemory-policy noeviction (the data is small and bounded; eviction would silently drop state), and a password
 * (`requirepass`, then `SH_REDIS_URL=redis://:<password>@host:port/0`): anything that can write the stream can put
 * frames in front of every viewer.
 */
import { Redis } from 'ioredis';
import type { Address, Hex } from 'viem';
import { firstScoreOf } from '../model';
import {
  ACTIVITY_KEPT,
  ALIVE_TTL_S,
  BLOCKS_KEPT,
  FRAMES_KEPT,
  TRADES_KEPT,
  TX_SENDER_TTL_S,
  decodeStoredBlock,
  encodeStoredBlock,
  storeKeys,
  type BlockCommit,
  type ClearOptions,
  type FinalityRecord,
  type HotStore,
  type RecentData,
  type RecentFrames,
  type RollbackCommit,
  type ScoredJson,
  type SnapshotRecord,
  type UpdateCommit,
} from './types';

export interface RedisStoreOptions {
  readonly url: string;
  readonly chainId: number;
  readonly poolId: Hex;
  /** Key namespace (storeKeys); empty for the default environment. */
  readonly namespace?: string;
  /** How long one XREAD waits before it is re-issued (ms); only matters for shutdown and reconnect checks. */
  readonly blockMs?: number;
}

type ChainableCommander = ReturnType<Redis['multi']>;
type StreamEntry = [id: string, fields: string[]];

const FRAME_FIELD = 'f';

function frameOf(entry: StreamEntry): string | null {
  const [, fields] = entry;
  for (let i = 0; i + 1 < fields.length; i += 2) if (fields[i] === FRAME_FIELD) return fields[i + 1] ?? null;
  return null;
}

export class RedisStore implements HotStore {
  readonly kind = 'redis' as const;
  private readonly redis: Redis;
  private readonly keys: ReturnType<typeof storeKeys>;
  private readonly url: string;
  private readonly blockMs: number;
  private readonly readers = new Set<Redis>();

  constructor(options: RedisStoreOptions) {
    this.url = options.url;
    this.blockMs = options.blockMs ?? 5_000;
    this.keys = storeKeys(options.chainId, options.poolId, options.namespace ?? '');
    this.redis = new Redis(options.url, { maxRetriesPerRequest: 3, enableReadyCheck: true, lazyConnect: false });
  }

  async ping(): Promise<string> {
    return this.redis.ping();
  }

  async loadRecent(limits: { readonly trades: number; readonly activity: number }): Promise<RecentData> {
    const k = this.keys;
    const [blocks, states, trades, activity] = await Promise.all([
      this.redis.zrange(k.blocks, '0', '-1'),
      this.redis.zrange(k.states, '0', '-1', 'WITHSCORES'),
      this.redis.zrange(k.trades, String(-limits.trades), '-1'),
      this.redis.zrange(k.activity, String(-limits.activity), '-1'),
    ]);
    const pairs: { block: bigint; json: string }[] = [];
    for (let i = 0; i + 1 < states.length; i += 2) {
      const json = states[i];
      const score = states[i + 1];
      if (json !== undefined && score !== undefined) pairs.push({ block: BigInt(score), json });
    }
    return { blocks: blocks.map(decodeStoredBlock), states: pairs, trades, activity };
  }

  private appendFrame(multi: ChainableCommander, message: string): void {
    multi.xadd(this.keys.frames, 'MAXLEN', '~', String(FRAMES_KEPT), '*', FRAME_FIELD, message);
  }

  private replaceTrades(multi: ChainableCommander, trades: readonly ScoredJson[]): void {
    for (const trade of trades) {
      multi.zremrangebyscore(this.keys.trades, trade.score, trade.score);
      multi.zadd(this.keys.trades, trade.score, trade.json);
    }
    if (trades.length > 0) multi.zremrangebyrank(this.keys.trades, 0, -(TRADES_KEPT + 1));
  }

  private static async exec(multi: ChainableCommander, what: string): Promise<void> {
    const result = await multi.exec();
    const failed = result?.find(([error]) => error);
    if (!result || failed) throw new Error(`redis ${what} failed: ${failed?.[0]?.message ?? 'aborted'}`);
  }

  async commitBlock(commit: BlockCommit): Promise<void> {
    const k = this.keys;
    const n = commit.block.number;
    const floor = n - BigInt(BLOCKS_KEPT);
    const multi = this.redis.multi();
    multi.hset(k.head, { number: n.toString(), hash: commit.block.hash, parentHash: commit.block.parentHash, ts: commit.block.timestamp.toString() });
    multi.zremrangebyscore(k.blocks, n.toString(), n.toString());
    multi.zadd(k.blocks, n.toString(), encodeStoredBlock(commit.block));
    multi.zremrangebyscore(k.blocks, '-inf', floor.toString());
    multi.zremrangebyscore(k.states, n.toString(), n.toString());
    multi.zadd(k.states, n.toString(), commit.stateJson);
    multi.zremrangebyscore(k.states, '-inf', floor.toString());
    this.replaceTrades(multi, commit.trades);
    for (const row of commit.activity) {
      multi.zremrangebyscore(k.activity, row.score, row.score);
      multi.zadd(k.activity, row.score, row.json);
    }
    if (commit.activity.length > 0) multi.zremrangebyrank(k.activity, 0, -(ACTIVITY_KEPT + 1));
    for (const [hash, from] of commit.txSenders) multi.set(k.txSender(hash), from, 'EX', TX_SENDER_TTL_S);
    if (commit.snapshot) multi.hset(k.snapshot, { json: commit.snapshot.json, etag: commit.snapshot.etag });
    if (commit.message !== null) this.appendFrame(multi, commit.message);
    await RedisStore.exec(multi, `commit of block ${n}`);
  }

  async rollback(commit: RollbackCommit): Promise<void> {
    const k = this.keys;
    const above = `(${commit.toBlock.toString()}`;
    const firstGone = firstScoreOf(commit.toBlock + 1n);
    const ancestor = await this.redis.zrangebyscore(k.blocks, commit.toBlock.toString(), commit.toBlock.toString());
    const multi = this.redis.multi();
    multi.zremrangebyscore(k.blocks, above, '+inf');
    multi.zremrangebyscore(k.states, above, '+inf');
    multi.zremrangebyscore(k.trades, firstGone, '+inf');
    multi.zremrangebyscore(k.activity, firstGone, '+inf');
    const head = ancestor[0] ? decodeStoredBlock(ancestor[0]) : null;
    if (head) multi.hset(k.head, { number: head.number.toString(), hash: head.hash, parentHash: head.parentHash, ts: head.timestamp.toString() });
    if (commit.snapshot) multi.hset(k.snapshot, { json: commit.snapshot.json, etag: commit.snapshot.etag });
    if (commit.message !== null) this.appendFrame(multi, commit.message);
    await RedisStore.exec(multi, `rollback to ${commit.toBlock}`);
  }

  async publishUpdate(commit: UpdateCommit): Promise<void> {
    const multi = this.redis.multi();
    this.replaceTrades(multi, commit.trades ?? []);
    multi.hset(this.keys.snapshot, { json: commit.snapshot.json, etag: commit.snapshot.etag });
    this.appendFrame(multi, commit.message);
    await RedisStore.exec(multi, 'update');
  }

  async getSnapshot(): Promise<SnapshotRecord | null> {
    const [json, etag] = await this.redis.hmget(this.keys.snapshot, 'json', 'etag');
    return json && etag ? { json, etag } : null;
  }

  async tradesPage(beforeScore: number | null, limit: number): Promise<string[]> {
    const max = beforeScore === null ? '+inf' : `(${beforeScore}`;
    return this.redis.zrevrangebyscore(this.keys.trades, max, '-inf', 'LIMIT', 0, limit);
  }

  async txSender(hash: Hex): Promise<Address | null> {
    return (await this.redis.get(this.keys.txSender(hash))) as Address | null;
  }

  async setFinality(finality: FinalityRecord, message: string): Promise<void> {
    const multi = this.redis.multi();
    multi.hset(this.keys.head, { safe: finality.safe?.toString() ?? '', finalized: finality.finalized?.toString() ?? '' });
    this.appendFrame(multi, message);
    await RedisStore.exec(multi, 'finality');
  }

  async getFinality(): Promise<FinalityRecord> {
    const [safe, finalized] = await this.redis.hmget(this.keys.head, 'safe', 'finalized');
    return { safe: safe ? BigInt(safe) : null, finalized: finalized ? BigInt(finalized) : null };
  }

  async publish(message: string): Promise<void> {
    await this.redis.xadd(this.keys.frames, 'MAXLEN', '~', String(FRAMES_KEPT), '*', FRAME_FIELD, message);
  }

  async heartbeat(info: string): Promise<void> {
    await this.redis.set(this.keys.alive, info, 'EX', ALIVE_TTL_S);
  }

  async lastHeartbeat(): Promise<string | null> {
    return this.redis.get(this.keys.alive);
  }

  async recentFrames(count: number): Promise<RecentFrames> {
    const entries = (await this.redis.xrevrange(this.keys.frames, '+', '-', 'COUNT', count)) as StreamEntry[];
    const frames = entries.map(frameOf).filter((frame): frame is string => frame !== null).reverse();
    return { frames, cursor: entries[0]?.[0] ?? '0-0' };
  }

  /**
   * A dedicated connection per subscriber runs XREAD BLOCK in a loop from the last id it delivered. ioredis
   * reconnects on its own (maxRetriesPerRequest null queues the read until then), and the next read continues from
   * that id, so a Redis restart or a network blip costs latency, not frames.
   */
  async subscribe(onMessage: (message: string) => void, cursor?: string): Promise<() => Promise<void>> {
    const reader = new Redis(this.url, { maxRetriesPerRequest: null });
    this.readers.add(reader);
    let lastId = cursor ?? ((await this.redis.xrevrange(this.keys.frames, '+', '-', 'COUNT', 1)) as StreamEntry[])[0]?.[0] ?? '0-0';
    let running = true;
    const loop = async (): Promise<void> => {
      while (running) {
        let reply: [key: string, items: StreamEntry[]][] | null;
        try {
          reply = (await reader.xread('BLOCK', this.blockMs, 'STREAMS', this.keys.frames, lastId)) as [string, StreamEntry[]][] | null;
        } catch (error) {
          if (!running) return;
          console.warn(`[redis] stream read failed: ${error instanceof Error ? error.message : String(error)}; retrying`);
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        for (const [, items] of reply ?? []) {
          for (const entry of items) {
            lastId = entry[0];
            const frame = frameOf(entry);
            if (frame !== null && running) onMessage(frame);
          }
        }
      }
    };
    const done = loop();
    return async () => {
      running = false;
      this.readers.delete(reader);
      reader.disconnect();
      await done;
    };
  }

  /** DEL of this pool's known keys (no KEYS scan); tx senders are chain-level facts and stay. */
  async clear(options: ClearOptions = {}): Promise<void> {
    const k = this.keys;
    const keys = k.poolKeys.filter((key) => !(options.keepSnapshot && key === k.snapshot) && (options.frames || key !== k.frames));
    await this.redis.unlink(...keys);
  }

  async close(): Promise<void> {
    for (const reader of this.readers) reader.disconnect();
    this.readers.clear();
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
