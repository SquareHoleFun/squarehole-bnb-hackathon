/**
 * Metadata table v1 bytes read back into types and values (the inverse of encodeBoxMetadataTable), so an opened
 * archive can check every record's attributes against its traitsPacked from the archived table bytes alone.
 */
import { hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { encodeBoxMetadataTable } from '../box-commitment';
import { messageOf, readR7 } from '../test-support/box0-export';
import { decodeTableBytes } from './table-bytes';

const r7 = readR7();
const traitTypes = r7.types.map((t) => ({ name: t.name, values: [...t.list] }));

describe('table bytes', () => {
  it('reads the round-7 table back: 16 types, every value in order, no description', () => {
    const table = decodeTableBytes(hexToBytes(r7.table.slice(2)));
    expect(table).toEqual({ description: '', traitTypes });
  });

  it('reads a description (MF-12)', () => {
    const description = 'One short neutral line.';
    expect(decodeTableBytes(encodeBoxMetadataTable({ description, traitTypes }))).toEqual({ description, traitTypes });
  });

  it('refuses bytes that end early, run past the last type, or carry another version', () => {
    const bytes = encodeBoxMetadataTable({ description: '', traitTypes });
    expect(messageOf(() => decodeTableBytes(bytes.slice(0, -1)))).toMatch(/the table bytes end early/);
    expect(messageOf(() => decodeTableBytes(Uint8Array.of(...bytes, 0)))).toMatch(/the table bytes go on past the last type/);
    expect(messageOf(() => decodeTableBytes(Uint8Array.of(2, ...bytes.slice(1))))).toMatch(/the table bytes are not version 1/);
    expect(messageOf(() => decodeTableBytes(new Uint8Array()))).toMatch(/the table bytes end early/);
  });

  it('refuses bytes that are not the canonical encoding of what they hold (an empty value list)', () => {
    const empty = Uint8Array.of(1, 0, 0, 1, 1, 0x41, 0);
    expect(messageOf(() => decodeTableBytes(empty))).toMatch(/the table bytes are not a valid v1 table/);
  });
});
