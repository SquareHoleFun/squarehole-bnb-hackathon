/**
 * ART-01: file type comes from the bytes (magic numbers and structure), never from the name or the browser's MIME
 * guess. Only still PNG, JPEG and WebP of 256–4096 px and ≤ 10 MB pass; markup, GIF, polyglots and trailing data fail
 * with a specific, human-readable reason.
 */
import { describe, expect, it } from 'vitest';
import { IMAGE_LIMITS, inspectImage, type ImageRejectionCode } from './index';
import {
  GIF_WITH_SCRIPT,
  HTML_AS_PNG,
  SVG_WITH_PROLOG,
  SVG_WITH_SCRIPT,
  ascii,
  concat,
  makeJpeg,
  makePng,
  makeWebp,
  pngChunk,
  pngText,
  pngXmp,
  webpChunk,
} from './test-support/images';

const rejected = (bytes: Uint8Array): ImageRejectionCode | 'accepted' => {
  const result = inspectImage(bytes);
  return result.ok ? 'accepted' : result.code;
};

describe('inspectImage: accepted formats', () => {
  it.each([
    ['PNG', makePng({ width: 512, height: 300 }), 'png', 'image/png', 512, 300],
    ['PNG at the minimum size', makePng({ width: 256, height: 256 }), 'png', 'image/png', 256, 256],
    ['PNG at the maximum size', makePng({ width: 4096, height: 4096 }), 'png', 'image/png', 4096, 4096],
    ['PNG with an XMP packet', makePng({ width: 600, height: 600, before: [pngXmp()] }), 'png', 'image/png', 600, 600],
    ['baseline JPEG', makeJpeg({ width: 1024, height: 768 }), 'jpeg', 'image/jpeg', 1024, 768],
    ['progressive JPEG', makeJpeg({ width: 800, height: 1200, progressive: true }), 'jpeg', 'image/jpeg', 800, 1200],
    ['JPEG with a harmless comment', makeJpeg({ width: 300, height: 300, comment: 'Made with love <3' }), 'jpeg', 'image/jpeg', 300, 300],
    ['lossless WebP', makeWebp({ width: 640, height: 480 }), 'webp', 'image/webp', 640, 480],
    ['lossy WebP', makeWebp({ width: 1000, height: 257, kind: 'VP8' }), 'webp', 'image/webp', 1000, 257],
    ['extended WebP', makeWebp({ width: 4096, height: 2048, kind: 'VP8X' }), 'webp', 'image/webp', 4096, 2048],
  ] as const)('%s', (_name, bytes, format, mediaType, width, height) => {
    expect(inspectImage(bytes)).toEqual({ ok: true, format, mediaType, width, height });
  });
});

