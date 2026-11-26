import { describe, expect, it } from 'vitest';
import { IdentityError, parseFeedFixture, sameAssetIdentity, validateAssetRegistry, type Address } from '@squarehole/domain';
import feedJson from '../fixtures/feed.json';
import { ProviderUnavailableError } from '../errors';
import { createMockAssetRegistry } from '../index';

const feed = parseFeedFixture(feedJson);
const quotes = new Map(feed.items.map((pair) => [pair.quote.symbol, pair.quote]));
const LEGACY: Address = '0x0000000000000000000000000000000000002328';

describe('mock AssetRegistryProvider (M2 step 1; G06)', () => {
  it('lists exactly the three fixture quotes as supported_demo, by exact identity', async () => {
    const entries = await createMockAssetRegistry().listSupportedQuotes(31337);
    expect(validateAssetRegistry(entries)).toEqual(entries);
    expect(entries.map((entry) => [entry.asset.symbol, entry.asset.decimals, entry.admission])).toEqual([
      ['AAPLx-DEMO', 18, 'supported_demo'],
      ['USDC-DEMO', 6, 'supported_demo'],
      ['WETH-DEMO', 18, 'supported_demo'],
    ]);
    for (const entry of entries) {
      const quote = quotes.get(entry.asset.symbol);
      if (!quote) throw new Error('missing quote');
      expect(entry.asset).toEqual(quote); // identity copied from the fixture, including underlying + wrapperVersion
      expect(sameAssetIdentity(entry.asset, quote)).toBe(true);
      expect(entry.provenance).toMatchObject({ state: 'mock', coverage: 'demo' });
      expect(entry.issuerFamily).toMatch(/^Demo /);
    }
    const aaplx = entries.find((entry) => entry.asset.symbol === 'AAPLx-DEMO');
    expect(aaplx?.asset).toMatchObject({ underlyingAddress: '0x000000000000000000000000000000000000238d', wrapperVersion: 'mock-current-not-deployable' });
  });

  it('keeps an explicitly rejected legacy wrapper (G06) out of the supported list but readable', async () => {
    const registry = createMockAssetRegistry();
    const supported = await registry.listSupportedQuotes(31337);
    expect(supported.some((entry) => entry.asset.address === LEGACY)).toBe(false);
    const legacy = await registry.readAsset(31337, LEGACY);
    expect(legacy).toMatchObject({
      admission: 'rejected',
      rejection: { gate: 'G06' },
      asset: { wrapperVersion: 'mock-legacy-v1', underlyingAddress: '0x000000000000000000000000000000000000238d' },
    });
    expect(legacy?.admission === 'rejected' && legacy.rejection.reason).toMatch(/legacy/i);
  });

  it('reads by exact chain + address (any case); unknown addresses never become approved', async () => {
    const registry = createMockAssetRegistry();
    const usdc = quotes.get('USDC-DEMO');
    if (!usdc) throw new Error('missing');
    expect((await registry.readAsset(31337, `0x${usdc.address.slice(2).toUpperCase()}` as Address))?.asset).toEqual(usdc);
    expect(await registry.readAsset(1, usdc.address)).toBeNull();
    expect(await registry.listSupportedQuotes(1)).toEqual([]);
    expect(await registry.readAsset(31337, '0x00000000000000000000000000000000000003ea')).toBeNull(); // a T, not a registered quote
    // Every address in the neighbourhood of the registered ones (near misses included), plus the fixture T tokens.
    const candidates: Address[] = [];
    for (let n = 0x2200; n <= 0x24ff; n += 1) candidates.push(`0x${n.toString(16).padStart(40, '0')}`);
    for (const pair of feed.items) candidates.push(pair.token.address, pair.pairId.split(':')[1] as Address);
    for (const candidate of candidates) {
      const entry = await registry.readAsset(31337, candidate);
      const known = [...quotes.values()].some((quote) => quote.address === candidate) || candidate === LEGACY;
      expect(entry === null, candidate).toBe(!known);
      if (entry !== null && candidate !== LEGACY) expect(entry.admission).toBe('supported_demo');
    }
  });

  it('never matches by symbol (a lookalike ticker at another address is unknown)', async () => {
    const registry = createMockAssetRegistry();
    const entries = await registry.listSupportedQuotes(31337);
    const lookalike: Address = '0x0000000000000000000000000000000000002330';
    expect(entries.some((entry) => entry.asset.address === lookalike)).toBe(false);
    expect(await registry.readAsset(31337, lookalike)).toBeNull();
  });

  it('rejects malformed input with typed errors and serves frozen data', async () => {
    const registry = createMockAssetRegistry();
    await expect(registry.readAsset(31337, '0x2329' as Address)).rejects.toBeInstanceOf(IdentityError);
    await expect(registry.listSupportedQuotes(0)).rejects.toBeInstanceOf(IdentityError);
    const entries = await registry.listSupportedQuotes(31337);
    expect(Object.isFrozen(entries)).toBe(true);
    expect(Object.isFrozen(entries[0]?.asset)).toBe(true);
  });

  it('unavailable scenario rejects instead of returning an empty registry', async () => {
    const registry = createMockAssetRegistry({ scenario: 'unavailable' });
    await expect(registry.listSupportedQuotes(31337)).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(registry.readAsset(31337, LEGACY)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});
