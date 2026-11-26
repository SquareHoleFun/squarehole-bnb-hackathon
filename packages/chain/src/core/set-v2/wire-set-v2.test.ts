import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toSetSpecV2Wire } from '@squarehole/box-spec';
import { setDecimalStringSchema, setFeedSchema, setBoxSchema, setMembersSchema, setMemberStateSchema, setFactoryV2Abi, setVaultV2Abi, setStarterSetLoaderV2Abi, setRegistryV2Abi } from './index';
import { core, hash, spec, identityInput } from './test-support';

const input = identityInput();
const common = { chainId: core.chainId, asOf: { block: '60', hash: hash('block'), tier: 'confirmed' } };
const box = {
  registry: input.registry, boxId: '0', coordinator: input.roles[0], token: input.roles[1], vault: input.roles[3],
  loader: input.roles[19], creator: input.creator, collection: spec.collection, templateId: input.templateId,
  specHash: input.specHash, encodedSpec: input.encodedSpec, spec: toSetSpecV2Wire(spec),
  state: { loaded: '10', inside: '9', totalSupply: '100003', escrowPrincipal: '10001', gateOpen: true, failed: false, seedReady: true, remainingHash: hash('suffix') },
};
const memberView = () => ({ schema: 'sh.core-set-members.v1', ...common, registry: input.registry, boxId: '0', collection: spec.collection, setHash: spec.setHash, offset: '0', nextOffset: null, members: [{ index: '0', id: '0', state: 'Inside' }, { index: '1', id: ((1n << 256n) - 1n).toString(), state: 'Deferred' }] });

describe('E08A-WIRE / SET-09', () => {
  it('round-trips all three strict wire envelopes with decimal amounts and arbitrary ids', () => {
    const feed = { schema: 'sh.core-set-feed.v1', ...common, boxes: [box] };
    const detail = { schema: 'sh.core-set-box.v1', ...common, box };
    for (const [schema, value] of [[setFeedSchema, feed], [setBoxSchema, detail], [setMembersSchema, memberView()]] as const) {
      expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    }
    for (const state of ['Inside', 'Outside', 'Released', 'Deferred']) expect(setMemberStateSchema.parse(state)).toBe(state);
    expect(() => setMemberStateSchema.parse('Unknown')).toThrow();
  });
  it('refuses JSON numbers, noncanonical decimals, uint256 overflow and extra fields at nested boundaries', () => {
    for (const id of [0, 1.5, '-1', '01', '1e3', (1n << 256n).toString()]) {
      expect(() => setMembersSchema.parse({ ...memberView(), members: [{ index: '0', id, state: 'Inside' }] })).toThrow();
    }
    for (const field of ['totalSupply', 'escrowPrincipal', 'inside', 'loaded']) {
      expect(() => setBoxSchema.parse({ schema: 'sh.core-set-box.v1', ...common, box: { ...box, state: { ...box.state, [field]: 1 } } })).toThrow();
    }
    expect(() => setBoxSchema.parse({ schema: 'sh.core-set-box.v1', ...common, box: { ...box, spec: { ...box.spec, raise: 1 } } })).toThrow();
    expect(() => setFeedSchema.parse({ schema: 'sh.core-set-feed.v1', ...common, boxes: [box], extra: true })).toThrow();
    expect(() => setMembersSchema.parse({ ...memberView(), members: [{ index: '0', id: '1', state: 'Inside', extra: true }] })).toThrow();
    expect(() => setMembersSchema.parse({ ...memberView(), asOf: { ...common.asOf, block: 60 } })).toThrow();
  });
  it('returns a zod refusal for malformed decimal strings without throwing from safeParse', () => {
    for (const value of ['wat', '1.5', '1e3', '', '00', '-1', '9'.repeat(1000)]) {
      expect(setDecimalStringSchema.safeParse(value).success).toBe(false);
    }
  });
});

it('E08A-ABI exports the new factory/vault and unchanged loader/registry entrypoints and events', () => {
  const names = (abi: readonly { type: string; name?: string }[]) => abi.map(i => i.name);
  expect(names(setFactoryV2Abi)).toEqual(expect.arrayContaining(['createBox', 'predictBox', 'predictHook', 'versionCodeHash', 'RELEASE', 'TEMPLATE']));
  expect(names(setVaultV2Abi)).toEqual(expect.arrayContaining(['withdrawBatch', 'returnItems', 'releaseToCreator', 'SetLoaded', 'ReleaseSucceeded', 'ReleaseDeferred']));
  expect(names(setStarterSetLoaderV2Abi)).toEqual(expect.arrayContaining(['load', 'progress', 'complete']));
  expect(names(setRegistryV2Abi)).toContain('BoxCreated');
});

it('E08A-INTEGER rejects lossy numeric parsing in the shared chain source', () => {
  const dir = new URL('./', import.meta.url);
  for (const file of readdirSync(dir).filter(f => /\.(ts|mjs)$/.test(f) && !f.endsWith('.test.ts'))) {
    expect(readFileSync(new URL(file, dir), 'utf8'), file).not.toMatch(/\bNumber\s*\(|\bparseFloat\b|\bparseInt\b/);
  }
});
