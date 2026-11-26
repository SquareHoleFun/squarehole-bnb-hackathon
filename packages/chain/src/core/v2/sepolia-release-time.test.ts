import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, getAddress, keccak256, toBytes, type Hex } from 'viem';
import { buildSepoliaRelease, returnedManifest } from './sepolia-release';
import { checkReleaseOnChain } from './sepolia-release-chain';
import { FakeReleaseChain, forkPlan, forkRun, forkV1Manifest, forkVerifyOutput, type Json } from './test-support/sepolia-release-fixture';

const hash = (c: string): Hex => `0x${c.repeat(64)}`;
const topic = keccak256(toBytes('DirectoryCodeVerified(address,uint256,bytes32)'));

function delayed() {
  const plan = forkPlan();
  const run = forkRun(plan);
  const returned = returnedManifest(run.returns.manifest.value) as Json;
  returned.partCodeHashes[29] = hash('a');
  run.returns.manifest.value = JSON.stringify(returned);
  const event = {
    topics: [topic],
    data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }], [getAddress(plan.parts[29]), 1792721568n, hash('b')]),
  };
  const output = JSON.parse(forkVerifyOutput(plan).split('\n')[1] ?? '') as Json;
  output.raw_logs.unshift(event);
  const inputs = () => ({ plan, run, v1Manifest: forkV1Manifest(plan), verifyOutput: JSON.stringify(output), registry: plan.registry });
  return { plan, run, returned, event, output, inputs };
}

describe('SH-V2-RELEASE-TIME writer', () => {
  it('records the verified chain hash when plan, broadcast and chain have three directory hashes', async () => {
    const f = delayed();
    const { manifest } = buildSepoliaRelease(f.inputs());
    const release = manifest.releases[0];
    if (!release) throw new Error('no release');
    expect(release.feeModuleDirectory).toEqual({ address: getAddress(f.plan.parts[29]), codeHash: hash('b') });
    const chain = new FakeReleaseChain(manifest, release);
    chain.codes.set(f.plan.parts[29].toLowerCase(), hash('b'));
    expect(await checkReleaseOnChain(manifest, release, chain)).toEqual([]);
    chain.codes.set(f.plan.parts[29].toLowerCase(), hash('c'));
    expect((await checkReleaseOnChain(manifest, release, chain)).join('\n')).toMatch(/feeModuleDirectory .* code hash/);
    expect(f.plan.partCodeHashes[29]).not.toBe(hash('b'));
  });

  it('refuses the difference without the directory event', () => {
    const f = delayed();
    f.output.raw_logs.shift();
    expect(() => buildSepoliaRelease(f.inputs())).toThrow(/partCodeHashes/);
  });

  it('refuses an event for a different directory address', () => {
    const f = delayed();
    f.event.data = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }], [getAddress(f.plan.parts[30]), 1792721568n, hash('b')]);
    expect(() => buildSepoliaRelease(f.inputs())).toThrow(/directory/i);
  });

  it('refuses an event hash that does not equal the chain, even when it equals the plan or broadcast', async () => {
    for (const claimed of [hash('c'), hash('a'), forkPlan().partCodeHashes[29] as Hex]) {
      const f = delayed();
      f.event.data = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }], [getAddress(f.plan.parts[29]), 1792721568n, claimed]);
      const { manifest } = buildSepoliaRelease(f.inputs());
      const release = manifest.releases[0];
      if (!release) throw new Error('no release');
      const chain = new FakeReleaseChain(manifest, release);
      chain.codes.set(f.plan.parts[29].toLowerCase(), hash('b'));
      expect((await checkReleaseOnChain(manifest, release, chain)).join('\n')).toMatch(/feeModuleDirectory .* code hash/);
    }
  });

  it('checks the directory against the chain without an event when the two simulations agree', async () => {
    const f = delayed();
    f.run.returns.manifest.value = JSON.stringify(f.plan);
    f.output.raw_logs.shift();
    const { manifest } = buildSepoliaRelease(f.inputs());
    const release = manifest.releases[0];
    if (!release) throw new Error('no release');
    const chain = new FakeReleaseChain(manifest, release);
    chain.codes.set(f.plan.parts[29].toLowerCase(), hash('b'));
    expect((await checkReleaseOnChain(manifest, release, chain)).join('\n')).toMatch(/feeModuleDirectory .* code hash/);
  });

  it('never exempts another part, another field, or a malformed directory hash', () => {
    for (const edit of [
      (p: Json) => { p.partCodeHashes[30] = hash('c'); },
      (p: Json) => { p.partCodeHashes[29] = 'bad'; },
      (p: Json) => { p.partCodeHashes.push(hash('c')); },
      (p: Json) => { p.partNames[29] = 'Other'; },
      (p: Json) => { p.parts[29] = p.parts[30]; },
      (p: Json) => { p.remainingProofs = 'changed'; },
    ]) {
      const f = delayed();
      edit(f.returned);
      f.run.returns.manifest.value = JSON.stringify(f.returned);
      expect(() => buildSepoliaRelease(f.inputs())).toThrow();
    }
  });

  it('refuses duplicate directory events and a failed verification', () => {
    const f = delayed();
    f.output.raw_logs.unshift(f.event);
    expect(() => buildSepoliaRelease(f.inputs())).toThrow(/DirectoryCodeVerified/);
    f.output.raw_logs.shift();
    f.output.success = false;
    expect(() => buildSepoliaRelease(f.inputs())).toThrow(/did not succeed/);
  });

  it('accepts only the simulated time changing in the optional time-dependent annotation', () => {
    const f = delayed();
    f.plan.timeDependentCodeHash = { part: '29', name: 'FeeModuleDirectoryV21', simulatedCreationTime: '1792720824' };
    f.returned.timeDependentCodeHash = { ...f.plan.timeDependentCodeHash, simulatedCreationTime: '1792721256' };
    f.run.returns.manifest.value = JSON.stringify(f.returned);
    expect(() => buildSepoliaRelease(f.inputs())).not.toThrow();
    f.returned.timeDependentCodeHash.part = '30';
    f.run.returns.manifest.value = JSON.stringify(f.returned);
    expect(() => buildSepoliaRelease(f.inputs())).toThrow(/timeDependentCodeHash/);
  });
});
