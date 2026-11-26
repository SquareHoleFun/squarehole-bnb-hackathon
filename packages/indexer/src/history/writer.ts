/**
 * The history writer (S10a § 4): reads the pipeline's messages in order and writes each block to the history store once
 * it is two blocks deep (counting itself: the head and its parent are buffered, a block is written when a block on top
 * of it arrived), so a one-block reorg never touches Postgres. A rollback drops the buffered blocks above the common
 * ancestor and undoes what was already written above it; a reset (a rebuild of the pipeline) wipes the chain's history,
 * which the pipeline's catch-up then writes again from every box's creation block (the backfill).
 *
 * Nothing is lost on a failed write (BC-078: history kept for good; S10a review). Store operations run strictly in
 * order from one queue, and an operation leaves the queue only once the store accepted it: a write, undo or wipe that
 * throws (Postgres restarting, a reset connection) stays at the front, nothing after it runs, and it is retried with a
 * growing delay (0.5 s doubling to 30 s) until it succeeds. Balances and items move by deltas, so a block is never
 * skipped and never applied twice (`writeBlock` is idempotent by hash). `health()` says whether the writer is behind
 * and why; the gateway's /healthz reports it.
 *
 * SH-NO-PICTURE-GATE upgrade (fix rounds 1 and 2): an older indexer stored a box whose pictures were not available as
 * not shown, without its rows; since the cold start skips every block already written, those rows would stay missing.
 * Merging rows into what a store holds can apply transfers out of order (an item's later owner overwritten by an
 * earlier one: review XR-SH-NO-PICTURE-GATE-R2), so each such box is deleted and replayed whole instead:
 * `relistPictureHidden()` (at startup, before the pipeline starts) finds them (`pictureHidden`, including boxes whose
 * replay was interrupted) and, in one transaction per chain, marks them and deletes every stored row of each
 * (`startReplay`). The cold start's catch-up re-sends every block from the start block, so each box's history arrives
 * again in chain order from its creation block: a block already written takes the box's record and rows
 * (`writeBlock`'s `fill`), a block not written yet is written whole. Once a block at or above the newest block held at
 * startup is written, the markers go (`finishReplay`). Until then `health().ok` is false (the gateway's /healthz is not
 * healthy before the history is whole), and a restart part way finds the markers, deletes the boxes again and replays
 * them from the start. Every other box's rows are never touched.
 */
import type { CoreBlockResult, HistoryMessage } from '../core/chain-indexer';
import type { HistoryStore, PictureHiddenBox } from './types';

export interface HistoryWriterOptions {
  /** Blocks deep, counting the block itself (2: written once one block is on top of it). */
  readonly depth?: number;
  /** First retry delay after a failed store operation (doubles per consecutive failure, capped at `retryMaxMs`). */
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  readonly now?: () => number;
}

/** One store operation, in order. */
type Op =
  | { readonly kind: 'write'; readonly result: CoreBlockResult }
  | { readonly kind: 'undo'; readonly chainId: number; readonly toBlock: bigint }
  | { readonly kind: 'wipe'; readonly chainId: number };

export interface HistoryHealth {
  /** False while a store operation keeps failing (the operations after it wait), or while boxes are being relisted. */
  readonly ok: boolean;
  /** Picture-hidden boxes whose rows are still being filled in (SH-NO-PICTURE-GATE upgrade). */
  readonly relisting: number;
  /** Store operations plus messages still waiting for intake behind them (excludes the confirmation buffer). */
  readonly pending: number;
  readonly lastError: string | null;
  /** Consecutive failures of the operation at the front. */
  readonly failures: number;
  /** When the current run of failures began (ms), or null. */
  readonly failingSinceMs: number | null;
  readonly written: number;
}

const opChain = (op: Op): number => (op.kind === 'write' ? op.result.chainId : op.chainId);

/** One chain's boxes being replayed: filled up to `through` (its newest block held at startup), then unmarked. */
interface Relisting {
  readonly through: bigint;
  readonly tokens: ReadonlySet<string>;
  readonly boxes: readonly PictureHiddenBox[];
}

export class HistoryWriter {
  private readonly depth: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly now: () => number;
  private buffer: CoreBlockResult[] = [];
  private ops: Op[] = [];
  private queue: Promise<void> = Promise.resolve();
  private waitingIntake = 0;
  private recoveryWaiters: (() => void)[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private failingSinceMs: number | null = null;
  private stopped = false;
  private readonly relisting = new Map<number, Relisting>();
  written = 0;
  undone = 0;
  lastError: string | null = null;

  constructor(
    private readonly store: HistoryStore,
    options: HistoryWriterOptions = {},
  ) {
    this.depth = options.depth ?? 2;
    if (this.depth < 1) throw new RangeError('depth is at least 1');
    this.retryBaseMs = options.retryBaseMs ?? 500;
    this.retryMaxMs = options.retryMaxMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  /**
   * SH-NO-PICTURE-GATE upgrade, once at startup before any message: the boxes stored as not shown only for the removed
   * picture check (or left marked by an interrupted replay), deleted and then replayed by the catch-up (above).
   * Returns how many.
   */
  async relistPictureHidden(): Promise<number> {
    const hidden = await this.store.pictureHidden();
    for (const chainId of new Set(hidden.map((b) => b.chainId))) {
      const boxes = hidden.filter((b) => b.chainId === chainId);
      const through = await this.store.startReplay(chainId, boxes);
      this.relisting.set(chainId, { through, tokens: new Set(boxes.map((b) => b.token.toLowerCase())), boxes });
    }
    if (hidden.length > 0) console.warn(`[history] ${hidden.length} box(es) stored as unlisted for their pictures (SH-NO-PICTURE-GATE): deleted, and replayed from their creation blocks during the catch-up`);
    return hidden.length;
  }

  /**
   * The pipeline's intake (bound: pass it as `onHistory`). Runs strictly in order; never rejects.
   * A failed drain keeps its acknowledgement pending until recovery, so the pipeline's message cap also bounds
   * retained retry operations. Only acknowledgements wait: intake, rollback/reset and the retry queue stay usable.
   */
  readonly accept = (message: HistoryMessage): Promise<void> => {
    this.waitingIntake += 1;
    let drained = false;
    const intake = this.enqueue(async () => {
      this.waitingIntake -= 1;
      this.take(message);
      drained = await this.drain();
    });
    return intake.then(() => {
      if (drained || this.ops.length === 0) return;
      return new Promise<void>((resolve) => this.recoveryWaiters.push(resolve));
    });
  };

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task).catch((error: unknown) => {
      // drain() handles store failures itself; this is a bug guard (nothing is dropped: the ops stay queued).
      this.lastError = error instanceof Error ? error.message : String(error);
      console.error(`[history] ${this.lastError}`);
    });
    return this.queue;
  }

