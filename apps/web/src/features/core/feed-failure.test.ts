/**
 * XR2-ITEM-3D-V2 F2: one rule for when a feed that never answered is unreachable (feed-failure.ts), read off the query's
 * failure count, which a poll leaves alone (its status goes back to pending; query-core query.js fetchState).
 */
import { QueryClient, hashKey, type Query } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { NO_RETRIES, failedSince, unansweredFeed } from './feed-failure';

const KEY = ['v2-feed', 'local', 31337, 'http://indexer.test'] as const;

describe('failedSince', () => {
  it('no answer kept: failed from the first failure, through later polls, until an answer', () => {
    expect(failedSince({ data: undefined, errorUpdateCount: 0 }, KEY)).toBe(false);
    expect(failedSince({ data: undefined, errorUpdateCount: 1 }, KEY)).toBe(true);
    expect(failedSince({ data: undefined, errorUpdateCount: 3 }, KEY, NO_RETRIES)).toBe(true);
    expect(failedSince({ data: { cards: [] }, errorUpdateCount: 3 }, KEY)).toBe(false);
  });
  it('after a Retry only a later failure counts, and only for the feed it was recorded for', () => {
    const retries = new Map([[hashKey(KEY), 2]]);
    expect(failedSince({ data: undefined, errorUpdateCount: 2 }, KEY, retries)).toBe(false);
    expect(failedSince({ data: undefined, errorUpdateCount: 3 }, KEY, retries)).toBe(true);
    expect(failedSince({ data: undefined, errorUpdateCount: 2 }, ['core-feed', 'local', 31337, 'direct'], retries)).toBe(true);
  });
});

describe('unansweredFeed', () => {
  it('the feed queries that failed with no answer kept, and no other query', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const fail = (key: readonly unknown[]) => client.fetchQuery({ queryKey: key, queryFn: async () => { throw new Error('down'); } }).catch(() => undefined);
    await fail(KEY);
    await fail(['core-box', 'local', 31337, '0x1']);
    await client.fetchQuery({ queryKey: ['set-feed', 31337, '0xabc', 'http://indexer.test'], queryFn: async () => ({ boxes: [] }) });
    await fail(['core-feed', 'local', 31337, 'direct']);
    const queries = client.getQueryCache().findAll() as Query[];
    expect(queries.filter(unansweredFeed).map((query) => query.queryKey[0]).sort()).toEqual(['core-feed', 'v2-feed']);
    // The hash the page records is the one the hooks look up.
    expect(client.getQueryCache().find({ queryKey: KEY, exact: true })?.queryHash).toBe(hashKey(KEY));
  });
});
