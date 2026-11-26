/**
 * Image sniffing (SH-010; ART-01). The type of an upload comes from its bytes: a magic number plus a structural walk
 * of the whole container, never the file name or the browser's MIME guess. Accepted: still PNG, JPEG and WebP whose
 * sides are 256–4096 px, at most 10 MB. Refused, with a reason a person can act on:
 *  - SVG and HTML/markup (active content), GIF, anything else;
 *  - "polyglots": markup or script hidden in metadata chunks/segments, or any data after the image's end marker;
 *  - damaged structure (bad PNG CRC, missing IEND/EOI, truncated chunks), animation.
 * Compressed image data (PNG IDAT, JPEG scans, WebP bitstreams) is not scanned for markup: it is noise, and a pattern
 * found there would be a false alarm. The pipeline never renders these bytes; it only decodes and re-encodes them.
 * A C2PA manifest store ("content credentials", as AI tools write them) is scanned like any metadata, except that an
 * SVG file embedded in it (OpenAI's c2pa.icon) may open with `<svg`, and only as one static drawing; a second store, or
 * a damaged or incomplete one, makes the picture damaged (see "C2PA content credentials" below; SH-ACCEPT-C2PA). The
 * bytes are kept as uploaded, store included.
 */
import { IMAGE_LIMITS } from './limits';

export type ImageFormat = 'png' | 'jpeg' | 'webp';
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp';
export type ImageRejectionCode =
  | 'empty'
  | 'too_large'
  | 'svg'
  | 'html'
  | 'gif'
  | 'unsupported_type'
  | 'embedded_markup'
  | 'trailing_data'
  | 'malformed'
  | 'animated'
  | 'dimensions_too_small'
  | 'dimensions_too_large';

export interface ImageAccepted {
  readonly ok: true;
  readonly format: ImageFormat;
  readonly mediaType: ImageMediaType;
  readonly width: number;
  readonly height: number;
}
export interface ImageRejected {
  readonly ok: false;
  readonly code: ImageRejectionCode;
  readonly message: string;
}
export type ImageInspection = ImageAccepted | ImageRejected;

export interface ImageLimits {
  readonly maxBytes: number;
  readonly minSide: number;
  readonly maxSide: number;
}

const MEDIA_TYPE: Readonly<Record<ImageFormat, ImageMediaType>> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

const group = (value: number): string => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export function rejectionMessage(code: ImageRejectionCode, detail: { width?: number; height?: number; limits?: ImageLimits } = {}): string {
  const limits = detail.limits ?? IMAGE_LIMITS;
  const size = `${group(detail.width ?? 0)} × ${group(detail.height ?? 0)} px`;
  switch (code) {
    case 'empty':
      return 'The file is empty, so there is no image to check.';
    case 'too_large':
      return `The file is larger than ${Math.floor(limits.maxBytes / (1024 * 1024))} MB.`;
    case 'svg':
      return 'SVG files are not accepted because they can contain scripts. Use PNG, JPEG or WebP.';
    case 'html':
      return 'This file is web markup (HTML or script), not an image, whatever its name says. Use PNG, JPEG or WebP.';
    case 'gif':
      return 'GIF files are not accepted. Use PNG, JPEG or WebP.';
    case 'unsupported_type':
      return 'This is not a PNG, JPEG or WebP image. The type is read from the file’s content, not its name.';
    case 'embedded_markup':
      return 'The image hides web markup or a script in its metadata (a polyglot file), so it is refused.';
    case 'trailing_data':
      return 'The file carries extra data after the end of the image, a common way to hide a second file, so it is refused.';
    case 'malformed':
      return 'The image structure is damaged or incomplete, so it cannot be checked.';
    case 'animated':
      return 'Animated images are not accepted: the published artwork is a still image.';
    case 'dimensions_too_small':
      return `The image is ${size}; each side must be at least ${group(limits.minSide)} px.`;
    case 'dimensions_too_large':
      return `The image is ${size}; each side must be at most ${group(limits.maxSide)} px.`;
  }
}

const reject = (code: ImageRejectionCode, detail?: Parameters<typeof rejectionMessage>[1]): ImageRejected => ({
  ok: false,
  code,
  message: rejectionMessage(code, detail),
});

