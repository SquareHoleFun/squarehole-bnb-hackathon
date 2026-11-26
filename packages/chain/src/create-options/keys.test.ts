import { AddOnId, BoxType, FeeChoice } from '@squarehole/box-spec/v2';
import { encodeAbiParameters, getAddress, keccak256, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { shLimit } from '../../../../vitest.timeouts.mjs';
import { CREATE_ADDON_KEYS_V2, CREATE_FEE_KEYS_V2, CREATE_KIND_KEYS_V2, decodeBoxSpecV2, encodeBoxSpecV2, type BoxSpecV2, type SideV2 } from '../core/v2/spec-v2';
import type { BoxRecordV2 } from '../core/v2/record-v2';
import { alchemistSideV21 } from '../core/v2/alchemist-v21';
import { STATIC_CREATE_OPTIONS, TEMPLATE_CREATE_OPTIONS, isCreateOptionKey, requiredCreateOptions, switchedOff, type CreateOptionKey } from './keys';
import type { CreateOptionsDocument } from './schema';

const P = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const Q = '0x1234567890abcdef1234567890abcdef12345678';
const ZERO = '0x0000000000000000000000000000000000000000';
const H = `0x${'00'.repeat(32)}` as Hex;
const empty = { leg: 0, dest: 0, legParams: '0x', destParams: '0x' } as const;
const uint = (value: number) => encodeAbiParameters([{ type: 'uint8' }], [value]);
const side = (leg: number, dest: number, destParams: Hex = '0x'): SideV2 => ({ a: { leg, dest, legParams: '0x', destParams }, b: empty, split: 1, splitParams: '0x' });
const spec: BoxSpecV2 = {
  format: 2, version: 2, boxType: 3, tokenName: 'Test', tokenSymbol: 'TEST', collectionName: '', collectionSymbol: '', description: '',
  n: 0, firstId: 0n, pricing: { listingId: 0, token: P }, raise: 1n, layout: 1, gradLayout: 3, launchFormat: 1, openAt: 0,
  deadlineDays: 30, buyers: side(1, 2), sellers: side(1, 2), artMode: 0, revealRoot: H, metadataTable: '0x', generatorHash: H,
  coverSha256: H, revealListId: H, marketplaceOwner: ZERO, creatorFeeRecipient: ZERO, creatorBuy: 0n, collectionCoverSha256: H,
  addOns: [], contentsParams: '0x', pickFeeBps: 0,
};
const base = ['kind.token', 'fee.buyers.keep', 'fee.sellers.keep', `price.${P}`];
// Round-trip through the chain encoder AND its checked decoder, not a UI-shaped substitute.
const decoded = (patch: Partial<BoxSpecV2> = {}): BoxSpecV2 => {
  const input = { ...spec, ...patch }; const bytes = encodeBoxSpecV2(input);
  return decodeBoxSpecV2(bytes, { boxId: 1n, specHash: keccak256(bytes), pricingListingId: input.pricing.listingId, q: input.pricing.token, raise: input.raise } as BoxRecordV2);
};
const equal = (actual: readonly string[], expected: readonly string[]) => expect([...actual].sort()).toEqual([...expected].sort());
const fees = [
  ['keep', side(1, 2)], ['burn', side(2, 1)], ['grow', side(1, 4)], ['holders-p', side(1, 6, uint(1))],
  ['holders-t', side(2, 6, uint(2))], ['items-p', side(1, 8, uint(1))], ['items-t', side(2, 8, uint(1))],
  ['eat', side(1, 1)], ['pile', side(1, 7)], ['alchemist', alchemistSideV21(7)], ['shop', side(2, 7, uint(2))],
] as const;

describe('Create option inventory', () => {
  it('covers every encoder enum value, including explicit excluded values', () => {
    const wires = (values: object) => Object.values(values).map(String).sort();
    expect(Object.keys(CREATE_KIND_KEYS_V2).sort()).toEqual(wires(BoxType));
    expect(Object.keys(CREATE_FEE_KEYS_V2).sort()).toEqual(wires(FeeChoice));
    expect(Object.keys(CREATE_ADDON_KEYS_V2).sort()).toEqual(wires(AddOnId));
    expect(Object.entries(CREATE_KIND_KEYS_V2).filter(([, key]) => key === null).map(([wire]) => wire)).toEqual(['2']);
    expect(Object.entries(CREATE_ADDON_KEYS_V2).filter(([, key]) => key === null).map(([wire]) => wire)).toEqual(['9', '10']);
  });
  it('has exactly ten template, four kind, ten buyer, eleven seller and six addon keys', () => {
    expect(new Set(STATIC_CREATE_OPTIONS).size).toBe(41);
    for (const [prefix, count] of [['template.', 10], ['kind.', 4], ['fee.buyers.', 10], ['fee.sellers.', 11], ['addon.', 6]] as const) {
      expect(STATIC_CREATE_OPTIONS.filter(key => key.startsWith(prefix))).toHaveLength(count);
    }
    expect(STATIC_CREATE_OPTIONS.every(isCreateOptionKey)).toBe(true);
  });
  it.each([[1, 'collection'], [3, 'token'], [4, 'shop'], [5, 'pile']] as const)('derives exactly kind wire %i (%s)', (boxType, key) => {
    const contentsParams = boxType === 5 ? encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [Q, 5n]) : '0x';
    equal(requiredCreateOptions(decoded({ boxType, contentsParams })), [`kind.${key}`, ...base.slice(1), ...(boxType === 5 ? [`pile.coin.${Q}`] : [])]);
  });
  for (const feeSide of ['buyers', 'sellers'] as const) {
    it.each(fees.filter(([key]) => feeSide === 'sellers' || key !== 'shop'))(`derives exactly ${feeSide} %s`, (key, choice) => {
      equal(requiredCreateOptions(decoded({ [feeSide]: choice }), Q), [...base.filter(k => !k.startsWith(`fee.${feeSide}.`)), `fee.${feeSide}.${key}`,
        ...(key === 'alchemist' ? [`module.${Q}.7`] : []),
        ...(key === 'shop' ? ['fee.sellers.holders-p'] : [])]);
    });
  }
  it.each([1, 3, 4, 6, 7, 8])('derives exactly add-on %i', id => equal(requiredCreateOptions(decoded({ addOns: [{ id, params: '0x' }] })), [...base, `addon.${id}`]));
  it('derives a shop and its holder overflow dependency, ignoring shop presets', () => {
    equal(requiredCreateOptions(decoded({ boxType: 4, sellers: side(2, 7, uint(8)), addOns: [{ id: 7, params: '0x' }, { id: 8, params: '0x' }] })),
      ['kind.shop', 'fee.buyers.keep', 'fee.sellers.shop', 'fee.sellers.holders-p', 'addon.7', 'addon.8', `price.${P}`]);
  });
  it('derives both alchemist rows with the explicit release directory, including row zero', () => {
    equal(requiredCreateOptions(decoded({ boxType: 5, buyers: alchemistSideV21(0), sellers: alchemistSideV21(4294967295),
      contentsParams: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [Q, 0n]) }), getAddress(P)),
    ['kind.pile', 'fee.buyers.alchemist', 'fee.sellers.alchemist', `module.${P}.0`, `module.${P}.4294967295`, `price.${P}`, `pile.coin.${Q}`]);
  });
  it('deduplicates a shared module row and keeps directories distinct across releases', () => {
    const input = decoded({ buyers: alchemistSideV21(7), sellers: alchemistSideV21(7) });
    const expected = ['kind.token', 'fee.buyers.alchemist', 'fee.sellers.alchemist', `price.${P}`];
    equal(requiredCreateOptions(input, P), [...expected, `module.${P}.7`]);
    equal(requiredCreateOptions(input, Q), [...expected, `module.${Q}.7`]);
    expect(() => requiredCreateOptions(input)).toThrow('release directory');
    expect(() => requiredCreateOptions(input, '0x1234')).toThrow('unsupported Create option');
  });
  it('refuses malformed module row bytes even with a directory', () => {
    expect(() => requiredCreateOptions(decoded({ buyers: side(1, 9, '0x') }), P)).toThrow();
    expect(() => requiredCreateOptions(decoded({ buyers: side(1, 9, encodeAbiParameters([{ type: 'uint256' }], [4294967296n])) }), P)).toThrow();
    expect(() => requiredCreateOptions(decoded({ buyers: side(1, 9, `${alchemistSideV21(0).a.destParams}00`) }), P)).toThrow();
  });
  it('ignores presets and authoring fields, and never requires a template', () => {
    equal(requiredCreateOptions(decoded({ creatorBuy: 123n, openAt: 123, deadlineDays: 180, pickFeeBps: 100, artMode: 2, collectionName: 'Separate' })), base);
    expect(requiredCreateOptions(decoded()).some(key => TEMPLATE_CREATE_OPTIONS.includes(key as typeof TEMPLATE_CREATE_OPTIONS[number]))).toBe(false);
  });
  it('canonicalizes decoded coin addresses and includes the native price coin', () => {
    equal(requiredCreateOptions(decoded({ pricing: { listingId: 0, token: getAddress(P) } })), base);
    equal(requiredCreateOptions(decoded({ pricing: { listingId: 0, token: ZERO } })), [...base.slice(0, -1), `price.${ZERO}`]);
  });
  // Per-choice tests above cover the ABI round trip. This matrix covers all 440 combinations and deduplication.
  it('all 440 supported kind/fee/addon combinations produce known keys, never templates, with the shLimit timeout', { timeout: shLimit(120_000) }, ({ task }) => {
    // Assert the registered limit, so a bare timeout fails under SH_TEST_TIMEOUT without a timed wait.
    expect(task.timeout).toBe(shLimit(120_000));
    const pileContents = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint16' }], [Q, 0n, 500]);
    let cases = 0;
    for (const boxType of [1, 3, 4, 5]) for (const [, buyers] of fees.slice(0, -1)) for (const [, sellers] of fees) {
      const keys = requiredCreateOptions({ ...spec, boxType, buyers, sellers, addOns: [1, 3, 4, 6, 7, 8].map(id => ({ id, params: '0x' })),
        contentsParams: boxType === 5 ? pileContents : '0x' }, Q);
      expect(keys.every(isCreateOptionKey)).toBe(true);
      expect(keys.some(key => key.startsWith('template.'))).toBe(false);
      expect(new Set(keys).size).toBe(keys.length);
      cases++;
    }
    expect(cases).toBe(440);
  });
  it.each([0, 2, 6, 255])('refuses unsupported kind %i', boxType => expect(() => requiredCreateOptions(decoded({ boxType }))).toThrow());
  it.each([0, 2, 5, 9, 10, 65535])('refuses unsupported addon %i', id => expect(() => requiredCreateOptions(decoded({ addOns: [{ id, params: '0x' }] }))).toThrow());
  it('refuses unsupported fees and noncanonical parameters instead of omitting a key', () => {
    for (const buyers of [side(3, 2), side(1, 3), side(1, 6), side(1, 6, uint(2)), side(2, 8, uint(4)), side(2, 7, uint(3)),
      side(2, 7, uint(2)), { ...side(1, 2), split: 2 }, { ...side(1, 2), b: { ...empty, dest: 2 } }, alchemistSideV21(0)]) {
      expect(() => requiredCreateOptions(decoded({ buyers }))).toThrow();
    }
  });
  for (const feeSide of ['buyers', 'sellers'] as const) {
    it.each([
      ['legParams', { ...side(1, 2), a: { ...side(1, 2).a, legParams: '0x01' as Hex } }],
      ['splitParams', { ...side(1, 2), splitParams: '0x01' as Hex }],
      ['second branch legParams', { ...side(1, 2), b: { ...empty, legParams: '0x01' as Hex } }],
      ['second branch destParams', { ...side(1, 2), b: { ...empty, destParams: '0x01' as Hex } }],
    ] as const)(`refuses non-empty ${feeSide} %s`, (_name, choice) => {
      const input = decoded({ [feeSide]: choice });
      expect(() => requiredCreateOptions(input)).toThrow('unsupported Create fee wire');
    });
  }
  it('refuses unsupported format and version', () => {
    expect(() => requiredCreateOptions(decoded({ format: 1 }))).toThrow();
    expect(() => requiredCreateOptions(decoded({ version: 3 }))).toThrow();
  });
});

