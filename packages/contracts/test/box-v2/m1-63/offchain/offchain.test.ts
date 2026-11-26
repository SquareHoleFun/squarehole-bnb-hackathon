import { describe, expect, it } from 'vitest';
import { parseCoreManifestV2 } from '../../../../../chain/src/core/v2/manifest-v2';
import { SynthReaderV2, V2, ZERO, synthBoxV2, synthManifestV2, synthManifestV2Json } from '../../../../../chain/src/core/v2/test-support/synth-v2';
import { checkBoxV2 } from '../../../../../indexer/src/core/v2/discovery-v2';
import { validateManifest, validateSnapshot } from '../../../../../burn-bot/src/builders';
import { hash, manifest, snapshot } from '../../../../../burn-bot/test/fixtures';
import { emptyMemory, plan } from '../../../../../keeper/src/plan';
import { addr, box, options, time, v2, world } from '../../../../../keeper/test/support/v2';

// M1-63 / CQ11 cross-part review: failed assertions express the promised behavior.
// Synthetic records must follow current factory output; legacy executor records are refused.
describe('M1-63 creation and offchain agreements', () => {
  it('H1: admits a release without the contracts retired by C14', () => {
    const raw = synthManifestV2Json();
    const retired = new Set(['converterDeployer', 'platformCap', 'executor']);
    const retiredImplementations = new Set(['receiverExtension', 'sampler', 'swapModule', 'converter', 'converterExtension']);
    const releases = synthManifestV2().releases.map(release => ({
      ...Object.fromEntries(Object.entries(release).filter(([name]) => !retired.has(name))),
      implementations: Object.fromEntries(Object.entries(release.implementations).filter(([name]) => !retiredImplementations.has(name))),
    }));
    // This is the deployed v1 wrapper expected by the indexer, not the deploy simulation plan.
    expect(() => parseCoreManifestV2({ ...raw, releases })).not.toThrow();
  });

  it('H2: shows the zero-executor record emitted by the current factory', async () => {
    const original = synthBoxV2({ boxId: 4n, tokenOnly: true });
    const contracts = [...original.record.contracts];
    const codeHashes = [...original.record.codeHashes];
    contracts[9] = ZERO;
    codeHashes[9] = hash(0n);
    const current = { ...original, record: { ...original.record, contracts, codeHashes } };
    const verdict = await checkBoxV2(new SynthReaderV2().addBox(current), synthManifestV2(),
      { ...current, registry: V2.registry }, { creationHash: hash(50n), headHash: hash(60n), reviewed: [] });
    expect(verdict.reason).toBeNull();
    expect(verdict.classification).toBe('shown');
  });

  it('H2: refuses the retired nonzero executor role', async () => {
    const current = synthBoxV2({ boxId: 4n, tokenOnly: true,
      extra: [{ index: 9, role: 'executor', code: '0x60006000' }] });
    const verdict = await checkBoxV2(new SynthReaderV2().addBox(current), synthManifestV2(),
      { ...current, registry: V2.registry }, { creationHash: hash(50n), headHash: hash(60n), reviewed: [] });
    expect(verdict.classification).toBe('refused');
    expect(verdict.reason).toMatch(/executor/);
  });

  it('M2, superseded by F164 D2: the bot pins no platform Safe, so its version, owners and threshold cannot stop it', () => {
    // The deploy checks still pin the platform Safe; the burn bot has no platform role and refuses a platform setting.
    const platform = '0x0000000000000000000000000000000000000003';
    expect(() => validateManifest({ ...manifest, safes: { ...manifest.safes, platform } })).toThrow(/platform/);
    expect(validateSnapshot(validateManifest(manifest), snapshot('fit'), 'fit').safe).toBe(manifest.safes.fit);
  });

  it('control: FIT remains 2-of-3 on 1.4.1', () => {
    expect(validateSnapshot(manifest, snapshot('fit'), 'fit').threshold).toBe(2n);
  });

  it('M3: schedules a bounded execute call for the graduated FIT executor', () => {
    const executor = addr(88);
    const fit = box({ version: 1, id: 0n, priceSource: executor, v2: undefined,
      spotTick: 0, sampleTick: 0, checkpointTime: time,
      executor: { budget: 10n ** 18n, batchThreshold: 10n ** 17n, twapReady: true } });
    // The execution job requires a funded and ready executor, independently of checkpoint maintenance.
    const result = plan({ ...world(fit), fitGraduated: true }, emptyMemory(), options());
    const execute = result.candidates.find(candidate => candidate.to === executor && candidate.fn === 'execute');
    expect(execute, 'a funded executor has no execution job or readiness read').toBeDefined();
    expect(typeof execute?.args[0]).toBe('bigint');
    expect(execute?.args[0]).toBeGreaterThan(0n);
  });

  it('control: the seven-day hatch uses fail at the exact boundary', () => {
    const closedAt = time - 604_800n;
    const waiting = box({ graduated: false, v2: { ...v2, closedAt } });
    const before = plan(world(waiting, 100n, time - 1n), emptyMemory(), options()).candidates;
    const boundary = plan(world(waiting), emptyMemory(), options()).candidates;
    expect(before.some(candidate => candidate.fn === 'graduate')).toBe(true);
    expect(before.some(candidate => candidate.fn === 'fail')).toBe(false);
    expect(boundary.some(candidate => candidate.fn === 'fail')).toBe(true);
    expect(boundary.some(candidate => candidate.fn === 'graduate')).toBe(false);
  });
});
