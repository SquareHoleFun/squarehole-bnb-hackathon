/** Test-only helpers for provider tests. */
import { expect } from 'vitest';
import type { FeedProvider, FeedQuery, FeedSnapshot, PairId, PairRecord } from '@squarehole/domain';

export const query = (overrides: Partial<FeedQuery> = {}): FeedQuery => ({
  search: '',
  sort: 'market_cap',
  type: 'all',
  lifecycle: 'all',
  limit: 50,
  ...overrides,
});

export const ids = (rows: readonly Pick<PairRecord, 'pairId'>[]): string[] => rows.map((row) => row.pairId);
export const pid = (suffix: string): PairId => `31337:0x${suffix.padStart(40, '0')}`;

/** Follows cursors until exhausted and returns every page. */
export async function readAllPages(provider: FeedProvider, base: FeedQuery): Promise<FeedSnapshot[]> {
  const pages: FeedSnapshot[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 100; guard += 1) {
    const page = await provider.readFeed({ ...base, cursor });
    pages.push(page);
    if (page.nextCursor === null) return pages;
    cursor = page.nextCursor;
  }
  throw new Error('pagination did not terminate');
}

export async function expectAbortError(promise: Promise<unknown>): Promise<void> {
  const error: unknown = await promise.then(
    () => new Error('expected rejection'),
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(DOMException);
  expect((error as DOMException).name).toBe('AbortError');
}

/** Resolves true if the promise settles within the current macrotask turn (used with fake timers). */
export async function settles(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  return settled;
}
