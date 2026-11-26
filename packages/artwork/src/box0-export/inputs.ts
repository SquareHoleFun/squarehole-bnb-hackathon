/**
 * The exporter's curated inputs (formats documented in docs/design/box0-commitment-export.md):
 *
 * - the trait table file `squarehole.box-trait-table/1` (scripts/box/misfits-trait-table.mjs writes it; round 7 today,
 *   rebuilt from the frozen set later): `types[{ name, list }]`, `table` (the v1 bytes, 0x hex) and an optional
 *   `description` (MF-12; empty when absent). The bytes must be exactly the lists' encoding;
 * - the frozen set `squarehole.misfits-frozen-set/1` (the curation tool writes it): `n` and `entries[{ id, attributes }]`,
 *   every id 1..n exactly once, ids already assigned. Other fields are allowed and ignored.
 */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { encodeBoxMetadataTable } from '../box-commitment';
import type { Hex32 } from '../hash';
import type { MetadataTable } from '../misfits-commitment';
import { valueOrderHash } from './traits';

export const TRAIT_TABLE_FORMAT = 'squarehole.box-trait-table/1';
export const FROZEN_SET_FORMAT = 'squarehole.misfits-frozen-set/1';
/** Box 0's edition: 4,200 Misfits + 69 Icons (F49 E8). */
export const BOX0_N = 4_269;

export interface TraitTable {
  readonly table: MetadataTable;
  /** The table v1 bytes, exactly as the spec will carry them. */
  readonly bytes: Uint8Array;
  /** keccak256(bytes): BoxSpec metadataTable hash, BoxCollection.metadataTableHash. */
  readonly hash: Hex32;
  /** keccak256 of the same table with an empty description (traits.ts `valueOrderHash`). */
  readonly valueOrderHash: Hex32;
}

export interface FrozenEntry {
  readonly id: number;
  /** As the generator writes them; checked against the table when packed. */
  readonly attributes: unknown;
}

const record = (value: unknown, what: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${what} must be a JSON object`);
  return value as Record<string, unknown>;
};

export function parseTraitTable(json: unknown): TraitTable {
  const file = record(json, 'the trait table file');
  if (file.format !== TRAIT_TABLE_FORMAT) throw new Error(`not a ${TRAIT_TABLE_FORMAT} file`);
  if (!Array.isArray(file.types)) throw new Error('the trait table file needs a types list');
  const traitTypes = (file.types as unknown[]).map((t, i) => {
    const type = record(t, `trait type ${i}`);
    if (typeof type.name !== 'string' || !Array.isArray(type.list) || !(type.list as unknown[]).every((v) => typeof v === 'string')) {
      throw new Error(`trait type ${i} needs a name and a list of value strings`);
    }
    return { name: type.name, values: [...(type.list as string[])] };
  });
  const description = file.description === undefined ? '' : file.description;
  if (typeof description !== 'string') throw new Error('the description must be a string');
  if (typeof file.table !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(file.table)) throw new Error('table must be a 0x hex string');
  const table: MetadataTable = { description, traitTypes };
  const bytes = encodeBoxMetadataTable(table);
  if (bytesToHex(bytes) !== file.table.slice(2).toLowerCase()) throw new Error('the table bytes do not match its type lists and description');
  return { table, bytes, hash: `0x${bytesToHex(keccak_256(bytes))}`, valueOrderHash: valueOrderHash(table) };
}

export function parseFrozenSet(json: unknown, n: number): FrozenEntry[] {
  const file = record(json, 'the frozen set');
  if (file.format !== FROZEN_SET_FORMAT) throw new Error(`not a ${FROZEN_SET_FORMAT} file`);
  if (file.n !== n) throw new Error(Number.isInteger(file.n) ? `the frozen set says n = ${String(file.n)}; expected ${n}` : `the frozen set's n is not ${n}`);
  if (!Array.isArray(file.entries)) throw new Error('the frozen set needs an entries list');
  const entries = file.entries as unknown[];
  if (entries.length !== n) throw new Error(`the frozen set has ${entries.length} entries; expected ${n}`);
  const byId: (FrozenEntry | undefined)[] = Array.from({ length: n });
  for (const [k, e] of entries.entries()) {
    const entry = record(e, 'a frozen-set entry');
    const id = entry.id;
    // Never quote an id that is not a whole number: it may be a misplaced trait value.
    if (typeof id !== 'number' || !Number.isInteger(id)) throw new Error(`entry ${k + 1}: the id is not a whole number in 1..${n}`);
    if (id < 1 || id > n) throw new Error(`id ${id} is outside 1..${n}`);
    if (byId[id - 1]) throw new Error(`id ${id} appears twice in the frozen set`);
    if (!Array.isArray(entry.attributes)) throw new Error(`id ${id}: attributes must be a list`);
    byId[id - 1] = { id, attributes: entry.attributes };
  }
  return byId as FrozenEntry[];
}
