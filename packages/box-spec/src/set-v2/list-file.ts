import type { Address } from 'viem';
import { z } from 'zod';
import { buildSetCommitment, type SetCommitment } from './commitment';
import { SET_MAX_COUNT, SET_MIN_COUNT, setAddressSchema, setDecimalSchema } from './spec';

export const SET_LIST_SCHEMA = 'squarehole.set-list/1';
const listSchema = z.strictObject({
  schema: z.literal(SET_LIST_SCHEMA), collection: setAddressSchema,
  count: z.number().int().min(SET_MIN_COUNT).max(SET_MAX_COUNT),
  setHash: z.templateLiteral(['0x', z.string()]).refine(s => /^0x[0-9a-fA-F]{64}$/.test(s)),
  ids: z.array(setDecimalSchema).min(SET_MIN_COUNT).max(SET_MAX_COUNT),
});
export interface SetListFile extends SetCommitment { readonly schema: typeof SET_LIST_SCHEMA; readonly ids: string[] }
export interface ParsedSetList { readonly commitment: SetCommitment; readonly ids: bigint[] }

/** Produces JSON-safe data without sorting. A numeric id is refused even when exactly representable. */
export function createSetListFile(collection: Address, ids: readonly bigint[]): SetListFile {
  const { commitment, pages } = buildSetCommitment(collection, ids);
  return { schema: SET_LIST_SCHEMA, ...commitment, ids: pages.flatMap(page => page.ids.map(String)) };
}
/** Parse JSON data, rehash the ordered full list, then bind it to the independently obtained spec commitment. */
export function parseSetListFile(input: unknown, expected: SetCommitment): ParsedSetList {
  const file = listSchema.parse(input);
  const { commitment } = buildSetCommitment(file.collection, file.ids);
  if (file.collection.toLowerCase() !== expected.collection.toLowerCase()) throw new Error('set list collection mismatch');
  if (file.count !== commitment.count || file.count !== expected.count) throw new Error('set list count mismatch');
  if (file.setHash.toLowerCase() !== commitment.setHash || file.setHash.toLowerCase() !== expected.setHash.toLowerCase()) throw new Error('set list hash mismatch');
  return { commitment, ids: file.ids };
}
