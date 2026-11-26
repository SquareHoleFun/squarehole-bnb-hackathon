/**
 * The hot store: what the indexer writes once per block and the gateways read. Two implementations behind this one
 * interface: Redis (`redis-store.ts`, the deployment) and memory (`memory-store.ts`, tests and a single process
 * without Redis). Everything in it can be rebuilt from the chain.
 *
 * Contract (the shared suite in `store.contract.ts` runs against both):
 * - `commitBlock`, `rollback` and `publishUpdate` are atomic: a reader never sees a snapshot of one block with the
 *   trades of another, and the frame is appended to the stream in the same step (Redis MULTI/EXEC).
 * - A QUIET commit or rollback (`snapshot` and `message` null) writes the data but leaves the served snapshot and the
 *   stream alone: a backfill, rebuild or repair is written block by block and announced once, at the end, by
 *   `publishUpdate` with a `resync` frame.
 * - Frames go to a capped stream (the last `FRAMES_KEPT`), not fire-and-forget pub/sub: a gateway that reconnects
 *   reads on from where it was, and one that starts seeds its replay buffer from `recentFrames`.
 * - Blocks and states keep the last `BLOCKS_KEPT` numbers; trades the last `TRADES_KEPT`; activity the last
 *   `ACTIVITY_KEPT`; tx senders expire after `TX_SENDER_TTL_S`; the indexer's heartbeat after `ALIVE_TTL_S`.
 * - `rollback(toBlock)` removes every block, state, trade and activity row above `toBlock`.
 */
import type { Address, Hex } from 'viem';

export const BLOCKS_KEPT = 128;
export const TRADES_KEPT = 5_000;
export const ACTIVITY_KEPT = 1_000;
export const TX_SENDER_TTL_S = 86_400;
export const ALIVE_TTL_S = 30;
/** Frames kept in the stream: the gateways' replay buffer (64) with room for a slow reconnect. */
export const FRAMES_KEPT = 256;

export interface StoredBlock {
  readonly number: bigint;
  readonly hash: Hex;
  readonly parentHash: Hex;
  readonly timestamp: bigint;
  /**
   * Log indexes of the events the state took from this block (events.ts `isStateRelevant`). The audit compares them
   * with a range re-read; kept in the store so a restart does not mistake "not loaded" for "never applied".
   */
  readonly logIndexes?: readonly number[];
}

export interface ScoredJson {
  readonly score: number;
  readonly json: string;
}

export interface SnapshotRecord {
  readonly json: string;
  readonly etag: string;
}

export interface BlockCommit {
  readonly block: StoredBlock;
  readonly stateJson: string;
  readonly trades: readonly ScoredJson[];
  readonly activity: readonly ScoredJson[];
  /** The served snapshot after this block; null in a quiet commit (the previous one stays served). */
  readonly snapshot: SnapshotRecord | null;
  /** The frame (frame.ts) appended in the same transaction; null in a quiet commit. */
  readonly message: string | null;
  readonly txSenders: readonly (readonly [Hex, Address])[];
}

export interface RollbackCommit {
  readonly toBlock: bigint;
  /** Null in a quiet rollback (a repair or rebuild that announces itself once, at the end). */
  readonly snapshot: SnapshotRecord | null;
  readonly message: string | null;
}

export interface UpdateCommit {
  readonly snapshot: SnapshotRecord;
  readonly message: string;
  /** Trade rows to replace at their scores (a trader resolved after the block went out). */
  readonly trades?: readonly ScoredJson[];
}

export interface RecentData {
  /** Oldest first. */
  readonly blocks: readonly StoredBlock[];
  /** Oldest first. */
  readonly states: readonly { readonly block: bigint; readonly json: string }[];
  /** Oldest first. */
  readonly trades: readonly string[];
  /** Oldest first. */
  readonly activity: readonly string[];
}

export interface FinalityRecord {
  readonly safe: bigint | null;
  readonly finalized: bigint | null;
}

export interface RecentFrames {
  /** Oldest first. */
  readonly frames: readonly string[];
  /** Where `subscribe` continues from so that nothing between the two calls is lost. */
  readonly cursor: string;
}

export interface ClearOptions {
  /** Keep serving the last snapshot while a rebuild runs (it is replaced by the rebuild's `resync`). */
  readonly keepSnapshot?: boolean;
  /**
   * Also drop the frame stream (tests, a fresh environment). A rebuild keeps it: the gateways' replay and the
   * indexer's frame sequence continue across it.
   */
  readonly frames?: boolean;
}

