/**
 * The per-block pipeline (research § 5.1, § 3.2). One task at a time, strictly in order (every store write and every
 * frame goes through the same queue, so frame sequence numbers reach the stream in order):
 *
 * 1. Dedupe by hash. A header below our head is ignored (a lagging source); the next head of a new branch reveals a
 *    reorg anyway.
 * 2. Gap (header > head + 1): fetch the missing headers by number and process them first. A long gap (> 64), a cold
 *    start and a rebuild are written QUIETLY (range backfill up to 32 blocks below the target, then block by block)
 *    and announced once at the end with a `resync` frame carrying the new snapshot: viewers never watch a replay.
 * 3. Parent mismatch or a sibling at our height: walk the new branch back by parent hash to the newest block we still
 *    hold (the common ancestor), roll the store back to it (`reorg` published), then apply the new branch block by
 *    block. An ancestor we do not hold (below the contiguous tail, or a hole left by a range backfill): rebuild.
 * 4. Apply: `getLogs` by block hash only when the header's bloom allows a log of ours; decode; traders (senders.ts);
 *    fold into the state (derive.ts); build the snapshot and the SSE event; one atomic store commit that also appends
 *    the frame to the stream.
 *
 * Audit (every 32 blocks): re-reads blocks 8 to 40 below the head by range and compares them with what was applied.
 * It only ever ADDS: a log that a backend returned by block hash for a block that is still canonical is real, so a
 * range answer that lacks it (a lagging backend) changes nothing. A range answer with logs we never applied is
 * confirmed by a two-endpoint by-hash read and merged in (quiet re-apply, one `resync`). Only a block whose hash
 * changed by number is taken away, as a reorg.
 *
 * Verification (while running, off the queue): the derived √price, tick, liquidity and burned amount are compared
 * with the chain (`extsload`, `totalSupply()` pinned by block hash) at the parent of every block with trades (where a
 * missed event still shows, before the block's own Swap overwrites the price) and every 64 blocks at the head. A
 * mismatch marks the stream unverified at once (status frame, heartbeat) and schedules a repair: re-apply everything
 * after the last verified block from two-endpoint by-hash reads, else rebuild; then check again.
 */
import type { Address, Hex } from 'viem';
import type { ChainReader } from './chain-reader';
import type { PoolTarget } from './config';
import { applyBlock, initialPoolState, type DeriveContext } from './derive';
import { decodeBlockLogs, type RawLog } from './events';
import { decodeFrame, encodeFrame, eventId } from './frame';
import { groupByBlock, logsOfHash, mapLimit, relevantIndexes, sameHash, unionLogs } from './log-sets';
import { activityFromJson, stateFromJson, toJson, tradeFromJson, type BlockHeader, type HeadSource, type PoolState, type Trade } from './model';
import { SenderResolver, txsNeedingSender, type SenderMetrics } from './senders';
import { blockEvent, buildSnapshot, finalityView, storedHeader, reorgEvent, type HeadInfo, type ViewContext } from './snapshot';
import { BLOCKS_KEPT, type HotStore, type StoredBlock } from './store/types';
import { ChainVerifier, type BlockRef, type VerifierMetrics } from './verifier';
import { headView, type IndexerStatus, type LiveSnapshot, type ResyncEvent, type TradersEvent } from './views';
import { RecentWindow, RING_ACTIVITY, RING_TRADES } from './window';
const SHORT_GAP = 64n;
const RANGE_TAIL = 32n;
const AUDIT_EVERY = 32;
const VERIFY_EVERY = 64;
const SENDER_BUDGET_MS = 600;
const SENDER_RETRY_MS: readonly number[] = [2_000, 5_000, 15_000];
const READ_CONCURRENCY = 4;

export interface PipelineMetrics extends SenderMetrics, VerifierMetrics {
  blocksApplied: number;
  headsSeen: number;
  duplicates: number;
  ignoredOld: number;
  reorgs: number;
  maxReorgDepth: number;
  rebuilds: number;
  gapsFilled: number;
  audits: number;
  /** Audits that changed something: logs merged in and re-applied, or a replaced block followed. */
  auditMismatches: number;
  /** Range answers that lacked logs we applied by hash, or carried another fork's logs, for a canonical block: ignored. */
  auditRangeBehind: number;
  logCalls: number;
  bloomSkips: number;
  errors: number;
  lastError: string | null;
  repairs: number;
  resyncs: number;
  frames: number;
}

