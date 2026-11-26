import { keccak256, type Hex } from 'viem';
import { z } from 'zod';
import type { KeeperState } from './run';

/**
 * SH-249 (open finding 8.4; CRIT-B findings 1 and 2): every signed transaction is saved, with its signer, nonce, fees,
 * gas, target, reservation, hash and signed bytes, before its first broadcast, and broadcast only from those bytes.
 *
 * Write order for one send (each write is temporary file, fsync, rename, directory fsync):
 *   1. sign in memory (nonce from this record and the mined count; nothing leaves the process);
 *   2. this record: the entry as `signed`;
 *   3. the journal: the reservation, already naming the hash;
 *   4. this record: the entry as `sent`;
 *   5. broadcast the saved bytes.
 * A `signed` entry was never broadcast. On load it becomes `sent` when the journal names its hash (the crash fell
 * between 3 and 4) and is dropped otherwise (between 2 and 3: no reservation was ever durable). A `sent` entry may be in
 * a pool: its nonce is never given to another call, and its bytes are broadcast again until its nonce is used.
 *
 * SH-250 (stage B): `txs` holds every transaction signed for the nonce. A replacement of the same call (raised fees) is
 * saved after the journal has reserved its higher maximum and is broadcastable at once. A takeover (an urgent random-number
 * job taking a hanging ordinary nonce, B3) carries its own `call` and is saved `signed` first, like a first send. When one
 * transaction of the nonce is final, the record names the outcome in `renamed` (the journal's hash for that call becomes the
 * winner's) and `released` (hashes whose call never executed, or that were never broadcast): the runner applies both to
 * the journal, and the store lets a start go only on such proof.
 */

/** A call that took a hanging nonce (SH-250 B3): another job than the entry's own. */
export interface SentCall {
  readonly job: string;
  readonly key: string;
  readonly to: string;
  readonly value?: bigint;
  readonly drandDeadline?: bigint;
  readonly reservation?: SentReservation;
}

/** One signed transaction. */
export interface SentTx {
  /** keccak256 of `raw`, lower case. */
  readonly hash: string;
  /** The signed bytes: the only thing ever broadcast. */
  readonly raw: Hex;
  readonly gas: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  /** The pending block it was signed for. */
  readonly block: bigint;
  /** Only a takeover is saved `signed` first; every other transaction after the first is broadcastable once saved. */
  readonly state?: 'signed';
  /** A takeover's own call; absent: the entry's call (the first transaction or a replacement of it). */
  readonly call?: SentCall;
}

/** What the scheduler reserved for this send (its journal entries name the same hash). */
export interface SentReservation {
  /** Pending block timestamp of the reservation and its UTC day. */
  readonly at: bigint;
  readonly day: bigint;
  /** Signed gas maximum plus value, as charged to the day's counters. */
  readonly costWei: bigint;
  /** The F111 spend entry's box (receiver) and time, when the job is income-capped; `start` for a first collection. */
  readonly income?: { readonly box: string; readonly at: bigint; readonly start?: 'collect' | 'sellFees' };
  /** The drand bounty reservation key (source:round). */
  readonly bounty?: string;
  /** SH-250: the counters it was charged to, as in the day's pending entry, so a replacement charges the same ones. */
  readonly counter?: 'drandRescue';
  readonly ours?: 'ours' | 'pokes';
  readonly unblocking?: string;
  /** True when the job may use the protected reserve (a reserved job's recovery call). */
  readonly reserve?: boolean;
  /** 2: written by SH-250 with its counters; absent: a stage A reservation, which is never replaced (only sent again). */
  readonly v?: 2;
}

export interface SentEntry {
  /** The signing account, lower case. */
  readonly signer: string;
  readonly nonce: bigint;
  /** Signed by the private-send key and broadcast through the private endpoint. */
  readonly privately: boolean;
  readonly job: string;
  readonly key: string;
  /** Target, lower case. */
  readonly to: string;
  readonly value?: bigint;
  /** The deadline a random-number job serves (its fee rule, R62-FEE). */
  readonly drandDeadline?: bigint;
  /** Absent only for a direct send outside the scheduler (tests and tools). */
  readonly reservation?: SentReservation;
  /** The first transaction's state. */
  readonly state: 'signed' | 'sent';
  readonly txs: readonly SentTx[];
}

