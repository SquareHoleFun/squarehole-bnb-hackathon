import { readFileSync } from 'node:fs';

// Reuse the committed seeded-noise tile image; construct the review's EXIF variant in memory.
// No generated binary is committed or written into the container.
const input = readFileSync(new URL('./wide-png.webp', import.meta.url));
function chunk(type: string, payload: Buffer) {
  const out = Buffer.alloc(8 + payload.length + (payload.length & 1));
  out.write(type); out.writeUInt32LE(payload.length, 4); payload.copy(out, 8); return out;
}
export function memoryWebp(density: number) {
  const exif = Buffer.alloc(72);
  exif.write('Exif\0\0'); exif.write('II', 6); exif.writeUInt16LE(42, 8); exif.writeUInt32LE(8, 10);
  exif.writeUInt16LE(3, 14);
  for (const [i, tag, type, value] of [[0, 282, 5, 50], [1, 283, 5, 58], [2, 296, 3, 2]] as const) {
    const at = 16 + 12 * i; exif.writeUInt16LE(tag, at); exif.writeUInt16LE(type, at + 2);
    exif.writeUInt32LE(1, at + 4); exif.writeUInt32LE(value, at + 8);
  }
  exif.writeUInt32LE(density, 56); exif.writeUInt32LE(1, 60);
  exif.writeUInt32LE(density, 64); exif.writeUInt32LE(1, 68);
  const vp8x = Buffer.alloc(10); vp8x[0] = 8; vp8x.writeUIntLE(2047, 4, 3); vp8x.writeUIntLE(2047, 7, 3);
  const body = Buffer.concat([Buffer.from('WEBP'), chunk('VP8X', vp8x), input.subarray(12), chunk('EXIF', exif)]);
  const riff = Buffer.alloc(8); riff.write('RIFF'); riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}
