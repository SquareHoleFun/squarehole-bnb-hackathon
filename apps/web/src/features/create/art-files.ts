/**
 * Reading the creator's files (box creation flow § 3). Nothing is uploaded: every file is read in this browser.
 *
 * - Items: files named `1.png` … `N.png` (PNG, JPEG or WebP by content, never by name; scripts, SVG, HTML, GIF and
 *   trailing data are refused by `inspectImage`), each at most 1 MiB (one raw IPFS block), hashed as uploaded with
 *   sha256 (WebCrypto, off the main thread; @noble's sha256 where it is missing). Ids must run 1..N without gaps.
 *   An AI tool's C2PA "content credentials" are accepted and stay in the bytes and the hash (SH-ACCEPT-C2PA).
 * - R74-ART: a 3D model beside each picture, `1.glb` … `N.glb`: a self-contained binary glTF 2.0 file in one raw block,
 *   checked by the same rules the site's model viewer applies (`inspectModel`: artwork `glbSha256`, as
 *   scene/controller.ts `loadItemModel`) and hashed as uploaded. A model for every picture or for none: a model
 *   without its picture, or a picture missing its model, is named, never committed as no model.
 * - Traits: an optional traits file (CSV or JSON, `parseAttributes`, up to a box's 10,000 items), or per-item
 *   `<id>.json` metadata from a folder, of which only `attributes` is read; URLs are never fetched. Traits must also fit
 *   the on-chain table (printable ASCII without `"` or `\`, 1-255 bytes, at most 16 types and 255 values each);
 *   failures name the item ids.
 * - SH-AI-PLAN: or pictures with any names and a plan (a CSV whose first column is `file`: art-plan.ts). The page then
 *   deals the numbers 1..N itself, with this browser's `crypto.getRandomValues`: no file name or plan row decides one.
 * - The logo, a new collection's cover (F74 U3), the banner and the teasers: the pictures that are re-encoded (pixels only, metadata dropped) within a
 *   side (1,024 px; the banner 1,600 px wide) and one raw block, then hashed; the re-encoded bytes are kept (another
 *   browser would not re-encode them byte for byte, and the spec commits to them), and a small thumbnail for the page.
 * - Problems never throw: they are grouped by rule, at most three lines (a count and one example each).
 */
import {
  MAX_RAW_BLOCK_BYTES,
  compactIdRanges,
  glbSha256,
  inspectImage,
  itemIdFromFileName,
  normaliseItemId,
  parseAttributes,
  sha256Hex,
  type Attribute,
  type ImageLimits,
} from '@squarehole/artwork';
import { MAX_N } from '@squarehole/box-spec';
import { MAX_BANNER_URL_CHARS, MAX_COVER_URL_CHARS, MAX_THUMBS, MAX_THUMB_URL_CHARS } from '../boxes/created-boxes';
import type { FreeFit } from '../pictures/arweave-publish';
import { pictureType } from '../pictures/picture-type';
import { TOO_DETAILED, UNREADABLE, shrinkPicture, type PictureEncoder } from '../pictures/shrink';
import { MAX_PLAN_BYTES, PLAN_WORDS, dealItems, parsePlan, planHeaderVerdict, wordStream, type PlannedPicture, type PlanRow } from './art-plan';
import type { ArtItem, ArtState, CoverState, Hex } from './create-model';


/** Item pictures: one raw block each; pixel art may be small. */
export const ITEM_LIMITS: ImageLimits = Object.freeze({ maxBytes: MAX_RAW_BLOCK_BYTES, minSide: 16, maxSide: 4096 });
/** The cover as uploaded (it is re-encoded below 1,024 px a side). */
export const COVER_LIMITS: ImageLimits = Object.freeze({ maxBytes: 10 * 1024 * 1024, minSide: 256, maxSide: 4096 });
/** A banner as uploaded: wide (shown at 4:1), at least 128 px high. */
export const BANNER_LIMITS: ImageLimits = Object.freeze({ maxBytes: 10 * 1024 * 1024, minSide: 128, maxSide: 8192 });
/** A banner narrower than 2:1 would be cropped hard on the box page's 4:1 strip, and its hash is fixed for good. */
export const BANNER_MIN_RATIO = 2;
export const BANNER_TOO_NARROW = 'Use a wide picture, about 4:1.';
/** What the processed bytes are read with to learn their shape as drawn (after any EXIF turn). */
const PROCESSED_LIMITS: ImageLimits = Object.freeze({ maxBytes: MAX_RAW_BLOCK_BYTES, minSide: 1, maxSide: 8192 });