  /** A message into the buffer and the operation queue (no store call here). */
  private take(message: HistoryMessage): void {
    switch (message.type) {
      case 'block': {
        this.buffer.push(message.result);
        while (this.buffer.length >= this.depth) {
          const oldest = this.buffer.shift();
          if (oldest) this.ops.push({ kind: 'write', result: oldest });
        }
        return;
      }
      case 'rollback': {
        this.buffer = this.buffer.filter((b) => b.block.number <= message.toBlock);
        // Writes above the ancestor that never reached the store are dropped; what did is undone in order.
        this.ops = this.ops.filter((op) => !(op.kind === 'write' && op.result.chainId === message.chainId && op.result.block.number > message.toBlock));
        this.ops.push({ kind: 'undo', chainId: message.chainId, toBlock: message.toBlock });
        return;
      }
      case 'reset':
        this.buffer = [];
        // The wipe rewrites every block, each box with its rows: nothing is left to relist.
        this.relisting.delete(message.chainId);
        // The wipe supersedes everything still waiting for this chain.
        this.ops = [...this.ops.filter((op) => opChain(op) !== message.chainId), { kind: 'wipe', chainId: message.chainId }];
        return;
    }
  }

  private async apply(op: Op): Promise<void> {
    switch (op.kind) {
      case 'write': {
        const relisting = this.relisting.get(op.result.chainId);
        await this.store.writeBlock(op.result, relisting?.tokens);
        this.written += 1;
        if (!relisting || op.result.block.number < relisting.through) return;
        // Every block held at startup is behind us: the replay is whole (retried with this write if it fails).
        await this.store.finishReplay(op.result.chainId, relisting.boxes);
        this.relisting.delete(op.result.chainId);
        console.warn(`[history] replayed ${relisting.boxes.length} picture-hidden box(es) on chain ${op.result.chainId}`);
        return;
      }
      case 'undo': {
        const cursor = await this.store.cursor(op.chainId);
        if (cursor && cursor.block > op.toBlock) {
          await this.store.undoAbove(op.chainId, op.toBlock);
          this.undone += 1;
        }
        return;
      }
      case 'wipe':
        await this.store.wipe(op.chainId);
        return;
    }
  }

  /** Applies the queued operations in order; the first failure stops the run and schedules a retry. */
  private async drain(): Promise<boolean> {
    while (this.ops.length > 0) {
      if (this.retryTimer) return false; // a retry is scheduled: nothing overtakes the failed operation
      const op = this.ops[0] as Op;
      try {
        await this.apply(op);
      } catch (error) {
        this.failures += 1;
        this.failingSinceMs ??= this.now();
        this.lastError = `${op.kind === 'write' ? `block ${op.result.block.number}` : op.kind}: ${error instanceof Error ? error.message : String(error)}`;
        console.error(`[history] ${this.lastError} (failure ${this.failures}; ${this.ops.length} waiting, retried)`);
        this.scheduleRetry();
        return false;
      }
      this.ops.shift();
      if (this.failures > 0) console.warn(`[history] recovered after ${this.failures} failed attempt(s)`);
      this.failures = 0;
      this.failingSinceMs = null;
    }
    for (const resolve of this.recoveryWaiters.splice(0)) resolve();
    return true;
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.min(this.failures - 1, 16));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.enqueue(async () => {
        await this.drain();
      });
    }, delay);
    (this.retryTimer as { unref?: () => void }).unref?.();
  }

  health(): HistoryHealth {
    const relisting = [...this.relisting.values()].reduce((n, r) => n + r.boxes.length, 0);
    return { ok: this.failures === 0 && relisting === 0, relisting, pending: this.ops.length + this.waitingIntake, lastError: this.failures === 0 ? null : this.lastError, failures: this.failures, failingSinceMs: this.failingSinceMs, written: this.written };
  }

  /**
   * Writes what is buffered (shutdown, tests: everything up to the head). Throws when the store still refuses an
   * operation (nothing is dropped: the operations stay queued and the retries go on).
   */
  async flush(): Promise<void> {
    await this.enqueue(async () => {
      for (const result of this.buffer.splice(0)) this.ops.push({ kind: 'write', result });
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
      await this.drain();
    });
    if (this.ops.length > 0) throw new Error(`history: ${this.ops.length} operation(s) not written yet (${this.lastError ?? 'unknown error'})`);
  }

  async idle(): Promise<void> {
    await this.queue;
  }

  /** Stops the retries (shutdown). What is queued stays queued. */
  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}
