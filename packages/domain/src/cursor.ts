/**
 * Stable snapshot pagination (FEED-05). A cursor is opaque to callers; internally it binds
 * { snapshot id, offset, query fingerprint }. Using it with another snapshot or another query is a typed error,
 * never a silent skip or duplicate (03-FEED: "A new snapshot resets cursor state").
 */
import { FeedCursorError, FeedQueryError } from './errors';
import { normalizeFeedQuery, type FeedSelectionQuery } from './feed';
import type { PairRecord } from './types';

export const MAX_FEED_LIMIT = 100;
const MAX_CURSOR_LENGTH = 1024;
const CURSOR_VERSION = 1;

export interface FeedPage {
  items: PairRecord[];
  nextCursor: string | null;
  /** Organic matches in the whole ordering (not just this page). */
  totalMatches: number;
}

export interface PaginateOptions {
  snapshotId: string;
  query: FeedSelectionQuery;
  cursor?: string;
  limit: number;
}

interface CursorPayload {
  v: number;
  s: string;
  o: number;
  q: string;
}

/** cyrb53: small deterministic 53-bit string hash (not cryptographic; it only scopes a cursor to its query). */
function hash53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Fingerprint of the normalised query: equivalent spellings (defaults, case, whitespace) share cursors. */
export function queryFingerprint(query: FeedSelectionQuery): string {
  const q = normalizeFeedQuery(query);
  return hash53(JSON.stringify([q.sort, q.type, q.lifecycle, q.rewardSide, q.rewardAddress, q.search]));
}

function toBase64Url(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function encodeCursor(payload: CursorPayload): string {
  return toBase64Url(JSON.stringify(payload));
}

function decodeCursor(cursor: string): CursorPayload {
  const malformed = new FeedCursorError('malformed', 'Unreadable feed cursor');
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) throw malformed;
  const text = fromBase64Url(cursor);
  if (text === null) throw malformed;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw malformed;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw malformed;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(',');
  const { v, s, o, q } = record;
  if (keys !== 'o,q,s,v' || v !== CURSOR_VERSION || typeof s !== 'string' || typeof q !== 'string') throw malformed;
  if (typeof o !== 'number' || !Number.isSafeInteger(o) || o < 0) throw malformed;
  return { v, s, o, q };
}

/**
 * One page of an already-ordered result (`selectFeed(...).rows`). Throws `FeedQueryError('invalid_limit')` and
 * `FeedCursorError('malformed' | 'snapshot_mismatch' | 'query_mismatch' | 'out_of_range')`.
 */
export function paginateFeed(rows: readonly PairRecord[], options: PaginateOptions): FeedPage {
  const { snapshotId, cursor, limit } = options;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_FEED_LIMIT) {
    throw new FeedQueryError('invalid_limit', `limit must be an integer between 1 and ${MAX_FEED_LIMIT}`);
  }
  const fingerprint = queryFingerprint(options.query);
  let offset = 0;
  if (cursor !== undefined) {
    const payload = decodeCursor(cursor);
    if (payload.s !== snapshotId) throw new FeedCursorError('snapshot_mismatch', 'Cursor belongs to another snapshot');
    if (payload.q !== fingerprint) throw new FeedCursorError('query_mismatch', 'Cursor belongs to another query');
    if (payload.o > rows.length) throw new FeedCursorError('out_of_range', 'Cursor offset is beyond the result set');
    offset = payload.o;
  }
  const end = offset + limit;
  return {
    items: rows.slice(offset, end),
    nextCursor: end < rows.length ? encodeCursor({ v: CURSOR_VERSION, s: snapshotId, o: end, q: fingerprint }) : null,
    totalMatches: rows.length,
  };
}
