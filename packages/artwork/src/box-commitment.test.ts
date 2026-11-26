/**
 * The generalised box commitment (box creation flow § 2 field 20): the Misfits leaf and tree for any N. For N = 4,200
 * it must give exactly the Misfits root and proofs, so the contracts' Misfits vectors cover it too.
 */
import { describe, expect, it } from 'vitest';
import * as sharedCommitment from '@squarehole/domain/box-commitment';
import {
  BOX_MAX_TABLE_BYTES,
  boxLeaf,
  boxTreeDepth,
  buildBoxTree,
  encodeBoxLeafPreimage,
  encodeBoxMetadataTable,
  verifyBoxProof,
  type BoxLeafEntry,
} from './box-commitment';
import { MISFITS_COUNT, buildMisfitsTree, encodeMetadataTable, misfitLeaf, misfitsFixtureEntries, sha256Hex } from './misfits-commitment';

const ZERO = `0x${'0'.repeat(64)}` as const;
const utf8 = (text: string) => new TextEncoder().encode(text);

function entry(id: number): BoxLeafEntry {
  return { id, traitsPacked: BigInt(id % 3), imageSha256: sha256Hex(utf8(`image-${id}`)), avatarSha256: ZERO, modelSha256: ZERO, salt: sha256Hex(utf8(`salt-${id}`)) };
}

describe('box commitment (any N)', () => {
  it('keeps the artwork API on the same primitives used by chain validation', () => {
    for (const [name, implementation] of Object.entries({ boxLeaf, boxTreeDepth, buildBoxTree, encodeBoxLeafPreimage, verifyBoxProof })) {
      expect(sharedCommitment[name as keyof typeof sharedCommitment]).toBe(implementation);
    }
  });

  it('binds a nonzero model hash as the fifth word and rejects its removal or substitution', () => {
    const plain = entry(1);
    const model = { ...plain, modelSha256: sha256Hex(utf8('reviewed GLB')) };
    const changed = { ...model, modelSha256: sha256Hex(utf8('replacement GLB')) };
    const preimage = encodeBoxLeafPreimage(model, 10);
    expect(preimage).toHaveLength(6 * 32);
    expect(`0x${Array.from(preimage.slice(4 * 32, 5 * 32), b => b.toString(16).padStart(2, '0')).join('')}`).toBe(model.modelSha256);
    expect(boxLeaf(model, 10)).toBe(misfitLeaf(model));
    expect(boxLeaf(model, 10)).not.toBe(boxLeaf(plain, 10));
    expect(boxLeaf(model, 10)).not.toBe(boxLeaf(changed, 10));
    const leaves = Array.from({ length: 10 }, (_, i) => boxLeaf(i === 0 ? model : entry(i + 1), 10));
    const tree = buildBoxTree(leaves, 10);
    expect(verifyBoxProof(1, boxLeaf(model, 10), tree.proof(1), tree.root, 10)).toBe(true);
    for (const wrong of [plain, changed]) {
      expect(verifyBoxProof(1, boxLeaf(wrong, 10), tree.proof(1), tree.root, 10)).toBe(false);
    }
  });

  it('uses depth ⌈log₂ N⌉', () => {
    expect([1, 2, 3, 10, 16, 17, 4_200, 10_000].map(boxTreeDepth)).toEqual([0, 1, 2, 4, 4, 5, 13, 14]);
    expect(() => boxTreeDepth(0)).toThrow(/N must be/);
    expect(() => boxTreeDepth(1.5)).toThrow(/N must be/);
  });

  it('gives the Misfits leaf, root and proofs for N = 4,200', () => {
    const entries = misfitsFixtureEntries();
    const leaves = entries.map(misfitLeaf);
    for (const id of [1, 2, 4_096, 4_200]) expect(boxLeaf(entries[id - 1] as BoxLeafEntry, MISFITS_COUNT)).toBe(leaves[id - 1]);
    const misfits = buildMisfitsTree(leaves);
    const box = buildBoxTree(leaves, MISFITS_COUNT);
    expect(box.root).toBe(misfits.root);
    expect(box.depth).toBe(13);
    for (const id of [1, 77, 4_097, 4_200]) expect(box.proof(id)).toEqual(misfits.proof(id));
  });

  it('commits a small box with no avatar and no model, and every proof checks', () => {
    const n = 10;
    const leaves = Array.from({ length: n }, (_, i) => boxLeaf(entry(i + 1), n));
    const tree = buildBoxTree(leaves, n);
    expect(tree.depth).toBe(4);
    for (let id = 1; id <= n; id++) {
      const proof = tree.proof(id);
      expect(proof).toHaveLength(4);
      expect(verifyBoxProof(id, leaves[id - 1] as `0x${string}`, proof, tree.root, n)).toBe(true);
      expect(verifyBoxProof(id === n ? 1 : id + 1, leaves[id - 1] as `0x${string}`, proof, tree.root, n)).toBe(false);
    }
    expect(verifyBoxProof(0, leaves[0] as `0x${string}`, tree.proof(1), tree.root, n)).toBe(false);
    expect(verifyBoxProof(1, leaves[0] as `0x${string}`, tree.proof(1).slice(1), tree.root, n)).toBe(false);
    // A different salt is a different leaf, so a different root.
    const salted = buildBoxTree(leaves.map((leaf, i) => (i === 0 ? boxLeaf({ ...entry(1), salt: sha256Hex(utf8('other')) }, n) : leaf)), n);
    expect(salted.root).not.toBe(tree.root);
  });

  it('refuses a missing image, an id outside 1..N and the wrong number of leaves', () => {
    expect(() => boxLeaf({ ...entry(1), imageSha256: ZERO }, 10)).toThrow(/imageSha256 must not be zero/);
    expect(() => boxLeaf(entry(11), 10)).toThrow(/outside 1\.\.10/);
    expect(() => boxLeaf({ ...entry(1), traitsPacked: 1n << 128n }, 10)).toThrow(/128 bits/);
    expect(() => buildBoxTree([boxLeaf(entry(1), 2)], 2)).toThrow(/exactly 2 leaves/);
  });

  it('takes a table up to the on-chain limit, where the genesis keeps its 2,048-byte budget', () => {
    const values = Array.from({ length: 255 }, (_, i) => `Value number ${String(i).padStart(3, '0')}`);
    const table = { description: 'Box', traitTypes: [{ name: 'Big', values }] };
    expect(encodeBoxMetadataTable(table).length).toBeGreaterThan(2_048);
    expect(encodeBoxMetadataTable(table).length).toBeLessThanOrEqual(BOX_MAX_TABLE_BYTES);
    expect(() => encodeMetadataTable(table)).toThrow(/a genesis carries at most 2048/);
    const huge = { description: 'x'.repeat(30_000), traitTypes: [] };
    expect(() => encodeBoxMetadataTable(huge)).toThrow(/a box carries at most 24575/);
  });
});
