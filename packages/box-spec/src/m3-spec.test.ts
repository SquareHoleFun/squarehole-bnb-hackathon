import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { encodeAbiParameters, parseAbiParameters, zeroAddress, zeroHash, type Address, type Hex } from 'viem';
import { loadModelV2, outputsV2, readSourcesV2 } from '../scripts/lib/outputs-v2.mjs';
import {
  decodeBoxSpecV2, decodeReleaseContextV2, encodeBoxSpecV2, specHashV2, validateBoxSpecV2,
  type BoxSpecV2, type BranchV2, type ReleaseContextV2,
} from './generated/box-spec.v2';

type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
const hash: Hex = `0x${'11'.repeat(32)}`;
const coin = '0x0000000000000000000000000000000000001111';
const ctx: ReleaseContextV2 = { listing: { id: 1, token: coin, decimals: 8, class: 4, kind: 1, raise: 1000000n } };
const word = (v: bigint) => encodeAbiParameters([{ type: 'uint256' }], [v]);
const pileBytes = (asset: Address = zeroAddress, seedAmount = 0n) => encodeAbiParameters(parseAbiParameters('(address asset, uint256 seedAmount)'), [{ asset, seedAmount }]);
const branch = (choice: number): Mutable<BranchV2> => ({ leg: choice === 2 ? 2 : 1,
  dest: choice === 1 ? 2 : choice === 2 ? 1 : choice === 3 ? 4 : choice === 4 ? 6 : 8,
  legParams: '0x', destParams: choice >= 4 ? word(choice === 6 ? 2n : 1n) : '0x' });
const side = (choice: number) => ({ a: branch(choice), b: { leg: 0, dest: 0, legParams: '0x' as Hex, destParams: '0x' as Hex }, split: 1, splitParams: '0x' as Hex });
const spec = (boxType = 1, b = 5, s = 6): Mutable<BoxSpecV2> => ({
  format: 2, version: 2, boxType, tokenName: 'Example', tokenSymbol: 'EX',
  collectionName: boxType === 1 ? 'Items' : '', collectionSymbol: boxType === 1 ? 'IT' : '',
  description: '', n: boxType === 1 ? 10 : 0, firstId: boxType === 1 ? 1n : 0n,
  pricing: { listingId: 1, token: coin }, raise: ctx.listing.raise,
  layout: 1, gradLayout: 3, launchFormat: 1, openAt: 0, deadlineDays: 30, buyers: side(b), sellers: side(s),
  artMode: boxType === 1 ? 1 : 0, revealRoot: boxType === 1 ? hash : zeroHash,
  metadataTable: boxType === 1 ? '0x01000000' : '0x', generatorHash: zeroHash, coverSha256: hash,
  revealListId: boxType === 1 ? hash : zeroHash, marketplaceOwner: boxType === 1 ? coin : zeroAddress,
  creatorFeeRecipient: b === 1 || s === 1 ? coin : zeroAddress, creatorBuy: 0n,
  collectionCoverSha256: boxType === 1 ? hash : zeroHash, addOns: [],
  contentsParams: boxType === 5 ? pileBytes() : '0x', pickFeeBps: boxType === 1 ? 100 : 0,
});
const ok = { reason: 0, field: 0 };

it('IP14 admits every Depth P/T combination and hashes the explicit choice', () => {
  for (const leg of [1, 2]) for (const name of ['buyers', 'sellers'] as const) {
    const s = spec(); const before = specHashV2(s);
    s[name].a.leg = leg; s[name].a.destParams = word(3n);
    expect(validateBoxSpecV2(s, ctx)).toEqual(ok);
    expect(decodeBoxSpecV2(encodeBoxSpecV2(s))).toEqual(s);
    expect(specHashV2(s)).not.toBe(before);
  }
});

it('BC-266 offers both Items policies and all mixed five-choice sides', () => {
  for (let b = 1; b <= 6; ++b) for (let s = 1; s <= 6; ++s) expect(validateBoxSpecV2(spec(1, b, s), ctx), `${b}/${s}`).toEqual(ok);
});

it('BC-259 refuses missing, unknown, padded, extended and legacy item policies on either side', () => {
  for (const name of ['buyers', 'sellers'] as const) {
    const field = name === 'buyers' ? 17004 : 18004;
    for (const v of [0n, 4n, 255n]) {
      const s = spec(); s[name].a.destParams = word(v);
      expect(validateBoxSpecV2(s, ctx)).toEqual({ reason: 3, field });
    }
    for (const params of ['0x', '0x01', word(256n), word(257n), `${word(1n)}00`, `${word(1n)}${word(0n).slice(2)}`] as Hex[]) {
      const s = spec(); s[name].a.destParams = params;
      expect(validateBoxSpecV2(s, ctx)).toEqual({ reason: 23, field });
    }
    for (const boxType of [2, 3, 5]) {
      const s = spec(boxType, 3, 3); s[name].a = branch(5);
      // EXISTING is not offered; the other types fail the Items box rule after field checks.
      expect(validateBoxSpecV2(s, ctx)).toEqual({ reason: 3, field: boxType === 2 ? 2 : field - 2 });
    }
  }
});

