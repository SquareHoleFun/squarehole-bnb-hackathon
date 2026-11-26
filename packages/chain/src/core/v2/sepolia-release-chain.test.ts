/**
 * SH-SEP-MANIFEST: the read-only chain check of a written Sepolia release, at the v1 manifest's evidence block, on a fake
 * chain that agrees with the fork plan fixture (test-support/sepolia-release-fixture.ts). No network.
 */
import { getAddress, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { buildSepoliaRelease } from './sepolia-release';
import { checkReleaseOnChain, SAFE_GUARD_SLOT, SAFE_HANDLER_SLOT } from './sepolia-release-chain';
import { FakeReleaseChain, forkPlan, forkRun, forkV1Manifest, forkVerifyOutput } from './test-support/sepolia-release-fixture';

const built = () => {
  const plan = forkPlan();
  const { manifest } = buildSepoliaRelease({ v1Manifest: forkV1Manifest(plan), plan, run: forkRun(plan), verifyOutput: forkVerifyOutput(plan), registry: plan.registry });
  const release = manifest.releases[0];
  if (!release) throw new Error('no release');
  return { manifest, release, chain: new FakeReleaseChain(manifest, release) };
};
const hash = (c: string) => `0x${c.repeat(64)}` as Hex;
const OTHER = '0x7777777777777777777777777777777777777777';

describe('SH-SEP-MANIFEST chain check at the evidence block', () => {
  it('passes when the chain agrees, reading only at the evidence block', async () => {
    const { manifest, release, chain } = built();
    expect(await checkReleaseOnChain(manifest, release, chain)).toEqual([]);
    expect([...chain.seenBlocks]).toEqual([BigInt(manifest.evidence.block.number)]);
  });

  it('stops at another chain or a different evidence block hash', async () => {
    const { manifest, release, chain } = built();
    chain.chain = 1;
    expect(await checkReleaseOnChain(manifest, release, chain)).toEqual(['the RPC is chain 1, not Sepolia']);
    const other = built();
    const moved = { ...other.manifest, evidence: { ...other.manifest.evidence, block: { ...other.manifest.evidence.block, hash: hash('e') } } };
    expect((await checkReleaseOnChain(moved, other.release, other.chain))[0]).toMatch(/reorg or another chain/);
  });

  it('names each contract whose code, role or view differs', async () => {
    const { manifest, release, chain } = built();
    chain.codes.set(release.implementations.tickets.address.toLowerCase(), hash('1'));
    chain.codes.delete(release.listingRegistry.address.toLowerCase());
    chain.setView(release.factory.address, 'implementation', [18n], OTHER);
    chain.setView(release.factory.address, 'versionCodeHash', [], hash('2'));
    chain.setView(release.implementations.hook.address, 'extension', [], OTHER);
    chain.setView(release.implementations.receiver.address, 'FIT_SAFE', [], OTHER);
    const problems = await checkReleaseOnChain(manifest, release, chain);
    expect(problems.join('\n')).toMatch(/implementations\.tickets/);
    expect(problems.join('\n')).toMatch(/listingRegistry .* code hash 0xc5d2/);
    expect(problems.join('\n')).toMatch(/factory\.implementation\(18\)/);
    expect(problems.join('\n')).toMatch(/versionCodeHash/);
    expect(problems.join('\n')).toMatch(/hook\.extension/);
    expect(problems.join('\n')).toMatch(/receiver\.FIT_SAFE/);
    expect(problems).toHaveLength(6);
  });

  it('applies CoreV2SafeChecks\'s rules to both Safes', async () => {
    const { manifest, release, chain } = built();
    const fit = release.safes.fit.address;
    const platform = release.safes.platform.address;
    chain.setView(fit, 'getOwners', [], [...release.safes.fit.owners].reverse().map((o) => getAddress(o)));
    chain.setView(fit, 'getThreshold', [], 1n);
    chain.setView(platform, 'getModulesPaginated', ['0x0000000000000000000000000000000000000001', 10n], [[OTHER], '0x0000000000000000000000000000000000000001']);
    chain.slots.set(`${platform}:${SAFE_GUARD_SLOT}`, `0x${OTHER.slice(2).padStart(64, '0')}`);
    chain.slots.set(`${fit}:${SAFE_HANDLER_SLOT}`, hash('0'));
    chain.slots.set(`${platform}:0x0`, `0x${OTHER.slice(2).padStart(64, '0')}`);
    chain.setView(release.safes.platform.singleton, 'VERSION', [], '1.3.0');
    const text = (await checkReleaseOnChain(manifest, release, chain)).join('\n');
    for (const expected of [/safes\.fit: owners/, /safes\.fit: threshold 1/, /safes\.platform: modules enabled/, /safes\.platform: guard/, /safes\.fit: handler 0x0{40}/, /safes\.platform: singleton 0x7777/, /safes\.platform\.singleton: VERSION 1\.3\.0/]) {
      expect(text).toMatch(expected);
    }
  });

  it('checks control-transfer transactions when given: success, to the Safe, ExecutionSuccess, before the evidence block', async () => {
    const { manifest, release, chain } = built();
    const n = BigInt(manifest.evidence.block.number);
    const fit = getAddress(release.safes.fit.address);
    chain.addControlProof(fit, hash('a'), hash('b'), n - 10n);
    expect(await checkReleaseOnChain(manifest, release, chain, { fit: { inTx: hash('a'), outTx: hash('b') } })).toEqual([]);
    const platform = { inTx: hash('c'), outTx: hash('d') };
    chain.addControlProof(fit, platform.inTx, platform.outTx, n + 5n); // sent to the wrong Safe, and late
    const text = (await checkReleaseOnChain(manifest, release, chain, { platform })).join('\n');
    expect(text).toMatch(/safes\.platform: control proof in .* not a successful transaction to the Safe/);
    expect(text).toMatch(/safes\.platform: control proof out .* no ExecutionSuccess/);
    expect(text).toMatch(/after the evidence block/);
    expect((await checkReleaseOnChain(manifest, release, chain, { fit: { inTx: hash('f'), outTx: hash('b') } })).join('\n')).toMatch(/control proof in/);
  });
});
