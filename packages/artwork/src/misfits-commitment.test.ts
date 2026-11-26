/**
 * The Misfits commitment builder (v2 T08; acceptance LCH-08, SEL-01, REV-17 through the Solidity side; F29 the 3D model
 * in every leaf): leaf encoding, fixed-depth index-directed Merkle proofs, raw-codec CIDv1, the GLB check, the
 * generator hash and the metadata table, plus the cross-language vector file that
 * packages/contracts/test/v2/MisfitsCollectionVectors.t.sol replays against the contract.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { describe, expect, it } from 'vitest';
import {
  FIXTURE_GENERATOR_TREE,
  FIXTURE_TABLE,
  MAX_RAW_BLOCK_BYTES,
  MISFITS_COUNT,
  MISFITS_MAX_GENESIS_TABLE_BYTES,
  MISFITS_TREE_DEPTH,
  base32Lower,
  buildMisfitsTree,
  encodeLeafPreimage,
  encodeMetadataTable,
  generatorHashFromGitTree,
  glbSha256,
  misfitLeaf,
  misfitsCommitmentVectors,
  misfitsFixtureEntries,
  packTraits,
  placeholderGlb,
  rawCidV1,
  sha256Hex,
  unpackTraits,
  verifyMisfitProof,
  type MisfitEntry,
} from './misfits-commitment';

const utf8 = (text: string) => new TextEncoder().encode(text);
const VECTOR_FILE = fileURLToPath(new URL('../../contracts/test/vectors/misfits-commitment.json', import.meta.url));

const entry = (overrides: Partial<MisfitEntry> = {}): MisfitEntry => ({
  id: 42,
  traitsPacked: packTraits([1, 2, 3, 0, 5, 6]),
  imageSha256: sha256Hex(utf8('image 42')),
  avatarSha256: sha256Hex(utf8('avatar 42')),
  modelSha256: sha256Hex(utf8('model 42')),
  salt: `0x${'ab'.repeat(32)}`,
  ...overrides,
});

describe('raw-codec CIDv1 (hosting research Proposal A)', () => {
  it('matches the CID the research checked against four gateways for "hello world"', () => {
    // docs/research/low-cost-hosting.md § 3.1 (branch research-hosting): Pinata, Filebase, 4EVERLAND and
    // trustless-gateway.link each returned "hello world" for this CID.
    const digest = sha256Hex(utf8('hello world'));
    expect(digest).toBe('0xb94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
    expect(rawCidV1(digest)).toBe('bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e');
  });

  it('is "b" + RFC 4648 base32 (lower case, no padding) of 0x01 0x55 0x12 0x20 and the digest', () => {
    // RFC 4648 § 10 test vectors, lower-cased and unpadded (multibase "b").
    const cases: [string, string][] = [
      ['', ''],
      ['f', 'my'],
      ['fo', 'mzxq'],
      ['foo', 'mzxw6'],
      ['foob', 'mzxw6yq'],
      ['fooba', 'mzxw6ytb'],
      ['foobar', 'mzxw6ytboi'],
    ];
    for (const [input, expected] of cases) expect(base32Lower(utf8(input))).toBe(expected);
    const cid = rawCidV1(`0x${'00'.repeat(32)}`);
    expect(cid).toHaveLength(59);
    expect(cid.startsWith('bafkrei')).toBe(true);
  });

  it('refuses a digest that is not 32 bytes', () => {
    expect(() => rawCidV1('0x1234')).toThrow(/32-byte/);
  });
});

describe('leaf encoding', () => {
  it('is abi.encode(uint256 id, uint128 traits, bytes32 image, bytes32 avatar, bytes32 model, bytes32 salt): six words', () => {
    const e = entry();
    const pre = encodeLeafPreimage(e);
    expect(pre).toHaveLength(192);
    expect(pre[31]).toBe(42);
    expect(Array.from(pre.slice(0, 31)).every((b) => b === 0)).toBe(true);
    // traitsPacked sits right-aligned in the second word (uint128 pads like uint256 in abi.encode).
    expect(pre[63]).toBe(1);
    expect(pre[62]).toBe(2);
    expect(pre[58]).toBe(6);
    // F29: the model's sha256 is the fifth word, between the avatar and the salt.
    expect(`0x${Buffer.from(pre.slice(64, 96)).toString('hex')}`).toBe(e.imageSha256);
    expect(`0x${Buffer.from(pre.slice(96, 128)).toString('hex')}`).toBe(e.avatarSha256);
    expect(`0x${Buffer.from(pre.slice(128, 160)).toString('hex')}`).toBe(e.modelSha256);
    expect(`0x${Buffer.from(pre.slice(160, 192)).toString('hex')}`).toBe(e.salt);
  });

  it('binds every field: changing any one changes the leaf', () => {
    const base = misfitLeaf(entry());
    expect(misfitLeaf(entry({ id: 43 }))).not.toBe(base);
    expect(misfitLeaf(entry({ traitsPacked: packTraits([1, 2, 3, 0, 5, 7]) }))).not.toBe(base);
    expect(misfitLeaf(entry({ imageSha256: sha256Hex(utf8('other')) }))).not.toBe(base);
    expect(misfitLeaf(entry({ avatarSha256: sha256Hex(utf8('other')) }))).not.toBe(base);
    expect(misfitLeaf(entry({ modelSha256: sha256Hex(utf8('other')) }))).not.toBe(base);
    expect(misfitLeaf(entry({ salt: `0x${'ac'.repeat(32)}` }))).not.toBe(base);
    // Swapping the picture and the model changes the leaf too (the fields are positional).
    const e = entry();
    expect(misfitLeaf({ ...e, imageSha256: e.modelSha256, modelSha256: e.imageSha256 })).not.toBe(base);
  });

  it('refuses ids outside 1..4,200 and traits above 128 bits', () => {
    expect(() => misfitLeaf(entry({ id: 0 }))).toThrow(/id/);
    expect(() => misfitLeaf(entry({ id: MISFITS_COUNT + 1 }))).toThrow(/id/);
    expect(() => misfitLeaf(entry({ traitsPacked: 1n << 128n }))).toThrow(/128/);
    expect(() => misfitLeaf(entry({ salt: '0x12' }))).toThrow(/32-byte/);
    expect(() => misfitLeaf(entry({ modelSha256: '0x12' }))).toThrow(/modelSha256/);
  });

  it('refuses a zero picture or model digest, which would commit a dead on-chain link (review fix)', () => {
    const zero = `0x${'00'.repeat(32)}` as const;
    expect(() => misfitLeaf(entry({ imageSha256: zero }))).toThrow(/imageSha256 must not be zero/);
    expect(() => misfitLeaf(entry({ modelSha256: zero }))).toThrow(/modelSha256 must not be zero/);
    // The avatar is only emitted, never linked by tokenURI, and the salt is not a file digest: both stay free.
    expect(misfitLeaf(entry({ avatarSha256: zero }))).toMatch(/^0x[0-9a-f]{64}$/);
    expect(misfitLeaf(entry({ salt: zero }))).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

/** A GLB container around one JSON chunk (the header fields are overridable to build broken files). */
function glb(
  json: string,
  over: { magic?: number; version?: number; length?: number; chunkLength?: number; chunkType?: number } = {},
) {
  const text = utf8(json);
  const padded = new Uint8Array(Math.ceil(text.length / 4) * 4).fill(0x20);
  padded.set(text);
  const out = new Uint8Array(20 + padded.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, over.magic ?? 0x46546c67, true);
  view.setUint32(4, over.version ?? 2, true);
  view.setUint32(8, over.length ?? out.length, true);
  view.setUint32(12, over.chunkLength ?? padded.length, true);
  view.setUint32(16, over.chunkType ?? 0x4e4f534a, true);
  out.set(padded, 20);
  return out;
}

