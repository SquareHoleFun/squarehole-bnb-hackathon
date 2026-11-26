import { decodeAbiParameters, encodeAbiParameters, hexToBytes, keccak256, stringToHex, zeroAddress, zeroHash, type AbiParameter, type Hex } from 'viem';
import { z } from 'zod';

export const SET_FORMAT = 2;
export const SET_SCHEMA = keccak256(stringToHex('SquareHole.SetSpecV2.v1'));
export const SET_RELEASE = keccak256(stringToHex('SquareHole.ExistingNFTs.v1'));
export const SET_TEMPLATE = keccak256(stringToHex('SquareHole.ExistingNFTs.PicksReturns.Grow.v1'));
export const SET_MIN_COUNT = 10;
export const SET_MAX_COUNT = 10000;
export const SET_MAX_PAGE = 32;
export const SET_RETURN_FEE_BPS = 500;
export const SET_GROW_CHOICE = 3;
export const SetReason = {
  OK: 0, UNSUPPORTED_VERSION: 1, NOT_A_MEMBER: 2, OUT_OF_RANGE: 4, LENGTH_OUT_OF_RANGE: 5,
  BAD_CHARACTER: 6, ZERO_VALUE: 7, RAISE_NOT_A_PRESET: 10, DEADLINE_RULE: 12,
  LISTING_UNKNOWN: 21, LISTING_MISMATCH: 22, FORBIDDEN_FIELD: 27, INVALID_TYPE: 28,
  NONCANONICAL_ABI: 29, COUNT_MISMATCH: 30, HASH_MISMATCH: 31, COLLECTION_MISMATCH: 32,
  NONZERO_TIER: 33, DUPLICATE_ID: 34, PAGE_SIZE: 35,
  // The admission probes' codes (SetConstantsV2.sol:41-46, SH-EXISTING-NFTS-E02); the pure validator never emits them.
  COLLECTION_NO_CODE: 36, INTERFACE_REFUSED: 37, TRANSFER_VALIDATOR: 38, LOCK_REFUSED: 39, OWNER_MISMATCH: 40, PROBE_GAS: 41,
} as const;
export const SetField = {
  format: 0, schema: 1, release: 2, tokenName: 3, tokenSymbol: 4, pricing: 5, raise: 6,
  openAt: 7, deadlineDays: 8, creatorBuy: 9, collection: 10, count: 11, setHash: 12,
  pickFeeBps: 13, description: 14, logoSha256: 15, global: 65535,
} as const;
export interface SetVerdict { reason: number; field: number }
export const setVerdict = (reason = 0, field = 0): SetVerdict => ({ reason, field });
// Explicit field, not a parameter property: scripts load this file through Node's type stripping, which refuses them.
export class SetValidationError extends Error {
  readonly verdict: SetVerdict;
  constructor(verdict: SetVerdict) {
    super(`SetRefused(${verdict.reason},${verdict.field})`);
    this.verdict = verdict;
  }
}
export const setAddressSchema = z.templateLiteral(['0x', z.string()]).refine((s) => /^0x[0-9a-fA-F]{40}$/.test(s));
const hash = z.templateLiteral(['0x', z.string()]).refine((s) => /^0x[0-9a-fA-F]{64}$/.test(s));
const uint = (bits: number) => z.number().int().min(0).max(2 ** bits - 1);
export const setUint256Schema = z.bigint().min(0n).max((1n << 256n) - 1n);
export const setDecimalSchema = z.string().regex(/^(0|[1-9][0-9]*)$/).transform((s) => BigInt(s)).pipe(setUint256Schema);
const pricingSchema = z.strictObject({ listingId: uint(32), token: setAddressSchema });
const specShape = {
  format: uint(16), schema: hash, release: hash, tokenName: z.string(), tokenSymbol: z.string(),
  pricing: pricingSchema, raise: setUint256Schema, openAt: uint(32), deadlineDays: uint(16),
  creatorBuy: setUint256Schema, collection: setAddressSchema, count: uint(32), setHash: hash,
  pickFeeBps: uint(16), description: z.string(), logoSha256: hash,
};
export const setSpecV2Schema = z.strictObject(specShape);
const wireSchema = z.strictObject({ ...specShape, raise: setDecimalSchema, creatorBuy: setDecimalSchema });
const contextSchema = z.strictObject({
  listing: z.strictObject({ id: uint(32), token: setAddressSchema, decimals: uint(8), class: uint(8), kind: uint(8), raise: setUint256Schema }),
  timestamp: setUint256Schema,
});
export type SetSpecV2 = z.infer<typeof setSpecV2Schema>;
export type SetValidationContext = z.infer<typeof contextSchema>;
export type SetSpecV2Wire = Omit<SetSpecV2, 'raise' | 'creatorBuy'> & { raise: string; creatorBuy: string };

