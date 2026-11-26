import { safeDeferral, type Deferral } from './skips';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { UNKNOWN_INCOME_BOX, incomeCost, type IncomeSnapshot, type IncomeSpend } from './income';
import type { BackupHeaderPath } from './backup-header';

/**
 * The keeper's monitor view (infra/server/monitor/keeper-view.md): the queue, fee, income and drand readings of one
 * tick, for the host monitor to check. Read-only output; nothing here changes what the keeper sends.
 */
export const MONITOR_VIEW_SCHEMA = 'squarehole.monitor-keeper.v1';
/** The monitor refuses a larger file. */
export const MONITOR_VIEW_MAX_BYTES = 4 * 1024 * 1024;

/** One requested drand round as the poster sees it (drand.ts `readRequest`). */
export interface DrandRequestView {
  readonly requestedAt: bigint;
  readonly deadline: bigint;
  readonly usable: boolean;
  readonly silent: boolean;
}
export interface DrandObservation { readonly complete: boolean; readonly requests: readonly DrandRequestView[] }

export interface BackupHeaderCheck {
  readonly checkedAt: bigint;
  readonly block: bigint;
  readonly ok: boolean;
  readonly path: BackupHeaderPath | null;
}

/** What one canonical read saw, beyond the world itself. Set by the chain adapter only when the view is configured. */
export interface MonitorReadings {
  /** No guarded box, discovery or registry read fell back this tick (reverts are answers, not failures). */
  readonly complete: boolean;
  readonly failedReads: number;
  /** The canonical block the reads used (the pending block's parent), read from its own header. Null: unreadable. */
  readonly snapshot: { readonly number: bigint; readonly timestamp: bigint } | null;
  readonly drand: DrandObservation;
  /** Last completed box 0 header self-check; independent of candidate read completeness. */
  readonly backupHeader?: BackupHeaderCheck;
}

/** Outstanding work key -> first snapshot block it was seen waiting since the keeper last sent it. Durable. */
export type MonitorQueue = Readonly<Record<string, bigint>>;

/**
 * What happened to one proposed candidate this tick: sent; `none` (the pending simulation found nothing to do);
 * `unknown` (skipped before simulating: fee pause, rate limit or a taken pool slot); `waiting` (work found, or a node
 * error, but deferred by a guard: budget, income cap, gas admission, endpoint, send error).
 */
export type WorkStatus = 'sent' | 'none' | 'unknown' | 'waiting';

export interface QueueTick {
  /** Snapshot height: the pending block's parent. */
  readonly at: bigint;
  /** Pending block number and time, as the plan's backoff uses them. */
  readonly pending: bigint;
  readonly now: bigint;
  readonly complete: boolean;
  readonly outcomes: ReadonlyMap<string, WorkStatus>;
  readonly attempts: Readonly<Record<string, { readonly next: bigint; readonly nextAt?: bigint }>>;
}

/**
 * Next durable queue: deferred work only. A key enters when its simulation found work (or errored) but a guard
 * deferred it, and leaves when a complete read shows no work (its simulation found none, or it was not proposed while
 * out of retry backoff) or when the keeper sends it: served work is not outstanding, and if work remains the next
 * simulation re-adds it at that block. Age is therefore time waited unserved, and a send's retry backoff (hourly for
 * inbox orders, `SH_KEEPER_RETRY_BLOCKS` otherwise) never counts as backlog. Work skipped without a simulation keeps
 * its previous state. A reorg below an entry's block rewinds it to the current snapshot.
 */
export function trackQueue(previous: MonitorQueue | undefined, t: QueueTick): MonitorQueue {
  const next: Record<string, bigint> = {};
  const rewind = (since: bigint) => since > t.at ? t.at : since;
  for (const [key, work] of t.outcomes) {
    const since = previous?.[key];
    if (work === 'none' || work === 'sent') continue;
    if (since !== undefined) next[key] = rewind(since);
    else if (work === 'waiting') next[key] = t.at;
  }
  for (const [key, since] of Object.entries(previous ?? {})) {
    if (t.outcomes.has(key)) continue;
    const a = t.attempts[key];
    const backoff = a !== undefined && (a.next > t.pending || (a.nextAt ?? 0n) > t.now);
    if (t.complete && !backoff) continue;
    next[key] = rewind(since);
  }
  return next;
}

export interface MonitorViewInput {
  readonly deferrals?: readonly Deferral[];
  readonly chainId: number;
  readonly identity: string;
  readonly readings: MonitorReadings;
  readonly maxFeePerGas: bigint;
  readonly queue: MonitorQueue;
  readonly income: IncomeSnapshot | null;
  /** F111 reservations after this tick; starts settle once and leave 24 hours after payment (run.ts `incomeSpend`). */
  readonly incomeSpend: readonly IncomeSpend[];
}

const text = (n: bigint) => n.toString();

