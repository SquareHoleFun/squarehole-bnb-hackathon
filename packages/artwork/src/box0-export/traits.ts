/**
 * Box 0's traitsPacked from an id's attributes through its trait table (BoxCollection metadata table v1;
 * misfits-commitment.ts `packTraits`): trait type i in byte i, the value's 1-based position in that type's list, 0 when
 * the id has no attribute of that type (the contract then leaves it out of tokenJSON). Attributes come as the
 * generator writes them ([{ trait_type, value }], art branch scripts/nft/edition/attributes.mjs `familyAttributes`), in
 * any order.
 *
 * Errors name the id and a trait type from the table, never the value and never a type outside the table (a curation
 * tool that swapped the keys would put a value there): such an attribute is named by its position in the list.
 */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { encodeBoxMetadataTable } from '../box-commitment';
import type { Hex32 } from '../hash';
import { packTraits, unpackTraits, type MetadataTable } from '../misfits-commitment';

export interface Attribute {
  readonly trait_type: string;
  readonly value: string;
}

/** Each type's position and each value's 1-based index, for one table. */
export interface TraitIndex {
  readonly typeCount: number;
  readonly types: ReadonlyMap<string, { readonly position: number; readonly values: ReadonlyMap<string, number> }>;
}

export function traitIndex(table: MetadataTable): TraitIndex {
  const types = new Map<string, { position: number; values: Map<string, number> }>();
  table.traitTypes.forEach((type, position) => {
    if (types.has(type.name)) throw new Error(`the trait table is ambiguous: type "${type.name}" appears twice`);
    const values = new Map<string, number>();
    type.values.forEach((value, v) => {
      if (values.has(value)) throw new Error(`the trait table is ambiguous: type "${type.name}" lists a value twice`);
      values.set(value, v + 1);
    });
    types.set(type.name, { position, values });
  });
  return { typeCount: table.traitTypes.length, types };
}

function isAttribute(a: unknown): a is Attribute {
  const x = a as { trait_type?: unknown; value?: unknown } | null;
  return typeof x === 'object' && x !== null && typeof x.trait_type === 'string' && typeof x.value === 'string';
}

/** traitsPacked of one id (`what` names it in errors, e.g. "id 7"). */
export function packAttributes(attributes: unknown, index: TraitIndex, what: string): bigint {
  if (!Array.isArray(attributes)) throw new Error(`${what}: attributes must be a list`);
  if (attributes.length === 0) throw new Error(`${what}: no attributes`);
  const bytes = Array<number>(index.typeCount).fill(0);
  for (const [k, a] of (attributes as unknown[]).entries()) {
    if (!isAttribute(a)) throw new Error(`${what}: every attribute needs a string trait_type and value`);
    const type = index.types.get(a.trait_type);
    if (!type) throw new Error(`${what}: attribute ${k + 1} has a trait type that is not in the table`);
    if (bytes[type.position] !== 0) throw new Error(`${what}: trait type "${a.trait_type}" appears twice`);
    const v = type.values.get(a.value);
    if (v === undefined) throw new Error(`${what}: its ${a.trait_type} value is not in the table`);
    bytes[type.position] = v;
  }
  return packTraits(bytes);
}

/** The attributes a traitsPacked stands for, in table order (the order tokenJSON lists them). */
export function attributesOf(traitsPacked: bigint, table: MetadataTable): Attribute[] {
  const out: Attribute[] = [];
  unpackTraits(traitsPacked, table.traitTypes.length).forEach((v, i) => {
    const type = table.traitTypes[i];
    if (v === 0 || !type) return;
    const value = type.values[v - 1];
    if (value === undefined) throw new Error(`trait byte ${i} is ${v}, past type "${type.name}"'s ${type.values.length} values`);
    out.push({ trait_type: type.name, value });
  });
  return out;
}

/**
 * keccak256 of the table with an empty description: the part every leaf depends on (types and value order). A final
 * table that only adds the description (MF-12) keeps this hash, so the spec step can check it against the commitment.
 */
export function valueOrderHash(table: MetadataTable): Hex32 {
  return `0x${bytesToHex(keccak_256(encodeBoxMetadataTable({ description: '', traitTypes: table.traitTypes })))}`;
}