// ── Byte helpers ─────────────────────────────────────────────────────────────────────────────────────────────────
const u16be = (b: Uint8Array, i: number): number => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u16le = (b: Uint8Array, i: number): number => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, i: number): number => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, i: number): number => (((b[i] ?? 0) << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0)) >>> 0;
const u32le = (b: Uint8Array, i: number): number => ((b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16) | ((b[i + 3] ?? 0) << 24)) >>> 0;
const fourcc = (b: Uint8Array, i: number): string => String.fromCharCode(b[i] ?? 0, b[i + 1] ?? 0, b[i + 2] ?? 0, b[i + 3] ?? 0);
const startsWith = (b: Uint8Array, prefix: readonly number[], at = 0): boolean => prefix.every((byte, k) => b[at + k] === byte);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const ascii = (text: string): number[] => Array.from(text, (ch) => ch.charCodeAt(0));

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(b: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i += 1) crc = (CRC_TABLE[(crc ^ (b[i] ?? 0)) & 255] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ── Markup detection in metadata regions ─────────────────────────────────────────────────────────────────────────
/** Lower-case ASCII patterns that make a region active content. Compared case-insensitively. */
const MARKUP_PATTERNS: readonly (readonly number[])[] = [
  '<script',
  '<html',
  '<body',
  '<head',
  '<iframe',
  '<object',
  '<embed',
  '<svg',
  '<!doctype',
  '<?php',
  '<meta',
  'javascript:',
  'vbscript:',
  'data:text/html',
].map(ascii);

const lower = (byte: number): number => (byte >= 0x41 && byte <= 0x5a ? byte | 0x20 : byte);

/** Whether a markup pattern starts in [start, end). A match may run on up to `limit` (by default `end`). */
function hasMarkup(b: Uint8Array, start: number, end: number, limit = end): boolean {
  for (let i = start; i < end; i += 1) {
    const first = lower(b[i] ?? 0);
    for (const pattern of MARKUP_PATTERNS) {
      if (pattern[0] !== first || i + pattern.length > limit) continue;
      let k = 1;
      while (k < pattern.length && lower(b[i + k] ?? 0) === pattern[k]) k += 1;
      if (k === pattern.length) return true;
    }
  }
  return false;
}

// SH-SNIFF-HANDLERS: exact element names, so <imageData> and XMP/RDF names stay metadata.
const ACTIVE_ELEMENTS = [
  'img', 'image', 'a', 'form', 'input', 'button', 'link', 'style', 'base', 'video', 'audio', 'source', 'track', 'iframe',
  'frame', 'frameset', 'details', 'marquee', 'math', 'template', 'textarea', 'select', 'option',
  'applet', 'bgsound', 'portal', 'use', 'animate', 'animatemotion', 'animatetransform', 'set', 'foreignobject', 'feimage',
].map(ascii);
const ON = ascii('on');
const STYLE = ascii('style');
const ACTIVE_CSS = ['url(', 'expression('].map(ascii);
const isAsciiLetter = (c: number): boolean => lower(c) >= 0x61 && lower(c) <= 0x7a;
const isHtmlSpace = (c: number): boolean => isXmlSpace(c) || c === 0x0c;
const endsHtmlName = (c: number): boolean => isHtmlSpace(c) || c === 0x2f || c === 0x3e;

/**
 * Conservative tag spans: every '<' followed by an ASCII letter starts a candidate, even inside another name or
 * quoted value. Its span ends at the next unquoted '>' or the region end. Within it, any delimiter-prefixed
 * on<letters>= or active style value counts, including text inside another attribute's quoted value.
 *
 * Walk backwards to share suffix work between overlapping candidates. The three ends give the first closing '>'
 * when entering the suffix unquoted, single-quoted or double-quoted; a quote swaps the corresponding ends. The
 * earliest active-attribute end in the suffix fits a candidate iff it is at or before that candidate's end.
 * For styles, retain the nearest CSS token and the last value delimiters before it, avoiding rescans of values.
 * Fixed-size name/pattern checks and disjoint letter/space runs keep this linear with constant auxiliary space.
 * All reads stay in [start, end), including regions bounded by exempt C2PA icons. No decoding or decompression.
 */
function hasActiveMarkup(b: Uint8Array, start: number, end: number): boolean {
  let unquotedEnd = end;
  let singleQuotedEnd = end;
  let doubleQuotedEnd = end;
  let activeAttributeEnd = end + 1;
  let cssEnd = end + 1;
  let singleBeforeCss = -1;
  let doubleBeforeCss = -1;
  let unquotedBeforeCss = -1;

  for (let pos = end - 1; pos >= start; pos -= 1) {
    const c = b[pos] ?? 0;
    if (c === 0x3e) unquotedEnd = pos;
    else if (c === 0x27) [unquotedEnd, singleQuotedEnd] = [singleQuotedEnd, unquotedEnd];
    else if (c === 0x22) [unquotedEnd, doubleQuotedEnd] = [doubleQuotedEnd, unquotedEnd];

    for (const pattern of ACTIVE_CSS) {
      if (lower(c) === pattern[0] && isAt(b, pos, pattern, end)) {
        cssEnd = pos + pattern.length;
        singleBeforeCss = doubleBeforeCss = unquotedBeforeCss = -1;
      }
    }
    // Only the first delimiter encountered walking backwards is the last one before this CSS token.
    if (c === 0x27 && singleBeforeCss < 0) singleBeforeCss = pos;
    if (c === 0x22 && doubleBeforeCss < 0) doubleBeforeCss = pos;
    if ((isHtmlSpace(c) || c === 0x3e) && unquotedBeforeCss < 0) unquotedBeforeCss = pos;

    const previous = pos > start ? b[pos - 1] ?? 0 : 0;
    const attributeBoundary = isHtmlSpace(previous) || previous === 0x2f || previous === 0x22 || previous === 0x27 || previous === 0x3c;
    if (attributeBoundary && (lower(c) === ON[0] || lower(c) === STYLE[0])) {
      let nameEnd = pos;
      const style = isAt(b, pos, STYLE, end);
      if (style) nameEnd += STYLE.length;
      else if (isAt(b, pos, ON, end)) {
        nameEnd += ON.length;
        while (nameEnd < end && isAsciiLetter(b[nameEnd] ?? 0)) nameEnd += 1;
        if (nameEnd === pos + ON.length) continue;
      } else continue;
      let value = nameEnd;
      while (value < end && isHtmlSpace(b[value] ?? 0)) value += 1;
      if (value === end || b[value] !== 0x3d) continue;
      if (!style) activeAttributeEnd = Math.min(activeAttributeEnd, value + 1);
      else if (cssEnd <= end) {
        value += 1;
        while (value < end && isHtmlSpace(b[value] ?? 0)) value += 1;
        // The nearest CSS token must occur before this value closes. Quotes inside unquoted values are data.
        const quote = value < end ? b[value] : null;
        const inValue = quote === 0x27 ? singleBeforeCss === value
          : quote === 0x22 ? doubleBeforeCss === value
          : unquotedBeforeCss < value;
        if (inValue) activeAttributeEnd = Math.min(activeAttributeEnd, cssEnd);
      }
    }

    if (c !== 0x3c || pos + 1 >= end || !isAsciiLetter(b[pos + 1] ?? 0)) continue;
    if (activeAttributeEnd <= unquotedEnd) return true;
    for (const tag of ACTIVE_ELEMENTS) {
      const nameEnd = pos + 1 + tag.length;
      if (isAt(b, pos + 1, tag, end) && (nameEnd === end || endsHtmlName(b[nameEnd] ?? 0) || b[nameEnd] === 0x3c)) return true;
    }
  }
  return false;
}

type Region = readonly [start: number, end: number];

/** JPEG metadata can split a legacy pattern, tag, attribute or CSS function. The payload copy is bounded by the file. */
function hasSplitActiveMarkup(b: Uint8Array, regions: readonly Region[]): boolean {
  if (regions.length < 2) return false;
  const joined = new Uint8Array(regions.reduce((sum, [start, end]) => sum + end - start, 0));
  let pos = 0;
  // Non-store APP11 regions are collected after the other segments; restore file order before joining payloads.
  for (const [start, end] of [...regions].sort((a, z) => a[0] - z[0])) {
    joined.set(b.subarray(start, end), pos);
    pos += end - start;
  }
  return hasMarkup(joined, 0, joined.length) || hasActiveMarkup(joined, 0, joined.length);
}

/** A C2PA manifest store (for JPEG, its APP11 parts joined) and the embedded SVG files in it, in order. */
interface Credentials {
  readonly bytes: Uint8Array;
  readonly svgs: readonly Region[];
}
/**
 * A container read to its end: its size, the metadata regions to scan, the JPEG APP11 JUMBF boxes other than the store
 * as their parts rebuild them (scanned whole, like regions), and the C2PA store if there is one.
 */
type Parsed = { ok: true; width: number; height: number; regions: Region[]; joined: Uint8Array[]; credentials: Credentials | null } | { ok: false; code: ImageRejectionCode };
const fail = (code: ImageRejectionCode): Parsed => ({ ok: false, code });

// ── C2PA content credentials ─────────────────────────────────────────────────────────────────────────────────────
// AI tools (ChatGPT / GPT Image) sign their pictures with a C2PA manifest store: a JUMBF box tree (ISO/IEC 19566-5) in
// a PNG `caBX` chunk, in JPEG APP11 segments or in a WebP `C2PA` chunk. Its assertions may embed files: OpenAI's
// `c2pa.icon` is an SVG of its logo, which the markup scan reads as a polyglot. Founder decision 2026-10-24: such
// pictures are accepted as they are, credentials included (SH-ACCEPT-C2PA). The decision covers AI pictures, not
// markup: a store is scanned for markup like any other metadata, whole (fix round 1). The one exception is an embedded
// SVG file, the binary data (`bidb`) of an embedded-file superbox whose description (`bfdb`) says image/svg+xml as
// OpenAI writes it: it may open with its `<svg` tag (one SVG per embedded-file box; a store with several manifests
// carries several icons), and the rest of it must be one static drawing (`isStaticSvg`).
// A store is what the picture says is one: a PNG `caBX` chunk, a WebP `C2PA` chunk, or a JPEG APP11 JUMBF superbox that
// does not describe itself with another UUID (`mayBeC2paStore`). A picture holds at most one, and it must be complete
// and well-formed, whatever it holds, or the picture is refused as damaged (fix round 2): exactly one `jumb` superbox
// filling its carrier (in JPEG, rebuilt from all its APP11 parts), described by the C2PA manifest-store UUID and the
// label `c2pa`, holding at least one superbox (a manifest) and nothing else; every box inside well-formed (no zero or
// short lengths, no box past its parent, a printable type), each superbox starting with a description box whose fields
// its toggles account for exactly, children filling their parent with no byte left over, at most 16 levels deep.
// Everything else (another chunk or segment, another JUMBF box) is scanned as before, with no exception. Signatures
// and hashes are not checked; the store is never interpreted, only kept.
const JUMBF_UUID_TAIL = [0x00, 0x11, 0x00, 0x10, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71] as const;
const C2PA_STORE_UUID = [...ascii('c2pa'), ...JUMBF_UUID_TAIL];
const C2PA_STORE_LABEL = ascii('c2pa');
const MAX_JUMBF_DEPTH = 16;
/** The embedded-file content type (ISO/IEC 19566-5): a file description box (`bfdb`) then the file (`bidb`). */
const EMBEDDED_FILE_UUID = [0x40, 0xcb, 0x0c, 0x32, 0xbb, 0x8a, 0x48, 0x9d, 0xa7, 0x0b, 0x2a, 0xd6, 0xf4, 0x7f, 0x43, 0x69] as const;
/** A `bfdb` saying image/svg+xml as OpenAI writes it: toggles 0 (no file name, not a reference), the media type, NUL. */
const SVG_FILE_DESCRIPTION = [0x00, ...ascii('image/svg+xml'), 0x00];
const SVG_TAG = ascii('<svg');

interface Box {
  readonly type: string;
  readonly content: number;
  readonly end: number;
}

/**
 * The header of the box at `pos`, read only before `limit`: its size (8 bytes, or 16 with an XLBox) and the length the
 * box declares. Null when the header does not fit before `limit` or its XLBox needs more than 32 bits.
 */
function boxHeader(b: Uint8Array, pos: number, limit: number): { readonly header: number; readonly length: number } | null {
  if (pos + 8 > limit) return null;
  const declared = u32be(b, pos);
  if (declared !== 1) return { header: 8, length: declared };
  if (pos + 16 > limit || u32be(b, pos + 8) !== 0) return null;
  return { header: 16, length: u32be(b, pos + 12) };
}

/** The box at `pos`, ending by `limit`, or null. Length 0 ("to the end of the file") is not accepted inside a store. */
function readBox(b: Uint8Array, pos: number, limit: number): Box | null {
  const head = boxHeader(b, pos, limit);
  if (!head || head.length < head.header || head.length > limit - pos) return null;
  for (let k = 4; k < 8; k += 1) {
    const c = b[pos + k] ?? 0;
    if (c < 0x20 || c > 0x7e) return null;
  }
  return { type: fourcc(b, pos + 4), content: pos + head.header, end: pos + head.length };
}

/** A description box's content: UUID, toggles, then exactly the label, ID, signature and private box they announce. */
function readDescription(b: Uint8Array, start: number, end: number): { readonly uuid: number; readonly label: Region | null } | null {
  if (end - start < 17) return null;
  const toggles = b[start + 16] ?? 0;
  if ((toggles & 0xe0) !== 0) return null;
  let pos = start + 17;
  let label: Region | null = null;
  if ((toggles & 0x02) !== 0) {
    const nul = b.subarray(pos, end).indexOf(0);
    if (nul < 0) return null;
    label = [pos, pos + nul];
    pos += nul + 1;
  }
  if ((toggles & 0x04) !== 0) pos += 4;
  if ((toggles & 0x08) !== 0) pos += 32;
  if ((toggles & 0x10) !== 0) {
    const own = readBox(b, pos, end);
    if (!own) return null;
    pos = own.end;
  }
  return pos === end ? { uuid: start, label } : null;
}

/**
 * A superbox's content [start, end): its description, its number of children, and whether every child is itself a
 * (well-formed) superbox. Embedded SVG files found in it are added to `svgs`, in order.
 */
function readSuperbox(b: Uint8Array, start: number, end: number, depth: number, svgs: Region[]): { readonly description: NonNullable<ReturnType<typeof readDescription>>; readonly children: number; readonly onlySuperboxes: boolean } | null {
  if (depth > MAX_JUMBF_DEPTH) return null;
  const head = readBox(b, start, end);
  if (head?.type !== 'jumd') return null;
  const description = readDescription(b, head.content, head.end);
  if (!description) return null;
  let children = 0;
  let onlySuperboxes = true;
  let first: Box | null = null;
  let second: Box | null = null;
  for (let pos = head.end; pos < end; ) {
    const child = readBox(b, pos, end);
    if (!child) return null;
    if (child.type === 'jumb') {
      if (!readSuperbox(b, child.content, child.end, depth + 1, svgs)) return null;
    } else {
      onlySuperboxes = false;
    }
    if (children === 0) first = child;
    else if (children === 1) second = child;
    children += 1;
    pos = child.end;
  }
  const svg = children === 2 && first && second ? embeddedSvg(b, description.uuid, first, second) : null;
  if (svg) svgs.push(svg);
  return { description, children, onlySuperboxes };
}

/**
 * The SVG file of an embedded-file superbox (UUID at `uuid`) whose two children are a `bfdb` saying image/svg+xml and
 * a `bidb` opening with `<svg`: that `bidb`'s content. Null for anything else: a file name in the `bfdb`, another media
 * type or spelling, an XML declaration, byte-order mark or space before `<svg`, a third box.
 */
function embeddedSvg(b: Uint8Array, uuid: number, description: Box, file: Box): Region | null {
  if (!startsWith(b, EMBEDDED_FILE_UUID, uuid) || description.type !== 'bfdb' || file.type !== 'bidb') return null;
  if (description.end - description.content !== SVG_FILE_DESCRIPTION.length || !startsWith(b, SVG_FILE_DESCRIPTION, description.content)) return null;
  if (file.end - file.content < SVG_TAG.length || !startsWith(b, SVG_TAG, file.content)) return null;
  return [file.content, file.end];
}

/** When `b` is exactly one well-formed C2PA manifest store, and nothing else: the embedded SVG files in it. Else null. */
function readC2paStore(b: Uint8Array): Region[] | null {
  const store = readBox(b, 0, b.length);
  if (store?.type !== 'jumb' || store.end !== b.length) return null;
  const svgs: Region[] = [];
  const tree = readSuperbox(b, store.content, store.end, 1, svgs);
  if (!tree || tree.children === 0 || !tree.onlySuperboxes) return null;
  const { uuid, label } = tree.description;
  const isStore = startsWith(b, C2PA_STORE_UUID, uuid) && label !== null && label[1] - label[0] === C2PA_STORE_LABEL.length && startsWith(b, C2PA_STORE_LABEL, label[0]);
  return isStore ? svgs : null;
}

/** A C2PA store carrier's bytes: the store and its embedded SVG files when the bytes are exactly one store, else null. */
function credentialsIn(bytes: Uint8Array): Credentials | null {
  const svgs = readC2paStore(bytes);
  return svgs ? { bytes, svgs } : null;
}

/**
 * Whether a C2PA store holds markup. It is scanned whole, like any metadata (a match may run across boxes), except that
 * each embedded SVG file may open with its `<svg` tag; the rest of that file is scanned as well and must be static.
 */
function storeHasMarkup({ bytes, svgs }: Credentials): boolean {
  let pos = 0;
  for (const [start, end] of svgs) {
    if (hasMarkup(bytes, pos, start, bytes.length) || hasActiveMarkup(bytes, pos, start) || hasMarkup(bytes, start + 1, end, bytes.length) || !isStaticSvg(bytes, start, end)) return true;
    pos = end;
  }
  return hasMarkup(bytes, pos, bytes.length) || hasActiveMarkup(bytes, pos, bytes.length);
}

/** The elements an embedded SVG may use: static drawing only (OpenAI's c2pa.icon uses `svg` and `path`). Lower case. */
const SVG_DRAWING_ELEMENTS: readonly (readonly number[])[] = ['svg', 'g', 'defs', 'title', 'desc', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask'].map(ascii);
/** How deep an embedded SVG's elements may nest (OpenAI's icon: 2). */
const MAX_SVG_DEPTH = 32;
const HREF = ascii('href');
const SVG_NAME = ascii('svg');
const XMLNS = ascii('xmlns');
const SVG_NAMESPACE = ascii('http://www.w3.org/2000/svg');
/** A byte that can be part of an XML name, the colon aside: ASCII letters and digits, `_`, `-`, `.`. */
const isNameByte = (c: number): boolean => (lower(c) >= 0x61 && lower(c) <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x5f || c === 0x2d || c === 0x2e;
/** A byte that can start an attribute's name: ASCII letters, `_`, `:`. */
const startsAttributeName = (c: number): boolean => (lower(c) >= 0x61 && lower(c) <= 0x7a) || c === 0x5f || c === 0x3a;
/** XML whitespace: space, tab, LF, CR (a form feed is not). */
const isXmlSpace = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
/** Whether the lower-case ASCII `pattern` is at `i`, compared case-insensitively, ending by `end`. */
function isAt(b: Uint8Array, i: number, pattern: readonly number[], end: number): boolean {
  if (i + pattern.length > end) return false;
  for (let k = 0; k < pattern.length; k += 1) if (lower(b[i + k] ?? 0) !== pattern[k]) return false;
  return true;
}
const skipSpace = (b: Uint8Array, pos: number, end: number): number => {
  let at = pos;
  while (at < end && isXmlSpace(b[at] ?? 0)) at += 1;
  return at;
};

/**
 * Whether the embedded SVG file [start, end) is one static drawing:
 *  - byte rules, case-insensitive: no `&` (no character or entity reference, so nothing is spelled indirectly, as in
 *    `&#106;avascript:`); no `href`, so no `xlink:href`; no `on` after a byte that cannot be part of a name (space, tab,
 *    LF, CR, FF, quote, slash, colon, …), so no event-handler attribute however it is spaced or prefixed;
 *  - its structure, read by `isOneDrawing`: one complete `svg` root of allowed elements and nothing after it.
 * The markup patterns are checked on the same bytes by `storeHasMarkup` (`javascript:` in a value, a second `<svg`).
 */
function isStaticSvg(b: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i += 1) {
    const c = lower(b[i] ?? 0);
    if (c === 0x26 || (c === 0x68 && isAt(b, i, HREF, end)) || (c === 0x6f && i + 1 < end && lower(b[i + 1] ?? 0) === 0x6e && !isNameByte(b[i - 1] ?? 0))) return false;
  }
  return isOneDrawing(b, start, end);
}

/** The end of the name of an allowed element at `pos` (any case, no prefix), or -1. */
function drawingElementEnd(b: Uint8Array, pos: number, end: number): number {
  let stop = pos;
  while (stop < end && isNameByte(b[stop] ?? 0)) stop += 1;
  for (const name of SVG_DRAWING_ELEMENTS) if (name.length === stop - pos && isAt(b, pos, name, end)) return stop;
  return -1;
}

/** The end of an attribute's name at `pos` (letters, digits, `_`, `-`, `.`, `:`; not starting with a digit, `-`, `.`). */
function attributeNameEnd(b: Uint8Array, pos: number, end: number): number {
  if (pos >= end || !startsAttributeName(b[pos] ?? 0)) return pos;
  let stop = pos + 1;
  while (stop < end && (isNameByte(b[stop] ?? 0) || b[stop] === 0x3a)) stop += 1;
  return stop;
}

/**
 * Whether [start, end) is one complete drawing, read front to back by a small tokenizer (nothing is built or rendered):
 * an `svg` root, then nothing but XML whitespace; every tag complete, a start tag `<name attribute="value" …>` or
 * `<name …/>` with each attribute after whitespace and its value in quotes without `<`, an end tag `</name>` closing the
 * innermost open element by its exact name; element names from SVG_DRAWING_ELEMENTS (no prefix), every element, empty
 * or not, at most MAX_SVG_DEPTH deep; a default namespace (`xmlns`) only SVG's. So no script, a, foreignObject, use,
 * image, animate, set, style or iframe; no comment, CDATA, DOCTYPE (so no entity declaration) or processing
 * instruction; no unfinished, unquoted or unbalanced tag; no drawing moved into another vocabulary; nothing after the
 * root.
 */
function isOneDrawing(b: Uint8Array, start: number, end: number): boolean {
  const open = new Uint32Array(MAX_SVG_DEPTH * 2); // each open element's name: where it starts, its length
  let depth = 0;
  let closed = false; // the root has ended
  let pos = start;
  while (pos < end) {
    if (b[pos] !== 0x3c) {
      if (depth === 0 && !isXmlSpace(b[pos] ?? 0)) return false;
      pos += 1;
      continue;
    }
    if (closed || pos + 1 >= end) return false;
    if (b[pos + 1] === 0x2f) {
      if (depth === 0) return false;
      depth -= 1;
      const name = pos + 2;
      const length = open[depth * 2 + 1] ?? 0;
      const from = open[depth * 2] ?? 0;
      if (name + length >= end) return false;
      for (let k = 0; k < length; k += 1) if (b[name + k] !== b[from + k]) return false;
      const after = b[name + length] ?? 0;
      if (isNameByte(after) || after === 0x3a) return false;
      const close = skipSpace(b, name + length, end);
      if (close >= end || b[close] !== 0x3e) return false;
      pos = close + 1;
      closed = depth === 0;
      continue;
    }
    const name = pos + 1;
    const nameEnd = drawingElementEnd(b, name, end);
    if (nameEnd < 0 || (depth === 0 && (nameEnd - name !== SVG_NAME.length || !startsWith(b, SVG_NAME, name)))) return false;
    let at = nameEnd;
    let empty = false;
    for (;;) {
      const next = skipSpace(b, at, end);
      if (next >= end) return false;
      if (b[next] === 0x3e) {
        at = next + 1;
        break;
      }
      if (b[next] === 0x2f) {
        if (next + 1 >= end || b[next + 1] !== 0x3e) return false;
        empty = true;
        at = next + 2;
        break;
      }
      const attributeEnd = attributeNameEnd(b, next, end);
      if (next === at || attributeEnd === next) return false;
      let value = skipSpace(b, attributeEnd, end);
      if (value >= end || b[value] !== 0x3d) return false;
      value = skipSpace(b, value + 1, end);
      if (value >= end) return false;
      const quote = b[value];
      if (quote !== 0x22 && quote !== 0x27) return false;
      let stop = value + 1;
      while (stop < end && b[stop] !== quote) {
        if (b[stop] === 0x3c) return false;
        stop += 1;
      }
      if (stop >= end) return false;
      // A default namespace may only be SVG's: it decides what every unprefixed name means.
      const isDefaultNamespace = attributeEnd - next === XMLNS.length && startsWith(b, XMLNS, next);
      if (isDefaultNamespace && (stop - value - 1 !== SVG_NAMESPACE.length || !startsWith(b, SVG_NAMESPACE, value + 1))) return false;
      at = stop + 1;
    }
    // Every element counts, an empty one (`<path/>`) as much as a pair: at most MAX_SVG_DEPTH deep.
    if (depth === MAX_SVG_DEPTH) return false;
    if (empty) {
      closed = depth === 0;
    } else {
      open[depth * 2] = name;
      open[depth * 2 + 1] = nameEnd - name;
      depth += 1;
    }
    pos = at;
  }
  return closed;
}

/** Part of a JUMBF box in a JPEG APP11 segment's payload: 'JP', box instance (2), sequence number (4), box header, data. */
export interface JumbfPart {
  readonly instance: number;
  readonly sequence: number;
  readonly start: number;
  readonly end: number;
}
const JPEG_JUMBF_PREFIX = 8;

function jumbfPart(b: Uint8Array, start: number, end: number): JumbfPart | null {
  if (end - start < JPEG_JUMBF_PREFIX + 8 || b[start] !== 0x4a || b[start + 1] !== 0x50) return null;
  return { instance: u16be(b, start + 2), sequence: u32be(b, start + 4), start, end };
}

/**
 * One instance's parts joined back into its box (every part repeats the box header; sequence numbers 1, 2, …), or null.
 * Reads each part only inside [start, end): the header's XLBox only once the first part is known to hold it. Exported
 * for its bounds test; not part of the package's API.
 */
export function joinJumbfParts(b: Uint8Array, parts: readonly JumbfPart[]): Uint8Array | null {
  const first = parts[0];
  if (!first) return null;
  const at = first.start + JPEG_JUMBF_PREFIX;
  const head = boxHeader(b, at, first.end);
  if (!head || head.length < head.header) return null;
  const { header, length } = head;
  let total = header;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] as JumbfPart;
    const data = part.start + JPEG_JUMBF_PREFIX + header;
    if (part.sequence !== i + 1 || data > part.end) return null;
    for (let k = 0; k < header; k += 1) if (b[part.start + JPEG_JUMBF_PREFIX + k] !== b[at + k]) return null;
    total += part.end - data;
  }
  if (total !== length) return null;
  const joined = new Uint8Array(total);
  joined.set(b.subarray(at, at + header));
  let pos = header;
  for (const part of parts) {
    const data = b.subarray(part.start + JPEG_JUMBF_PREFIX + header, part.end);
    joined.set(data, pos);
    pos += data.length;
  }
  return joined;
}

