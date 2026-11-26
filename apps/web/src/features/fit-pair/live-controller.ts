/**
 * The live curve's source ladder (docs/design/realtime-chain-data.md § 7; C19, UI-12): the indexer's SSE stream, then
 * its edge-cached snapshot every few seconds, then direct chain reads, then the last good state marked stale. The
 * service is an accelerator only: without it the page still reads the chain, and without both it says so instead of
 * showing zeros or an empty curve (UI-04).
 *
 * Freshness is decided when the view is computed, never assumed:
 * - live: the stream (or a poll) delivered this head, and a new head arrived within `STALE_AFTER_MS` (three slots);
 * - stale: no new head for that long, or the gateway says `stale`;
 * - unverified: the gateway says so, its figures or launch window do not match this market, or its price differs
 *   from a direct chain read at the same block;
 * - direct: the numbers come from our own `eth_call`s at one block (no trades list).
 * While the indexer is stale or unverified and the chain can be read, the page shows the direct read instead.
 *
 * The spot check: while the indexer is used and an RPC exists, the chain is read about once a minute and its √price
 * compared with the indexer's at the same block and hash (every direct read counts, also the fallback's). A match
 * lets the page say the price matched the chain at that block; a difference stops the page trusting the indexer until
 * a later read agrees again. A read at a block the indexer has not reported (or on another fork) decides nothing.
 *
 * Everything with a clock or a socket is injected (`LiveDeps`), so the tests drive time and transports by hand.
 */
import { formatBlock } from './fit-format';
import type { FitMarketTarget } from './fit-target';
import { applyLiveEvent, LIVE_EVENT_TYPES, LiveDataError, mismatchOf, parseLiveEvent, type LiveData, type LiveEvent } from './live-model';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

/** No new head for three slots: stale (the gateway uses 36 s too). */
export const STALE_AFTER_MS = 36_000;
/** How long a dropped stream may try to reconnect before the page polls the snapshot instead. */
export const SSE_GRACE_MS = 10_000;
/** A stream that never delivered anything gets less: the gateway answers in milliseconds when it is up. */
export const SSE_FIRST_GRACE_MS = 4_000;
export const POLL_MS = 3_000;
/** Failed polls in a row before the page reads the chain itself. */
export const POLL_FAILURES_TO_DIRECT = 2;
/** One slot: direct reads follow the chain at its own pace. */
export const DIRECT_MS = 12_000;
/** From polling or direct reads, the stream is tried again this often. */
export const SSE_RETRY_MS = 30_000;
export const TICK_MS = 2_000;
/** How often a live indexer's price is compared with a direct chain read (the first check runs on the first tick). */
export const SPOT_CHECK_MS = 60_000;
/** A chain read at a block the indexer has not reported yet waits this long for it, then decides nothing. */
const SAMPLE_WAIT_MS = 60_000;
/** The gateway's status reason while the indexer rebuilds or fills a gap (packages/indexer/src/gateway/server.ts). */
const GATEWAY_CATCHING_UP = 'catching up';
/** What the page says meanwhile: a wait, shown with the logo loader, not a fault. */
export const CATCHING_UP_REASON = 'The live service is catching up with the chain.';
/** Indexer heads remembered for the spot check (about 13 minutes of blocks). */
const HISTORY_BLOCKS = 64;
/** A reorg notice stays until the head is this many blocks past the replaced block. */
const REORG_NOTICE_BLOCKS = 12n;

/** An EventSource, or the Demo stream that behaves like one. */
export interface StreamLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: { readonly data?: unknown }) => void): void;
  close(): void;
}

export interface SnapshotAnswer {
  readonly status: number;
  readonly etag: string | null;
  /** X-SH-Indexer: live | stale | unverified. */
  readonly indexer: string | null;
  readonly body: string | null;
}

