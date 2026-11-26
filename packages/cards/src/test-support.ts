/**
 * Tests only (never imported by the service or the Pages function): pictures whose files are small and whose decoded
 * size is not, built here so that no such file is committed (share-art.ts `logoFits`).
 */
import { crc32, deflateSync } from 'node:zlib';

const ascii = (text: string): number[] => Array.from(text, (ch) => ch.charCodeAt(0));
const u16be = (n: number): number[] => [(n >>> 8) & 255, n & 255];
const u16le = (n: number): number[] => [n & 255, (n >>> 8) & 255];
const u32be = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngChunk(type: string, data: Uint8Array | readonly number[]): number[] {
  const typed = Uint8Array.from([...ascii(type), ...data]);
  return [...u32be(data.length), ...typed, ...u32be(crc32(typed))];
}

/** A real PNG of that size, every pixel black (1-bit grey): 8,000 x 8,000 px is under 8 KB. */
export function blankPng(width: number, height: number, extra: readonly number[] = []): Uint8Array<ArrayBuffer> {
  const header = Uint8Array.from([...u32be(width), ...u32be(height), 1, 0, 0, 0, 0]);
  const rows = new Uint8Array((1 + Math.ceil(width / 8)) * height);
  const data = deflateSync(rows, { level: 9 });
  return Uint8Array.from([...PNG_SIGNATURE, ...pngChunk('IHDR', header), ...extra, ...pngChunk('IDAT', data), ...pngChunk('IEND', [])]);
}

/** A real RGBA PNG with distinct corner marks reaching all four edges, and optional transparent ground. */
export function edgePng(width: number, height: number, transparent = false): Uint8Array<ArrayBuffer> {
  const rows = new Uint8Array((1 + width * 4) * height);
  const corners = [[240, 20, 20, 255], [20, 220, 20, 255], [20, 20, 240, 255], [240, 220, 20, 255]] as const;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const corner = (x < width * 0.08 || x >= width * 0.92) && (y < height * 0.08 || y >= height * 0.92);
      const colour = corner ? (corners[(x >= width / 2 ? 1 : 0) + (y >= height / 2 ? 2 : 0)] ?? corners[0])
        : x > width * 0.3 && x < width * 0.4 ? [0, 0, 0, 255]
        : x > width * 0.6 && x < width * 0.7 ? [255, 255, 255, 255]
        : [128, 128, 128, transparent ? 0 : 255];
      rows.set(colour, y * (1 + width * 4) + 1 + x * 4);
    }
  }
  return Uint8Array.from([...PNG_SIGNATURE, ...pngChunk('IHDR', [...u32be(width), ...u32be(height), 8, 6, 0, 0, 0]),
    ...pngChunk('IDAT', deflateSync(rows)), ...pngChunk('IEND', [])]);
}

/** An APNG frame control chunk for a frame of that size (to put before the image data). */
export const pngFrame = (width: number, height: number): number[] => pngChunk('fcTL', [...u32be(0), ...u32be(width), ...u32be(height), ...u32be(0), ...u32be(0), 0, 1, 0, 1, 0, 0]);

/** A PNG whose first chunk is not its header. */
export const headlessPng = (): Uint8Array<ArrayBuffer> => Uint8Array.from([...PNG_SIGNATURE, ...pngChunk('tEXt', ascii('a\u0000b'))]);

const segment = (marker: number, body: readonly number[]): number[] => [0xff, marker, ...u16be(body.length + 2), ...body];

/** A JPEG's parts: its markers in order, the scan's data a stand-in (nothing decodes it here). */
export const JPEG = {
  start: [0xff, 0xd8],
  jfif: segment(0xe0, [...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
  /** The frame header (baseline by default; 0xc2 progressive): the size the picture decodes to. */
  frame: (width: number, height: number, marker = 0xc0): number[] => segment(marker, [8, ...u16be(height), ...u16be(width), 1, 1, 0x11, 0]),
  /** An Exif block whose bytes hold another frame header (a thumbnail's): not the picture's. */
  exif: (width: number, height: number): number[] => segment(0xe1, [...ascii('Exif'), 0, 0, 0xff, 0xc0, 0, 11, 8, ...u16be(height), ...u16be(width), 1, 1, 0x11, 0]),
  /** A scan: its header, then data with a stuffed 0xFF and a restart marker. */
  scan: [...segment(0xda, [1, 1, 0, 0, 0x3f, 0]), 0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56],
  end: [0xff, 0xd9],
};
export const jpegOf = (...parts: readonly (readonly number[])[]): Uint8Array<ArrayBuffer> => Uint8Array.from(parts.flat());
export const plainJpeg = (width: number, height: number): Uint8Array<ArrayBuffer> => jpegOf(JPEG.start, JPEG.jfif, JPEG.frame(width, height), JPEG.scan, JPEG.end);

export interface GifFrame {
  readonly width: number;
  readonly height: number;
  /** A colour table of its own (skipped to find what follows). */
  readonly local?: boolean;
}

/** A GIF: its screen and global colour table, a graphic control block, one image per frame (each a stand-in LZW run). */
export function gifOf(screen: readonly [number, number], frames: readonly GifFrame[]): Uint8Array<ArrayBuffer> {
  const head = [...ascii('GIF89a'), ...u16le(screen[0]), ...u16le(screen[1]), 0x80, 0, 0, 0, 0, 0, 255, 255, 255];
  const control = [0x21, 0xf9, 4, 0, 0, 0, 0, 0];
  const images = frames.flatMap(({ width, height, local }) => [0x2c, 0, 0, 0, 0, ...u16le(width), ...u16le(height), local ? 0x80 : 0, ...(local ? [0, 0, 0, 255, 255, 255] : []), 2, 2, 0x44, 0x01, 0]);
  return Uint8Array.from([...head, ...control, ...images, 0x3b]);
}