export interface PipelineOptions {
  readonly reader: ChainReader;
  readonly store: HotStore;
  readonly target: PoolTarget;
  readonly confirmations: number;
  readonly now?: () => number;
  readonly auditEvery?: number;
  /** Verify the head against the chain every this many published blocks (and before each trade block). */
  readonly verifyEvery?: number;
  /** How long a block may wait for its traders' senders before it goes out without them (ms). */
  readonly senderBudgetMs?: number;
  readonly senderRetryMs?: readonly number[];
}

/** What the indexer writes into its heartbeat (service.ts) and what the gateways judge freshness by. */
export interface HeartbeatInfo {
  /** The newest block applied (during a quiet catch-up: ahead of what viewers have). */
  readonly head: string | null;
  /** The head of the last frame viewers got. The gateways call the stream stale when it stops advancing. */
  readonly publishedHead: string | null;
  readonly publishedAtMs: number | null;
  readonly verified: boolean | null;
  readonly catchingUp: boolean;
}

export class PoolIndexer {
  readonly metrics: PipelineMetrics = {
    blocksApplied: 0, headsSeen: 0, duplicates: 0, ignoredOld: 0, reorgs: 0, maxReorgDepth: 0, rebuilds: 0, gapsFilled: 0,
    audits: 0, auditMismatches: 0, auditRangeBehind: 0, logCalls: 0, bloomSkips: 0, errors: 0, lastError: null,
    verified: null, verifications: 0, verifyFailures: 0, verifySkipped: 0, repairs: 0, resyncs: 0, frames: 0,
    senderCalls: 0, senderBlockCalls: 0, sendersLate: 0, senderFailures: 0,
  };
  private readonly reader: ChainReader;
  private readonly store: HotStore;
  private readonly target: PoolTarget;
  private readonly confirmations: number;
  private readonly now: () => number;
  private readonly auditEvery: number;
  private readonly verifyEvery: number;
  private readonly senderBudgetMs: number;
  private readonly ctx: DeriveContext;
  private readonly senders: SenderResolver;
  private readonly window: RecentWindow;
  private finality: { safe: bigint | null; finalized: bigint | null } = { safe: null, finalized: null };
  private lastHeadInfo: HeadInfo = { source: 'backfill', seenAtMs: 0 };
  private busy: Promise<void> = Promise.resolve();
  private pending: { header: BlockHeader; info: HeadInfo } | null = null;
  private running = false;
  private sinceAudit = 0;
  private auditing = false;
  private quiet = false;
  private quietChanges = 0;
  private catchingUp = false;
  private seq = 0;
  private published: { head: bigint | null; atMs: number | null } = { head: null, atMs: null };
  private sinceVerify = 0;
  private readonly verifier: ChainVerifier;
  private readonly background = new Set<Promise<unknown>>();

  constructor(options: PipelineOptions) {
    this.reader = options.reader;
    this.store = options.store;
    this.target = options.target;
    this.confirmations = options.confirmations;
    this.now = options.now ?? Date.now;
    this.auditEvery = options.auditEvery ?? AUDIT_EVERY;
    this.verifyEvery = options.verifyEvery ?? VERIFY_EVERY;
    this.senderBudgetMs = options.senderBudgetMs ?? SENDER_BUDGET_MS;
    this.ctx = { launchRouter: options.target.launchRouter, hook: options.target.hook, genesis: options.target.genesis, collector: options.target.collector, executor: options.target.executor, shape: options.target.curve };
    this.senders = new SenderResolver({ reader: options.reader, store: options.store, metrics: this.metrics, retryMs: options.senderRetryMs ?? SENDER_RETRY_MS });
    this.verifier = new ChainVerifier({
      reader: options.reader,
      issuance: options.target.issuance,
      metrics: this.metrics,
      now: this.now,
      running: () => this.running,
      stillCurrent: (block, state) => this.stillCurrent(block, state),
      onVerdict: () => void this.schedule('status', () => this.publishStatus()),
      onFailure: (block, state) =>
        void this.schedule('verification repair', async () => {
          try {
            if (this.stillCurrent(block, state)) await this.repair(block);
          } finally {
            this.verifier.repairFinished();
          }
        }),
      track: (work) => this.track(work),
    });
    this.window = new RecentWindow(() => this.genesisState());
  }

  private genesisState(): PoolState {
    const zero = `0x${'0'.repeat(64)}` as Hex;
    return initialPoolState({ number: this.target.deployBlock - 1n, hash: zero, parentHash: zero, timestamp: 0n }, this.target.curve);
  }