/**
 * Whether the JUMBF box at `at` (readable before `end`) is to be taken as a C2PA manifest store: a superbox (`jumb`) whose
 * description box carries the C2PA store UUID or cannot be read. Each box is read as it declares itself, its header 8
 * bytes or 16 with an XLBox: the description must lie whole inside the superbox's declared length and the bytes at
 * hand, and its UUID inside the description; a UUID cut off by the description's end cannot be read, whatever follows.
 * Only a superbox that shows a whole description with another UUID, or a box that is no superbox, is something else.
 */
function mayBeC2paStore(b: Uint8Array, at: number, end: number): boolean {
  if (at + 8 > end || fourcc(b, at + 4) !== 'jumb') return false;
  const head = boxHeader(b, at, end);
  if (!head || head.length < head.header) return true;
  const description = readBox(b, at + head.header, Math.min(end, at + head.length));
  if (description?.type !== 'jumd') return true;
  return description.content + C2PA_STORE_UUID.length > description.end || startsWith(b, C2PA_STORE_UUID, description.content);
}

/**
 * The APP11 JUMBF boxes, their parts grouped by box instance and each instance looked at. The one C2PA store must rebuild
 * from its parts into a well-formed store; a second store, or a store that is damaged or incomplete, makes the picture
 * damaged (null), whatever the boxes hold. Every other box is scanned as its parts sit in the file (as before) and, when
 * they rebuild it, also as one box, so a match split across two parts is found.
 */