describe('3D model (F29): GLB checks and the model hash', () => {
  const asset = '{"asset":{"version":"2.0"}}';

  it('hashes a valid binary glTF 2.0 file with sha256, the digest its raw CID is built from', () => {
    const file = glb(asset);
    expect(glbSha256(file)).toBe(sha256Hex(file));
    expect(rawCidV1(glbSha256(file))).toMatch(/^bafkrei[a-z2-7]{52}$/);
  });

  it('refuses files that are not a GLB 2.0 container', () => {
    expect(() => glbSha256(new Uint8Array(0))).toThrow(/GLB/);
    expect(() => glbSha256(glb(asset, { magic: 0x12345678 }))).toThrow(/magic/);
    expect(() => glbSha256(glb(asset, { version: 1 }))).toThrow(/version 2/);
    expect(() => glbSha256(glb(asset, { length: 999 }))).toThrow(/length/);
    expect(() => glbSha256(glb(asset, { chunkType: 0x004e4942 }))).toThrow(/JSON chunk/);
    expect(() => glbSha256(glb('{"asset":{"version":"1.0"}}'))).toThrow(/2\.0/);
    expect(() => glbSha256(glb('not json'))).toThrow(/JSON/);
    // The JSON chunk's own length: not 4-byte aligned, or running past the end of the file (review fix: untested).
    const fits = glb(asset).length - 20;
    expect(() => glbSha256(glb(asset, { chunkLength: fits - 1 }))).toThrow(/4-byte aligned/);
    expect(() => glbSha256(glb(asset, { chunkLength: fits + 4 }))).toThrow(/past the end/);
  });

  it('refuses a GLB that fetches a buffer or image from another file (review fix: animation_url is one raw block)', () => {
    const withBuffers = (buffers: unknown[]) => glb(JSON.stringify({ asset: { version: '2.0' }, buffers }));
    const withImages = (images: unknown[]) => glb(JSON.stringify({ asset: { version: '2.0' }, images }));
    expect(() => glbSha256(withBuffers([{ byteLength: 4, uri: 'mesh.bin' }]))).toThrow(/self-contained.*mesh\.bin/);
    expect(() => glbSha256(withImages([{ uri: 'https://example.com/skin.png' }]))).toThrow(/self-contained/);
    expect(() => glbSha256(withImages([{ uri: 42 }]))).toThrow(/self-contained/);
    // The GLB's own BIN chunk (a buffer without uri), images in buffer views and data: URIs are self-contained.
    expect(glbSha256(withBuffers([{ byteLength: 4 }]))).toMatch(/^0x[0-9a-f]{64}$/);
    expect(glbSha256(withImages([{ bufferView: 0, mimeType: 'image/png' }]))).toMatch(/^0x[0-9a-f]{64}$/);
    expect(glbSha256(withBuffers([{ byteLength: 4, uri: 'data:application/octet-stream;base64,AAAAAA==' }]))).toMatch(
      /^0x[0-9a-f]{64}$/,
    );
  });

  it('refuses a model above one raw IPFS block (1 MiB), whose raw CID would not resolve', () => {
    expect(MAX_RAW_BLOCK_BYTES).toBe(1_048_576);
    const big = glb(`{"asset":{"version":"2.0"},"extras":{"pad":"${'x'.repeat(MAX_RAW_BLOCK_BYTES)}"}}`);
    expect(big.length).toBeGreaterThan(MAX_RAW_BLOCK_BYTES);
    expect(() => glbSha256(big)).toThrow(/1 MiB/);
    // The cap is inclusive: a file of exactly 1 MiB is still one raw block.
    const prefix = '{"asset":{"version":"2.0"},"extras":{"pad":"';
    const suffix = '"}}';
    const edge = glb(`${prefix}${'x'.repeat(MAX_RAW_BLOCK_BYTES - 20 - prefix.length - suffix.length)}${suffix}`);
    expect(edge.length).toBe(MAX_RAW_BLOCK_BYTES);
    expect(glbSha256(edge)).toBe(sha256Hex(edge));
  });

  it('builds a distinct, valid placeholder GLB per id for the test vectors (not a Misfit model)', () => {
    const one = placeholderGlb(1);
    const two = placeholderGlb(2);
    expect(glbSha256(one)).not.toBe(glbSha256(two));
    expect(one.length % 4).toBe(0);
    const json = JSON.parse(new TextDecoder().decode(one.slice(20)).trimEnd()) as {
      asset: { version: string; generator: string };
      extras: { misfit: number };
    };
    expect(json.asset.version).toBe('2.0');
    expect(json.asset.generator).toMatch(/placeholder/i);
    expect(json.extras.misfit).toBe(1);
    expect(() => placeholderGlb(0)).toThrow(/id/);
  });
});