/** How each picture is processed: its upload limits, the side it is re-encoded within, its thumbnail. */
export const PICTURES = Object.freeze({
  logo: { limits: COVER_LIMITS, side: 1024, thumbSide: 320, thumbChars: MAX_COVER_URL_CHARS },
  /** A new collection's cover (field 28, its contractURI image): processed like the logo, its own upload. */
  collection: { limits: COVER_LIMITS, side: 1024, thumbSide: 320, thumbChars: MAX_COVER_URL_CHARS },
  banner: { limits: BANNER_LIMITS, side: 1600, thumbSide: 800, thumbChars: MAX_BANNER_URL_CHARS },
  teaser: { limits: COVER_LIMITS, side: 1024, thumbSide: 240, thumbChars: MAX_THUMB_URL_CHARS },
} as const);
export type PictureKind = keyof typeof PICTURES;
const ITEM_THUMB_SIDE = 160;
const CONCURRENCY = 4;
const MAX_METADATA_JSON_CHARS = 64 * 1024;
/**
 * A traits file: up to a box's 10,000 items (SH-AI-PLAN: the parser's own default is the old demo's 2,000) in up to
 * 16 MiB of text, the parser's 4 MiB for 2,000 items scaled to 10,000.
 */
const MAX_TRAITS_FILE_CHARS = 16 * 1024 * 1024;
const TRAITS_LIMITS = Object.freeze({ maxItems: MAX_N, maxFileChars: MAX_TRAITS_FILE_CHARS });
/** At most this many problem lines: one per rule broken, with a count and an example, never one per file. */
export const MAX_PROBLEM_LINES = 3;
const IMAGE_NAME = /\.(png|jpe?g|webp)$/i;
const ITEM_JSON = /^([0-9]+)\.json$/i;
/** R74-ART: an item's 3D model, named after its picture's id (`7.glb` beside `7.png`; "007.glb" is 7, as for pictures). */
const MODEL_NAME = /\.glb$/i;
const MODEL_FILE = /^([0-9]{1,12})\.glb$/i;
/** A model's media type (the BoxSpec file's `models` entries, IPFS serving: infra/server/ipfs/content.mjs). */
export const MODEL_TYPE = 'model/gltf-binary';

/** Why a model cannot be used: larger than one raw block, not a binary glTF 2.0 file, or one that loads other files. */
export type ModelRefusal = 'too_large' | 'not_glb' | 'external';
/**
 * R74-ART: a model as the site's viewer takes it (scene/controller.ts `loadItemModel`, artwork `glbSha256`): at most one
 * raw block (1 MiB), a GLB container of glTF 2.0 whose declared length is the file's, a valid JSON chunk first, and no
 * buffer or image fetched from another file. Its sha256 (of the bytes as given) is what the item's leaf commits.
 */
export function inspectModel(bytes: Uint8Array): { readonly ok: true; readonly sha256: Hex } | { readonly ok: false; readonly reason: ModelRefusal } {
  if (bytes.byteLength > MAX_RAW_BLOCK_BYTES) return { ok: false, reason: 'too_large' };
  try {
    return { ok: true, sha256: glbSha256(bytes) as Hex };
  } catch (error) {
    return { ok: false, reason: error instanceof Error && /self-contained/.test(error.message) ? 'external' : 'not_glb' };
  }
}

/** What the page needs from the browser; the tests pass their own. */
export interface ArtEnvironment {
  /** sha256 of bytes, 0x-prefixed lower-case hex. */
  digest(bytes: Uint8Array): Promise<Hex>;
  /** A small picture of an accepted image as a data URL (≤ the size given), or null when the browser cannot draw it. */
  thumbnail(file: Blob, side: number, maxChars: number): Promise<string | null>;
  /** The cover re-encoded (pixels only) within `side` and one raw block, or a reason it could not be. */
  encodeCover(file: Blob, side: number): Promise<{ readonly bytes: Uint8Array } | { readonly error: string }>;
  /**
   * SH-ARWEAVE-PICTURES-WEB: the logo or a collection cover shrunk by the free ladder (pictures/shrink.ts) until `fits`,
   * or the reason it cannot be. Absent (the tests' environments): `encodeCover`, then the same fit check.
   */
  encodeFree?(file: Blob, fits: FreeFit): Promise<{ readonly bytes: Uint8Array } | { readonly error: string }>;
  /** 32 random bytes as hex (a leaf salt). */
  salt(): Hex;
  /**
   * Fills `words` with cryptographically random values (this browser's `crypto.getRandomValues`): the plan's numbers
   * (art-plan.ts `dealItems`). Tests pass their own; absent, this browser's is used. Throws where there is none.
   */
  randomWords?(words: Uint32Array<ArrayBuffer>): void;
}

/** This browser's own randomness, never a weaker fallback: without `crypto.getRandomValues` it throws. */
function browserRandomWords(words: Uint32Array<ArrayBuffer>): void {
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') throw new Error('No crypto.getRandomValues');
  crypto.getRandomValues(words);
}

