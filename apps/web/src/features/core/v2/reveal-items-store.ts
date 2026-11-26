/** Public progress only. No salts, proofs, calldata, asset bytes or local completion cursor. */
import { requireRevealAuthority } from './reveal-session';
import { isAddress, type Address, type Hex } from 'viem';

export interface RevealProgressStore {
  get(key: string): Promise<string | null>;
  /** Legacy import/test boundary. Production uses records below. Resolves after commit. */
  put(key: string, value: string): Promise<void>;
  records?: RevealRecordStore;
}
export type IntentStatus = 'intent' | 'submitted' | 'unknown' | 'refused' | 'included' | 'finalized' | 'reverted' | 'closed' | 'user-released';
export interface RevealIntent {
  readonly attempt: string;
  readonly ids: readonly string[];
  readonly account: Address;
  /** Observed transaction nonce. An old journal may contain a hint; never use it to unlock IDs. */
  readonly nonce?: string;
  readonly createdAt: number;
  readonly capWei: string;
  readonly status: IntentStatus;
  readonly hash?: Hex;
  readonly succeeded?: readonly string[];
  readonly emitted?: readonly string[];
  readonly block?: { readonly number: string; readonly hash: Hex };
  readonly receiptStatus?: 'success' | 'reverted';
  /** Hidden openings share the sender lock and public schema. */
  readonly ticket?: string;
  readonly clock?: ReleaseClock;
}
export interface RevealProgress {
  readonly version: 1;
  readonly specHash: Hex;
  readonly intents: readonly RevealIntent[];
}
export const PROGRESS_MAX_BYTES = 16 * 1024 * 1024;
export const PROGRESS_MAX_RECORD_BYTES = 4096;
export const PROGRESS_MAX_INTENTS = 30_000;
export const revealProgressKey = (chainId: number, token: Address): string => `sh.reveal.run/1:${chainId}:${token.toLowerCase()}`;
const decimal = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v);
const hash = (v: unknown): v is Hex => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
export const unresolvedIntent = (i: RevealIntent): boolean => ['intent', 'submitted', 'unknown'].includes(i.status);
export const requireRevealValue = <T>(v: T | undefined | null): T => { if (v == null) throw new Error('progress-invalid'); return v; };
const invalid = (): never => { throw new Error('progress-invalid'); };

/** Rebuild public fields. Reject incoherent evidence on both the read and write boundaries. */
function publicProgress(value: RevealProgress, specHash: Hex): RevealProgress {
  if (value?.version !== 1 || !hash(value.specHash) || value.specHash.toLowerCase() !== specHash.toLowerCase()
    || !Array.isArray(value.intents) || value.intents.length > PROGRESS_MAX_INTENTS) invalid();
  const attempts = new Set<string>();
  const intents = value.intents.map(i => {
    if (!i || typeof i.attempt !== 'string' || i.attempt.length < 1 || i.attempt.length > 200 || attempts.has(i.attempt)
      || typeof i.account !== 'string' || !isAddress(i.account) || (i.nonce !== undefined && !decimal(i.nonce))
      || !decimal(i.capWei) || !Number.isSafeInteger(i.createdAt) || i.createdAt < 0
      || !Array.isArray(i.ids) || !i.ids.length || i.ids.length > 40
      || i.ids.some((id: unknown, index: number) => !decimal(id) || BigInt(id) < 1n || BigInt(id) > 10_000n
        || (index > 0 && BigInt(id) <= BigInt(i.ids[index - 1] ?? '-1')))) invalid();
    attempts.add(i.attempt);
    // The first pass's nonce-consumed claim is not safe with browser wallets. Reopen it.
    let status: IntentStatus = (i.status as string) === 'nonce-consumed' ? (i.hash ? 'submitted' : 'unknown') : i.status;
    if (!['intent', 'submitted', 'unknown', 'refused', 'included', 'finalized', 'reverted', 'closed', 'user-released'].includes(status)
      || (i.hash !== undefined && !hash(i.hash))
      || (['submitted', 'included', 'reverted'].includes(status) && !i.hash)
      // SH-203 af5 (R4-L2b): a released send may keep its transaction id (released after every read found it gone).
      || (['intent', 'unknown', 'refused'].includes(status) && i.hash !== undefined)) invalid();
    const subset = (ids: readonly string[] | undefined): readonly string[] | undefined => {
      if (ids === undefined) return undefined;
      if (!Array.isArray(ids) || ids.length > i.ids.length || new Set(ids).size !== ids.length || ids.some(id => !i.ids.includes(id))) invalid();
      return [...ids];
    };
    const succeeded = subset(i.succeeded), emitted = subset(i.emitted);

    if (i.block !== undefined && (!decimal(i.block?.number) || !hash(i.block?.hash))) invalid();
    if (i.receiptStatus !== undefined && !['success', 'reverted'].includes(i.receiptStatus)) invalid();
    if (status === 'included' && (!i.block || !i.receiptStatus)) invalid();
    if (status === 'closed' && !i.ticket) invalid();
    if (['finalized', 'reverted', 'closed'].includes(status)
      && (!i.block || succeeded === undefined || (status === 'reverted' && i.receiptStatus !== 'reverted')
        || (status === 'finalized' && i.hash && !i.receiptStatus && succeeded.length !== i.ids.length))) {
      status = i.hash ? 'submitted' : 'unknown';
    }
    if (i.clock && !validClock(i.clock)) invalid();
    if (i.ticket !== undefined && (!decimal(i.ticket) || BigInt(i.ticket) < 1n || BigInt(i.ticket) > 10_000n || i.ids.length !== 1)) invalid();
    return { attempt: i.attempt, ids: [...i.ids], account: i.account, createdAt: i.createdAt, capWei: i.capWei, status,
      ...(i.nonce !== undefined ? { nonce: i.nonce } : {}), ...(i.hash ? { hash: i.hash } : {}),
      ...(succeeded !== undefined ? { succeeded } : {}), ...(emitted !== undefined ? { emitted } : {}),
      ...(i.block ? { block: { number: i.block.number, hash: i.block.hash } } : {}),
      ...(i.receiptStatus ? { receiptStatus: i.receiptStatus } : {}), ...(i.ticket ? { ticket: i.ticket } : {}),
      ...(i.clock ? { clock: { wall: i.clock.wall, tick: i.clock.tick, epoch: i.clock.epoch, elapsed: i.clock.elapsed } } : {}) };
  });
  return { version: 1, specHash: value.specHash, intents };
}
function bounded(text: string): string {
  if (text.length > PROGRESS_MAX_BYTES || new TextEncoder().encode(text).length > PROGRESS_MAX_BYTES) invalid();
  return text;
}
export interface ReleaseClock { readonly wall: number; readonly tick: number; readonly epoch: string; readonly elapsed: number }
export const validClock = (c: ReleaseClock): boolean => Number.isSafeInteger(c.wall) && c.wall >= 0
  && Number.isSafeInteger(c.tick) && c.tick >= 0 && Number.isSafeInteger(c.elapsed) && c.elapsed >= 0
  && typeof c.epoch === 'string' && c.epoch.length > 0 && c.epoch.length <= 100;