/** A transaction signed in memory and not yet saved. */
export type SignedSend = Omit<SentEntry, 'reservation' | 'state'> & { readonly hash: string; readonly takeover?: boolean };

const raw = z.string().regex(/^\d+$/).transform(s => BigInt(s));
const lower = (n: number) => z.string().regex(new RegExp(`^0x[0-9a-f]{${n}}$`));
const reservationSchema = z.object({ at: raw, day: raw, costWei: raw,
  income: z.object({ box: lower(40), at: raw, start: z.enum(['collect', 'sellFees']).optional() }).optional(),
  bounty: z.string().regex(/^0x[0-9a-f]{40}:\d+$/).optional(),
  counter: z.enum(['drandRescue']).optional(), ours: z.enum(['ours', 'pokes']).optional(), unblocking: lower(40).optional(),
  reserve: z.boolean().optional(), v: z.literal(2).optional() });
const callSchema = z.object({ job: z.string().min(1), key: z.string().min(1), to: lower(40), value: raw.optional(),
  drandDeadline: raw.optional(), reservation: reservationSchema.optional() });
const txSchema = z.object({ hash: lower(64), raw: z.string().regex(/^0x([0-9a-fA-F]{2})+$/).transform(s => s as Hex),
  gas: raw, maxFeePerGas: raw, maxPriorityFeePerGas: raw, block: raw, state: z.enum(['signed']).optional(), call: callSchema.optional() });
const entrySchema = z.object({
  signer: lower(40), nonce: raw, privately: z.boolean(), job: z.string().min(1), key: z.string().min(1), to: lower(40),
  value: raw.optional(), drandDeadline: raw.optional(), reservation: reservationSchema.optional(),
  state: z.enum(['signed', 'sent']),
  txs: z.array(txSchema).min(1),
});
const fileSchema = z.object({ version: z.literal(1), identity: z.string(), entries: z.array(entrySchema),
  next: z.record(lower(40), raw).optional(), renamed: z.record(lower(64), lower(64)).optional(), released: z.record(lower(64), raw).optional() });

/**
 * The record: its entries, and per signer the nonce after the highest one that was ever `sent` (review note 2). Retiring
 * an entry never lowers that mark, so a count read from an endpoint that lags behind finality cannot hand a used nonce
 * to a new call. Only an entry dropped as never broadcast (it never became `sent`) leaves the mark where it was.
 * `renamed` and `released` are the settled outcomes of nonces (SH-250 B1, B6, B7), kept for the journal and the store.
 */
export interface SentRecord {
  readonly entries: readonly SentEntry[];
  readonly next: Readonly<Record<string, bigint>>;
  readonly renamed?: Readonly<Record<string, string>>;
  /** Hash: the block it was released at (0 when found at startup). */
  readonly released?: Readonly<Record<string, bigint>>;
}

export const EMPTY_SENT: SentRecord = { entries: [], next: {} };
/** Settled outcomes kept per kind; the oldest go first. */
export const OUTCOMES_KEPT = 4096;

/** The marks raised to every `sent` entry. */
export function raiseMarks(next: Readonly<Record<string, bigint>>, entries: readonly SentEntry[]): Record<string, bigint> {
  const out = { ...next };
  for (const e of entries) {
    const mark = out[e.signer];
    if (e.state === 'sent' && (mark === undefined || e.nonce + 1n > mark)) out[e.signer] = e.nonce + 1n;
  }
  return out;
}

export const SENT_INVALID = 'keeper sent record invalid or belongs to another chain/signer/registry';
export const SENT_MISSING = 'keeper sent record missing';

export function encodeSent(record: SentRecord, identity: string): string {
  return JSON.stringify({ version: 1, identity, entries: record.entries, next: record.next,
    ...(record.renamed && Object.keys(record.renamed).length ? { renamed: record.renamed } : {}),
    ...(record.released && Object.keys(record.released).length ? { released: record.released } : {}) },
  (_k, v: unknown) => typeof v === 'bigint' ? v.toString() : v) + '\n';
}

