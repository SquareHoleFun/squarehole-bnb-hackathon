import { canonicalJson as sharedCanonicalJson } from '@squarehole/domain/canonical-json';
/**
 * Metadata manifest hash (SH-009 Step 3; SH-010): keccak-256 over a canonical JSON manifest, computed in the browser.
 * The canonical form is independent of input order and key insertion order, and every metadata field changes it.
 * The manifest has no financial fields at all (ART-03).
 */
import { describe, expect, it } from 'vitest';
import {
  MANIFEST_FORMAT,
  buildMetadataManifest,
  canonicalJson,
  keccak256Hex,
  manifestHash,
  type ManifestImage,
  type MetadataManifestInput,
} from './index';

const utf8 = (text: string) => new TextEncoder().encode(text);

const image = (seed: string): ManifestImage => ({ mediaType: 'image/png', width: 512, height: 512, bytes: 2048, keccak256: keccak256Hex(utf8(seed)) });

const collection = (): MetadataManifestInput => ({
  assetType: 'nft_collection',
  name: 'Tiny Trees',
  symbol: 'TREE',
  description: 'Small trees that fit the square hole.',
  items: [
    { id: '2', image: image('two'), attributes: [{ trait: 'Season', value: 'Winter' }, { trait: 'Background', value: 'Blue' }] },
    { id: '1', image: image('one'), attributes: [{ trait: 'Background', value: 'Green' }] },
    { id: '10', image: image('ten'), attributes: [] },
  ],
});