it('BC-266 refuses splits and every removed recipe field and refuses a pile fee destination when the asset differs from P', () => {
  for (const name of ['buyers', 'sellers'] as const) {
    for (const mutate of [
      (s: Mutable<BoxSpecV2>) => { s[name].a.legParams = '0x00'; },
      (s: Mutable<BoxSpecV2>) => { s[name].splitParams = '0x00'; },
      (s: Mutable<BoxSpecV2>) => { s[name].b.leg = 1; },
      (s: Mutable<BoxSpecV2>) => { s[name].b.dest = 8; },
      (s: Mutable<BoxSpecV2>) => { s[name].b.legParams = '0x00'; },
      (s: Mutable<BoxSpecV2>) => { s[name].b.destParams = '0x00'; },
    ]) { const s = spec(); mutate(s); expect(validateBoxSpecV2(s, ctx).reason).toBe(8); }
    for (const split of [2, 3, 4]) { const s = spec(); s[name].split = split; s[name].b = branch(3); expect(validateBoxSpecV2(s, ctx).reason).toBe(24); }
    const s = spec(5, 3, 3); s[name].a.dest = 7;
    expect(validateBoxSpecV2(s, ctx)).toEqual({ reason: 23, field: 30 });
  }
});

it('BC-266 admits only a canonical static PILE tuple, with native/zero/full-width seed', () => {
  for (const asset of [zeroAddress, coin, '0xffffffffffffffffffffffffffffffffffffffff'] as const) {
    for (const seed of [0n, 1n, 2n ** 200n, 2n ** 256n - 1n]) {
      const s = spec(5, 3, 4); s.contentsParams = pileBytes(asset, seed);
      expect(validateBoxSpecV2(s, ctx)).toEqual(ok);
      expect(decodeBoxSpecV2(encodeBoxSpecV2(s))).toEqual(s);
    }
  }
  for (const params of ['0x', '0x01', word(0n), `${pileBytes()}00`, `${word(1n << 160n)}${word(0n).slice(2)}`] as Hex[]) {
    const s = spec(5, 3, 3); s.contentsParams = params;
    expect(validateBoxSpecV2(s, ctx)).toEqual({ reason: 23, field: 30 });
  }
});

it('BC-266 keeps PILE collection fields and all collection/shop add-ons absent', () => {
  const values = { collectionName: 'x', collectionSymbol: 'x', n: 1, firstId: 1n, artMode: 1,
    revealRoot: hash, metadataTable: '0x00', generatorHash: hash, revealListId: hash,
    marketplaceOwner: coin, collectionCoverSha256: hash, pickFeeBps: 100 };
  for (const [key, value] of Object.entries(values)) {
    const s = spec(5, 3, 3); Object.assign(s, { [key]: value });
    expect(validateBoxSpecV2(s, ctx).reason, key).toBe(8);
  }
  for (const id of [1, 3, 4, 6, 7, 8]) {
    const s = spec(5, 3, 3); s.addOns = [{ id, params: '0x' }];
    expect(validateBoxSpecV2(s, ctx)).toEqual({ reason: 19, field: id * 100 });
  }
});

it('S1 retains exact P creation snapshots and hashes both policies and the independent seed', () => {
  for (const s of [spec(), spec(5, 3, 3)]) for (const decimals of [6, 8, 18]) {
    const context = { listing: { ...ctx.listing, decimals, raise: 2n ** 100n } };
    s.raise = context.listing.raise; expect(validateBoxSpecV2(s, context)).toEqual(ok);
    const oldHash = specHashV2(s);
    if (s.boxType === 1) s.buyers.a.destParams = word(2n);
    else s.contentsParams = pileBytes(coin, 2n ** 255n);
    expect(specHashV2(s)).not.toBe(oldHash);
    expect(validateBoxSpecV2(s, { listing: { ...context.listing, raise: s.raise + 1n } })).toEqual({ reason: 10, field: 11 });
    // Reset before the next decimal case.
    if (s.boxType === 1) s.buyers.a.destParams = word(1n); else s.contentsParams = pileBytes();
  }
});

it('S1 generator rejects frozen tuple drift and reproduces both twins', () => {
  for (const [file, before, after] of [
    ['RecipeTypes.sol', 'uint8 insidePolicy;', 'uint16 insidePolicy;'],
    ['SpecTypes.sol', 'uint256 seedAmount;', 'uint128 seedAmount;'],
  ]) {
    const sources = readSourcesV2(); const path = `packages/contracts/src/box-v2/interfaces/${file}`;
    sources.frozen[path] = (sources.frozen[path] ?? '').replace(before ?? '', after ?? '');
    expect(() => loadModelV2(sources)).toThrow(/ItemsDestParams|PileParams/);
  }
  for (const [path, text] of outputsV2(loadModelV2(readSourcesV2()))) {
    expect(readFileSync(path, 'utf8')).toBe(text);
    if (path.endsWith('.ts')) expect(text).toContain('export interface PileParamsV2');
  }
});

it('BC-266 all shared vectors preserve exact refusal, wire and hash parity', () => {
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