describe('generator hash (F29): the generator version the collection records', () => {
  it('left-aligns a 20-byte SHA-1 git tree id in bytes32', () => {
    expect(generatorHashFromGitTree('ed1c0b9e00a84189fa476ac6824f2f1b4b13dbdf')).toBe(
      '0xed1c0b9e00a84189fa476ac6824f2f1b4b13dbdf000000000000000000000000',
    );
    expect(generatorHashFromGitTree('ED1C0B9E00A84189FA476AC6824F2F1B4B13DBDF')).toBe(
      generatorHashFromGitTree('ed1c0b9e00a84189fa476ac6824f2f1b4b13dbdf'),
    );
  });

  it('keeps a 32-byte SHA-256 git object id as it is', () => {
    const id = 'ab'.repeat(32);
    expect(generatorHashFromGitTree(id)).toBe(`0x${id}`);
  });

  it('refuses anything else, and the zero id', () => {
    expect(() => generatorHashFromGitTree('')).toThrow(/tree id/);
    expect(() => generatorHashFromGitTree('0xed1c0b9e00a84189fa476ac6824f2f1b4b13dbdf')).toThrow(/tree id/);
    expect(() => generatorHashFromGitTree('ed1c0b9e')).toThrow(/tree id/);
    expect(() => generatorHashFromGitTree('zz'.repeat(20))).toThrow(/tree id/);
    expect(() => generatorHashFromGitTree('0'.repeat(40))).toThrow(/zero/);
  });
});

