// Admission regressions for the generated v2 validator; this file is authored test code.
import { expect, it } from 'vitest';
import { encodeAbiParameters, parseAbiParameters, zeroAddress, zeroHash } from 'viem';
import { validateBoxSpecV2, type BoxSpecV2, type ReleaseContextV2 } from './box-spec.v2';

const abi = parseAbiParameters('(uint256 seedT, uint256[4] givePricesT, uint16 pickBps, uint16 weeklyBps, uint16 collectionBps, uint32 listDelay, address curator, address[] collections, uint8[] tiers)');
const nft = '0x0000000000000000000000000000000000000721' as const;
const unit = 10n ** 18n;
const config = () => ({ seedT: 40n * 10n ** 18n,
  givePricesT: [unit, 2n * unit, 4n * unit, 8n * unit] as [bigint, bigint, bigint, bigint],
  pickBps: 15000, weeklyBps: 1000, collectionBps: 250, listDelay: 604800,
  curator: zeroAddress, collections: [nft], tiers: [0],
});
const ctx: ReleaseContextV2 = { listing: { id: 0, token: zeroAddress, decimals: 18, class: 1, kind: 1, raise: 1000000n } };
const side = () => ({ a: { leg: 1, dest: 4, legParams: '0x' as const, destParams: '0x' as const },
  b: { leg: 0, dest: 0, legParams: '0x' as const, destParams: '0x' as const }, split: 1, splitParams: '0x' as const });
function verdict(c: ReturnType<typeof config>) {
  const s: BoxSpecV2 = {
    format: 2, version: 2, boxType: 4, tokenName: 'Shop', tokenSymbol: 'SHOP', collectionName: '', collectionSymbol: '',
    description: '', n: 0, firstId: 0n, pricing: { listingId: 0, token: zeroAddress }, raise: ctx.listing.raise,
    layout: 1, gradLayout: 3, launchFormat: 1, openAt: 0, deadlineDays: 30, buyers: side(), sellers: side(),
    artMode: 0, revealRoot: zeroHash, metadataTable: '0x', generatorHash: zeroHash, coverSha256: `0x${'11'.repeat(32)}`,
    revealListId: zeroHash, marketplaceOwner: zeroAddress, creatorFeeRecipient: zeroAddress, creatorBuy: 0n,
    collectionCoverSha256: zeroHash, pickFeeBps: 0, contentsParams: encodeAbiParameters(abi, [c]),
    addOns: [{ id: 7, params: '0x' }, { id: 8, params: encodeAbiParameters(parseAbiParameters('bytes32, uint32'), [zeroHash, 0]) }],
  };
  return validateBoxSpecV2(s, ctx);
}
const ok = { reason: 0, field: 0 };
const refused = { reason: 4, field: 30 };

it('F132 refuses one give of seed and accepts exactly two', () => {
  const c = config(); c.seedT = 10n ** 18n; expect(verdict(c)).toEqual(refused);
  c.seedT = 2n * unit - 1n; expect(verdict(c)).toEqual(refused);
  c.seedT += 1n; expect(verdict(c)).toEqual(ok);
});

it('requires a nonempty initial list and positive sufficient seed', () => {
  const c = config(); c.seedT = 0n; expect(verdict(c)).toEqual(refused);
  c.seedT = (1n << 256n) - 1n; c.collections = []; c.tiers = [];
  expect(verdict(c)).toEqual(refused);
});

it('uses the cheapest listed tier and two-give boundary for every collection cap', () => {
  for (const bps of [100, 250, 500]) for (const tier of [0, 1, 2, 3] as const) {
    const c = config(); c.collectionBps = bps; c.tiers = [tier];
    c.givePricesT = [1n, 3n, 7n, 11n];
    const minimum = c.givePricesT[tier];
    c.seedT = minimum * 2n;
    expect(verdict(c)).toEqual(ok); c.seedT -= 1n; expect(verdict(c)).toEqual(refused);
  }
});

it('handles full uint256 amounts without overflowing or accepting an impossible minimum', () => {
  const c = config(); const max = (1n << 256n) - 1n;
  const price = max / 10000n + 1n;
  c.givePricesT = [price, price + 1n, price + 2n, price + 3n];
  c.seedT = price * 2n;
  expect(verdict(c)).toEqual(ok); c.seedT -= 1n; expect(verdict(c)).toEqual(refused);
  c.givePricesT = [max / 2n + 1n, max / 2n + 2n, max / 2n + 3n, max / 2n + 4n];
  c.seedT = max; expect(verdict(c)).toEqual(refused);
});
