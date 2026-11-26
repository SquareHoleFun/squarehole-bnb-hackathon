/** Real tiny files shared by the two entry-point tests. Node test support only. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { fitPictureBytes } from './box-picture';

export const pictureFixture = (file: string): Uint8Array<ArrayBuffer> => new Uint8Array(readFileSync(fileURLToPath(new URL(`./picture-fixtures/${file}`, import.meta.url)).replace(/^\/@fs\//, '/')));
/** Complete PNG variants with distinct commitments; optional padding is an in-container text chunk. */
export function pngFixture(seed: number, size = 0): Uint8Array<ArrayBuffer> {
  const original = pictureFixture('ordinary.png');
  const text = Buffer.from(`Fixture\0${seed}`);
  const chunk = Buffer.alloc(Math.max(text.length + 12, size - original.length), 32);
  chunk.writeUInt32BE(chunk.length - 12, 0);
  chunk.write('tEXt', 4);
  text.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return new Uint8Array([...original.subarray(0, -12), ...chunk, ...original.subarray(-12)]);
}

/** R3's 282-byte JPEG: keep every segment through SOS, remove scan data, append EOI. */
export function jpegWithoutScanData(): Uint8Array<ArrayBuffer> {
  const original = pictureFixture('ordinary.jpg');
  for (let pos = 2; pos + 4 <= original.length;) {
    const length = ((original[pos + 2] ?? 0) << 8) | (original[pos + 3] ?? 0);
    const end = pos + 2 + length;
    if (original[pos] !== 0xff || length < 2 || end > original.length) break;
    if (original[pos + 1] === 0xda) return new Uint8Array([...original.subarray(0, end), 0xff, 0xd9]);
    pos = end;
  }
  throw new Error('ordinary JPEG fixture has no scan header');
}

const webpCase = (name: string, complete: boolean, accepted = complete) => ({ name: `${name}.webp`, bytes: pictureFixture(`${name}.webp`), complete, accepted });
const FIXTURES = [
  ...['png', 'jpg', 'gif'].map((ext) => ({ name: `ordinary.${ext}`, bytes: pictureFixture(`ordinary.${ext}`), accepted: true, complete: true })),
  { name: 'ordinary-cmyk.jpg', bytes: pictureFixture('ordinary-cmyk.jpg'), accepted: true, complete: true },
  { name: 'no-scan-data.jpg', bytes: jpegWithoutScanData(), accepted: true, complete: true },
  ...['ordinary', 'lossless', 'extended-alpha', 'extended-lossless', 'at-pixel-budget'].map((name) => webpCase(name, true)),
  ...['huge-vp8', 'huge-vp8l', 'huge-vp8x', 'pixel-budget'].map((name) => webpCase(name, true, false)),
  ...['declared-long', 'declared-short', 'false-frame-tail', 'frame-mismatch', 'frame-outside', 'missing-anim', 'missing-frame', 'duplicate-image', 'canvas-mismatch', 'reserved-vp8x', 'reserved-frame', 'bad-padding', 'empty-vp8l', 'missing-alpha', 'missing-metadata'].map((name) => webpCase(name, false)),
  ...['png', 'jpg', 'gif', 'webp'].map((ext) => ({ name: `false-tail.${ext}`, bytes: pictureFixture(`false-tail.${ext}`), accepted: false, complete: false })),
  { name: 'huge.png', bytes: pictureFixture('huge.png'), accepted: false, complete: true },
  ...['png', 'gif', 'webp'].flatMap((ext) => [2, 32, 33].map((frames) => ({ name: `frames-${frames}.${ext}`, bytes: pictureFixture(`frames-${frames}.${ext}`), accepted: frames <= 32, complete: true }))),
  ...['png', 'gif'].map((ext) => ({ name: `transparent.${ext}`, bytes: pictureFixture(`transparent.${ext}`), accepted: true, complete: true })),
  { name: 'bundled FIT', bytes: fitPictureBytes(), accepted: true, complete: true },
  { name: 'arbitrary SVG', bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>'), accepted: false, complete: false },
] as const;

/** Expected installed-renderer outcomes for tests, never a production format policy. Complete means structural. */
export const PICTURE_CASES = FIXTURES.map((fixture) => ({ ...fixture,
  outcome: !fixture.accepted ? 'missing' as const : fixture.name === 'ordinary-cmyk.jpg'
    ? 'page-picture-card-brand' as const : 'same-picture' as const,
}));
