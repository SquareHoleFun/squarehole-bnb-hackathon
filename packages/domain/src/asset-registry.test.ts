/**
 * Asset registry entries (M2 step 1; 03-FEED AssetRegistryProvider; G06).
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import {
  DataValidationError,
  assetRegistryEntrySchema,
  safeParseAssetRegistryEntry,
  sameAssetIdentity,
  validateAssetRegistry,
  type AssetRegistryEntry,
} from './index';
import { setAt } from './test-support/handoff';
import { feedPair, rejectedEntry, supportedEntry } from './test-support/m23';

type Path = (string | number)[];
const paths = (entry: unknown): string[] => {
  const result = safeParseAssetRegistryEntry(entry);
  return result.ok ? [] : result.issues.map((issue) => issue.path);
};
function mutated(base: () => AssetRegistryEntry, path: Path, value: unknown): AssetRegistryEntry {
  const entry = base();
  setAt(entry, path, value);
  return entry;
}

describe('AssetRegistryEntry', () => {
  it('accepts a supported demo quote and a rejected legacy wrapper', () => {
    expect(paths(supportedEntry())).toEqual([]);
    expect(paths(rejectedEntry())).toEqual([]);
    expectTypeOf<z.output<typeof assetRegistryEntrySchema>>().toEqualTypeOf<AssetRegistryEntry>();
  });

  it.each([
    ['supported_demo off the demo chain', supportedEntry, ['asset', 'chainId'], 1, 'admission'],
    ['a verified issuer claim on demo data (FEED-09)', supportedEntry, ['asset', 'issuerStatus'], 'verified', 'asset.issuerStatus'],
    ['a zero-address asset', supportedEntry, ['asset', 'address'], '0x0000000000000000000000000000000000000000', 'asset.address'],
    ['a rejection on a supported entry', supportedEntry, ['rejection'], { gate: 'G06', reason: 'x' }, 'rejection'],
    ['a rejected entry without its reason', rejectedEntry, ['rejection'], undefined, 'rejection'],
    ['a rejection citing another gate', rejectedEntry, ['rejection', 'gate'], 'G05', 'rejection.gate'],
    ['an empty rejection reason', rejectedEntry, ['rejection', 'reason'], '', 'rejection.reason'],
    ['an unknown admission', supportedEntry, ['admission'], 'supported', 'admission'],
    ['a control character in the issuer family', supportedEntry, ['issuerFamily'], 'Demo\u0000', 'issuerFamily'],
  ] as const)('rejects %s', (_label, base, path, value, expected) => {
    expect(paths(mutated(base, [...path], value))).toContain(expected);
  });

  describe('supported_testnet (ADR-0012, chain registry admissions on Sepolia)', () => {
    const sepoliaWeth = (): AssetRegistryEntry => ({
      asset: { chainId: 11_155_111, address: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', symbol: 'WETH', decimals: 18, issuerStatus: 'unverified' },
      issuerFamily: 'Canonical WETH9 (testnet)',
      admission: 'supported_testnet',
      provenance: { state: 'fresh', asOf: '2026-09-26T12:00:00Z', blockNumber: '100', source: 'test', coverage: 'canonical_markets' },
    });

    it('accepts a Sepolia registry quote', () => {
      expect(paths(sepoliaWeth())).toEqual([]);
    });

    it.each([
      ['on the demo chain', ['asset', 'chainId'], 31_337, 'admission'],
      ['on mainnet', ['asset', 'chainId'], 1, 'admission'],
      ['claiming a verified issuer (a testnet template is not G06)', ['asset', 'issuerStatus'], 'verified', 'asset.issuerStatus'],
      ['with a rejection', ['rejection'], { gate: 'G06', reason: 'x' }, 'rejection'],
    ] as const)('rejects it %s', (_label, path, value, expected) => {
      expect(paths(mutated(sepoliaWeth, [...path], value))).toContain(expected);
    });
  });

  it('rejects duplicate identities in one registry (chain + case-insensitive address)', () => {
    const duplicate = mutated(rejectedEntry, ['asset', 'address'], supportedEntry().asset.address.toUpperCase().replace('0X', '0x'));
    expect(() => validateAssetRegistry([supportedEntry(), duplicate])).toThrow(DataValidationError);
    expect(validateAssetRegistry([supportedEntry(), rejectedEntry()])).toHaveLength(2);
  });

  it('compares identities by chain, address (any case) and decimals, never by symbol', () => {
    const usdc = feedPair('misfit-studio').quote;
    expect(sameAssetIdentity(usdc, { ...usdc, address: usdc.address.toUpperCase().replace('0X', '0x') as typeof usdc.address })).toBe(true);
    expect(sameAssetIdentity(usdc, { ...usdc, symbol: 'OTHER' })).toBe(true);
    expect(sameAssetIdentity(usdc, { ...usdc, decimals: 18 })).toBe(false);
    expect(sameAssetIdentity(usdc, { ...usdc, chainId: 1 })).toBe(false);
    expect(sameAssetIdentity(usdc, { ...feedPair('orchard').quote, symbol: 'USDC-DEMO' })).toBe(false);
  });
});
