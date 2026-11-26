/**
 * What box 0's exporter refuses as a stand-in: the public TEST commitments of this repository (their roots, generator
 * hashes and tables), and per-file hashes that are zero, one repeated byte, the empty file's, or any test set's or
 * fixture's "file" hash at any id. A real file's sha256 meets none of these except by a 2^-200-odd chance.
 *
 * Roots: the Sepolia box 0 test set (DeployCoreV1 refuses it on mainnet, `TestCommitmentRefused`), box 0's BoxSpec
 * fixture (packages/box-spec/fixtures/box-0-misfits.json, keccak256 of its FIXTURE text), v2's commitment vectors and
 * v2's Sepolia test set. placeholders.test.ts checks every constant against the file that holds it.
 */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import type { Hex32 } from '../hash';
import { FIXTURE_GENERATOR_TREE, generatorHashFromGitTree, glbSha256, placeholderGlb, sha256Hex } from '../misfits-commitment';

export const KNOWN_TEST_ROOTS = {
  /** packages/contracts/test/vectors/box/sepolia-box0-test-set.json (script/lib/SepoliaBox0TestSet.sol). */
  sepoliaBox0TestSet: '0xf983840bf08a7deb54c03a65382418390b9cdc259e2152a01d56d340ca3679ec',
  /** packages/box-spec/fixtures/box-0-misfits.json revealRoot (keccakOfText "FIXTURE box 0 revealRoot: ..."). */
  box0Fixture: '0x3d88f4cc193a1debaa14062d0866edba43dd836564dcb36f2234517b98fa922d',
  /** packages/contracts/test/vectors/misfits-commitment.json (v2 fixture, 4,200 leaves). */
  v2MisfitsFixture: '0x96ab1aa34dca451e37eb23c6f4010ae2c3d8546868120b79abbee6913654614a',
  /** packages/contracts/test/vectors/sepolia-test-set.json (v2 Sepolia rehearsal). */
  v2SepoliaTestSet: '0xfe3ba00e7949b9bed0fb17f7af5e0e101b581ec6d328bf0dec0330bba08842fc',
  /** packages/contracts/test/vectors/box/box0-commitment-export.json (fixed test salts). */
  box0ExporterSmall: '0xdfc000d2ce029fc889fb15f05384153d543afc63a3a60a22e302ee11bcb0979f',
  box0ExporterFull: '0xfdbae7713f2c54f1f75970cddee81cf4fb1ef9d17c69255b85b90fe34e6c26fc',
} as const satisfies Record<string, Hex32>;

export const KNOWN_TEST_GENERATOR_HASHES = {
  /** FIXTURE_GENERATOR_TREE, a prototype tree id (box 0's fixture and v2's vectors). */
  fixtureTree: generatorHashFromGitTree(FIXTURE_GENERATOR_TREE),
  /** keccak256("sepolia-core-v1.box0-test-set/1: no generator (test data)"). */
  sepoliaBox0TestSet: '0x328f60269102b38166998b931526ce934f7876ee07c549e2949bf59278db9a2b',
  /** keccak256("sepolia-full.test-set/1: no generator (test data)"). */
  v2SepoliaTestSet: '0xb2bef4c106e7a62014645962d428e333da58b8eff38557696e8190a29b88950a',
  /** packages/artwork/src/test-support/box0-export.ts TEST_GENERATOR_TREE (a public label). */
  box0Exporter: '0x31349e9b3d9338f711f34c6a3acebc4b758707c5000000000000000000000000',
} as const satisfies Record<string, Hex32>;

/** keccak256 of each test commitment's metadata table bytes. */
export const KNOWN_TEST_TABLE_HASHES = {
  sepoliaBox0NeutralTwin: '0x74133bce98ccde702e998fb1f169d7cca4e5e45b7ec6b8c6f3f8266eaae15bd5',
  box0FixtureStandIn: '0xf717502016660d406186cb310eb8f763a5189d127f8176a3b48ba1aa60738c39',
  v2MisfitsFixture: '0xf8182d3a709a6e7db37bf3a2760c4f6722890e7a05c09db410cb8b6eb969fd49',
  v2SepoliaTestSet: '0x365fa7aa85416e76e2fcdba1bc1b5ae4bd212a9d2d77317bb457eee229257fa2',
} as const satisfies Record<string, Hex32>;

