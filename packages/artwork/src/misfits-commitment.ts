/**
 * Off-chain side of The Misfits commitment (v2 T08; hosting research Proposal A; ADR-0013 § 2.4 with the T08 leaf;
 * F29: the 3D model is part of every Misfit NFT). It mirrors packages/contracts/src/v2/MisfitsCollection.sol exactly:
 *
 * - leaf = keccak256(abi.encode(uint256 id, uint128 traitsPacked, bytes32 imageSha256, bytes32 avatarSha256,
 *   bytes32 modelSha256, bytes32 salt)); the id is inside the leaf, so a leaf is bound to its token number, and the
 *   model (a binary glTF 2.0 file, GLB) is committed with the pictures;
 * - a plain binary Merkle tree of fixed depth 13 over positions id − 1 (exactly 4,200 leaves, padded to 8,192 with
 *   bytes32(0)), node = keccak256(left ‖ right), proofs verified index-directed. The fixed depth and the index path
 *   leave exactly one committed leaf per id, so the committer cannot keep two alternatives for one number;
 * - image = "ipfs://" + CIDv1(raw codec 0x55, sha2-256 multihash 0x12 0x20, digest), multibase "b" (RFC 4648 base32,
 *   lower case, no padding); animation_url is the same for the model's GLB. Each file must be stored as one raw
 *   block (at most MAX_RAW_BLOCK_BYTES), or its raw CID does not resolve; `glbSha256` checks a model before commit;
 * - generatorHash (contract constructor, contractURI "generator_hash"): the generator version that rebuilds a model
 *   from its traits, by convention the root tree id of the release commit, left-aligned (`generatorHashFromGitTree`):
 *   scripts/nft/edition imports scene and library code outside its folder and three.js through pnpm-lock.yaml, so
 *   only the whole tree pins the generator;
 * - traitsPacked: one byte per trait type (type i in bits 8i..8i+7, at most 16 types); 0 = attribute absent, v ≥ 1 =
 *   the v-th name of that type in the metadata table;
 * - metadata table v1: 0x01, uint16 description length (big-endian), description, uint8 type count, then per type
 *   uint8 name length, name, uint8 value count, per value uint8 length and bytes. Every string is printable ASCII
 *   without '"' or '\', so the contract can place it in JSON without escaping.
 *
 * The fixture generator below is deterministic test data only. Real salts are 32 CSPRNG bytes each and the real
 * assignment of art to numbers is an offline step of the reveal pipeline (ADR-0013 § 2.4, hosting research § 6).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import type { Hex32 } from './hash';

/** The edition size N (F35: 4,200 in total; `MisfitsCollection.MISFITS_COUNT`). */
export const MISFITS_COUNT = 4_200;
/** ⌈log₂ 4,200⌉ = 13 (`MisfitsCollection.TREE_DEPTH`). */
export const MISFITS_TREE_DEPTH = 13;
export const MISFITS_MAX_TRAIT_TYPES = 16;
export const MISFITS_TABLE_VERSION = 1;
/**
 * The largest metadata table a genesis may carry (`GenesisPlanning.MAX_METADATA_TABLE_BYTES`; security review
 * 2026-09-30). The table is deployed inside the genesis transaction at about 559 gas a byte, and 2,048 bytes keep that
 * transaction more than 1,000,000 gas under EIP-7825's 16,777,216. The on-chain format alone accepts 24,575 bytes.
 */
export const MISFITS_MAX_GENESIS_TABLE_BYTES = 2_048;
/**
 * The largest file stored as one raw IPFS block, so that its CID is the raw CIDv1 of its sha256: 1 MiB, the largest
 * chunk `ipfs add` accepts and the block size IPFS peers are expected to exchange. Larger files are chunked into a
 * UnixFS DAG whose CID differs from the committed hash.
 */