function readApp11(b: Uint8Array, parts: readonly JumbfPart[]): { readonly regions: Region[]; readonly joined: Uint8Array[]; readonly credentials: Credentials | null } | null {
  const instances = new Map<number, JumbfPart[]>();
  for (const part of parts) {
    const group = instances.get(part.instance);
    if (group) group.push(part);
    else instances.set(part.instance, [part]);
  }
  const regions: Region[] = [];
  const joined: Uint8Array[] = [];
  let credentials: Credentials | null = null;
  for (const group of instances.values()) {
    const first = group[0] as JumbfPart;
    const box = joinJumbfParts(b, group);
    if (box ? mayBeC2paStore(box, 0, box.length) : mayBeC2paStore(b, first.start + JPEG_JUMBF_PREFIX, first.end)) {
      const store = box ? credentialsIn(box) : null;
      if (!store || credentials) return null;
      credentials = store;
    } else {
      for (const part of group) regions.push([part.start, part.end]);
      if (box) joined.push(box);
    }
  }
  return { regions, joined, credentials };
}

// ── Type detection ───────────────────────────────────────────────────────────────────────────────────────────────
type Detected = ImageFormat | 'gif' | 'svg' | 'html' | 'unknown';

function detect(b: Uint8Array): Detected {
  if (startsWith(b, PNG_SIGNATURE)) return 'png';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(b, ascii('RIFF')) && b.length >= 12) return startsWith(b, ascii('WEBP'), 8) ? 'webp' : 'unknown';
  if (startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a'))) return 'gif';
  let i = startsWith(b, [0xef, 0xbb, 0xbf]) ? 3 : 0;
  while (i < b.length && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0d)) i += 1;
  if (b[i] === 0x3c) {
    const head = String.fromCharCode(...b.subarray(i, Math.min(b.length, i + 4096))).toLowerCase();
    return head.includes('<svg') ? 'svg' : 'html';
  }
  return 'unknown';
}

