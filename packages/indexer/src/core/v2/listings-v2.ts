/** CQ11 permanent manual listings. Raises update the row; existing boxes keep their creation record's raise. */
import { formatUnits, parseDecimal, type DecimalAmount } from '@squarehole/domain';
import { decodeFunctionResult, encodeFunctionData, getAddress, isAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';
import type { CoreReader } from '../core-reader';
import type { CoreEventV2 } from './events-v2';
import { readCheckedBurnV21, ENUM_NAMES_V2, enumName, listingRegistryV2Abi, type BoxRecordV2, type ReleaseV2 } from './chain-v2';

export interface ListingV2 {
  /** Only an authenticated v2.1 admission event/read supplies this; absence is unknown on an older release. */
  readonly checkedBurnSelector?: Hex;
  readonly id: number;
  readonly token: Address;
  readonly class: string;
  readonly kind: string;
  readonly raise: bigint;
}

export interface ListingBookV2 {
  readonly listings: readonly ListingV2[];
  byId(id: number): ListingV2 | null;
  /** At most one row per coin. */
  ofToken(token: Address): readonly ListingV2[];
  /** Historical API name: returns the permanent row, not a relisting. */
  newestOf(token: Address): ListingV2 | null;
}
const lower = (a: string): string => a.toLowerCase();

/** Events of one registry/canonical chain, applied by block then log index without mutating the input. */
export function listingBookV2(events: readonly CoreEventV2[]): ListingBookV2 {
  const byId = new Map<number, ListingV2>();
  const ordered = [...events].sort((a, b) => a.ref.blockNumber === b.ref.blockNumber
    ? a.ref.logIndex - b.ref.logIndex : a.ref.blockNumber < b.ref.blockNumber ? -1 : 1);
  for (const e of ordered) {
    if (e.source !== 'listingRegistry') continue;
    const a = e.args;
    const id = a.id as number;
    if (e.name === 'ListingAdded') {
      if (byId.has(id) || [...byId.values()].some((row) => lower(row.token) === lower(a.token as string))) throw new Error('listing record repeats a permanent identity');
      byId.set(id, { id, token: getAddress(a.token as string), class: enumName('ListingClass', a.class as number), kind: enumName('ListingKind', a.kind as number), raise: a.raise as bigint });
    } else if (e.name === 'CheckedBurnRecorded') {
      const row = byId.get(id);
      if (!row || lower(row.token) !== lower(a.token as string) || row.token === '0x0000000000000000000000000000000000000000'
        || row.checkedBurnSelector !== undefined || a.selector !== '0x42966c68') throw new Error('invalid checked-burn listing event');
      byId.set(id, { ...row, checkedBurnSelector: a.selector });
    } else if (e.name === 'RaiseUpdated') {
      const row = byId.get(id);
      if (!row) throw new Error(`raise update for unknown listing ${id}`);
      if (a.previousRaise !== row.raise) throw new Error('listing record previous raise differs from its event');
      byId.set(id, { ...row, raise: a.raise as bigint });
    }
  }
  const listings = Object.freeze([...byId.values()].sort((a, b) => a.id - b.id).map((row) => Object.freeze(row)));
  const index = new Map(listings.map((row) => [row.id, row]));
  return Object.freeze({
    listings,
    byId: (id: number) => index.get(id) ?? null,
    ofToken: (token: Address) => listings.filter((row) => lower(row.token) === lower(token)),
    newestOf: (token: Address) => listings.find((row) => lower(row.token) === lower(token)) ?? null,
  });
}

/** Each box's immutable creation raise, including boxes created before a lister's update. */
export function boxesOnListingV2(book: ListingBookV2, id: number, records: readonly BoxRecordV2[]): { readonly boxId: bigint; readonly raise: bigint }[] {
  if (!book.byId(id)) return [];
  return records.filter((r) => r.pricingListingId === id).map((r) => ({ boxId: r.boxId, raise: r.raise }));
}

export interface QParametersV2 {
  readonly bootstrapQ: bigint;
  readonly batchMinQ: bigint;
  readonly tipMaxQ: bigint;
  readonly swapStepMinQ: bigint;
}
export interface ListingDetailV2 extends ListingV2 {
  readonly decimals: number;
  readonly listedAt: bigint;
  readonly q: QParametersV2;
}
export type ListingReaderV2 = Pick<CoreReader, 'callAt'>;

/** One permanent row at a block hash. No converter or route discovery exists in CQ11. */
export async function readListingDetailV2(reader: ListingReaderV2, release: ReleaseV2, id: number, blockHash: Hex): Promise<ListingDetailV2> {
  const data = encodeFunctionData({ abi: listingRegistryV2Abi, functionName: 'listing', args: [id] });
  const encoded = await reader.callAt(release.listingRegistry.address, data, blockHash);
  const row = decodeFunctionResult({ abi: listingRegistryV2Abi, functionName: 'listing', data: encoded });
  return { ...row, q: { ...row.q }, class: enumName('ListingClass', row.class), kind: enumName('ListingKind', row.kind) };
}

/** V2.1 entry for launch/site callers that need an explicit burn-or-lock answer; no fallback on failed reads. */
export async function readListingDetailV21(reader: ListingReaderV2, release: ReleaseV2, id: number, hash: Hex): Promise<ListingDetailV2> {
  const row = await readListingDetailV2(reader, release, id, hash);
  const checkedBurnSelector = await readCheckedBurnV21(reader, release.listingRegistry.address, row.token, hash);
  return { ...row, checkedBurnSelector };
}

/** Validate canonical permanent-row identity and current raise against its ordered events. */
export function validateListingDetailV2(detail: ListingDetailV2, event: ListingV2, previous?: ListingDetailV2): void {
  // The same strict boundary as the offline representation checks decimals, enum values and raw amount domains.
  listingDetailFromJson(listingDetailToJson(detail));
  if (detail.id !== event.id || lower(detail.token) !== lower(event.token) || detail.class !== event.class
    || detail.kind !== event.kind || detail.raise !== event.raise || detail.class === 'NONE' || detail.kind === 'NONE') {
    throw new Error('listing record differs from its event');
  }
  if (detail.checkedBurnSelector !== undefined && event.checkedBurnSelector !== undefined && detail.checkedBurnSelector !== event.checkedBurnSelector) {
    throw new Error('listing checked-burn capability differs from its event');
  }
  if (previous?.checkedBurnSelector !== undefined && previous.checkedBurnSelector !== detail.checkedBurnSelector) {
    throw new Error('listing checked-burn capability changed');
  }
  if (previous && (detail.decimals !== previous.decimals || detail.listedAt !== previous.listedAt)) {
    throw new Error('listing record changed immutable fields');
  }
}

/** A raw amount in the listing's decimals, exact ("12345.678901" for 12,345,678,901 at 6 decimals). */
export function listingAmountV2(raw: bigint, decimals: number): DecimalAmount {
  return formatUnits(raw, decimals);
}

/** The raw amount of a decimal string in `decimals`; more fraction digits than the token has are refused. */
export function rawFromListingAmountV2(display: string, decimals: number): bigint {
  const { units, scale } = parseDecimal(display);
  if (scale > decimals) throw new RangeError(`${display} has more than ${decimals} decimals`);
  return units * 10n ** BigInt(decimals - scale);
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const toJson = (value: unknown): Json => {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(toJson);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJson(v)]));
  return value as Json;
};

