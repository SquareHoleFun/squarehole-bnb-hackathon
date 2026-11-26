/** Test data for the creation page: a valid draft (form, art, logo, collection cover, page pictures, owner) in a few lines. */
import { sha256Hex } from '@squarehole/artwork';
import type { Address } from '@squarehole/domain';
import { toBase64 } from '../art-files';
import { DEFAULT_FORM, EMPTY_PAGE, commitArt, type ArtState, type BuildInput, type CoverState, type CreateForm, type PageState } from '../create-model';

export const OWNER = '0xDe00000000000000000000000000000000000A11' as Address;
export const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const utf8 = (text: string) => new TextEncoder().encode(text);
const COLOURS = ['Red', 'Teal', 'Gold'] as const;
const SHAPES = ['Square', 'Circle'] as const;

/** N items with ids 1..N, two trait types, a salt each. */
export function artOf(n = 12, { traits = true }: { traits?: boolean } = {}): ArtState {
  const items = Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    imageSha256: sha256Hex(utf8(`image-${i + 1}`)),
    traits: traits
      ? [
          { trait: 'Colour', value: COLOURS[i % 3] as string },
          { trait: 'Shape', value: SHAPES[i % 2] as string },
        ]
      : [],
    bytes: 1_000,
  }));
  return { items, salts: items.map((item) => sha256Hex(utf8(`salt-${item.id}`))), thumbs: [], totalBytes: n * 1_000, problems: [] };
}

/** The item files `artOf`'s hashes were taken of, by sha256, as a visit that read the art keeps them (item-files.ts). */
export function itemFilesOf(n = 12): Map<string, Blob> {
  return new Map(Array.from({ length: n }, (_, i) => [sha256Hex(utf8(`image-${i + 1}`)), new Blob([`image-${i + 1}`])] as const));
}

/** A processed picture of these bytes (as the page keeps it: hash, size, base64; a thumbnail when given). */
export function pictureOf(text: string, url: string | null = null): CoverState {
  const bytes = utf8(text);
  return Object.freeze({ sha256: sha256Hex(bytes), url, bytes: bytes.length, data: toBase64(bytes) });
}

export const COVER: CoverState = pictureOf('cover bytes as re-encoded');
export const THUMB = 'data:image/png;base64,iVBORw0KGgo=';
/** A new collection's own cover (field 28, F74 U3): a different picture from the logo. */
export const COLLECTION_COVER: CoverState = pictureOf('collection cover bytes as re-encoded', THUMB);
/** A banner and three teasers (add-on 6). */
export const PAGE: PageState = Object.freeze({ banner: pictureOf('banner bytes', THUMB), teasers: Object.freeze([1, 2, 3].map((i) => pictureOf(`teaser ${i}`, THUMB))) });

/** A new collection named Paper Moons / MOON, on the defaults. */
export const formOf = (patch: Partial<CreateForm> = {}): CreateForm => ({ ...DEFAULT_FORM, name: 'Paper Moons', ticker: 'MOON', contents: 'collection', ...patch });
/** "Token": Paper Moons / MOON, no collection. */
export const tokenFormOf = (patch: Partial<CreateForm> = {}): CreateForm => formOf({ contents: 'token', ...patch });

/** A complete, valid build input; override any part. */
export function inputOf(patch: Partial<BuildInput> & { form?: CreateForm } = {}): BuildInput {
  const art = patch.art === undefined ? artOf() : patch.art;
  return {
    form: patch.form ?? formOf(),
    art,
    commitment: patch.commitment === undefined ? commitArt(art, (patch.form ?? formOf()).artMode) : patch.commitment,
    cover: patch.cover === undefined ? COVER : patch.cover,
    collectionCover: patch.collectionCover === undefined ? COLLECTION_COVER : patch.collectionCover,
    page: patch.page ?? EMPTY_PAGE,
    owner: patch.owner === undefined ? OWNER : patch.owner,
    nowMs: patch.nowMs ?? NOW,
  };
}
