/**
 * Safe image pipeline (SH-010; ART-01): size check before reading, byte sniffing, decode, dimension cross-check,
 * re-encode to PNG (metadata stripped), re-check the output, keccak-256 of the published bytes. The original bytes
 * never leave the pipeline.
 */
import { describe, expect, it, vi } from 'vitest';
import { IMAGE_LIMITS, keccak256Hex, processImage, type DecodedImage, type ImageCodec, type ImageSource } from './index';
import { HTML_AS_PNG, makeJpeg, makePng, pngText } from './test-support/images';

function source(name: string, bytes: Uint8Array, size = bytes.length): ImageSource & { read: ReturnType<typeof vi.fn> } {
  const read = vi.fn(async () => bytes);
  return { name, size, bytes: read, read };
}

/** Decodes to the given size and "re-encodes" to a fresh PNG of that size (what a canvas would return). */
function fakeCodec(options: { decoded?: { width: number; height: number }; output?: (image: DecodedImage) => Uint8Array; decodeError?: Error } = {}) {
  const closed: DecodedImage[] = [];
  const codec: ImageCodec = {
    async decode(bytes, mediaType) {
      if (options.decodeError) throw options.decodeError;
      const header = mediaType === 'image/png' ? { width: 600, height: 400 } : { width: 1024, height: 768 };
      const size = options.decoded ?? header;
      void bytes;
      const image: DecodedImage = { width: size.width, height: size.height, close: () => closed.push(image) };
      return image;
    },
    async encodePng(image) {
      return options.output ? options.output(image) : makePng({ width: image.width, height: image.height });
    },
  };
  return { codec, closed };
}

describe('processImage', () => {
  it('re-encodes an accepted image to PNG and hashes the new bytes', async () => {
    const original = makePng({ width: 600, height: 400, before: [pngText('Author', 'someone')] });
    const { codec, closed } = fakeCodec();
    const result = await processImage(source('1.png', original), codec);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reencoded = makePng({ width: 600, height: 400 });
    expect(result.image).toEqual({
      fileName: '1.png',
      sourceFormat: 'png',
      sourceBytes: original.length,
      mediaType: 'image/png',
      width: 600,
      height: 400,
      bytes: reencoded,
      keccak256: keccak256Hex(reencoded),
    });
    expect(result.image.bytes).not.toBe(original);
    expect(closed).toHaveLength(1);
  });

  it('accepts an EXIF-rotated JPEG whose decoded size is the header size turned 90°', async () => {
    const { codec } = fakeCodec({ decoded: { width: 768, height: 1024 } });
    const result = await processImage(source('2.jpg', makeJpeg({ width: 1024, height: 768 })), codec);
    expect(result.ok && [result.image.width, result.image.height, result.image.sourceFormat]).toEqual([768, 1024, 'jpeg']);
  });

  it('checks the size before reading any bytes', async () => {
    const file = source('big.png', makePng({ width: 512, height: 512 }), IMAGE_LIMITS.maxBytes + 1);
    const result = await processImage(file, fakeCodec().codec);
    expect(result).toMatchObject({ ok: false, code: 'too_large', fileName: 'big.png' });
    expect(file.read).not.toHaveBeenCalled();
  });

  it('never decodes rejected bytes', async () => {
    const { codec } = fakeCodec();
    const decode = vi.spyOn(codec, 'decode');
    const result = await processImage(source('cute.png', HTML_AS_PNG), codec);
    expect(result).toMatchObject({ ok: false, code: 'html' });
    expect(decode).not.toHaveBeenCalled();
  });

  it('reports a decoder failure', async () => {
    const result = await processImage(source('1.png', makePng({ width: 600, height: 400 })), fakeCodec({ decodeError: new Error('boom') }).codec);
    expect(result).toMatchObject({ ok: false, code: 'decode_failed' });
  });

  it('rejects a decoded size that disagrees with the header', async () => {
    const { codec, closed } = fakeCodec({ decoded: { width: 601, height: 400 } });
    const result = await processImage(source('1.png', makePng({ width: 600, height: 400 })), codec);
    expect(result).toMatchObject({ ok: false, code: 'decode_mismatch' });
    expect(closed).toHaveLength(1);
  });

  it('rejects an encoder output that is not a clean PNG of the same size', async () => {
    for (const output of [() => makeJpeg({ width: 600, height: 400 }), () => makePng({ width: 300, height: 400 }), () => makePng({ width: 600, height: 400, trailing: new Uint8Array([1]) })]) {
      const result = await processImage(source('1.png', makePng({ width: 600, height: 400 })), fakeCodec({ output }).codec);
      expect(result).toMatchObject({ ok: false, code: 'reencode_failed' });
    }
  });

  it('reports an unreadable file', async () => {
    const file: ImageSource = { name: '1.png', size: 10, bytes: () => Promise.reject(new Error('NotReadableError')) };
    expect(await processImage(file, fakeCodec().codec)).toMatchObject({ ok: false, code: 'unreadable' });
  });
});
