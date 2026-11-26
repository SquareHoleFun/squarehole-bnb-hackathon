import { describe, expect, it } from 'vitest';
import { sha256Hex } from './misfits-commitment';
import { fitPictureBytes, inspectBoxPicture, pictureStructure, PICTURE_BUDGET, verifiedBoxPicture } from './box-picture';
import { PICTURE_CASES, pictureFixture, pngFixture, jpegWithoutScanData } from './picture-fixtures';

describe('one box-picture judge', () => {
  it.each(PICTURE_CASES)('$name: complete=$complete, accepted=$accepted', ({ bytes, complete, accepted }) => {
    expect(pictureStructure(bytes) !== null).toBe(complete);
    expect(inspectBoxPicture(bytes) !== null).toBe(accepted);
    expect(verifiedBoxPicture(bytes, sha256Hex(bytes)) !== null).toBe(accepted);
    expect(verifiedBoxPicture(bytes, `0x${'12'.repeat(32)}`)).toBeNull();
  });
  it('no padding after a format end and no byte over the shared limit', () => {
    for (const ext of ['png', 'jpg', 'gif', 'webp']) {
      expect(pictureStructure(new Uint8Array([...pictureFixture(`ordinary.${ext}`), 0]))).toBeNull();
    }
    expect(inspectBoxPicture(new Uint8Array(PICTURE_BUDGET.bytes + 1))).toBeNull();
  });
  it('the 282-byte JPEG with a scan header, no scan data and EOI is accepted on purpose', () => {
    const bytes = jpegWithoutScanData();
    expect(pictureFixture('ordinary.jpg')).toHaveLength(286);
    expect(bytes).toHaveLength(282);
    expect(bytes.slice(-2)).toEqual(new Uint8Array([0xff, 0xd9]));
    expect(inspectBoxPicture(bytes)).toEqual({ type: 'image/jpeg', width: 3, height: 2, frames: 1 });
    expect(verifiedBoxPicture(bytes, sha256Hex(bytes))).toEqual({ bytes, type: 'image/jpeg' });
  });
  it('a complete ordinary 16 by 12 CMYK JPEG is usable', () => {
    const bytes = pictureFixture('ordinary-cmyk.jpg');
    expect(inspectBoxPicture(bytes)).toEqual({ type: 'image/jpeg', width: 16, height: 12, frames: 1 });
    expect(verifiedBoxPicture(bytes, sha256Hex(bytes))).not.toBeNull();
  });
  it('real seeded PNGs keep distinct commitments and the requested original-file size', () => {
    const hashes = [1, 2, 3, 8, 9].map((seed) => {
      const bytes = pngFixture(seed);
      expect(inspectBoxPicture(bytes)).toMatchObject({ type: 'image/png', width: 3, height: 2 });
      return sha256Hex(bytes);
    });
    expect(new Set(hashes).size).toBe(5);
    expect(pngFixture(3, 5000)).toHaveLength(5000);
    expect(inspectBoxPicture(pngFixture(3, 5000))).not.toBeNull();
  });
  it.each([2, 32, 33])('WebP counts every frame, including mixed VP8/VP8L frames: %i', (frames) => {
    expect(pictureStructure(pictureFixture(`frames-${frames}.webp`))).toEqual({ type: 'image/webp', width: 3, height: 2, frames });
  });
  it('FIT is the exact reviewed drawing; a one-byte change loses the SVG exception', () => {
    const bytes = fitPictureBytes(); bytes[40] = (bytes[40] ?? 0) ^ 1;
    expect(inspectBoxPicture(bytes)).toBeNull();
  });
});
