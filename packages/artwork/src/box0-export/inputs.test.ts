/**
 * The exporter's two curated inputs: the trait table file (squarehole.box-trait-table/1, as
 * scripts/box/misfits-trait-table.mjs writes it) and the frozen set (squarehole.misfits-frozen-set/1: every id 1..N
 * once, with its attributes).
 */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { encodeBoxMetadataTable } from '../box-commitment';
import { messageOf, readR7, readR7Json, testSet } from '../test-support/box0-export';
import { BOX0_N, parseFrozenSet, parseTraitTable } from './inputs';

const r7 = readR7();

describe('trait table file', () => {
  it('reads the round-7 table: 16 types, 3,341 bytes, its keccak256 as the table hash', () => {
    const t = parseTraitTable(readR7Json());
    expect(t.table.traitTypes).toHaveLength(16);
    expect(t.table.description).toBe('');
    expect(t.bytes).toHaveLength(3_341);
    expect(t.hash).toBe(`0x${bytesToHex(keccak_256(hexToBytes(r7.table.slice(2))))}`);
    expect(t.valueOrderHash).toBe(t.hash);
  });

  it('takes a description (MF-12) and checks the bytes against the lists', () => {
    const json = readR7Json() as Record<string, unknown>;
    const description = 'One short neutral line.';
    const traitTypes = r7.types.map((x) => ({ name: x.name, values: [...x.list] }));
    const bytes = encodeBoxMetadataTable({ description, traitTypes });
    const t = parseTraitTable({ ...json, description, table: `0x${bytesToHex(bytes)}` });
    expect(t.table.description).toBe(description);
    expect(t.valueOrderHash).toBe(parseTraitTable(json).hash);
    expect(t.hash).not.toBe(t.valueOrderHash);
    expect(messageOf(() => parseTraitTable({ ...json, description }))).toMatch(/the table bytes do not match its type lists/);
  });

  it('refuses another format, edited lists and a missing table', () => {
    const json = readR7Json() as Record<string, unknown>;
    expect(messageOf(() => parseTraitTable({ ...json, format: 'other/1' }))).toMatch(/not a squarehole.box-trait-table\/1 file/);
    const types = r7.types.map((x, i) => (i === 2 ? { ...x, list: [...x.list].reverse() } : x));
    expect(messageOf(() => parseTraitTable({ ...json, types }))).toMatch(/the table bytes do not match its type lists/);
    expect(messageOf(() => parseTraitTable({ ...json, table: undefined }))).toMatch(/table must be a 0x hex string/);
  });
});

describe('frozen set', () => {
  const { frozenSet } = testSet(13, r7.types, [3]);

  it('box 0 has 4,269 ids (F49 E8)', () => {
    expect(BOX0_N).toBe(4_269);
  });

  it('reads every id 1..N once, in id order', () => {
    const shuffled = { ...frozenSet, entries: [...frozenSet.entries].reverse() };
    const entries = parseFrozenSet(shuffled, 13);
    expect(entries.map((e) => e.id)).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
    expect(entries[2]?.attributes).toEqual(frozenSet.entries[2]?.attributes);
  });

  it('refuses another format, another N, a missing, repeated or foreign id and missing attributes', () => {
    expect(messageOf(() => parseFrozenSet({ ...frozenSet, format: 'x/1' }, 13))).toMatch(/not a squarehole.misfits-frozen-set\/1 file/);
    expect(messageOf(() => parseFrozenSet(frozenSet, 4_269))).toMatch(/the frozen set says n = 13; expected 4269/);
    expect(messageOf(() => parseFrozenSet({ ...frozenSet, entries: frozenSet.entries.slice(1) }, 13))).toMatch(/12 entries; expected 13/);
    const twice = frozenSet.entries.map((e) => (e.id === 4 ? { ...e, id: 3 } : e));
    expect(messageOf(() => parseFrozenSet({ ...frozenSet, entries: twice }, 13))).toMatch(/id 3 appears twice/);
    const foreign = frozenSet.entries.map((e) => (e.id === 4 ? { ...e, id: 14 } : e));
    expect(messageOf(() => parseFrozenSet({ ...frozenSet, entries: foreign }, 13))).toMatch(/id 14 is outside 1\.\.13/);
    const bad = frozenSet.entries.map((e) => (e.id === 2 ? { id: 2 } : e));
    expect(messageOf(() => parseFrozenSet({ ...frozenSet, entries: bad }, 13))).toMatch(/id 2: attributes must be a list/);
  });

  it('never quotes an id or n that is not a whole number (it may be a misplaced trait value)', () => {
    const named = frozenSet.entries.map((e) => (e.id === 4 ? { ...e, id: 'Unreleased Name' } : e));
    const idMessage = messageOf(() => parseFrozenSet({ ...frozenSet, entries: named }, 13));
    expect(idMessage).toMatch(/entry 4: the id is not a whole number in 1\.\.13/);
    expect(idMessage).not.toContain('Unreleased');
    const nMessage = messageOf(() => parseFrozenSet({ ...frozenSet, n: 'Unreleased Name' }, 13));
    expect(nMessage).toMatch(/the frozen set's n is not 13/);
    expect(nMessage).not.toContain('Unreleased');
  });
});
