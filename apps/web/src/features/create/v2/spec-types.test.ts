/**
 * M1-53-a: the site's TypeScript stub of M1-00's frozen shapes (SpecTypes.sol, RecipeTypes.sol, IListingRegistry.sol's
 * listing enums, IBoxCoordinatorV2.sol's chunk parts) matches the Solidity sources member by member, so the create
 * flow builds format 2 specs in the frozen layout until M1-10's generated twin replaces the stub in wave 2.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeAbiParameters, keccak256 } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  BOX_SPEC_V2_ABI_COMPONENTS,
  BOX_SPEC_V2_FIELDS,
  BoxTypeV2,
  ChunkPart,
  Dest,
  Leg,
  ListingClass,
  ListingKind,
  Split,
  encodeBoxSpecV2,
  emptyBranch,
  specHashV2,
  type ListingV2,
} from './spec-types';
import { sampleSpec } from './test-support/v2-fixtures';

const INTERFACES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../packages/contracts/src/box-v2/interfaces');
const sol = (name: string) => readFileSync(resolve(INTERFACES, name), 'utf8');
const uncomment = (body: string) => body.replace(/\/\/[^\n]*/g, '');

/** An enum's members after its zero member, in order. */
function solEnum(source: string, name: string): string[] {
  const match = new RegExp(`enum ${name} \\{([^}]*)\\}`).exec(source);
  if (!match?.[1]) throw new Error(`enum ${name} not found`);
  return uncomment(match[1])
    .split(',')
    .map((member) => member.trim())
    .filter(Boolean)
    .slice(1);
}

/** A struct's field names, in order. */
function solStruct(source: string, name: string): string[] {
  const match = new RegExp(`struct ${name} \\{([^}]*)\\}`).exec(source);
  if (!match?.[1]) throw new Error(`struct ${name} not found`);
  return uncomment(match[1])
    .split(';')
    .map((line) => line.trim().split(/\s+/).pop() ?? '')
    .filter(Boolean);
}

interface AbiField {
  readonly name: string;
  readonly type: string;
  readonly components?: readonly AbiField[];
}

const ELEMENTARY = /^(uint\d*|int\d*|address|bool|bytes\d*|string)(\[\])?$/;
const SOURCES = ['SpecTypes.sol', 'RecipeTypes.sol'];

/** A struct as viem's ABI components: elementary types as written, a struct member as a tuple of its own members. */
function solAbi(name: string): AbiField[] {
  const source = SOURCES.map(sol).find((text) => new RegExp(`struct ${name} \\{`).test(text));
  if (!source) throw new Error(`struct ${name} not found`);
  const match = new RegExp(`struct ${name} \\{([^}]*)\\}`).exec(source);
  return uncomment(match?.[1] ?? '')
    .split(';')
    .map((line) => line.trim().split(/\s+/))
    .filter((words) => words.length === 2)
    .map(([type = '', field = '']) => {
      if (ELEMENTARY.test(type)) return { name: field, type };
      const array = type.endsWith('[]');
      return { name: field, type: array ? 'tuple[]' : 'tuple', components: solAbi(array ? type.slice(0, -2) : type) };
    });
}

/** The ABI as plain data (viem's `as const` arrays compare member by member). */
const plain = (fields: readonly AbiField[]): AbiField[] => fields.map((field) => ({ name: field.name, type: field.type, ...(field.components ? { components: plain(field.components) } : {}) }));

const members = (values: Readonly<Record<string, number>>) => Object.entries(values).sort((x, y) => x[1] - y[1]);

describe('the frozen enums (M1-00)', () => {
  const cases: [string, string, Readonly<Record<string, number>>][] = [
    ['SpecTypes.sol', 'BoxType', BoxTypeV2],
    ['RecipeTypes.sol', 'Leg', Leg],
    ['RecipeTypes.sol', 'Dest', Dest],
    ['RecipeTypes.sol', 'Split', Split],
    ['IListingRegistry.sol', 'ListingClass', ListingClass],
    ['IListingRegistry.sol', 'ListingKind', ListingKind],
    ['IBoxCoordinatorV2.sol', 'ChunkPart', ChunkPart],
  ];
  it.each(cases)('%s %s: same members, same values, 0 never a member', (file, name, values) => {
    const names = solEnum(sol(file), name);
    expect(members(values).map(([key]) => key)).toEqual(names);
    expect(members(values).map(([, value]) => value)).toEqual(names.map((_, index) => index + 1));
  });
});

describe('the frozen structs (M1-00)', () => {
  it('BoxSpec: fields 0-31 in id order', () => {
    expect(BOX_SPEC_V2_FIELDS).toEqual(solStruct(sol('SpecTypes.sol'), 'BoxSpec'));
    expect(BOX_SPEC_V2_FIELDS).toHaveLength(32);
  });
  it('Side, Branch and Pricing keep their order', () => {
    const recipes = sol('RecipeTypes.sol');
    expect(solStruct(recipes, 'Side')).toEqual(['a', 'b', 'split', 'splitParams']);
    expect(solStruct(recipes, 'Branch')).toEqual(['leg', 'dest', 'legParams', 'destParams']);
    expect(solStruct(sol('SpecTypes.sol'), 'Pricing')).toEqual(['listingId', 'token']);
  });
  it('BoxSpec’s ABI tuple has every member’s Solidity type, nested tuples included (Pricing, Side, Branch, AddOn)', () => {
    expect(plain(BOX_SPEC_V2_ABI_COMPONENTS)).toEqual(solAbi('BoxSpec'));
  });
  it('Listing: the stub’s members in order, each at the width its TypeScript type holds (number up to uint32, bigint above)', () => {
    // A Record over keyof ListingV2: the compiler refuses a missing or extra member, the test the order and the widths.
    const widths: Record<keyof ListingV2, string> = { id: 'uint32', token: 'address', decimals: 'uint8', class: 'uint8', kind: 'uint8', raise: 'uint256' };
    expect(solAbi('Listing')).toEqual(Object.entries(widths).map(([name, type]) => ({ name, type })));
  });
});

describe('encoding', () => {
  it('the spec hash is keccak256(abi.encode(spec)): one dynamic tuple, format and version first', () => {
    const spec = sampleSpec();
    const encoded = encodeBoxSpecV2(spec);
    expect(specHashV2(spec)).toBe(keccak256(encoded));
    const word = (i: number) => BigInt(`0x${encoded.slice(2 + 64 * i, 2 + 64 * (i + 1))}`);
    expect([word(0), word(1), word(2), word(3)]).toEqual([32n, 2n, 2n, BigInt(BoxTypeV2.NEW_COLLECTION)]);
  });
  it('the side round-trips with one branch and no parameters', () => {
    const side = { a: { leg: Leg.BuyT, dest: Dest.Eat, legParams: '0x', destParams: '0x' }, b: emptyBranch(), split: Split.NoSplit, splitParams: '0x' } as const;
    const [decoded] = decodeAbiParameters([{ type: 'tuple', components: BOX_SPEC_V2_ABI_COMPONENTS }], encodeBoxSpecV2({ ...sampleSpec(), sellers: side }));
    expect((decoded as { sellers: unknown }).sellers).toEqual(side);
  });
  it('an all-zero branch is empty', () => {
    expect(emptyBranch()).toEqual({ leg: 0, dest: 0, legParams: '0x', destParams: '0x' });
  });
});