/** Refuses another identity, a duplicate signer and nonce or hash, and bytes whose hash is not the saved one. */
export function decodeSent(text: string, identity: string): SentRecord {
  try {
    const parsed = fileSchema.parse(JSON.parse(text));
    if (parsed.identity !== identity) throw new Error();
    const entries = parsed.entries as SentEntry[];
    const slots = new Set(entries.map(e => `${e.signer}:${e.nonce}`));
    const hashes = entries.flatMap(e => e.txs.map(t => t.hash));
    if (slots.size !== entries.length || new Set(hashes).size !== hashes.length
      || entries.some(e => e.txs.some(t => keccak256(t.raw).toLowerCase() !== t.hash))) throw new Error();
    return { entries, next: raiseMarks(parsed.next ?? {}, entries), ...(parsed.renamed ? { renamed: parsed.renamed } : {}),
      ...(parsed.released ? { released: parsed.released } : {}) };
  } catch { throw new Error(SENT_INVALID); }
}

/** Every hash the journal's reservations name: the day's sends, F111 spend (starts included) and drand bounties. */
export function journalHashes(state: KeeperState): Set<string> {
  return new Set([
    ...(state.budget?.pending ?? []).flatMap(r => r.hash === undefined ? [] : [r.hash.toLowerCase()]),
    ...(state.incomeSpend ?? []).flatMap(s => s.hash === undefined ? [] : [s.hash.toLowerCase()]),
    ...Object.values(state.drandBounties ?? {}).flatMap(b => b.hash === undefined ? [] : [b.hash.toLowerCase()]),
  ]);
}

/**
 * SH-250 B1: the journal's hashes after a nonce's outcome: a call won by a replacement is named by the winner's hash
 * (daily reservations, F111 spend, starts, drand bounties alike). Idempotent; released calls are applied by the runner.
 */
export function renameState(state: KeeperState, renamed: Readonly<Record<string, string>> | undefined): KeeperState {
  if (!renamed || !Object.keys(renamed).length) return state;
  const to = (h: string | undefined) => h === undefined ? h : renamed[h.toLowerCase()] ?? h;
  const hit = journalHashes(state);
  if (![...hit].some(h => renamed[h] !== undefined)) return state;
  return { ...state,
    ...(state.budget ? { budget: { ...state.budget, ...(state.budget.pending ? { pending: state.budget.pending.map(r => r.hash === undefined ? r : { ...r, hash: to(r.hash) }) } : {}) } } : {}),
    ...(state.incomeSpend ? { incomeSpend: state.incomeSpend.map(s => s.hash === undefined ? s : { ...s, hash: to(s.hash) }) } : {}),
    ...(state.drandBounties ? { drandBounties: Object.fromEntries(Object.entries(state.drandBounties).map(([k, b]) => [k, b.hash === undefined ? b : { hash: to(b.hash) }])) } : {}),
  };
}

/** The hash the journal names for a transaction's call: the first transaction's for the entry's call, its own for a takeover. */
export const journalName = (e: SentEntry, t: SentTx) => t.call ? t.hash : e.txs[0]?.hash ?? t.hash;

/** Keeps the newest `OUTCOMES_KEPT` of a map (insertion order). */
function trim<T>(map: Record<string, T>): Record<string, T> {
  const keys = Object.keys(map);
  return keys.length <= OUTCOMES_KEPT ? map : Object.fromEntries(keys.slice(keys.length - OUTCOMES_KEPT).map(k => [k, map[k] as T]));
}

/**
 * Load rule for a record written before a crash: a `signed` entry (or takeover) the journal names is `sent` (it may be
 * broadcast now); one the journal does not name had no durable reservation and was never broadcast, so it is dropped
 * and its nonce is free (a start of it is dropped first, StateStore.saveSent, SH-250 B7).
 * Only the journal as it stood at the crash can decide this: run it at startup, before any tick writes the journal.
 */
export function reconcileSent(record: SentRecord, state: KeeperState): SentRecord {
  const named = journalHashes(state);
  const entries = record.entries.flatMap(e => {
    if (e.state === 'signed' && !e.txs.some(t => named.has(t.hash))) {
      return [];
    }
    const txs = e.txs.flatMap((t, i) => {
      if (i === 0 || t.state !== 'signed') return [t];
      if (named.has(t.hash)) { const { state: _s, ...rest } = t; void _s; return [rest]; }
      return [];
    });
    return [{ ...e, state: 'sent' as const, txs }];
  });
  return { entries, next: raiseMarks(record.next, entries), ...(record.renamed ? { renamed: record.renamed } : {}),
    ...(record.released ? { released: record.released } : {}) };
}

