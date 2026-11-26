/** Box-picture eligibility, shared by the page and card service. No DOM, renderer or network dependency. */
import { sha256Hex } from './misfits-commitment';
import { FIT_ICON_SHA256, fitPictureBytes } from './fit-picture';
export { FIT_ICON_SHA256, fitPictureBytes } from './fit-picture';

export const PICTURE_BUDGET = Object.freeze({ bytes: 1_048_576, side: 4096, pixels: 4_194_304, frames: 32 });
/** Usability is independent of a particular renderer's format support. */
export const BOX_PICTURE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'] as const);
export type BoxPictureType = (typeof BOX_PICTURE_TYPES)[number];
export type PictureFormat = BoxPictureType;
export interface PictureInfo { readonly type: PictureFormat; readonly width: number; readonly height: number; readonly frames: number }
export interface BoxPicture { readonly bytes: Uint8Array; readonly type: BoxPictureType }

const u16be = (b: Uint8Array, i: number): number => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u16le = (b: Uint8Array, i: number): number => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, i: number): number => u16le(b, i) | ((b[i + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, i: number): number => (u16be(b, i) * 65536 + u16be(b, i + 2));
const u32le = (b: Uint8Array, i: number): number => (u16le(b, i) + u16le(b, i + 2) * 65536);
const ascii = (b: Uint8Array, i: number, n = 4): string => String.fromCharCode(...b.subarray(i, i + n));
const starts = (b: Uint8Array, prefix: readonly number[]): boolean => prefix.every((v, i) => b[i] === v);

/** Identification only. A matching signature is never permission to decode. */
export function pictureFormat(b: Uint8Array): PictureFormat | null {
  if (starts(b, [137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
  if (starts(b, [255, 216, 255])) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(ascii(b, 0, 6))) return 'image/gif';
  if (ascii(b, 0) === 'RIFF' && ascii(b, 8) === 'WEBP') return 'image/webp';
  // The sole SVG exception is exact, reviewed public art, not an SVG parser for arbitrary uploads.
  if (b.length === fitPictureBytes().length && sha256Hex(b) === FIT_ICON_SHA256) return 'image/svg+xml';
  return null;
}
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (b: Uint8Array, start: number, end: number): number => {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = (crcTable[(c ^ (b[i] ?? 0)) & 255] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
type Size = { width: number; height: number; frames: number };
const sized = (width: number, height: number, frames = 1): Size | null => width > 0 && height > 0 ? { width, height, frames } : null;

/** Length-delimited chunks, CRCs, 'IDAT' and an exact 'IEND'. APNG counts real frame controls and their data. */
function png(b: Uint8Array): Size | null {
  if (b.length < 33 || u32be(b, 8) !== 13 || ascii(b, 12) !== 'IHDR') return null;
  const size = sized(u32be(b, 16), u32be(b, 20));
  if (!size) return null;
  let data = false, dataEnded = false, palette = false, declared = 0, frames = 0, sequence = 0, frameData = false;
  for (let pos = 8; pos + 12 <= b.length;) {
    const length = u32be(b, pos), type = ascii(b, pos + 4), at = pos + 8, end = at + length;
    if (end + 4 > b.length || crc(b, pos + 4, end) !== u32be(b, end)) return null;
    if (type === 'IHDR') {
      if (pos !== 8 || length !== 13 || b[26] !== 0 || b[27] !== 0 || (b[28] ?? 2) > 1) return null;
      const depths: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[b[25] ?? -1]?.includes(b[24] ?? -1)) return null;
    } else if (type === 'PLTE') {
      if (palette || data || length === 0 || length > 768 || length % 3 !== 0) return null;
      palette = true;
    } else if (type === 'IDAT') {
      if (dataEnded || (b[25] === 3 && !palette)) return null;
      data = true;
      if (frames > 0 && length > 0) frameData = true;
    } else {
      if (data) dataEnded = true;
      if (type === 'acTL') {
        if (declared || data || length !== 8 || u32be(b, at) === 0) return null;
        declared = u32be(b, at);
      } else if (type === 'fcTL') {
        if (!declared || length !== 26 || (frames > 0 && !frameData) || u32be(b, at) !== sequence++) return null;
        const w = u32be(b, at + 4), h = u32be(b, at + 8);
        if (!w || !h || w + u32be(b, at + 12) > size.width || h + u32be(b, at + 16) > size.height) return null;
        if ((b[at + 24] ?? 3) > 2 || (b[at + 25] ?? 2) > 1) return null;
        frames++; frameData = false;
      } else if (type === 'fdAT') {
        if (!data || !frames || length <= 4 || u32be(b, at) !== sequence++) return null;
        frameData = true;
      } else if (type === 'IEND') {
        return length === 0 && end + 4 === b.length && data && (!declared || (frames === declared && frameData))
          ? { ...size, frames: declared || 1 } : null;
      } else if ((b[pos + 4] ?? 0) < 97) return null; // Unknown critical chunk.
    }
    pos = end + 4;
  }
  return null;
}

const frameMarker = (m: number): boolean => m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m);
/** Segment lengths outside scans; byte stuffing and restart markers inside scans. EOI must be at the file end. */
function jpeg(b: Uint8Array): Size | null {
  let pos = 2, size: Size | null = null, scan = false, sawScan = false;
  while (pos < b.length) {
    if (scan) {
      if (b[pos++] !== 0xff) continue;
      while (b[pos] === 0xff) pos++;
      const m = b[pos];
      if (m === undefined) return null;
      if (m === 0 || (m >= 0xd0 && m <= 0xd7)) { pos++; continue; }
      pos--; scan = false;
    }
    if (b[pos++] !== 0xff) return null;
    while (b[pos] === 0xff) pos++;
    const marker = b[pos++];
    if (marker === 0xd9) return sawScan && pos === b.length ? size : null;
    if (marker === undefined || marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) return null;
    if (marker === 1) continue;
    const length = u16be(b, pos);
    if (length < 2 || pos + length > b.length) return null;
    if (frameMarker(marker)) {
      if (size || length < 11 || length !== 8 + 3 * (b[pos + 7] ?? 0)) return null;
      size = sized(u16be(b, pos + 5), u16be(b, pos + 3));
      if (!size) return null;
    } else if (marker === 0xda) {
      if (!size || length < 8 || length !== 6 + 2 * (b[pos + 2] ?? 0)) return null;
      scan = true; sawScan = true;
    } else if (marker === 0xdc || marker === 0xde) return null; // Deferred height / hierarchical frames.
    pos += length;
  }
  return null;
}

/** GIF's length-delimited extension and image sub-blocks. Payload 0x3b is never a trailer. */
function gif(b: Uint8Array): Size | null {
  if (b.length < 13) return null;
  const size = sized(u16le(b, 6), u16le(b, 8), 0);
  if (!size) return null;
  let pos = 13 + ((b[10] ?? 0) & 128 ? 3 * 2 ** (((b[10] ?? 0) & 7) + 1) : 0);
  const blocks = (): boolean => {
    while (pos < b.length) {
      const length = b[pos++] ?? 0;
      if (length === 0) return true;
      if (pos + length > b.length) return false;
      pos += length;
    }
    return false;
  };
  while (pos < b.length) {
    const marker = b[pos++];
    if (marker === 0x3b) return pos === b.length && size.frames > 0 ? size : null;
    if (marker === 0x21) {
      if (pos >= b.length) return null;
      pos++;
      if (!blocks()) return null;
    } else if (marker === 0x2c) {
      if (pos + 9 > b.length) return null;
      const w = u16le(b, pos + 4), h = u16le(b, pos + 6), flags = b[pos + 8] ?? 0;
      if (!w || !h || w + u16le(b, pos) > size.width || h + u16le(b, pos + 2) > size.height) return null;
      pos += 9 + (flags & 128 ? 3 * 2 ** ((flags & 7) + 1) : 0);
      const codeSize = b[pos++];
      if (codeSize === undefined || codeSize < 2 || codeSize > 8 || !blocks()) return null;
      size.frames++;
    } else return null;
  }
  return null;
}

/** RIFF chunks including padding, VP8/VP8L dimensions, and ANMF child chunks. No tail-marker search. */
function webp(b: Uint8Array): Size | null {
  if (u32le(b, 4) + 8 !== b.length) return null;
  let canvas: Size | null = null, image: Size | null = null, frames = 0, animated = false, animationControl = false;
  let alpha = false, flags = 0;
  const metadata = new Set<string>();
  const bitstream = (type: string, at: number, length: number): Size | null => {
    if (type === 'VP8 ' && length > 10 && ((b[at] ?? 1) & 1) === 0 && starts(b.subarray(at + 3), [0x9d, 1, 0x2a])) {
      const tag = u24le(b, at), partition = tag >>> 5;
      if (((tag >>> 1) & 7) > 3 || !(tag & 16) || partition === 0 || partition > length - 10) return null;
      return sized(u16le(b, at + 6) & 0x3fff, u16le(b, at + 8) & 0x3fff);
    }
    if (type === 'VP8L' && length > 5 && b[at] === 0x2f && (b[at + 4] ?? 255) >>> 5 === 0) {
      const bits = u32le(b, at + 1);
      return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    return null;
  };
  const alphaChunk = (at: number, length: number): boolean => length > 1 && ((b[at] ?? 255) & 0xc0) === 0
    && ((b[at] ?? 255) & 3) <= 1 && (((b[at] ?? 255) >>> 4) & 3) <= 1;
  const chunkFits = (end: number, length: number, limit: number): boolean => end + (length & 1) <= limit
    && (!(length & 1) || b[end] === 0);
  for (let pos = 12; pos < b.length;) {
    if (pos + 8 > b.length) return null;
    const type = ascii(b, pos), length = u32le(b, pos + 4), at = pos + 8, end = at + length;
    if (!chunkFits(end, length, b.length)) return null;
    if (type === 'VP8X') {
      if (pos !== 12 || length !== 10 || ((b[at] ?? 255) & 0xc1) || u24le(b, at + 1) !== 0) return null;
      flags = b[at] ?? 0;
      canvas = sized(u24le(b, at + 4) + 1, u24le(b, at + 7) + 1);
      animated = ((b[at] ?? 0) & 2) !== 0;
    } else if (type === 'ANIM') {
      if (!animated || animationControl || length !== 6) return null;
      animationControl = true;
    } else if (type === 'ANMF') {
      if (!canvas || !animated || !animationControl || length < 24 || ((b[at + 15] ?? 255) & 0xfc)) return null;
      const w = u24le(b, at + 6) + 1, h = u24le(b, at + 9) + 1;
      if (2 * u24le(b, at) + w > canvas.width || 2 * u24le(b, at + 3) + h > canvas.height) return null;
      let frame: Size | null = null, frameAlpha = false;
      for (let child = at + 16; child < end;) {
        if (child + 8 > end) return null;
        const tag = ascii(b, child), len = u32le(b, child + 4), stop = child + 8 + len + (len & 1);
        if (!chunkFits(child + 8 + len, len, end)) return null;
        if (tag === 'VP8 ' || tag === 'VP8L') {
          if (frame || (tag === 'VP8L' && frameAlpha)) return null;
          frame = bitstream(tag, child + 8, len);
          if (!frame || frame.width !== w || frame.height !== h) return null;
        } else if (tag === 'ALPH') {
          if (frameAlpha || frame || !(flags & 16) || !alphaChunk(child + 8, len)) return null;
          frameAlpha = true;
        } else return null;
        child = stop;
      }
      if (!frame) return null;
      frames++;
    } else if (type === 'VP8 ' || type === 'VP8L') {
      if (image || animated || (type === 'VP8L' && alpha)) return null;
      image = bitstream(type, at, length);
      if (!image) return null;
    } else if (type === 'ALPH') {
      if (!canvas || animated || alpha || image || !(flags & 16) || !alphaChunk(at, length)) return null;
      alpha = true;
    } else if (['ICCP', 'EXIF', 'XMP '].includes(type)) {
      const flag = type === 'ICCP' ? 32 : type === 'EXIF' ? 8 : 4;
      if (!canvas || !(flags & flag) || metadata.has(type) || length === 0 || (type === 'ICCP' && (image || frames))) return null;
      metadata.add(type);
    }
    pos = end + (length & 1);
  }
  if (([['ICCP', 32], ['EXIF', 8], ['XMP ', 4]] as const).some(([tag, flag]) => (flags & flag) && !metadata.has(tag))) return null;
  if (animated) return canvas && frames ? { ...canvas, frames } : null;
  if (!image || (canvas && (canvas.width !== image.width || canvas.height !== image.height))) return null;
  return image;
}

/** Structural walk only: callers cannot use this result to bypass the common rendering policy or budget. */
export function pictureStructure(bytes: Uint8Array): PictureInfo | null {
  if (bytes.length === 0 || bytes.length > PICTURE_BUDGET.bytes) return null;
  const type = pictureFormat(bytes);
  const size = type === 'image/png' ? png(bytes) : type === 'image/jpeg' ? jpeg(bytes) : type === 'image/gif' ? gif(bytes)
    : type === 'image/webp' ? webp(bytes) : type === 'image/svg+xml' ? sized(256, 256) : null;
  return type && size ? { type, ...size } : null;
}

/**
 * Every presentation path calls this before allocating a URL or starting a decoder, after verifying the commitment.
 * Integrator decision (af5): "complete" means structurally complete as this judge checks it. A JPEG with a scan
 * header and EOI but no scan data, or a PNG whose compressed rows stop early, can pass. Those are the creator's
 * committed bytes; each side shows them as its decoder renders them. No additional decoder checks pixel completeness.
 */
export function inspectBoxPicture(bytes: Uint8Array): PictureInfo & { type: BoxPictureType } | null {
  const info = pictureStructure(bytes);
  if (!info || !BOX_PICTURE_TYPES.some((type) => type === info.type) || info.width > PICTURE_BUDGET.side || info.height > PICTURE_BUDGET.side
    || info.width * info.height > PICTURE_BUDGET.pixels || info.frames > PICTURE_BUDGET.frames) return null;
  return info as PictureInfo & { type: BoxPictureType };
}

/** Hash and structure are enforced together at both byte-loader entry points. */
export function verifiedBoxPicture(bytes: Uint8Array, sha256: string): BoxPicture | null {
  if (bytes.length > PICTURE_BUDGET.bytes || sha256Hex(bytes).toLowerCase() !== sha256.toLowerCase()) return null;
  const info = inspectBoxPicture(bytes);
  return info ? { bytes, type: info.type } : null;
}