const toHex = (bytes: Uint8Array): Hex => `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;

/** Bytes as base64 (in chunks: spreading a whole MiB into one call would overflow the stack). */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** base64 back to bytes, or null when it is not plain base64 (a plain loop: a settings file holds many MB of it). */
export function fromBase64(text: string): Uint8Array | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) return null;
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function digest(bytes: Uint8Array): Promise<Hex> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', copy.buffer)));
  }
  return sha256Hex(bytes);
}

function canvasOf(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * Draws a picture within `side` px on a fresh canvas (only pixels survive), or null where the browser cannot. With a
 * `ground`, the canvas is painted with it first, so a transparent picture keeps its look in JPEG (no black corners).
 */
async function draw(file: Blob, side: number, ground: string | null = null): Promise<HTMLCanvasElement | null> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = canvasOf(width, height);
    const context = canvas.getContext('2d');
    if (!context) return null;
    if (ground !== null) {
      context.fillStyle = ground;
      context.fillRect(0, 0, width, height);
    }
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    return canvas;
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}

const blobOf = (canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> =>
  new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });

/** Whether this browser writes WebP: one 1 px canvas asked once per page load (Safari and iPhones answer PNG). */
let writesWebp: Promise<boolean> | null = null;
function webpEncoder(): Promise<boolean> {
  writesWebp ??= typeof document === 'undefined'
    ? Promise.resolve(false)
    : blobOf(canvasOf(1, 1), 'image/webp', 0.8).then((blob) => blob?.type === 'image/webp').catch(() => false);
  return writesWebp;
}

/** SH-ARWEAVE-PICTURES-WEB: the browser's canvas encoder for the free ladder (pictures/shrink.ts). */
export const BROWSER_ENCODER: PictureEncoder<HTMLCanvasElement> = {
  webp: webpEncoder,
  draw,
  encode: (canvas, type, quality) => blobOf(canvas, type, quality),
};

export const BROWSER_ART: ArtEnvironment = {
  digest,
  async thumbnail(file, side, maxChars) {
    const canvas = await draw(file, side);
    if (!canvas) return null;
    for (const quality of [0.85, 0.7, 0.5]) {
      const url = canvas.toDataURL('image/webp', quality);
      if (url.startsWith('data:image/webp') && url.length <= maxChars) return url;
      const jpeg = canvas.toDataURL('image/jpeg', quality);
      if (jpeg.length <= maxChars) return jpeg;
    }
    return null;
  },
  async encodeCover(file, side) {
    const canvas = await draw(file, side);
    if (!canvas) return { error: UNREADABLE };
    for (const [type, quality] of [['image/png', undefined], ['image/webp', 0.92], ['image/jpeg', 0.9]] as const) {
      const blob = await blobOf(canvas, type, quality);
      if (blob && blob.size <= MAX_RAW_BLOCK_BYTES) return { bytes: new Uint8Array(await blob.arrayBuffer()) };
    }
    return { error: 'The picture is larger than 1 MB after processing. Use a simpler one.' };
  },
  async encodeFree(file, fits) {
    const shrunk = await shrinkPicture(file, fits, BROWSER_ENCODER);
    return 'error' in shrunk ? shrunk : { bytes: shrunk.bytes };
  },
  salt() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return toHex(bytes);
  },
  randomWords: browserRandomWords,
};

async function eachLimited<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next] as T;
        next += 1;
        await work(item);
      }
    }),
  );
}

const TABLE_TEXT = /^[\x20-\x21\x23-\x5b\x5d-\x7e]{1,255}$/;

/** Traits that the on-chain table can hold; problems name the trait and the item ids. */
export function tableProblems(items: readonly { id: number; traits: readonly Attribute[] }[]): string[] {
  const problems: string[] = [];
  const bad = new Map<string, number[]>();
  const types = new Map<string, Set<string>>();
  for (const item of items) {
    for (const { trait, value } of item.traits) {
      for (const text of [trait, value]) {
        if (!TABLE_TEXT.test(text)) bad.set(text, [...(bad.get(text) ?? []), item.id]);
      }
      const values = types.get(trait) ?? new Set<string>();
      values.add(value);
      types.set(trait, values);
    }
  }
  for (const [text, ids] of bad) problems.push(`Items ${compactIdRanges(ids.map(BigInt), 6)}: "${text.slice(0, 24)}" uses a character the box cannot store (plain letters, numbers and punctuation; no " or \\).`);
  if (types.size > 16) problems.push(`${types.size} trait types: a box holds at most 16.`);
  for (const [trait, values] of types) if (values.size > 255) problems.push(`Trait "${trait.slice(0, 24)}" has ${values.size} values: at most 255.`);
  return problems;
}