export const MAX_RAW_BLOCK_BYTES = 1_048_576;
const LEAF_SLOTS = 1 << MISFITS_TREE_DEPTH;
const GLB_MAGIC = 0x46546c67; // "glTF", little-endian
const GLB_CHUNK_JSON = 0x4e4f534a; // "JSON", little-endian
const GLB_HEADER_BYTES = 12;
const GLB_CHUNK_HEADER_BYTES = 8;
const RAW_CID_PREFIX = Uint8Array.of(0x01, 0x55, 0x12, 0x20);
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const ZERO32 = new Uint8Array(32);

export interface MisfitEntry {
  /** Token number, 1..4,200. */
  readonly id: number;
  /** One byte per trait type, below 2^128. */
  readonly traitsPacked: bigint;
  readonly imageSha256: Hex32;
  readonly avatarSha256: Hex32;
  /** sha256 of the Misfit's 3D model, a GLB (F29); see `glbSha256`. */
  readonly modelSha256: Hex32;
  readonly salt: Hex32;
}

export interface MetadataTable {
  readonly description: string;
  readonly traitTypes: readonly { readonly name: string; readonly values: readonly string[] }[];
}

export interface MisfitsTree {
  readonly root: Hex32;
  /** The 13 siblings from the leaf upwards. */
  proof(id: number): Hex32[];
}

const toHex = (bytes: Uint8Array): Hex32 => `0x${bytesToHex(bytes)}`;