describe('switchedOff', () => {
  const doc: CreateOptionsDocument = { schema: 1, chainId: 11155111, factory: P, registry: Q, versionCodeHash: H, revision: 1,
    off: [{ key: 'kind.token' }, { key: 'fee.sellers.holders-p', issueId: 'optional' }, { key: 'template.blank' }] };
  it('returns only distinct requested keys that are off, in request order', () => {
    expect(switchedOff(doc, ['fee.sellers.holders-p', 'fee.buyers.keep', 'kind.token', 'kind.token'])).toEqual(['fee.sellers.holders-p', 'kind.token']);
  });
  it('an empty document changes no choice', () => expect(switchedOff({ ...doc, off: [] }, base as CreateOptionKey[])).toEqual([]));
  it('a template only affects a tile request', () => {
    expect(switchedOff({ ...doc, off: [{ key: 'template.blank' }] }, requiredCreateOptions(decoded()))).toEqual([]);
    expect(switchedOff(doc, ['template.blank'])).toEqual(['template.blank']);
  });
  it('shop overflow is blocked by the holders-P key', () => {
    expect(switchedOff(doc, requiredCreateOptions(decoded({ boxType: 4, sellers: side(2, 7, uint(2)) })))).toEqual(['fee.sellers.holders-p']);
  });
  it('matches dynamic module and coin identities exactly', () => {
    const document: CreateOptionsDocument = { ...doc, off: [{ key: `module.${P}.7` }, { key: `pile.coin.${Q}` }, { key: `price.${P}` }] };
    expect(switchedOff(document, [`module.${Q}.7`, `module.${P}.8`, `module.${P}.7`, `pile.coin.${Q}`, `price.${Q}`, `price.${P}`]))
      .toEqual([`module.${P}.7`, `pile.coin.${Q}`, `price.${P}`]);
  });
});
