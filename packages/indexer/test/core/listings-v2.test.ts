/** CQ11-0: permanent listings replace relisting, used flags, routes and converter proof subjects.
 * New decoded-event and RaiseUpdated regression pins live in core/v2/listings-cq11.test.ts.
 */
import { keccak256, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { listingAmountV2, rawFromListingAmountV2, readListingDetailV2, listingDetailToJson, listingDetailFromJson } from '../../src/core/v2/listings-v2';
import { synthManifestV2, SynthReaderV2, V2 } from '../../../chain/src/core/v2/test-support/synth-v2';

const firstRelease = synthManifestV2().releases[0];
if (!firstRelease) throw new Error('missing synthetic release');
const release = firstRelease;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address;
const WBTC = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599' as Address;
const record = (id: number, token: Address, decimals: number, raise: bigint) => ({
  id, token, decimals, class: 3, kind: 1, listedAt: 1_800_000_000n, raise,
  q: { bootstrapQ: raise / 1_000n, batchMinQ: raise / 10_000n, tipMaxQ: raise / 100_000n + 1n, swapStepMinQ: raise / 50_000n },
});

describe('permanent listing detail data', () => {
  it('keeps exact amounts at 6 and 8 decimals through reads and JSON', async () => {
    const reader = new SynthReaderV2().answer(V2.listingRegistry, 'listing', ([id]) =>
      id === 5 ? record(5, USDC, 6, 12_345_678_901n) : record(6, WBTC, 8, 14_000_001n));
    const hash = keccak256('0x0500');
    const usdc = await readListingDetailV2(reader, release, 5, hash);
    const wbtc = await readListingDetailV2(reader, release, 6, hash);
    expect(listingAmountV2(usdc.raise, usdc.decimals)).toBe('12345.678901');
    expect(listingAmountV2(wbtc.raise, wbtc.decimals)).toBe('0.14000001');
    expect(rawFromListingAmountV2('12345.678901', 6)).toBe(12_345_678_901n);
    expect(rawFromListingAmountV2('0.14000001', 8)).toBe(14_000_001n);
    expect(() => rawFromListingAmountV2('0.140000011', 8)).toThrow(/decimals/);
    for (const detail of [usdc, wbtc]) {
      const json = listingDetailToJson(detail);
      expect(typeof (json as { raise: unknown }).raise).toBe('string');
      expect(listingDetailFromJson(JSON.parse(JSON.stringify(json)) as unknown)).toEqual(detail);
    }
  });

  it('refuses malformed or obsolete permanent-row JSON fields', () => {
    const good = listingDetailToJson({ ...record(5, USDC, 6, 12_345_678_901n), class: 'STABLE', kind: 'LISTED' }) as Record<string, unknown>;
    const bad = [
      { decimals: '6' }, { decimals: 37 }, { decimals: 6.5 }, { token: '0x1234' },
      { token: '0x514910771AF9Ca656af840dff83E8264EcF986Ca' }, { class: 'GOLD' }, { kind: 'CONVERTER' },
      { raise: '1.5' }, { raise: 12 }, { q: { ...(good.q as object), tipMaxQ: '-1' } },
      { converter: USDC }, { route: [] }, { used: false }, { earlierListing: 0 }, { extra: 1 },
    ];
    for (const change of bad) expect(() => listingDetailFromJson({ ...good, ...change })).toThrow(/listing JSON/);
  });
});