// ── PNG ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const isChunkType = (b: Uint8Array, i: number): boolean => {
  for (let k = 0; k < 4; k += 1) {
    const c = b[i + k] ?? 0;
    if (!((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a))) return false;
  }
  return true;
};

function parsePng(b: Uint8Array): Parsed {
  let pos = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let first = true;
  let sawIdat = false;
  let credentials: Credentials | null = null;
  const regions: Region[] = [];
  for (;;) {
    if (pos + 12 > b.length) return fail('malformed');
    const length = u32be(b, pos);
    if (length > 0x7fffffff || !isChunkType(b, pos + 4)) return fail('malformed');
    const type = fourcc(b, pos + 4);
    const dataStart = pos + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > b.length) return fail('malformed');
    if (crc32(b, pos + 4, dataEnd) !== u32be(b, dataEnd)) return fail('malformed');
    if (first) {
      if (type !== 'IHDR' || length !== 13) return fail('malformed');
      width = u32be(b, dataStart);
      height = u32be(b, dataStart + 4);
      first = false;
    } else if (type === 'IHDR') {
      return fail('malformed');
    }
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') return fail('animated');
    if (type === 'IDAT') sawIdat = true;
    else if (type === 'caBX') {
      // A C2PA manifest store: one per picture, complete and well-formed, or the picture is damaged.
      if (credentials) return fail('malformed');
      credentials = credentialsIn(b.subarray(dataStart, dataEnd));
      if (!credentials) return fail('malformed');
    } else if (type !== 'IHDR' && type !== 'IEND') regions.push([dataStart, dataEnd]);
    pos = dataEnd + 4;
    if (type === 'IEND') break;
  }
  if (!sawIdat) return fail('malformed');
  if (pos < b.length) return fail('trailing_data');
  return { ok: true, width, height, regions, joined: [], credentials };
}

