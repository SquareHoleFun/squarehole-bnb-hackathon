/**
 * F-1 (SH-V21-EXAMPLES-E2E-FIX2): the pictures a v2 spec commits, as bytes, for the BoxSpec file and for publishing.
 * The logo (field 23), a new collection's cover (field 28) and its page's banner and teasers (add-on 6) are this
 * browser's re-encodings, which no other browser repeats byte for byte, so only the draft has them; item pictures are
 * hashed as uploaded, so they are this visit's item files (item-files.ts). Every picture is checked against its
 * committed sha256 before it is used. The indexer lists a box only once its logo and collection cover are served by that
 * sha256 (one raw block each), and an item shows only once its picture is. R74-ART: an item's 3D model (a GLB) is hashed
 * as uploaded too, so it is also this visit's item file; models are their own list (`eachCommittedModel`), never a picture.
 *
 * Where pictures are stored is the founder's pending decision: `publishPictures` is the one place a store would be
 * called. Until one is named nothing is uploaded and every picture stays pending.
 */
import { MAX_RAW_BLOCK_BYTES, sha256Hex } from '@squarehole/artwork';
import { AddOnId, ArtMode, decodeCollectionMetadataParams, decodePlaceholdersParams } from '@squarehole/box-spec';
import { MODEL_TYPE, inspectModel, toBase64 } from '../art-files';
import { commitArt, type ArtState, type CoverState, type Hex, type PageState } from '../create-model';
import { itemFileOf } from '../item-files';
import type { FreeFit } from '../../pictures/arweave-publish';
import { pictureType } from '../../pictures/picture-type';
import { BoxTypeV2, type BoxSpecV2 } from './spec-types';

export type PictureRole = 'logo' | 'collection cover' | 'banner' | 'teaser' | 'item';
/** One committed picture: what it is, the sha256 the spec commits (its raw CID's digest) and its exact bytes. */
export interface CommittedPicture { readonly role: PictureRole; readonly sha256: Hex; readonly bytes: Uint8Array }
/** A picture the spec commits that this visit cannot supply (an item file not read since a reload, or changed bytes). */
export interface MissingPicture { readonly role: PictureRole; readonly sha256: Hex }
export interface CommittedPictures {
  readonly pictures: readonly CommittedPicture[];
  readonly missing: readonly MissingPicture[];
}
/** What the draft holds of the pictures: the processed logo, collection cover and page pictures, and the art's hashes. */
export interface PictureDraft {
  readonly cover: CoverState | null;
  readonly collectionCover: CoverState | null;
  readonly page?: PageState;
  readonly art: ArtState | null;
}

const ZERO32 = /^0x0{64}$/i;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** base64 back to bytes (the draft keeps the processed pictures as base64). */
const bytesOf = (base64: string): Uint8Array => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

/** The collection page's banner and teasers the spec commits (add-on 6), each distinct teaser once, in the spec's order. */
function pageOf(spec: BoxSpecV2): { readonly banner: Hex | null; readonly teasers: readonly Hex[] } {
  const addOn = spec.addOns.find((entry) => entry.id === AddOnId.CollectionMetadata);
  if (!addOn) return { banner: null, teasers: [] };
  const params = decodeCollectionMetadataParams(addOn.params);
  const teasers = [...new Map(params.teaserSha256s.map((sha256) => [sha256.toLowerCase(), sha256 as Hex])).values()];
  return { banner: ZERO32.test(params.bannerSha256) ? null : params.bannerSha256 as Hex, teasers };
}

/**
 * Every picture `spec` commits, in the file's order: the logo, a new collection's cover, its page's banner and teasers,
 * then each distinct item picture once, items in sha256 order (so a hidden collection's file never says which item has
 * which picture). Each is re-checked against its hash with `digest` and handed to `visit` before the next one is read,
 * so a large collection never holds every picture's bytes at once. What cannot be supplied is returned, never left out
 * silently.
 */
export async function eachCommittedPicture(spec: BoxSpecV2, draft: PictureDraft, digest: (bytes: Uint8Array) => Promise<Hex>, visit: (picture: CommittedPicture) => void | Promise<void>): Promise<readonly MissingPicture[]> {
  const missing: MissingPicture[] = [];
  const add = async (role: PictureRole, sha256: Hex, bytes: Uint8Array | null) => {
    if (bytes !== null && bytes.byteLength <= MAX_RAW_BLOCK_BYTES && same(await digest(bytes), sha256)) await visit({ role, sha256, bytes });
    else missing.push({ role, sha256 });
  };
  const drafted = (state: CoverState | null | undefined, sha256: Hex) => (state && same(state.sha256, sha256) ? bytesOf(state.data) : null);
  await add('logo', spec.coverSha256, drafted(draft.cover, spec.coverSha256));
  if (!ZERO32.test(spec.collectionCoverSha256)) await add('collection cover', spec.collectionCoverSha256, drafted(draft.collectionCover, spec.collectionCoverSha256));
  const page = pageOf(spec);
  if (page.banner !== null) await add('banner', page.banner, drafted(draft.page?.banner, page.banner));
  for (const sha256 of page.teasers) await add('teaser', sha256, drafted(draft.page?.teasers.find((teaser) => same(teaser.sha256, sha256)), sha256));
  if (spec.boxType === BoxTypeV2.NEW_COLLECTION) {
    const items = [...new Set((draft.art?.items ?? []).map((item) => item.imageSha256.toLowerCase()))].sort() as Hex[];
    for (const sha256 of items) {
      const file = itemFileOf(sha256);
      await add('item', sha256, file ? new Uint8Array(await file.arrayBuffer()) : null);
    }
  }
  return missing;
}

