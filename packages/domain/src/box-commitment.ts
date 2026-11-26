/**
 * The commitment of another creator's box (launch pipeline v1 § 3.1, box creation flow § 2 field 20): the Misfits
 * leaf and tree, generalised to any edition size N. Shared by chain validation and artwork generation.
 *
 * - leaf = keccak256(abi.encode(uint256 id, uint128 traitsPacked, bytes32 imageSha256, bytes32 avatarSha256,
 *   bytes32 modelSha256, bytes32 salt)), the same six words as `misfitLeaf`. Create currently supplies zero avatars;
 *   a model-bearing item commits the SHA-256 of its exact GLB bytes (R74-ART), while a 2D item commits bytes32(0).
 *   Both fields participate in the leaf even when zero. The image digest must not be zero (a missing file);
 * - a plain binary Merkle tree of fixed depth ⌈log₂ N⌉ over positions id − 1, padded with bytes32(0), node =
 *   keccak256(left ‖ right), proofs verified index-directed. For N = 4,200 this is exactly the Misfits tree (depth 13).
 *
 * Salts are 32 CSPRNG bytes per item, chosen by the caller; nothing here is random.
 */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
type Hex32 = `0x${string}`;

/** The largest edition a box tree is built for here (2^20); the factory's own bound is lower (box-spec MAX_N). */
export const BOX_TREE_MAX_ITEMS = 1 << 20;

export interface BoxLeafEntry {
  /** Token number, 1..N. */
  readonly id: number;
  /** One byte per trait type, below 2^128. */
  readonly traitsPacked: bigint;
  readonly imageSha256: Hex32;
  /** Committed avatar digest; Create currently supplies bytes32(0). */
  readonly avatarSha256: Hex32;
  /** Committed SHA-256 of the exact GLB bytes, or bytes32(0) for a 2D item (R74-ART). */
  readonly modelSha256: Hex32;
  readonly salt: Hex32;
}

export interface BoxTree {
  readonly root: Hex32;
  readonly depth: number;
  /** The `depth` siblings from the leaf upwards. */
  proof(id: number): Hex32[];
}

const toHex = (bytes: Uint8Array): Hex32 => `0x${bytesToHex(bytes)}`;
const ZERO32 = new Uint8Array(32);

function bytes32(value: Hex32, what: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${what} must be a 32-byte hex string`);
  return hexToBytes(value.slice(2));
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

function checkSize(n: number): void {
  if (!Number.isInteger(n) || n < 1 || n > BOX_TREE_MAX_ITEMS) throw new Error(`N must be a whole number from 1 to ${BOX_TREE_MAX_ITEMS}`);
}

function checkId(id: number, n: number): void {
  if (!Number.isInteger(id) || id < 1 || id > n) throw new Error(`id ${id} is outside 1..${n}`);
}

/** ⌈log₂ N⌉: 0 for one item, 13 for 4,200, 14 for 10,000. */
export function boxTreeDepth(n: number): number {
  checkSize(n);
  let depth = 0;
  while (1 << depth < n) depth += 1;
  return depth;
}

/** The six-word leaf preimage; avatar and model may be zero, the image may not. */
export function encodeBoxLeafPreimage(entry: BoxLeafEntry, n: number): Uint8Array {
  checkSize(n);
  checkId(entry.id, n);
  if (entry.traitsPacked < 0n || entry.traitsPacked >= 1n << 128n) throw new Error('traitsPacked must fit in 128 bits');
  const image = bytes32(entry.imageSha256, 'imageSha256');
  if (image.every((b) => b === 0)) throw new Error('imageSha256 must not be zero (a missing file)');
  return concatBytes(
    word(BigInt(entry.id)),
    word(entry.traitsPacked),
    image,
    bytes32(entry.avatarSha256, 'avatarSha256'),
    bytes32(entry.modelSha256, 'modelSha256'),
    bytes32(entry.salt, 'salt'),
  );
}

export function boxLeaf(entry: BoxLeafEntry, n: number): Hex32 {
  return toHex(keccak_256(encodeBoxLeafPreimage(entry, n)));
}

const hashPair = (left: Uint8Array, right: Uint8Array) => keccak_256(concatBytes(left, right));

/** The fixed-depth tree over exactly N leaves (index = id − 1), padded to 2^depth with bytes32(0). */
export function buildBoxTree(leaves: readonly Hex32[], n: number): BoxTree {
  const depth = boxTreeDepth(n);
  if (leaves.length !== n) throw new Error(`the tree needs exactly ${n} leaves, got ${leaves.length}`);
  const layers: Uint8Array[][] = [];
  let level: Uint8Array[] = Array.from({ length: 1 << depth }, (_, i) => (i < n ? bytes32(leaves[i] as Hex32, `leaf ${i + 1}`) : ZERO32));
  layers.push(level);
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(hashPair(level[i] as Uint8Array, level[i + 1] as Uint8Array));
    layers.push(next);
    level = next;
  }
  return {
    root: toHex(level[0] as Uint8Array),
    depth,
    proof(id: number): Hex32[] {
      checkId(id, n);
      let index = id - 1;
      const siblings: Hex32[] = [];
      for (let d = 0; d < depth; d++) {
        siblings.push(toHex((layers[d] as Uint8Array[])[index ^ 1] as Uint8Array));
        index >>= 1;
      }
      return siblings;
    },
  };
}

/** The contract-side check for a box of N items: exactly ⌈log₂ N⌉ siblings, combined by the bits of id − 1. */
export function verifyBoxProof(id: number, leaf: Hex32, proof: readonly Hex32[], root: Hex32, n: number): boolean {
  const depth = boxTreeDepth(n);
  if (!Number.isInteger(id) || id < 1 || id > n || proof.length !== depth) return false;
  let node = bytes32(leaf, 'leaf');
  let index = id - 1;
  for (const sibling of proof) {
    const s = bytes32(sibling, 'sibling');
    node = index & 1 ? hashPair(s, node) : hashPair(node, s);
    index >>= 1;
  }
  return toHex(node) === root.toLowerCase();
}