// ── JPEG ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const isSof = (m: number): boolean => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

function parseJpeg(b: Uint8Array): Parsed {
  let pos = 2;
  let width = 0;
  let height = 0;
  let sawSof = false;
  let sawSos = false;
  let end = -1;
  const regions: Region[] = [];
  const jumbf: JumbfPart[] = [];
  while (end < 0) {
    if (pos >= b.length || b[pos] !== 0xff) return fail('malformed');
    while (b[pos] === 0xff) pos += 1;
    if (pos >= b.length) return fail('malformed');
    const marker = b[pos] ?? 0;
    pos += 1;
    if (marker === 0xd9) {
      end = pos;
      break;
    }
    if (marker === 0xd8 || marker === 0x00) return fail('malformed');
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (pos + 2 > b.length) return fail('malformed');
    const length = u16be(b, pos);
    const segStart = pos + 2;
    const segEnd = pos + length;
    if (length < 2 || segEnd > b.length) return fail('malformed');
    if (isSof(marker)) {
      if (sawSof || length < 8) return fail('malformed');
      height = u16be(b, segStart + 1);
      width = u16be(b, segStart + 3);
      if (width === 0 || height === 0) return fail('malformed');
      sawSof = true;
    } else if (marker !== 0xda && marker !== 0xdb && marker !== 0xc4 && marker !== 0xdd) {
      // APPn, COM and any other segment can carry arbitrary bytes: scan them (APP11 JUMBF parts once joined, below).
      const part = marker === 0xeb ? jumbfPart(b, segStart, segEnd) : null;
      if (part) jumbf.push(part);
      else regions.push([segStart, segEnd]);
    }
    pos = segEnd;
    if (marker === 0xda) {
      if (!sawSof) return fail('malformed');
      sawSos = true;
      // Entropy-coded data runs until a marker that is not a stuffed 0xFF00, a restart marker or fill.
      for (;;) {
        const next = b.indexOf(0xff, pos);
        if (next < 0 || next + 1 >= b.length) return fail('malformed');
        const code = b[next + 1] ?? 0;
        if (code === 0x00 || (code >= 0xd0 && code <= 0xd7) || code === 0xff) {
          pos = next + (code === 0xff ? 1 : 2);
          continue;
        }
        pos = next;
        break;
      }
    }
  }
  if (!sawSof || !sawSos) return fail('malformed');
  if (end < b.length) return fail('trailing_data');
  const app11 = readApp11(b, jumbf);
  if (!app11) return fail('malformed');
  return { ok: true, width, height, regions: [...regions, ...app11.regions], joined: app11.joined, credentials: app11.credentials };
}

