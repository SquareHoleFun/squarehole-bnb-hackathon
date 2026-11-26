import { describe, expect, it } from 'vitest';
import {
  DEMO_CHAIN_ID,
  DEMO_NOW,
  IdentityError,
  canonicalAddress,
  canonicalPairId,
  formatPairId,
  isAddress,
  isChainId,
  isDemoChain,
  isPairId,
  pairIdFromRoute,
  pairRoute,
  parsePairId,
  sameAddress,
} from './index';

const LOWER = '0x00000000000000000000000000000000000003ea';
const MIXED = '0x00000000000000000000000000000000000003EA';

describe('constants', () => {
  it('pins the demo chain and clock', () => {
    expect(DEMO_CHAIN_ID).toBe(31337);
    expect(DEMO_NOW).toBe('2026-09-25T12:00:00Z');
    expect(isDemoChain(31337)).toBe(true);
    expect(isDemoChain(1)).toBe(false);
  });
});

describe('addresses', () => {
  it('accepts 20-byte hex addresses in any case', () => {
    expect(isAddress(LOWER)).toBe(true);
    expect(isAddress(MIXED)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['no prefix', '00000000000000000000000000000000000003ea'],
    ['uppercase prefix', '0X00000000000000000000000000000000000003ea'],
    ['too short', '0x3ea'],
    ['too long', `${LOWER}0`],
    ['non-hex', '0x00000000000000000000000000000000000003eg'],
    ['surrounding space', ` ${LOWER}`],
    ['not a string', 42],
  ])('rejects %s', (_label, value) => {
    expect(isAddress(value)).toBe(false);
  });

  it('canonicalises to lowercase and throws a typed error on malformed input', () => {
    expect(canonicalAddress(MIXED)).toBe(LOWER);
    expect(() => canonicalAddress('0x123')).toThrow(IdentityError);
    try {
      canonicalAddress('nope');
    } catch (error) {
      expect(error).toBeInstanceOf(IdentityError);
      expect((error as IdentityError).code).toBe('malformed_address');
    }
  });

  it('compares addresses case-insensitively and never matches malformed values', () => {
    expect(sameAddress(LOWER, MIXED)).toBe(true);
    expect(sameAddress(LOWER, '0x00000000000000000000000000000000000003eb')).toBe(false);
    expect(sameAddress('0x1', '0x1')).toBe(false);
  });
});

describe('chain ids', () => {
  it('accepts positive safe integers only', () => {
    expect(isChainId(1)).toBe(true);
    expect(isChainId(31337)).toBe(true);
    for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 53, '1', null]) {
      expect(isChainId(bad)).toBe(false);
    }
  });
});

describe('pair ids', () => {
  it('formats canonical lowercase pair ids', () => {
    expect(formatPairId(31337, MIXED)).toBe(`31337:${LOWER}`);
  });

  it('parses and canonicalises pair ids', () => {
    expect(parsePairId(`31337:${MIXED}`)).toEqual({ chainId: 31337, address: LOWER, pairId: `31337:${LOWER}` });
    expect(canonicalPairId(`31337:${MIXED}`)).toBe(`31337:${LOWER}`);
    expect(isPairId(`31337:${MIXED}`)).toBe(true);
  });

  it.each([
    ['missing chain', `:${LOWER}`],
    ['zero chain', `0:${LOWER}`],
    ['leading-zero chain', `031337:${LOWER}`],
    ['negative chain', `-1:${LOWER}`],
    ['unsafe chain', `9007199254740993:${LOWER}`],
    ['wrong separator', `31337-${LOWER}`],
    ['bad address', '31337:0x123'],
    ['extra segment', `31337:${LOWER}:1`],
    ['whitespace', ` 31337:${LOWER}`],
  ])('rejects %s', (_label, value) => {
    expect(isPairId(value)).toBe(false);
    expect(() => parsePairId(value)).toThrow(IdentityError);
  });

  it('rejects an invalid chain id when formatting', () => {
    expect(() => formatPairId(0, LOWER)).toThrow(IdentityError);
    expect(() => formatPairId(31337, '0x12')).toThrow(IdentityError);
  });
});

describe('pair routes', () => {
  it('builds /pair/<chainId>/<address> from a pair or a pair id', () => {
    expect(pairRoute(`31337:${MIXED}`)).toBe(`/pair/31337/${LOWER}`);
    expect(pairRoute({ pairId: `31337:${LOWER}` })).toBe(`/pair/31337/${LOWER}`);
  });

  it('round-trips a route back to the canonical pair id', () => {
    expect(pairIdFromRoute('31337', MIXED)).toEqual({ ok: true, pairId: `31337:${LOWER}`, chainId: 31337, address: LOWER });
  });

  it('rejects malformed chain ids and addresses with typed reasons', () => {
    expect(pairIdFromRoute('031337', LOWER)).toEqual({ ok: false, reason: 'malformed_chain_id' });
    expect(pairIdFromRoute('abc', LOWER)).toEqual({ ok: false, reason: 'malformed_chain_id' });
    expect(pairIdFromRoute('9007199254740993', LOWER)).toEqual({ ok: false, reason: 'malformed_chain_id' });
    expect(pairIdFromRoute('31337', '0x12')).toEqual({ ok: false, reason: 'malformed_address' });
    expect(pairIdFromRoute('31337', `31337:${LOWER}`)).toEqual({ ok: false, reason: 'malformed_address' });
  });

  it('rejects a route for another chain than the expected one (demo chain by default)', () => {
    expect(pairIdFromRoute('1', LOWER)).toEqual({ ok: false, reason: 'chain_mismatch' });
    expect(pairIdFromRoute('1', LOWER, { expectedChainId: 1 })).toMatchObject({ ok: true, pairId: `1:${LOWER}` });
  });
});