export const EMPTY_FILE_SHA256: Hex32 = '0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ZERO: Hex32 = `0x${'0'.repeat(64)}`;

function nameOf(table: Record<string, string>, value: string): string | undefined {
  const lower = value.toLowerCase();
  return Object.entries(table).find(([, v]) => v === lower)?.[0];
}

export function assertNotTestRoot(root: Hex32): void {
  const name = root.toLowerCase() === ZERO ? 'zero' : nameOf(KNOWN_TEST_ROOTS, root);
  if (name) throw new Error(`the root ${root} is a test or placeholder root (${name})`);
}

/** `what` names the value in the error (default: the generator hash itself). */
export function assertNotTestGenerator(generatorHash: Hex32, what = `the generator hash ${generatorHash}`): void {
  const name = nameOf(KNOWN_TEST_GENERATOR_HASHES, generatorHash);
  if (name) throw new Error(`${what} is a stand-in generator hash (${name}); MF-17's default is the sealed release tree id`);
}

export function assertNotTestTable(tableHash: Hex32): void {
  const name = nameOf(KNOWN_TEST_TABLE_HASHES, tableHash);
  if (name) throw new Error(`the trait table ${tableHash} is a test or fixture table (${name})`);
}

const utf8 = (text: string) => new TextEncoder().encode(text);
const word = (value: number) => hexToBytes(value.toString(16).padStart(64, '0'));

/** Words 1-3 (image, avatar, model) of a label-derived test set (SepoliaBox0TestSet.sol, SepoliaTestSet.sol). */
function labelSetHashes(label: string, count: number, into: Set<string>): void {
  const labelHash = keccak_256(utf8(label));
  for (let id = 1; id <= count; id++) {
    const seed = keccak_256(concatBytes(labelHash, word(id)));
    for (let k = 1; k <= 3; k++) into.add(bytesToHex(keccak_256(concatBytes(seed, word(k)))));
  }
}

let testDigests: Set<string> | undefined;
let exporterDigests: Set<string> | undefined;

function exporterFixtureDigests(): Set<string> {
  if (exporterDigests) return exporterDigests;
  const all = new Set<string>();
  for (let id = 1; id <= 4_269; id++) {
    for (const kind of ['image', 'avatar', 'model']) {
      all.add(sha256Hex(utf8(`box0-commitment-export test ${kind} ${id}`)).slice(2));
    }
  }
  exporterDigests = all;
  return all;
}

/** Used only by the explicit fixed-salt fixture builder; production still refuses these digests. */
export function isExporterFixtureDigest(hash: Hex32): boolean {
  return exporterFixtureDigests().has(hash.slice(2).toLowerCase());
}

/** Every "file" hash of the repository's test sets and fixtures, without 0x (built once, about 51,000 hashes). */
function knownTestDigests(): Set<string> {
  if (testDigests) return testDigests;
  const all = new Set<string>(exporterFixtureDigests());
  labelSetHashes('sepolia-core-v1.box0-test-set/1', 4_269, all);
  labelSetHashes('sepolia-full.test-set/1', 4_200, all);
  for (let id = 1; id <= 4_200; id++) {
    all.add(sha256Hex(utf8(`misfit-image-${id}`)).slice(2));
    all.add(sha256Hex(utf8(`misfit-avatar-${id}`)).slice(2));
    all.add(glbSha256(placeholderGlb(id)).slice(2));
  }
  testDigests = all;
  return all;
}

/** Why `hash` is no real file's sha256, or undefined when it may be one. */
export function placeholderReason(hash: Hex32): string | undefined {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('a file hash must be 0x and 64 hex digits');
  const lower = hash.toLowerCase();
  if (lower === ZERO) return 'zero';
  if (/^0x([0-9a-f]{2})\1{31}$/.test(lower)) return 'one repeated byte';
  if (lower === EMPTY_FILE_SHA256) return 'the empty file';
  if (knownTestDigests().has(lower.slice(2))) return 'a test set or fixture hash';
  return undefined;
}