// ── WebP ─────────────────────────────────────────────────────────────────────────────────────────────────────────
function parseWebp(b: Uint8Array): Parsed {
  const riffEnd = 8 + u32le(b, 4);
  if (riffEnd > b.length || riffEnd < 12) return fail('malformed');
  if (riffEnd < b.length) return fail('trailing_data');
  let pos = 12;
  let canvas: { width: number; height: number } | null = null;
  let image: { width: number; height: number } | null = null;
  let first = true;
  let credentials: Credentials | null = null;
  const regions: Region[] = [];
  while (pos < riffEnd) {
    if (pos + 8 > riffEnd) return fail('malformed');
    const id = fourcc(b, pos);
    const size = u32le(b, pos + 4);
    const dataStart = pos + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > riffEnd) return fail('malformed');
    if (id === 'VP8X') {
      if (!first || size < 10) return fail('malformed');
      if (((b[dataStart] ?? 0) & 0x02) !== 0) return fail('animated');
      canvas = { width: u24le(b, dataStart + 4) + 1, height: u24le(b, dataStart + 7) + 1 };
    } else if (id === 'ANIM' || id === 'ANMF') {
      return fail('animated');
    } else if (id === 'VP8 ') {
      if (image || size < 10 || !startsWith(b, [0x9d, 0x01, 0x2a], dataStart + 3)) return fail('malformed');
      image = { width: u16le(b, dataStart + 6) & 0x3fff, height: u16le(b, dataStart + 8) & 0x3fff };
    } else if (id === 'VP8L') {
      if (image || size < 5 || b[dataStart] !== 0x2f) return fail('malformed');
      const bits = u32le(b, dataStart + 1);
      image = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    } else if (id === 'C2PA') {
      // A C2PA manifest store: one per picture, complete and well-formed, or the picture is damaged.
      if (credentials) return fail('malformed');
      credentials = credentialsIn(b.subarray(dataStart, dataEnd));
      if (!credentials) return fail('malformed');
    } else if (id !== 'ALPH') {
      regions.push([dataStart, dataEnd]);
    }
    first = false;
    pos = dataEnd + (size % 2);
  }
  if (!image) return fail('malformed');
  const size = canvas ?? image;
  if (size.width === 0 || size.height === 0) return fail('malformed');
  return { ok: true, width: size.width, height: size.height, regions, joined: [], credentials };
}

