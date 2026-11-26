/**
 * SH-BOX-LIFE-VIEW § 2: the box's history, live and polite. A controller reads the activity route's newest items:
 * - when something happened in the box: the snapshot (the page re-reads it every 4 s while the tab is visible) shows
 *   its figures moved (`figuresSignatureV2`: trades, price, supply, burns, holders, the raise, the life state, the
 *   buy-backs, the claim pot). The snapshot's block alone says nothing about the box: it is the indexer's head, which
 *   moves every block, so a new block alone reads nothing. When the read after a move shows nothing new yet (the history
 *   writer can lag the snapshot by a moment), it reads again after 1.5, 3 and 6 s;
 * - on its own otherwise: every 15 s, doubling to 60 s while nothing new arrives (events no figure shows, a holder's
 *   transfer or fees collected, arrive this way);
 * - after a failed read: from 2 s, doubling to 60 s, and it says "reconnecting". The back-off stands: neither a new
 *   block nor moved figures read before its retry.
 * Nothing is read while the tab is hidden, also no page back for a newest read that answers after the tab was hidden
 * (fix round 3: the held rows stay as they are); it reads at once, to the end, when the tab is shown again.
 *
 * Never a lost or doubled row: rows are keyed by the indexer's `block-logIndex`; a newest read that does not reach the
 * held rows reads further back (`before`) until it does, at most `maxGapPages` pages, else it replaces them; inside the
 * range a read covers it is the truth (life-activity.ts `mergeNewestV2`). Older held rows stay only where the two runs
 * meet on the same block hash: a read that ends inside a block a reorg replaced reads further back the same way, to a
 * block both hold alike, else its run replaces the held one with its own cursor (fix round 3). Nothing here asks a
 * wallet.
 *
 * Review round 2:
 * - `since` is the block of the first snapshot that showed the box's figures as they are now: a held history read at or
 *   after it answers for the snapshot (holdersV2), so the holders show as soon as their pages are read, never held back
 *   for a new head alone;
 * - while the holders' tab is open the box's whole history is read back (`wantHistory`), also when the tab opened before
 *   the first read answered, and a failed page is read again on the error back-off;
 * - a new row flashes once: once the page has shown it for its flash (`shown`), it is no longer new.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { Fetcher } from '../core-client';
import type { V2Source, V2Snapshot } from './indexer-v2';
import { appendOlderV2, EMPTY_ACTIVITY_V2, mergeNewestV2, parseActivityPageV2, replaceNewestV2, type ActivityPageV2, type ActivityStoreV2 } from './life-activity';

export type LifeLiveStatusV2 = 'loading' | 'live' | 'reconnecting' | 'paused' | 'unavailable';

export interface LifeActivityStateV2 {
  readonly store: ActivityStoreV2;
  readonly status: LifeLiveStatusV2;
  /** An older page is being read (Show more, or the history for the holders). */
  readonly loadingMore: boolean;
  /**
   * Ids that arrived while the page was open (after the first read) and are still new, newest last; at most 64. A row
   * stops being new once the page has shown it for its flash (`shown`).
   */
  readonly arrived: readonly string[];
  /**
   * The block of the first snapshot that showed the box's figures as they are now (`signal`); null before the first.
   * The snapshot's own block is the indexer's head, which moves every block whatever the box does: a history whose newest
   * read is not older than `since` shows the box as the snapshot does (holdersV2).
   */
  readonly since: bigint | null;
  /** The holders want the whole history and it is not all held yet: an older page is due, in flight or read again soon. */
  readonly readingHistory: boolean;
}

export interface LifeActivityOptionsV2 {
  /** Items per newest read. */
  readonly livePage?: number;
  /** Items per older page. */
  readonly olderPage?: number;
  /** Older pages a newest read may add to reach the held rows. */
  readonly maxGapPages?: number;
  /** Older pages read for the holders' whole history, each time their tab opens. */
  readonly historyPages?: number;
  readonly idleMs?: readonly [number, number];
  readonly errorMs?: readonly [number, number];
  readonly soonMs?: readonly number[];
  /** How long a new row's arrival flash runs (life-view.css `sh-life-arrive`, 2.4 s). */
  readonly flashMs?: number;
}

const DEFAULTS: Required<LifeActivityOptionsV2> = { livePage: 50, olderPage: 200, maxGapPages: 8, historyPages: 5, idleMs: [15_000, 60_000], errorMs: [2_000, 60_000], soonMs: [1_500, 3_000, 6_000], flashMs: 2_400 };
const ARRIVED_KEPT = 64;

