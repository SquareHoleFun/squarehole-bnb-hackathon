/**
 * Metadata table v1 bytes read back into types and values: the inverse of box-commitment.ts `encodeBoxMetadataTable`
 * (version byte, 2-byte description length, description, type count, then per type a length-prefixed name and a
 * counted list of length-prefixed values). An opened archive uses it to check every record's attributes against its
 * traitsPacked from the archived bytes alone. The result must re-encode to exactly the same bytes. Errors never quote
 * the table's text.
 */
import { bytesToHex } from '@noble/hashes/utils.js';
import { encodeBoxMetadataTable } from '../box-commitment';
import { MISFITS_TABLE_VERSION, type MetadataTable } from '../misfits-commitment';

export function decodeTableBytes(bytes: Uint8Array): MetadataTable {
  let at = 0;
  const take = (count: number): Uint8Array => {
    if (at + count > bytes.length) throw new Error('the table bytes end early');
    const part = bytes.subarray(at, at + count);
    at += count;
    return part;
  };
  const byte = (): number => take(1)[0] as number;
  const text = (count: number): string => new TextDecoder().decode(take(count));
  if (byte() !== MISFITS_TABLE_VERSION) throw new Error(`the table bytes are not version ${MISFITS_TABLE_VERSION}`);
  const description = text((byte() << 8) | byte());
  const traitTypes = Array.from({ length: byte() }, () => {
    const name = text(byte());
    const values = Array.from({ length: byte() }, () => text(byte()));
    return { name, values };
  });
  if (at !== bytes.length) throw new Error('the table bytes go on past the last type');
  const table: MetadataTable = { description, traitTypes };
  let again: Uint8Array;
  try {
    again = encodeBoxMetadataTable(table);
  } catch {
    throw new Error('the table bytes are not a valid v1 table');
  }
  if (bytesToHex(again) !== bytesToHex(bytes)) throw new Error('the table bytes are not a valid v1 table');
  return table;
}
