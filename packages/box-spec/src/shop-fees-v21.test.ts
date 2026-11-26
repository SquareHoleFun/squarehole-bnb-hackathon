// Admission regressions for the generated v2 validator; this file is authored test code.
import { expect, it } from 'vitest';
import { encodeAbiParameters, parseAbiParameters, zeroAddress, zeroHash } from 'viem';
import { validateBoxSpecV2, type BoxSpecV2, type ReleaseContextV2 } from './generated/box-spec.v2';

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
function spec(c: ReturnType<typeof config>) {
  const s: BoxSpecV2 = {
    format: 2, version: 2, boxType: 4, tokenName: 'Shop', tokenSymbol: 'SHOP', collectionName: '', collectionSymbol: '',
    description: '', n: 0, firstId: 0n, pricing: { listingId: 0, token: zeroAddress }, raise: ctx.listing.raise,
    layout: 1, gradLayout: 3, launchFormat: 1, openAt: 0, deadlineDays: 30, buyers: side(), sellers: side(),
    artMode: 0, revealRoot: zeroHash, metadataTable: '0x', generatorHash: zeroHash, coverSha256: `0x${'11'.repeat(32)}`,
    revealListId: zeroHash, marketplaceOwner: zeroAddress, creatorFeeRecipient: zeroAddress, creatorBuy: 0n,
    collectionCoverSha256: zeroHash, pickFeeBps: 0, contentsParams: encodeAbiParameters(abi, [c]),
    addOns: [{ id: 7, params: '0x' }, { id: 8, params: encodeAbiParameters(parseAbiParameters('bytes32, uint32'), [zeroHash, 0]) }],
  };
  return s;
}
const ok = { reason: 0, field: 0 };

const shopSide = (preset: number) => ({ ...side(), a: { leg: 2, dest: 7, legParams: '0x' as const, destParams: encodeAbiParameters(parseAbiParameters('uint8'), [preset]) } });
it('SF01 admits sellers ShopT with canonical 2x/4x/8x and refuses buyers, other boxes and malformed params', () => {
  for (const preset of [2, 4, 8]) {
    const s = { ...spec(config()), sellers: shopSide(preset) };
    expect(validateBoxSpecV2(s, ctx)).toEqual(ok);
    expect(validateBoxSpecV2({ ...s, buyers: shopSide(preset) }, ctx).reason).not.toBe(0);
    expect(validateBoxSpecV2({ ...s, boxType: 5 }, ctx).reason).not.toBe(0);
    for (const destParams of ['0x', '0x02', `${s.sellers.a.destParams}00`, encodeAbiParameters(parseAbiParameters('uint256'), [258n])] as const) {
      expect(validateBoxSpecV2({ ...s, sellers: { ...s.sellers, a: { ...s.sellers.a, destParams } } }, ctx).reason).not.toBe(0);
    }
  }
  for (const preset of [0, 1, 3, 16, 255]) expect(validateBoxSpecV2({ ...spec(config()), sellers: shopSide(preset) }, ctx).reason).not.toBe(0);
});
