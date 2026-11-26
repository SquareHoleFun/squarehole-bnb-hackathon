import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { concatHex, encodeAbiParameters, keccak256, zeroHash, type Address, type Hex } from 'viem';
import data from '../../vectors/set-v2/vectors.json';
import {
  SET_SCHEMA, SET_RELEASE, SET_TEMPLATE, buildSetCommitment, decodeSetSpecV2, encodeSetLink, encodeSetSpecV2,
  parseSetSpecV2, parseSetPage, setSpecV2Hash, toSetSpecV2Wire, toSetPageWire,
  validateSetSpecV2, validateEncodedSetSpecV2, verifySetPages, type SetSpecV2,
} from '../../src/set-v2/index';

it('matches independent ABI bytes, hashes, domains and every loader suffix', () => {
  expect([SET_SCHEMA, SET_RELEASE, SET_TEMPLATE]).toEqual([data.domains.schema, data.domains.release, data.domains.template]);
  for (const v of data.vectors) {
    const s = parseSetSpecV2(v.spec);
    const ctx = { listing: { ...v.context.listing, raise: BigInt(v.context.listing.raise) }, timestamp: BigInt(v.context.timestamp) };
    expect(encodeSetSpecV2(s)).toBe(v.encoded);
    expect(setSpecV2Hash(s)).toBe(v.hash);
    expect(keccak256(v.encoded as Hex)).toBe(v.hash);
    expect(decodeSetSpecV2(v.encoded as Hex)).toEqual(s);
    expect(toSetSpecV2Wire(s)).toEqual(v.spec);
    expect(validateSetSpecV2(s, ctx)).toEqual({ reason: 0, field: 0 });
    const built = buildSetCommitment(s.collection, v.ids);
    expect(built.commitment.setHash).toBe(s.setHash);
    expect(built.pages.map(toSetPageWire)).toEqual(v.pages);
    expect(v.pages.map(parseSetPage)).toEqual(built.pages);
    for (let i = 0; i < v.ids.length; ++i) {
      const id = v.ids[i], suffix = v.suffixes[i + 1];
      if (id === undefined || suffix === undefined) throw new Error('vector');
      expect(encodeSetLink(s.collection, BigInt(id), suffix as Hex)).toBe(v.links[i]);
      expect(keccak256(v.links[i] as Hex)).toBe(v.suffixes[i]);
    }
  }
  const sol = readFileSync('packages/contracts/test/box-v2/existing-nfts/SetVectors.sol', 'utf8');
  for (const v of data.vectors) {
    expect(sol).toContain(v.encoded.slice(2));
    expect(sol).toContain(v.hash);
  }
});

const vector = data.vectors[0];
if (!vector) throw new Error('vector');
const spec = parseSetSpecV2(vector.spec);
const context = { ...vector.context, listing: { ...vector.context.listing, token: vector.context.listing.token as Address, raise: BigInt(vector.context.listing.raise) }, timestamp: BigInt(vector.context.timestamp) };

it.each(['draw', 'drawFeeBps', 'revealRoot', 'artMode', 'firstId', 'payout', 'curator', 'creator', 'buyers', 'sellers', 'addOns', 'contentsParams', 'creatorFeeRecipient'])(
  'refuses the forbidden %s field even when empty or zero', (key) => {
    for (const value of [0, false, '', [], {}]) {
      expect(() => parseSetSpecV2({ ...vector.spec, [key]: value })).toThrow();
      expect(validateSetSpecV2({ ...spec, [key]: value }, context)).toEqual({ reason: 27, field: 65535 });
      expect(() => encodeSetSpecV2({ ...spec, [key]: value })).toThrow();
    }
  },
);
it('refuses unknown nested fields, numeric amounts and lossy JSON ids', () => {
  expect(() => parseSetSpecV2({ ...vector.spec, pricing: { ...vector.spec.pricing, curator: false } })).toThrow();
  for (const key of ['raise', 'creatorBuy']) for (const value of [0, 1, 9007199254740992, '01', '-1', '1e18', '1.0', ((1n << 256n)).toString()]) {
    expect(() => parseSetSpecV2({ ...vector.spec, [key]: value })).toThrow();
  }
  expect(validateSetSpecV2({ ...spec, raise: 9007199254740992 }, context)).toEqual({ reason: 28, field: 6 });
  const page = vector.pages[0];
  if (!page) throw new Error('page');
  expect(() => parseSetPage({ ...page, ids: [9007199254740992] })).toThrow();
});
it('binds every spec field into the hash', () => {
  const patches: Partial<SetSpecV2>[] = [
    { format: 3 }, { schema: zeroHash }, { release: zeroHash }, { tokenName: 'X' }, { tokenSymbol: 'X' },
    { pricing: { ...spec.pricing, listingId: 1 } }, { pricing: { ...spec.pricing, token: spec.collection } },
    { raise: 1n }, { openAt: 1792800000 }, { deadlineDays: 60 }, { creatorBuy: 1n },
    { collection: '0x2222222222222222222222222222222222222222' }, { count: 10 }, { setHash: zeroHash },
    { pickFeeBps: 100 }, { description: 'X' }, { logoSha256: zeroHash },
  ];
  for (const patch of patches) expect(setSpecV2Hash({ ...spec, ...patch })).not.toBe(vector.hash);
});
it('refuses trailing bytes, truncation, noncanonical offsets, padding and high bits', () => {
  const bytes = vector.encoded as Hex;
  const word = (n: bigint) => encodeAbiParameters([{ type: 'uint256' }], [n]);
  const padding = `${bytes.slice(0, -2)}01` as Hex;
  const variants = [concatHex([bytes, '0x00']), concatHex([bytes, zeroHash]), bytes.slice(0, -2) as Hex,
    concatHex([word(64n), zeroHash, `0x${bytes.slice(66)}`]),
    concatHex([word(32n), word(65538n), `0x${bytes.slice(130)}`]), padding, '0x' as Hex];
  for (const value of variants) {
    expect(() => decodeSetSpecV2(value)).toThrow(/29/);
    expect(validateEncodedSetSpecV2(value, context)).toEqual({ reason: 29, field: 65535 });
  }
});
it.each([1, 32])('refuses correctly rehashed duplicates at %s', (offset) => {
  const { commitment, pages } = buildSetCommitment(spec.collection, vector.ids);
  const page = pages[Math.floor(offset / 32)];
  if (!page) throw new Error('page');
  page.ids[offset % 32] = 0n;
  let hash: Hex = zeroHash;
  for (const p of [...pages].reverse()) {
    p.nextHash = hash;
    for (const id of [...p.ids].reverse()) hash = keccak256(encodeSetLink(spec.collection, id, hash));
  }
  commitment.setHash = hash;
  expect(verifySetPages(commitment, pages)).toEqual({ reason: 34, field: 12 });
});
it('returns the same BAD_CHARACTER code for canonical ABI containing invalid UTF-8 bytes', () => {
  // 32-byte tuple offset + 17-word head + 32-byte tokenName length.
  const at = 2 + 608 * 2;
  const malformedText = `${vector.encoded.slice(0, at)}ff${vector.encoded.slice(at + 2)}` as Hex;
  expect(validateEncodedSetSpecV2(malformedText, context)).toEqual({ reason: 6, field: 3 });
});