export class LifeActivityControllerV2 {
  private state: LifeActivityStateV2 = { store: EMPTY_ACTIVITY_V2, status: 'loading', loadingMore: false, arrived: [], since: null, readingHistory: false };
  private readonly listeners = new Set<() => void>();
  private readonly options: Required<LifeActivityOptionsV2>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private visible = true;
  /** Bumped by stop(): a read that started before is ignored when it ends. */
  private generation = 0;
  private reading = false;
  private again = false;
  private failures = 0;
  private idleRounds = 0;
  private soon: number[] = [];
  /** Moves of the figures seen so far: a read tells a move made while it ran from one made before it. */
  private moves = 0;
  private lastBlock: bigint | null = null;
  private lastFigures: string | null = null;
  private olderReading = false;
  /** The holders' tab is open: the whole history is wanted. */
  private historyWanted = false;
  /** Older pages the holders may still read since their tab opened. */
  private historyLeft = 0;
  /** Failed older pages in a row: the history's retry waits on the error back-off. */
  private historyFailures = 0;
  private historyTimer: ReturnType<typeof setTimeout> | null = null;
  /** New rows the page has shown, and the timers that end their flash. */
  private readonly shownIds = new Set<string>();
  private readonly shownTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly url: string, private readonly fetcher: Fetcher, options: LifeActivityOptionsV2 = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getState = (): LifeActivityStateV2 => this.state;

  private set(next: Partial<LifeActivityStateV2>): void {
    const state = { ...this.state, ...next };
    const readingHistory = this.historyWanted && state.store.loaded && state.store.next !== null && (this.historyLeft > 0 || this.olderReading);
    this.state = { ...state, readingHistory };
    for (const listener of this.listeners) listener();
  }

  start(visible: boolean): void {
    this.running = true;
    this.visible = visible;
    if (visible) void this.readNewest();
    else this.set({ status: this.state.store.loaded ? 'paused' : this.state.status });
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    this.reading = false;
    this.again = false;
    this.olderReading = false;
    this.clear();
    this.clearHistory();
    // Rows already shown are no longer new, whether their flash timer ran or not (no listener is told: the page has gone).
    if (this.shownIds.size > 0) this.state = { ...this.state, arrived: this.state.arrived.filter((id) => !this.shownIds.has(id)) };
    for (const timer of this.shownTimers) clearTimeout(timer);
    this.shownTimers.clear();
    this.shownIds.clear();
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (!this.running) return;
    if (!visible) {
      this.clear();
      this.clearHistory();
      this.set({ status: 'paused' });
      return;
    }
    this.idleRounds = 0;
    void this.readNewest();
    this.pumpHistory();
  }

  /**
   * The box's snapshot was read again (`block`, its figures' signature `figures`). Only moved figures read now: the
   * block alone is the indexer's head, which moves every block whatever the box does, so the idle poll's back-off goes
   * on. A read after a move that finds nothing new is retried soon (1.5, 3, 6 s). While reads fail, the error back-off's
   * retry comes first; the soon retries follow it. An older snapshot than one already seen (a late answer) says nothing.
   * The first snapshot and every move set `since`.
   */
  signal(block: bigint, figures: string): void {
    if (this.lastBlock !== null && block < this.lastBlock) return;
    const first = this.lastBlock === null;
    this.lastBlock = block;
    const moved = !first && figures !== this.lastFigures;
    this.lastFigures = figures;
    if (first || moved) this.set({ since: block });
    if (!moved || !this.running) return;
    this.moves += 1;
    this.soon = [...this.options.soonMs];
    this.idleRounds = 0;
    if (this.visible && this.failures === 0) void this.readNewest();
  }

  /** Show more: the next older page. */
  loadMore(): Promise<void> {
    return this.readOlder(false);
  }

  /**
   * The holders' tab opened (`on`) or closed. While it is open the box's whole history is read back, at most
   * `historyPages` older pages each time it opens: at once when the newest rows are held, else as soon as the first read
   * answers; a page that fails is read again on the error back-off (2 s, doubling to 60 s). Closed, no further page.
   */
  readonly wantHistory = (on: boolean): void => {
    if (on === this.historyWanted) return;
    this.historyWanted = on;
    this.clearHistory();
    if (on) {
      this.historyLeft = this.options.historyPages;
      this.historyFailures = 0;
    }
    this.set({});
    this.pumpHistory();
  };