describe('traits', () => {
  it('packs one byte per trait type, type 0 in the lowest byte, 0 meaning "absent"', () => {
    expect(packTraits([1, 2])).toBe(0x0201n);
    expect(packTraits([0, 0, 7])).toBe(0x070000n);
    expect(unpackTraits(0x070000n, 3)).toEqual([0, 0, 7]);
    expect(() => packTraits([256])).toThrow(/byte/);
    expect(() => packTraits(new Array(17).fill(1))).toThrow(/16/);
  });
});

describe('metadata table (format v1)', () => {
  it('encodes version, description and length-prefixed names', () => {
    const bytes = encodeMetadataTable({ description: 'Hi', traitTypes: [{ name: 'Shape', values: ['Ball', 'Star'] }] });
    expect(Array.from(bytes)).toEqual([
      1, 0, 2, ...utf8('Hi'), 1, 5, ...utf8('Shape'), 2, 4, ...utf8('Ball'), 4, ...utf8('Star'),
    ]);
  });

  it('refuses characters that would need JSON escaping and out-of-range sizes', () => {
    const one = (name: string, values: string[] = ['A']) => ({ description: '', traitTypes: [{ name, values }] });
    expect(() => encodeMetadataTable(one('Bad"quote'))).toThrow(/printable/);
    expect(() => encodeMetadataTable(one('Back\\slash'))).toThrow(/printable/);
    expect(() => encodeMetadataTable(one('Tab\t'))).toThrow(/printable/);
    expect(() => encodeMetadataTable(one('Emoji \u{1F600}'))).toThrow(/printable/);
    expect(() => encodeMetadataTable(one(''))).toThrow(/1 to 255/);
    expect(() => encodeMetadataTable(one('A', []))).toThrow(/1 to 255/);
    expect(() =>
      encodeMetadataTable({ description: '', traitTypes: new Array(17).fill({ name: 'A', values: ['B'] }) }),
    ).toThrow(/16/);
  });

  it('refuses a table larger than a genesis can carry (2,048 bytes; the committed vector has 603)', () => {
    // Version, description length and type count take 4 bytes; the description fills the rest.
    const sized = (n: number) => ({ description: 'a'.repeat(n - 4), traitTypes: [] });
    expect(MISFITS_MAX_GENESIS_TABLE_BYTES).toBe(2_048);
    expect(encodeMetadataTable(sized(MISFITS_MAX_GENESIS_TABLE_BYTES)).length).toBe(2_048);
    expect(() => encodeMetadataTable(sized(MISFITS_MAX_GENESIS_TABLE_BYTES + 1))).toThrow(/at most 2048/);
    expect(encodeMetadataTable(FIXTURE_TABLE).length).toBe(603);
  });
});