/** The hashes proved never broadcast or never executed: `signed` entries and takeovers, and released hashes. */
export const unsentHashes = (record: SentRecord) => new Set([
  ...record.entries.flatMap(e => e.state === 'signed' ? e.txs.map(t => t.hash) : e.txs.flatMap(t => t.state === 'signed' ? [t.hash] : [])),
  ...Object.keys(record.released ?? {}),
]);

/** A refusal that is a wait, not an error: the runner defers the job with this reason (SH-250 B5). */
export class SendWait extends Error {}

/** A broadcast is repeated at least this many observed blocks apart while its nonce is unused. */
export const REBROADCAST_BLOCKS = 25n;
/** SH-250 Q2: hanging after this many observed blocks unmined, or with its maximum fee below the base fee for this many heads. */
export const HANG_BLOCKS = 25n;
export const UNDERPRICED_HEADS = 3;
/** SH-250 B5: unconfirmed transactions per signer above which nothing new is signed. */
export const MAX_IN_FLIGHT = 8n;
/** SH-250 Q1: a replacement raises both fee fields by at least 12.5% (an eighth), rounded up. */
export const bump = (fee: bigint) => fee + (fee + 7n) / 8n;

/** The signed maximum a transaction reserves: gas times its maximum fee, plus the call's value. */
export const txCost = (e: SentEntry, t: SentTx) => t.gas * t.maxFeePerGas + ((t.call ? t.call.value : e.value) ?? 0n);

/**
 * Signing is deterministic: the same call, nonce and fees signed again after their first bytes were dropped give the
 * same hash. Saving it again takes it out of `released`, or the runner would free the new reservation.
 */
function unreleased(released: Record<string, bigint>, hash: string): Record<string, bigint> {
  if (released[hash.toLowerCase()] === undefined) return released;
  return Object.fromEntries(Object.entries(released).filter(([h]) => h !== hash.toLowerCase()));
}

/**
 * The record in memory, published through `write` (the store's durable sidecar; nothing for an in-memory book). Every
 * change is written before it takes effect here, so a failed write changes nothing.
 */
export class SentBook {
  private list: SentEntry[];
  private marks: Record<string, bigint>;
  private renamed: Record<string, string>;
  private released: Record<string, bigint>;
  /** Hashes whose journal write completed in this process (step 3 done). */
  private readonly journaled = new Set<string>();
  /** Hash: the block of its last answered broadcast in this process. */
  private readonly answered = new Map<string, bigint>();

  constructor(record: SentRecord = EMPTY_SENT, private readonly write: (record: SentRecord) => void = () => {}) {
    this.list = [...record.entries];
    this.marks = raiseMarks(record.next, record.entries);
    this.renamed = { ...record.renamed };
    this.released = { ...record.released };
  }

  get entries(): readonly SentEntry[] { return this.list; }
  get next(): Readonly<Record<string, bigint>> { return this.marks; }
  /** The settled outcomes the journal must carry (SH-250). */
  get outcomes(): { readonly renamed: Readonly<Record<string, string>>; readonly released: Readonly<Record<string, bigint>> } {
    return { renamed: this.renamed, released: this.released };
  }

  private publish(entries: SentEntry[], renamed = this.renamed, released = this.released) {
    const next = raiseMarks(this.marks, entries);
    const r = trim(renamed), d = trim(released);
    this.write({ entries, next, ...(Object.keys(r).length ? { renamed: r } : {}), ...(Object.keys(d).length ? { released: d } : {}) });
    this.list = entries;
    this.marks = next;
    this.renamed = r;
    this.released = d;
  }

  /** The nonce after this signer's highest saved one, never below its mark (retired entries included). */
  after(signer: string): bigint | undefined {
    const who = signer.toLowerCase();
    let next = this.marks[who];
    for (const e of this.list) if (e.signer === who && (next === undefined || e.nonce + 1n > next)) next = e.nonce + 1n;
    return next;
  }