  /**
   * The page shows these new rows (their arrival flashes): once the flash has run they are no longer new, so a row shown
   * again later (after a tab switch, say) does not flash again. A new row not shown yet stays new.
   */
  readonly shown = (ids: readonly string[]): void => {
    const waiting = new Set(this.state.arrived);
    const fresh = ids.filter((id) => waiting.has(id) && !this.shownIds.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) this.shownIds.add(id);
    const timer = setTimeout(() => {
      this.shownTimers.delete(timer);
      const done = new Set(fresh);
      for (const id of fresh) this.shownIds.delete(id);
      this.set({ arrived: this.state.arrived.filter((id) => !done.has(id)) });
    }, this.options.flashMs);
    this.shownTimers.add(timer);
  };

  private clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private clearHistory(): void {
    if (this.historyTimer !== null) clearTimeout(this.historyTimer);
    this.historyTimer = null;
  }

  /** The holders' next history page, when one is due (none while another older page is out or a retry waits). */
  private pumpHistory(): void {
    const store = this.state.store;
    if (!this.running || !this.visible || !this.historyWanted || this.historyTimer !== null || this.olderReading) return;
    if (!store.loaded || store.next === null || this.historyLeft <= 0) return;
    this.historyLeft -= 1;
    void this.readOlder(true);
  }

  private schedule(ms: number): void {
    this.clear();
    if (!this.running || !this.visible) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.readNewest();
    }, ms);
  }

  private async page(query: string): Promise<ActivityPageV2> {
    const reply = await this.fetcher(`${this.url}?${query}`);
    if (!reply.ok) throw new Error(`Activity unavailable (${reply.status})`);
    return parseActivityPageV2(await reply.json());
  }

  private async readNewest(): Promise<void> {
    if (!this.running || !this.visible) return;
    if (this.reading) {
      this.again = true;
      return;
    }
    this.reading = true;
    this.clear();
    const generation = this.generation;
    const moves = this.moves;
    let answered = false;
    try {
      let fresh = await this.page(`limit=${this.options.livePage}`);
      if (generation !== this.generation) return;
      let merged = mergeNewestV2(this.state.store, fresh);
      // More new items than one read carried (or a reorg across its boundary): read further back until the run joins
      // the held one.
      for (let i = 0; !merged.reached && i < this.options.maxGapPages && fresh.next !== null; i += 1) {
        // Never a page back while the tab is hidden (fix round 3): the held rows stay as they are, one run with no hole,
        // and the chip says Paused; shown again, the tab reads the refresh to its end (setVisible).
        if (!this.running || !this.visible) {
          this.failures = 0;
          this.set({ status: 'paused' });
          return;
        }
        const older = await this.page(`limit=${this.options.olderPage}&before=${fresh.next}`);
        if (generation !== this.generation) return;
        fresh = { asOfBlock: fresh.asOfBlock, items: [...fresh.items, ...older.items], next: older.next };
        merged = mergeNewestV2(this.state.store, fresh);
      }
      // Merged against the rows held now (an older page may have joined meanwhile), with no await before the update.
      const held = this.state.store;
      const final = mergeNewestV2(held, fresh);
      const store = final.reached ? final.store : replaceNewestV2(fresh);
      const known = new Set(held.items.map((item) => item.id));
      const fresher = held.loaded ? store.items.filter((item) => !known.has(item.id)).map((item) => item.id).reverse() : [];
      answered = true;
      this.failures = 0;
      // A read that ends after the tab was hidden keeps its rows; the chip still says Paused.
      this.set({ store, status: this.visible ? 'live' : 'paused', arrived: [...this.state.arrived, ...fresher].slice(-ARRIVED_KEPT) });
      // The holders may have asked for the history before the first read answered.
      this.pumpHistory();
      if (fresher.length > 0) {
        this.idleRounds = 0;
        // The rows of a move made while this read ran may not be among them: its soon retries stay.
        if (this.moves === moves) this.soon = [];
      }
      const retry = fresher.length === 0 ? this.soon.shift() : undefined;
      if (retry !== undefined) this.schedule(retry);
      else {
        const [min, max] = this.options.idleMs;
        this.schedule(Math.min(max, min * 2 ** this.idleRounds));
        this.idleRounds += 1;
      }
    } catch {
      if (generation !== this.generation) return;
      this.failures += 1;
      const [min, max] = this.options.errorMs;
      this.set({ status: !this.visible && this.state.store.loaded ? 'paused' : this.state.store.loaded ? 'reconnecting' : this.failures >= 3 ? 'unavailable' : 'loading' });
      this.schedule(Math.min(max, min * 2 ** (this.failures - 1)));
    } finally {
      if (generation === this.generation) {
        this.reading = false;
        const again = this.again;
        this.again = false;
        // Asked again while this read ran (moved figures, the tab shown): once more now. After a failure the back-off's
        // retry reads instead.
        if (again && answered) void this.readNewest();
      }
    }
  }

  /** One older page (`forHistory`: one of the holders' pages, which a failure gives back for its retry). */
  private async readOlder(forHistory: boolean): Promise<void> {
    const store = this.state.store;
    if (!this.running || this.olderReading || !store.loaded || store.next === null) return;
    this.olderReading = true;
    this.set({ loadingMore: true });
    const generation = this.generation;
    const before = store.next;
    // The run's last item as the page is asked for: a page asked for below another one (a reorg that kept the id) is stale.
    const tail = store.items.at(-1);
    let failed = false;
    try {
      const page = await this.page(`limit=${this.options.olderPage}&before=${before}`);
      if (generation !== this.generation) return;
      this.historyFailures = 0;
      const joined = appendOlderV2(this.state.store, before, page, tail);
      // A page dropped as stale (the run changed while it was out: a burst past the whole run, a reorg) read none of the
      // history: a holders' page is given back, so the history still reads to its end. Bounded: a drop needs a change.
      if (forHistory && joined === this.state.store) this.historyLeft += 1;
      this.set({ store: joined });
    } catch {
      // Show more can be pressed again; the holders' history reads its page again on the error back-off.
      failed = true;
    } finally {
      if (generation === this.generation) {
        this.olderReading = false;
        // A failed holders' page read no history: give its page back whatever the tab does meanwhile (a page that fails
        // while the tab is hidden would otherwise be lost for good); only the retry waits for a visible, wanted run.
        if (failed && forHistory) this.historyLeft += 1;
        if (failed && this.historyWanted && this.running && this.visible) {
          this.historyFailures += 1;
          const [min, max] = this.options.errorMs;
          this.clearHistory();
          this.historyTimer = setTimeout(() => {
            this.historyTimer = null;
            this.pumpHistory();
          }, Math.min(max, min * 2 ** (this.historyFailures - 1)));
        }
        this.set({ loadingMore: false });
        this.pumpHistory();
      }
    }
  }
}

