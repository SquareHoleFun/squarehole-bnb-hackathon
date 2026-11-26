import { keccak256, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { parseCoreManifestV2 } from './chain-v2';
import { checkBoxV2 } from './discovery-v2';
import { feeChoiceV2 } from './views-v2';
import { m3Fixture, H, required } from './m3-fixture.test-support';
const blocks = { creationHash: H(100), headHash: H(101), reviewed: [] };
const check = (f: ReturnType<typeof m3Fixture>) => checkBoxV2(f.reader, f.manifest, { registry: f.release.registry.address, record: f.record, encodedSpec: f.encodedSpec }, blocks);

describe('M352 provenance and canonical menu', () => {
  it.each([false, true])('admits only release-pinned M3 parts, pile=%s', async pile => {
    const f = m3Fixture(pile);
    expect(() => parseCoreManifestV2(f.manifest)).not.toThrow();
    expect(await check(f)).toMatchObject({ classification: 'shown', reason: null });
  });
  it('admits an unseeded pile with zero collection, tickets, item ledger and loader', async () => {
    const f = m3Fixture(true, 0n);
    expect(await check(f)).toMatchObject({ classification: 'shown' });
  });
  it('recognizes explicit Keep and Burn policies and refuses empty or padded policies', () => {
    const f = m3Fixture();
    expect(feeChoiceV2(f.spec.buyers)).toBe('items');
    expect(feeChoiceV2(f.spec.sellers)).toBe('items');
    for (const destParams of ['0x', H(0), H(4), `${H(1)}00`] as Hex[]) expect(feeChoiceV2({ ...f.spec.buyers, a: { ...f.spec.buyers.a, destParams } })).toBeNull();
  });
  it.each([[false, 16, 0], [false, 16, 20], [false, 16, 40], [false, 16, 60], [false, 16, 80], [false, 16, 100], [false, 16, 120], [false, 16, 140], [false, 5, 243], [true, 3, 0], [true, 3, 20], [true, 3, 40], [true, 3, 60], [true, 3, 80]] as const)('refuses self-hashed forged wiring %s/%s/%s', async (pile, role, offset) => {
    const f = m3Fixture(pile); const address = f.at(role); const runtime = required(f.code.get(address.toLowerCase()));
    const pos = 92 + offset * 2;
    const forged = `${runtime.slice(0, pos)}ff${runtime.slice(pos + 2)}` as Hex;
    f.code.set(address.toLowerCase(), forged);
    f.record.codeHashes[role] = keccak256(forged);
    if (pile) f.record.codeHashes[19] = keccak256(forged);
    expect(await check(f)).toMatchObject({ classification: 'refused' });
  });
  it.each([false, true])('refuses replaced implementation code, pile=%s', async pile => {
    const f = m3Fixture(pile); const key = pile ? 'pileVault' : 'itemLedger';
    const pins = f.release.implementations as unknown as Record<string, { address: string }>;
    f.code.set(required(pins[key]).address.toLowerCase(), '0x6000');
    expect(await check(f)).toMatchObject({ classification: 'refused' });
  });
});
