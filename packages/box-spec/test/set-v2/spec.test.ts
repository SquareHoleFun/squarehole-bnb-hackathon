import { describe, expect, it } from 'vitest';
import { keccak256, stringToHex, zeroAddress } from 'viem';
import { validateSetSpecV2 } from '../../src/set-v2/index';

const spec = {
  format: 2,
  schema: keccak256(stringToHex('SquareHole.SetSpecV2.v1')),
  release: keccak256(stringToHex('SquareHole.ExistingNFTs.v1')),
  tokenName: 'Outside Set', tokenSymbol: 'SET',
  pricing: { listingId: 0, token: zeroAddress }, raise: 4206980085000000000n,
  openAt: 0, deadlineDays: 30, creatorBuy: 0n,
  collection: '0x1111111111111111111111111111111111111111' as const,
  count: 10, setHash: keccak256(stringToHex('set')), pickFeeBps: 500,
  description: 'Named picks and returns', logoSha256: keccak256(stringToHex('logo')),
};
const context = {
  listing: { id: 0, token: zeroAddress, decimals: 18, class: 1, kind: 1, raise: spec.raise },
  timestamp: 1792800000n,
};

describe('SET-01 count admission', () => {
  it.each([9, 10, 10000, 10001])('N=%s', (count) => {
    expect(validateSetSpecV2({ ...spec, count }, context)).toEqual(
      count < 10 || count > 10000 ? { reason: 4, field: 11 } : { reason: 0, field: 0 },
    );
  });
});

it.each([
  ['format', 1, 1, 0], ['schema', `0x${'00'.repeat(32)}`, 1, 1], ['release', `0x${'00'.repeat(32)}`, 1, 2],
  ['tokenName', '', 5, 3], ['tokenName', 'a'.repeat(33), 5, 3], ['tokenName', '"', 6, 3],
  ['tokenSymbol', 'a'.repeat(12), 5, 4], ['tokenSymbol', '\\', 6, 4],
  ['pricing', { listingId: 1, token: zeroAddress }, 21, 5],
  ['pricing', { listingId: 0, token: spec.collection }, 22, 5],
  ['raise', 0n, 10, 6], ['raise', spec.raise + 1n, 10, 6],
  ['openAt', 1, 4, 7], ['openAt', 1794009601, 4, 7], ['deadlineDays', 31, 12, 8],
  ['creatorBuy', spec.raise, 4, 9], ['collection', zeroAddress, 7, 10],
  ['setHash', `0x${'00'.repeat(32)}`, 7, 12], ['pickFeeBps', 501, 2, 13],
  ['description', 'a'.repeat(1025), 5, 14], ['description', '\n', 6, 14],
  ['logoSha256', `0x${'00'.repeat(32)}`, 7, 15],
])('refusal %s = %s', (key, value, reason, field) => {
  expect(validateSetSpecV2({ ...spec, [key as string]: value }, context)).toEqual({ reason, field });
});

it('keeps pricing admission, time horizon, fee and deadline presets', () => {
  expect(validateSetSpecV2(spec, { ...context, listing: { ...context.listing, kind: 0 } })).toEqual({ reason: 21, field: 5 });
  for (const pickFeeBps of [100, 500, 2500]) for (const deadlineDays of [30, 60, 90, 180]) {
    expect(validateSetSpecV2({ ...spec, pickFeeBps, deadlineDays, openAt: 1794009600 }, context).reason).toBe(0);
  }
  expect(validateSetSpecV2({ ...spec, openAt: 1788220800 }, context).reason).toBe(0);
});