  head(): StoredBlock | null {
    return this.window.head();
  }

  latestState(): PoolState {
    return this.window.latestState();
  }

  recentTrades(): readonly Trade[] {
    return this.window.trades();
  }

  heartbeatInfo(): HeartbeatInfo {
    return {
      head: this.head()?.number.toString() ?? null,
      publishedHead: this.published.head?.toString() ?? null,
      publishedAtMs: this.published.atMs,
      verified: this.metrics.verified,
      catchingUp: this.catchingUp,
    };
  }

  private stateAtOrBefore(block: bigint): PoolState {
    return this.window.stateAtOrBefore(block);
  }

  private hashAt(number: bigint): Hex | undefined {
    return this.window.hashAt(number);
  }

  // ------------------------------------------------------------------------------------------------ lifecycle

  /** Restores the in-memory window from the store, or starts from the genesis state; then catches up to the head. */
  async start(): Promise<void> {
    const recent = await this.store.loadRecent({ trades: RING_TRADES, activity: RING_ACTIVITY });
    if (recent.blocks.length > 0 && recent.states.length > 0) {
      this.window.restore(recent.blocks, new Map(recent.states.map((s) => [s.block, stateFromJson(s.json)])), recent.trades.map(tradeFromJson), recent.activity.map(activityFromJson));
    } else {
      await this.store.clear();
    }
    this.finality = await this.store.getFinality();
    this.seq = await this.lastSeq();
    this.running = true;
    const latest = await this.reader.latestHeader();
    await this.enqueue(latest, { source: 'backfill', seenAtMs: this.now() });
    await this.verifyAgainstChain();
  }

  /** Frame numbers continue from the stream across restarts; a fresh stream starts from the clock (ms). */
  private async lastSeq(): Promise<number> {
    const last = (await this.store.recentFrames(1)).frames.at(-1);
    if (last) {
      try {
        return decodeFrame(last).seq;
      } catch {
        // a frame of an older format: start from the clock, which is above any earlier sequence
      }
    }
    return this.now();
  }

  stop(): void {
    this.running = false;
  }

  /** Called by the head feed; only the newest waiting header is kept while a block is being processed. */
  onHead(header: BlockHeader, source: HeadSource, seenAtMs: number): void {
    this.metrics.headsSeen += 1;
    void this.enqueue(header, { source, seenAtMs });
  }

  enqueue(header: BlockHeader, info: HeadInfo): Promise<void> {
    if (!this.pending || header.number >= this.pending.header.number) this.pending = { header, info };
    return this.schedule(`block ${header.number}`, async () => {
      const next = this.pending;
      this.pending = null;
      if (next) await this.handle(next.header, next.info);
    });
  }

  /** Every state change and every frame runs through this one queue. */
  private schedule(what: string, task: () => Promise<void>): Promise<void> {
    this.busy = this.busy.then(async () => {
      if (!this.running) return;
      try {
        await task();
      } catch (error) {
        this.recordError(what, error);
      }
    });
    return this.busy;
  }

  private recordError(what: string, error: unknown): void {
    this.metrics.errors += 1;
    this.metrics.lastError = error instanceof Error ? error.message : String(error);
    console.error(`[indexer] ${what}: ${this.metrics.lastError}`);
  }

  private track(work: Promise<unknown>): void {
    const tracked = work.catch((error: unknown) => this.recordError('background', error)).finally(() => this.background.delete(tracked));
    this.background.add(tracked);
  }

  /** Waits until the queue, the verification loop and any trader follow-ups are done (tests, scripts). */
  async idle(): Promise<void> {
    for (;;) {
      const busy = this.busy;
      await busy;
      const background = [...this.background];
      if (background.length === 0 && busy === this.busy) return;
      await Promise.allSettled(background);
    }
  }

  // ------------------------------------------------------------------------------------------------ frames

  private nextId(block?: BlockRef): string {
    this.seq += 1;
    this.metrics.frames += 1;
    return eventId(this.seq, block?.number, block?.hash);
  }

  private markPublished(block: BlockRef): void {
    this.published = { head: block.number, atMs: this.now() };
  }

  private async publishStatus(): Promise<void> {
    const status: IndexerStatus = { verified: this.metrics.verified, catchingUp: this.catchingUp, head: this.head()?.number.toString() ?? null, atMs: this.now() };
    await this.store.publish(encodeFrame({ type: 'status', id: this.nextId(), etag: '', event: toJson(status), snapshot: null }));
  }