/** The JSON form: every bigint as a decimal string. */
export function listingDetailToJson(detail: ListingDetailV2): Json {
  return toJson(detail);
}

const MAX_DECIMALS = 36;
const address = z.string().refine((v) => isAddress(v), 'not an address (0x, 20 bytes, a valid checksum)').transform((v) => getAddress(v));
const rawAmount = z.string().regex(/^(0|[1-9][0-9]*)$/, 'not a raw decimal amount').transform((v) => BigInt(v));
const memberOf = (kind: 'ListingClass' | 'ListingKind') => z.enum(ENUM_NAMES_V2[kind] as [string, ...string[]]);
const small = (max: number) => z.number().int().min(0).max(max);

/** The JSON form of `ListingDetailV2` (the offline copy, `listings.sepolia.json`): every field checked. */
const listingDetailJson = z
  .object({
    id: small(0xffff_ffff),
    token: address,
    decimals: small(MAX_DECIMALS),
    class: memberOf('ListingClass'),
    kind: memberOf('ListingKind'),
    checkedBurnSelector: z.string().regex(/^0x(?:00000000|42966c68)$/).optional(),
    listedAt: rawAmount,
    raise: rawAmount,
    q: z.object({ bootstrapQ: rawAmount, batchMinQ: rawAmount, tipMaxQ: rawAmount, swapStepMinQ: rawAmount }).strict(),
  })
  .strict();

/** The JSON form back, parsed by schema (addresses, decimals 0-36, enum names, amounts as raw decimal strings). */
export function listingDetailFromJson(json: unknown): ListingDetailV2 {
  const parsed = listingDetailJson.safeParse(json);
  if (!parsed.success) throw new TypeError(`listing JSON: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  return parsed.data as ListingDetailV2;
}