/**
 * What moved in a snapshot, for `signal`: the figures a trade or a box event changes (trades, price, supply, burns,
 * holders, the raise, buy-backs, the claim pot and the coins left) and the life state. Never the block, its time or a
 * figure that moves with the clock alone (the 24 h volume, the hours).
 */
export function figuresSignatureV2(view: V2Snapshot): string {
  const s = view.statistics;
  return [s?.tradeCount, s?.pricePPerTX18, s?.totalSupplyT, s?.burnedT, s?.holderCount, s?.raiseProgress?.raisedP, view.closedAt, view.graduated, view.failed?.at, view.gate.open,
    view.buyBack.pSpent, view.buyBack.tBought, view.buyBack.tBurned, view.closing?.pot, view.closing?.tLeft]
    .map((v) => (v === undefined || v === null ? '' : String(v))).join('|');
}

const visibleNow = (): boolean => typeof document === 'undefined' || document.visibilityState !== 'hidden';
/** The route answers `no-store`; the global fetch is called on its own (never as a method of the controller). */
const activityFetch: Fetcher = (url) => fetch(url);

/** The box's activity, live while the tab is visible (see the header). `fetcher` and `options`: test seams (stable references). */
export function useLifeActivityV2(source: V2Source, view: V2Snapshot, fetcher: Fetcher = activityFetch, options?: LifeActivityOptionsV2) {
  const url = `${source.origin}/v2/boxes/${source.manifest.chainId}/${view.token.toLowerCase()}/activity`;
  const controller = useMemo(() => new LifeActivityControllerV2(url, fetcher, options), [url, fetcher, options]);
  useEffect(() => {
    controller.start(visibleNow());
    const onVisibility = () => controller.setVisible(visibleNow());
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      controller.stop();
    };
  }, [controller]);
  const figures = figuresSignatureV2(view);
  useEffect(() => controller.signal(view.block, figures), [controller, view.block, figures]);
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  return { ...state, loadMore: () => void controller.loadMore(), wantHistory: controller.wantHistory, shown: controller.shown };
}

/** What the activity card takes: the live state and its three requests. */
export type LifeActivityV2 = LifeActivityStateV2 & { loadMore(): void; wantHistory(on: boolean): void; shown(ids: readonly string[]): void };