type ProblemKind = 'not-picture' | 'bad-name' | 'duplicate' | 'refused' | 'unreadable' | 'traits' | 'table' | 'plan' | 'no-picture' | 'not-in-plan' | 'model-name' | 'model-duplicate' | 'model-refused' | 'other';

/** One line for a rule broken `count` times; `example` is the first case, already naming its file or ids. */
const PROBLEM_LINE: Readonly<Record<ProblemKind, (count: number, example: string) => string>> = {
  'not-picture': (n, ex) => (n === 1 ? `${ex}: not a picture (PNG, JPEG or WebP) or a traits file.` : `${n} files are not pictures or a traits file, e.g. ${ex}.`),
  'bad-name': (n, ex) => (n === 1 ? `${ex}: name each picture after its id (1.png, 2.png …).` : `${n} pictures not named by id, e.g. ${ex} (use 1.png, 2.png …).`),
  duplicate: (n, ex) => (n === 1 ? `${ex}.` : `${n} pictures repeat an id, e.g. ${ex}.`),
  refused: (n, ex) => (n === 1 ? ex : `${n} pictures refused, e.g. ${ex}`),
  unreadable: (n, ex) => (n === 1 ? `${ex}: the file could not be read.` : `${n} files could not be read, e.g. ${ex}.`),
  traits: (n, ex) => (n === 1 ? `Traits: ${ex}` : `${n} problems in the traits, e.g. ${ex}`),
  table: (n, ex) => (n === 1 ? ex : `${n} trait problems, e.g. ${ex}`),
  // SH-AI-PLAN: a plan's rows and cells, and the pictures it names (art-plan.ts PLAN_WORDS).
  plan: (n, ex) => (n === 1 ? ex : `${n} problems in the plan, e.g. ${ex}`),
  'no-picture': (n, ex) => (n === 1 ? ex : `${n} rows have no picture, e.g. ${ex}`),
  'not-in-plan': (n, ex) => (n === 1 ? PLAN_WORDS.notInPlan(ex) : `${n} pictures are not in the plan, e.g. ${ex}.`),
  // R74-ART: 3D models (`<id>.glb`), named and checked as pictures are.
  'model-name': (n, ex) => (n === 1 ? `${ex}: name each model after its picture’s id (1.glb, 2.glb …).` : `${n} models not named by id, e.g. ${ex} (use 1.glb, 2.glb …).`),
  'model-duplicate': (n, ex) => (n === 1 ? `${ex}.` : `${n} models repeat an id, e.g. ${ex}.`),
  'model-refused': (n, ex) => (n === 1 ? ex : `${n} models refused, e.g. ${ex}`),
  other: (_n, ex) => ex,
};

/** A refused model's line: its size when over one raw block, else what the viewer needs (`inspectModel`). */
function modelRefusedLine(name: string, size: number, reason: ModelRefusal): string {
  if (reason === 'too_large') {
    const tenths = Math.ceil((size * 10) / MAX_RAW_BLOCK_BYTES);
    return `${name} is ${Math.floor(tenths / 10)}.${tenths % 10} MB. Max 1 MB.`;
  }
  return reason === 'external' ? `${name}: the model loads other files. Use one self-contained GLB.` : `${name}: not a GLB model (binary glTF 2.0).`;
}

/** A model whose id has no picture, and pictures missing their model (every picture has one, or none has). */
export const MODEL_WORDS = Object.freeze({
  orphans: (ids: string) => `Models for ids without a picture: ${ids}.`,
  missing: (ids: string) => `Missing models for ids ${ids}: add a model for every picture, or none.`,
  /** SH-AI-PLAN: a plan's pictures have any names, so a model cannot name its picture. */
  withPlan: 'Models need numbered files (1.png with 1.glb …), not a plan.',
});

/**
 * A refused item picture's line: a picture over one raw block says how large it is and what to do (design checks,
 * SH-AI-PLAN), every other refusal gives the inspector's reason.
 */
function refusedLine(name: string, size: number, inspection: { readonly code: string; readonly message: string }): string {
  if (inspection.code !== 'too_large') return `${name}: ${inspection.message}`;
  // Tenths of a MiB, rounded up, so a file just over the limit never reads as 1.0 MB (a file size, not an amount).
  const tenths = Math.ceil((size * 10) / MAX_RAW_BLOCK_BYTES);
  return `${name} is ${Math.floor(tenths / 10)}.${tenths % 10} MB. Max 1 MB. Save it as WebP or JPEG.`;
}

