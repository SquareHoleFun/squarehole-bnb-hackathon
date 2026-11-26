/**
 * The box row as the indexer and the site share it: re-exported from the chain package's decoder (one decoder for the
 * logs, `recordOf` and JSON), and box 0's platform cap from the BoxSpec constants. Browser-safe.
 */
export { boxRowFromJson, boxRowToJson, type BoxRow, type BoxRowJson } from '@squarehole/chain';
export { PLATFORM_CAP_WEI as PLATFORM_CAP_Q } from '@squarehole/box-spec';


import type { BoxRow as RowV1, RowOrigin } from '@squarehole/chain';
import { boxRowToJson as rowV1ToJson } from '@squarehole/chain';
import type { BoxRecordV2, BoxSpecV2, InboxWiringV21, ReleaseV2, RolesV2 } from './v2/chain-v2';
import type { PlugInMark } from './v2/discovery-v2';

/** V2 keeps its own spec and all 24 roles; it is never coerced into a v1 row. */
export interface BoxRowV2 extends Omit<BoxRecordV2, 'contracts' | 'codeHashes'>, RolesV2 {
  readonly protocol: 2;
  readonly chainId: number;
  readonly registry: `0x${string}`;
  readonly record: BoxRecordV2;
  readonly spec: BoxSpecV2;
  readonly encodedSpec: `0x${string}`;
  readonly origin: RowOrigin;
  readonly release: ReleaseV2;
  marks: readonly PlugInMark[];
  /** Authenticated immutable receiver snapshots, populated by discovery. */
  feeModules?: readonly { readonly module: `0x${string}`; readonly codeHash: `0x${string}` }[];
  /** Immutable wiring read from the authenticated inbox at creation, used for sale receipts. */
  inbox?: InboxWiringV21;
  pDecimals: number;
}
import type { SetSpecV2 } from '@squarehole/box-spec';
import type { SetReleaseManifest } from '@squarehole/chain/core/set-v2';
/** The add-on remains a third kind, with its original spec and no trust labels. */
export interface SetBoxRowV2 extends Omit<BoxRowV2, 'protocol' | 'spec' | 'release' | 'marks' | 'feeModules' | 'inbox'> {
  readonly protocol: 'set-v2';
  readonly spec: SetSpecV2;
  readonly release: SetReleaseManifest;
}
export type IndexedRow = RowV1 | BoxRowV2 | SetBoxRowV2;
export const isSetRowV2 = (row: IndexedRow): row is SetBoxRowV2 => 'protocol' in row && row.protocol === 'set-v2';
export const isRowV2 = (row: IndexedRow): row is BoxRowV2 => 'protocol' in row && row.protocol === 2;
export type JsonV2<T> = T extends bigint ? string : T extends readonly (infer U)[] ? readonly JsonV2<U>[] : T extends object ? { readonly [K in keyof T]: JsonV2<T[K]> } : T;
/** JSON transport: raw amounts and times stay decimal strings, including nested event fields. */
export function jsonV2<T>(value: T): JsonV2<T> {
  if (typeof value === 'bigint') return value.toString() as JsonV2<T>;
  if (Array.isArray(value)) return value.map((v: unknown) => jsonV2(v)) as JsonV2<T>;
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonV2(v)])) as JsonV2<T>;
  return value as JsonV2<T>;
}
export const indexedRowToJson = (row: IndexedRow) => (isRowV2(row) || isSetRowV2(row)) ? jsonV2(row) : rowV1ToJson(row);