/**
 * SH-WITHHELD-SITE fix round af4: whether `art` is the art a new collection's `spec` commits: the reveal root rebuilt
 * from it (its items, traits, salts and models, by the spec's art mode) is the spec's. True for a box that commits no art.
 */
export function artCommittedBy(spec: BoxSpecV2, art: ArtState | null): boolean {
  if (spec.boxType !== BoxTypeV2.NEW_COLLECTION) return true;
  const mode = spec.artMode === ArtMode.HIDDEN ? 'hidden' : spec.artMode === ArtMode.OPEN ? 'open' : null;
  const commitment = mode === null ? null : commitArt(art, mode);
  return commitment !== null && commitment.revealRoot.toLowerCase() === spec.revealRoot.toLowerCase();
}

/**
 * The Placeholders add-on's hidden picture (add-on 1: a hidden collection's one picture until its draws), as the SHA-256
 * of its exact SVG: its UTF-8 bytes, the bytes the site draws (the spec allows printable ASCII only); null without it.
 */
function hiddenPictureOf(spec: BoxSpecV2): Hex | null {
  const addOn = spec.addOns.find((entry) => entry.id === AddOnId.Placeholders);
  if (!addOn) return null;
  const svg = decodePlaceholdersParams(addOn.params).hiddenSvg;
  return svg === '' ? null : (sha256Hex(new TextEncoder().encode(svg)).toLowerCase() as Hex);
}

/**
 * SH-WITHHELD-SITE fix round af3 (R77-TAKEDOWN-CREATE): every picture hash `spec` commits, without their bytes, as
 * `eachCommittedPicture` names them: the logo, a new collection's cover, its page's banner and teasers (add-on 6,
 * CollectionMetadata) and a new collection's item pictures, as its art names them (the spec commits those through its
 * reveal root); fix round af4: and the Placeholders add-on's hidden picture, whatever SVG it carries (Create's own or a
 * loaded setup's). Each distinct hash once, lowercase; none that is zero. Fix round af4: null for a new collection whose
 * `art` is not the art the spec commits (`artCommittedBy`): its item pictures cannot be named then.
 */
export function committedPictureHashes(spec: BoxSpecV2, art: ArtState | null): readonly Hex[] | null {
  if (!artCommittedBy(spec, art)) return null;
  const page = pageOf(spec);
  const items = spec.boxType === BoxTypeV2.NEW_COLLECTION ? (art?.items ?? []).map((item) => item.imageSha256) : [];
  return [...new Set([spec.coverSha256, spec.collectionCoverSha256, page.banner, ...page.teasers, ...items, hiddenPictureOf(spec)]
    .filter((sha256): sha256 is Hex => sha256 !== null && !ZERO32.test(sha256))
    .map((sha256) => sha256.toLowerCase()))] as Hex[];
}

/**
 * SH-ARWEAVE-PICTURES-WEB: the box's own two pictures, as Create publishes them before its createBox: the logo and a
 * new collection's cover (when the spec commits one), each from the draft and checked against its hash. Item pictures
 * stay out (marketplaces read them by IPFS address; a separate question), and so do the page's banner and teasers.
 */
export async function logoAndCover(spec: BoxSpecV2, draft: PictureDraft, digest: (bytes: Uint8Array) => Promise<Hex>): Promise<CommittedPictures> {
  const pictures: CommittedPicture[] = [];
  const missing: MissingPicture[] = [];
  const add = async (role: PictureRole, sha256: Hex, state: CoverState | null | undefined) => {
    const bytes = state && same(state.sha256, sha256) ? bytesOf(state.data) : null;
    if (bytes !== null && bytes.byteLength <= MAX_RAW_BLOCK_BYTES && same(await digest(bytes), sha256)) pictures.push({ role, sha256, bytes });
    else missing.push({ role, sha256 });
  };
  if (!ZERO32.test(spec.coverSha256)) await add('logo', spec.coverSha256, draft.cover);
  if (!ZERO32.test(spec.collectionCoverSha256) && !same(spec.collectionCoverSha256, spec.coverSha256)) await add('collection cover', spec.collectionCoverSha256, draft.collectionCover);
  return { pictures, missing };
}

/**
 * SH-ARWEAVE-PICTURES-WEB: whether the draft holds a logo or collection cover (the ones this spec commits) that does
 * not fit the free tier (`fits`, pictures/arweave-publish.ts `fitsFree`), so Create refuses before anything is signed.
 * A picture read on this page was shrunk to fit already; this catches one from an earlier draft or a loaded setup.
 */