  private async publishResync(reason: string): Promise<void> {
    const head = this.head();
    if (!head) return;
    const header = storedHeader(head);
    const id = this.nextId(head);
    const event: ResyncEvent = { id, reason, head: headView(header, this.lastHeadInfo.source, this.lastHeadInfo.seenAtMs) };
    const snapshotJson = toJson(this.buildSnapshot(header));
    await this.store.publishUpdate({ snapshot: { json: snapshotJson, etag: id }, message: encodeFrame({ type: 'resync', id, etag: id, event: toJson(event), snapshot: snapshotJson }) });
    this.metrics.resyncs += 1;
    this.markPublished(head);
  }

  /**
   * Runs `work` with every commit and rollback written quietly (no frame, the served snapshot untouched), then
   * announces the result once with a `resync`. `announce` also tells viewers "catching up" while it runs (a cold
   * start, a long gap, a rebuild); a short repair only sends the resync. Nested calls join the outer one.
   */
  private async quietly(reason: string, announce: boolean, work: () => Promise<void>): Promise<void> {
    if (this.quiet) {
      await work();
      return;
    }
    this.quiet = true;
    this.quietChanges = 0;
    if (announce) {
      this.catchingUp = true;
      await this.publishStatus();
    }
    try {
      await work();
    } finally {
      this.quiet = false;
      this.catchingUp = false;
      if (this.quietChanges > 0) {
        await this.publishResync(reason);
        const head = this.head();
        if (head) this.verifier.request(head, this.latestState()); // check what was just written, off the queue
      }
      if (announce) await this.publishStatus();
    }
  }

  // ------------------------------------------------------------------------------------------------ blocks

  private async handle(header: BlockHeader, info: HeadInfo): Promise<void> {
    const head = this.head();
    if (this.hashAt(header.number) === header.hash) {
      this.metrics.duplicates += 1;
      return;
    }
    if (!head) {
      await this.catchUp(header, info);
      return;
    }
    if (header.number < head.number) {
      this.metrics.ignoredOld += 1;
      return;
    }
    if (header.number > head.number + 1n) {
      await this.catchUp(header, info);
      return;
    }
    if (header.number === head.number + 1n && header.parentHash === head.hash) {
      await this.apply(header, info);
      await this.maybeAudit();
      return;
    }
    await this.reorg(header, info);
  }

  /** Up to `target`: block by block for a short gap (published); quietly with a range backfill otherwise. */
  private async catchUp(target: BlockHeader, info: HeadInfo): Promise<void> {
    const head = this.head();
    if (head && target.number - head.number <= SHORT_GAP) {
      await this.fillGap(target, info);
      return;
    }
    await this.quietly(head ? 'long gap' : 'cold start', true, async () => {
      if (head) await this.dropNonCanonicalHead();
      const kept = this.head();
      const from = kept ? kept.number + 1n : this.target.deployBlock;
      const end = target.number - RANGE_TAIL;
      if (end >= from) await this.rangeApply(from, end);
      else if (!kept) await this.rangeApply(from, from); // a chain barely past the deploy block
      await this.fillGap(target, info);
    });
  }

  private async fillGap(target: BlockHeader, info: HeadInfo): Promise<void> {
    let head = this.head();
    if (!head) throw new Error(`no head to fill the gap to ${target.number} from`);
    this.metrics.gapsFilled += 1;
    while (head && head.number + 1n < target.number) {
      const next = await this.reader.headerByNumber(head.number + 1n);
      if (!next) throw new Error(`block ${head.number + 1n} not available yet`);
      await this.handle(next, { source: 'backfill', seenAtMs: this.now() });
      const moved = this.head();
      if (!moved || moved.number <= head.number) throw new Error(`could not advance past ${head.number}`);
      head = moved;
    }
    await this.handle(target, info);
  }

  /**
   * Before a range backfill: our head may have been replaced while we were away (a restart, a long RPC outage). Find
   * the newest held block that is still canonical by number and roll back to it; none at all → start from genesis.
   */
  private async dropNonCanonicalHead(): Promise<void> {
    const held = this.window.heldBlocks();
    for (let i = held.length - 1; i >= 0; i -= 1) {
      const block = held[i];
      if (!block) continue;
      const onChain = await this.reader.headerByNumber(block.number);
      if (onChain?.hash !== block.hash) continue;
      if (i < held.length - 1) await this.rollbackTo(block.number, 'reorg');
      return;
    }
    this.metrics.rebuilds += 1;
    this.window.reset();
    this.quietChanges += 1;
    await this.store.clear({ keepSnapshot: true });
  }