describe('keccak256Hex (@noble/hashes, pinned 2.4.0)', () => {
  it('matches the standard Keccak-256 vectors (not NIST SHA3-256)', () => {
    expect(keccak256Hex(utf8(''))).toBe('0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
    expect(keccak256Hex(utf8('abc'))).toBe('0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  });
});

describe('canonicalJson', () => {
  it('sorts keys by UTF-16 code units, keeps array order and adds no whitespace', () => {
    expect(canonicalJson({ b: '1', a: ['z', 'y'], A: { d: '', c: 'x' } })).toBe('{"A":{"c":"x","d":""},"a":["z","y"],"b":"1"}');
  });

  it('escapes strings exactly like JSON.stringify (RFC 8785 for string-only trees)', () => {
    const hostile = 'quote " backslash \\ newline \n tab \t nul \u0000 emoji 🍎 é';
    expect(canonicalJson({ s: hostile })).toBe(`{"s":${JSON.stringify(hostile)}}`);
  });

  it('rejects anything but strings, arrays and plain objects', () => {
    expect(() => canonicalJson({ n: 1 } as never)).toThrow(TypeError);
    expect(() => canonicalJson({ n: null } as never)).toThrow(TypeError);
    expect(() => canonicalJson({ n: true } as never)).toThrow(TypeError);
  });
});

describe('buildMetadataManifest', () => {
  it('writes a string-only manifest with items sorted by numeric id and traits by name', () => {
    const manifest = buildMetadataManifest(collection());
    expect(manifest.format).toBe(MANIFEST_FORMAT);
    expect(manifest.items?.map((item) => item.id)).toEqual(['1', '2', '10']);
    expect(manifest.items?.[1]?.attributes).toEqual([
      { trait: 'Background', value: 'Blue' },
      { trait: 'Season', value: 'Winter' },
    ]);
    expect(manifest.items?.[0]?.image).toEqual({ mediaType: 'image/png', width: '512', height: '512', bytes: '2048', keccak256: keccak256Hex(utf8('one')) });
    expect(manifest.logo).toBeUndefined();
  });

  it('has no financial field: only format, kind, identity text and art (ART-03)', () => {
    const token = buildMetadataManifest({ assetType: 'token', name: 'Round', symbol: 'RND', description: '', logo: image('logo') });
    expect(Object.keys(token).sort()).toEqual(['assetType', 'description', 'format', 'logo', 'name', 'symbol']);
    const nft = buildMetadataManifest(collection());
    expect(Object.keys(nft).sort()).toEqual(['assetType', 'description', 'format', 'items', 'name', 'symbol']);
  });

  it('keeps hostile trait text as inert strings inside the item', () => {
    const input = collection();
    const first = input.items?.[0];
    if (!first) throw new Error('fixture');
    const hostile = { ...input, items: [{ ...first, attributes: [{ trait: 'rewardSide', value: 'T' }, { trait: 'feePolicyId', value: 'NONE' }] }] };
    const manifest = buildMetadataManifest(hostile);
    expect(Object.keys(manifest)).not.toContain('rewardSide');
    expect(manifest.items?.[0]?.attributes).toEqual([
      { trait: 'feePolicyId', value: 'NONE' },
      { trait: 'rewardSide', value: 'T' },
    ]);
  });

  it('rejects a token with items, a collection with a logo, duplicate ids and duplicate traits', () => {
    expect(() => buildMetadataManifest({ ...collection(), assetType: 'token' })).toThrow(/token/);
    expect(() => buildMetadataManifest({ ...collection(), logo: image('x') })).toThrow(/logo/);
    const dup = collection();
    expect(() => buildMetadataManifest({ ...dup, items: [...(dup.items ?? []), { id: '01', image: image('again'), attributes: [] }] })).toThrow(/Duplicate item id/);
    expect(() =>
      buildMetadataManifest({ ...dup, items: [{ id: '1', image: image('a'), attributes: [{ trait: 'A', value: '1' }, { trait: 'A', value: '2' }] }] }),
    ).toThrow(/Duplicate trait/);
  });
});

describe('manifestHash', () => {
  it('is a 32-byte keccak-256 of the canonical manifest', () => {
    const input = collection();
    const hash = manifestHash(input);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hash).toBe(keccak256Hex(utf8(canonicalJson(buildMetadataManifest(input)))));
  });

  it('pins the canonical text of a small token manifest', () => {
    const input: MetadataManifestInput = { assetType: 'token', name: 'Round', symbol: 'RND', description: 'A "round" token', logo: image('logo') };
    expect(canonicalJson(buildMetadataManifest(input))).toBe(
      `{"assetType":"token","description":"A \\"round\\" token","format":"${MANIFEST_FORMAT}","logo":{"bytes":"2048","height":"512","keccak256":"${keccak256Hex(utf8('logo'))}","mediaType":"image/png","width":"512"},"name":"Round","symbol":"RND"}`,
    );
  });

  it('does not depend on item order, trait order or key insertion order', () => {
    const base = collection();
    const reordered: MetadataManifestInput = {
      items: [...(base.items ?? [])].reverse().map((item) => ({ attributes: [...item.attributes].reverse(), image: item.image, id: item.id })),
      description: base.description,
      symbol: base.symbol,
      name: base.name,
      assetType: base.assetType,
    };
    expect(manifestHash(reordered)).toBe(manifestHash(base));
  });

  it('changes when any metadata field changes', () => {
    const base = collection();
    const baseHash = manifestHash(base);
    const items = base.items ?? [];
    const variants: MetadataManifestInput[] = [
      { ...base, name: 'Tiny Tree' },
      { ...base, symbol: 'TREES' },
      { ...base, description: `${base.description} ` },
      { ...base, items: items.map((item, i) => (i === 0 ? { ...item, image: image('changed') } : item)) },
      { ...base, items: items.map((item, i) => (i === 0 ? { ...item, attributes: [{ trait: 'Season', value: 'Summer' }] } : item)) },
      { ...base, items: items.map((item, i) => (i === 2 ? { ...item, id: '3' } : item)) },
      { ...base, items: items.slice(0, 2) },
    ];
    const hashes = new Set(variants.map(manifestHash));
    expect(hashes.size).toBe(variants.length);
    expect(hashes.has(baseHash)).toBe(false);
  });
});

it('uses the same canonical bytes for artwork and chain reveal lists', () => {
  expect(canonicalJson).toBe(sharedCanonicalJson);
});
