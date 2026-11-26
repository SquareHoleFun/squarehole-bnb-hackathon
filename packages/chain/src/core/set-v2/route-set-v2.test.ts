import { describe, expect, it } from 'vitest';
import { getAddress, keccak256, zeroAddress, type Hex } from 'viem';
import { encodeSetSpecV2 } from '@squarehole/box-spec';
import { parseSetManifest, releaseKindOfRegistry, checkSetIdentity } from './index';
import { core, hash, address, required, setManifestInput, identityInput, spec } from './test-support';

const manifest = () => parseSetManifest(setManifestInput(), core);
describe('E08A-ROUTE / SET-07', () => {
  it('dispatches by emitting registry, never by template alone', () => {
    expect(releaseKindOfRegistry(core, manifest(), required(core.versions[0]).registry.address)?.kind).toBe('v1');
    expect(releaseKindOfRegistry(core, manifest(), required(core.releases[0]).registry.address)?.kind).toBe('v2.1');
    expect(releaseKindOfRegistry(core, manifest(), manifest().registry.address)?.kind).toBe('set-v2');
    expect(releaseKindOfRegistry(core, null, manifest().registry.address)).toBeNull();
    expect(releaseKindOfRegistry(core, manifest(), address('unknown'))).toBeNull();
  });
  it('returns the outside collection only from the matching spec and vault immutable arguments', () => {
    const identity = checkSetIdentity(core, manifest(), identityInput());
    expect(identity.spec).toEqual({ ...spec, collection: getAddress(spec.collection) });
    expect(identity.collection.toLowerCase()).toBe(spec.collection.toLowerCase());
    expect(identity.vault).toBe(identityInput().roles[3]);
    expect(identityInput().roles[4]).toBe(zeroAddress);
  });
  it.each(['registry', 'template', 'hash', 'trailing', 'schema', 'release', 'format', 'role4'] as const)('refuses %s', (bad) => {
    const input = identityInput();
    if (bad === 'registry') input.registry = required(core.releases[0]).registry.address;
    if (bad === 'template') input.templateId = hash('wrong');
    if (bad === 'hash') input.specHash = hash('wrong');
    if (bad === 'trailing') input.encodedSpec = `${input.encodedSpec}00`;
    if (bad === 'schema' || bad === 'release' || bad === 'format') input.encodedSpec = encodeSetSpecV2({ ...spec, [bad]: bad === 'format' ? 1 : hash('wrong') });
    if (['trailing', 'schema', 'release', 'format'].includes(bad)) input.specHash = keccak256(input.encodedSpec);
    if (bad === 'role4') input.roles[4] = spec.collection;
    expect(() => checkSetIdentity(core, manifest(), input)).toThrow();
  });
  it('refuses unknown registries, wrong clone implementation/length and every immutable term mismatch', () => {
    const input = identityInput();
    expect(() => checkSetIdentity(core, manifest(), { ...input, registry: address('unknown') })).toThrow();
    expect(() => checkSetIdentity(core, manifest(), { ...input, vaultCode: `${input.vaultCode}00` })).toThrow();
    for (const byte of [10, 45, 65, 85, 105, 125, 145, 149, 181]) {
      const start = 2 + byte * 2;
      const original = input.vaultCode.slice(start, start + 2);
      const vaultCode: Hex = `0x${input.vaultCode.slice(2, start)}${original === 'ff' ? '00' : 'ff'}${input.vaultCode.slice(start + 2)}`;
      expect(() => checkSetIdentity(core, manifest(), { ...input, vaultCode })).toThrow();
    }
    for (const role of [0, 1, 2, 3, 5, 6, 19]) {
      const roles = [...input.roles]; roles[role] = zeroAddress;
      expect(() => checkSetIdentity(core, manifest(), { ...input, roles })).toThrow();
    }
    for (const role of [7, 16, 17]) {
      const roles = [...input.roles]; roles[role] = spec.collection;
      expect(() => checkSetIdentity(core, manifest(), { ...input, roles })).toThrow();
    }
  });
});
