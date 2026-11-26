/** Shared commitment primitives keep artwork generation and chain proof checks byte-identical. */
export {
  BOX_TREE_MAX_ITEMS, boxTreeDepth, encodeBoxLeafPreimage, boxLeaf, buildBoxTree, verifyBoxProof,
  type BoxLeafEntry, type BoxTree,
} from '@squarehole/domain/box-commitment';
import { encodeMetadataTable, type MetadataTable } from './misfits-commitment';

/** The on-chain metadata table's own limit (EIP-170 less the STOP prefix; box-spec MAX_METADATA_TABLE_BYTES). */
export const BOX_MAX_TABLE_BYTES = 24_575;

/** The metadata table of a box: the Misfits table format, up to the on-chain limit (not the genesis budget). */
export function encodeBoxMetadataTable(table: MetadataTable): Uint8Array {
  return encodeMetadataTable(table, BOX_MAX_TABLE_BYTES);
}
