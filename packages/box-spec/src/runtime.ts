/**
 * Runtime helpers of the generated BoxSpecV1 validator (src/generated/box-spec.v1.ts). Each mirrors a private helper of
 * the generated Solidity library packages/contracts/src/box/BoxSpecV1.sol line for line, so both return the same
 * (reason, field) for the same bytes (BC-001).
 */
import type { Hex } from 'viem';

/** validate()'s result: reason 0 (OK) with field 0, or the first failing check's reason and field id. */
export interface Verdict {
  readonly reason: number;
  readonly field: number;
}

/** Parameter kinds of the add-on tuples (Solidity `_K_*`). */
export const ParamKind = {
  UINT8: 1,
  UINT16: 2,
  UINT32: 3,
  UINT64: 4,
  UINT128: 5,
  UINT256: 6,
  BOOL: 7,
  ADDRESS: 8,
  BYTES32: 9,
  STRING: 10,
  BYTES32_ARRAY: 11,
} as const;

const REASON_OK = 0;
const REASON_LENGTH_OUT_OF_RANGE = 5;
const REASON_BAD_CHARACTER = 6;

type Ranges = readonly (readonly [number, number])[];

function allowed(c: number, ranges: Ranges): boolean {
  return ranges.some(([lo, hi]) => c >= lo && c <= hi);
}

/** Solidity `_hasPrefix`: no prefix, an empty string, or the bytes start with the rule's prefix. */
function hasPrefix(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (prefix.length === 0 || bytes.length === 0) return true;
  if (bytes.length < prefix.length) return false;
  return prefix.every((c, j) => bytes[j] === c);
}

/**
 * Solidity `_checkString`: the length bounds first, then every byte against the rule's ranges, then the rule's prefix
 * (a non-empty string must start with it; `RULE_PREFIXES`, empty for most rules).
 */
export function checkString(bytes: Uint8Array, minBytes: number, maxBytes: number, ranges: Ranges, prefix: readonly number[] = []): number {
  if (bytes.length < minBytes || bytes.length > maxBytes) return REASON_LENGTH_OUT_OF_RANGE;
  for (const c of bytes) {
    if (!allowed(c, ranges)) return REASON_BAD_CHARACTER;
  }
  return hasPrefix(bytes, prefix) ? REASON_OK : REASON_BAD_CHARACTER;
}

/** Solidity `_checkStringAt`: a string inside canonical params, its length word at `offset`. */
export function checkStringAt(
  p: Uint8Array,
  offset: bigint,
  minBytes: number,
  maxBytes: number,
  ranges: Ranges,
  prefix: readonly number[] = [],
): number {
  const start = Number(offset);
  const len = readWord(p, start);
  if (len < BigInt(minBytes) || len > BigInt(maxBytes)) return REASON_LENGTH_OUT_OF_RANGE;
  return checkString(p.subarray(start + 32, start + 32 + Number(len)), 0, Number.MAX_SAFE_INTEGER, ranges, prefix);
}

/**
 * Solidity `_tableV1`: the metadata table's format v1, BoxMetadataTable.validate's rules (core item 9): version byte 1,
 * a uint16 big-endian description length and the description, at most `maxTypes` types, then per type a name of at
 * least one byte, a value count of at least one and each value of at least one byte, every text within `ranges`
 * (JSON_TEXT), and nothing after the last value.
 */
export function tableV1(t: Uint8Array, maxTypes: number, ranges: Ranges): boolean {
  const len = t.length;
  if (len < 3 || t[0] !== 1) return false;
  let c = 3 + (((t[1] ?? 0) << 8) | (t[2] ?? 0));
  if (c >= len || !t.subarray(3, c).every((b) => allowed(b, ranges))) return false;
  const types = t[c] ?? 0;
  c += 1;
  if (types > maxTypes) return false;
  for (let i = 0; i < types; i++) {
    const afterName = tableText(t, c, ranges);
    if (afterName === null || afterName >= len) return false;
    const values = t[afterName] ?? 0;
    c = afterName + 1;
    if (values === 0) return false;
    for (let v = 0; v < values; v++) {
      const afterValue = tableText(t, c, ranges);
      if (afterValue === null) return false;
      c = afterValue;
    }
  }
  return c === len;
}