  /** Range backfill [from, to] with `eth_getLogs` over spans; headers only for blocks that have logs, and for `to`. */
  private async rangeApply(from: bigint, to: bigint): Promise<void> {
    const byBlock = groupByBlock(await this.reader.rangeLogs(from, to));
    const numbers = [...byBlock.keys()].sort((a, b) => (a < b ? -1 : 1));
    const headers = await mapLimit(numbers, READ_CONCURRENCY, async (number) => {
      const hash = byBlock.get(number)?.[0]?.blockHash;
      const header = hash ? await this.reader.headerByHash(hash) : null;
      if (!header || header.number !== number) throw new Error(`range backfill: header of block ${number} unavailable`);
      return header;
    });
    const info: HeadInfo = { source: 'backfill', seenAtMs: this.now() };
    for (const header of headers) await this.commit(header, logsOfHash(byBlock.get(header.number) ?? [], header.hash), info, 0);
    const end = await this.reader.headerByNumber(to);
    if (!end) throw new Error(`range backfill: header ${to} unavailable`);
    if (this.hashAt(end.number) !== end.hash) await this.commit(end, [], info, 0);
  }

  private async apply(header: BlockHeader, info: HeadInfo): Promise<void> {
    const { logs, calls } = await this.reader.blockLogs(header);
    this.metrics.logCalls += calls;
    if (calls === 0) this.metrics.bloomSkips += 1;
    await this.commit(header, logs, info, calls);
  }

  /** Folds one block in, updates the window, commits atomically; publishes unless quiet. */
  private async commit(header: BlockHeader, logs: readonly RawLog[], info: HeadInfo, rpcCalls: number): Promise<void> {
    const events = decodeBlockLogs(logs, this.target);
    const senders = await this.senders.forBlock(header.hash, txsNeedingSender(events), this.quiet ? null : this.senderBudgetMs);
    const previous = this.latestState();
    const result = applyBlock(previous, header, events, senders.known, this.ctx);
    const logIndexes = relevantIndexes(events);
    const stored: StoredBlock = { number: header.number, hash: header.hash, parentHash: header.parentHash, timestamp: header.timestamp, ...(logIndexes.length > 0 ? { logIndexes } : {}) };
    this.window.add(stored, result.state, logs, result.trades, result.activity);
    this.lastHeadInfo = info;
    this.metrics.blocksApplied += 1;
    const rows = {
      block: stored,
      stateJson: toJson(result.state),
      trades: result.trades.map((t) => ({ score: t.score, json: toJson(t) })),
      activity: result.activity.map((a) => ({ score: a.score, json: toJson(a) })),
      txSenders: senders.fetched,
    };

    if (this.quiet) {
      this.quietChanges += 1;
      await this.store.commitBlock({ ...rows, snapshot: null, message: null });
    } else {
      const id = this.nextId(stored);
      const event = blockEvent(this.views(), id, header, info, result, rpcCalls);
      const snapshotJson = toJson(this.buildSnapshot(header, info));
      await this.store.commitBlock({ ...rows, snapshot: { json: snapshotJson, etag: id }, message: encodeFrame({ type: 'block', id, etag: id, event: toJson(event), snapshot: snapshotJson }) });
      this.markPublished(stored);
      this.afterPublish(stored, header, result.trades.length > 0);
    }
    if (senders.later) this.followUpTraders(header, senders.later);
  }

  private views(): ViewContext {
    return { target: this.target, confirmations: this.confirmations, finality: this.finality, window: this.window, nowMs: this.now() };
  }

  buildSnapshot(header: BlockHeader, info: HeadInfo = this.lastHeadInfo): LiveSnapshot {
    return buildSnapshot(this.views(), header, info);
  }

  // ------------------------------------------------------------------------------------------------ traders

  private followUpTraders(header: BlockHeader, later: Promise<ReadonlyMap<Hex, Address>>): void {
    this.track(later.then((found) => (found.size > 0 ? this.schedule(`traders of block ${header.number}`, () => this.patchTraders(header, found)) : undefined)));
  }