describe('inspectImage: rejected input (ART-01)', () => {
  it('rejects an empty file', () => {
    expect(rejected(new Uint8Array())).toBe('empty');
  });

  it('rejects more than 10 MB before looking at the content', () => {
    const big = new Uint8Array(IMAGE_LIMITS.maxBytes + 1);
    big.set(makePng({ width: 512, height: 512 }));
    expect(rejected(big)).toBe('too_large');
    expect(IMAGE_LIMITS.maxBytes).toBe(10 * 1024 * 1024);
  });

  it.each([
    ['SVG with a script', SVG_WITH_SCRIPT, 'svg'],
    ['SVG behind a BOM, whitespace and an XML prolog', SVG_WITH_PROLOG, 'svg'],
    ['HTML renamed .png', HTML_AS_PNG, 'html'],
    ['plain <script> text', ascii('<script>alert(1)</script>'), 'html'],
    ['GIF with an embedded script comment', GIF_WITH_SCRIPT, 'gif'],
    ['a PDF', ascii('%PDF-1.7\n%âãÏÓ\n1 0 obj'), 'unsupported_type'],
    ['random text', ascii('just some words, not an image'), 'unsupported_type'],
    ['a UTF-16 document', new Uint8Array([0xff, 0xfe, 0x3c, 0x00, 0x73, 0x00]), 'unsupported_type'],
  ] as const)('%s → %s', (_name, bytes, code) => {
    expect(rejected(bytes)).toBe(code);
  });

  describe('polyglots and hidden content', () => {
    it.each([
      ['PNG with <script> in a text chunk', makePng({ width: 512, height: 512, before: [pngText('Comment', '<script>alert(1)</script>')] })],
      ['PNG with an HTML page in a private chunk', makePng({ width: 512, height: 512, after: [pngChunk('prVt', ascii('<!DOCTYPE html><html><body>hi</body></html>'))] })],
      ['PNG with an SVG in a text chunk', makePng({ width: 512, height: 512, before: [pngText('Title', '<svg onload=alert(1)>')] })],
      ['PNG with a javascript: URL in a text chunk', makePng({ width: 512, height: 512, before: [pngText('Source', 'javascript:alert(1)')] })],
      ['JPEG with HTML in a comment', makeJpeg({ width: 512, height: 512, comment: '<html><script>alert(1)</script></html>' })],
      ['JPEG with an iframe in a comment', makeJpeg({ width: 512, height: 512, comment: 'x<IFRAME src=//evil>' })],
      ['WebP with an SVG in an unknown chunk', makeWebp({ width: 512, height: 512, extra: [webpChunk('XTRA', ascii('<svg xmlns="x"></svg>'))] })],
    ])('%s → embedded_markup', (_name, bytes) => {
      expect(rejected(bytes)).toBe('embedded_markup');
    });

    it.each([
      ['PNG followed by an HTML page', makePng({ width: 512, height: 512, trailing: ascii('<html><script>alert(1)</script></html>') })],
      ['PNG followed by a zip archive', makePng({ width: 512, height: 512, trailing: concat(ascii('PK'), new Uint8Array([3, 4, 20, 0])) })],
      ['JPEG followed by a script', makeJpeg({ width: 512, height: 512, trailing: ascii('<script>alert(1)</script>') })],
      ['WebP with bytes beyond its RIFF size', makeWebp({ width: 512, height: 512, trailing: ascii('<html>') })],
    ])('%s → trailing_data', (_name, bytes) => {
      expect(rejected(bytes)).toBe('trailing_data');
    });
  });

  describe('malformed structure', () => {
    it.each([
      ['PNG without IEND', makePng({ width: 512, height: 512, omitIend: true })],
      ['PNG with a bad CRC', makePng({ width: 512, height: 512, badCrc: true })],
      ['truncated PNG', makePng({ width: 512, height: 512 }).slice(0, 40)],
      ['PNG whose first chunk is not IHDR', concat(makePng({ width: 1, height: 1 }).slice(0, 8), pngChunk('IEND', new Uint8Array()))],
      ['JPEG without EOI', makeJpeg({ width: 512, height: 512, omitEoi: true })],
      ['JPEG without a frame header', concat(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))],
      ['JPEG with a zero height', makeJpeg({ width: 512, height: 0 })],
      ['WebP without an image chunk', concat(ascii('RIFF'), new Uint8Array([4, 0, 0, 0]), ascii('WEBP'))],
    ])('%s → malformed', (_name, bytes) => {
      expect(rejected(bytes)).toBe('malformed');
    });

    it('treats a RIFF file that is not WebP (WAV, AVI) as an unsupported type', () => {
      expect(rejected(concat(ascii('RIFF'), new Uint8Array([4, 0, 0, 0]), ascii('WAVE')))).toBe('unsupported_type');
    });
  });

  it('rejects animated images (the published art is a still)', () => {
    expect(rejected(makePng({ width: 512, height: 512, before: [pngChunk('acTL', new Uint8Array(8))] }))).toBe('animated');
    expect(rejected(makeWebp({ width: 512, height: 512, kind: 'VP8X', animated: true }))).toBe('animated');
  });

  it.each([
    [255, 512, 'dimensions_too_small'],
    [512, 255, 'dimensions_too_small'],
    [4097, 512, 'dimensions_too_large'],
    [256, 5000, 'dimensions_too_large'],
  ] as const)('%i × %i px → %s', (width, height, code) => {
    expect(rejected(makePng({ width, height }))).toBe(code);
    expect(rejected(makeJpeg({ width, height }))).toBe(code);
  });

  it('explains every rejection in words', () => {
    for (const bytes of [new Uint8Array(), SVG_WITH_SCRIPT, HTML_AS_PNG, GIF_WITH_SCRIPT, makePng({ width: 100, height: 100 })]) {
      const result = inspectImage(bytes);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message.length).toBeGreaterThan(20);
    }
  });
});
