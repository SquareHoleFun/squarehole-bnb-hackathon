/**
 * C2PA "content credentials" fixtures (SH-ACCEPT-C2PA). `c2pa/*.png` are real pictures made with OpenAI's image model,
 * copied byte for byte from the repository with `git show sh-v21-int:<source>` (the same git blobs, so the copies add
 * nothing to the repository's history). Each carries OpenAI's C2PA manifest store in a `caBX` chunk, whose `c2pa.icon`
 * assertion is an SVG of OpenAI's logo. The helpers take a PNG's chunks apart, build JUMBF boxes and stores, and carry a
 * store in JPEG APP11 segments (the JPEG XT box format) or a WebP `C2PA` chunk.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ascii, concat, jpegSegment, pngChunk } from './images';

export interface C2paFixture {
  readonly name: string;
  /** Where the file lives on the integration line. */
  readonly source: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  /** The caBX chunk's data length (the C2PA manifest store). */
  readonly storeBytes: number;
}

export const C2PA_FIXTURES: readonly C2paFixture[] = [
  { name: 'rent-free-logo', source: 'examples/boxes/rent-free/art/logo-original.png', sha256: 'c161e0f8957e16a2f264d239ef8747a9e6b42a3e24de1405f13f4592c4a319b7', bytes: 516_379, width: 1254, height: 1254, storeBytes: 21_881 },
  { name: 'rent-free-cover', source: 'examples/boxes/rent-free/art/cover-original.png', sha256: '8af864b06c6adcef2b2cbea29deadefc10877e81e521919d87e26f27a88b4690', bytes: 1_291_245, width: 1733, height: 907, storeBytes: 23_654 },
  { name: 'rent-free-scene-05', source: 'examples/boxes/rent-free/art/scenes/scene-05-original.png', sha256: '84bbdf6d43f33100321ff50ad4b182a823ad4cb2b6e0dead8aaa3e776f3e7602', bytes: 1_266_940, width: 1254, height: 1254, storeBytes: 23_654 },
  { name: 'rent-free-houses-07', source: 'examples/boxes/rent-free/art/houses/variant-07-original.png', sha256: 'c154160142e6a7336940e6223edc8744a4bf76ba0b194bae5f965541af27ff83', bytes: 1_279_154, width: 1536, height: 1024, storeBytes: 23_654 },
  { name: 'junkyard-logo', source: 'examples/boxes/junkyard/art/logo-original.png', sha256: '70b7c05a7a80639b6a880c920070f247102ea6c2caf163bb7d49c01ec3a50604', bytes: 2_053_123, width: 1254, height: 1254, storeBytes: 23_654 },
  { name: 'misfits-chatgpt-sheet', source: 'docs/design/misfits-v2/img/inspiration-chatgpt-misfits.png', sha256: '7dabe78b92e441f563a1bb2bc28c3e9bd18a2aae4ebc8498223c6894387a57a6', bytes: 2_124_650, width: 1312, height: 1199, storeBytes: 21_881 },
];

/** A fixture's bytes, exactly as committed. */
export function readC2paFixture(name: string): Uint8Array<ArrayBuffer> {
  // Not `new URL('./c2pa/…', import.meta.url)`: Vite rewrites that pattern into a served URL in the web app's tests.
  return new Uint8Array(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'c2pa', `${name}.png`)));
}

// ── PNG chunks ───────────────────────────────────────────────────────────────────────────────────────────────────
const u32 = (b: Uint8Array, i: number): number => (((b[i] ?? 0) << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0)) >>> 0;
const u32be = (value: number): Uint8Array => new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
const u16be = (value: number): Uint8Array => new Uint8Array([(value >>> 8) & 255, value & 255]);

export interface PngChunkAt {
  readonly type: string;
  readonly start: number;
  readonly data: Uint8Array;
  readonly end: number;
}

/** A well-formed PNG's chunks, in order. */
export function pngChunks(png: Uint8Array): PngChunkAt[] {
  const out: PngChunkAt[] = [];
  for (let pos = 8; pos + 12 <= png.length; ) {
    const length = u32(png, pos);
    const type = String.fromCharCode(...png.subarray(pos + 4, pos + 8));
    out.push({ type, start: pos, data: png.subarray(pos + 8, pos + 8 + length), end: pos + 12 + length });
    pos += 12 + length;
  }
  return out;
}

