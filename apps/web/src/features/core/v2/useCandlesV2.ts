/**
 * SH-BOX-CANDLES: the chart's reads. One request per box and step, the server's ready-made answer (candles-v2.ts), kept
 * in the app's query cache: switching steps, or coming back to the box, costs no request while the answer is fresh,
 * and an answer is fresh while the box's figures stand as they were when it was read (`figuresSignatureV2`).
 *
 * At the life view's cadence and politeness (useLifeActivity.ts): the page reads the snapshot every 4 s while the tab is
 * visible; a step without an answer for the box's figures as they stand (none yet, or one read before they moved) is
 * read, and, while an answer read after a move shows nothing new, at most three times more, 1.5, 3 and 6 s apart
 * (`CatchUpV2`: the history writer can lag the snapshot). Every such read is charged before it starts to its query key
 * and figures, for the query client's lifetime (`CandleReadBudgetV2`, fix round 2, F2): a first read and three re-reads
 * at most, whatever hides the tab, switches the step or leaves the page in between. No polling loop of its own: without
 * a move nothing is read again, however long the page stays open. No other host, and nothing while the tab is hidden. A
 * read the chart no longer needs (another box or step, the tab hidden, the page gone) is cancelled, its fetch aborted; a
 * finished answer stays in the cache. The browser's HTTP cache stays on (the route answers `public, max-age=1` with a
 * weak ETag and 304 when nothing changed): no cache-busting parameter, never `no-store`. A failed read, or a step whose
 * reads are spent without an answer, shows the step unavailable until the figures move again or its button is pressed
 * again (a press is the visitor's own read, never charged).
 *
 * Max picks its step from the box's age (candles-v2.ts `maxStepV2`): from the start of the snapshot's first hourly
 * candle when those hours hold every trade, else from the box's first daily candle (one read of its 1d step, the same
 * cached answer the 1d button shows).
 */
