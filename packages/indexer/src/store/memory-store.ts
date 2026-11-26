/**
 * In-memory hot store: the same contract as the Redis store, for tests and for a single process run without Redis
 * (`SH_STORE=memory`). Nothing survives a restart; the frame stream is an in-process ring of `FRAMES_KEPT` frames that
 * subscribers read in order from a cursor, as XREAD does.
 */
import { EventEmitter } from 'node:events';
import type { Address, Hex } from 'viem';
import { firstScoreOf } from '../model';
import {
  ACTIVITY_KEPT,
  ALIVE_TTL_S,
  BLOCKS_KEPT,
  FRAMES_KEPT,
  TRADES_KEPT,
  TX_SENDER_TTL_S,
  type BlockCommit,
  type ClearOptions,
  type FinalityRecord,
  type HotStore,
  type RecentData,
  type RecentFrames,
  type RollbackCommit,
  type ScoredJson,
  type SnapshotRecord,
  type StoredBlock,
  type UpdateCommit,
} from './types';

function insertSorted(list: ScoredJson[], item: ScoredJson): ScoredJson[] {
  const without = list.filter((existing) => existing.score !== item.score);
  without.push(item);
  return without.sort((a, b) => a.score - b.score);
}

interface StreamEntry {
  readonly id: number;
  readonly message: string;
}

export class MemoryStore implements HotStore {
  readonly kind = 'memory' as const;
  private blocks: StoredBlock[] = [];
  private states: { block: bigint; json: string }[] = [];
  private trades: ScoredJson[] = [];
  private activity: ScoredJson[] = [];
  private snapshot: SnapshotRecord | null = null;
  private finality: FinalityRecord = { safe: null, finalized: null };
  private readonly senders = new Map<string, { from: Address; expires: number }>();
  private aliveUntil = 0;
  /** The indexer's last heartbeat payload, as Redis keeps it under indexer:alive. */
  aliveInfo: string | null = null;
  private stream: StreamEntry[] = [];
  private nextStreamId = 1;
  private readonly bus = new EventEmitter();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.bus.setMaxListeners(0);
  }

  async loadRecent(limits: { readonly trades: number; readonly activity: number }): Promise<RecentData> {
    return {
      blocks: [...this.blocks],
      states: [...this.states],
      trades: this.trades.slice(-limits.trades).map((t) => t.json),
      activity: this.activity.slice(-limits.activity).map((a) => a.json),
    };
  }

  private append(message: string): void {
    this.stream = [...this.stream, { id: this.nextStreamId, message }].slice(-FRAMES_KEPT);
    this.nextStreamId += 1;
    this.bus.emit('frame');
  }

  private replaceTrades(rows: readonly ScoredJson[]): void {
    let trades = this.trades;
    for (const trade of rows) trades = insertSorted(trades, trade);
    this.trades = trades.slice(-TRADES_KEPT);
  }

  async commitBlock(commit: BlockCommit): Promise<void> {
    const n = commit.block.number;
    const floor = n - BigInt(BLOCKS_KEPT);
    this.blocks = [...this.blocks.filter((b) => b.number !== n && b.number > floor), commit.block].sort((a, b) => (a.number < b.number ? -1 : 1));
    this.states = [...this.states.filter((s) => s.block !== n && s.block > floor), { block: n, json: commit.stateJson }].sort((a, b) => (a.block < b.block ? -1 : 1));
    this.replaceTrades(commit.trades);
    let activity = this.activity;
    for (const row of commit.activity) activity = insertSorted(activity, row);
    this.activity = activity.slice(-ACTIVITY_KEPT);
    for (const [hash, from] of commit.txSenders) this.senders.set(hash.toLowerCase(), { from, expires: this.now() + TX_SENDER_TTL_S * 1_000 });
    if (commit.snapshot) this.snapshot = commit.snapshot;
    if (commit.message !== null) this.append(commit.message);
  }

  async rollback(commit: RollbackCommit): Promise<void> {
    const keep = (block: bigint): boolean => block <= commit.toBlock;
    const firstGone = firstScoreOf(commit.toBlock + 1n);
    this.blocks = this.blocks.filter((b) => keep(b.number));
    this.states = this.states.filter((s) => keep(s.block));
    this.trades = this.trades.filter((t) => t.score < firstGone);
    this.activity = this.activity.filter((a) => a.score < firstGone);
    if (commit.snapshot) this.snapshot = commit.snapshot;
    if (commit.message !== null) this.append(commit.message);
  }

  async publishUpdate(commit: UpdateCommit): Promise<void> {
    this.replaceTrades(commit.trades ?? []);
    this.snapshot = commit.snapshot;
    this.append(commit.message);
  }

  async getSnapshot(): Promise<SnapshotRecord | null> {
    return this.snapshot;
  }

  async tradesPage(beforeScore: number | null, limit: number): Promise<string[]> {
    const eligible = beforeScore === null ? this.trades : this.trades.filter((t) => t.score < beforeScore);
    return eligible.slice(-limit).reverse().map((t) => t.json);
  }

  async txSender(hash: Hex): Promise<Address | null> {
    const entry = this.senders.get(hash.toLowerCase());
    if (!entry || entry.expires <= this.now()) return null;
    return entry.from;
  }

  async setFinality(finality: FinalityRecord, message: string): Promise<void> {
    this.finality = finality;
    this.append(message);
  }

  async getFinality(): Promise<FinalityRecord> {
    return this.finality;
  }

  async publish(message: string): Promise<void> {
    this.append(message);
  }

  async heartbeat(info: string): Promise<void> {
    this.aliveInfo = info;
    this.aliveUntil = this.now() + ALIVE_TTL_S * 1_000;
  }

  async lastHeartbeat(): Promise<string | null> {
    return this.aliveUntil > this.now() ? this.aliveInfo : null;
  }

  async recentFrames(count: number): Promise<RecentFrames> {
    const entries = this.stream.slice(-count);
    return { frames: entries.map((e) => e.message), cursor: String(this.stream.at(-1)?.id ?? 0) };
  }

  /** Delivers every frame after `cursor` in order, synchronously on append (as XREAD would, minus the network). */
  async subscribe(onMessage: (message: string) => void, cursor?: string): Promise<() => Promise<void>> {
    let lastId = cursor === undefined ? (this.stream.at(-1)?.id ?? 0) : Number(cursor);
    const drain = (): void => {
      for (const entry of this.stream) {
        if (entry.id <= lastId) continue;
        lastId = entry.id;
        onMessage(entry.message);
      }
    };
    this.bus.on('frame', drain);
    drain();
    return async () => {
      this.bus.off('frame', drain);
    };
  }

  async clear(options: ClearOptions = {}): Promise<void> {
    this.blocks = [];
    this.states = [];
    this.trades = [];
    this.activity = [];
    if (!options.keepSnapshot) this.snapshot = null;
    this.finality = { safe: null, finalized: null };
    this.aliveUntil = 0;
    this.aliveInfo = null;
    if (options.frames) this.stream = [];
  }

  async close(): Promise<void> {
    this.bus.removeAllListeners();
  }
}