  find(hash: string): SentEntry | undefined {
    return this.list.find(e => e.txs.some(t => t.hash === hash.toLowerCase()));
  }

  /** Step 2. */
  add(s: SignedSend, reservation?: SentReservation): void {
    const rest: Omit<SignedSend, 'hash'> & { hash?: string; takeover?: boolean } = { ...s };
    delete rest.hash;
    delete rest.takeover;
    if (this.list.some(e => e.signer === s.signer && e.nonce === s.nonce)) throw new Error('nonce already saved');
    if (this.find(s.hash)) throw new Error('transaction already saved');
    this.publish([...this.list, { ...rest, ...(reservation ? { reservation } : {}), state: 'signed' }], this.renamed, unreleased(this.released, s.hash));
  }

  /** SH-250: another transaction for a saved nonce: a replacement (already reserved) or a takeover (saved `signed`). */
  addTx(signer: string, nonce: bigint, tx: SentTx): void {
    const e = this.list.find(x => x.signer === signer && x.nonce === nonce);
    if (!e || e.state !== 'sent') throw new Error('nonce not saved');
    if (this.find(tx.hash)) throw new Error('transaction already saved');
    this.publish(this.list.map(x => x === e ? { ...e, txs: [...e.txs, tx] } : x), this.renamed, unreleased(this.released, tx.hash));
  }

  /** Step 4: the journal names `hash`; only now may its bytes be broadcast. */
  commit(hash: string): SentEntry {
    const h = hash.toLowerCase();
    this.journaled.add(h);
    const e = this.find(h);
    if (!e) throw new Error('transaction not saved');
    const i = e.txs.findIndex(t => t.hash === h);
    if (i === 0 ? e.state === 'sent' : e.txs[i]?.state !== 'signed') return e;
    const sent = i === 0 ? { ...e, state: 'sent' as const }
      : { ...e, txs: e.txs.map((t, j) => { if (j !== i) return t; const { state: _s, ...rest } = t; void _s; return rest; }) };
    this.publish(this.list.map(x => x === e ? sent : x));
    return sent;
  }

  /**
   * Finishes an earlier attempt of this process before the next signature: a `signed` entry or takeover whose journal
   * write never completed is dropped (never broadcast), one whose journal write completed is committed.
   */
  tidy(): void {
    const stale = this.list.some(e => e.state === 'signed' || e.txs.some(t => t.state === 'signed'));
    if (!stale) return;
    const entries = this.list.flatMap(e => {
      if (e.state === 'signed' && !e.txs.some(t => this.journaled.has(t.hash))) {
        return [];
      }
      const txs = e.txs.flatMap((t, i) => {
        if (i === 0 || t.state !== 'signed') return [t];
        if (this.journaled.has(t.hash)) { const { state: _s, ...rest } = t; void _s; return [rest]; }
        return [];
      });
      return [{ ...e, state: 'sent' as const, txs }];
    });
    this.publish(entries);
  }

  /** Retires entries whose transaction is final and canonical (stage A: nothing to rename or release). */
  remove(hashes: readonly string[]): void {
    const gone = new Set(hashes.map(h => h.toLowerCase()));
    const next = this.list.filter(e => !e.txs.some(t => gone.has(t.hash)));
    if (next.length !== this.list.length) this.publish(next);
    for (const h of gone) { this.answered.delete(h); this.journaled.delete(h); }
  }

  /**
   * SH-250 B1, B6: retires a nonce with its outcome: the journal's hash for the winning call becomes the winner's
   * (`rename`), and the calls that never executed are released.
   */
  resolve(e: SentEntry, rename: readonly (readonly [string, string])[], release: readonly string[], block: bigint): void {
    const renamed = { ...this.renamed }, released = { ...this.released };
    for (const [from, to] of rename) if (from !== to) renamed[from] = to;
    for (const h of release) released[h] = block;
    this.publish(this.list.filter(x => x !== e), renamed, released);
    for (const t of e.txs) { this.answered.delete(t.hash); this.journaled.delete(t.hash); }
  }

  markAnswered(hash: string, block?: bigint): void { this.answered.set(hash.toLowerCase(), block ?? -1n); }
  answeredAt(hash: string): bigint | undefined { return this.answered.get(hash.toLowerCase()); }
}