/** The view object, every amount a decimal string. Null when the snapshot header is unknown: never relabel time. */
export function buildMonitorView(input: MonitorViewInput) {
  const snap = input.readings.snapshot;
  if (!snap) return null;
  const since = Object.values(input.queue);
  const oldest = since.reduce<bigint | null>((m, b) => m === null || b < m ? b : m, null);
  const boxes = new Map<string, { shareWei: bigint; tipsWei: bigint; spentWei: bigint }>();
  const row = (box: string) => {
    const key = box.toLowerCase();
    const found = boxes.get(key) ?? { shareWei: 0n, tipsWei: 0n, spentWei: 0n };
    boxes.set(key, found);
    return found;
  };
  let unattributed = 0n;
  const income = input.income;
  if (income) for (const [box, credit] of Object.entries(income.boxes)) {
    if (box.toLowerCase() === UNKNOWN_INCOME_BOX) continue;
    const r = row(box); r.shareWei += credit.shareWei; r.tipsWei += credit.tipsWei;
  }
  for (const s of input.incomeSpend) {
    if (s.box.toLowerCase() === UNKNOWN_INCOME_BOX) unattributed += incomeCost(s, income);
    else row(s.box).spentWei += incomeCost(s, income);
  }
  const stamp = { observedAt: text(snap.timestamp), block: text(snap.number) };
  const deferrals = (input.deferrals ?? []).map(s => ({ ...safeDeferral({ ...s }), ...stamp }));
  const valuationFailures = (income?.valuationFailures ?? []).map(s => {
    const safe = safeDeferral({ ...s, job: 'income' });
    return { boxId: safe.boxId, code: safe.code, ...stamp };
  });
  const omitted = [...deferrals, ...valuationFailures].filter(s => s.boxId === 'unknown').length;
  const deferralsComplete = omitted === 0;
  return {
    deferralsComplete,
    deferralsOmitted: String(omitted),
    deferrals: deferrals.filter(s => s.boxId !== 'unknown').map(({ boxId, job, code, observedAt, block }) => ({ boxId, job, code, observedAt, block })),
    valuationFailures: valuationFailures.filter(s => s.boxId !== 'unknown'),
    schema: MONITOR_VIEW_SCHEMA,
    chainId: String(input.chainId),
    identity: input.identity,
    observedAt: text(snap.timestamp),
    block: text(snap.number),
    complete: input.readings.complete && income !== null,
    failedReads: String(input.readings.failedReads),
    ...(input.readings.backupHeader ? { backupHeader: {
      ...input.readings.backupHeader, checkedAt: text(input.readings.backupHeader.checkedAt),
      block: text(input.readings.backupHeader.block),
    } } : {}),
    maxFeePerGasWei: text(input.maxFeePerGas),
    queue: { count: String(since.length), oldestBlock: oldest === null ? null : text(oldest > snap.number ? snap.number : oldest) },
    income: {
      platformWei: text(income?.platformWei ?? 0n),
      unattributedWei: text(unattributed),
      boxes: [...boxes].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([box, r]) => ({
        box, shareWei: text(r.shareWei), tipsWei: text(r.tipsWei), spentWei: text(r.spentWei),
      })),
    },
    drand: {
      complete: input.readings.drand.complete,
      requests: input.readings.drand.requests.map(r => ({
        requestedAt: text(r.requestedAt), deadline: text(r.deadline), usable: r.usable, silent: r.silent,
      })),
    },
  };
}
export type MonitorView = NonNullable<ReturnType<typeof buildMonitorView>>;

/** One line within the size limit: drop diagnostics first, preserving the readings whenever they fit. */
export function encodeMonitorView(view: MonitorView): string {
  const full = JSON.stringify(view) + '\n';
  if (Buffer.byteLength(full) <= MONITOR_VIEW_MAX_BYTES) return full;
  const trimmed = { ...view, deferralsComplete: false, deferrals: [], valuationFailures: [],
    deferralsOmitted: text(BigInt(view.deferralsOmitted) + BigInt(view.deferrals.length) + BigInt(view.valuationFailures.length)) };
  const readings = JSON.stringify(trimmed) + '\n';
  if (Buffer.byteLength(readings) <= MONITOR_VIEW_MAX_BYTES) return readings;
  const legacy = Object.fromEntries(Object.entries(trimmed).filter(([key]) =>
    !['deferrals', 'valuationFailures', 'deferralsComplete', 'deferralsOmitted'].includes(key)));
  const legacyBody = JSON.stringify(legacy) + '\n';
  if (Buffer.byteLength(legacyBody) <= MONITOR_VIEW_MAX_BYTES) return legacyBody;
  return JSON.stringify({ ...trimmed, complete: false, income: { ...view.income, boxes: [] },
    drand: { complete: false, requests: [] } }) + '\n';
}

/** Atomic replace: a private file on the same filesystem, fsync, rename, fsync the directory. */
export function writeMonitorView(file: string, body: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.pending`;
  const fd = openSync(temp, 'wx', 0o600);
  try {
    try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, file);
  } catch (error) {
    // The keeper keeps ticking after a failed write: never leave one stray file per block (a full disk, say).
    rmSync(temp, { force: true });
    throw error;
  }
  const dir = openSync(dirname(file), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

/** What `runTick` returns for the view. */
export interface TickObservation {
  readonly deferrals?: readonly Deferral[];
  readonly readings?: MonitorReadings;
  readonly maxFeePerGas: bigint;
  readonly income: IncomeSnapshot | null;
  readonly incomeSpend: readonly IncomeSpend[];
}

/**
 * Publishes the view of a finished tick. Returns false, writing nothing, when the tick has no readings or no snapshot
 * header: the previous file then ages and the monitor reports it stale. Write errors throw for the caller to log.
 */
export function publishMonitorView(file: string, chainId: number, identity: string,
  out: { readonly state: { readonly monitorQueue?: MonitorQueue }; readonly observed?: TickObservation }): boolean {
  const o = out.observed;
  if (!o?.readings) return false;
  const view = buildMonitorView({ chainId, identity, readings: o.readings, maxFeePerGas: o.maxFeePerGas,
    queue: out.state.monitorQueue ?? {}, income: o.income, incomeSpend: o.incomeSpend, deferrals: o.deferrals });
  if (!view) return false;
  writeMonitorView(file, encodeMonitorView(view));
  return true;
}
