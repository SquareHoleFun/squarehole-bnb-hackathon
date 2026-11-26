/**
 * The exporter's two plain files:
 *
 * - the public commitment `squarehole.box0-commitment/1`: what box0-spec.1.json takes (N, depth, reveal root, table and
 *   generator hashes), the tree that rendered the files (renderGeneratorTree, recorded even when MF-17 commits zero),
 *   and the identity of the archive (file, sha256, key id, escrow intent, key split). Safe to commit;
 * - the proofs file `squarehole.box0-proofs/1`: each id's leaf and its siblings, for the reveal job. Not secret (every
 *   leaf hides its preimage behind a 32-byte salt) but not for publication either: the leaves are not needed before a
 *   reveal.
 *
 * Neither holds a salt, a file hash or a trait of any id: a per-id picture or model hash lets anyone render the public
 * generator's candidates and match them to numbers before the reveal (the list stays hidden, STYLE-BIBLE § 3.12).
 */
import type { Hex32 } from '../hash';
import type { EscrowMode, SplitReceipt } from './archive';
import type { Box0Commitment } from './commitment';
import { assertKeySplitClaim } from './key-split';

export const PUBLIC_FORMAT = 'squarehole.box0-commitment/1';
export const PROOFS_FORMAT = 'squarehole.box0-proofs/1';

export interface ArchiveInfo {
  /** The archive's file name, relative to the public file. */
  readonly file: string;
  readonly sha256: Hex32;
  readonly keyId: Hex32;
  /** MF-16's answer, an intent: keySplit says whether a split was made. */
  readonly escrowIntent: EscrowMode;
  /** The key split's scheme: "shamir-2-of-3" for trustee escrow, only with `splitReceipt`. */
  readonly keySplit: string;
  /** The split's receipt; for trustee escrow the verified TrusteeKeySplit receipt of this archive. Not written out. */
  readonly splitReceipt?: SplitReceipt;
}

export function publicCommitment(c: Box0Commitment, archive: ArchiveInfo) {
  if (c.testSalts) throw new Error('test salts never make a public commitment');
  assertKeySplitClaim({ escrowIntent: archive.escrowIntent, keyId: archive.keyId, archiveSha256: archive.sha256, keySplit: archive.keySplit, receipt: archive.splitReceipt });
  return {
    format: PUBLIC_FORMAT,
    about:
      "Box 0 (The Misfits) commitment for box0-spec.1.json: N, depth, reveal root, metadata table and generator hashes, the generator tree that rendered the files, and the escrow archive's identity. escrowIntent is who is meant to keep the archive key (MF-16); keySplit says whether a split was made. No salt, file hash or trait of any id. Written by scripts/box/box0-commitment.mjs.",
    n: c.n,
    depth: c.depth,
    root: c.root,
    metadataTable: { hash: c.tableHash, bytes: c.table.bytes.length, valueOrderHash: c.valueOrderHash },
    generatorHash: c.generatorHash,
    generatorTree: c.generatorTree,
    renderGeneratorTree: c.render.generatorTree,
    encoding: c.render.encoding,
    platform: c.render.platform,
    leaf: 'keccak256(abi.encode(uint256 id, uint128 traitsPacked, bytes32 imageSha256, bytes32 avatarSha256, bytes32 modelSha256, bytes32 salt)) (BoxCollection.leafOf)',
    tree: 'binary, fixed depth ceil(log2 N), position id - 1, padded with bytes32(0), node = keccak256(left || right), index-directed proofs (BoxCollection._verify)',
    archive: {
      file: archive.file,
      sha256: archive.sha256,
      keyId: archive.keyId,
      cipher: 'aes-256-gcm',
      escrowIntent: archive.escrowIntent,
      keySplit: archive.keySplit,
    },
  };
}

export function proofsFile(c: Box0Commitment) {
  return {
    format: PROOFS_FORMAT,
    about: 'Leaf and siblings (from the leaf up) of every id of box 0, for the reveal job. No salt and no file hash.',
    n: c.n,
    depth: c.depth,
    root: c.root,
    proofs: c.records.map((r) => ({ id: r.id, leaf: r.leaf, proof: c.proof(r.id) })),
  };
}