  /** Fills in traders that arrived after their block went out: trade rows, snapshot and a `traders` frame. */
  private async patchTraders(header: BlockHeader, found: ReadonlyMap<Hex, Address>): Promise<void> {
    const head = this.head();
    if (!head || this.hashAt(header.number) !== header.hash) return; // the block was replaced meanwhile
    const patched = this.window.patchTrades((trade) => {
      const from = trade.blockHash === header.hash && trade.trader === null ? found.get(trade.txHash) : undefined;
      return from ? { ...trade, trader: from.toLowerCase() as Address } : null;
    });
    if (patched.length === 0) return;
    const id = this.nextId();
    const event: TradersEvent = { id, block: header.number.toString(), blockHash: header.hash, traders: patched.map((t) => ({ id: t.id, trader: t.trader ?? '' })) };
    const snapshotJson = toJson(this.buildSnapshot(storedHeader(head)));
    await this.store.publishUpdate({
      snapshot: { json: snapshotJson, etag: id },
      message: encodeFrame({ type: 'traders', id, etag: id, event: toJson(event), snapshot: snapshotJson }),
      trades: patched.map((t) => ({ score: t.score, json: toJson(t) })),
    });
  }

  // ------------------------------------------------------------------------------------------------ reorgs

  /** Walks the new branch back to the newest block we still hold, rolls back to it, applies the branch. */
  private async reorg(header: BlockHeader, info: HeadInfo): Promise<void> {
    const branch: BlockHeader[] = [header];
    let cursor = header;
    let ancestor: bigint | null = null;
    while (ancestor === null) {
      const known = this.hashAt(cursor.number - 1n);
      if (known === undefined || branch.length > BLOCKS_KEPT) {
        await this.rebuild(header, info);
        return;
      }
      if (known === cursor.parentHash) {
        ancestor = cursor.number - 1n;
        break;
      }
      const parent = await this.reader.headerByHash(cursor.parentHash);
      if (!parent) throw new Error(`reorg: parent ${cursor.parentHash} of block ${cursor.number} unavailable`);
      branch.unshift(parent);
      cursor = parent;
    }
    await this.rollbackTo(ancestor, 'reorg');
    for (const block of branch) await this.apply(block, block === header ? info : { source: 'backfill', seenAtMs: this.now() });
  }

  /** Drops everything above `ancestor`. A reorg is published as one; a repair's rollback is quiet (inside `quietly`). */
  private async rollbackTo(ancestor: bigint, kind: 'reorg' | 'repair'): Promise<void> {
    const head = this.head();
    const ancestorBlock = this.window.blockAt(ancestor);
    if (!head || !ancestorBlock) throw new Error(`rollback: block ${ancestor} is not held`);
    const depth = Number(head.number - ancestor);
    const dropped = this.window.dropAbove(ancestor);
    if (kind === 'reorg') {
      this.metrics.reorgs += 1;
      this.metrics.maxReorgDepth = Math.max(this.metrics.maxReorgDepth, depth);
      console.warn(`[indexer] reorg: rolled back ${depth} block(s) from ${head.number} to ${ancestor}`);
    }
    if (this.quiet) {
      this.quietChanges += 1;
      await this.store.rollback({ toBlock: ancestor, snapshot: null, message: null });
      return;
    }
    const header = storedHeader(ancestorBlock);
    const info: HeadInfo = { source: 'backfill', seenAtMs: this.now() };
    const id = this.nextId(ancestorBlock);
    const event = reorgEvent(this.views(), id, head.number, ancestorBlock, dropped, info);
    const snapshotJson = toJson(this.buildSnapshot(header, info));
    await this.store.rollback({ toBlock: ancestor, snapshot: { json: snapshotJson, etag: id }, message: encodeFrame({ type: 'reorg', id, etag: id, event: toJson(event), snapshot: snapshotJson }) });
    this.markPublished(ancestorBlock);
  }

  /**
   * An ancestor we do not hold, or a repair that did not help: start over from the genesis state, quietly, up to the
   * chain's newest head (not only to the header that led here), so viewers get one resync and no stream of catch-up
   * blocks after it.
   */
  private async rebuild(header: BlockHeader, info: HeadInfo, reason = 'rebuild'): Promise<void> {
    this.metrics.rebuilds += 1;
    console.warn(`[indexer] ${reason}: rebuilding from the deploy block (written quietly, then one resync)`);
    await this.quietly(reason, true, async () => {
      this.window.reset();
      this.quietChanges += 1;
      await this.store.clear({ keepSnapshot: true });
      const latest = await this.reader.latestHeader();
      await this.catchUp(latest.number > header.number ? latest : header, latest.number > header.number ? { source: 'backfill', seenAtMs: this.now() } : info);
    });
  }