import { queryOptions, useQuery, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { INDEXER_DEADLINE_MS, type Fetcher } from '../core-client';
import { withDeadline } from '../deadline';
import { boxStartV2, candlesUrlV2, maxStepV2, parseCandlesV2, type CandleAnswerV2, type CandleChoiceV2, type CandleStepV2 } from './candles-v2';
import type { V2Snapshot, V2Source } from './indexer-v2';
import { figuresSignatureV2 } from './useLifeActivity';

/** One read of a step: the answer, or the failure (its HTTP status when there was one), and the figures it was read for. */
export type CandleReadV2 =
  | { readonly ok: true; readonly answer: CandleAnswerV2; readonly readFor: string }
  | { readonly ok: false; readonly status: number | null; readonly readFor: string };

/** The re-reads after moved figures while the answer shows nothing new (useLifeActivity.ts `soonMs`). */
export const CANDLE_SOON_MS: readonly number[] = Object.freeze([1_500, 3_000, 6_000]);
/** How long an answer nobody shows stays in the cache. */
export const CANDLE_CACHE_MS = 30 * 60_000;

type SourceKey = Pick<V2Source, 'network' | 'manifest' | 'origin'>;
export const candlesKeyV2 = (source: SourceKey, token: string, step: CandleStepV2, limit: number) =>
  ['v2-candles', source.network, source.manifest.chainId, source.origin, token.toLowerCase(), step, limit] as const;

class CandleReplyError extends Error {
  constructor(readonly status: number) {
    super(`Candles unavailable (${status})`);
  }
}

/** The page's read: fetch with the browser's HTTP cache as the route sets it. */
const candleFetch: Fetcher = (url, init) => fetch(url, init?.signal ? { signal: init.signal } : undefined);

/**
 * One step's query: never stale by time (it is read again only when the figures move), never retried on its own, kept
 * for half an hour unused. A failed read is an answer too (the step shows unavailable); a cancelled one is not: it
 * throws, so react-query keeps what the cache held before it, and its fetch is aborted (react-query's signal, passed on
 * with the indexer deadline).
 */
export function candleQueryV2(source: SourceKey, token: string, step: CandleStepV2, limit: number, readFor: string, fetcher: Fetcher = candleFetch) {
  return queryOptions({
    queryKey: candlesKeyV2(source, token, step, limit),
    queryFn: async ({ signal }): Promise<CandleReadV2> => {
      try {
        const answer = await withDeadline(INDEXER_DEADLINE_MS, signal, async (deadline) => {
          const reply = await fetcher(candlesUrlV2(source.origin, source.manifest.chainId, token, step, limit), { signal: deadline });
          if (!reply.ok) throw new CandleReplyError(reply.status);
          return parseCandlesV2(await reply.json(), step, limit);
        });
        return { ok: true, answer, readFor };
      } catch (error) {
        if (signal.aborted) throw error;
        return { ok: false, status: error instanceof CandleReplyError ? error.status : null, readFor };
      }
    },
    staleTime: Infinity,
    gcTime: CANDLE_CACHE_MS,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

/** What tells a newer answer from the one held: its length and its last candle (a new candle, or the last one moved). */
export function readSignatureV2(read: CandleReadV2): string {
  if (!read.ok) return `failed:${read.status}`;
  const last = read.answer.candles.at(-1);
  return last ? `${read.answer.candles.length}:${last.start}:${last.open}:${last.high}:${last.low}:${last.close}:${last.volumeP}:${last.trades}` : '0';
}

/** The reads one step's query may make unasked for one set of figures: a first read and the three re-reads. */
export const CANDLE_READS_PER_FIGURES = 1 + CANDLE_SOON_MS.length;

/** A read's account: its whole query key (host, chain, box, step, limit) and the figures it is read for. */
export const candleReadIdV2 = (key: QueryKey, figures: string): string => `${JSON.stringify(key)}|${figures}`;

/**
 * The unasked reads charged so far, per query key and figures, for the query client's lifetime (fix round 2, F2): a
 * hidden tab, another step and back, or the page left and opened again keep the count, so nothing refills it. Only the
 * cache letting a query go (30 min after its last observer, `CANDLE_CACHE_MS`) takes that query's counts with it: its
 * answer is gone too, and the read that brings it back is a first one again. A press of a step's button (`retry`) is
 * the visitor's own read and is never charged.
 */
export class CandleReadBudgetV2 {
  private readonly used = new Map<string, number>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly reads: number = CANDLE_READS_PER_FIGURES) {}

  /** For `useSyncExternalStore`: told when a count reaches its end or goes. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  usedBy(id: string): number {
    return this.used.get(id) ?? 0;
  }

  spent(id: string): boolean {
    return this.usedBy(id) >= this.reads;
  }

  /** Charges one read of `id` before it starts; false, and nothing charged, once its reads are spent. */
  charge(id: string): boolean {
    const used = this.usedBy(id);
    if (used >= this.reads) return false;
    this.used.set(id, used + 1);
    if (used + 1 >= this.reads) this.tell();
    return true;
  }

  /** Every count of one query (`JSON.stringify` of its key), whatever the figures: the cache let it go. */
  forget(key: string): void {
    let gone = false;
    for (const id of [...this.used.keys()]) {
      if (!id.startsWith(`${key}|`)) continue;
      this.used.delete(id);
      gone = true;
    }
    if (gone) this.tell();
  }

  private tell(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

const budgets = new WeakMap<QueryClient, CandleReadBudgetV2>();

/** The query client's own budget, made on first use, its counts going with the candle queries the cache lets go. */
export function candleReadBudgetV2(client: QueryClient): CandleReadBudgetV2 {
  const known = budgets.get(client);
  if (known) return known;
  const budget = new CandleReadBudgetV2();
  budgets.set(client, budget);
  client.getQueryCache().subscribe((event) => {
    if (event.type === 'removed' && event.query.queryKey[0] === 'v2-candles') budget.forget(JSON.stringify(event.query.queryKey));
  });
  return budget;
}

/**
 * One run of unasked reads of one query for one set of figures (`id`, `candleReadIdV2`): the chart has no answer for the
 * box's figures as they stand, none yet or one read before they moved (`before`, that answer's signature; null for none).
 *
 * Why the re-reads: the snapshot (read every 4 s) can show a trade before the indexer's history writer has stored it, so
 * the read right after a move may still miss it; useLifeActivity.ts reads its rows the same way. Without them the chart
 * would wait for the next move, which on a quiet box may never come.
 *
 * Bound (fix round 2, F2): every read is charged to `id` in the query client's budget before it starts, the first of a
 * run resumed after a stop too, and a run is refused once the budget is spent: a first read and at most three re-reads
 * per query key and figures, whatever stops and starts the run (a hidden tab, another step and back, the page left and
 * opened again). A re-read comes 1.5, 3 or 6 s after the one before (`CANDLE_SOON_MS`) only while the answer shows
 * nothing new against `before`, and is charged when it is set, so one pending when the run stops counts as spent. The
 * run ends at the first answer that differs, fails or is cancelled, and at a first answer when none was held. Nothing
 * starts a run but a missing or outdated answer: no polling.
 */
export class CatchUpV2 {
  private id: string | null = null;
  private stopRun: (() => void) | null = null;

  constructor(private readonly soonMs: readonly number[] = CANDLE_SOON_MS) {}

  running(id: string): boolean {
    return this.id === id;
  }

  /** Stops the run unless it is `id`'s. */
  keepOnly(id: string | null): void {
    if (this.id !== null && this.id !== id) this.stop();
  }

  /** Starts `id`'s run with a read charged to `budget`; false, and nothing read, once `id`'s reads are spent. */
  start(budget: CandleReadBudgetV2, id: string, before: string | null, read: () => Promise<CandleReadV2>): boolean {
    this.stop();
    if (!budget.charge(id)) return false;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = async () => {
      // A cancelled read (its step, its tab or its page went) ends the run like a failed one.
      const next = await read().catch(() => null);
      // Something new, a failed read, or a first answer: the run ends (a failure is read again on a move or a press).
      if (stopped || next === null || !next.ok || before === null || readSignatureV2(next) !== before) return;
      // Nothing new yet: one more read later, charged now.
      const delay = this.soonMs[budget.usedBy(id) - 1];
      if (delay === undefined || !budget.charge(id)) return;
      timer = setTimeout(() => void attempt(), delay);
    };
    this.id = id;
    this.stopRun = () => {
      stopped = true;
      clearTimeout(timer);
    };
    void attempt();
    return true;
  }

  stop(): void {
    this.stopRun?.();
    this.stopRun = null;
    this.id = null;
  }
}

const onVisibility = (listener: () => void) => {
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
};
const isVisible = () => document.visibilityState !== 'hidden';

export interface CandlesV2 {
  /** The step the chart shows (Max's pick); null until it is known. */
  readonly step: CandleStepV2 | null;
  readonly limit: number | null;
  readonly status: 'reading' | 'ready' | 'unavailable';
  readonly answer: CandleAnswerV2 | null;
  /** Reads the shown step again (its button pressed again after a failed read). */
  readonly retry: () => void;
}

/**
 * The candles of `view`'s box at `choice`, the newest `limit` of them (candles-v2.ts `candleLimitV2`: the chart's width
 * decides; null before it is measured, and nothing is read). `fetcher`: a test seam (a stable reference).
 */
export function useCandlesV2(source: V2Source, view: V2Snapshot, choice: CandleChoiceV2, limit: number | null, fetcher?: Fetcher): CandlesV2 {
  const client = useQueryClient();
  const budget = candleReadBudgetV2(client);
  const visible = useSyncExternalStore(onVisibility, isVisible, () => true);
  const figures = figuresSignatureV2(view);
  const token = view.token;
  // The cache's answers, watched only (`enabled: false`): every read is this hook's own run below, or a press.
  // Max: when the box started, from the snapshot's hours; else its first daily candle (the 1d step's own answer).
  const hourStart = choice === 'max' ? boxStartV2(view.statistics) : null;
  const dayKey = limit !== null && choice === 'max' && hourStart === null ? candlesKeyV2(source, token, '1d', limit) : null;
  const startRead = useQuery({ ...candleQueryV2(source, token, '1d', limit ?? 0, figures, fetcher), enabled: false });
  const daySpent = useSyncExternalStore(budget.subscribe, () => dayKey !== null && budget.spent(candleReadIdV2(dayKey, figures)));
  const firstDay = startRead.data?.ok ? startRead.data.answer.candles[0]?.start ?? null : null;
  const start = hourStart ?? firstDay;
  // Max waits for the first day while the cache has no 1d answer, unless its reads are spent and none is running.
  const waiting = dayKey !== null && startRead.data === undefined && (startRead.isFetching || !daySpent);
  const step: CandleStepV2 | null = choice !== 'max' ? choice
    : limit === null ? null
      : start !== null ? maxStepV2(start, view.timestamp, limit)
        // No daily candle (no trade yet), a failed answer or reads spent: the 1d step's own state shows.
        : waiting ? null : '1d';
  const shownKey = step !== null && limit !== null ? candlesKeyV2(source, token, step, limit) : null;
  const shown = useQuery({ ...candleQueryV2(source, token, step ?? '1d', limit ?? 0, figures, fetcher), enabled: false });
  const shownSpent = useSyncExternalStore(budget.subscribe, () => shownKey !== null && budget.spent(candleReadIdV2(shownKey, figures)));

  // The reads this chart needs now, while the tab is visible: the shown step and, while Max waits for it, the box's first
  // day. Any other read it asked for is cancelled (another step, Max no longer waiting even though its 1d observer
  // stays, the tab hidden), and all of them go with the page: react-query aborts the fetch and keeps what the cache held
  // before (a finished answer stays; a cancelled read never becomes one).
  const [asked] = useState(() => new Map<string, QueryKey>());
  useEffect(() => {
    const needed = new Map<string, QueryKey>();
    const need = (key: QueryKey) => needed.set(JSON.stringify(key), key);
    if (visible && limit !== null) {
      if (step !== null) need(candlesKeyV2(source, token, step, limit));
      if (choice === 'max' && hourStart === null) need(candlesKeyV2(source, token, '1d', limit));
    }
    for (const [id, key] of asked) {
      if (needed.has(id)) continue;
      void client.cancelQueries({ queryKey: key, exact: true });
      asked.delete(id);
    }
    for (const [id, key] of needed) asked.set(id, key);
  }, [asked, client, source, token, step, limit, choice, hourStart, visible]);
  useEffect(() => () => {
    for (const key of asked.values()) void client.cancelQueries({ queryKey: key, exact: true });
    asked.clear();
  }, [asked, client]);

  // The read the chart needs now, while the tab is visible: the first day while Max waits for it, else the shown step,
  // when the cache holds no answer for the box's figures as they stand (none yet, or one read before a move). One run
  // per query key and figures (`CatchUpV2`), every read in it charged to the query client's budget first.
  const [run] = useState(() => new CatchUpV2());
  const neededKey = !visible ? null : waiting ? dayKey : shownKey;
  const neededStep: CandleStepV2 | null = waiting ? '1d' : step;
  const neededId = neededKey === null ? null : candleReadIdV2(neededKey, figures);
  const heldFor = shown.data?.readFor;
  const dayHeld = startRead.data !== undefined;
  useEffect(() => {
    run.keepOnly(neededId);
    if (neededId === null || neededStep === null || limit === null || run.running(neededId)) return;
    const options = candleQueryV2(source, token, neededStep, limit, figures, fetcher);
    const held = client.getQueryData<CandleReadV2>(options.queryKey);
    if (held !== undefined && held.readFor === figures) return;
    run.start(budget, neededId, held === undefined ? null : readSignatureV2(held), () => client.fetchQuery({ ...options, staleTime: 0 }));
  }, [run, budget, client, source, token, neededId, neededStep, limit, figures, fetcher, heldFor, dayHeld]);
  useEffect(() => () => run.stop(), [run]);

  const read = step === null || limit === null ? undefined : shown.data;
  const retry = () => {
    // A read cancelled meanwhile (the step or the tab went) needs nothing more.
    if (step !== null && limit !== null && visible) client.fetchQuery({ ...candleQueryV2(source, token, step, limit, figures, fetcher), staleTime: 0 }).catch(() => undefined);
  };
  return {
    step,
    limit,
    // No answer: reading, or, once its unasked reads are spent and none is running, unavailable (a press reads it again).
    status: read === undefined ? (shownSpent && !shown.isFetching ? 'unavailable' : 'reading') : read.ok ? 'ready' : 'unavailable',
    answer: read?.ok ? read.answer : null,
    retry,
  };
}