function bytes32(value: Hex32, what: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${what} must be a 32-byte hex string`);
  return hexToBytes(value.slice(2));
}

function checkId(id: number): void {
  if (!Number.isInteger(id) || id < 1 || id > MISFITS_COUNT) throw new Error(`id ${id} is outside 1..${MISFITS_COUNT}`);
}

function word(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let rest = value;
  for (let i = 31; i >= 0 && rest > 0n; i--) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

export function sha256Hex(bytes: Uint8Array): Hex32 {
  return toHex(sha256(bytes));
}

/**
 * A file digest the contract turns into an on-chain link (image, animation_url). The zero word is never the sha256 of
 * a real file, only a missing one; once committed it would be a dead link for that id forever, so it is refused here.
 */
function linkDigest(value: Hex32, what: string): Uint8Array {
  const bytes = bytes32(value, what);
  if (bytes.every((b) => b === 0)) throw new Error(`${what} must not be zero (a missing file)`);
  return bytes;
}

/**
 * abi.encode(uint256 id, uint128 traitsPacked, bytes32 imageSha256, bytes32 avatarSha256, bytes32 modelSha256,
 * bytes32 salt): six 32-byte words. A zero imageSha256 or modelSha256 is refused (see `linkDigest`).
 */
export function encodeLeafPreimage(entry: MisfitEntry): Uint8Array {
  checkId(entry.id);
  if (entry.traitsPacked < 0n || entry.traitsPacked >= 1n << 128n) throw new Error('traitsPacked must fit in 128 bits');
  return concatBytes(
    word(BigInt(entry.id)),
    word(entry.traitsPacked),
    linkDigest(entry.imageSha256, 'imageSha256'),
    bytes32(entry.avatarSha256, 'avatarSha256'),
    linkDigest(entry.modelSha256, 'modelSha256'),
    bytes32(entry.salt, 'salt'),
  );
}

export function misfitLeaf(entry: MisfitEntry): Hex32 {
  return toHex(keccak_256(encodeLeafPreimage(entry)));
}

const hashPair = (left: Uint8Array, right: Uint8Array) => keccak_256(concatBytes(left, right));

/** Builds the fixed-depth tree over exactly 4,200 leaves (index = id − 1), padded with bytes32(0). */
export function buildMisfitsTree(leaves: readonly Hex32[]): MisfitsTree {
  if (leaves.length !== MISFITS_COUNT) throw new Error(`the tree needs exactly ${MISFITS_COUNT.toLocaleString('en-US')} leaves, got ${leaves.length}`);
  const layers: Uint8Array[][] = [];
  let level: Uint8Array[] = Array.from({ length: LEAF_SLOTS }, (_, i) =>
    i < leaves.length ? bytes32(leaves[i] as Hex32, `leaf ${i + 1}`) : ZERO32,
  );
  layers.push(level);
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(hashPair(level[i] as Uint8Array, level[i + 1] as Uint8Array));
    layers.push(next);
    level = next;
  }
  return {
    root: toHex(level[0] as Uint8Array),
    proof(id: number): Hex32[] {
      checkId(id);
      let index = id - 1;
      const siblings: Hex32[] = [];
      for (let depth = 0; depth < MISFITS_TREE_DEPTH; depth++) {
        siblings.push(toHex((layers[depth] as Uint8Array[])[index ^ 1] as Uint8Array));
        index >>= 1;
      }
      return siblings;
    },
  };
}

/** The contract's check: exactly 13 siblings, combined left or right by the bits of id − 1. */
export function verifyMisfitProof(id: number, leaf: Hex32, proof: readonly Hex32[], root: Hex32): boolean {
  if (!Number.isInteger(id) || id < 1 || id > MISFITS_COUNT || proof.length !== MISFITS_TREE_DEPTH) return false;
  let node = bytes32(leaf, 'leaf');
  let index = id - 1;
  for (const sibling of proof) {
    const s = bytes32(sibling, 'sibling');
    node = index & 1 ? hashPair(s, node) : hashPair(node, s);
    index >>= 1;
  }
  return toHex(node) === root.toLowerCase();
}

/** RFC 4648 base32 alphabet, lower case, no padding (multibase "b"). */
export function base32Lower(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

/** CIDv1, raw codec, sha2-256: "b" + base32(0x01 0x55 0x12 0x20 ‖ digest). */
export function rawCidV1(sha256Digest: Hex32): string {
  return `b${base32Lower(concatBytes(RAW_CID_PREFIX, bytes32(sha256Digest, 'the digest')))}`;
}

/**
 * Checks that `glb` is a binary glTF 2.0 container small enough for one raw IPFS block and returns its sha256, the
 * value a leaf commits as modelSha256 (F29). Checked: the 12-byte header ("glTF", version 2, declared length = file
 * length, a multiple of 4), a first chunk of type JSON inside the file, 4-byte aligned, whose text parses with
 * asset.version "2.0", no buffer or image fetched from another file (the link is one raw block with no directory
 * around it, so a relative or remote `uri` would not load through animation_url; `data:` URIs are self-contained),
 * and the size cap MAX_RAW_BLOCK_BYTES. The model's content (meshes, the eight slot anchors) is the generator's to
 * test.
 */
export function glbSha256(glb: Uint8Array): Hex32 {
  if (glb.length < GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES) throw new Error('a GLB needs a header and a JSON chunk');
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('not a GLB: the magic is not "glTF"');
  if (view.getUint32(4, true) !== 2) throw new Error('only GLB version 2 (glTF 2.0) is accepted');
  if (view.getUint32(8, true) !== glb.length || glb.length % 4 !== 0) {
    throw new Error('the GLB header length must equal the file length, a multiple of 4');
  }
  if (glb.length > MAX_RAW_BLOCK_BYTES) {
    throw new Error(`the model is ${glb.length} bytes; one raw IPFS block holds at most 1 MiB (${MAX_RAW_BLOCK_BYTES})`);
  }
  const jsonLength = view.getUint32(GLB_HEADER_BYTES, true);
  const jsonStart = GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES;
  if (view.getUint32(GLB_HEADER_BYTES + 4, true) !== GLB_CHUNK_JSON || jsonLength % 4 !== 0) {
    throw new Error('the first GLB chunk must be the JSON chunk, 4-byte aligned');
  }
  if (jsonStart + jsonLength > glb.length) throw new Error('the JSON chunk runs past the end of the GLB');
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(glb.subarray(jsonStart, jsonStart + jsonLength)));
  } catch {
    throw new Error('the GLB JSON chunk is not valid JSON');
  }
  const version = (json as { asset?: { version?: unknown } } | null)?.asset?.version;
  if (version !== '2.0') throw new Error('the GLB JSON must declare asset.version "2.0"');
  const external = externalUri(json as GltfResources);
  if (external !== undefined) throw new Error(`the GLB must be self-contained; it references "${external}"`);
  return sha256Hex(glb);
}

type GltfResources = { readonly buffers?: unknown; readonly images?: unknown };

/** The first buffer or image `uri` that is not a `data:` URI (an external file), if any. */
function externalUri(json: GltfResources): string | undefined {
  for (const list of [json.buffers, json.images]) {
    if (!Array.isArray(list)) continue;
    for (const item of list as unknown[]) {
      const uri = (item as { uri?: unknown } | null)?.uri;
      if (uri !== undefined && !(typeof uri === 'string' && uri.startsWith('data:'))) return String(uri);
    }
  }
  return undefined;
}

/**
 * The contract's generatorHash from a git tree id, by convention the release commit's root tree (`git rev-parse
 * <release commit>^{tree}`; the tree of scripts/nft/edition alone misses the shared scene code, scripts/nft/lib and
 * the lockfile): a 40-hex SHA-1 id left-aligned in bytes32 (the low 12 bytes zero), or a 64-hex SHA-256 id as it
 * is. Lower-case output.
 */
export function generatorHashFromGitTree(treeId: string): Hex32 {
  if (!/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(treeId)) {
    throw new Error('a git tree id is 40 (SHA-1) or 64 (SHA-256) hex digits without 0x');
  }
  if (/^0+$/.test(treeId)) throw new Error('the generator hash must not be zero');
  return `0x${treeId.toLowerCase().padEnd(64, '0')}`;
}

export function packTraits(indices: readonly number[]): bigint {
  if (indices.length > MISFITS_MAX_TRAIT_TYPES) throw new Error('at most 16 trait types fit in traitsPacked');
  return indices.reduce((packed, value, i) => {
    if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error(`trait ${i} must be one byte`);
    return packed | (BigInt(value) << BigInt(8 * i));
  }, 0n);
}

export function unpackTraits(traitsPacked: bigint, typeCount: number): number[] {
  return Array.from({ length: typeCount }, (_, i) => Number((traitsPacked >> BigInt(8 * i)) & 0xffn));
}

function tableString(text: string, what: string, maxLength: number, minLength: number): Uint8Array {
  if (!/^[\x20-\x7e]*$/.test(text) || /["\\]/.test(text)) {
    throw new Error(`${what} must be printable ASCII without '"' or '\\'`);
  }
  const bytes = new TextEncoder().encode(text);
  if (bytes.length < minLength || bytes.length > maxLength) {
    throw new Error(`${what} must be ${minLength} to ${maxLength} bytes`);
  }
  return bytes;
}

/**
 * The metadata table v1 bytes. `maxBytes` defaults to the genesis budget (`MISFITS_MAX_GENESIS_TABLE_BYTES`); another
 * creator's box passes the on-chain limit (box-commitment.ts `encodeBoxMetadataTable`).
 */
export function encodeMetadataTable(table: MetadataTable, maxBytes: number = MISFITS_MAX_GENESIS_TABLE_BYTES): Uint8Array {
  if (table.traitTypes.length > MISFITS_MAX_TRAIT_TYPES) throw new Error('at most 16 trait types');
  const description = tableString(table.description, 'the description', 0xffff, 0);
  const parts: Uint8Array[] = [
    Uint8Array.of(MISFITS_TABLE_VERSION, description.length >> 8, description.length & 0xff),
    description,
    Uint8Array.of(table.traitTypes.length),
  ];
  for (const [t, type] of table.traitTypes.entries()) {
    const name = tableString(type.name, `trait type ${t}`, 255, 1);
    if (type.values.length < 1 || type.values.length > 255) throw new Error(`trait type ${t} needs 1 to 255 values`);
    parts.push(Uint8Array.of(name.length), name, Uint8Array.of(type.values.length));
    for (const [v, value] of type.values.entries()) {
      const bytes = tableString(value, `value ${v + 1} of trait type ${t}`, 255, 1);
      parts.push(Uint8Array.of(bytes.length), bytes);
    }
  }
  const encoded = concatBytes(...parts);
  if (encoded.length > maxBytes) {
    throw new Error(`the table is ${encoded.length} bytes; ${maxBytes === MISFITS_MAX_GENESIS_TABLE_BYTES ? 'a genesis carries' : 'a box carries'} at most ${maxBytes}`);
  }
  return encoded;
}

// ---------------------------------------------------------------------------------------------------------------
// Deterministic test fixture and the vector file packages/contracts/test/vectors/misfits-commitment.json.
// ---------------------------------------------------------------------------------------------------------------

/** Trait names from scripts/nft/lib/vocab.mjs (round-one generator). The final table comes with the art (G13). */
export const FIXTURE_TABLE: MetadataTable = {
  description: 'Test vector only (not launch copy). The Misfits: toy shapes that still fit the square hole.',
  traitTypes: [
    {
      name: 'Shape',
      values: ['Ball', 'Pyramid', 'Star', 'Heart', 'Gem', 'Drum', 'Triangle', 'Crescent', 'Pill', 'Diamond', 'Hexagon', 'Cloud', 'Plus', 'Blob'],
    },
    { name: 'Material', values: ['Plastic', 'Clay', 'Wood', 'Jelly', 'Chrome', 'Gold'] },
    { name: 'Color', values: ['Cherry', 'Sunflower', 'Cobalt', 'Clover', 'Tangerine', 'Bubblegum', 'Lilac', 'Lagoon'] },
    {
      name: 'Expression',
      values: ['Happy', 'Grinning', 'Smug', 'Surprised', 'Sleepy', 'Wink', 'Determined', 'Blushing', 'Worried', 'Starry-Eyed'],
    },
    {
      name: 'Prop',
      values: ['None', 'Party Hat', 'Sunglasses', 'Bow Tie', 'Top Hat', 'Beanie', 'Headphones', 'Monocle', 'Flower', 'Propeller Cap', 'Halo'],
    },
    {
      name: 'Background',
      values: ['Lavender Glow', 'Indigo Night', 'Teal Glow', 'Rose Glow', 'Amber Glow', 'Mint Glow', 'Starry Night', 'Confetti'],
    },
  ],
};

const utf8 = (text: string) => new TextEncoder().encode(text);

/**
 * Stand-in generator version for the vectors: the root tree id of main 501b413 (`git rev-parse 501b413^{tree}`,
 * 2026-09-29), a prototype, not a release. The launch value is the root tree of the release commit.
 */
export const FIXTURE_GENERATOR_TREE = 'e95521689a770d6d7b423c18b6d84d6556192211';

/**
 * TEST DATA ONLY (F29 vectors): a valid, empty glTF 2.0 file per id, "placeholder" in its generator field. Real
 * models come from the generator (scripts/nft/edition) with all eight slot anchors.
 */
export function placeholderGlb(id: number): Uint8Array {
  checkId(id);
  const text = utf8(
    `{"asset":{"version":"2.0","generator":"Square Hole test vector placeholder, not a Misfit model"},"extras":{"misfit":${id}}}`,
  );
  const json = new Uint8Array(Math.ceil(text.length / 4) * 4).fill(0x20);
  json.set(text);
  const out = new Uint8Array(GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES + json.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(GLB_HEADER_BYTES, json.length, true);
  view.setUint32(GLB_HEADER_BYTES + 4, GLB_CHUNK_JSON, true);
  out.set(json, GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES);
  return out;
}

/** Fixture traits: type i = 1 + (byte i of keccak256("misfits-fixture-traits-<id>") mod count). Id 3 has no Prop
 * (byte 0, attribute omitted) and id 4 an out-of-table Shape index 200 (rendered as "200"), to cover both paths. */
function fixtureTraits(id: number): bigint {
  const h = keccak_256(utf8(`misfits-fixture-traits-${id}`));
  const indices = FIXTURE_TABLE.traitTypes.map((type, i) => 1 + ((h[i] as number) % type.values.length));
  if (id === 3) indices[4] = 0;
  if (id === 4) indices[0] = 200;
  return packTraits(indices);
}

export function misfitsFixtureEntries(): MisfitEntry[] {
  return Array.from({ length: MISFITS_COUNT }, (_, i) => {
    const id = i + 1;
    return {
      id,
      traitsPacked: fixtureTraits(id),
      imageSha256: sha256Hex(utf8(`misfit-image-${id}`)),
      avatarSha256: sha256Hex(utf8(`misfit-avatar-${id}`)),
      modelSha256: glbSha256(placeholderGlb(id)),
      salt: toHex(keccak_256(utf8(`misfits-fixture-salt-${id}`))),
    };
  });
}

function renderedAttributes(traitsPacked: bigint): { types: string[]; values: string[] } {
  const types: string[] = [];
  const values: string[] = [];
  unpackTraits(traitsPacked, FIXTURE_TABLE.traitTypes.length).forEach((v, i) => {
    const type = FIXTURE_TABLE.traitTypes[i];
    if (v === 0 || !type) return;
    types.push(type.name);
    values.push(type.values[v - 1] ?? String(v));
  });
  return { types, values };
}

export const VECTOR_IDS = [1, 2, 3, 4, 42, 69, 2_100, 4_096, 4_097, 4_199, 4_200] as const;

export function misfitsCommitmentVectors() {
  const entries = misfitsFixtureEntries();
  const tree = buildMisfitsTree(entries.map(misfitLeaf));
  const table = encodeMetadataTable(FIXTURE_TABLE);
  const helloWorld = sha256Hex(utf8('hello world'));
  return {
    format: 'squarehole.misfits-commitment-vectors/2',
    note:
      'Generated by packages/artwork/src/misfits-commitment.ts (SH_WRITE_VECTORS=1 pnpm vitest run ' +
      'packages/artwork/src/misfits-commitment.test.ts); replayed by test/v2/MisfitsCollectionVectors.t.sol. ' +
      'Deterministic test data, not launch data. Format 2 (F29): six-field leaf with modelSha256; the model files ' +
      'are placeholder GLBs, not Misfit models.',
    count: MISFITS_COUNT,
    depth: MISFITS_TREE_DEPTH,
    root: tree.root,
    metadataTable: toHex(table),
    metadataTableHash: toHex(keccak_256(table)),
    description: FIXTURE_TABLE.description,
    generator: {
      note: 'Stand-in: the root tree id of main 501b413 (git rev-parse 501b413^{tree}), not a release generator.',
      gitTreeId: `0x${FIXTURE_GENERATOR_TREE}`,
      generatorHash: generatorHashFromGitTree(FIXTURE_GENERATOR_TREE),
    },
    helloWorld: { sha256: helloWorld, cid: rawCidV1(helloWorld) },
    entries: VECTOR_IDS.map((id) => {
      const e = entries[id - 1] as MisfitEntry;
      const attributes = renderedAttributes(e.traitsPacked);
      return {
        id,
        traitsPacked: e.traitsPacked.toString(),
        imageSha256: e.imageSha256,
        avatarSha256: e.avatarSha256,
        modelSha256: e.modelSha256,
        salt: e.salt,
        leaf: misfitLeaf(e),
        proof: tree.proof(id),
        imageCid: rawCidV1(e.imageSha256),
        modelCid: rawCidV1(e.modelSha256),
        modelGlb: toHex(placeholderGlb(id)),
        attributeTypes: attributes.types,
        attributeValues: attributes.values,
      };
    }),
  };
}
