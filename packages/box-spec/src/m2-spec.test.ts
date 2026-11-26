import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { shopCases, solidityCases } from '../../contracts/test/box-v2/m2-10/shop-cases.mjs';
import { encodeAbiParameters, parseAbiParameters, zeroAddress, zeroHash, type Hex } from 'viem';
import { loadModelV2, outputsV2, readSourcesV2 } from '../scripts/lib/outputs-v2.mjs';
import {
  decodeBoxSpecV2, decodeReleaseContextV2, encodeBoxSpecV2, specHashV2, validateBoxSpecV2,
  type BoxSpecV2, type BranchV2, type ReleaseContextV2,
} from './generated/box-spec.v2';

type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
const ctx: Mutable<ReleaseContextV2> = { listing: {
  id: 1, token: '0x0000000000000000000000000000000000001111', decimals: 8, class: 4, kind: 1, raise: 1000000n,
} };
const holderParams = encodeAbiParameters([{ type: 'uint8' }], [1]);
const holder = (): Mutable<BranchV2> => ({ leg: 1, dest: 6, legParams: '0x', destParams: holderParams });
const side = () => ({ a: holder(), b: { leg: 0, dest: 0, legParams: '0x' as Hex, destParams: '0x' as Hex }, split: 1, splitParams: '0x' as Hex });
const spec = (): Mutable<BoxSpecV2> => ({
  format: 2, version: 2, boxType: 3, tokenName: 'Example', tokenSymbol: 'EX', collectionName: '', collectionSymbol: '',
  description: '', n: 0, firstId: 0n, pricing: { listingId: 1, token: ctx.listing.token }, raise: ctx.listing.raise,
  layout: 1, gradLayout: 3, launchFormat: 1, openAt: 0, deadlineDays: 30, buyers: side(), sellers: side(),
  artMode: 0, revealRoot: zeroHash, metadataTable: '0x', generatorHash: zeroHash,
  coverSha256: `0x${'11'.repeat(32)}`, revealListId: zeroHash, marketplaceOwner: zeroAddress,
  creatorFeeRecipient: zeroAddress, creatorBuy: 0n, collectionCoverSha256: zeroHash, addOns: [], contentsParams: '0x', pickFeeBps: 0,
});
// Frozen IShopVaultV2 tuple, independent of the generator's field checks.
const shopAbi = parseAbiParameters('(uint256 seedT, uint256[4] givePricesT, uint16 pickBps, uint16 weeklyBps, uint16 collectionBps, uint32 listDelay, address curator, address[] collections, uint8[] tiers)');
const config = () => ({ seedT: 10000n, givePricesT: [100n, 200n, 300n, 400n] as const,
  pickBps: 12500, weeklyBps: 1000, collectionBps: 250, listDelay: 604800, curator: zeroAddress,
  collections: ['0x0000000000000000000000000000000000000721'] as const, tiers: [0] });
const shop = (): Mutable<BoxSpecV2> => ({ ...spec(), boxType: 4, contentsParams: encodeAbiParameters(shopAbi, [config()]), addOns: [{ id: 7, params: '0x' }, starter(zeroHash, 0)] });
const starter = (hash: Hex, count: number) => ({ id: 8, params: encodeAbiParameters(parseAbiParameters('bytes32, uint32'), [hash, count]) });
const ok = { reason: 0, field: 0 };

it('M210 offers holders on both sides in native, 6-, 8- and 18-decimal P without a conversion', () => {
  for (const decimals of [6, 8, 18]) {
    const context = structuredClone(ctx); context.listing.decimals = decimals;
    const s = spec(); s.raise = 2n ** 100n; context.listing.raise = s.raise;
    expect(validateBoxSpecV2(s, context)).toEqual(ok);
  }
  const s = spec(); s.pricing = { listingId: 0, token: zeroAddress };
  expect(validateBoxSpecV2(s, { listing: { ...ctx.listing, id: 0, token: zeroAddress, decimals: 18, class: 1 } })).toEqual(ok);
});

it('M210 refuses every non-menu leg/destination combination on either side', () => {
  for (const name of ['buyers', 'sellers'] as const) for (let leg = 0; leg <= 6; ++leg) for (let dest = 0; dest <= 9; ++dest) {
    const s = spec(); s[name].a = { leg, dest, legParams: '0x', destParams: dest === 6 ? holderParams : '0x' };
    if (dest === 2) s.creatorFeeRecipient = ctx.listing.token;
    const valid = (leg === 1 && [1, 2, 4, 6].includes(dest)) || (leg === 2 && dest === 1);
    expect(validateBoxSpecV2(s, ctx).reason === 0, `${name}/${leg}/${dest}`).toBe(valid);
  }
});

