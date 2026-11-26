// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { MAX_QUERY_LENGTH, normaliseQuery } from './search-url';

// URL building for the search moved to features/feed/feed-params.ts (serialiseFeedParams), tested there.
describe('normaliseQuery', () => {
  it('trims and collapses whitespace', () => {
    expect(normaliseQuery('  orchard   tree ')).toBe('orchard tree');
    expect(normaliseQuery('\t\n')).toBe('');
  });

  it('caps the length so a pasted blob cannot bloat the URL', () => {
    expect(normaliseQuery('x'.repeat(500))).toHaveLength(MAX_QUERY_LENGTH);
  });
});