const PARSERS: Readonly<Record<ImageFormat, (b: Uint8Array) => Parsed>> = { png: parsePng, jpeg: parseJpeg, webp: parseWebp };

/** Inspects untrusted bytes. Total: never throws, whatever the input. */
export function inspectImage(bytes: Uint8Array, limits: ImageLimits = IMAGE_LIMITS): ImageInspection {
  if (bytes.length === 0) return reject('empty', { limits });
  if (bytes.length > limits.maxBytes) return reject('too_large', { limits });
  const detected = detect(bytes);
  if (detected === 'unknown') return reject('unsupported_type', { limits });
  if (detected === 'gif' || detected === 'svg' || detected === 'html') return reject(detected, { limits });
  const parsed = PARSERS[detected](bytes);
  if (!parsed.ok) return reject(parsed.code, { limits });
  // The first bytes of every container are headers; scan them together with the metadata regions and the C2PA store.
  const regions: Region[] = [[0, Math.min(bytes.length, 64)], ...parsed.regions];
  if (regions.some(([start, end]) => hasMarkup(bytes, start, end) || hasActiveMarkup(bytes, start, end))) return reject('embedded_markup', { limits });
  if (detected === 'jpeg' && hasSplitActiveMarkup(bytes, parsed.regions)) return reject('embedded_markup', { limits });
  if (parsed.joined.some((box) => hasMarkup(box, 0, box.length) || hasActiveMarkup(box, 0, box.length))) return reject('embedded_markup', { limits });
  if (parsed.credentials && storeHasMarkup(parsed.credentials)) return reject('embedded_markup', { limits });
  const { width, height } = parsed;
  if (width < limits.minSide || height < limits.minSide) return reject('dimensions_too_small', { width, height, limits });
  if (width > limits.maxSide || height > limits.maxSide) return reject('dimensions_too_large', { width, height, limits });
  return { ok: true, format: detected, mediaType: MEDIA_TYPE[detected], width, height };
}
