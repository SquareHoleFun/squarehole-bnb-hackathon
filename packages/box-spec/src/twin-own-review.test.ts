/**
 * Box 0's own review (F147), the TypeScript twin's three off-chain findings (docs/evidence/SH-AUDIT-B0-DOCFIX.md):
 *
 * - W3-U9-1 (FQ-34): `validateEncodedBoxSpecV1` and `specHashOfEncoded` take ABI bytes from anywhere. Solidity's
 *   `abi.decode` reverts on a static word with bits above its type; viem keeps an address word's low 20 bytes and reads
 *   a uintN word whole. The 19 dirty encodings of box 0's fixture below (the U9 proof's cases: one byte set in a head
 *   word) all revert in Solidity (AuditU9ClaudeTwin.t.sol on sh-audit-b0-u9-claude), so the twin must throw on each;
 *   it refuses every non-canonical encoding (bytes whose canonical re-encoding differs), so it never hashes other bytes
 *   than those given.
 * - W3-U9-2 (FQ-35): `contextForBuild` maps the raise only; add-on 5's presets stay mainnet's until version 2's
 *   creation page goes to Sepolia, and build-profile.ts says so.
 * - W3-U9-3 (FQ-36): core v1 builds the per-item stream (S8) and Sepolia's box 0 runs it, so Sepolia's list offers
 *   PER_ITEM_STREAM and box 0's fixture passes there.
 */
import { readFileSync } from 'node:fs';
import { bytesToHex, concat, hexToBytes, keccak256, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  BOX_0_MISFITS,
  BOX_0_MISFITS_SPEC_HASH,
  BOX_SPEC_V1_BYTES_ABI,
  BUILD_PROFILE_MAINNET,
  BUILD_PROFILE_REHEARSAL,
  CONTEXT_V1,
  CONTEXT_V2,
  NOT_BUILT,
  OFFERED_AMOUNTS,
  OFFERED_ON,
  Reason,
  TStream,
  contextForBuild,
  encodeBoxSpecV1Bytes,
  specHashOfEncoded,
  toBoxSpecV1Bytes,
  validateBoxSpecV1,
  validateEncodedBoxSpecV1,
} from './index';

const FIELDS: readonly string[] = BOX_SPEC_V1_BYTES_ABI.components.map((c) => c.name);
const BOX0: Hex = encodeBoxSpecV1Bytes(toBoxSpecV1Bytes(BOX_0_MISFITS));
/** The head word of `field` in the encoding of `[BoxSpecV1]` (one tuple with dynamic members: its offset word first). */
const head = (field: string): number => {
  const i = FIELDS.indexOf(field);
  expect(i, field).toBeGreaterThanOrEqual(0);
  return 32 + 32 * i;
};
/** [field, byte within its head word, the byte's new value]: every one gives the word bits above its type. */
const DIRTY: readonly (readonly [string, number, number])[] = [
  ['q', 0, 0x01], ['q', 11, 0x01], ['marketplaceOwner', 0, 0xff], ['marketplaceOwner', 11, 0x80],
  ['creatorFeeRecipient', 0, 0x01], ['creatorFeeRecipient', 11, 0x01],
  ['openAt', 27, 0x01], ['openAt', 0, 0x01], ['n', 27, 0x01], ['n', 0, 0x80],
  ['version', 29, 0x01], ['boxType', 30, 0x01], ['layout', 30, 0x01], ['gradLayout', 0, 0x01], ['launchFormat', 30, 0x02],
  ['deadlineDays', 29, 0x01], ['qStream', 30, 0x01], ['tStream', 30, 0x01], ['artMode', 30, 0x01],
];
const dirty = (field: string, at: number, value: number): Hex => {
  const bytes = hexToBytes(BOX0);
  const offset = head(field) + at;
  expect(bytes[offset], `${field} byte ${at} is clean in the canonical encoding`).toBe(0);
  bytes[offset] = value;
  return bytesToHex(bytes);
};

describe('W3-U9-1: the twin refuses bytes that are not canonical ABI', () => {
  it('the canonical encoding of box 0 still validates and hashes to keccak256 of its bytes (control)', () => {
    expect(validateEncodedBoxSpecV1(BOX0, CONTEXT_V1)).toEqual({ reason: Reason.OK, field: 0 });
    expect(specHashOfEncoded(BOX0)).toBe(keccak256(BOX0));
    expect(specHashOfEncoded(BOX0)).toBe(BOX_0_MISFITS_SPEC_HASH);
    expect(validateEncodedBoxSpecV1(BOX0.toUpperCase().replace(/^0X/, '0x') as Hex, CONTEXT_V1)).toEqual({ reason: Reason.OK, field: 0 });
  });

  it.each(DIRTY)('%s with byte %i set to %i: both functions throw, as abi.decode reverts', (field, at, value) => {
    const encoded = dirty(field, at, value);
    expect(() => validateEncodedBoxSpecV1(encoded, CONTEXT_V1)).toThrow();
    expect(() => specHashOfEncoded(encoded)).toThrow();
  });

  it('bytes Solidity would still decode but that are not canonical (trailing bytes) are refused too', () => {
    const trailing = concat([BOX0, `0x${'00'.repeat(32)}`]);
    expect(() => validateEncodedBoxSpecV1(trailing, CONTEXT_V1)).toThrow();
    expect(() => specHashOfEncoded(trailing)).toThrow();
  });
});

describe('W3-U9-2: the build profile maps the raise only', () => {
  it('the rehearsal context scales the native-ETH raise; add-on 5 keeps mainnet presets, and build-profile.ts says so', () => {
    const rehearsal = contextForBuild(CONTEXT_V2, BUILD_PROFILE_REHEARSAL);
    const eth = rehearsal.qList.find((q) => /^0x0{40}$/.test(q.token));
    expect(eth?.raisePresets).toContain(BUILD_PROFILE_REHEARSAL.values.RAISE);
    expect(eth?.raisePresets).not.toContain(BUILD_PROFILE_MAINNET.values.RAISE);
    const presets = ['CREATOR_FEE_CAP_PRESET_0', 'CREATOR_FEE_CAP_PRESET_1', 'CREATOR_FEE_CAP_PRESET_2', 'CREATOR_FEE_CAP_PRESET_3', 'CREATOR_FEE_CAP_PRESET_4'] as const;
    expect(OFFERED_AMOUNTS['addOns.creator-fee-cap.capPerEpoch']).toEqual(presets.map((k) => BUILD_PROFILE_MAINNET.values[k]));
    expect(OFFERED_AMOUNTS['addOns.creator-fee-cap.capPerEpoch']).not.toEqual(presets.map((k) => BUILD_PROFILE_REHEARSAL.values[k]));
    const text = readFileSync(new URL('./build-profile.ts', import.meta.url), 'utf8');
    expect(text).toContain("add-on 5's creator-fee-cap presets stay mainnet's");
  });
});

describe('W3-U9-3: Sepolia offers the per-item stream (built in S8)', () => {
  it("box 0's fixture passes on every network and PER_ITEM_STREAM is on Sepolia's list", () => {
    for (const network of ['mainnet', 'sepolia', 'demo'] as const) {
      expect(validateBoxSpecV1(BOX_0_MISFITS, CONTEXT_V1, network), network).toEqual({ reason: Reason.OK, field: 0 });
    }
    expect(OFFERED_ON.sepolia.tStream).toContain(TStream.PER_ITEM_STREAM);
    expect(NOT_BUILT.TStream?.PER_ITEM_STREAM).toBeUndefined();
  });
});