/** Problems grouped by rule, in the order first met; `lines()` gives at most MAX_PROBLEM_LINES lines. */
function problemList() {
  const groups = new Map<string, { kind: ProblemKind; count: number; example: string }>();
  return {
    add(kind: ProblemKind, example: string) {
      // "other" lines are each their own rule (a gap list, a second traits file): never merged.
      const key = kind === 'other' ? `other:${example}` : kind;
      const group = groups.get(key);
      if (group) group.count += 1;
      else groups.set(key, { kind, count: 1, example });
    },
    /** Whether any problem was added. */
    get empty(): boolean {
      return groups.size === 0;
    },
    lines(): string[] {
      const all = [...groups.values()];
      const shown = all.length > MAX_PROBLEM_LINES ? all.slice(0, MAX_PROBLEM_LINES - 1) : all;
      const lines = shown.map((group) => PROBLEM_LINE[group.kind](group.count, group.example));
      const rest = all.slice(shown.length).reduce((sum, group) => sum + group.count, 0);
      return rest > 0 ? [...lines, `…and ${rest} more ${rest === 1 ? 'problem' : 'problems'}.`] : lines;
    },
  };
}

export interface ReadArtOptions {
  readonly env: ArtEnvironment;
  /** Called as files are read (every file; the page announces every 10%). */
  readonly onProgress?: (done: number, total: number) => void;
  /**
   * Called with each accepted item file, pictures and then models (R74-ART), and the sha256 of its bytes (the bytes the
   * spec commits; item-files.ts).
   */
  readonly onItemFile?: (sha256: Hex, file: File) => void;
}

/** A numbered model's id (`7.glb`, "007.glb" is 7), 1 to a box's MAX_N, or null. */
function modelIdOf(name: string): number | null {
  const match = MODEL_FILE.exec(name);
  const id = match ? normaliseItemId(match[1]) : null;
  if (!id?.ok || !/^[0-9]{1,6}$/.test(id.id)) return null;
  const number = Number.parseInt(id.id, 10);
  return number >= 1 && number <= MAX_N ? number : null;
}

/**
 * Reads the item files, an optional traits file and per-item `<id>.json` metadata into the art state; R74-ART: and a
 * numbered model beside each picture, or none. Problems never throw: they are listed, and the art is unusable until
 * none remain.
 */
