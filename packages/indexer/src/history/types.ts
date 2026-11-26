/**
 * Full history kept for good (S10a § 4; F50; BC-078): every trade, vault action, batch, graduation and transfer of every
 * shown box since its creation block, written two blocks deep, never expiring. Two implementations behind this one
 * interface, run through one contract test (test/history.contract.ts): Postgres (pg-history.ts, the deployment) and
 * memory (memory-history.ts). Tables (chain-data-platform § 2.5, keyed for versions by registry and box id):
 * chain_blocks, boxes, trades, activity, batches, depth_events, transfers, balances, items, candles, writer_cursor.
 *
 * - `writeBlock` is idempotent: a block already written with the same hash is skipped whole (balances move by delta,
 *   so nothing is applied twice); one written with another hash is first undone (a reorg the writer was told late).
 * - `undoAbove(chain, n)` removes every row above block n: balances by the deltas of the removed transfers, each item's
 *   owner back to the removed transfer's sender, candles recomputed from the trades left.
 * - SH-NO-PICTURE-GATE upgrade (writer.ts, fix round 2): a box an older indexer stored as not shown only because its
 *   pictures were not available (`pictureHidden`) is deleted whole with a replay marker (`startReplay`, one
 *   transaction), replayed from its creation block by the cold start's catch-up (`writeBlock`'s `fill`), and its marker
 *   removed at the end (`finishReplay`). An interrupted delete or replay repeats from the start.
 * - `dump` lists every table's rows in a fixed order, for the wipe-and-rebuild comparison.
 */
import type { CandleInterval, Candle } from '../core/core-gateway';
import type { CoreBlockResult } from '../core/chain-indexer';
import type { ActivityPage } from '../core/core-gateway';

export interface HistoryActivityOptions {
  readonly kind: string | null;
  readonly before: string | null;
  readonly limit: number;
  /** Internal v2 context: exclude these contracts (including the PoolManager) when filling legacy null traders. */
  readonly v2Contracts?: readonly string[];
}

export interface HistoryDump {
  readonly chainBlocks: readonly string[];
  readonly boxes: readonly string[];
  readonly trades: readonly string[];
  readonly activity: readonly string[];
  readonly batches: readonly string[];
  readonly depthEvents: readonly string[];
  readonly transfers: readonly string[];
  readonly balances: readonly string[];
  readonly items: readonly string[];
  readonly candles: readonly string[];
}

/** The reason prefix the removed picture check stored (SH-NO-PICTURE-GATE): "art not available: logo missing (bafk…)". */
export const PICTURE_HIDDEN_PREFIX = 'art not available:';

/** A box to replay: stored as not shown only for the removed picture check (reason PICTURE_HIDDEN_PREFIX…), or marked. */
export interface PictureHiddenBox {
  readonly chainId: number;
  /** Lower-case, as stored. */
  readonly registry: string;
  /** Decimal, as stored. */
  readonly boxId: string;
  /** Lower-case: every row of the box is keyed by it. */
  readonly token: string;
}

export interface HistoryStore {
  readonly kind: 'memory' | 'postgres';
  /** Process-local generation, advanced only after a committed write transaction. */
  readonly version: bigint;
  init(): Promise<void>;
  /**
   * `fill`: tokens being replayed (`startReplay` deleted all their rows). In a block already written (the same hash)
   * their box records and item rows go in, as a block not yet written would take them; the block, every other box's
   * rows and the cursor stay as they are. A block not yet written is written whole either way.
   */
  writeBlock(result: CoreBlockResult, fill?: ReadonlySet<string>): Promise<void>;
  /**
   * The boxes to replay, on every chain: stored as not shown only for the removed picture check, or with a replay
   * marker left by an interrupted replay (their record may be gone or written again by then).
   */
  pictureHidden(): Promise<readonly PictureHiddenBox[]>;
  /**
   * One transaction: a replay marker for each box, then every stored row of each box deleted (its record, trades,
   * activity, batches, depth events, transfers, balances, item and ticket owners, candles). Other boxes are untouched.
   * Returns the newest block held on the chain: the replay ends once a block at or above it is written.
   */
  startReplay(chainId: number, boxes: readonly PictureHiddenBox[]): Promise<bigint>;
  /** The replay markers of these boxes removed (the replay reached `startReplay`'s block). */
  finishReplay(chainId: number, boxes: readonly PictureHiddenBox[]): Promise<void>;
  undoAbove(chainId: number, block: bigint): Promise<void>;
  wipe(chainId: number): Promise<void>;
  /** The newest block written (number and hash), or null. */
  cursor(chainId: number): Promise<{ readonly block: bigint; readonly hash: string } | null>;
  activityPage(chainId: number, token: string, options: HistoryActivityOptions): Promise<ActivityPage['items']>;
  candles(chainId: number, token: string, interval: CandleInterval, limit?: number): Promise<readonly Candle[]>;
  dump(chainId: number): Promise<HistoryDump>;
  close(): Promise<void>;
}

/** Row keys and JSON forms shared by both stores, so a dump compares row for row across them. */
export const BATCH_KEYS = ['q', 't', 'qToReserve', 'tip', 'qReward', 'qFit', 'qDepth', 'qPlatform', 'tReward', 'tFit', 'tDepth', 'tBurned'] as const;
export const DEPTH_KINDS = new Set(['deepened', 'deepen_skipped', 'depth_converted', 'depth_held', 'depth_funded', 'depth_gifted', 'settled']);