/** The data of a PNG's first caBX chunk (its C2PA manifest store). */
export function pngStore(png: Uint8Array): Uint8Array<ArrayBuffer> {
  const chunk = pngChunks(png).find((c) => c.type === 'caBX');
  if (!chunk) throw new Error('no caBX chunk');
  return chunk.data.slice();
}

/** The PNG with chunks inserted after the chunk of the given type (its first). */
export function insertAfter(png: Uint8Array, type: string, ...chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const at = pngChunks(png).find((c) => c.type === type);
  if (!at) throw new Error(`no ${type} chunk`);
  return concat(png.subarray(0, at.end), ...chunks, png.subarray(at.end));
}

/** The PNG with its first caBX chunk replaced by the given bytes (a whole chunk, or several). */
export function replaceStoreChunk(png: Uint8Array, ...chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const at = pngChunks(png).find((c) => c.type === 'caBX');
  if (!at) throw new Error('no caBX chunk');
  return concat(png.subarray(0, at.start), ...chunks, png.subarray(at.end));
}

/** A caBX chunk holding `data` (a correct CRC). */
export const caBX = (data: Uint8Array): Uint8Array<ArrayBuffer> => pngChunk('caBX', data);

// ── JUMBF boxes (ISO/IEC 19566-5) ────────────────────────────────────────────────────────────────────────────────
const JUMBF_UUID_TAIL = new Uint8Array([0x00, 0x11, 0x00, 0x10, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]);
/** The C2PA UUIDs: four ASCII letters then the ISO tail ('c2pa' store, 'c2ma' manifest, 'c2as' assertions, …). */
export const c2paUuid = (head: string): Uint8Array<ArrayBuffer> => concat(ascii(head), JUMBF_UUID_TAIL);
/** The embedded-file content type (c2pa.icon, c2pa.thumbnail). */
export const EMBEDDED_FILE_UUID = new Uint8Array([0x40, 0xcb, 0x0c, 0x32, 0xbb, 0x8a, 0x48, 0x9d, 0xa7, 0x0b, 0x2a, 0xd6, 0xf4, 0x7f, 0x43, 0x69]);

/** A box: LBox (its whole length), TBox, content. `length` overrides LBox. */
export const jumbfBox = (type: string, content: Uint8Array, length = 8 + content.length): Uint8Array<ArrayBuffer> => concat(u32be(length), ascii(type), content);

export interface DescriptionOptions {
  readonly toggles?: number;
  /** Bytes after the label (an ID, a signature, a private box) or stray bytes. */
  readonly tail?: Uint8Array;
}

/** A description box: UUID, toggles (label present when a label is given), label + NUL, tail. */
export function jumd(uuid: Uint8Array, label: string | null, { toggles, tail }: DescriptionOptions = {}): Uint8Array<ArrayBuffer> {
  const flags = toggles ?? (label === null ? 0x01 : 0x03);
  return jumbfBox('jumd', concat(uuid, new Uint8Array([flags]), label === null ? new Uint8Array() : concat(ascii(label), new Uint8Array([0])), tail ?? new Uint8Array()));
}

export const superbox = (description: Uint8Array, ...children: readonly Uint8Array[]): Uint8Array<ArrayBuffer> => jumbfBox('jumb', concat(description, ...children));

/** The same box with its header in the extended form: LBox 1, TBox, then an XLBox (high word 0) with the new length. */
export const withXlBox = (box: Uint8Array): Uint8Array<ArrayBuffer> => concat(u32be(1), box.subarray(4, 8), u32be(0), u32be(box.length + 8), box.subarray(8));

export const OPENAI_LIKE_ICON = '<svg width="716" height="716" viewBox="0 0 716 716" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h716v716H0z"/></svg>';

/** The salt box OpenAI puts in each assertion's description (a private box, toggles 0x10). */
const SALT = jumbfBox('c2sh', new Uint8Array(16).fill(7));

/** A file description box (`bfdb`): toggles (bit 0: a file name follows), the media type and the file name, NUL-ended. */
export const bfdb = (mediaType: string, fileName?: string): Uint8Array<ArrayBuffer> =>
  jumbfBox('bfdb', concat(new Uint8Array([fileName === undefined ? 0 : 1]), ascii(mediaType), new Uint8Array([0]), fileName === undefined ? new Uint8Array() : concat(ascii(fileName), new Uint8Array([0]))));