  // ------------------------------------------------------------------------------------------------ audit

  private async maybeAudit(): Promise<void> {
    this.sinceAudit += 1;
    if (this.sinceAudit < this.auditEvery || this.auditing) return;
    this.sinceAudit = 0;
    this.auditing = true;
    try {
      await this.audit();
    } finally {
      this.auditing = false;
    }
  }

  /**
   * Re-reads blocks 8 … 40 below the head by range and compares the events the state depends on with what was
   * applied (the log indexes kept per block, in the store too). Additive only:
   * - the block's hash changed by number → a fork we missed: roll back and follow the chain (a reorg);
   * - otherwise our block is canonical, and a log any backend returned for it by hash is real. Logs the range lacks
   *   (a lagging backend) or that carry another block hash are ignored. Logs we never applied are confirmed by a
   *   two-endpoint by-hash read, merged with what was applied, and re-applied quietly (one `resync`).
   */
  async audit(): Promise<void> {
    const head = this.head();
    if (!head) return;
    const to = head.number - 8n;
    const from = to - 32n;
    if (!this.window.holdsEveryBlockFrom(from - 1n)) return;
    this.metrics.audits += 1;
    const byBlock = groupByBlock(await this.reader.rangeLogs(from, to));
    for (let n = from; n <= to; n += 1n) {
      const held = this.window.blockAt(n);
      if (!held) return;
      const answer = byBlock.get(n) ?? [];
      const onHeld = logsOfHash(answer, held.hash);
      const applied = new Set(held.logIndexes ?? []);
      const seen = relevantIndexes(decodeBlockLogs(onHeld, this.target));
      const foreign = answer.length - onHeld.length;
      const lacking = [...applied].filter((i) => !seen.includes(i)).length;
      if (foreign === 0 && lacking === 0 && seen.every((i) => applied.has(i))) continue;
      const canonical = await this.reader.headerByNumber(n);
      if (!canonical) {
        console.warn(`[indexer] audit: block ${n} is not available by number; nothing changed`);
        return;
      }
      if (!sameHash(canonical.hash, held.hash)) {
        this.metrics.auditMismatches += 1;
        console.warn(`[indexer] audit: block ${n} was replaced (${held.hash} → ${canonical.hash}); following the chain`);
        await this.rollbackTo(n - 1n, 'reorg');
        await this.catchUp(await this.reader.latestHeader(), { source: 'backfill', seenAtMs: this.now() });
        return;
      }
      const byHash = logsOfHash(await this.reader.logsByHash(held.hash), held.hash);
      const merged = unionLogs(onHeld, byHash);
      const extra = relevantIndexes(decodeBlockLogs(merged, this.target)).filter((i) => !applied.has(i));
      if (extra.length === 0) {
        this.metrics.auditRangeBehind += 1;
        console.warn(`[indexer] audit: the range answer for block ${n} ${lacking > 0 ? `lacks ${lacking} applied log(s)` : 'carries another fork\'s logs'}; our block is canonical, kept as applied`);
        continue;
      }
      this.metrics.auditMismatches += 1;
      console.warn(`[indexer] audit: block ${n} has ${extra.length} log(s) we never applied; merging and re-applying from ${n}`);
      const extraByBlock = new Map<bigint, RawLog[]>([[n, merged]]);
      for (let m = n + 1n; m <= to; m += 1n) {
        const hash = this.hashAt(m);
        if (hash) extraByBlock.set(m, logsOfHash(byBlock.get(m) ?? [], hash));
      }
      await this.reapplyFrom(n, extraByBlock, 'audit', false);
      return;
    }
  }

