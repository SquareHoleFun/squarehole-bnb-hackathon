/**
 * Byte-level image fixtures generated inside the tests (no binary files in the repo): well-formed PNG, JPEG, WebP and
 * GIF skeletons plus the hostile samples ART-01 names (SVG with script, HTML renamed .png, polyglots, trailing data).
 * The sniffer reads structure only, so image payloads are small placeholders unless a test needs a decodable PNG.
 */
import { deflateSync } from 'node:zlib';

const ascii = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

export function concat(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const u32be = (value: number): Uint8Array => new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
const u32le = (value: number): Uint8Array => new Uint8Array([value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]);
const u16be = (value: number): Uint8Array => new Uint8Array([(value >>> 8) & 255, value & 255]);
const u24le = (value: number): Uint8Array => new Uint8Array([value & 255, (value >>> 8) & 255, (value >>> 16) & 255]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 255] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function pngChunk(type: string, data: Uint8Array, options: { badCrc?: boolean } = {}): Uint8Array<ArrayBuffer> {
  const typed = concat(ascii(type), data);
  const crc = crc32(typed) ^ (options.badCrc ? 1 : 0);
  return concat(u32be(data.length), typed, u32be(crc >>> 0));
}

export interface PngOptions {
  width: number;
  height: number;
  /** Real zlib image data (decodable) instead of a tiny placeholder. Keep dimensions small when set. */
  decodable?: boolean;
  before?: readonly Uint8Array[];
  after?: readonly Uint8Array[];
  trailing?: Uint8Array;
  omitIend?: boolean;
  badCrc?: boolean;
}

export function makePng({ width, height, decodable, before = [], after = [], trailing, omitIend, badCrc }: PngOptions): Uint8Array<ArrayBuffer> {
  const ihdr = concat(u32be(width), u32be(height), new Uint8Array([8, 2, 0, 0, 0]));
  let idat: Uint8Array;
  if (decodable) {
    const row = new Uint8Array(1 + width * 3);
    for (let x = 0; x < width; x += 1) row.set([(x * 7) & 255, 120, 200], 1 + x * 3);
    const raw = new Uint8Array(row.length * height);
    for (let y = 0; y < height; y += 1) raw.set(row, y * row.length);
    idat = new Uint8Array(deflateSync(raw));
  } else {
    idat = new Uint8Array(deflateSync(new Uint8Array(16)));
  }
  return concat(
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    ...before,
    pngChunk('IDAT', idat, { badCrc }),
    ...after,
    omitIend ? new Uint8Array() : pngChunk('IEND', new Uint8Array()),
    trailing ?? new Uint8Array(),
  );
}

export const pngText = (keyword: string, text: string): Uint8Array<ArrayBuffer> => pngChunk('tEXt', concat(ascii(keyword), new Uint8Array([0]), ascii(text)));

/** An XMP packet the way image editors write it (iTXt, uncompressed). Must NOT be mistaken for markup. */
export const pngXmp = (): Uint8Array<ArrayBuffer> =>
  pngChunk(
    'iTXt',
    concat(
      ascii('XML:com.adobe.xmp'),
      new Uint8Array([0, 0, 0, 0, 0]),
      ascii('<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF></rdf:RDF></x:xmpmeta><?xpacket end="w"?>'),
    ),
  );

const segment = (marker: number, payload: Uint8Array): Uint8Array => concat(new Uint8Array([0xff, marker]), u16be(payload.length + 2), payload);
export const jpegSegment = segment;

export interface JpegOptions {
  width: number;
  height: number;
  comment?: string;
  /** Whole segments (marker included) placed after APP0, e.g. APP11 JUMBF parts. */
  segments?: readonly Uint8Array[];
  trailing?: Uint8Array;
  progressive?: boolean;
  omitEoi?: boolean;
}

export function makeJpeg({ width, height, comment, segments = [], trailing, progressive, omitEoi }: JpegOptions): Uint8Array<ArrayBuffer> {
  const app0 = segment(0xe0, concat(ascii('JFIF'), new Uint8Array([0, 1, 1, 0, 0, 1, 0, 1, 0, 0])));
  const dqt = segment(0xdb, new Uint8Array(65));
  const sof = segment(progressive ? 0xc2 : 0xc0, concat(new Uint8Array([8]), u16be(height), u16be(width), new Uint8Array([1, 1, 0x11, 0])));
  const dht = segment(0xc4, new Uint8Array(29));
  const sos = segment(0xda, new Uint8Array([1, 1, 0, 0, 63, 0]));
  // Entropy-coded data with a stuffed 0xFF00 and a restart marker, as a real scan would contain.
  const scan = new Uint8Array([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0x9a]);
  const scans = progressive ? concat(sos, scan, dht, sos, scan) : concat(sos, scan);
  return concat(
    new Uint8Array([0xff, 0xd8]),
    app0,
    ...segments,
    comment === undefined ? new Uint8Array() : segment(0xfe, ascii(comment)),
    dqt,
    sof,
    dht,
    scans,
    omitEoi ? new Uint8Array() : new Uint8Array([0xff, 0xd9]),
    trailing ?? new Uint8Array(),
  );
}

const riffChunk = (fourcc: string, payload: Uint8Array): Uint8Array =>
  concat(ascii(fourcc), u32le(payload.length), payload, payload.length % 2 === 1 ? new Uint8Array([0]) : new Uint8Array());

export interface WebpOptions {
  width: number;
  height: number;
  kind?: 'VP8L' | 'VP8' | 'VP8X';
  animated?: boolean;
  extra?: readonly Uint8Array[];
  trailing?: Uint8Array;
}

export const webpChunk = riffChunk;

export function makeWebp({ width, height, kind = 'VP8L', animated, extra = [], trailing }: WebpOptions): Uint8Array<ArrayBuffer> {
  const vp8l = () => {
    const bits = (width - 1) | ((height - 1) << 14);
    return riffChunk('VP8L', concat(new Uint8Array([0x2f]), u32le(bits >>> 0), new Uint8Array(8)));
  };
  const vp8 = () =>
    riffChunk(
      'VP8 ',
      concat(new Uint8Array([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a]), new Uint8Array([width & 255, (width >>> 8) & 0x3f]), new Uint8Array([height & 255, (height >>> 8) & 0x3f]), new Uint8Array(10)),
    );
  let chunks: Uint8Array;
  if (kind === 'VP8X') {
    const flags = animated ? 0x02 : 0x00;
    const header = riffChunk('VP8X', concat(new Uint8Array([flags, 0, 0, 0]), u24le(width - 1), u24le(height - 1)));
    const body = animated ? concat(riffChunk('ANIM', new Uint8Array(6)), riffChunk('ANMF', new Uint8Array(24))) : vp8l();
    chunks = concat(header, ...extra, body);
  } else {
    chunks = concat(kind === 'VP8' ? vp8() : vp8l(), ...extra);
  }
  const body = concat(ascii('WEBP'), chunks);
  return concat(ascii('RIFF'), u32le(body.length), body, trailing ?? new Uint8Array());
}

export const GIF_WITH_SCRIPT = concat(
  ascii('GIF89a'),
  new Uint8Array([0x00, 0x01, 0x00, 0x01, 0x80, 0x00, 0x00]),
  new Uint8Array([0, 0, 0, 255, 255, 255]),
  new Uint8Array([0x21, 0xfe, 0x1d]),
  ascii('*/=1;alert(document.domain)//'),
  new Uint8Array([0x00, 0x3b]),
);

export const SVG_WITH_SCRIPT = ascii('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><script>alert(1)</script></svg>');
export const SVG_WITH_PROLOG = concat(new Uint8Array([0xef, 0xbb, 0xbf]), ascii('\n  <?xml version="1.0"?>\n<!DOCTYPE svg><svg onload="alert(1)"></svg>'));
export const HTML_AS_PNG = ascii('<!DOCTYPE html><html><body><script>fetch("/steal")</script></body></html>');

export { ascii };
