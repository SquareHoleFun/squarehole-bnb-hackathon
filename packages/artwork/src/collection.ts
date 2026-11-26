/**
 * NFT item ids and collection completeness (SH-010; ART-02). Ids are DN404 token ids: whole numbers from 1 to
 * 2^32 − 2, compared after normalisation ("007" is 7). An image file is named after its id ("7.png"); a collection of
 * size N needs exactly one image and one attributes entry for every id 1 … N.
 */
import { DEMO_MAX_ITEMS, MAX_ITEM_ID } from './limits';

export type ItemIdResult = { readonly ok: true; readonly id: string } | { readonly ok: false; readonly message: string };

const ID_MESSAGE = `id must be a whole number from 1 to ${MAX_ITEM_ID.toLocaleString('en-US')}`;

/** Normalises an id given as text (ASCII digits only) or a JSON number. */
export function normaliseItemId(value: unknown): ItemIdResult {
  let digits: string | null = null;
  if (typeof value === 'string' && /^[0-9]{1,12}$/.test(value)) digits = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) digits = String(value);
  if (digits === null) return { ok: false, message: ID_MESSAGE };
  const id = BigInt(digits);
  if (id < 1n || id > MAX_ITEM_ID) return { ok: false, message: ID_MESSAGE };
  return { ok: true, id: id.toString() };
}

const FILE_NAME = /^([0-9]{1,12})\.(png|jpe?g|webp)$/i;

/** "7.png", "0007.JPG" → "7". Anything else is refused with a hint. */
export function itemIdFromFileName(name: string): ItemIdResult {
  const match = FILE_NAME.exec(name);
  if (!match?.[1]) return { ok: false, message: 'Name each image after its NFT id, for example 1.png, 2.jpg or 3.webp.' };
  const id = normaliseItemId(match[1]);
  return id.ok ? id : { ok: false, message: `The file name’s ${id.message}.` };
}

/** "1–3, 5, 7–8"; at most `limit` ranges, then "and n more". */
export function compactIdRanges(ids: readonly bigint[], limit = 12): string {
  const sorted = [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const ranges: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i] ?? 0n;
    let end = start;
    while (sorted[i + 1] === end + 1n) {
      i += 1;
      end = sorted[i] ?? end;
    }
    ranges.push(start === end ? `${start}` : `${start}–${end}`);
    i += 1;
  }
  if (ranges.length <= limit) return ranges.join(', ');
  return `${ranges.slice(0, limit).join(', ')} and ${ranges.length - limit} more`;
}

export interface CollectionImageRef {
  readonly id: string;
  readonly fileName: string;
}

export interface CollectionCheckInput {
  readonly collectionSize: bigint;
  readonly images: readonly CollectionImageRef[];
  /** Attributes keyed by normalised id, or null when no attributes file was added. */
  readonly attributes: ReadonlyMap<string, unknown> | null;
}

export interface CollectionReport {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

const grouped = (value: bigint): string => value.toLocaleString('en-US');

export function checkCollection({ collectionSize, images, attributes }: CollectionCheckInput): CollectionReport {
  if (collectionSize < 1n) return { ok: false, problems: ['Set a collection size of at least 1 NFT first.'] };
  if (collectionSize > BigInt(DEMO_MAX_ITEMS)) {
    return {
      ok: false,
      problems: [`This demo accepts uploads for up to ${grouped(BigInt(DEMO_MAX_ITEMS))} NFTs; the collection size is ${grouped(collectionSize)}.`],
    };
  }
  const problems: string[] = [];
  const size = Number(collectionSize); // ≤ DEMO_MAX_ITEMS here: a loop bound, not an amount.

  if (images.length === 0) {
    problems.push(`Add one image per NFT (ids 1–${collectionSize}).`);
  } else {
    const byId = new Map<string, string[]>();
    for (const image of images) byId.set(image.id, [...(byId.get(image.id) ?? []), image.fileName]);
    const missing: bigint[] = [];
    for (let id = 1; id <= size; id += 1) if (!byId.has(String(id))) missing.push(BigInt(id));
    if (missing.length > 0) problems.push(`Missing images for ids ${compactIdRanges(missing)}.`);
    const duplicates = [...byId.entries()].filter(([, names]) => names.length > 1);
    for (const [id, names] of duplicates.slice(0, 5)) problems.push(`Id ${id} has more than one image: ${names.join(', ')}.`);
    if (duplicates.length > 5) problems.push(`${duplicates.length - 5} more ids have more than one image.`);
    const beyond = [...byId.keys()].map(BigInt).filter((id) => id > collectionSize);
    if (beyond.length > 0) problems.push(`Images for ids beyond the collection size of ${grouped(collectionSize)}: ${compactIdRanges(beyond)}.`);
  }

  if (attributes === null) {
    problems.push('Add an attributes file (JSON or CSV).');
  } else {
    const missing: bigint[] = [];
    for (let id = 1; id <= size; id += 1) if (!attributes.has(String(id))) missing.push(BigInt(id));
    if (missing.length > 0) problems.push(`Missing attributes for ids ${compactIdRanges(missing)}.`);
    const beyond = [...attributes.keys()].map(BigInt).filter((id) => id > collectionSize);
    if (beyond.length > 0) problems.push(`Attributes for ids beyond the collection size of ${grouped(collectionSize)}: ${compactIdRanges(beyond)}.`);
  }
  return { ok: problems.length === 0, problems };
}
