/**
 * SH-EXISTING-NFTS-E08C: the existing-NFTs Create flow's draft: the price coin, names, logo, the collection and the
 * pasted ids, the pick fee, the deadline, an optional first buy, and which list file was saved for which set hash.
 *
 * Its own store (the format 2 flow's draft keeps its own; a creator can have both open), kept for this tab in
 * sessionStorage `sh.create.set.v1` (listed in the privacy notice, features/legal/privacy.ts) so a reload keeps it; best
 * effort, every access in try/catch, and a stored value is checked before use (a logo's bytes must match its hash). Ids
 * stay the text the creator pasted; they are parsed into bigint where they are used (set-ids.ts).
 */
import { useSyncExternalStore } from 'react';
import type { Hex } from 'viem';
import { sha256Hex } from '@squarehole/artwork';
import { SET_LIST_SCHEMA } from '@squarehole/box-spec';
import type { CoverState } from '../create-model';

export const SET_PICK_FEES: readonly number[] = /* @__PURE__ */ Object.freeze([100, 500, 2_500]);
export const SET_DEADLINE_DAYS: readonly number[] = /* @__PURE__ */ Object.freeze([30, 60, 90, 180]);

/** The list file saved for a set: its schema and the set hash it binds (never a bare yes). */
export interface ListAck {
  readonly schema: typeof SET_LIST_SCHEMA;
  readonly setHash: Hex;
}

export interface SetDraft {
  /** The price coin's address; '' takes the first listed coin. */
  readonly pricing: string;
  readonly name: string;
  readonly ticker: string;
  readonly about: string;
  readonly logo: CoverState | null;
  /** The outside collection's address, as typed. */
  readonly collection: string;
  /** The ids, as pasted. */
  readonly ids: string;
  readonly pickFeeBps: number;
  readonly deadlineDays: number;
  /** The creator's coins at the start (the first buy), as typed: "" or "0.05". */
  readonly firstIn: string;
  readonly listSaved: ListAck | null;
}

export const EMPTY_SET_DRAFT: SetDraft = /* @__PURE__ */ Object.freeze({
  pricing: '', name: '', ticker: '', about: '', logo: null, collection: '', ids: '', pickFeeBps: 500, deadlineDays: 30, firstIn: '', listSaved: null,
});

const KEY = 'sh.create.set.v1';
const HEX32 = /^0x[0-9a-f]{64}$/;
/** A stored draft larger than this is not read back (10,000 long ids and a logo fit well within it). */
const MAX_STORED_CHARS = 4 * 1024 * 1024;

const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.length <= max ? value : null);

function fromBase64(data: string): Uint8Array | null {
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function readLogo(value: unknown): CoverState | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const c = value as Record<string, unknown>;
  if (typeof c.sha256 !== 'string' || !HEX32.test(c.sha256) || typeof c.bytes !== 'number' || !Number.isSafeInteger(c.bytes) || typeof c.data !== 'string') return undefined;
  if (c.url !== null && (typeof c.url !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(c.url))) return undefined;
  const bytes = fromBase64(c.data);
  if (!bytes || bytes.length !== c.bytes || sha256Hex(bytes).toLowerCase() !== c.sha256) return undefined;
  return { sha256: c.sha256 as Hex, url: c.url as string | null, bytes: c.bytes, data: c.data };
}

/** A stored draft, checked field by field; null when it is not one (the page starts empty). */
export function parseSetDraft(raw: string | null): SetDraft | null {
  if (raw === null || raw.length > MAX_STORED_CHARS) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const fields = {
      pricing: text(v.pricing, 42), name: text(v.name, 256), ticker: text(v.ticker, 64), about: text(v.about, 4096),
      collection: text(v.collection, 256), ids: text(v.ids, 2 * 1024 * 1024), firstIn: text(v.firstIn, 128),
    };
    if (Object.values(fields).some((field) => field === null)) return null;
    const logo = readLogo(v.logo);
    if (logo === undefined) return null;
    if (typeof v.pickFeeBps !== 'number' || !SET_PICK_FEES.includes(v.pickFeeBps) || typeof v.deadlineDays !== 'number' || !SET_DEADLINE_DAYS.includes(v.deadlineDays)) return null;
    const ack = v.listSaved as Record<string, unknown> | null;
    const listSaved = ack !== null && typeof ack === 'object' && ack.schema === SET_LIST_SCHEMA && typeof ack.setHash === 'string' && HEX32.test(ack.setHash)
      ? { schema: SET_LIST_SCHEMA as typeof SET_LIST_SCHEMA, setHash: ack.setHash as Hex } : null;
    return { ...(fields as { [K in keyof typeof fields]: string }), logo, pickFeeBps: v.pickFeeBps, deadlineDays: v.deadlineDays, listSaved };
  } catch {
    return null;
  }
}

let state: SetDraft = EMPTY_SET_DRAFT;
let loaded = false;
const listeners = new Set<() => void>();

function load(): SetDraft {
  if (loaded) return state;
  loaded = true;
  try {
    state = parseSetDraft(window.sessionStorage.getItem(KEY)) ?? EMPTY_SET_DRAFT;
  } catch {
    // Blocked storage: the draft lives in memory for this page load.
  }
  return state;
}

function write(next: SetDraft): void {
  try {
    if (next === EMPTY_SET_DRAFT) window.sessionStorage.removeItem(KEY);
    else window.sessionStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Too large or blocked: kept in memory for this page load.
  }
}

/** Typing saves a moment later (10,000 pasted ids are large); leaving or hiding the page saves at once. */
let pending: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
function flush(): void {
  if (pending !== null) clearTimeout(pending);
  pending = null;
  write(state);
}
function save(next: SetDraft): void {
  if (next === EMPTY_SET_DRAFT) {
    flush();
    return;
  }
  if (pending !== null) clearTimeout(pending);
  pending = setTimeout(flush, 250);
  if (!flushing && typeof window !== 'undefined') {
    flushing = true;
    window.addEventListener('pagehide', flush);
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const currentSetDraft = (): SetDraft => load();
export const useSetDraft = (): SetDraft => useSyncExternalStore(subscribe, load, load);

export function updateSetDraft(change: (draft: SetDraft) => SetDraft): void {
  state = change(load());
  save(state);
  for (const listener of listeners) listener();
}

/** Start over: the empty draft, and nothing stored. */
export function clearSetDraft(): void {
  updateSetDraft(() => EMPTY_SET_DRAFT);
}

/** Test seam: forget the draft in memory (the next read takes the stored one again). */
export function resetSetDraftForTests(): void {
  if (pending !== null) clearTimeout(pending);
  pending = null;
  state = EMPTY_SET_DRAFT;
  loaded = false;
  for (const listener of listeners) listener();
}
