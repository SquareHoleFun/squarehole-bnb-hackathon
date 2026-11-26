/**
 * Metadata manifest and its hash (SH-009 Step 3 "metadata hash"; SH-010). Computed in the browser; nothing is uploaded.
 *
 * Canonical form (documented in ADR-0008 addendum):
 *  - a tree of strings, arrays and plain objects only (numbers are written as decimal strings, so no float formatting
 *    question arises);
 *  - object keys sorted by UTF-16 code units, arrays in a defined order (items by numeric id, traits by trait name),
 *    no whitespace, strings escaped exactly as JSON.stringify does — i.e. RFC 8785 (JCS) for string-only trees;
 *  - hash = keccak-256 of the UTF-8 bytes, `0x` + 64 lower-case hex digits.
 * The manifest holds art and identity text only. It has no field for chain, quote asset, reward side, fees or supply,
 * so uploaded or generated metadata cannot change financial configuration (ART-03).
 */
import { canonicalJson } from '@squarehole/domain/canonical-json';
export { canonicalJson, type CanonicalValue } from '@squarehole/domain/canonical-json';
import type { Attribute } from './attributes';
import { keccak256Hex, type Hex32 } from './hash';

export const MANIFEST_FORMAT = 'squarehole.metadata-manifest/0.1-demo';

export interface ManifestImage {
  readonly mediaType: 'image/png';
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly keccak256: Hex32;
}

export interface ManifestItemInput {
  readonly id: string;
  readonly image: ManifestImage;
  readonly attributes: readonly Attribute[];
}

export interface MetadataManifestInput {
  readonly assetType: 'token' | 'nft_collection';
  readonly name: string;
  readonly symbol: string;
  readonly description: string;
  /** Token logo. */
  readonly logo?: ManifestImage;
  /** Collection items (ids 1 … N). */
  readonly items?: readonly ManifestItemInput[];
}

// Type aliases (not interfaces) so the manifest is assignable to CanonicalValue.
type CanonicalImage = {
  readonly mediaType: string;
  readonly width: string;
  readonly height: string;
  readonly bytes: string;
  readonly keccak256: string;
};

type CanonicalAttribute = { readonly trait: string; readonly value: string };

export type MetadataManifest = {
  readonly format: string;
  readonly assetType: string;
  readonly name: string;
  readonly symbol: string;
  readonly description: string;
  readonly logo?: CanonicalImage;
  readonly items?: readonly { readonly id: string; readonly image: CanonicalImage; readonly attributes: readonly CanonicalAttribute[] }[];
};

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function image(ref: ManifestImage): CanonicalImage {
  for (const n of [ref.width, ref.height, ref.bytes]) {
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('image sizes must be non-negative integers');
  }
  if (!/^0x[0-9a-f]{64}$/.test(ref.keccak256)) throw new RangeError('image hash must be 0x + 64 lower-case hex digits');
  return { mediaType: ref.mediaType, width: String(ref.width), height: String(ref.height), bytes: String(ref.bytes), keccak256: ref.keccak256 };
}

export function buildMetadataManifest(input: MetadataManifestInput): MetadataManifest {
  const base = { format: MANIFEST_FORMAT, assetType: input.assetType, name: input.name, symbol: input.symbol, description: input.description };
  if (input.assetType === 'token') {
    if (input.items !== undefined) throw new RangeError('a token manifest has a logo, not collection items');
    return input.logo === undefined ? base : { ...base, logo: image(input.logo) };
  }
  if (input.logo !== undefined) throw new RangeError('a collection manifest has item images, not a logo');
  const seen = new Set<string>();
  const items = (input.items ?? []).map((item) => {
    if (!/^[0-9]+$/.test(item.id)) throw new RangeError(`Item id "${item.id}" is not a whole number`);
    const id = BigInt(item.id);
    const key = id.toString();
    if (seen.has(key)) throw new RangeError(`Duplicate item id ${key}`);
    seen.add(key);
    const traits = new Set<string>();
    for (const attribute of item.attributes) {
      if (traits.has(attribute.trait)) throw new RangeError(`Duplicate trait "${attribute.trait}" on item ${key}`);
      traits.add(attribute.trait);
    }
    return {
      order: id,
      entry: {
        id: key,
        image: image(item.image),
        attributes: [...item.attributes].map((a) => ({ trait: a.trait, value: a.value })).sort((a, b) => byCodeUnits(a.trait, b.trait)),
      },
    };
  });
  items.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  return { ...base, items: items.map((item) => item.entry) };
}

/** keccak-256 of the canonical manifest (the `metadataManifestHash` of a launch draft). */
export function manifestHash(input: MetadataManifestInput): Hex32 {
  return keccak256Hex(new TextEncoder().encode(canonicalJson(buildMetadataManifest(input))));
}