describe('Merkle tree: fixed depth 13, index-directed, one leaf per position', () => {
  const entries = misfitsFixtureEntries();
  const tree = buildMisfitsTree(entries.map(misfitLeaf));

  it('has exactly 4,200 committed leaves and 13 siblings per proof (F35)', () => {
    expect(MISFITS_COUNT).toBe(4_200);
    expect(MISFITS_TREE_DEPTH).toBe(13);
    expect(2 ** (MISFITS_TREE_DEPTH - 1) < MISFITS_COUNT && MISFITS_COUNT <= 2 ** MISFITS_TREE_DEPTH).toBe(true);
    expect(entries).toHaveLength(MISFITS_COUNT);
    expect(entries[0]?.id).toBe(1);
    expect(entries.at(-1)?.id).toBe(MISFITS_COUNT);
    expect(tree.proof(1)).toHaveLength(MISFITS_TREE_DEPTH);
  });

  it('verifies every leaf at its own position and nowhere else', () => {
    for (const id of [1, 2, 3, 4, 42, 69, 2_048, 2_049, 4_096, 4_097, 4_199, 4_200]) {
      const e = entries[id - 1] as MisfitEntry;
      const leaf = misfitLeaf(e);
      expect(verifyMisfitProof(id, leaf, tree.proof(id), tree.root)).toBe(true);
      // Position binding twice over: the id is inside the leaf, and the proof path is the id's own.
      expect(verifyMisfitProof(id === 1 ? 2 : id - 1, leaf, tree.proof(id), tree.root)).toBe(false);
    }
  });

  it('rejects a tampered sibling, a short or long proof and the zero padding positions', () => {
    const leaf = misfitLeaf(entries[41] as MisfitEntry);
    const proof = tree.proof(42);
    const tampered = [...proof];
    tampered[5] = `0x${'00'.repeat(31)}01`;
    expect(verifyMisfitProof(42, leaf, tampered, tree.root)).toBe(false);
    expect(verifyMisfitProof(42, leaf, proof.slice(0, 12), tree.root)).toBe(false);
    expect(verifyMisfitProof(42, leaf, [...proof, proof[0] as `0x${string}`], tree.root)).toBe(false);
    expect(() => tree.proof(MISFITS_COUNT + 1)).toThrow(/id/);
    // The id guard: an id above 4,200 is refused before any hashing, whatever the proof.
    expect(verifyMisfitProof(MISFITS_COUNT + 1, leaf, proof, tree.root)).toBe(false);
    expect(verifyMisfitProof(0, leaf, proof, tree.root)).toBe(false);
  });

  it('pads positions 4,201 … 8,192 with bytes32(0): every all-padding subtree is the zero subtree of its height', () => {
    // z0 = bytes32(0), z(k+1) = keccak256(zk ‖ zk): the root of a subtree of height k over padding only.
    const zero: Uint8Array[] = [new Uint8Array(32)];
    for (let k = 0; k < MISFITS_TREE_DEPTH; k++) {
      const z = zero[k] as Uint8Array;
      const both = new Uint8Array(64);
      both.set(z, 0);
      both.set(z, 32);
      zero.push(keccak_256(both));
    }
    const hex = (bytes: Uint8Array) => `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
    // Id 4,200 (index 4,199 = 0b1_0000_0110_0111): at height 3 its sibling covers ids 4,201 … 4,208, all padding.
    expect(tree.proof(4_200)[3]).toBe(hex(zero[3] as Uint8Array));
    // In general: a sibling whose leaves all lie past id 4,200 is the zero subtree of its height, and one that
    // reaches a real leaf is not. For id 4,200 that is heights 3, 4, 7, 8, 9, 10 and 11.
    const paddingHeights: number[] = [];
    for (const id of [4_193, 4_199, 4_200]) {
      const proof = tree.proof(id);
      let index = id - 1;
      for (let height = 0; height < MISFITS_TREE_DEPTH; height++) {
        const firstLeaf = (index ^ 1) * 2 ** height; // index of the sibling subtree's first leaf (0-based)
        const allPadding = firstLeaf >= MISFITS_COUNT;
        const isZero = proof[height] === hex(zero[height] as Uint8Array);
        expect(isZero, `id ${id}, height ${height}`).toBe(allPadding);
        if (id === 4_200 && allPadding) paddingHeights.push(height);
        index >>= 1;
      }
    }
    expect(paddingHeights).toEqual([3, 4, 7, 8, 9, 10, 11]);
  });

  it('refuses a tree that does not hold exactly 4,200 leaves', () => {
    expect(() => buildMisfitsTree([])).toThrow(/4,200/);
  });
});

describe('cross-language vector file (replayed by the Solidity tests)', () => {
  it('matches the committed packages/contracts/test/vectors/misfits-commitment.json', () => {
    const generated = `${JSON.stringify(misfitsCommitmentVectors(), null, 2)}\n`;
    if (process.env.SH_WRITE_VECTORS === '1') writeFileSync(VECTOR_FILE, generated);
    expect(readFileSync(VECTOR_FILE, 'utf8')).toBe(generated);
  });

  it('carries the model file, its hash and CID per entry, and the generator hash (F29)', () => {
    const vectors = misfitsCommitmentVectors();
    expect(vectors.format).toBe('squarehole.misfits-commitment-vectors/2');
    expect(vectors.generator.gitTreeId).toBe(`0x${FIXTURE_GENERATOR_TREE}`);
    expect(vectors.generator.generatorHash).toBe(generatorHashFromGitTree(FIXTURE_GENERATOR_TREE));
    for (const e of vectors.entries) {
      const bytes = Uint8Array.from(Buffer.from(e.modelGlb.slice(2), 'hex'));
      expect(glbSha256(bytes)).toBe(e.modelSha256);
      expect(e.modelCid).toBe(rawCidV1(e.modelSha256));
      expect(e.modelCid).not.toBe(e.imageCid);
      expect(verifyMisfitProof(e.id, e.leaf, e.proof, vectors.root)).toBe(true);
    }
  });
});