export function freePicturesRefused(spec: Pick<BoxSpecV2, 'coverSha256' | 'collectionCoverSha256'>, draft: Pick<PictureDraft, 'cover' | 'collectionCover'>, fits: FreeFit): boolean {
  const refused = (sha256: Hex, state: CoverState | null | undefined): boolean => {
    if (ZERO32.test(sha256) || !state || !same(state.sha256, sha256)) return false;
    let head: Uint8Array;
    try { head = bytesOf(state.data.slice(0, 16)); } catch { return false; }
    return !fits(state.bytes, pictureType(head) ?? '');
  };
  return refused(spec.coverSha256, draft.cover) || refused(spec.collectionCoverSha256, draft.collectionCover);
}

/** The same pictures collected in one list (for a store, and for tests): `eachCommittedPicture` keeps only one at a time. */
export async function committedPictures(spec: BoxSpecV2, draft: PictureDraft, digest: (bytes: Uint8Array) => Promise<Hex>): Promise<CommittedPictures> {
  const pictures: CommittedPicture[] = [];
  const missing = await eachCommittedPicture(spec, draft, digest, (picture) => { pictures.push(picture); });
  return { pictures, missing };
}

/** A picture as the BoxSpec file carries it. */
export const pictureJson = (picture: CommittedPicture) => ({ role: picture.role, sha256: picture.sha256, base64: toBase64(picture.bytes) });

/** R74-ART: one committed 3D model: the sha256 its items' leaves commit (its raw CID's digest) and its exact GLB bytes. */
export interface CommittedModel { readonly sha256: Hex; readonly bytes: Uint8Array }
/** A model the spec commits that this visit cannot supply (a file not read since a reload, or changed bytes). */
export interface MissingModel { readonly sha256: Hex }

/**
 * The distinct models a new collection's art commits, in sha256 order (as its item pictures: a hidden collection's file
 * never says which item has which model); none for any other box, or art without models.
 */
export function committedModelHashes(spec: Pick<BoxSpecV2, 'boxType'>, art: ArtState | null): readonly Hex[] {
  if (spec.boxType !== BoxTypeV2.NEW_COLLECTION || !art) return [];
  return [...new Set(art.items.flatMap((item) => (item.modelSha256 ? [item.modelSha256.toLowerCase()] : [])))].sort() as Hex[];
}

/**
 * Every model the spec's art commits (`committedModelHashes`), each from this visit's item files, read only when it fits
 * one raw block, checked as the site's viewer checks it (`inspectModel`) and against its committed sha256, then handed to
 * `visit` before the next is read. What cannot be supplied is returned, never left out silently.
 */
export async function eachCommittedModel(spec: Pick<BoxSpecV2, 'boxType'>, draft: Pick<PictureDraft, 'art'>, visit: (model: CommittedModel) => void | Promise<void>): Promise<readonly MissingModel[]> {
  const missing: MissingModel[] = [];
  for (const sha256 of committedModelHashes(spec, draft.art)) {
    const file = itemFileOf(sha256);
    const bytes = file && file.size <= MAX_RAW_BLOCK_BYTES ? new Uint8Array(await file.arrayBuffer()) : null;
    const checked = bytes ? inspectModel(bytes) : null;
    if (bytes && checked?.ok && same(checked.sha256, sha256)) await visit({ sha256, bytes });
    else missing.push({ sha256 });
  }
  return missing;
}

/** The same models in one list (for the kit tooling and tests). */
export async function committedModels(spec: Pick<BoxSpecV2, 'boxType'>, draft: Pick<PictureDraft, 'art'>): Promise<{ readonly models: readonly CommittedModel[]; readonly missing: readonly MissingModel[] }> {
  const models: CommittedModel[] = [];
  const missing = await eachCommittedModel(spec, draft, (model) => { models.push(model); });
  return { models, missing };
}

/** A model as the BoxSpec file carries it (`models`): typed, its sha256 and its exact bytes. */
export const modelJson = (model: CommittedModel) => ({ type: MODEL_TYPE, sha256: model.sha256, base64: toBase64(model.bytes) });

/** Where pictures would be stored: given each picture's exact bytes, it makes them answer `/ipfs/<raw CID of sha256>`. */
export interface PictureStore { put(picture: CommittedPicture): Promise<void> }
export interface PublishOutcome { readonly published: readonly Hex[]; readonly pending: readonly Hex[] }

/**
 * The one function that would publish a box's pictures before it is expected to show (F-1). The store is the founder's
 * pending decision, so today there is none: nothing is uploaded and every picture stays pending. With a store, each
 * picture is published in order; one that fails stays pending and the rest still go.
 */
export async function publishPictures(pictures: readonly CommittedPicture[], store: PictureStore | null = null): Promise<PublishOutcome> {
  if (store === null) return { published: [], pending: pictures.map((picture) => picture.sha256) };
  const published: Hex[] = []; const pending: Hex[] = [];
  for (const picture of pictures) {
    try {
      await store.put(picture);
      published.push(picture.sha256);
    } catch (error) {
      console.error('Create v2: a picture was not published', error);
      pending.push(picture.sha256);
    }
  }
  return { published, pending };
}