export interface LiveDeps {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Opens the stream; null when there is no stream for this target. */
  openStream: ((url: string) => StreamLike) | null;
  /** GET of the snapshot endpoint; null when there is no indexer. */
  fetchSnapshot: ((url: string, etag: string | null) => Promise<SnapshotAnswer>) | null;
  /** One direct chain read; null when there is no RPC (the demo). */
  readDirect: (() => Promise<LiveData>) | null;
}

export type LiveSource = 'stream' | 'poll' | 'direct';
export type Freshness = 'connecting' | 'live' | 'polling' | 'direct' | 'stale' | 'unverified' | 'unavailable';

export interface ReorgNotice {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly depth: number;
}

export interface LiveView {
  readonly freshness: Freshness;
  /** Where the shown data came from; null when nothing is shown. */
  readonly source: LiveSource | null;
  readonly data: LiveData | null;
  /** The newest head at which the shown data stopped being current (for "Stale since block B"). */
  readonly staleSinceBlock: bigint | null;
  /** Plain reason for stale, unverified, direct or unavailable. */
  readonly reason: string | null;
  readonly reorg: ReorgNotice | null;
  /** The transport currently tried (for the chip's hint). */
  readonly transport: 'stream' | 'poll' | 'direct' | 'none';
  /** While the indexer's data is shown: the newest block at which its √price matched a direct chain read, else null. */
  readonly checkedBlock: bigint | null;
  /** The reason shown is the live service catching up (a rebuild or a long gap): a wait, not a fault. */
  readonly catchingUp: boolean;
}

const INITIAL: LiveView = Object.freeze({ freshness: 'connecting', source: null, data: null, staleSinceBlock: null, reason: null, reorg: null, transport: 'none', checkedBlock: null, catchingUp: false });

export function streamUrl(target: FitMarketTarget): string | null {
  return target.indexerOrigin === null ? null : `${target.indexerOrigin}/v1/pools/${target.chainId}/${target.poolId.toLowerCase()}/stream`;
}

export function snapshotUrl(target: FitMarketTarget): string | null {
  return target.indexerOrigin === null ? null : `${target.indexerOrigin}/v1/pools/${target.chainId}/${target.poolId.toLowerCase()}/snapshot`;
}

const sameView = (a: LiveView, b: LiveView): boolean =>
  a.freshness === b.freshness &&
  a.source === b.source &&
  a.data === b.data &&
  a.staleSinceBlock === b.staleSinceBlock &&
  a.reason === b.reason &&
  a.reorg === b.reorg &&
  a.transport === b.transport &&
  a.checkedBlock === b.checkedBlock &&
  a.catchingUp === b.catchingUp;

export class LivePoolController {
  private readonly target: FitMarketTarget;
  private readonly deps: LiveDeps;
  private readonly listeners = new Set<() => void>();
  private view: LiveView = INITIAL;
  private running = false;

  private mode: 'stream' | 'poll' | 'direct' | 'none' = 'none';
  private stream: StreamLike | null = null;
  private streamErrorAt: number | null = null;
  private lastStreamAttemptAt = 0;
  private lastStreamFrameAt = 0;
  private pollFailures = 0;
  /** Bumped whenever a poll loop starts or is replaced: a fetch of an older loop schedules nothing. */
  private pollGeneration = 0;
  private etag: string | null = null;

  private indexer: LiveData | null = null;
  private indexerHeadAt = 0;
  private indexerStatus: 'live' | 'stale' | 'unverified' | null = null;
  private indexerReason: string | null = null;
  private protocolProblem: string | null = null;

  private direct: LiveData | null = null;
  private directAt = 0;
  private directFailed: string | null = null;
  private directBusy = false;
  private directTimer: unknown = null;

  private pollTimer: unknown = null;
  private tickTimer: unknown = null;
  private reorg: ReorgNotice | null = null;

  /** The indexer's head states by block: hash and √price (the spot check's reference). */
  private readonly history = new Map<bigint, { readonly hash: string; readonly sqrtPriceX96: bigint }>();
  /** The newest direct read not yet compared (its block may still be ahead of the indexer). */
  private sample: { readonly block: bigint; readonly hash: string; readonly sqrtPriceX96: bigint; readonly at: number } | null = null;
  private chainCheck: { readonly status: 'match' | 'mismatch'; readonly block: bigint } | null = null;
  private lastSpotAt = Number.NEGATIVE_INFINITY;

