import { F143_DRAND, withF143 } from './f143-synth';
/**
 * M1-52 red tests: v2 box discovery by clone checks (core-v2-m1-tickets.md § 2, M1-52 "Red first"; ADR-0017 § 2, § 6;
 * ADR-0016's note 4; F102, CQ2-5; BC-214, whose planned TypeScript test this file carries, coverage.v2.json):
 * - a v2 box is found from the manifest's v2 registry alone and its code checked at its creation block: every role's
 *   code hashes to the record's, each part is a clone of the release's implementation, T is a standard clone of the
 *   release's T implementation whose 182 bytes decode to its `BoxTokenV2Args`, and its PoolManager and drand source are
 *   the manifest's;
 * - a v1 look-alike is refused (a registry that is not a v2 release's; parts cloned from v1's implementations);
 * - no template gate: a box with any template id is shown (v1's `supportedTemplates` would class it 'unsupported');
 * - plug-ins (BC-214, N08): an unreviewed one is shown and marked; one whose code was removed in its creation
 *   transaction, or replaced later, is marked; a LEG clone of the implementation the spec names passes, one of other
 *   code is refused.
 * Review round 1: a spec whose plug-in, recipe or add-on params do not decode is refused, never thrown (the caller
 * retries only unreadable code); a role this release names no implementation for (16-23) is refused, as is a spec with
 * more than 2 LEG plug-ins; and each identity check has a refusal of its own (executor, v1's roles 10 and 12, T's
 * holder and vault, the drand source, the tickets and the royalty router's receiving form).
 */
