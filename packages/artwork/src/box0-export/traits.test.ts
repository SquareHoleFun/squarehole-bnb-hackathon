/**
 * traitsPacked from an id's attributes through box 0's trait table (BoxCollection's metadata table v1): type i in byte
 * i, the 1-based value index, 0 for an absent type, whatever order the attributes come in.
 */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { encodeBoxMetadataTable } from '../box-commitment';
import { packTraits, type MetadataTable } from '../misfits-commitment';
import { messageOf, readR7 } from '../test-support/box0-export';
import { attributesOf, packAttributes, traitIndex, valueOrderHash } from './traits';

const r7 = readR7();
const table: MetadataTable = { description: '', traitTypes: r7.types.map((t) => ({ name: t.name, values: [...t.list] })) };
const index = traitIndex(table);
const value = (t: number, v: number) => r7.types[t]?.list[v] as string;

describe('box 0 traits via the table', () => {
  it('packs type i into byte i with the 1-based value index, absent types as 0, in any attribute order', () => {
    const attributes = [
      { trait_type: 'Box', value: value(15, 2) },
      { trait_type: 'Character', value: value(0, 0) },
      { trait_type: 'Finish', value: value(5, 32) },
    ];
    const packed = packAttributes(attributes, index, 'id 1');
    const bytes = Array<number>(16).fill(0);
    bytes[0] = 1;
    bytes[5] = 33;
    bytes[15] = 3;
    expect(packed).toBe(packTraits(bytes));
    expect(packAttributes([...attributes].reverse(), index, 'id 1')).toBe(packed);
  });

  it('gives the attributes back in table order, the order the contract renders them', () => {
    const attributes = [
      { trait_type: 'Environment', value: value(14, 1) },
      { trait_type: 'Character', value: value(0, 85) },
      { trait_type: 'Role', value: value(13, 7) },
    ];
    const packed = packAttributes(attributes, index, 'id 9');
    expect(attributesOf(packed, table)).toEqual([attributes[1], attributes[2], attributes[0]]);
  });

  it('refuses an unknown type, an unknown value, a repeated type and an empty list, naming the id but not the value', () => {
    const foreign = messageOf(() => packAttributes([{ trait_type: 'Color', value: value(4, 0) }, { trait_type: 'Hat', value: 'Cap' }], index, 'id 7'));
    expect(foreign).toMatch(/id 7: attribute 2 has a trait type that is not in the table/);
    expect(foreign).not.toContain('Hat');
    // A curation tool that swapped the keys must not put the unreleased value on stderr.
    const swapped = messageOf(() => packAttributes([{ trait_type: 'Unreleased Violet', value: 'Color' }], index, 'id 7'));
    expect(swapped).toMatch(/id 7: attribute 1 has a trait type that is not in the table/);
    expect(swapped).not.toContain('Unreleased');
    const unknown = messageOf(() => packAttributes([{ trait_type: 'Color', value: 'Secret Ultra Violet' }], index, 'id 7'));
    expect(unknown).toMatch(/id 7: its Color value is not in the table/);
    expect(unknown).not.toContain('Secret Ultra Violet');
    const twice = [
      { trait_type: 'Color', value: value(4, 0) },
      { trait_type: 'Color', value: value(4, 1) },
    ];
    expect(messageOf(() => packAttributes(twice, index, 'id 7'))).toMatch(/id 7: trait type "Color" appears twice/);
    expect(messageOf(() => packAttributes([], index, 'id 7'))).toMatch(/id 7: no attributes/);
    expect(messageOf(() => packAttributes('Color', index, 'id 7'))).toMatch(/id 7: attributes must be a list/);
    expect(messageOf(() => packAttributes([{ trait_type: 'Color', value: 3 }], index, 'id 7'))).toMatch(
      /id 7: every attribute needs a string trait_type and value/,
    );
  });

  it('refuses a table with a repeated type or value (an index would be ambiguous)', () => {
    expect(() => traitIndex({ description: '', traitTypes: [{ name: 'A', values: ['x'] }, { name: 'A', values: ['y'] }] })).toThrow(/type "A" appears twice/);
    expect(() => traitIndex({ description: '', traitTypes: [{ name: 'A', values: ['x', 'x'] }] })).toThrow(/type "A" lists a value twice/);
  });

  it('valueOrderHash ignores the description but not the value order', () => {
    const empty = `0x${bytesToHex(keccak_256(encodeBoxMetadataTable(table)))}`;
    expect(valueOrderHash(table)).toBe(empty);
    expect(valueOrderHash({ ...table, description: 'One short neutral line.' })).toBe(empty);
    const swapped = table.traitTypes.map((t, i) => (i === 1 ? { ...t, values: [...t.values].reverse() } : t));
    expect(valueOrderHash({ ...table, traitTypes: swapped })).not.toBe(empty);
  });
});