export async function readArt(files: readonly File[], options: ReadArtOptions): Promise<ArtState> {
  // SH-AI-PLAN: a plan among the files (a CSV whose first column is `file`) means this page deals the numbers.
  const plans: File[] = [];
  for (const file of files) if (await isPlanFile(file)) plans.push(file);
  if (plans.length > 0) return readPlannedArt(files, plans, options);
  const { env, onProgress, onItemFile } = options;
  const problems = problemList();
  const images: { file: File; id: number }[] = [];
  const models: { file: File; id: number }[] = [];
  const metadata: { file: File; id: number }[] = [];
  const traitFiles: File[] = [];
  const seen = new Map<number, string>();
  const seenModels = new Map<number, string>();
  for (const file of files) {
    const name = file.name;
    const json = ITEM_JSON.exec(name);
    if (json) {
      metadata.push({ file, id: Number.parseInt(json[1] ?? '0', 10) });
      continue;
    }
    if (/\.(csv|json)$/i.test(name)) {
      traitFiles.push(file);
      continue;
    }
    if (MODEL_NAME.test(name) && !name.startsWith('.')) {
      const id = modelIdOf(name);
      if (id === null) problems.add('model-name', name);
      else if (seenModels.has(id)) problems.add('model-duplicate', `${name}: id ${id} is already ${seenModels.get(id)}`);
      else {
        seenModels.set(id, name);
        models.push({ file, id });
      }
      continue;
    }
    if (!IMAGE_NAME.test(name)) {
      if (!name.startsWith('.')) problems.add('not-picture', name);
      continue;
    }
    const id = itemIdFromFileName(name);
    const number = id.ok && /^[0-9]{1,6}$/.test(id.id) ? Number.parseInt(id.id, 10) : null;
    if (!id.ok || number === null || number < 1 || number > MAX_N) {
      problems.add('bad-name', name);
      continue;
    }
    if (seen.has(number)) {
      problems.add('duplicate', `${name}: id ${number} is already ${seen.get(number)}`);
      continue;
    }
    seen.set(number, name);
    images.push({ file, id: number });
  }
  if (traitFiles.length > 1) problems.add('other', `${traitFiles.length} traits files: add one (CSV or JSON), or a folder of <id>.json files.`);

  const accepted: { id: number; sha: Hex; bytes: number; file: File }[] = [];
  let done = 0;
  const total = images.length + models.length;
  onProgress?.(0, total);
  await eachLimited(images, CONCURRENCY, async ({ file, id }) => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const inspection = inspectImage(bytes, ITEM_LIMITS);
      if (!inspection.ok) problems.add('refused', refusedLine(file.name, bytes.byteLength, inspection));
      else accepted.push({ id, sha: await env.digest(bytes), bytes: bytes.byteLength, file });
    } catch {
      problems.add('unreadable', file.name);
    }
    done += 1;
    onProgress?.(done, total);
  });
  accepted.sort((a, b) => a.id - b.id);
  // R74-ART: each model is read only when it fits one raw block (never a larger file into memory), then checked and hashed.
  const modelsRead = new Map<number, { readonly sha: Hex; readonly bytes: number; readonly file: File }>();
  await eachLimited(models, CONCURRENCY, async ({ file, id }) => {
    try {
      if (file.size > MAX_RAW_BLOCK_BYTES) problems.add('model-refused', modelRefusedLine(file.name, file.size, 'too_large'));
      else {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const inspection = inspectModel(bytes);
        if (!inspection.ok) problems.add('model-refused', modelRefusedLine(file.name, bytes.byteLength, inspection.reason));
        else modelsRead.set(id, { sha: inspection.sha256, bytes: bytes.byteLength, file });
      }
    } catch {
      problems.add('unreadable', file.name);
    }
    done += 1;
    onProgress?.(done, total);
  });
  for (const item of accepted) onItemFile?.(item.sha, item.file);
  for (const item of accepted) {
    const model = modelsRead.get(item.id);
    if (model) onItemFile?.(model.sha, model.file);
  }

  const ids = accepted.map((item) => item.id);
  const n = ids.length === 0 ? 0 : Math.max(...ids);
  const missing: bigint[] = [];
  for (let id = 1, i = 0; id <= n; id++) {
    if (ids[i] === id) i += 1;
    else missing.push(BigInt(id));
  }
  if (missing.length > 0) problems.add('other', `Missing pictures for ids ${compactIdRanges(missing, 8)}: ids run from 1 to N without gaps.`);
  // A model for every picture or for none: one without its picture, or a picture without its model, is never left out.
  const orphanModels = [...seenModels.keys()].filter((id) => !seen.has(id));
  if (orphanModels.length > 0) problems.add('other', MODEL_WORDS.orphans(compactIdRanges(orphanModels.map(BigInt), 8)));
  const withoutModel = seenModels.size === 0 ? [] : [...seen.keys()].filter((id) => !seenModels.has(id));
  if (withoutModel.length > 0) problems.add('other', MODEL_WORDS.missing(compactIdRanges(withoutModel.map(BigInt), 8)));

  const traits = await readTraits(traitFiles[0] ?? null, metadata, problems);
  const items: ArtItem[] = accepted.map((item) => {
    const model = modelsRead.get(item.id);
    return { id: item.id, imageSha256: item.sha, traits: traits.get(item.id) ?? [], bytes: item.bytes, ...(model ? { modelSha256: model.sha, modelBytes: model.bytes } : {}) };
  });
  const orphan = [...traits.keys()].filter((id) => !seen.has(id));
  if (orphan.length > 0) problems.add('other', `Traits for ids without a picture: ${compactIdRanges(orphan.map(BigInt), 8)}.`);
  for (const problem of tableProblems(items)) problems.add('table', problem);

  const thumbs: string[] = [];
  for (const item of accepted.slice(0, MAX_THUMBS)) {
    const url = await env.thumbnail(item.file, ITEM_THUMB_SIDE, MAX_THUMB_URL_CHARS);
    if (url) thumbs.push(url);
  }
  const reported = problems.lines();
  return {
    items,
    salts: items.map(() => env.salt()),
    thumbs,
    totalBytes: artBytes(items),
    problems: reported,
  };
}

/** The art's size: every item's picture and, R74-ART, its model (what "Store all art" would store). */
export const artBytes = (items: readonly Pick<ArtItem, 'bytes' | 'modelBytes'>[]): number => items.reduce((sum, item) => sum + item.bytes + (item.modelBytes ?? 0), 0);