import { keccak256, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { checkBoxV2, type BoxVerdictV2, type ReviewedPlugIn } from '../../src/core/v2/discovery-v2';
import type { BoxRecordV2 } from '../../src/core/v2/chain-v2';
import { plainCode, plugInParams, synthBoxV2, synthManifestV2, SynthReaderV2, tArgs, V2, type SynthBoxV2, type SynthBoxOptions } from '../../../chain/src/core/v2/test-support/synth-v2';
import { standardRuntime } from '../../../chain/src/core/v2/clones-v2';

const CREATION = keccak256('0xc0') as Hex;
const HEAD = keccak256('0x01') as Hex;
const RULE_CODE = plainCode('rule-plug-in');
const RULE = { implementation: '0x5100000000000000000000000000000000000001' as Address, codeHash: keccak256(RULE_CODE) };
const LEG_CODE = plainCode('leg-plug-in');
const LEG = { implementation: '0x5100000000000000000000000000000000000002' as Address, codeHash: keccak256(LEG_CODE) };

async function check(o: SynthBoxOptions, setup: (r: SynthReaderV2, box: SynthBoxV2) => void = () => undefined, reviewed: readonly ReviewedPlugIn[] = [RULE, LEG], registry: Address = V2.registry, recordOf: (r: BoxRecordV2) => BoxRecordV2 = (r) => r): Promise<BoxVerdictV2> {
  const box = synthBoxV2(o);
  const reader = new SynthReaderV2().addBox(box).setCode(RULE.implementation, RULE_CODE).setCode(LEG.implementation, LEG_CODE);
  setup(reader, box);
  return checkBoxV2(reader, synthManifestV2(), { registry, record: recordOf(box.record), encodedSpec: box.encodedSpec }, { creationHash: CREATION, headHash: HEAD, reviewed });
}

/** The record with role `index` at `address` (its code hash zero: these checks come before any code is read). */
const withRole = (index: number, address: Address) => (r: BoxRecordV2): BoxRecordV2 => ({ ...r, contracts: r.contracts.map((a, i) => (i === index ? address : a)) });
const refusedFor = (verdict: BoxVerdictV2, reason: RegExp): void => {
  expect(verdict.classification, verdict.reason ?? 'shown').toBe('refused');
  expect(verdict.reason).toMatch(reason);
};

describe('M1-52 v2 discovery by clone checks', () => {
  it('M1-52 a v2 box is shown: every part a clone of the release, T decoded from its 182 bytes', async () => {
    const verdict = await check({ boxId: 0n });
    expect(verdict).toMatchObject({ classification: 'shown', reason: null, marks: [] });
    expect(verdict.token).toEqual({ holder: synthBoxV2({ boxId: 0n }).record.contracts[0], vault: synthBoxV2({ boxId: 0n }).record.contracts[3], ledger: '0x0000000000000000000000000000000000000000', supply: 10n ** 27n, name: 'Box 0', symbol: 'B0' });
    const tokenOnly = await check({ boxId: 1n, tokenOnly: true });
    expect(tokenOnly.classification).toBe('shown');
    expect(tokenOnly.token?.vault).toBe('0x0000000000000000000000000000000000000000');
  });

  it('M1-52 no template gate: any template id is shown, never classed unsupported', async () => {
    const verdict = await check({ boxId: 2n });
    expect(verdict.classification).toBe('shown');
    expect(synthManifestV2().releases[0]).not.toHaveProperty('supportedTemplates');
  });

  it('M1-52 a v1 look-alike is refused: a registry no v2 release names, or parts cloned from v1', async () => {
    const fromV1Registry = await check({ boxId: 3n }, undefined, undefined, V2.v1Registry);
    expect(fromV1Registry).toMatchObject({ classification: 'refused' });
    expect(fromV1Registry.reason).toMatch(/registry/);
    const v1Clones = await check({ boxId: 4n, implOf: (key) => V2.v1Impl(key) });
    expect(v1Clones.classification).toBe('refused');
    expect(v1Clones.reason).toMatch(/coordinator is not a clone of the release's coordinator implementation/);
  });

  it("M1-52 a part whose code does not hash to the record's, or a PoolManager not the manifest's, is refused", async () => {
    const changed = await check({ boxId: 5n }, (r, box) => r.setCode(box.record.contracts[2] as Address, plainCode('other hook'), CREATION));
    expect(changed.reason).toMatch(/hook's code at the creation block/);
    const box = synthBoxV2({ boxId: 6n });
    const reader = new SynthReaderV2().addBox(box);
    const pm = await checkBoxV2(reader, synthManifestV2(), { registry: V2.registry, record: { ...box.record, poolManager: V2.weth }, encodedSpec: box.encodedSpec }, { creationHash: CREATION, headHash: HEAD, reviewed: [] });
    expect(pm.reason).toMatch(/PoolManager/);
  });

  it('M1-52 a T of other code is refused: a full contract, a clone of another implementation, or other arguments', async () => {
    const full = await check({ boxId: 7n, codeOf: { token: plainCode('full erc20') } });
    expect(full.reason).toMatch(/token is not a clone of the release's T implementation/);
    const other = await check({ boxId: 8n, codeOf: { token: standardRuntime(V2.impl('coordinator'), `0x${'00'.repeat(137)}`) } });
    expect(other.reason).toMatch(/token is not a clone/);
    const box = synthBoxV2({ boxId: 9n });
    const wrongName = await check({ boxId: 9n, codeOf: { token: box.code.get((box.record.contracts[1] as string).toLowerCase())?.replace(/426f782039/, '426f782038') as Hex } });
    expect(wrongName.reason).toMatch(/token's arguments/);
  });

  it('CQ11-E refuses retired plug-ins and cap recipes without discovering their code', async () => {
    for (const options of [{ rule: RULE }, { legs: [LEG] }, { humblePreset: 2 }]) {
      refusedFor(await check({ boxId: 10n, ...options }), /CQ11|offers/);
    }
  });

  it('M1-52 a spec whose plug-in, recipe or add-on params do not decode is refused, never thrown', async () => {
    refusedFor(await check({ boxId: 30n, specOf: (s) => ({ ...s, buyers: { ...s.buyers, split: 4, splitParams: '0x01' } }) }), /CQ11|params do not decode/);
    refusedFor(await check({ boxId: 31n, specOf: (s) => ({ ...s, sellers: { ...s.sellers, a: { leg: 5, dest: 4, legParams: '0x01', destParams: '0x' } } }) }), /CQ11|params do not decode/);
    refusedFor(await check({ boxId: 32n, specOf: (s) => ({ ...s, buyers: { ...s.buyers, split: 2, splitParams: '0x' } }) }), /CQ11|params do not decode/);
    refusedFor(await check({ boxId: 33n, specOf: (s) => ({ ...s, addOns: [{ id: 10, params: '0x01' }] }) }), /CQ11|params do not decode/);
  });

  it('M1-52 a role this release names no implementation for is refused, and so is a spec with more than 2 LEG plug-ins', async () => {
    const roles: [number, string][] = [[16, 'itemLedger'], [17, 'holderLedger'], [18, 'heldItemEarnings'], [19, 'starterSetLoader'], [20, 'reserved20'], [23, 'reserved23']];
    for (const [index, role] of roles) {
      refusedFor(await check({ boxId: 40n + BigInt(index), extra: [{ index, role, code: plainCode(`any ${role}`) }] }), new RegExp(`${role} is present but this release offers no ${role}`));
    }
    const third = { leg: 5, dest: 1, legParams: plugInParams.leg(LEG), destParams: '0x' } as const;
    refusedFor(await check({ boxId: 70n, legs: [LEG, LEG], specOf: (s) => ({ ...s, buyers: { ...s.buyers, b: third } }) }), /CQ11|offers/);
    // Exactly 2 is the cap, not past it (round 2).
    expect((await check({ boxId: 71n, legs: [LEG, LEG] })).classification).toBe('refused');
  });

  it('M1-52 each identity check refuses on its own: executor, roles 10 and 12, T holder and vault, drand source, tickets, royalty router', async () => {
    expect(synthBoxV2({ boxId: 80n }).record.contracts[9]).toBe('0x0000000000000000000000000000000000000000');
    const stranger = '0x5000000000000000000000000000000000000005' as Address;
    refusedFor(await check({ boxId: 80n }, undefined, undefined, undefined, withRole(9, stranger)), /executor is present but this release offers no executor/);
    refusedFor(await check({ boxId: 80n }, undefined, undefined, undefined, r => ({ ...r, codeHashes: r.codeHashes.map((h, i) => i === 9 ? CREATION : h) })), /unused executor hash must be zero/);
    refusedFor(await check({ boxId: 81n }, undefined, undefined, undefined, withRole(10, stranger)), /itemStream is not a v2 role but is present/);
    refusedFor(await check({ boxId: 82n }, undefined, undefined, undefined, withRole(12, stranger)), /metadataTable is not a v2 role but is present/);
    refusedFor(await check({ boxId: 83n }, undefined, undefined, undefined, (r) => ({ ...r, randomness: V2.weth })), /drand source/);
    const box = synthBoxV2({ boxId: 84n });
    const [coordinator, vault] = [box.record.contracts[0] as Address, box.record.contracts[3] as Address];
    const t = (holder: Address, v: Address): Hex => standardRuntime(V2.impl('token'), tArgs(holder, v, 10n ** 27n, 'Box 84', 'B84'));
    expect((await check({ boxId: 84n, codeOf: { token: t(coordinator, vault) } })).classification).toBe('shown');
    refusedFor(await check({ boxId: 84n, codeOf: { token: t(stranger, vault) } }), /token's arguments/);
    refusedFor(await check({ boxId: 84n, codeOf: { token: t(coordinator, stranger) } }), /token's arguments/);
    refusedFor(await check({ boxId: 85n, codeOf: { tickets: standardRuntime(V2.impl('vault')) } }), /tickets is not a clone of the release's tickets implementation/);
    refusedFor(await check({ boxId: 86n, codeOf: { royaltyRouter: standardRuntime(V2.impl('royaltyRouter')) } }), /royaltyRouter is not a clone of the release's royaltyRouter implementation/);
  });
});


it('F143: v2 discovers the pinned DrandSource and refuses the backed source with the existing reason', async () => {
  const manifest = withF143(synthManifestV2());
  const box = synthBoxV2({ boxId: 4n });
  const reader = new SynthReaderV2().addBox(box);
  const candidate = { registry: V2.registry, encodedSpec: box.encodedSpec, record: { ...box.record, randomness: F143_DRAND.address } };
  const at = { creationHash: CREATION, headHash: HEAD, reviewed: [] };
  expect(await checkBoxV2(reader, manifest, candidate, at)).toMatchObject({ classification: 'shown', reason: null });
  const backed = { ...candidate, record: { ...candidate.record, randomness: manifest.chain.randomness.address } };
  expect(await checkBoxV2(reader, manifest, backed, at)).toMatchObject({ classification: 'refused', reason: `drand source ${backed.record.randomness} is not the manifest's` });
});
