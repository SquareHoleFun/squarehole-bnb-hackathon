/**
 * The exporter's two plain outputs: the public commitment (what box0-spec.1.json needs: N, depth, root, table and
 * generator hashes, the archive's identity) and the proofs file (leaf and siblings per id). Neither carries a salt, a
 * file hash or a trait of any id: a per-id picture hash would let anyone match public generator renders to numbers
 * before the reveal.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readR7, readR7Json, randomTestSet } from '../test-support/box0-export';
import { outsideRepoTemp, workspaces } from '../test-support/box0-workspaces';
import { sealArchive } from './archive';
import { buildBox0Commitment } from './commitment';
import { parseFrozenSet, parseTraitTable } from './inputs';
import { proofsFile, publicCommitment } from './outputs';
import { parseRenderHashes } from './renders';
import { TrusteeKeySplit } from './trustees';

const n = 13;
const set = randomTestSet(n, readR7().types, [3]);
const c = buildBox0Commitment(
  {
    frozenSet: parseFrozenSet(set.frozenSet, n),
    renders: parseRenderHashes(set.renders, n),
    table: parseTraitTable(readR7Json()),
    generator: { tree: set.generatorTree },
  },
  { n },
);
const sealed = sealArchive(c, new Uint8Array(randomBytes(32)), { escrowIntent: 'floor-only' });
const archive = { file: 'box0-records.enc.json', sha256: sealed.sha256, keyId: sealed.header.keyId, escrowIntent: sealed.header.escrowIntent, keySplit: 'none' };

describe('public commitment', () => {
  const pub = publicCommitment(c, archive);
  const text = JSON.stringify(pub);

  it('carries what the spec needs and the archive identity', () => {
    expect(pub).toMatchObject({
      format: 'squarehole.box0-commitment/1',
      n: 13,
      depth: 4,
      root: c.root,
      metadataTable: { hash: c.tableHash, bytes: 3_341, valueOrderHash: c.valueOrderHash },
      generatorHash: c.generatorHash,
      generatorTree: set.generatorTree,
      renderGeneratorTree: set.generatorTree,
      platform: 'darwin-arm64',
      archive: {
        file: 'box0-records.enc.json',
        sha256: sealed.sha256,
        keyId: sealed.header.keyId,
        cipher: 'aes-256-gcm',
        escrowIntent: 'floor-only',
        keySplit: 'none',
      },
    });
    expect(pub.archive).not.toHaveProperty('escrow');
    expect(pub.encoding.image).toEqual({ format: 'webp', size: 512, quality: 90 });
  });

  it('names the generator tree that rendered the files even when generatorHash = 0 (MF-17 answered zero)', () => {
    const zero = publicCommitment({ ...c, generatorHash: `0x${'0'.repeat(64)}`, generatorTree: null }, archive);
    expect(zero.generatorHash).toBe(`0x${'0'.repeat(64)}`);
    expect(zero.generatorTree).toBeNull();
    expect(zero.renderGeneratorTree).toBe(set.generatorTree);
  });

  it('holds no salt, file hash, leaf or trait of any id', () => {
    for (const r of c.records) {
      for (const secret of [r.salt, r.imageSha256, r.avatarSha256, r.modelSha256, r.leaf]) expect(text).not.toContain(secret.slice(2));
    }
    expect(text).not.toMatch(/"(salt|imageSha256|avatarSha256|modelSha256|traitsPacked|attributes)"/);
  });

  it('refuses a trustee public commitment without a verified trustee split, and the shamir-2-of-3 label without one', () => {
    const trustee = { ...archive, escrowIntent: 'trustees-2-of-3' as const };
    expect(() => publicCommitment(c, trustee)).toThrow(/trustee escrow needs key split shamir-2-of-3/);
    const label = { ...trustee, keySplit: 'shamir-2-of-3' };
    expect(() => publicCommitment(c, label)).toThrow(/a shamir-2-of-3 key split needs the receipt of a verified trustee split/);
    const forged = { scheme: 'shamir-2-of-3', note: 'verified', keyId: archive.keyId, archiveSha256: archive.sha256 };
    expect(() => publicCommitment(c, { ...label, splitReceipt: forged })).toThrow(/needs the receipt of a verified trustee split/);
    expect(() => publicCommitment(c, { ...archive, keySplit: 'shamir-2-of-3' })).toThrow(/a shamir-2-of-3 split goes only with trustee escrow/);
  });

  it.skipIf(!outsideRepoTemp)('says keySplit shamir-2-of-3 with the verified receipt of this archive only', async () => {
    const ws = workspaces('box0-outputs');
    try {
      const key = new Uint8Array(randomBytes(32));
      const trusteeSealed = sealArchive(c, key, { escrowIntent: 'trustees-2-of-3' });
      const dir = ws.make();
      const splitter = new TrusteeKeySplit({ destinations: [1, 2, 3].map((t) => join(dir, `trustee-${t}`)), exportDir: join(dir, 'out') });
      const splitReceipt = await splitter.split(key, { archiveSha256: trusteeSealed.sha256, keyId: trusteeSealed.header.keyId, escrowIntent: 'trustees-2-of-3', archiveText: trusteeSealed.text });
      const info = { file: 'box0-records.enc.json', sha256: trusteeSealed.sha256, keyId: trusteeSealed.header.keyId, escrowIntent: 'trustees-2-of-3' as const, keySplit: 'shamir-2-of-3', splitReceipt };
      expect(publicCommitment(c, info).archive).toMatchObject({ escrowIntent: 'trustees-2-of-3', keySplit: 'shamir-2-of-3', keyId: trusteeSealed.header.keyId });
      expect(() => publicCommitment(c, { ...info, sha256: sealed.sha256 })).toThrow(/the trustee split receipt is for another archive/);
      expect(() => publicCommitment(c, { ...info, keyId: sealed.header.keyId })).toThrow(/the trustee split receipt is for another archive/);
    } finally {
      ws.trash();
    }
  });

  it('refuses a test-salt commitment', () => {
    const test = { ...c, testSalts: true };
    expect(() => publicCommitment(test, archive)).toThrow(/test salts never make a public commitment/);
  });
});

describe('proofs file', () => {
  const file = proofsFile(c);
  const text = JSON.stringify(file);

  it('lists every id with its leaf and its depth siblings', () => {
    expect(file.format).toBe('squarehole.box0-proofs/1');
    expect(file.root).toBe(c.root);
    expect(file.proofs).toHaveLength(n);
    file.proofs.forEach((p, i) => {
      expect(p.id).toBe(i + 1);
      expect(p.leaf).toBe(c.records[i]?.leaf);
      expect(p.proof).toEqual(c.proof(i + 1));
    });
  });

  it('holds no salt and no file hash', () => {
    for (const r of c.records) {
      for (const secret of [r.salt, r.imageSha256, r.avatarSha256, r.modelSha256]) expect(text).not.toContain(secret.slice(2));
    }
  });
});