/** Traits by item id, from one traits file or from per-item metadata (`attributes` only); problems are appended. */
async function readTraits(file: File | null, metadata: readonly { file: File; id: number }[], problems: ReturnType<typeof problemList>): Promise<Map<number, Attribute[]>> {
  const out = new Map<number, Attribute[]>();
  let fileName: string;
  let text: string;
  try {
    if (file) {
      if (file.size > MAX_TRAITS_FILE_CHARS) {
        problems.add('other', `${file.name}: larger than ${MAX_TRAITS_FILE_CHARS / (1024 * 1024)} MB.`);
        return out;
      }
      fileName = file.name;
      text = await file.text();
    } else if (metadata.length > 0) {
      const entries: unknown[] = [];
      for (const { file: item, id } of metadata) {
        if (item.size > MAX_METADATA_JSON_CHARS) {
          problems.add('traits', `${item.name} is larger than 64 KB.`);
          continue;
        }
        const parsed: unknown = JSON.parse(await item.text());
        const attributes = typeof parsed === 'object' && parsed !== null ? (parsed as { attributes?: unknown }).attributes : undefined;
        if (attributes !== undefined) entries.push({ id, attributes });
      }
      fileName = 'metadata.json';
      text = JSON.stringify(entries);
    } else {
      return out;
    }
  } catch {
    problems.add('other', `${file?.name ?? 'Item metadata'}: the file could not be read as JSON or CSV.`);
    return out;
  }
  const result = parseAttributes(fileName, text, TRAITS_LIMITS);
  if (!result.ok) {
    // The traits parser's limit names the Demo ("This demo accepts at most", packages/artwork); the site says "This site"
    // in every build (F130: no Demo word in the UI).
    for (const error of result.errors) problems.add('traits', error.replace(/^This \S+ accepts at most/, 'This site accepts at most'));
    return out;
  }
  for (const [id, attributes] of result.items) {
    if (/^[0-9]{1,6}$/.test(id)) out.set(Number.parseInt(id, 10), [...attributes]);
  }
  return out;
}

/** Detection's first read; each further read takes eight times as much, up to a plan's own limit. */
const PLAN_PROBE_BYTES = 4096;

/**
 * A CSV whose first non-blank record starts with `file` is a plan (art-plan.ts `planHeaderVerdict`, the parser's own
 * rules); a traits CSV starts with `id`. It reads the file's start, more each time, until that record ends, never past
 * MAX_PLAN_BYTES: a longer start is no plan the page would take, and a plan found larger is refused by its size.
 */
async function isPlanFile(file: File): Promise<boolean> {
  if (!/\.csv$/i.test(file.name) || file.name.startsWith('.')) return false;
  try {
    for (let size = PLAN_PROBE_BYTES; ; size *= 8) {
      const take = Math.min(size, file.size, MAX_PLAN_BYTES);
      const whole = take === file.size;
      const verdict = planHeaderVerdict(await file.slice(0, take).text(), whole);
      if (verdict !== null) return verdict;
      if (whole || take === MAX_PLAN_BYTES) return false;
    }
  } catch {
    return false;
  }
}

/**
 * SH-AI-PLAN: pictures with any names and a plan (art-plan.ts). Every picture must be in the plan and every row must
 * have its picture; each picture is read once, checked and hashed as uploaded, as numbered items are. Only when nothing
 * is wrong does the page deal the numbers 1..N (`dealItems`, this browser's own randomness) and make a salt per item.
 * Thumbnails and the kept item files go in the plan's order, never by number. Problems point at the row and column.
 */
async function readPlannedArt(files: readonly File[], plans: readonly File[], { env, onProgress, onItemFile }: ReadArtOptions): Promise<ArtState> {
  const problems = problemList();
  const none = (): ArtState => ({ items: [], salts: [], thumbs: [], totalBytes: 0, problems: problems.lines(), planned: true });
  const pictures = new Map<string, File[]>();
  let traits = false;
  for (const file of files) {
    const name = file.name;
    if (plans.includes(file)) continue;
    if (ITEM_JSON.test(name) || /\.(csv|json)$/i.test(name)) {
      traits = true;
      continue;
    }
    // R74-ART: a model names its picture by id, which a plan's pictures do not have.
    if (MODEL_NAME.test(name) && !name.startsWith('.')) {
      problems.add('other', MODEL_WORDS.withPlan);
      continue;
    }
    if (!IMAGE_NAME.test(name)) {
      if (!name.startsWith('.')) problems.add('not-picture', name);
      continue;
    }
    const key = name.toLowerCase();
    pictures.set(key, [...(pictures.get(key) ?? []), file]);
  }
  if (plans.length > 1) problems.add('other', PLAN_WORDS.twoPlans(plans.length));
  if (traits) problems.add('other', PLAN_WORDS.planAndTraits);
  const planFile = plans[0] as File;
  if (planFile.size > MAX_PLAN_BYTES) {
    problems.add('other', PLAN_WORDS.tooLarge(planFile.name));
    return none();
  }
  let text: string;
  try {
    text = await planFile.text();
  } catch {
    problems.add('unreadable', planFile.name);
    return none();
  }
  const plan = parsePlan(text);
  for (const issue of plan.issues) problems.add(issue.kind === 'row' ? 'plan' : 'other', issue.text);
  for (const [key, list] of pictures) {
    const first = (list[0] as File).name;
    if (list.length > 1) problems.add('other', PLAN_WORDS.sameName(list.length, first));
    // Against a plan whose rows could not be read, every picture would look missing from it: say only the plan's problem.
    if (plan.readRows && !plan.named.has(key)) problems.add('not-in-plan', first);
  }
  const chosen: { readonly row: PlanRow; readonly file: File }[] = [];
  for (const row of plan.rows) {
    const list = pictures.get(row.file.toLowerCase());
    if (!list) problems.add('no-picture', PLAN_WORDS.noPicture(row.row, row.file));
    else if (list.length === 1) chosen.push({ row, file: list[0] as File });
  }
  const read: (PlannedPicture & { readonly file: File })[] = [];
  let done = 0;
  onProgress?.(0, chosen.length);
  await eachLimited(chosen, CONCURRENCY, async ({ row, file }) => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const inspection = inspectImage(bytes, ITEM_LIMITS);
      if (!inspection.ok) problems.add('refused', refusedLine(file.name, bytes.byteLength, inspection));
      else read.push({ row, sha256: await env.digest(bytes), bytes: bytes.byteLength, file });
    } catch {
      problems.add('unreadable', file.name);
    }
    done += 1;
    onProgress?.(done, chosen.length);
  });
  if (!problems.empty) return none();
  let items: ArtItem[];
  try {
    items = dealItems(read, wordStream((words) => (env.randomWords ? env.randomWords(words) : browserRandomWords(words))));
  } catch {
    problems.add('other', PLAN_WORDS.noRandom);
    return none();
  }
  const inPlanOrder = [...read].sort((a, b) => a.row.row - b.row.row);
  for (const picture of inPlanOrder) onItemFile?.(picture.sha256, picture.file);
  const thumbs: string[] = [];
  for (const picture of inPlanOrder.slice(0, MAX_THUMBS)) {
    const url = await env.thumbnail(picture.file, ITEM_THUMB_SIDE, MAX_THUMB_URL_CHARS);
    if (url) thumbs.push(url);
  }
  return {
    items,
    salts: items.map(() => env.salt()),
    thumbs,
    totalBytes: items.reduce((sum, item) => sum + item.bytes, 0),
    problems: [],
    planned: true,
  };
}