it('M210 refuses splits, dirty holder words, and every populated second-branch field', () => {
  for (const name of ['buyers', 'sellers'] as const) {
    for (const split of [0, 2, 3, 4, 255]) { const s = spec(); s[name].split = split; expect(validateBoxSpecV2(s, ctx).reason).not.toBe(0); }
    for (const destParams of ['0x', '0x01', `${holderParams}00`, encodeAbiParameters([{ type: 'uint256' }], [257n])]) {
      const s = spec(); s[name].a.destParams = destParams as Hex;
      expect(validateBoxSpecV2(s, ctx)).toEqual({ reason: 23, field: name === 'buyers' ? 17004 : 18004 });
    }
    for (const b of [{ leg: 1 }, { dest: 6 }, { legParams: '0x00' }, { destParams: '0x00' }]) {
      const s = spec(); Object.assign(s[name].b, b); expect(validateBoxSpecV2(s, ctx).reason).toBe(8);
    }
  }
});

it('M210 admits SHOP, add-on 7 and exact empty or nonempty starter commitments', () => {
  const s = shop(); expect(validateBoxSpecV2(s, ctx)).toEqual(ok);
  for (const count of [0, 10, 10000]) {
    s.addOns = [{ id: 7, params: '0x' }, starter(count === 0 ? zeroHash : s.coverSha256, count)];
    expect(validateBoxSpecV2(s, ctx)).toEqual(ok);
  }
  for (const count of [1, 9, 10001]) {
    s.addOns[1] = starter(s.coverSha256, count); expect(validateBoxSpecV2(s, ctx).reason).not.toBe(0);
  }
  s.addOns[1] = starter(zeroHash, 10); expect(validateBoxSpecV2(s, ctx).reason).toBe(19);
  s.addOns[1] = starter(s.coverSha256, 0); expect(validateBoxSpecV2(s, ctx).reason).toBe(19);
  s.addOns = []; expect(validateBoxSpecV2(s, ctx)).toEqual({ reason: 18, field: 29 });
});

it('M210 preserves creation raise matching and hash binding for stock-priced shops', () => {
  const s = shop(); const hash = specHashV2(s);
  const fresh = structuredClone(ctx); fresh.listing.raise += 1n;
  expect(validateBoxSpecV2(s, fresh)).toEqual({ reason: 10, field: 11 });
  expect(validateBoxSpecV2(s, ctx)).toEqual(ok);
  s.raise = fresh.listing.raise; expect(validateBoxSpecV2(s, fresh)).toEqual(ok);
  expect(specHashV2(s)).not.toBe(hash);
});

it('M210 generated twins reproduce byte for byte', () => {
  for (const [path, contents] of outputsV2(loadModelV2(readSourcesV2()))) expect(readFileSync(path, 'utf8')).toBe(contents);
});

it('M210 all independent shared vectors retain verdict, wire and hash parity', () => {
  const v = JSON.parse(readFileSync(new URL('../../contracts/test/vectors/box-spec/box-spec-v2.json', import.meta.url), 'utf8')) as {
    contexts: { encoded: Hex }[]; columns: { name: string[]; encoded: Hex[]; context: number[]; reason: number[]; field: number[]; specHash: Hex[] };
  };
  v.columns.encoded.forEach((encoded, i) => {
    const context = v.contexts[v.columns.context[i] ?? -1]; if (!context) throw new Error('missing context');
    const s = decodeBoxSpecV2(encoded);
    expect(validateBoxSpecV2(s, decodeReleaseContextV2(context.encoded)), v.columns.name[i]).toEqual({ reason: v.columns.reason[i], field: v.columns.field[i] });
    expect(encodeBoxSpecV2(s)).toBe(encoded); expect(specHashV2(s)).toBe(v.columns.specHash[i]);
  });
});

it('M210C both validators consume every independent opaque shop case', () => {
  for (const c of shopCases) {
    const s = shop(); s.contentsParams = c.contents;
    if (c.flags === 0) s.addOns = [{ id: 7, params: '0x' }];
    if (c.flags === 2) s.addOns = [];
    if (c.flags === 3) s.raise += 1n;
    if (c.flags === 4) s.n = 10;
    expect(validateBoxSpecV2(s, ctx), c.name).toEqual({ reason: c.reason, field: c.field });
  }
  expect(readFileSync(new URL('../../contracts/test/box-v2/m2-10/ShopCases.sol', import.meta.url), 'utf8')).toBe(solidityCases());
});

it('M210C refuses drift in the frozen shop shape and consumes shop presets', () => {
  const sources = readSourcesV2();
  const shape = 'packages/contracts/src/box-v2/interfaces/IShopVaultV2.sol';
  expect(sources.frozen[shape]).toContain('struct ShopConfigV2');
  sources.frozen[shape] = (sources.frozen[shape] ?? '').replace('uint16 pickBps;', 'uint32 pickBps;');
  expect(() => loadModelV2(sources)).toThrow(/shop|ShopConfigV2/);
  const presets = readSourcesV2();
  (presets.spec.shop as { pickBps: number[] }).pickBps = [12600];
  for (const [, text] of outputsV2(loadModelV2(presets))) {
    expect(text).toMatch(/12_600|12600/);
  }
});
