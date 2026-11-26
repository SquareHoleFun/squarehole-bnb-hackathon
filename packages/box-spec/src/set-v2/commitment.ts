import { encodeAbiParameters, keccak256, zeroAddress, zeroHash, type Address, type Hex } from 'viem';
import { z } from 'zod';
import {
  SET_MAX_COUNT, SET_MAX_PAGE, SET_MIN_COUNT, SetField as F, SetReason as R, SetValidationError,
  setAddressSchema, setDecimalSchema, setUint256Schema, setVerdict, type SetVerdict,
} from './spec';

export interface SetCommitment { collection: Address; count: number; setHash: Hex }
export interface SetPage { collections: Address[]; ids: bigint[]; tiers: number[]; nextHash: Hex }
export interface SetPageWire extends Omit<SetPage, 'ids'> { ids: string[] }
const hashSchema = z.templateLiteral(['0x', z.string()]).refine((s) => /^0x[0-9a-fA-F]{64}$/.test(s));
const commitmentSchema = z.strictObject({ collection: setAddressSchema, count: z.number().int().min(0).max(0xffffffff), setHash: hashSchema });
const pageShape = {
  collections: z.array(setAddressSchema), ids: z.array(setUint256Schema),
  tiers: z.array(z.number().int().min(0).max(255)), nextHash: hashSchema,
};
const pageSchema = z.strictObject(pageShape);
export function parseSetPage(input: unknown): SetPage {
  return z.strictObject({ ...pageShape, ids: z.array(setDecimalSchema) }).parse(input);
}
export function toSetPageWire(page: SetPage): SetPageWire {
  const p = pageSchema.parse(page);
  return { ...p, ids: p.ids.map(String) };
}
/** Exactly the unchanged loader's four-word abi.encode preimage; never packed. */
export function encodeSetLink(collection: Address, id: bigint, nextHash: Hex): Hex {
  return encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'bytes32' }],
    [setAddressSchema.parse(collection), setUint256Schema.parse(id), 0, hashSchema.parse(nextHash)],
  );
}
export function setLinkHash(collection: Address, id: bigint, nextHash: Hex): Hex {
  return keccak256(encodeSetLink(collection, id, nextHash));
}
function refuse(reason: number, field: number): never { throw new SetValidationError(setVerdict(reason, field)); }
export function buildSetCommitment(collection: Address, input: readonly unknown[], pageSize = SET_MAX_PAGE): {
  commitment: SetCommitment; pages: SetPage[];
} {
  setAddressSchema.parse(collection);
  if (collection.toLowerCase() === zeroAddress) refuse(R.ZERO_VALUE, F.collection);
  if (input.length < SET_MIN_COUNT || input.length > SET_MAX_COUNT) refuse(R.OUT_OF_RANGE, F.count);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > SET_MAX_PAGE) refuse(R.PAGE_SIZE, F.global);
  const ids = input.map((id) => typeof id === 'string' ? setDecimalSchema.parse(id) : setUint256Schema.parse(id));
  if (new Set(ids).size !== ids.length) refuse(R.DUPLICATE_ID, F.setHash);
  const hashes: Hex[] = new Array<Hex>(ids.length + 1).fill(zeroHash);
  for (let i = ids.length - 1; i >= 0; --i) {
    const id = ids[i], next = hashes[i + 1];
    if (id === undefined || next === undefined) throw new Error('set index');
    hashes[i] = setLinkHash(collection, id, next);
  }
  const pages: SetPage[] = [];
  for (let start = 0; start < ids.length; start += pageSize) {
    const end = Math.min(start + pageSize, ids.length);
    const nextHash = hashes[end];
    if (!nextHash) throw new Error('set suffix');
    pages.push({ collections: Array<Address>(end - start).fill(collection), ids: ids.slice(start, end), tiers: Array<number>(end - start).fill(0), nextHash });
  }
  const setHash = hashes[0];
  if (!setHash) throw new Error('set root');
  return { commitment: { collection, count: ids.length, setHash }, pages };
}
/** Verifies the complete published list, including duplicate ids across arbitrary page boundaries. */
export function verifySetPages(input: SetCommitment, inputPages: readonly SetPage[]): SetVerdict {
  const c = commitmentSchema.safeParse(input), p = z.array(pageSchema).safeParse(inputPages);
  if (!c.success || !p.success) return setVerdict(R.INVALID_TYPE, F.global);
  const commitment = c.data, pages = p.data;
  if (commitment.collection.toLowerCase() === zeroAddress) return setVerdict(R.ZERO_VALUE, F.collection);
  if (commitment.count < SET_MIN_COUNT || commitment.count > SET_MAX_COUNT) return setVerdict(R.OUT_OF_RANGE, F.count);
  if (commitment.setHash === zeroHash) return setVerdict(R.ZERO_VALUE, F.setHash);
  if (pages.length === 0 || pages.length > commitment.count) return setVerdict(R.COUNT_MISMATCH, F.count);
  let loaded = 0, remaining = commitment.setHash.toLowerCase();
  const seen = new Set<bigint>();
  let duplicate = false;
  for (const page of pages) {
    const size = page.ids.length;
    if (size === 0 || size > SET_MAX_PAGE || page.collections.length !== size || page.tiers.length !== size) return setVerdict(R.PAGE_SIZE, F.global);
    loaded += size;
    if (loaded > commitment.count || (loaded === commitment.count) !== (page.nextHash === zeroHash)) return setVerdict(R.COUNT_MISMATCH, F.count);
    for (let i = 0; i < size; ++i) {
      if (page.collections[i]?.toLowerCase() !== commitment.collection.toLowerCase()) return setVerdict(R.COLLECTION_MISMATCH, F.collection);
      if (page.tiers[i] !== 0) return setVerdict(R.NONZERO_TIER, F.setHash);
    }
    let hash = page.nextHash;
    for (const id of [...page.ids].reverse()) hash = setLinkHash(commitment.collection, id, hash);
    if (hash.toLowerCase() !== remaining) return setVerdict(R.HASH_MISMATCH, F.setHash);
    for (const id of page.ids) { if (seen.has(id)) duplicate = true; seen.add(id); }
    remaining = page.nextHash.toLowerCase();
  }
  if (loaded !== commitment.count || remaining !== zeroHash) return setVerdict(R.COUNT_MISMATCH, F.count);
  return duplicate ? setVerdict(R.DUPLICATE_ID, F.setHash) : setVerdict();
}
