import { describe, expect, it } from 'vitest';
import {
  FeedCursorError,
  FeedQueryError,
  MAX_FEED_LIMIT,
  paginateFeed,
  selectFeed,
  type FeedSelectionQuery,
  type PairRecord,
} from './index';
import { handoffFixture } from './test-support/handoff';
import { ids } from './test-support/pairs';

const SNAPSHOT = 'demo-20260925T120000Z';
const items = (): PairRecord[] => handoffFixture().items;

function collect(rows: readonly PairRecord[], query: FeedSelectionQuery, limit: number): { pages: string[][]; cursors: string[] } {
  const pages: string[][] = [];
  const cursors: string[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 100; guard += 1) {
    const page = paginateFeed(rows, { snapshotId: SNAPSHOT, query, cursor, limit });
    pages.push(ids(page.items));
    expect(page.totalMatches).toBe(rows.length);
    if (page.nextCursor === null) return { pages, cursors };
    cursors.push(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error('pagination did not terminate');
}

function cursorError(fn: () => unknown): FeedCursorError['code'] {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(FeedCursorError);
    return (error as FeedCursorError).code;
  }
  throw new Error('expected FeedCursorError');
}

describe('FEED-05 pagination inside one snapshot', () => {
  const QUERIES: FeedSelectionQuery[] = [
    {},
    { sort: 'new' },
    { sort: 'turnover' },
    { type: 'nft_collection' },
    { search: 'orch' },
    { lifecycle: 'curve', sort: 'turnover' },
    { search: 'zzz' },
  ];

  it.each(QUERIES.map((query) => [JSON.stringify(query), query] as const))(
    'every limit 1..13 concatenates to the full ordering without duplicates or skips (%s)',
    (_label, query) => {
      const full = ids(selectFeed(items(), query).rows);
      for (let limit = 1; limit <= 13; limit += 1) {
        const { pages, cursors } = collect(selectFeed(items(), query).rows, query, limit);
        const flat = pages.flat();
        expect(flat).toEqual(full);
        expect(new Set(flat).size).toBe(flat.length);
        expect(pages).toHaveLength(Math.max(1, Math.ceil(full.length / limit)));
        expect(new Set(cursors).size).toBe(cursors.length);
      }
    },
  );

  it('produces deterministic, opaque, URL-safe cursors', () => {
    const rows = selectFeed(items()).rows;
    const a = paginateFeed(rows, { snapshotId: SNAPSHOT, query: {}, limit: 4 }).nextCursor;
    const b = paginateFeed(rows, { snapshotId: SNAPSHOT, query: {}, limit: 4 }).nextCursor;
    expect(a).toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('treats equivalent queries as the same cursor scope (defaults, case, whitespace)', () => {
    const rows = selectFeed(items(), { search: 'orch' }).rows;
    const first = paginateFeed(rows, { snapshotId: SNAPSHOT, query: { search: 'orch' }, limit: 1 });
    const next = paginateFeed(rows, {
      snapshotId: SNAPSHOT,
      query: { search: '  ORCH ', sort: 'market_cap', type: 'all', lifecycle: 'all' },
      cursor: first.nextCursor ?? undefined,
      limit: 1,
    });
    expect(next.items).toHaveLength(1);
  });
});

describe('cursor binding and typed errors', () => {
  const rows = selectFeed(items()).rows;
  const cursor = paginateFeed(rows, { snapshotId: SNAPSHOT, query: {}, limit: 5 }).nextCursor ?? '';

  it('rejects a cursor from another snapshot', () => {
    expect(cursorError(() => paginateFeed(rows, { snapshotId: 'demo-other', query: {}, cursor, limit: 5 }))).toBe('snapshot_mismatch');
  });

  it('rejects a cursor used with a different query', () => {
    expect(cursorError(() => paginateFeed(rows, { snapshotId: SNAPSHOT, query: { sort: 'new' }, cursor, limit: 5 }))).toBe('query_mismatch');
  });

  it('rejects a cursor whose offset is beyond the result set', () => {
    const fewer = rows.slice(0, 3);
    expect(cursorError(() => paginateFeed(fewer, { snapshotId: SNAPSHOT, query: {}, cursor, limit: 5 }))).toBe('out_of_range');
  });

  const encode = (value: unknown): string => btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  it.each([
    ['empty', ''],
    ['not base64url', 'a+b/c='],
    ['not JSON', encode('x').slice(0, 3)],
    ['wrong version', encode({ v: 2, s: SNAPSHOT, o: 5, q: '' })],
    ['negative offset', encode({ v: 1, s: SNAPSHOT, o: -1, q: '' })],
    ['fractional offset', encode({ v: 1, s: SNAPSHOT, o: 1.5, q: '' })],
    ['extra keys', encode({ v: 1, s: SNAPSHOT, o: 5, q: '', x: 1 })],
    ['oversized', 'A'.repeat(4097)],
  ])('rejects a malformed cursor (%s)', (_label, value) => {
    expect(cursorError(() => paginateFeed(rows, { snapshotId: SNAPSHOT, query: {}, cursor: value, limit: 5 }))).toBe('malformed');
  });

  it.each([0, -1, 1.5, Number.NaN, MAX_FEED_LIMIT + 1])('rejects limit %s', (limit) => {
    expect(() => paginateFeed(rows, { snapshotId: SNAPSHOT, query: {}, limit })).toThrow(FeedQueryError);
  });

  it('accepts the maximum limit', () => {
    expect(paginateFeed(rows, { snapshotId: SNAPSHOT, query: {}, limit: MAX_FEED_LIMIT }).items).toHaveLength(rows.length);
  });
});
