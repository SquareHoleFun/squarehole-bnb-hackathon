import { readLock } from './state-lock';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import type { KeeperState } from './run';
import { INCOME_WINDOW_SECONDS, UNKNOWN_INCOME_BOX, type IncomeSpend } from './income';
import { EMPTY_SENT, SENT_INVALID, SENT_MISSING, decodeSent, encodeSent, reconcileSent, renameState, unsentHashes, type SentRecord } from './sent';

const raw = z.string().regex(/^\d+$/).transform((s) => BigInt(s));
const count = z.number().int().nonnegative().safe();
const record = <T extends z.ZodType>(value: T) => z.record(z.string(), value);
const schema = z.object({
  version: z.literal(1), identity: z.string(),
  state: z.object({
    drandBounties: z.record(z.string().regex(/^0x[0-9a-f]{40}:\d+$/),
      z.object({ hash: z.string().regex(/^0x[0-9a-f]{64}$/).optional() })).optional(),
    drandLog: record(raw).optional(),
    incomeSpend: z.array(z.object({ box: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(s => s as `0x${string}`),
      at: raw, costWei: raw, hash: z.string().min(1).optional() })).optional(),
    m2Scan: record(raw).optional(),
    mem: z.object({
      cadence: record(z.object({ deepenSentSlot: raw.nullable(), deepenTriedSlot: raw.nullable(), deepenTriedBlock: raw, collectedAt: raw.nullable(), collectSlot: raw.nullable() })),
      pokes: record(raw), attempts: record(z.object({ block: raw, next: raw, nextAt: raw.optional() })),
      steps: record(z.object({ job: z.enum(['buyBack', 'deepen', 'shopFees', 'sellFees']), block: raw, sent: z.boolean() })),
      buyBackSince: record(raw),
      buyBackBudget: record(raw).optional(),
    }).optional(),
    budget: z.object({ day: raw, oursWei: raw, pokesWei: raw, totalWei: raw, drandRescueWei: raw.optional().default(0n), block: raw, txInBlock: count,
      unblockingGas: record(raw).optional(), unblockingWei: raw.optional(), unblockingWeiByBox: record(raw).optional(),
      pending: z.array(z.object({ costWei: raw, valueWei: raw.optional(), counter: z.enum(['drandRescue']).optional(), ours: z.enum(['ours', 'pokes']).optional(),
        box: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(), hash: z.string().min(1).optional() })).optional(),
    }).optional(),
    skipLog: record(z.object({ at: raw, repeats: count })).optional(),
    monitorQueue: record(raw).optional(),
  }),
});

export function encodeState(state: KeeperState, identity: string): string {
  return JSON.stringify({ version: 1, identity, state: { ...state, ...(state.incomeSpend ? {
    incomeSpend: state.incomeSpend.map(({ box, at, costWei, hash }) => ({ box, at, costWei, hash })),
  } : {}) } }, (_, value: unknown) => typeof value === 'bigint' ? value.toString() : value) + '\n';
}

export function decodeState(text: string, identity: string): KeeperState {
  const parsed = schema.safeParse(JSON.parse(text));
  if (!parsed.success || parsed.data.identity !== identity) throw new Error('keeper state invalid or belongs to another chain/signer/registry');
  return parsed.data.state;
}

// A owns its identities. J stays exactly the pre-B journal, including its spend schema.
const startSchema = schema.shape.state.shape.incomeSpend.unwrap().element.extend({
  id: z.string().uuid(),
  start: z.object({ job: z.enum(['collect', 'sellFees']), settledAt: raw.optional(), repaidAt: raw.optional(),
    paymentHashes: z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/)).optional() }),
});
const startsSchema = z.object({ version: z.literal(1), identity: z.string(), starts: z.array(startSchema) });
type StartRecord = z.infer<typeof startSchema>;
const paidAt = (s: IncomeSpend) => s.start?.repaidAt ?? s.start?.settledAt;
const expired = (s: IncomeSpend, now: bigint) => {
  const paid = paidAt(s);
  return paid !== undefined && paid <= now - INCOME_WINDOW_SECONDS;
};
const markerSchema = z.object({ version: z.literal(1), identity: z.string() });
const json = (value: unknown) => JSON.stringify(value, (_, v: unknown) => typeof v === 'bigint' ? v.toString()
  : v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v) + '\n';