  constructor(target: FitMarketTarget, deps: LiveDeps) {
    this.target = target;
    this.deps = deps;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): LiveView => this.view;

  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.deps.openStream && streamUrl(this.target)) this.openStream();
    else if (DEMO_BUILD && this.deps.openStream && this.target.kind === 'demo') this.openStream();
    else if (this.deps.fetchSnapshot && snapshotUrl(this.target)) this.startPolling();
    else this.startDirect();
    this.scheduleTick();
    this.publish();
  }

  stop(): void {
    this.running = false;
    this.pollGeneration += 1;
    this.closeStream();
    this.clear('pollTimer');
    this.clear('directTimer');
    this.clear('tickTimer');
  }

  // ---------------------------------------------------------------------------------------------- stream

  private openStream(): void {
    const open = this.deps.openStream;
    if (!open) return;
    this.closeStream();
    this.clear('pollTimer');
    this.pollGeneration += 1;
    this.mode = 'stream';
    this.streamErrorAt = null;
    this.lastStreamAttemptAt = this.deps.now();
    let stream: StreamLike;
    try {
      stream = open(streamUrl(this.target) ?? (DEMO_BUILD ? 'demo:' : ''));
    } catch {
      this.streamFailed();
      return;
    }
    this.stream = stream;
    for (const type of LIVE_EVENT_TYPES) {
      stream.addEventListener(type, (event) => {
        if (this.stream !== stream) return;
        this.onFrame(type, event.data);
      });
    }
    stream.addEventListener('open', () => {
      if (this.stream === stream) this.streamErrorAt = null;
    });
    stream.addEventListener('error', () => {
      if (this.stream !== stream) return;
      // CLOSED (2): the browser gave up (an HTTP error or a wrong content type). CONNECTING (0): it retries by itself.
      if (stream.readyState === 2) this.streamFailed();
      else this.streamErrorAt ??= this.deps.now();
      this.publish();
    });
  }

  private closeStream(): void {
    const stream = this.stream;
    this.stream = null;
    if (stream) {
      try {
        stream.close();
      } catch {
        // already closed
      }
    }
  }

  private streamFailed(): void {
    this.closeStream();
    if (this.deps.fetchSnapshot && snapshotUrl(this.target)) this.startPolling();
    else this.startDirect();
  }

  private onFrame(type: string, raw: unknown): void {
    if (typeof raw !== 'string') return;
    let event: LiveEvent;
    try {
      event = parseLiveEvent(type, raw, this.target);
    } catch (error) {
      // A frame we cannot trust: drop the stream and read the snapshot (or the chain) instead.
      this.protocolProblem = error instanceof LiveDataError ? error.message : 'The live service sent data that could not be read.';
      this.streamFailed();
      this.publish();
      return;
    }
    this.streamErrorAt = null;
    this.lastStreamFrameAt = this.deps.now();
    this.protocolProblem = null;
    this.apply(event);
    this.publish();
  }

  private apply(event: LiveEvent): void {
    if (event.type === 'status') {
      this.indexerStatus = event.indexer;
      this.indexerReason = event.reason;
      return;
    }
    const before = this.indexer;
    const next = applyLiveEvent(before, event);
    if (next === null) return;
    if (event.type === 'reorg') {
      this.reorg = Object.freeze({ fromBlock: event.fromBlock, toBlock: event.toBlock, depth: event.depth });
      for (const block of [...this.history.keys()]) if (block > event.toBlock) this.history.delete(block);
    }
    if (before === null || next.head.number !== before.head.number || next.head.hash !== before.head.hash) this.indexerHeadAt = this.deps.now();
    if (this.reorg && next.head.number >= this.reorg.fromBlock + REORG_NOTICE_BLOCKS) this.reorg = null;
    this.indexer = next;
    this.remember(next);
  }

  // ---------------------------------------------------------------------------------------------- spot check

  private remember(data: LiveData): void {
    if (data.state.block !== data.head.number) return;
    this.history.delete(data.head.number);
    this.history.set(data.head.number, Object.freeze({ hash: data.head.hash, sqrtPriceX96: data.state.sqrtPriceX96 }));
    while (this.history.size > HISTORY_BLOCKS) {
      const oldest = this.history.keys().next().value;
      if (oldest === undefined) break;
      this.history.delete(oldest);
    }
    this.compareSample();
  }

  /** Compares the newest direct read with the indexer's state at the same block and hash, when it has one. */
  private compareSample(): void {
    const sample = this.sample;
    if (sample === null) return;
    const seen = this.history.get(sample.block);
    if (seen === undefined) {
      if (this.deps.now() - sample.at > SAMPLE_WAIT_MS) this.sample = null;
      return;
    }
    this.sample = null;
    // Another block at that height (a reorg on either side): nothing to compare.
    if (seen.hash !== sample.hash) return;
    this.chainCheck = Object.freeze({ status: seen.sqrtPriceX96 === sample.sqrtPriceX96 ? 'match' : 'mismatch', block: sample.block });
  }

  private spotDue(now: number): boolean {
    return this.deps.readDirect !== null && this.indexer !== null && !this.directBusy && now - this.lastSpotAt >= SPOT_CHECK_MS;
  }

  private async spotOnce(): Promise<void> {
    this.lastSpotAt = this.deps.now();
    await this.readChain();
    this.publish();
  }

  // ---------------------------------------------------------------------------------------------- polling

  private startPolling(): void {
    this.clear('pollTimer');
    this.pollGeneration += 1;
    this.mode = 'poll';
    this.pollFailures = 0;
    void this.pollOnce(this.pollGeneration);
  }

  /** One snapshot fetch of poll loop `generation`; only the current loop may apply its answer or schedule the next. */
  private async pollOnce(generation: number): Promise<void> {
    const fetchSnapshot = this.deps.fetchSnapshot;
    const url = snapshotUrl(this.target);
    const current = () => this.running && this.mode === 'poll' && this.pollGeneration === generation;
    if (!current() || !fetchSnapshot || !url) return;
    try {
      const answer = await fetchSnapshot(url, this.etag);
      if (!current()) return;
      if (answer.status === 304 && this.indexer) {
        this.pollFailures = 0;
      } else if (answer.status === 200 && answer.body !== null) {
        this.apply(parseLiveEvent('snapshot', answer.body, this.target));
        this.etag = answer.etag;
        this.pollFailures = 0;
        this.protocolProblem = null;
      } else {
        throw new Error(`snapshot HTTP ${answer.status}`);
      }
      const status = answer.indexer;
      if (status === 'live' || status === 'stale' || status === 'unverified') {
        this.indexerStatus = status;
        this.indexerReason = status === 'live' ? null : 'reported by the live service';
      }
    } catch (error) {
      if (!current()) return;
      if (error instanceof LiveDataError) this.protocolProblem = error.message;
      this.pollFailures += 1;
      if (this.pollFailures >= POLL_FAILURES_TO_DIRECT) {
        this.startDirect();
        this.publish();
        return;
      }
    }
    this.publish();
    if (current()) {
      this.pollTimer = this.deps.setTimeout(() => {
        this.pollTimer = null;
        void this.pollOnce(generation);
      }, POLL_MS);
    }
  }

  // ---------------------------------------------------------------------------------------------- direct reads

  private startDirect(): void {
    this.clear('pollTimer');
    this.pollGeneration += 1;
    this.mode = this.deps.readDirect ? 'direct' : 'none';
    this.ensureDirect();
  }

  /** Direct reads run while the page depends on them: in direct mode, or as a check while the indexer is not live. */
  private ensureDirect(): void {
    if (!this.deps.readDirect || this.directTimer !== null || this.directBusy) return;
    void this.directOnce();
  }

  /** One direct read: kept as the fallback's data and as the spot check's sample. */
  private async readChain(): Promise<void> {
    const read = this.deps.readDirect;
    if (!read || !this.running) return;
    this.directBusy = true;
    try {
      const data = await read();
      if (!this.running) return;
      this.direct = data;
      this.directAt = this.deps.now();
      this.directFailed = null;
      this.sample = Object.freeze({ block: data.head.number, hash: data.head.hash, sqrtPriceX96: data.state.sqrtPriceX96, at: this.directAt });
      this.compareSample();
    } catch (error) {
      if (!this.running) return;
      this.directFailed = error instanceof Error && error.message ? error.message : 'The chain could not be read.';
    } finally {
      this.directBusy = false;
    }
  }

  private async directOnce(): Promise<void> {
    if (!this.deps.readDirect || !this.running) return;
    await this.readChain();
    if (!this.running) return;
    this.publish();
    if (this.running && this.needsDirect()) this.directTimer = this.deps.setTimeout(() => {
      this.directTimer = null;
      void this.directOnce();
    }, DIRECT_MS);
  }

  private indexerUsable(now: number): boolean {
    if (this.indexer === null || this.mode === 'direct' || this.mode === 'none') return false;
    if (this.indexerStatus === 'stale' || this.indexerStatus === 'unverified') return false;
    if (mismatchOf(this.indexer) !== null || this.chainCheck?.status === 'mismatch') return false;
    return now - this.indexerHeadAt <= STALE_AFTER_MS;
  }

  private needsDirect(): boolean {
    if (this.deps.readDirect === null) return false;
    if (this.mode === 'direct' || this.mode === 'none') return true;
    const now = this.deps.now();
    // A stream that is still connecting gets its grace period before the chain is read beside it.
    if (this.indexer === null && this.mode === 'stream' && now - this.lastStreamAttemptAt <= SSE_FIRST_GRACE_MS) return false;
    return !this.indexerUsable(now);
  }

  // ---------------------------------------------------------------------------------------------- clock

  private scheduleTick(): void {
    this.tickTimer = this.deps.setTimeout(() => {
      this.tickTimer = null;
      if (!this.running) return;
      this.tick();
      this.scheduleTick();
    }, TICK_MS);
  }

  private tick(): void {
    const now = this.deps.now();
    const grace = this.indexer === null ? SSE_FIRST_GRACE_MS : SSE_GRACE_MS;
    const streamSilent = this.mode === 'stream' && now - Math.max(this.lastStreamAttemptAt, this.lastStreamFrameAt) > (this.indexer === null ? SSE_FIRST_GRACE_MS : STALE_AFTER_MS);
    const streamDown = this.mode === 'stream' && this.streamErrorAt !== null && now - this.streamErrorAt > grace;
    // A demo stream never falls back: it has nowhere to fall back to, and its stale scenario is the point.
    if ((streamSilent || streamDown) && (!DEMO_BUILD || this.target.kind !== 'demo')) this.streamFailed();
    if ((this.mode === 'poll' || this.mode === 'direct') && this.deps.openStream && streamUrl(this.target) && now - this.lastStreamAttemptAt > SSE_RETRY_MS) {
      this.clear('directTimer');
      this.openStream();
    }
    if (this.needsDirect()) this.ensureDirect();
    else {
      this.clear('directTimer');
      if (this.spotDue(now)) void this.spotOnce();
    }
    this.compareSample();
    this.publish();
  }

  private clear(name: 'pollTimer' | 'directTimer' | 'tickTimer'): void {
    const handle = this[name];
    if (handle !== null) this.deps.clearTimeout(handle);
    this[name] = null;
  }

  // ---------------------------------------------------------------------------------------------- view

  private compute(): LiveView {
    const now = this.deps.now();
    const transport = this.mode;
    const reorg = this.reorg;
    const directFresh = this.direct !== null && now - this.directAt <= 2 * DIRECT_MS + 1_000;
    if (this.indexerUsable(now) && this.indexer) {
      const checkedBlock = this.chainCheck?.status === 'match' ? this.chainCheck.block : null;
      return { freshness: this.mode === 'poll' ? 'polling' : 'live', source: this.mode === 'poll' ? 'poll' : 'stream', data: this.indexer, staleSinceBlock: null, reason: null, reorg, transport, checkedBlock, catchingUp: false };
    }
    const indexerProblem = this.indexerProblem(now);
    if (directFresh && this.direct) {
      const mismatch = mismatchOf(this.direct);
      const reason = mismatch ?? indexerProblem ?? (this.target.indexerOrigin === null ? 'No live service is configured for this market.' : 'The live service cannot be reached.');
      return {
        freshness: mismatch ? 'unverified' : 'direct',
        source: 'direct',
        data: this.direct,
        staleSinceBlock: null,
        reason,
        reorg: null,
        transport,
        checkedBlock: null,
        catchingUp: reason === CATCHING_UP_REASON,
      };
    }
    if (this.indexer) {
      const unverified = this.indexerStatus === 'unverified' || mismatchOf(this.indexer) !== null || this.chainCheck?.status === 'mismatch';
      return {
        freshness: unverified ? 'unverified' : 'stale',
        source: this.mode === 'poll' ? 'poll' : 'stream',
        data: this.indexer,
        staleSinceBlock: unverified ? null : this.indexer.head.number,
        reason: indexerProblem,
        reorg,
        transport,
        checkedBlock: null,
        catchingUp: indexerProblem === CATCHING_UP_REASON,
      };
    }
    if (this.direct) {
      return {
        freshness: 'stale',
        source: 'direct',
        data: this.direct,
        staleSinceBlock: this.direct.head.number,
        reason: this.directFailed ?? 'The chain has not been read again.',
        reorg: null,
        transport,
        checkedBlock: null,
        catchingUp: false,
      };
    }
    const tried = this.mode === 'none' || (this.mode === 'direct' && this.directFailed !== null) || (this.mode === 'direct' && !this.deps.readDirect);
    if (tried) {
      const nothing = this.target.indexerOrigin === null && !this.deps.readDirect;
      const reason = nothing
        ? 'This market has no live service and no RPC to read.'
        : `Neither the live service nor the chain answered${this.directFailed ? ` (${this.directFailed.replace(/\.$/, '')})` : ''}.`;
      return { freshness: 'unavailable', source: null, data: null, staleSinceBlock: null, reason, reorg: null, transport, checkedBlock: null, catchingUp: false };
    }
    return { ...INITIAL, transport };
  }

  private indexerProblem(now: number): string | null {
    if (this.chainCheck?.status === 'mismatch') return `The live service’s price at block ${formatBlock(this.chainCheck.block)} differs from the chain’s.`;
    if (this.protocolProblem) return this.protocolProblem;
    if (this.indexer && mismatchOf(this.indexer)) return mismatchOf(this.indexer);
    // The service's own reasons for this state ("the indexer state differs from the chain", "reported by the live
    // service") repeat the sentence, so none is appended.
    if (this.indexerStatus === 'unverified') return 'Live data doesn’t match the chain.';
    if (this.indexerStatus === 'stale' && this.indexerReason === GATEWAY_CATCHING_UP) return CATCHING_UP_REASON;
    if (this.indexerStatus === 'stale') return `The live service reports stale data${this.indexerReason ? `: ${this.indexerReason}` : ''}.`;
    if (this.indexer && now - this.indexerHeadAt > STALE_AFTER_MS) return 'No new block has arrived for more than 36 seconds.';
    // A market without a live service (a record with no indexer) has nothing to reach: the view says it has none.
    if ((this.mode === 'direct' || this.mode === 'none') && this.target.indexerOrigin !== null) return 'The live service cannot be reached.';
    return null;
  }

  private publish(): void {
    const next = this.compute();
    if (sameView(next, this.view)) return;
    this.view = Object.freeze(next);
    for (const listener of [...this.listeners]) listener();
  }
}
