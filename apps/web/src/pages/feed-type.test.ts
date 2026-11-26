import { describe, expect, it } from 'vitest';
import { feedTypeLabel, parseFeedType } from './feed-type';

describe('parseFeedType (SH-006 extends the same Map lookup)', () => {
  it('returns the known feed types', () => {
    expect(parseFeedType('token')).toBe('token');
    expect(parseFeedType('nft_collection')).toBe('nft_collection');
  });

  it.each([null, '', 'all', 'Token', '__proto__', 'constructor', 'toString'])('treats %s as "all"', (raw) => {
    expect(parseFeedType(raw)).toBe('all');
  });
});

describe('feedTypeLabel', () => {
  it.each([
    ['token', 'Tokens'],
    ['nft_collection', 'NFT collections'],
  ])('labels the known feed type %s', (raw, label) => {
    expect(feedTypeLabel(raw)).toBe(label);
  });

  it('returns null when the parameter is absent or empty', () => {
    expect(feedTypeLabel(null)).toBeNull();
    expect(feedTypeLabel('')).toBeNull();
  });

  // The value comes from the URL, so names inherited from Object.prototype must never resolve to anything.
  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', '__defineGetter__'])(
    'returns null for the inherited name %s',
    (raw) => {
      expect(feedTypeLabel(raw)).toBeNull();
    },
  );

  it('is exact: no case folding, trimming or partial matches', () => {
    expect(feedTypeLabel('Token')).toBeNull();
    expect(feedTypeLabel(' token')).toBeNull();
    expect(feedTypeLabel('nft')).toBeNull();
  });
});