export interface HotStore {
  readonly kind: 'redis' | 'memory';
  loadRecent(limits: { readonly trades: number; readonly activity: number }): Promise<RecentData>;
  commitBlock(commit: BlockCommit): Promise<void>;
  rollback(commit: RollbackCommit): Promise<void>;
  publishUpdate(commit: UpdateCommit): Promise<void>;
  getSnapshot(): Promise<SnapshotRecord | null>;
  /** Newest first; `beforeScore` exclusive (null: from the newest). */
  tradesPage(beforeScore: number | null, limit: number): Promise<string[]>;
  txSender(hash: Hex): Promise<Address | null>;
  setFinality(finality: FinalityRecord, message: string): Promise<void>;
  getFinality(): Promise<FinalityRecord>;
  /** Appends one frame to the stream. */
  publish(message: string): Promise<void>;
  heartbeat(info: string): Promise<void>;
  /** The indexer's last heartbeat payload, or null once it expired (`ALIVE_TTL_S`). */
  lastHeartbeat(): Promise<string | null>;
  /** The newest `count` frames of the stream and the cursor to follow it from. */
  recentFrames(count: number): Promise<RecentFrames>;
  /** Follows the stream from `cursor` (from now when omitted), in order, without gaps while the stream holds them. */
  subscribe(onMessage: (message: string) => void, cursor?: string): Promise<() => Promise<void>>;
  /** Removes this pool's head, blocks, states, trades, activity and heartbeat (snapshot and frames as asked). */
  clear(options?: ClearOptions): Promise<void>;
  close(): Promise<void>;
}

export function encodeStoredBlock(block: StoredBlock): string {
  const base = `${block.number}:${block.hash}:${block.parentHash}:${block.timestamp}`;
  return block.logIndexes && block.logIndexes.length > 0 ? `${base}:${block.logIndexes.join(',')}` : base;
}

export function decodeStoredBlock(member: string): StoredBlock {
  const [number, hash, parentHash, timestamp, indexes] = member.split(':');
  if (!number || !hash || !parentHash || !timestamp) throw new Error(`bad stored block ${member}`);
  const block = { number: BigInt(number), hash: hash as Hex, parentHash: parentHash as Hex, timestamp: BigInt(timestamp) };
  if (!indexes) return block;
  const logIndexes = indexes.split(',').map((text) => {
    if (!/^\d{1,5}$/.test(text)) throw new Error(`bad log index in stored block ${member}`);
    return Number(text);
  });
  return { ...block, logIndexes };
}

/**
 * Key names under one prefix (`sh:v1:{chainId}:`, or `sh:v1:{namespace}:{chainId}:`), shared by the Redis store and the
 * design doc. Everything the indexer writes per pool sits under `pool:{poolId}:`, so two pool indexers on one chain
 * never share a window, a heartbeat or a stream, and one pool's rebuild clears only its own keys. Tx senders are
 * chain-level facts (a transaction's `from` never changes, not even across a reorg), shared and never cleared.
 * The namespace separates environments on one Redis (the PoC's tests once fed test frames to the live gateway).
 */
export function storeKeys(chainId: number, poolId: Hex, namespace = ''): {
  readonly head: string;
  readonly blocks: string;
  readonly alive: string;
  readonly states: string;
  readonly snapshot: string;
  readonly trades: string;
  readonly activity: string;
  readonly frames: string;
  readonly poolKeys: readonly string[];
  txSender(hash: Hex): string;
} {
  if (namespace && !/^[a-z0-9-]{1,32}$/.test(namespace)) throw new Error('namespace: 1-32 of a-z, 0-9, -');
  const prefix = namespace ? `sh:v1:${namespace}:${chainId}:` : `sh:v1:${chainId}:`;
  const pool = `${prefix}pool:${poolId.toLowerCase()}:`;
  const keys = {
    head: `${pool}head`,
    blocks: `${pool}blocks`,
    alive: `${pool}indexer:alive`,
    states: `${pool}states`,
    snapshot: `${pool}snapshot`,
    trades: `${pool}trades`,
    activity: `${pool}activity`,
    frames: `${pool}frames`,
  };
  return { ...keys, poolKeys: Object.values(keys), txSender: (hash: Hex) => `${prefix}tx:${hash.toLowerCase()}:from` };
}
