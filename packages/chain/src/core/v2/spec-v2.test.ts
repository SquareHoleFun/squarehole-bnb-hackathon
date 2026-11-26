/**
 * M1-52 red tests: a v2 box as registry v2 records it (`BoxCreated` with `BoxRecordV2`, `BoxSpec` with format 2's
 * `BoxSpec`; IBoxRegistryV2.sol, SpecTypes.sol, RecipeTypes.sol), decoded by the one decoder the indexer and the site use.
 * - the record's 24 roles by `ROLE_V2` (legacy LEG slots at 14-15, retired sampler at 13 absent), absent roles null;
 * - the spec checked against the record's hash (keccak256 of the encoded spec), its pricing listing and raise;
 * - the recipes (both sides, each branch's leg and destination with its params) and every plug-in the spec names,
 *   RULE, LEG and TARGET, with its implementation and code hash (ADR-0017 § 2);
 * - the humble cap's preset in ETH (add-on 10: 1, 4, 8, 16 or 32 ETH per 30 days).
 */
import { keccak256, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { decodeBoxCreatedV2, decodeBoxSpecLogV2, rolesOfV2, SpecRecordMismatch } from './record-v2';
import { decodeBoxSpecV2, encodeBoxSpecV2, humbleCapEth, plugInsOf, recipeOf } from './spec-v2';
import { boxLogsV2, synthBoxV2 } from './test-support/synth-v2';

const LEG = { implementation: '0x5100000000000000000000000000000000000002' as Address, codeHash: keccak256('0x02') };

describe('M1-52 v2 record and spec', () => {
  it('M1-52 BoxCreated and BoxSpec decode to the record, its 24 roles and the spec', () => {
    const box = synthBoxV2({ boxId: 4n, legs: [LEG] });
    const [created, spec] = boxLogsV2(box);
    const decoded = decodeBoxCreatedV2(created);
    expect(decoded.boxId).toBe(4n);
    expect(decoded.record.contracts).toHaveLength(24);
    const roles = rolesOfV2(decoded.record);
    expect(roles.contracts.coordinator).toBe(box.record.contracts[0]);
    expect(roles.contracts.sampler).toBeNull();
    expect(roles.contracts.swapModule).toBeNull();
    expect(roles.contracts.leg0).toBe(box.record.contracts[14]);
    expect(roles.contracts.leg1).toBeNull();
    expect(roles.contracts.itemStream).toBeNull();
    expect(roles.contracts.metadataTable).toBeNull();
    expect(roles.codeHashes.leg1).toBeNull();
    const specLog = decodeBoxSpecLogV2(spec);
    expect(specLog.boxId).toBe(4n);
    expect(keccak256(specLog.encodedSpec)).toBe(decoded.record.specHash);
    const s = decodeBoxSpecV2(specLog.encodedSpec, decoded.record);
    expect(s.tokenName).toBe(box.spec.tokenName);
    expect(s.pricing.listingId).toBe(box.record.pricingListingId);
    expect(s.raise).toBe(box.record.raise);
  });

  it("M1-52 a spec whose hash, pricing listing or raise is not the record's is refused", () => {
    const box = synthBoxV2({ boxId: 1n });
    const other = synthBoxV2({ boxId: 1n, tokenName: 'Other Box' });
    expect(() => decodeBoxSpecV2(other.encodedSpec, box.record)).toThrow(SpecRecordMismatch);
    const raised = synthBoxV2({ boxId: 1n, raise: box.record.raise + 1n });
    expect(() => decodeBoxSpecV2(box.encodedSpec, { ...box.record, specHash: keccak256(box.encodedSpec), raise: raised.record.raise })).toThrow(/raise/);
    expect(() => decodeBoxSpecV2('0x1234' as Hex, box.record)).toThrow(SpecRecordMismatch);
    expect(encodeBoxSpecV2(decodeBoxSpecV2(box.encodedSpec, box.record))).toBe(box.encodedSpec);
  });

  it('CQ11-E decodes every pair of the three single-choice menu recipes', () => {
    const menu = [
      { leg: 1, dest: 2, names: { leg: 'AsPaid', dest: 'Creator' } },
      { leg: 2, dest: 1, names: { leg: 'BuyT', dest: 'Eat' } },
      { leg: 1, dest: 4, names: { leg: 'AsPaid', dest: 'Depth' } },
    ];
    for (const buyers of menu) for (const sellers of menu) {
      const box = synthBoxV2({ boxId: 2n, specOf: (s) => ({
        ...s,
        buyers: { ...s.buyers, a: { leg: buyers.leg, dest: buyers.dest, legParams: '0x', destParams: '0x' } },
        sellers: { ...s.sellers, a: { leg: sellers.leg, dest: sellers.dest, legParams: '0x', destParams: '0x' } },
      }) });
      const spec = decodeBoxSpecV2(box.encodedSpec, box.record);
      const recipe = recipeOf(spec);
      expect(recipe.buyers).toMatchObject({ split: 'NoSplit', a: buyers.names, b: null });
      expect(recipe.sellers).toMatchObject({ split: 'NoSplit', a: sellers.names, b: null });
      expect(plugInsOf(spec)).toEqual([]);
      expect(spec.gradLayout).toBe(3);
    }
  });

  it('M1-52 a box with no plug-in names none; the humble preset reads in ETH', () => {
    const box3 = synthBoxV2({ boxId: 3n });
    const plain = decodeBoxSpecV2(box3.encodedSpec, box3.record);
    expect(plugInsOf(plain)).toEqual([]);
    expect(humbleCapEth(plain)).toBeNull();
    for (const [preset, eth] of [[1, 1n], [2, 4n], [3, 8n], [4, 16n], [5, 32n]] as const) {
      const box = synthBoxV2({ boxId: 5n, humblePreset: preset });
      expect(humbleCapEth(decodeBoxSpecV2(box.encodedSpec, box.record)), `preset ${preset}`).toBe(eth * 10n ** 18n);
    }
  });
});
