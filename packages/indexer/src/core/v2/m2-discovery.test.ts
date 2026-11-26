import { keccak256, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { checkBoxV2 } from './discovery-v2';
import { parseCoreManifestV2 } from './chain-v2';
import { H, m2Fixture } from './m2-fixture.test-support';

describe('M252-PROVENANCE', () => {
  it.each([true, false])('accepts only release-pinned M2 clones with their fixed wiring (shop %s)', async shop => {
    const f = m2Fixture(shop);
    expect(() => parseCoreManifestV2(f.manifest)).not.toThrow();
    const result = await checkBoxV2(f.reader, f.manifest, { registry: f.row.registry, record: f.record, encodedSpec: f.encodedSpec }, { creationHash: H(100), headHash: H(101), reviewed: [] });
    expect(result.reason).toBeNull();
    expect(result.classification).toBe('shown');
    expect(result.token?.ledger.toLowerCase()).toBe(f.at(17).toLowerCase());
  });

  it.each([[17, 0], [17, 80], [1, 40], [5, 223], [2, 211], [3, 40], [3, 60], [19, 40], [19, 72], [0, 234]])('refuses a recorded but miswired role %s at offset %s', async (role, offset) => {
    const f = m2Fixture(); const old = f.code.get(f.at(role).toLowerCase()) as Hex;
    const start = 2 + (45 + offset) * 2;
    const changed = `${old.slice(0, start)}ff${old.slice(start + 2)}` as Hex;
    f.code.set(f.at(role).toLowerCase(), changed);
    const record = { ...f.record, codeHashes: f.record.codeHashes.map((h, i) => i === role ? keccak256(changed) : h) };
    const verdict = await checkBoxV2(f.reader, f.manifest, { registry: f.row.registry, record, encodedSpec: f.encodedSpec }, { creationHash: H(100), headHash: H(101), reviewed: [] });
    expect(verdict.classification).toBe('refused');
  });

  it('refuses a replaced implementation even if its clone hash still matches', async () => {
    const f = m2Fixture(); const impl = f.release.implementations as unknown as Record<string, {address: Hex}>;
    f.code.set((impl.holderLedger?.address as Hex).toLowerCase(), '0x1234');
    expect((await checkBoxV2(f.reader, f.manifest, { registry: f.row.registry, record: f.record, encodedSpec: f.encodedSpec }, { creationHash: H(100), headHash: H(101), reviewed: [] })).classification).toBe('refused');
  });
});