/** Strict persisted data: numeric amounts, extra fields and noncanonical decimal strings are refused. */
export function parseSetSpecV2(input: unknown): SetSpecV2 { return wireSchema.parse(input); }
export function toSetSpecV2Wire(spec: SetSpecV2): SetSpecV2Wire {
  const s = setSpecV2Schema.parse(spec);
  return { ...s, raise: s.raise.toString(), creatorBuy: s.creatorBuy.toString() };
}
export const SET_SPEC_V2_ABI = {
  type: 'tuple', components: [
    { name: 'format', type: 'uint16' }, { name: 'schema', type: 'bytes32' }, { name: 'release', type: 'bytes32' },
    { name: 'tokenName', type: 'string' }, { name: 'tokenSymbol', type: 'string' },
    { name: 'pricing', type: 'tuple', components: [{ name: 'listingId', type: 'uint32' }, { name: 'token', type: 'address' }] },
    { name: 'raise', type: 'uint256' }, { name: 'openAt', type: 'uint32' }, { name: 'deadlineDays', type: 'uint16' },
    { name: 'creatorBuy', type: 'uint256' }, { name: 'collection', type: 'address' }, { name: 'count', type: 'uint32' },
    { name: 'setHash', type: 'bytes32' }, { name: 'pickFeeBps', type: 'uint16' }, { name: 'description', type: 'string' },
    { name: 'logoSha256', type: 'bytes32' },
  ],
} as const;
/** abi.encode(spec), including the dynamic tuple's initial offset. */
export function encodeSetSpecV2(spec: SetSpecV2): Hex {
  return encodeAbiParameters([SET_SPEC_V2_ABI], [setSpecV2Schema.parse(spec)]);
}
export function setSpecV2Hash(spec: SetSpecV2): Hex { return keccak256(encodeSetSpecV2(spec)); }
export function decodeSetSpecV2(encoded: Hex): SetSpecV2 {
  try {
    const [spec] = decodeAbiParameters([SET_SPEC_V2_ABI], encoded);
    if (encodeSetSpecV2(spec).toLowerCase() !== encoded.toLowerCase()) throw new Error('noncanonical');
    return spec;
  } catch {
    throw new SetValidationError(setVerdict(SetReason.NONCANONICAL_ABI, SetField.global));
  }
}
// ABI string and bytes have identical wire layouts. Preserve raw text bytes during validation so malformed
// UTF-8 receives Solidity's BAD_CHARACTER verdict instead of a JavaScript decoder/re-encoder mismatch.
const bytesAbi = { type: 'tuple', components: SET_SPEC_V2_ABI.components.map((c) =>
  c.type === 'string' ? { ...c, type: 'bytes' } : c,
) } as const satisfies AbiParameter;
export function validateEncodedSetSpecV2(encoded: Hex, ctx: SetValidationContext): SetVerdict {
  try {
    const [raw] = decodeAbiParameters([bytesAbi], encoded);
    if (encodeAbiParameters([bytesAbi], [raw]).toLowerCase() !== encoded.toLowerCase()) {
      return setVerdict(SetReason.NONCANONICAL_ABI, SetField.global);
    }
    return validateInput(raw, ctx, true);
  } catch { return setVerdict(SetReason.NONCANONICAL_ABI, SetField.global); }
}
function textReason(s: string, min: number, max: number, raw: boolean): number {
  const bytes = raw ? hexToBytes(s as Hex) : new TextEncoder().encode(s);
  if (bytes.length < min || bytes.length > max) return SetReason.LENGTH_OUT_OF_RANGE;
  return bytes.some((c) => c < 32 || c > 126 || c === 34 || c === 92) ? SetReason.BAD_CHARACTER : 0;
}
/** Pure structural admission; the factory must supply the real admitted pricing snapshot and block timestamp. */
export function validateSetSpecV2(input: unknown, context: unknown): SetVerdict {
  return validateInput(input, context, false);
}
function validateInput(input: unknown, context: unknown, rawText: boolean): SetVerdict {
  const parsed = setSpecV2Schema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const key = issue?.path[0];
    const field = typeof key === 'string' && key in SetField ? SetField[key as keyof typeof SetField] : SetField.global;
    return setVerdict(issue?.code === 'unrecognized_keys' ? SetReason.FORBIDDEN_FIELD : SetReason.INVALID_TYPE, field);
  }
  const ctxParsed = contextSchema.safeParse(context);
  if (!ctxParsed.success) return setVerdict(SetReason.INVALID_TYPE, SetField.global);
  const s = parsed.data, ctx = ctxParsed.data;
  if (s.format !== SET_FORMAT) return setVerdict(1, 0);
  if (s.schema.toLowerCase() !== SET_SCHEMA) return setVerdict(1, 1);
  if (s.release.toLowerCase() !== SET_RELEASE) return setVerdict(1, 2);
  let r = textReason(s.tokenName, 1, 32, rawText);
  if (r) return setVerdict(r, 3);
  r = textReason(s.tokenSymbol, 1, 11, rawText);
  if (r) return setVerdict(r, 4);
  if (ctx.listing.kind === 0 || ctx.listing.id !== s.pricing.listingId) return setVerdict(21, 5);
  if (ctx.listing.token.toLowerCase() !== s.pricing.token.toLowerCase()
    || (s.pricing.listingId === 0) !== (s.pricing.token.toLowerCase() === zeroAddress)) return setVerdict(22, 5);
  if (s.raise === 0n || s.raise !== ctx.listing.raise) return setVerdict(10, 6);
  if (s.openAt !== 0 && (s.openAt < 1788220800 || BigInt(s.openAt) - ctx.timestamp > 1209600n)) return setVerdict(4, 7);
  if (![30, 60, 90, 180].includes(s.deadlineDays)) return setVerdict(12, 8);
  if (s.creatorBuy >= s.raise) return setVerdict(4, 9);
  if (s.collection.toLowerCase() === zeroAddress) return setVerdict(7, 10);
  if (s.count < SET_MIN_COUNT || s.count > SET_MAX_COUNT) return setVerdict(4, 11);
  if (s.setHash === zeroHash) return setVerdict(7, 12);
  if (![100, 500, 2500].includes(s.pickFeeBps)) return setVerdict(2, 13);
  r = textReason(s.description, 0, 1024, rawText);
  if (r) return setVerdict(r, 14);
  if (s.logoSha256 === zeroHash) return setVerdict(7, 15);
  return setVerdict();
}
