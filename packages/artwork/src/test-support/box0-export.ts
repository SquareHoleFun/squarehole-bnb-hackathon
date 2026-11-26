/**
 * TEST DATA ONLY for the box 0 commitment exporter (src/box0-export): a frozen set, a render-hash file and fixed salts
 * built from public labels over the round-7 trait table. The "hashes" are sha256 of labels, not of any picture or model.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Hex32 } from '../hash';
import { sha256Hex } from '../misfits-commitment';

export const R7_TABLE_FILE = fileURLToPath(new URL('../../../contracts/test/vectors/box/misfits-trait-table-r7.json', import.meta.url));

export interface R7Type {
  readonly name: string;
  readonly list: readonly string[];
}

export interface TestAttribute {
  readonly trait_type: string;
  readonly value: string;
}

export interface TestFileHash {
  readonly sha256: string;
  readonly bytes: number;
}

export interface TestRenderRecord {
  readonly id: number;
  readonly attributes: readonly TestAttribute[];
  readonly image: TestFileHash;
  readonly avatar?: TestFileHash | null;
  readonly model: TestFileHash;
}

const utf8 = (text: string) => new TextEncoder().encode(text);
const hex = (bytes: Uint8Array): Hex32 => `0x${bytesToHex(bytes)}`;

export function readR7(): { types: R7Type[]; table: Hex32; tableBytes: number } {
  return JSON.parse(readFileSync(R7_TABLE_FILE, 'utf8')) as { types: R7Type[]; table: Hex32; tableBytes: number };
}

export function readR7Json(): unknown {
  return JSON.parse(readFileSync(R7_TABLE_FILE, 'utf8')) as unknown;
}

/** A test generator tree id (not a release and not the fixture's): the first 20 bytes of keccak256 of a label. */
export const TEST_GENERATOR_TREE = bytesToHex(keccak_256(utf8('box0-commitment-export test generator'))).slice(0, 40);

/** The fixed test salt of `id` (TESTS ONLY; the exporter draws real salts with node:crypto randomBytes). */
export function testSalt(id: number): Hex32 {
  return hex(keccak_256(utf8(`box0-commitment-export test salt ${id}`)));
}

const pick = (types: readonly R7Type[], t: number, index: number): TestAttribute => {
  const type = types[t] as R7Type;
  return { trait_type: type.name, value: type.list[index % type.list.length] as string };
};

/**
 * Test attributes of `id`. "one-of-one": Character, Role and Environment only (as familyAttributes gives a named
 * 1-of-1). "full": Character, Body and Color from the mixed-radix digits of id − 1 (so every id up to 52,288 differs),
 * every other type from a keccak byte, absent when that byte is a multiple of 4. Even ids list their attributes in
 * reverse table order (the exporter must not depend on the order).
 */
export function testAttributes(id: number, types: readonly R7Type[], shape: 'full' | 'one-of-one' = 'full'): TestAttribute[] {
  const n = id - 1;
  const chosen: TestAttribute[] = [];
  if (shape === 'one-of-one') {
    chosen.push(pick(types, 0, n), pick(types, 13, n), pick(types, 14, n + 1));
  } else {
    const h = keccak_256(utf8(`box0-commitment-export test traits ${id}`));
    types.forEach((type, t) => {
      if (type.name === 'Character') chosen.push(pick(types, t, n % 86));
      else if (type.name === 'Body') chosen.push(pick(types, t, Math.floor(n / 86) % 38));
      else if (type.name === 'Color') chosen.push(pick(types, t, Math.floor(n / (86 * 38)) % 16));
      else if ((h[t] as number) % 4 !== 0) chosen.push(pick(types, t, h[t] as number));
    });
  }
  return id % 2 === 0 ? chosen.reverse() : chosen;
}

export function testRender(id: number, attributes: readonly TestAttribute[], withAvatar = true): TestRenderRecord {
  const file = (what: string, bytes: number): TestFileHash => ({ sha256: sha256Hex(utf8(`box0-commitment-export test ${what} ${id}`)), bytes });
  return {
    id,
    attributes,
    image: file('image', 30_000 + id),
    ...(withAvatar ? { avatar: file('avatar', 5_000 + id) } : {}),
    model: file('model', 200_000 + id),
  };
}

export const TEST_ENCODING = {
  image: { format: 'webp', size: 512, quality: 90 },
  avatar: { format: 'webp', size: 256, quality: 90 },
  model: { format: 'glb' },
} as const;

export function renderHeader(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'squarehole.misfits-render-hashes/1',
    generatorTree: TEST_GENERATOR_TREE,
    platform: 'darwin-arm64',
    encoding: TEST_ENCODING,
    ...overrides,
  };
}

/** The render-hash file (JSON Lines): the header line, then one record per line. */
export function renderText(header: Record<string, unknown>, records: readonly unknown[]): string {
  return `${[header, ...records].map((line) => JSON.stringify(line)).join('\n')}\n`;
}

/** A test set of `n` ids: ids in `oneOfOnes` get the one-of-one shape. */
export function testSet(n: number, types: readonly R7Type[], oneOfOnes: readonly number[] = []) {
  const entries = Array.from({ length: n }, (_, i) => {
    const id = i + 1;
    return { id, attributes: testAttributes(id, types, oneOfOnes.includes(id) ? 'one-of-one' : 'full') };
  });
  const frozenSet = { format: 'squarehole.misfits-frozen-set/1', n, entries };
  const records = entries.map((e) => testRender(e.id, e.attributes));
  return { frozenSet, records, renders: renderText(renderHeader(), records) };
}

/** Runtime-only synthetic inputs for production-path tests; never publish a new set of reusable placeholder hashes. */
export function randomTestSet(n: number, types: readonly R7Type[], oneOfOnes: readonly number[] = [], generatorTree = randomBytes(20).toString('hex')) {
  const set = testSet(n, types, oneOfOnes);
  const file = (bytes: number): TestFileHash => ({ bytes, sha256: `0x${randomBytes(32).toString('hex')}` });
  const records = set.records.map((r) => ({ ...r, image: file(r.image.bytes), avatar: file(r.avatar?.bytes ?? 5_000), model: file(r.model.bytes) }));
  return { frozenSet: set.frozenSet, records, generatorTree, renders: renderText(renderHeader({ generatorTree }), records) };
}

export function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

/** The message and stack of what `promise` rejects with, or '' when it resolves. */
export async function rejectionOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  }
  return '';
}
