/**
 * What the exporter refuses as a placeholder: the public test commitments (the Sepolia box 0 test set, box 0's fixture,
 * v2's fixture and Sepolia test set), their generator hashes and tables, and per-file hashes that are zero, one repeated
 * byte, the empty file's, or any test set's or fixture's.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import type { Hex32 } from '../hash';
import { FIXTURE_GENERATOR_TREE, generatorHashFromGitTree, glbSha256, placeholderGlb, sha256Hex } from '../misfits-commitment';
import { TEST_GENERATOR_TREE, readR7, testSet } from '../test-support/box0-export';
import {
  EMPTY_FILE_SHA256,
  KNOWN_TEST_GENERATOR_HASHES,
  KNOWN_TEST_ROOTS,
  KNOWN_TEST_TABLE_HASHES,
  assertNotTestGenerator,
  assertNotTestRoot,
  assertNotTestTable,
  placeholderReason,
} from './placeholders';

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const vector = (name: string) => JSON.parse(read(`../../../contracts/test/vectors/${name}`)) as Record<string, unknown>;
const keccakHex = (hex: string): Hex32 => `0x${bytesToHex(keccak_256(hexToBytes(hex.slice(2))))}`;
const utf8 = (text: string) => new TextEncoder().encode(text);

const sepoliaBox0 = vector('box/sepolia-box0-test-set.json');
const v2Fixture = vector('misfits-commitment.json');
const v2Sepolia = vector('sepolia-test-set.json');
const exporter = vector('box/box0-commitment-export.json') as { generatorHash: Hex32; small: { root: Hex32 }; full: { root: Hex32 } };
/** Box 0's fixture (packages/box-spec/fixtures/box-0-misfits.json), generated into fixtures.v1.ts; BOX_0_MISFITS is first. */
const fixtureTs = read('../../../box-spec/src/generated/fixtures.v1.ts');
const fixtureRoot = /revealRoot: '(0x[0-9a-f]{64})'/.exec(fixtureTs)?.[1] as Hex32;
const fixtureTable = /metadataTable: '(0x[0-9a-f]+)'/.exec(fixtureTs)?.[1] as string;

describe('known test commitments', () => {
  it('lists the roots of every public test commitment, as their files hold them', () => {
    expect(Object.values(KNOWN_TEST_ROOTS).sort()).toEqual(
      [sepoliaBox0.root, v2Fixture.root, v2Sepolia.root, fixtureRoot, exporter.small.root, exporter.full.root].map((r) => (r as string).toLowerCase()).sort(),
    );
    expect(KNOWN_TEST_ROOTS.sepoliaBox0TestSet).toBe('0xf983840bf08a7deb54c03a65382418390b9cdc259e2152a01d56d340ca3679ec');
  });

  it('refuses each of them and the zero root, and takes any other', () => {
    for (const root of [...Object.values(KNOWN_TEST_ROOTS), `0x${'0'.repeat(64)}` as Hex32]) {
      expect(() => assertNotTestRoot(root)).toThrow(/is a test or placeholder root/);
      expect(() => assertNotTestRoot(root.toUpperCase().replace('0X', '0x') as Hex32)).toThrow(/is a test or placeholder root/);
    }
    expect(() => assertNotTestRoot(sha256Hex(utf8('a real root')))).not.toThrow();
  });

  it('refuses the stand-in generator hashes and the test tables', () => {
    const generators = [
      generatorHashFromGitTree(FIXTURE_GENERATOR_TREE),
      sepoliaBox0.generatorHash as Hex32,
      v2Sepolia.generatorHash as Hex32,
      exporter.generatorHash,
    ];
    expect(Object.values(KNOWN_TEST_GENERATOR_HASHES).sort()).toEqual([...generators].sort());
    for (const g of generators) expect(() => assertNotTestGenerator(g)).toThrow(/is a stand-in generator hash/);
    expect(() => assertNotTestGenerator(generatorHashFromGitTree('1'.repeat(39) + '2'))).not.toThrow();
    const tables = [keccakHex(sepoliaBox0.metadataTable as string), keccakHex(fixtureTable), keccakHex(v2Fixture.metadataTable as string), keccakHex(v2Sepolia.metadataTable as string)];
    expect(Object.values(KNOWN_TEST_TABLE_HASHES).sort()).toEqual([...tables].sort());
    for (const t of tables) expect(() => assertNotTestTable(t)).toThrow(/is a test or fixture table/);
  });
});

describe('placeholder file hashes', () => {
  it('names zero, one repeated byte and the empty file', () => {
    expect(EMPTY_FILE_SHA256).toBe(sha256Hex(new Uint8Array()));
    expect(placeholderReason(`0x${'0'.repeat(64)}`)).toBe('zero');
    expect(placeholderReason(`0x${'ab'.repeat(32)}`)).toBe('one repeated byte');
    expect(placeholderReason(EMPTY_FILE_SHA256)).toBe('the empty file');
  });

  it('finds every test set and fixture hash, at any id', () => {
    const samples = sepoliaBox0.samples as { imageSha256: Hex32; avatarSha256: Hex32; modelSha256: Hex32 }[];
    for (const s of samples) {
      for (const h of [s.imageSha256, s.avatarSha256, s.modelSha256]) expect(placeholderReason(h)).toBe('a test set or fixture hash');
    }
    const v2Samples = v2Sepolia.samples as { imageSha256: Hex32; modelSha256: Hex32 }[];
    for (const s of v2Samples) expect(placeholderReason(s.imageSha256)).toBe('a test set or fixture hash');
    expect(placeholderReason(sha256Hex(utf8('misfit-image-7')))).toBe('a test set or fixture hash');
    expect(placeholderReason(sha256Hex(utf8('misfit-avatar-4200')))).toBe('a test set or fixture hash');
    expect(placeholderReason(glbSha256(placeholderGlb(123)))).toBe('a test set or fixture hash');
  });

  it('passes a real-looking digest, in any case', () => {
    const real = sha256Hex(utf8('a real WebP picture'));
    expect(placeholderReason(real)).toBeUndefined();
    expect(placeholderReason(`0x${real.slice(2).toUpperCase()}`)).toBeUndefined();
  });
});

describe('exporter fixtures are never production inputs', () => {
  it('refuses both committed exporter roots and its label-derived generator', () => {
    expect(exporter.generatorHash).toBe(generatorHashFromGitTree(TEST_GENERATOR_TREE));
    expect(() => assertNotTestRoot(exporter.small.root)).toThrow(/test or placeholder root/);
    expect(() => assertNotTestRoot(exporter.full.root)).toThrow(/test or placeholder root/);
    expect(() => assertNotTestGenerator(exporter.generatorHash)).toThrow(/stand-in generator/);
  });

  it('refuses every image, avatar and model digest in the 4,269-item exporter fixture, including uppercase', () => {
    const set = testSet(4_269, readR7().types);
    for (const record of set.records) {
      for (const file of [record.image, record.avatar, record.model]) {
        if (!file) throw new Error('the fixture needs all three files');
        expect(placeholderReason(file.sha256 as Hex32), `fixture file of id ${record.id}`).toBe('a test set or fixture hash');
        expect(placeholderReason(`0x${file.sha256.slice(2).toUpperCase()}`)).toBe('a test set or fixture hash');
      }
    }
  });
});