/** Solidity `_tableText`: a length byte of at least 1 at `c`, then that many bytes inside `t`, each within `ranges`. */
function tableText(t: Uint8Array, c: number, ranges: Ranges): number | null {
  if (c >= t.length) return null;
  const n = t[c] ?? 0;
  const end = c + 1 + n;
  if (n === 0 || end > t.length) return null;
  return t.subarray(c + 1, end).every((b) => allowed(b, ranges)) ? end : null;
}

/** The word at `offset` of canonical params (a bytes32[]'s length word, from `canonicalParams`). */
export function readWordAt(p: Uint8Array, offset: bigint): bigint {
  return readWord(p, Number(offset));
}

/** Solidity `_nonZeroItems`: every item of the canonical bytes32[] whose length word is at `offset` is non-zero. */
export function nonZeroItems(p: Uint8Array, offset: bigint): boolean {
  const start = Number(offset);
  const count = Number(readWord(p, start));
  for (let j = 0; j < count; j++) {
    if (readWord(p, start + 32 + 32 * j) === 0n) return false;
  }
  return true;
}

function readWord(p: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 0; i < 32; i++) v = (v << 8n) | BigInt(p[offset + i] ?? 0);
  return v;
}

function fits(kind: number, v: bigint): boolean {
  if (kind === ParamKind.UINT256 || kind === ParamKind.BYTES32) return true;
  if (kind === ParamKind.BOOL) return v <= 1n;
  if (kind === ParamKind.ADDRESS) return v >> 160n === 0n;
  // UINT8 ... UINT128: 8, 16, 32, 64 or 128 bits.
  return v >> (8n << BigInt(kind - 1)) === 0n;
}

/**
 * Solidity `_canonical`: the static values and the offsets of the dynamic parts (strings, bytes32[]) of `p` when it is
 * exactly the canonical abi.encode of a tuple of `kinds`, else null.
 */
export function canonicalParams(p: Uint8Array, kinds: readonly number[]): bigint[] | null {
  const size = BigInt(p.length);
  let cursor = BigInt(kinds.length * 32);
  if (size < cursor) return null;
  const words: bigint[] = [];
  for (const [i, kind] of kinds.entries()) {
    const v = readWord(p, i * 32);
    if (kind === ParamKind.STRING) {
      if (v !== cursor || size - cursor < 32n) return null;
      const len = readWord(p, Number(cursor));
      if (len > size) return null;
      const padded = (len + 31n) & ~31n;
      if (size - cursor - 32n < padded) return null;
      const end = cursor + 32n + padded;
      for (let j = Number(cursor + 32n + len); j < Number(end); j++) {
        if (p[j] !== 0) return null;
      }
      words.push(cursor);
      cursor = end;
    } else if (kind === ParamKind.BYTES32_ARRAY) {
      if (v !== cursor || size - cursor < 32n) return null;
      const count = readWord(p, Number(cursor));
      if (count > (size - cursor - 32n) / 32n) return null;
      words.push(cursor);
      cursor = cursor + 32n + 32n * count;
    } else {
      if (!fits(kind, v)) return null;
      words.push(v);
    }
  }
  return cursor === size ? words : null;
}

/** The i-th decoded word (a value, or a string's offset); `canonicalParams` returned one per kind. */
export function word(words: readonly bigint[], i: number): bigint {
  const v = words[i];
  if (v === undefined) throw new Error(`no decoded word ${i}`);
  return v;
}

export function hexLength(hex: Hex): number {
  return (hex.length - 2) / 2;
}

export function isZeroHex(hex: Hex): boolean {
  return /^0x0*$/.test(hex);
}

export function sameAddress(a: Hex, b: Hex): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