  /**
   * Re-applies every held block from `from` with the UNION of what was applied and the new answers (`extra`; with
   * `refetchAll`, a two-endpoint by-hash read of every block). A block whose applied logs cannot be read back is not
   * guessed at: nothing is changed and the error surfaces. Written quietly, announced with one `resync`.
   */
  private async reapplyFrom(from: bigint, extra: ReadonlyMap<bigint, readonly RawLog[]>, reason: string, refetchAll: boolean): Promise<void> {
    const replay = this.window.heldBlocks().filter((b) => b.number >= from);
    const reread = refetchAll ? new Map(await mapLimit(replay, READ_CONCURRENCY, async (b) => [b.number, logsOfHash(await this.reader.logsByHash(b.hash), b.hash)] as const)) : new Map<bigint, RawLog[]>();
    const plan: { block: StoredBlock; logs: RawLog[] }[] = [];
    for (const block of replay) {
      const known = this.window.appliedLogs(block);
      let logs = unionLogs(known ?? [], extra.get(block.number) ?? [], reread.get(block.number) ?? []);
      if (known === null && (block.logIndexes?.length ?? 0) > 0 && !reread.has(block.number)) {
        logs = unionLogs(logs, logsOfHash(await this.reader.logsByHash(block.hash), block.hash));
      }
      const have = new Set(relevantIndexes(decodeBlockLogs(logs, this.target)));
      const lost = (block.logIndexes ?? []).filter((i) => !have.has(i));
      if (lost.length > 0) throw new Error(`${reason}: block ${block.number}: applied log(s) ${lost.join(', ')} were not returned again; nothing re-applied`);
      plan.push({ block, logs });
    }
    await this.quietly(reason, false, async () => {
      await this.rollbackTo(from - 1n, 'repair');
      const info: HeadInfo = { source: 'backfill', seenAtMs: this.now() };
      for (const { block, logs } of plan) await this.commit(storedHeader(block), logs, info, 0);
    });
  }

  // ------------------------------------------------------------------------------------------------ verification

  private afterPublish(block: StoredBlock, header: BlockHeader, hadTrades: boolean): void {
    this.sinceVerify += 1;
    const parent = block.number - 1n;
    if (hadTrades && parent >= this.target.deployBlock) this.verifier.request({ number: parent, hash: header.parentHash }, this.stateAtOrBefore(parent));
    if (this.sinceVerify >= this.verifyEvery) {
      this.sinceVerify = 0;
      this.verifier.request(block, this.stateAtOrBefore(block.number));
    }
  }

  /** The state object still held for that block (a repair or reorg since replaced it: the result no longer applies). */
  private stillCurrent(block: BlockRef, state: PoolState): boolean {
    const hash = this.hashAt(block.number);
    return (hash === undefined || sameHash(hash, block.hash)) && this.stateAtOrBefore(block.number) === state;
  }

  /**
   * After a failed check: re-read every block after the last verified one by hash on two endpoints and re-apply
   * (a missed log is the likely cause); if the chain still disagrees, or no verified block is held, rebuild. If even
   * the rebuild disagrees (a decoding bug), stay unverified and stop repairing until a check passes again.
   */
  private async repair(bad: BlockRef): Promise<void> {
    const head = this.head();
    if (!head) return;
    this.metrics.repairs += 1;
    const anchor = this.verifier.lastVerified;
    const usable = anchor && anchor.number < bad.number && sameHash(this.hashAt(anchor.number), anchor.hash) && this.window.holdsEveryBlockFrom(anchor.number);
    if (anchor && usable) {
      console.warn(`[indexer] verification: re-reading blocks ${anchor.number + 1n}…${head.number} by hash on two endpoints and re-applying`);
      try {
        await this.reapplyFrom(anchor.number + 1n, new Map(), 'verification', true);
      } catch (error) {
        this.recordError('verification repair', error);
      }
      if ((await this.verifyHead()) !== false) return;
    }
    await this.rebuild(await this.reader.latestHeader(), { source: 'backfill', seenAtMs: this.now() }, 'verification');
    if ((await this.verifyHead()) === false) {
      this.verifier.giveUp();
      console.error('[indexer] verification: the chain still disagrees after a rebuild; serving the stream as unverified');
    }
  }

  private async verifyHead(): Promise<boolean | null> {
    const head = this.head();
    return head ? this.verifier.verifyNow(head, this.latestState()) : null;
  }

  /** One eth_call pair at the head's hash: the derived √price and burned amount must equal the chain's. */
  async verifyAgainstChain(): Promise<boolean> {
    return (await this.verifyHead()) === true;
  }

  // ------------------------------------------------------------------------------------------------ finality

  /** Re-reads the safe and finalized tags; publishes a `finality` event when either moved. */
  async refreshFinality(): Promise<void> {
    const next = await this.reader.finality();
    await this.schedule('finality', async () => {
      if (next.safe === this.finality.safe && next.finalized === this.finality.finalized) return;
      this.finality = { safe: next.safe ?? this.finality.safe, finalized: next.finalized ?? this.finality.finalized };
      const view = finalityView(this.views(), this.head()?.number ?? 0n);
      await this.store.setFinality(this.finality, encodeFrame({ type: 'finality', id: this.nextId(), etag: '', event: toJson(view), snapshot: null }));
    });
  }
}