// Ordinary entries have no identity or order. Compare the spend multiset, keeping every duplicate.
const books = (state: KeeperState) => JSON.parse(json({ ...state, ...(state.incomeSpend ? {
  incomeSpend: [...state.incomeSpend].sort((a, b) => json(a).localeCompare(json(b))),
} : {}) }));
const startsInvalid = () => new Error('keeper starts invalid or belongs to another chain/signer/registry');
function optionalFile(file: string): string | undefined {
  try { return readFileSync(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
function decodeStarts(text: string, identity: string) {
  try {
    const parsed = startsSchema.parse(JSON.parse(text));
    if (parsed.identity !== identity || new Set(parsed.starts.map(s => s.id)).size !== parsed.starts.length
      || new Set(parsed.starts.map(s => `${s.box.toLowerCase()}:${s.at}`)).size !== parsed.starts.length) throw startsInvalid();
    return parsed.starts;
  } catch { throw startsInvalid(); }
}

/** A start owns its box/time pair. Cost and known hashes validate that pair; they never find it. */
function matchStarts(starts: readonly IncomeSpend[], spend: readonly IncomeSpend[]): Map<number, number> {
  const matches = new Map<number, number>();
  for (const [i, a] of starts.entries()) for (const [j, s] of spend.entries()) {
    if (a.box.toLowerCase() !== s.box.toLowerCase() || a.at !== s.at) continue;
    if (matches.has(i) || a.costWei !== s.costWei
      || (a.hash !== undefined && s.hash !== undefined && a.hash.toLowerCase() !== s.hash.toLowerCase())) throw startsInvalid();
    matches.set(i, j);
  }
  return matches;
}

/** U2/U3 are shared by startup and the pre-publication check. A controls a matched start's debit. */
function loadBooks(state: KeeperState, starts: readonly StartRecord[], now: bigint): KeeperState {
  const spend = state.incomeSpend ?? [], merged = [...spend];
  const matches = matchStarts(starts, spend);
  for (const [i, record] of starts.entries()) {
    const { box, at, costWei, hash, start } = record;
    const s: IncomeSpend = { box, at, costWei, hash, start };
    const j = matches.get(i);
    if (j !== undefined) merged[j] = { ...s, hash: hash ?? spend[j]?.hash };
    else if (paidAt(s) === undefined) merged.push({ ...s, hash: undefined });
    else if (!expired(s, now)) merged.push(s);
    // A paid orphan after its window is an interrupted removal; complete it in memory.
  }
  const legacy = state.incomeSpend === undefined ? state.budget?.totalWei : undefined;
  if (merged.length && legacy !== undefined && legacy > 0n) merged.unshift({ box: UNKNOWN_INCOME_BOX, at: merged[0]?.at ?? 0n, costWei: legacy });
  return merged.length || state.incomeSpend ? { ...state, incomeSpend: merged } : state;
}

/**
 * SH-249 report mode: reads a copy of the journal with its starts and saved-transaction sidecars, taking the identity
 * from the journal itself. Read-only: no lock, no marker, no write of any kind.
 */
export function inspectBooks(file: string): { identity: string; state: KeeperState; sent: SentRecord } {
  const text = optionalFile(file);
  if (text === undefined) throw new Error('journal copy missing');
  const identity = z.object({ identity: z.string() }).parse(JSON.parse(text)).identity;
  const state = decodeState(text, identity);
  const startsText = optionalFile(`${file}.starts`);
  const books = loadBooks(state, startsText === undefined ? [] : decodeStarts(startsText, identity), 0n);
  const sentText = optionalFile(`${file}.sent`);
  return { identity, state: books, sent: sentText === undefined ? EMPTY_SENT : decodeSent(sentText, identity) };
}

/**
 * Review note 1: a first collection whose starts-file write landed but whose journal write did not (a crash between the
 * two renames of one save, or a journal write that failed) names a hash the journal never held. Its bytes were never
 * broadcast: a broadcast follows the journal write and the record's `sent` mark. Such an unpaid start is dropped with its
 * record entry instead of staying hashless and blocking its box. Only positive proof qualifies (re-check R2): an unpaid
 * start with a hash, unmatched in the journal, whose hash is a `signed` entry of the record or one this process dropped
 * itself as never broadcast. A hash merely absent from the record (a retired entry, books restored out of step) keeps
 * the start, charged, as before; starts from before SH-249 are matched by the journal or carry no hash.
 */
function orphanStarts(starts: readonly StartRecord[], spend: readonly IncomeSpend[], unsent: ReadonlySet<string>): Set<StartRecord> {
  if (!unsent.size) return new Set();
  const matches = matchStarts(starts, spend);
  return new Set(starts.filter((s, i) => !matches.has(i) && paidAt(s) === undefined && s.hash !== undefined && unsent.has(s.hash.toLowerCase())));
}

/** Start records name the winner's hash once a replacement won their nonce (SH-250 B1). */
function renameStarts(starts: StartRecord[], renamed: Readonly<Record<string, string>> | undefined): StartRecord[] {
  if (!renamed || !Object.keys(renamed).length) return starts;
  return starts.map(s => s.hash !== undefined && renamed[s.hash.toLowerCase()] ? { ...s, hash: renamed[s.hash.toLowerCase()] } : s);
}

/** One process per gas wallet and state file. Invalid/stale locks stop execution; they never reset a budget. */
export class StateStore {
  private readonly lock: string;
  private closed = false;
  private marked = false;
  private sentMarked = false;
  constructor(private readonly file: string, private readonly identity: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.lock = `${file}.lock`;
    let fd: number;
    try { fd = openSync(this.lock, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let lockStartedAt: string | null = null;
      try { lockStartedAt = readLock(file).startedAt; } catch { /* Old or unreadable provenance stays unknown. */ }
      const record = `${file}.lock-refused.json`;
      atomicWrite(record, JSON.stringify({ schema: 'squarehole.keeper-lock-refused.v1',
        at: String(Math.floor(Date.now() / 1000)), lockStartedAt }) + '\n');
      throw Object.assign(new Error('keeper state lock held'), { code: 'SH_KEEPER_LOCK_HELD' });
    }
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: String(Math.floor(Date.now() / 1000)), id: randomUUID() }) + '\n');
      fsyncSync(fd);
    } finally { closeSync(fd); }
    const record = `${file}.lock-refused.json`;
    try { renameSync(record, `${record}.${randomUUID()}.cleared`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.close(); throw error; } }
  }
  private readMarker(): boolean {
    const text = optionalFile(`${this.file}.starts-required`);
    if (text === undefined) return false;
    try {
      if (markerSchema.parse(JSON.parse(text)).identity !== this.identity) throw startsInvalid();
    } catch { throw startsInvalid(); }
    return true;
  }
  private readStarts(): StartRecord[] {
    this.marked = this.readMarker();
    const text = optionalFile(`${this.file}.starts`);
    if (text !== undefined) return decodeStarts(text, this.identity);
    if (this.marked) throw new Error('keeper starts file missing');
    return [];
  }
  // Startup has no tick yet. Retain paid windows until the pending timestamp is available.
  load(now = 0n): KeeperState {
    const journal = optionalFile(this.file);
    const record = this.readSent();
    // SH-250: a nonce won by a replacement renames its call's hash; books written on either side of that are read alike.
    const state = renameState(journal === undefined ? {} : decodeState(journal, this.identity), record?.renamed);
    const read = renameStarts(this.readStarts(), record?.renamed);
    const orphans = orphanStarts(read, state.incomeSpend ?? [], this.unsent());
    const starts = read.filter(s => !orphans.has(s));
    // Drop never-broadcast starts durably before the record drops their entries (loadSent).
    if (orphans.size) atomicWrite(`${this.file}.starts`, json({ version: 1, identity: this.identity, starts }));
    const loaded = loadBooks(state, starts, now);
    const matches = matchStarts(starts, state.incomeSpend ?? []);
    // Finish an interrupted removal durably. save checks the recovered books before publishing J then A.
    if (starts.some((s, i) => !matches.has(i) && expired(s, now))) this.save(loaded, now);
    return loaded;
  }
  save(state: KeeperState, now: bigint): void {
    if (this.closed) throw new Error('keeper state store closed');
    const entries = (state.incomeSpend ?? []).filter(s => s.start);
    // A running process whose journal write failed after its starts write: the start it held only in that failed
    // checkpoint was never broadcast (review note 1). It is dropped here as at load, never forgotten otherwise.
    const read = renameStarts(this.readStarts(), this.readSent()?.renamed);
    const orphans = orphanStarts(read, entries, this.unsent());
    const previous = read.filter(s => !orphans.has(s));
    const matches = matchStarts(entries, previous);
    const starts = entries.map((s, i) => ({ ...s, id: previous[matches.get(i) ?? -1]?.id ?? randomUUID() }));
    const priorText = optionalFile(this.file);
    // Note 7: the prior journal is read as renamed, like the starts, so a renamed start matches its prior self.
    const priorSpend = priorText === undefined ? [] : renameState(decodeState(priorText, this.identity), this.readSent()?.renamed).incomeSpend ?? [];
    const priorMatches = matchStarts(previous, priorSpend);
    for (const s of starts) {
      const prior = previous.find(p => p.id === s.id);
      if (!prior) continue;
      // A may already be ahead of the caller after an interrupted checkpoint. Never overwrite its decision.
      if (prior.start.job !== s.start?.job || (paidAt(prior) !== undefined && !isDeepStrictEqual(JSON.parse(json(prior.start)), JSON.parse(json(s.start))))
        || (prior.hash !== undefined && s.hash === undefined && priorMatches.has(previous.indexOf(prior)))) throw new Error('keeper books do not round trip');
    }
    const kept = new Set(starts.map(s => s.id));
    const removed = previous.filter(s => !kept.has(s.id));
    // A checkpoint cannot silently forget an unpaid start or shorten a paid window.
    if (removed.some(s => !expired(s, now))) throw new Error('keeper books do not round trip');
    const text = encodeState(state, this.identity);
    const journal = decodeState(text, this.identity);
    const startText = json({ version: 1, identity: this.identity, starts });
    const loaded = loadBooks(journal, decodeStarts(startText, this.identity), now);
    const expected = { ...journal, ...(state.incomeSpend ? { incomeSpend: state.incomeSpend } : {}) };
    const duringText = json({ version: 1, identity: this.identity, starts: [...starts, ...removed] });
    const during = loadBooks(journal, decodeStarts(duringText, this.identity), now);
    const withoutExpired = (s: KeeperState) => ({ ...s, ...(s.incomeSpend ? { incomeSpend: s.incomeSpend.filter(e => !expired(e, now)) } : {}) });
    if (!isDeepStrictEqual(books(loaded), books(expected)) || !isDeepStrictEqual(books(withoutExpired(during)), books(withoutExpired(expected)))) throw new Error('keeper books do not round trip');
    // All validation precedes the first publication, including M on first use.
    // Mixed checkpoints retain removals in A while publishing additions/decisions ahead of J.
    const changed = starts.some(s => !isDeepStrictEqual(JSON.parse(json(s)), JSON.parse(json(previous.find(p => p.id === s.id) ?? null))));
    if (!this.marked || !removed.length || changed || orphans.size) {
      atomicWrite(`${this.file}.starts`, duringText);
    }
    if (!this.marked) atomicWrite(`${this.file}.starts-required`, json({ version: 1, identity: this.identity }));
    this.marked = true;
    atomicWrite(this.file, text);
    if (removed.length) atomicWrite(`${this.file}.starts`, startText);
  }

  /**
   * SH-249: the saved-transaction record `<journal>.sent` beside the journal, identity checked, under the same lock.
   * `<journal>.sent-required` marks that it exists: a missing record after the marker stops startup. Give the journal as
   * just loaded: an entry saved but never named by the journal is dropped here, one it names is followed (sent.ts).
   */
  /** The record as on disk, without the marker check; undefined when there is none. */
  private readSent(): SentRecord | undefined {
    const text = optionalFile(`${this.file}.sent`);
    return text === undefined ? undefined : decodeSent(text, this.identity);
  }

  /** Hashes proved never broadcast or never executed: `signed` entries and takeovers, and the record's released hashes. */
  private unsent(): Set<string> {
    const record = this.readSent();
    return record ? unsentHashes(record) : new Set();
  }

  loadSent(state: KeeperState): SentRecord {
    if (this.closed) throw new Error('keeper state store closed');
    const marker = optionalFile(`${this.file}.sent-required`);
    if (marker !== undefined) {
      try { if (markerSchema.parse(JSON.parse(marker)).identity !== this.identity) throw new Error(); }
      catch { throw new Error(SENT_INVALID); }
      this.sentMarked = true;
    }
    const text = optionalFile(`${this.file}.sent`);
    if (text === undefined) {
      if (this.sentMarked) throw new Error(SENT_MISSING);
      return EMPTY_SENT;
    }
    const record = decodeSent(text, this.identity);
    const next = reconcileSent(record, state);
    if (!isDeepStrictEqual(next, record)) this.saveSent(next);
    return next;
  }

  /** Durable replacement of the record (same file mode as the journal); first use writes the record, then the marker. */
  saveSent(record: SentRecord): void {
    if (this.closed) throw new Error('keeper state store closed');
    const text = encodeSent(record, this.identity);
    decodeSent(text, this.identity);
    // SH-250 B7: a `signed` entry leaving the record was never broadcast. A start that names it and that the journal on
    // disk does not hold (its journal write never landed) is dropped from the starts file first, so no crash between the
    // two writes can leave it without its proof.
    const before = this.readSent();
    if (before) {
      const kept = new Set(record.entries.flatMap(e => e.txs.map(t => t.hash)));
      const dropped = new Set([...unsentHashes({ entries: before.entries, next: {} })].filter(h => !kept.has(h)));
      if (dropped.size) {
        const journal = optionalFile(this.file);
        const spend = journal === undefined ? [] : decodeState(journal, this.identity).incomeSpend ?? [];
        const read = renameStarts(this.readStarts(), before.renamed);
        const orphans = orphanStarts(read, renameState({ incomeSpend: spend }, before.renamed).incomeSpend ?? [], dropped);
        if (orphans.size) atomicWrite(`${this.file}.starts`, json({ version: 1, identity: this.identity, starts: read.filter(x => !orphans.has(x)) }));
      }
    }
    atomicWrite(`${this.file}.sent`, text);
    if (!this.sentMarked) {
      atomicWrite(`${this.file}.sent-required`, json({ version: 1, identity: this.identity }));
      this.sentMarked = true;
    }
  }

  close(): void {
    if (this.closed) return;
    // Keep lock provenance; no deletion is needed for a normal shutdown.
    renameSync(this.lock, `${this.lock}.${randomUUID()}.released`);
    this.closed = true;
  }
}

/** Durable publication with restrictive permissions, including replacement of an older file. */
function atomicWrite(file: string, text: string): void {
  const temp = `${file}.${randomUUID()}.pending`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, file);
  const dir = openSync(dirname(file), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}