/** A picture read: the processed picture, and the sha256 of the file as uploaded (to compare with item files). */
export interface PictureRead {
  readonly picture: CoverState;
  readonly sourceSha256: Hex;
}

/** The pictures Create publishes to Arweave (SH-ARWEAVE-PICTURES-WEB): the logo and a new collection's cover. */
export const FREE_KINDS: ReadonlySet<PictureKind> = new Set(['logo', 'collection']);

/**
 * A picture: content-checked, re-encoded within its side and one raw block, hashed, with a small thumbnail. A banner
 * must be at least 2:1 as drawn (the processed bytes, so a turned phone photo counts as it shows).
 *
 * SH-ARWEAVE-PICTURES-WEB: with `free` (the source publishes to Arweave), the logo and a collection cover are shrunk
 * by the free ladder instead, and one that cannot fit Turbo's free tier is refused here, long before Create (no larger
 * fallback). The banner and the teasers are not published there and keep their rule.
 */
export async function readPicture(file: File, env: ArtEnvironment, kind: PictureKind, free: FreeFit | null = null): Promise<PictureRead | { readonly error: string }> {
  const how = PICTURES[kind];
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return { error: 'The file could not be read.' };
  }
  const inspection = inspectImage(bytes, how.limits);
  if (!inspection.ok) return { error: inspection.message };
  const fits = free !== null && FREE_KINDS.has(kind) ? free : null;
  const encoded = fits === null ? await env.encodeCover(file, how.side) : env.encodeFree ? await env.encodeFree(file, fits) : await env.encodeCover(file, how.side);
  if ('error' in encoded) return encoded;
  if (fits !== null && !fits(encoded.bytes.byteLength, pictureType(encoded.bytes) ?? '')) return { error: TOO_DETAILED };
  if (kind === 'banner') {
    const drawn = inspectImage(encoded.bytes, PROCESSED_LIMITS);
    const { width, height } = drawn.ok ? drawn : inspection;
    if (width < BANNER_MIN_RATIO * height) return { error: BANNER_TOO_NARROW };
  }
  const url = await env.thumbnail(new Blob([encoded.bytes.slice().buffer]), how.thumbSide, how.thumbChars);
  const [sha256, sourceSha256] = await Promise.all([env.digest(encoded.bytes), env.digest(bytes)]);
  return { picture: { sha256, url, bytes: encoded.bytes.byteLength, data: toBase64(encoded.bytes) }, sourceSha256 };
}

/** The logo (field 23): the token's and the card's picture, one of a box's two (a new collection's cover is field 28). */
export async function readCover(file: File, env: ArtEnvironment): Promise<{ readonly cover: CoverState } | { readonly error: string }> {
  const result = await readPicture(file, env, 'logo');
  return 'error' in result ? result : { cover: result.picture };
}