export interface JournalIndex { readonly revision: number; readonly specHash: Hex; readonly count: number; readonly bytes: number }
/** One atomic read snapshot and compare-and-swap transaction. No rejected commit may land later. */
export interface RevealRecordStore {
  read(key: string, knownRevision?: number): Promise<{ index: JournalIndex; records?: readonly string[] } | null>;
  commit(key: string, previous: number, index: JournalIndex, changes: readonly { attempt: string; text: string }[]): Promise<void>;
}
interface JournalCache {
  revision: number; legacyText?: string | null; bytes: number; spent: bigint; itemSpent: Map<string, bigint>; rewrite: boolean;
  positions: Map<string, number>; pending: Map<string, RevealIntent>; included: Map<bigint, Map<string, RevealIntent>>; heap: bigint[]; queued: Set<bigint>; byId: Map<string, Set<string>>; active: Map<string, RevealIntent>; texts: Map<string, string>;
}
function updateActive(m: JournalCache, old: RevealIntent | undefined, intent: RevealIntent) {
  if (old) {
    m.active.delete(old.attempt); m.pending.delete(old.attempt);
    if (old.block) m.included.get(BigInt(old.block.number))?.delete(old.attempt);
    for (const id of old.ids) m.byId.get(id)?.delete(old.attempt);
  }
  if (unresolvedIntent(intent) || intent.status === 'included') {
    m.active.set(intent.attempt, intent);
    for (const id of intent.ids) { let ids = m.byId.get(id); if (!ids) { ids = new Set(); m.byId.set(id, ids); } ids.add(intent.attempt); }
  }
  if (unresolvedIntent(intent)) m.pending.set(intent.attempt, intent);
  if (intent.status === 'included' && intent.block) {
    const number = BigInt(intent.block.number);
    let rows = m.included.get(number); if (!rows) { rows = new Map(); m.included.set(number, rows); } rows.set(intent.attempt, intent);
    if (!m.queued.has(number)) {
      m.queued.add(number); m.heap.push(number); let at = m.heap.length - 1;
      while (at > 0) { const parent = Math.floor((at - 1) / 2); if (requireRevealValue(m.heap[parent]) <= number) break;
        m.heap[at] = requireRevealValue(m.heap[parent]); at = parent; } m.heap[at] = number;
    }
  }
}
function popHeap(m: JournalCache) {
  const first = requireRevealValue(m.heap[0]), last = requireRevealValue(m.heap.pop()); m.queued.delete(first); m.included.delete(first);
  if (!m.heap.length) return;
  let at = 0;
  while (at * 2 + 1 < m.heap.length) {
    let child = at * 2 + 1; if (child + 1 < m.heap.length && requireRevealValue(m.heap[child + 1]) < requireRevealValue(m.heap[child])) child++;
    if (last <= requireRevealValue(m.heap[child])) break; m.heap[at] = requireRevealValue(m.heap[child]); at = child;
  }
  m.heap[at] = last;
}
const metadata = new WeakMap<RevealProgress, JournalCache>();
const caches = new WeakMap<RevealProgressStore, Map<string, RevealProgress>>();
/** Diagnostic counters count actual records visited and serialized, not merely calls. */
export const journalWork = { scanned: 0, serialized: 0, bytes: 0 };
const sizeOf = (text: string): number => new TextEncoder().encode(text).length;
function initialize(progress: RevealProgress, revision = 0, rewrite = false): JournalCache {
  const m: JournalCache = { revision, bytes: 0, spent: 0n, itemSpent: new Map(), rewrite, positions: new Map(), pending: new Map(), included: new Map(), heap: [], queued: new Set(), byId: new Map(), active: new Map(), texts: new Map() };
  progress.intents.forEach((i, n) => {
    journalWork.scanned++;
    const text = JSON.stringify(i); journalWork.serialized++;
    if (sizeOf(text) > PROGRESS_MAX_RECORD_BYTES) invalid();
    m.texts.set(i.attempt, text); m.bytes += sizeOf(text); m.positions.set(i.attempt, n);
    if (i.status !== 'refused') { m.spent += BigInt(i.capWei); for (const id of i.ids) m.itemSpent.set(id, (m.itemSpent.get(id) ?? 0n) + BigInt(i.capWei)); }
    updateActive(m, undefined, i);
  });
  if (m.bytes > PROGRESS_MAX_BYTES || progress.intents.length > PROGRESS_MAX_INTENTS) invalid();
  metadata.set(progress, m); return m;
}
const meta = (p: RevealProgress): JournalCache => metadata.get(p) ?? initialize(publicProgress(p, p.specHash));
export const journalRevision = (p: RevealProgress): number => meta(p).revision;
export const spentRevealCaps = (p: RevealProgress): bigint => meta(p).spent;
export const spentRevealItemCaps = (p: RevealProgress, id: string): bigint => meta(p).itemSpent.get(id) ?? 0n;
export const unresolvedRevealIntents = (p: RevealProgress): readonly RevealIntent[] => [...meta(p).pending.values()];
export const activeRevealIntents = (p: RevealProgress): readonly RevealIntent[] => [...meta(p).active.values()];
/** Unresolved plus newly final inclusions. Future included history is not scanned on polls. */
export function readyRevealIntents(p: RevealProgress, final: bigint): readonly RevealIntent[] {
  const m = meta(p), result = [...m.pending.values()];
  while (m.heap.length && !m.included.get(requireRevealValue(m.heap[0]))?.size) popHeap(m);
  const visit = (at: number) => {
    const number = m.heap[at]; if (number === undefined || number > final) return;
    result.push(...(m.included.get(number)?.values() ?? [])); visit(at * 2 + 1); visit(at * 2 + 2);
  };
  visit(0); return result;
}
export const hasActiveRevealIds = (p: RevealProgress, ids: readonly string[]): boolean => ids.some(id => (meta(p).byId.get(id)?.size ?? 0) > 0);
export const findRevealIntent = (p: RevealProgress, attempt: string): RevealIntent | undefined => {
  const at = meta(p).positions.get(attempt); return at === undefined ? undefined : p.intents[at];
};
export async function readRevealProgress(store: RevealProgressStore, key: string, specHash: Hex): Promise<RevealProgress> {
  let cache = caches.get(store); if (!cache) { cache = new Map(); caches.set(store, cache); }
  const previous = cache.get(key);
  if (store.records) {
    const read = await store.records.read(key, previous ? journalRevision(previous) : undefined);
    if (read) {
      if (!sameHash(read.index.specHash, specHash)) invalid();
      if (!read.records) { if (!previous) return invalid(); return previous; }
      const progress = publicProgress({ version: 1, specHash, intents: read.records.map(t => JSON.parse(bounded(t)) as RevealIntent) }, specHash);
      if (progress.intents.length !== read.index.count) invalid();
      initialize(progress, read.index.revision); cache.set(key, progress); return progress;
    }
  }
  const text = await store.get(key);
  if (previous && meta(previous).legacyText === text) return previous;
  const progress = text === null ? { version: 1 as const, specHash, intents: [] } : publicProgress(JSON.parse(bounded(text)) as RevealProgress, specHash);
  initialize(progress, previous ? journalRevision(previous) + 1 : 0, text !== null && JSON.stringify(progress) !== text);
  meta(progress).legacyText = text;
  if (store.records && progress.intents.length) {
    requireRevealAuthority(store);
    const m = meta(progress);
    await store.records.commit(key, 0, { revision: 1, specHash, count: progress.intents.length, bytes: m.bytes },
      [...m.texts].map(([attempt, text]) => ({ attempt, text })));
    m.revision = 1;
  }
  cache.set(key, progress); return progress;
}
const sameHash = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
/** Validate and serialize only changed records; publish memory only after the atomic transaction commits. */
export async function saveRevealChanges(store: RevealProgressStore, key: string, progress: RevealProgress, changed: readonly RevealIntent[]): Promise<RevealProgress> {
  requireRevealAuthority(store);
  if (!metadata.has(progress)) { progress = publicProgress(progress, progress.specHash); initialize(progress); }
  const m = meta(progress);
  const updates: { intent: RevealIntent; text: string }[] = [];
  let bytes = m.bytes, count = progress.intents.length;
  const attempts = new Set<string>();
  for (const raw of changed) {
    journalWork.scanned++;
    if (attempts.has(raw.attempt)) invalid(); attempts.add(raw.attempt);
    const intent = requireRevealValue(publicProgress({ version: 1, specHash: progress.specHash, intents: [raw] }, progress.specHash).intents[0]);
    const text = JSON.stringify(intent); journalWork.serialized++;
    if (sizeOf(text) > PROGRESS_MAX_RECORD_BYTES) invalid();
    const old = m.texts.get(intent.attempt);
    if (text === old) continue;
    bytes += sizeOf(text) - (old ? sizeOf(old) : 0); if (old === undefined) count++;
    updates.push({ intent, text });
  }
  if (bytes > PROGRESS_MAX_BYTES || count > PROGRESS_MAX_INTENTS) invalid();
  if (!updates.length && !m.rewrite) return progress;
  if (store.records) {
    await store.records.commit(key, m.revision, { revision: m.revision + 1, specHash: progress.specHash, count, bytes },
      updates.map(({ intent, text }) => ({ attempt: intent.attempt, text })));
  } else {
    const byAttempt = new Map(updates.map(u => [u.intent.attempt, u.intent]));
    const intents = progress.intents.map(i => byAttempt.get(i.attempt) ?? i);
    for (const u of updates) if (!m.positions.has(u.intent.attempt)) intents.push(u.intent);
    const text = bounded(JSON.stringify({ ...progress, intents }));
    await store.put(key, text); m.legacyText = text;
  }
  // Internal live journal view; approved handles hold the scalar revision, never this mutable view.
  const intents = progress.intents as RevealIntent[];
  for (const { intent, text } of updates) {
    const position = m.positions.get(intent.attempt);
    const old = position === undefined ? undefined : intents[position];
    if (old && old.status !== 'refused') { m.spent -= BigInt(old.capWei); for (const id of old.ids) m.itemSpent.set(id, (m.itemSpent.get(id) ?? 0n) - BigInt(old.capWei)); }
    if (intent.status !== 'refused') { m.spent += BigInt(intent.capWei); for (const id of intent.ids) m.itemSpent.set(id, (m.itemSpent.get(id) ?? 0n) + BigInt(intent.capWei)); }
    if (position === undefined) { m.positions.set(intent.attempt, intents.length); intents.push(intent); }
    else intents[position] = intent;
    updateActive(m, old, intent);
    m.texts.set(intent.attempt, text); journalWork.bytes += sizeOf(text);
  }
  m.revision++; m.bytes = bytes; m.rewrite = false; return progress;
}
/** Compatibility import boundary. Reconciliation uses saveRevealChanges with only changed evidence. */
export async function saveRevealProgress(store: RevealProgressStore, key: string, previous: RevealProgress, value: RevealProgress): Promise<RevealProgress> {
  return saveRevealChanges(store, key, previous, value.intents);
}
export async function saveRevealIntent(store: RevealProgressStore, key: string, progress: RevealProgress, intent: RevealIntent): Promise<RevealProgress> {
  return saveRevealChanges(store, key, progress, [intent]);
}

/** The callback holds the lock until its promise settles. No lease that can expire during a wallet prompt. */
export interface RevealLock {
  run<T>(key: string, work: () => Promise<T>): Promise<{ acquired: false } | { acquired: true; value: T }>;
}
/** The session binds navigator.locks. Missing Web Locks fails closed; no localStorage lease fallback. */
export function webRevealLock(manager: Pick<LockManager, 'request'> | undefined): RevealLock | null {
  if (!manager) return null;
  return { run: (key, work) => manager.request(key, { mode: 'exclusive', ifAvailable: true }, async lock =>
    lock ? { acquired: true as const, value: await work() } : { acquired: false as const }) };
}