export interface IconOptions {
  /** The media type its `bfdb` declares (default image/svg+xml). */
  readonly mediaType?: string;
  /** Children instead of the `bfdb` and the `bidb` holding the file. */
  readonly boxes?: readonly Uint8Array[];
}

/** An embedded-file superbox as OpenAI writes c2pa.icon: a salted description, a `bfdb`, the file in a `bidb`. */
export function iconBox(file: string, { mediaType = 'image/svg+xml', boxes }: IconOptions = {}): Uint8Array<ArrayBuffer> {
  return superbox(jumd(EMBEDDED_FILE_UUID, 'c2pa.icon', { toggles: 0x13, tail: SALT }), ...(boxes ?? [bfdb(mediaType), jumbfBox('bidb', ascii(file))]));
}

/** A manifest laid out as OpenAI writes it: assertions (the given ones, then actions), claim, signature. */
export function manifest(...assertions: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const actions = superbox(jumd(c2paUuid('cbor'), 'c2pa.actions.v2', { toggles: 0x13, tail: SALT }), jumbfBox('cbor', new Uint8Array([0xa1, 0x67, ...ascii('actions'), 0x80])));
  return superbox(
    jumd(c2paUuid('c2ma'), 'urn:c2pa:00000000-0000-4000-8000-000000000000'),
    superbox(jumd(c2paUuid('c2as'), 'c2pa.assertions'), ...assertions, actions),
    superbox(jumd(c2paUuid('c2cl'), 'c2pa.claim.v2'), jumbfBox('cbor', new Uint8Array([0xa0]))),
    superbox(jumd(c2paUuid('c2cs'), 'c2pa.signature'), jumbfBox('cbor', new Uint8Array(64).fill(0x5a))),
  );
}

/** A manifest store (UUID and label `c2pa`) holding the given boxes, normally manifests. */
export const c2paStore = (...children: readonly Uint8Array[]): Uint8Array<ArrayBuffer> => superbox(jumd(c2paUuid('c2pa'), 'c2pa'), ...children);

export interface StoreOptions {
  /** The embedded icon file's bytes (OpenAI ships an SVG). */
  readonly icon?: string;
  readonly label?: string;
  readonly uuid?: Uint8Array;
}

/** A manifest store laid out as OpenAI writes it: store → manifest → assertions (icon, actions), claim, signature. */
export function syntheticStore({ icon = OPENAI_LIKE_ICON, label = 'c2pa', uuid = c2paUuid('c2pa') }: StoreOptions = {}): Uint8Array<ArrayBuffer> {
  return superbox(jumd(uuid, label), manifest(iconBox(icon)));
}

// ── Carriers ─────────────────────────────────────────────────────────────────────────────────────────────────────
export interface JpegPartsOptions {
  /** The JUMBF box instance number (En). */
  readonly instance?: number;
  /** Payload bytes per segment after the repeated box header (at most 65,517). */
  readonly partBytes?: number;
  /** Sequence numbers (Z) to use instead of 1, 2, …. */
  readonly sequences?: readonly number[];
  /** Header bytes each part repeats, instead of the box's own header length (16 when its LBox is 1, else 8). */
  readonly headerBytes?: number;
}

/**
 * A JUMBF box split over JPEG APP11 segments: 'JP', En, Z, the box's header repeated (LBox and TBox, and the XLBox when
 * LBox is 1), then the next slice of its content.
 */
export function jpegJumbfSegments(box: Uint8Array, { instance = 1, partBytes = 60_000, sequences, headerBytes }: JpegPartsOptions = {}): Uint8Array<ArrayBuffer>[] {
  const repeated = headerBytes ?? (u32(box, 0) === 1 && box.length >= 16 ? 16 : 8);
  const header = box.subarray(0, repeated);
  const body = box.subarray(repeated);
  const out: Uint8Array<ArrayBuffer>[] = [];
  for (let at = 0, i = 0; at < body.length || i === 0; at += partBytes, i += 1) {
    const z = sequences?.[i] ?? i + 1;
    out.push(jpegSegment(0xeb, concat(ascii('JP'), u16be(instance), u32be(z), header, body.subarray(at, at + partBytes))) as Uint8Array<ArrayBuffer>);
  }
  return out;
}
