/** Internal PNGs only. Public picture admission keeps its 1 MiB cap. */
import { PICTURE_BUDGET, type BoxPicture, type PictureInfo } from '@squarehole/artwork/box-picture';

export const MAX_CONVERTED_BYTES = PICTURE_BUDGET.pixels * 4 + 1_048_576;
type Size = Pick<PictureInfo, 'width' | 'height'>;
const converted = new WeakMap<BoxPicture, Size>();
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Uint8Array, start: number, end: number): number => {
  let c = 0xffffffff;
  for (let at = start; at < end; at++) c = (crcTable[(c ^ (b[at] ?? 0)) & 255] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** Sharp emits one 8-bit RGBA PNG. Check all chunks, CRCs, bounds and the exact end before resvg sees it. */
function fits(bytes: Uint8Array, size: Size): boolean {
  if (bytes.length < 57 || bytes.length > MAX_CONVERTED_BYTES || size.width < 1 || size.height < 1
    || size.width > PICTURE_BUDGET.side || size.height > PICTURE_BUDGET.side || size.width * size.height > PICTURE_BUDGET.pixels) return false;
  const b = bytes, view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => b[i] === v)) return false;
  let data = false, physical = false;
  for (let at = 8; at + 12 <= b.length;) {
    const length = view.getUint32(at), end = at + 8 + length, type = String.fromCharCode(...b.subarray(at + 4, at + 8));
    if (end + 4 > b.length || crc32(b, at + 4, end) !== view.getUint32(end)) return false;
    if (at === 8) {
      if (type !== 'IHDR' || length !== 13 || view.getUint32(16) !== size.width || view.getUint32(20) !== size.height
        || ![8, 6, 0, 0, 0].every((v, i) => b[24 + i] === v)) return false;
    } else if (type === 'pHYs') {
      if (data || physical || length !== 9 || (b[at + 16] ?? 2) > 1) return false;
      physical = true;
    } else if (type === 'IDAT') {
      if (!length) return false;
      data = true;
    } else if (type === 'IEND') return data && length === 0 && end + 4 === b.length;
    else return false; // No animation, second image, metadata or unknown chunks.
    at = end + 4;
  }
  return false;
}

export function convertedPng(bytes: Uint8Array, size: Size): BoxPicture | null {
  if (!fits(bytes, size)) return null;
  const picture: BoxPicture = { bytes, type: 'image/png' };
  converted.set(picture, size);
  return picture;
}

/** Check again at the rendering boundary, including any changed bytes. This never admits public oversized PNGs. */
export function convertedPictureFits(picture: BoxPicture): boolean {
  const size = converted.get(picture);
  return picture.type === 'image/png' && size !== undefined && fits(picture.bytes, size);
}
