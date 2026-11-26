/**
 * SH-ACCEPT-C2PA (founder decision 2026-10-24): pictures made by AI tools are accepted as they are, C2PA "content
 * credentials" included. The decision covers AI pictures, not markup (fix round 1): a C2PA manifest store, recognised by
 * its structure (one well-formed JUMBF superbox labelled `c2pa` that fills its carrier), is scanned for markup like any
 * metadata, whole. Only an SVG file embedded in it (OpenAI's c2pa.icon: the `bidb` of an embedded-file box whose `bfdb`
 * says image/svg+xml) may open with `<svg`, one per embedded-file box, and it must be a static drawing. Everything else
 * is still refused: markup anywhere else in the store or in any other chunk or segment, a carrier that is not JUMBF,
 * bytes after the store, a damaged, truncated, oversized or mislabelled store, a second store, data after the image's end.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { inspectImage, type ImageRejectionCode } from './index';
import { joinJumbfParts, type JumbfPart } from './sniff';
import {
  C2PA_FIXTURES,
  EMBEDDED_FILE_UUID,
  OPENAI_LIKE_ICON,
  bfdb,
  c2paStore,
  c2paUuid,
  caBX,
  iconBox,
  insertAfter,
  jpegJumbfSegments,
  jumbfBox,
  jumd,
  manifest,
  pngChunks,
  pngStore,
  readC2paFixture,
  replaceStoreChunk,
  superbox,
  syntheticStore,
  withXlBox,
} from './test-support/c2pa';
import { ascii, concat, jpegSegment, makeJpeg, makePng, makeWebp, pngChunk, pngText, webpChunk } from './test-support/images';

type Outcome = ImageRejectionCode | 'accepted';
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const outcome = (bytes: Uint8Array): Outcome => {
  const result = inspectImage(bytes);
  return result.ok ? 'accepted' : result.code;
};
const holds = (bytes: Uint8Array, text: string): boolean => Buffer.from(bytes).includes(text);
const u32be = (value: number): Uint8Array => new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
/** A copy of `bytes` with a big-endian u32 written at `at`. */
const withU32 = (bytes: Uint8Array, at: number, value: number): Uint8Array<ArrayBuffer> => {
  const copy = bytes.slice();
  copy.set(u32be(value), at);
  return copy;
};

const base = readC2paFixture('rent-free-logo');
const store = pngStore(base);
const jpegWith = (segments: readonly Uint8Array[], comment?: string) => makeJpeg({ width: 1024, height: 768, segments, ...(comment === undefined ? {} : { comment }) });
const webpWith = (...extra: readonly Uint8Array[]) => makeWebp({ width: 1024, height: 768, kind: 'VP8X', extra });
const pngWith = (...before: readonly Uint8Array[]) => makePng({ width: 512, height: 512, before });
/** Filler that puts what follows past the first 64 bytes, which are scanned as the container's header anyway. */
const PAST_HEADER = new Uint8Array(64).fill(0x2e);

/** The outcome for a store in each carrier: a PNG `caBX` chunk, JPEG APP11 parts (one; 50-byte parts), a WebP `C2PA` chunk. */
const inEveryCarrier = (s: Uint8Array): Record<string, Outcome> => ({
  png: outcome(pngWith(caBX(s))),
  jpeg: outcome(jpegWith(jpegJumbfSegments(s))),
  'jpeg in 50-byte parts': outcome(jpegWith(jpegJumbfSegments(s, { partBytes: 50 }))),
  webp: outcome(webpWith(webpChunk('C2PA', s))),
});
const everywhere = (result: Outcome): Record<string, Outcome> => ({ png: result, jpeg: result, 'jpeg in 50-byte parts': result, webp: result });

/** `bytes` with the ASCII text `from` (there exactly once) replaced by `to` of the same length: box lengths stay valid. */
function swapText(bytes: Uint8Array, from: string, to: string): Uint8Array<ArrayBuffer> {
  const at = Buffer.from(bytes).indexOf(from);
  if (from.length !== to.length || at < 0 || Buffer.from(bytes).indexOf(from, at + 1) >= 0) throw new Error(`"${from}" is not there exactly once, or "${to}" differs in length`);
  const copy = bytes.slice();
  copy.set(ascii(to), at);
  return copy;
}

/** A store (LBox header) with one more top-level box, normally a manifest, after its own; its LBox fixed up. */
function withExtra(s: Uint8Array, extra: Uint8Array): Uint8Array<ArrayBuffer> {
  const content = concat(s.subarray(8), extra);
  return concat(u32be(8 + content.length), ascii('jumb'), content);
}

describe('real AI pictures with C2PA content credentials are accepted as they are', () => {
  it.each(C2PA_FIXTURES.map((fixture) => [fixture.name, fixture] as const))('%s', (_name, fixture) => {
    const bytes = readC2paFixture(fixture.name);
    expect([bytes.length, sha256(bytes)]).toEqual([fixture.bytes, fixture.sha256]);
    const own = pngStore(bytes);
    expect(own.length).toBe(fixture.storeBytes);
    // The store holds OpenAI's c2pa.icon, an SVG: what the scan refused before this change.
    expect(holds(own, 'c2pa.icon') && holds(own, '<svg')).toBe(true);
    expect(inspectImage(bytes)).toEqual({ ok: true, format: 'png', mediaType: 'image/png', width: fixture.width, height: fixture.height });
    expect(sha256(bytes)).toBe(fixture.sha256);
  });

  it.each(C2PA_FIXTURES.map((fixture) => [fixture.name] as const))('the store of %s is accepted in every carrier: PNG caBX, JPEG APP11 parts, WebP C2PA', (name) => {
    const own = pngStore(readC2paFixture(name));
    expect(inEveryCarrier(own)).toEqual(everywhere('accepted'));
    expect(outcome(jpegWith(jpegJumbfSegments(own, { partBytes: 4000 })))).toBe('accepted');
  });

  it('only a recognised store may hold an icon: the same file with a mislabelled store is refused as damaged', () => {
    const labelAt = 8 + 8 + 16 + 1; // jumb header, jumd header, UUID, toggles
    expect(String.fromCharCode(...store.subarray(labelAt, labelAt + 5))).toBe('c2pa\0');
    const mislabelled = store.slice();
    mislabelled[labelAt + 3] = 0x58; // 'c2pX'
    // embedded_markup until fix round 2: a caBX chunk that is no well-formed store now makes the picture damaged.
    expect(outcome(replaceStoreChunk(base, caBX(mislabelled)))).toBe('malformed');
  });

  it('a store laid out as OpenAI writes it, an extended-length (XLBox) store, and one nested 16 levels deep are accepted', () => {
    const synthetic = syntheticStore();
    expect(inEveryCarrier(synthetic)).toEqual(everywhere('accepted'));
    const content = synthetic.subarray(8);
    const extended = concat(u32be(1), ascii('jumb'), u32be(0), u32be(16 + content.length), content);
    expect(outcome(pngWith(caBX(extended)))).toBe('accepted');
    expect(outcome(pngWith(caBX(nested(16))))).toBe('accepted');
  });
});

/** A store whose deepest superbox (an embedded SVG icon) is at level `depth`; the store itself is level 1. */
function nested(depth: number): Uint8Array<ArrayBuffer> {
  let inner = superbox(jumd(EMBEDDED_FILE_UUID, 'c2pa.icon'), bfdb('image/svg+xml'), jumbfBox('bidb', ascii('<svg/>')));
  for (let level = depth - 1; level >= 2; level -= 1) inner = superbox(jumd(c2paUuid('c2as'), `level-${level}`), inner);
  return superbox(jumd(c2paUuid('c2pa'), 'c2pa'), inner);
}

describe('everything outside a well-formed C2PA store is still refused', () => {
  const chunkOf = (png: Uint8Array, type: string) => pngChunks(png).find((chunk) => chunk.type === type);

  it.each([
    ['markup in another ancillary chunk beside a real store', insertAfter(base, 'caBX', pngText('Comment', '<script>alert(1)</script>'))],
    ['an HTML page in a private chunk beside a real store', insertAfter(base, 'IHDR', pngChunk('prVt', ascii('<!DOCTYPE html><html><body>hi</body></html>')))],
  ])('PNG: %s → embedded_markup', (_name, bytes) => {
    expect(outcome(bytes)).toBe('embedded_markup');
  });

  // Each of these was refused as embedded_markup until fix round 2 (the scan found the markup or the icon in a chunk that
  // was no store); a caBX chunk that is no complete, well-formed store, or a second one, now makes the picture damaged.
  it.each([
    ['a caBX chunk that is not JUMBF, holding an SVG', replaceStoreChunk(base, caBX(concat(PAST_HEADER, ascii('<svg onload="alert(1)"></svg>'))))],
    ['a caBX chunk with markup appended after the store', replaceStoreChunk(base, caBX(concat(store, ascii('<script>alert(1)</script>'))))],
    ['a store whose LBox declares less than its chunk holds', replaceStoreChunk(base, caBX(withU32(store, 0, store.length - 100)))],
    ['a box inside the store with markup after its declared length', pngWith(caBX(superbox(jumd(c2paUuid('c2pa'), 'c2pa'), superbox(jumd(c2paUuid('c2ma'), 'm'), jumbfBox('bidb', ascii('x')), ascii('<svg onload=alert(1)>')))))],
    ['a truncated store (chunk length and CRC consistent)', replaceStoreChunk(base, caBX(store.subarray(0, store.length - 100)))],
    ['an oversized store: its LBox claims more than the chunk holds', replaceStoreChunk(base, caBX(withU32(store, 0, store.length + 1000)))],
    ['a store with LBox 0 ("to the end of the file")', replaceStoreChunk(base, caBX(withU32(store, 0, 0)))],
    ['a store with a different UUID', pngWith(caBX(syntheticStore({ uuid: c2paUuid('c2pb') })))],
    ['a store with a different label', pngWith(caBX(syntheticStore({ label: 'c2pa.other' })))],
    ['a store holding a bare box instead of manifests', pngWith(caBX(superbox(jumd(c2paUuid('c2pa'), 'c2pa'), jumbfBox('json', ascii('{"x":"<script>alert(1)</script>"}')))))],
    ['a store with stray bytes in its description box', pngWith(caBX(superbox(jumd(c2paUuid('c2pa'), 'c2pa', { tail: ascii('<svg/>') }), superbox(jumd(c2paUuid('c2ma'), 'm')))))],
    ['a store with reserved toggle bits set', pngWith(caBX(superbox(jumd(c2paUuid('c2pa'), 'c2pa', { toggles: 0x83 }), superbox(jumd(c2paUuid('c2ma'), 'm'), jumbfBox('bidb', ascii('<svg/>'))))))],
    ['a store nested deeper than 16 levels', pngWith(caBX(nested(17)))],
    ['a second caBX chunk, itself a well-formed store', insertAfter(base, 'caBX', caBX(syntheticStore()))],
  ])('PNG: %s → malformed (embedded_markup before fix round 2)', (_name, bytes) => {
    expect(outcome(bytes)).toBe('malformed');
  });

  it('PNG: a caBX chunk claiming more bytes than the file holds, or with a bad CRC → malformed', () => {
    const at = chunkOf(base, 'caBX')?.start ?? -1;
    expect(outcome(withU32(base, at, store.length + 1_000_000))).toBe('malformed');
    expect(outcome(replaceStoreChunk(base, pngChunk('caBX', store, { badCrc: true })))).toBe('malformed');
  });

  it('PNG: HTML after IEND → trailing_data', () => {
    expect(outcome(concat(base, ascii('<html><script>alert(1)</script></html>')))).toBe('trailing_data');
  });

  it.each([
    ['a comment with a script beside a valid store', jpegWith(jpegJumbfSegments(store), '<script>alert(1)</script>')],
    ['an APP11 segment that is not JUMBF, holding an SVG', jpegWith([jpegSegment(0xeb, concat(PAST_HEADER, ascii('<svg onload=alert(1)>')))])],
    ['a second JUMBF instance, not C2PA, holding markup', jpegWith([...jpegJumbfSegments(store), ...jpegJumbfSegments(superbox(jumd(c2paUuid('json'), 'x'), jumbfBox('json', ascii('<svg/>'))), { instance: 2 })])],
  ])('JPEG: %s → embedded_markup', (_name, bytes) => {
    expect(outcome(bytes)).toBe('embedded_markup');
  });

  it.each([
    ['a second C2PA store in another instance', jpegWith([...jpegJumbfSegments(store), ...jpegJumbfSegments(syntheticStore(), { instance: 2 })])],
    ['parts out of sequence', jpegWith(jpegJumbfSegments(store, { partBytes: 4000, sequences: [1, 3, 4, 5, 6, 7] }))],
    ['a part missing (the parts do not add up to the box)', jpegWith(jpegJumbfSegments(store, { partBytes: 4000 }).slice(0, -1))],
    ['markup after the store in its last part', jpegWith(jpegJumbfSegments(concat(store, ascii('<script>alert(1)</script>'))))],
    ['a part repeating a different box header', jpegWith(jpegJumbfSegments(store, { partBytes: 4000 }).map((segment, i) => (i === 2 ? withU32(segment, 4 + 8, store.length + 1) : segment)))],
  ])('JPEG: %s → malformed (embedded_markup before fix round 2)', (_name, bytes) => {
    expect(outcome(bytes)).toBe('malformed');
  });

  it('WebP: markup in another chunk beside a valid store → embedded_markup', () => {
    expect(outcome(webpWith(webpChunk('C2PA', store), webpChunk('XTRA', ascii('<svg xmlns="x"></svg>'))))).toBe('embedded_markup');
  });

  it.each([
    ['a C2PA chunk that is not JUMBF, holding an SVG', webpWith(webpChunk('C2PA', concat(PAST_HEADER, ascii('<svg onload=alert(1)>'))))],
    ['a C2PA chunk with markup after the store', webpWith(webpChunk('C2PA', concat(store, ascii('<script>alert(1)</script>'))))],
    ['a second C2PA chunk', webpWith(webpChunk('C2PA', store), webpChunk('C2PA', syntheticStore()))],
  ])('WebP: %s → malformed (embedded_markup before fix round 2)', (_name, bytes) => {
    expect(outcome(bytes)).toBe('malformed');
  });
});

describe('markup inside a well-formed C2PA store is refused, in every carrier (fix round 1)', () => {
  const HTML = '<!doctype html><html><body><script>alert(document.domain)</script></body></html>';
  /** A manifest-like superbox with an unlabelled description (toggles 0), as small as JUMBF allows. */
  const bare = (...children: readonly Uint8Array[]) => superbox(jumd(c2paUuid('xxxx'), null, { toggles: 0 }), ...children);

  it.each([
    ['a script as the icon (pinned as accepted "by decision" before fix round 1)', syntheticStore({ icon: '<script>alert(1)</script>' })],
    ['a minimal store holding an HTML page (79 bytes of boxes around it)', c2paStore(bare(jumbfBox('json', ascii(HTML))))],
    ['a box type that opens a tag ("<scr" is printable)', c2paStore(bare(jumbfBox('<scr', ascii('ipt>alert(1)</script>'))))],
    ['markup in a manifest label', c2paStore(superbox(jumd(c2paUuid('c2ma'), '<script>alert(1)</script>'), jumbfBox('cbor', new Uint8Array([0xa0]))))],
    ['markup in a private box of a description', c2paStore(superbox(jumd(c2paUuid('c2ma'), 'm', { toggles: 0x13, tail: jumbfBox('c2sh', ascii('<iframe src=javascript:alert(1)>')) })))],
    ['an extra manifest after the real one, holding an HTML page', withExtra(store, superbox(jumd(c2paUuid('c2ma'), 'urn:x'), jumbfBox('json', ascii(HTML))))],
    ['markup in an assertion beside a static icon', c2paStore(manifest(iconBox(OPENAI_LIKE_ICON), jumbfBox('json', ascii('{"x":"<svg onload=alert(1)>"}'))))],
    ['the real store, its icon given an event handler (same length)', swapText(store, ' fill="none"', ' onload="a1"')],
    ['the real store, its icon given an href (same length)', swapText(store, 'fill="black"', 'href="#abcd"')],
  ])('%s', (_name, s) => {
    expect(inEveryCarrier(s)).toEqual(everywhere('embedded_markup'));
  });

  it('JPEG: markup split across two APP11 parts of the store is found in the joined store', () => {
    const s = c2paStore(manifest(jumbfBox('json', ascii('{"x":"<script>alert(1)</script>"}'))));
    const split = Buffer.from(s.subarray(8)).indexOf('<script') + 3; // the first part's data ends inside "<script"
    const parts = jpegJumbfSegments(s, { partBytes: split });
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.some((part) => holds(part, '<script'))).toBe(false);
    expect(outcome(jpegWith(parts))).toBe('embedded_markup');
  });
});

/** Embedded SVG files that are not static drawings: each is refused as a store's icon, in every carrier. */
const ACTIVE_SVGS: readonly (readonly [string, string])[] = [
  ['a script element', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
  ['a script element in upper case', '<svg><SCRIPT>alert(1)</SCRIPT></svg>'],
  ['a script element with an external href', '<svg><script href="https://example.invalid/x.js"/></svg>'],
  ['a prefixed script element (svg:script)', '<svg xmlns:svg="http://www.w3.org/2000/svg"><svg:script>alert(1)</svg:script></svg>'],
  ['a prefixed script element (x:script)', '<svg xmlns:x="http://www.w3.org/2000/svg"><x:script>alert(1)</x:script></svg>'],
  ['onload', '<svg onload="alert(1)"/>'],
  ['onload in upper case', '<svg ONLOAD="alert(1)"/>'],
  ['onload after a newline', '<svg\nonload="alert(1)"/>'],
  ['onload after a tab', '<svg\tonload="alert(1)"/>'],
  ['onload after a carriage return', '<svg\ronload="alert(1)"/>'],
  ['onload after a form feed', '<svg\fonload="alert(1)"/>'],
  ['onload after a slash', '<svg/onload="alert(1)"/>'],
  ['onload right after a quoted value', '<svg width="1"onload="alert(1)"/>'],
  ['onload right after a single-quoted value', "<svg width='1'onload='alert(1)'/>"],
  ['onload with spaces around the equals sign', '<svg onload = "alert(1)"/>'],
  ['onload with an entity in its value', '<svg onload="&#97;lert(1)"/>'],
  ['a prefixed onload (x:onload)', '<svg xmlns:x="http://www.w3.org/2000/svg" x:onload="alert(1)"/>'],
  ['onclick on a path', '<svg><path d="M0 0h1v1z" onclick="alert(1)"/></svg>'],
  ['an a element with a javascript: href', '<svg><a href="javascript:alert(1)"><path d="M0 0h1v1z"/></a></svg>'],
  ['an a element with an entity-encoded javascript: xlink:href', '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="&#106;avascript:alert(1)"><path d="M0 0h1v1z"/></a></svg>'],
  ['an a element after a newline, HREF in upper case', '<svg><a\nHREF="#x"><path d="M0 0h1v1z"/></a></svg>'],
  ['an a element with no attribute', '<svg><a><path d="M0 0h1v1z"/></a></svg>'],
  ['an href on a drawing element', '<svg><path href="#x" d="M0 0h1v1z"/></svg>'],
  ['an image with an external href', '<svg><image href="https://example.invalid/x.png" width="1" height="1"/></svg>'],
  ['use with a data: href', '<svg><use href="data:image/svg+xml;base64,PHN2Zy8+"/></svg>'],
  ['use with no attribute', '<svg><use/></svg>'],
  ['use in upper case', '<svg><USE/></svg>'],
  ['foreignObject', '<svg><foreignObject><div>x</div></foreignObject></svg>'],
  ['foreignobject in lower case', '<svg><foreignobject width="1" height="1"></foreignobject></svg>'],
  ['an iframe', '<svg><iframe src="https://example.invalid/"></iframe></svg>'],
  ['a prefixed XHTML iframe with an entity-encoded javascript: src', '<svg><h:iframe xmlns:h="http://www.w3.org/1999/xhtml" src="&#106;avascript:alert(1)"/></svg>'],
  ['an HTML button with an entity-encoded javascript: formaction', '<svg><button formaction="&#106;avascript:alert(1)">x</button></svg>'],
  ['a style element', '<svg><style>@import url(https://example.invalid/x.css);</style></svg>'],
  ['animate', '<svg><animate attributeName="x" from="0" to="1" dur="1s"/></svg>'],
  ['animate setting an entity-encoded javascript: href', '<svg><animate attributeName="href" values="&#106;avascript:alert(1)"/></svg>'],
  ['animateTransform', '<svg><animateTransform attributeName="transform" type="rotate" from="0" to="90" dur="1s"/></svg>'],
  ['animateMotion', '<svg><animateMotion path="M0 0h1" dur="1s"/></svg>'],
  ['set', '<svg><set attributeName="fill" to="red"/></svg>'],
  ['set in upper case', '<svg><SET attributeName="fill" to="red"/></svg>'],
  ['a DOCTYPE declaring an entity', '<svg><!DOCTYPE svg [<!ENTITY x "&#60;script&#62;alert(1)&#60;/script&#62;">]>&x;</svg>'],
  ['a processing instruction (xml-stylesheet)', '<svg><?xml-stylesheet type="text/xsl" href="x.xsl"?></svg>'],
  ['a CDATA section', '<svg><![CDATA[x]]></svg>'],
  ['a comment', '<svg><!-- x --></svg>'],
  ['a second svg element', '<svg><svg width="1"/></svg>'],
  ['two svg roots', '<svg></svg><svg></svg>'],
  ['a tag with a space after <', '<svg>< script>alert(1)</script></svg>'],
  ['a tag cut off by the end of the file', '<svg></sv'],
  ['javascript: in a style', '<svg><path d="M0 0" style="fill:url(javascript:alert(1))"/></svg>'],
  ['data:text/html in a value', '<svg><path d="M0 0" fill="url(data:text/html,x)"/></svg>'],
  ['a character reference in a value', '<svg><path d="M0 0h1v1z" fill="&#x72;ed"/></svg>'],
  ['markup escaped as entities in a title', '<svg><title>&lt;script&gt;alert(1)&lt;/script&gt;</title></svg>'],
  ['markup after the closing tag', `${OPENAI_LIKE_ICON}<script>alert(1)</script>`],
];

/** A static drawing that uses every element an embedded SVG may use. */
const STATIC_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">\n<title>Mark</title><desc>A mark</desc>' +
  '<defs><linearGradient id="a"><stop offset="0" stop-color="#000"/></linearGradient><radialGradient id="b"/><clipPath id="c"><rect width="10" height="10"/></clipPath><mask id="m"><circle cx="5" cy="5" r="5"/></mask></defs>\n' +
  '<g clip-path="url(#c)" mask="url(#m)" fill="url(#a)"><path d="M0 0h10v10z"/><ellipse cx="5" cy="5" rx="2" ry="1"/><line x1="0" y1="0" x2="1" y2="1" stroke="#000"/><polyline points="0,0 1,1"/><polygon points="0,0 1,1 1,0"/></g>\n</svg>\n';

describe('an SVG embedded in a store (c2pa.icon) may open with <svg, and must be a static drawing (fix round 1)', () => {
  it.each(ACTIVE_SVGS)('%s → embedded_markup in every carrier', (_name, svg) => {
    expect(inEveryCarrier(syntheticStore({ icon: svg }))).toEqual(everywhere('embedded_markup'));
  });

  it('a static drawing with every allowed element (svg, g, defs, title, desc, shapes, gradients, clipPath, mask) is accepted', () => {
    expect(inEveryCarrier(syntheticStore({ icon: STATIC_SVG }))).toEqual(everywhere('accepted'));
  });
});

describe('only an SVG file in an embedded-file box may open with <svg, one per box (fix round 1)', () => {
  const svgFile = jumbfBox('bidb', ascii(OPENAI_LIKE_ICON));

  it.each([
    ['an SVG whose bfdb says image/png', c2paStore(manifest(iconBox(OPENAI_LIKE_ICON, { mediaType: 'image/png' })))],
    ['an SVG whose bfdb also names the file', c2paStore(manifest(iconBox(OPENAI_LIKE_ICON, { boxes: [bfdb('image/svg+xml', 'icon.svg'), svgFile] })))],
    ['an SVG in a json box', c2paStore(manifest(jumbfBox('json', ascii(OPENAI_LIKE_ICON))))],
    ['an SVG in the bidb of a superbox that is not an embedded file', c2paStore(manifest(superbox(jumd(c2paUuid('cbor'), 'c2pa.icon'), bfdb('image/svg+xml'), svgFile)))],
    ['two SVG files in one embedded-file box', c2paStore(manifest(iconBox(OPENAI_LIKE_ICON, { boxes: [bfdb('image/svg+xml'), svgFile, svgFile] })))],
    ['an SVG file before its description', c2paStore(manifest(iconBox(OPENAI_LIKE_ICON, { boxes: [svgFile, bfdb('image/svg+xml')] })))],
    ['an SVG file opening with an XML declaration', syntheticStore({ icon: `<?xml version="1.0" encoding="UTF-8"?>${OPENAI_LIKE_ICON}` })],
    ['an SVG file opening with a space', syntheticStore({ icon: ` ${OPENAI_LIKE_ICON}` })],
    ['an SVG file opening with a byte-order mark', syntheticStore({ icon: `\ufeff${OPENAI_LIKE_ICON}` })],
    ['an SVG file opening with <SVG in upper case', syntheticStore({ icon: OPENAI_LIKE_ICON.replace('<svg', '<SVG') })],
    ['two manifests, the second one with an event handler in its icon', c2paStore(manifest(iconBox(OPENAI_LIKE_ICON)), manifest(iconBox('<svg onload="alert(1)"/>')))],
  ])('%s → embedded_markup in every carrier', (_name, s) => {
    expect(inEveryCarrier(s)).toEqual(everywhere('embedded_markup'));
  });

  it.each([
    ['a store with two manifests, each with its icon', c2paStore(manifest(iconBox(OPENAI_LIKE_ICON)), manifest(iconBox(OPENAI_LIKE_ICON)))],
    ['a manifest with two icons, each in its own embedded-file box', c2paStore(manifest(iconBox(OPENAI_LIKE_ICON), iconBox(OPENAI_LIKE_ICON)))],
    ['the real store with a second manifest carrying an icon', withExtra(store, manifest(iconBox(OPENAI_LIKE_ICON)))],
  ])('%s → accepted in every carrier', (_name, s) => {
    expect(inEveryCarrier(s)).toEqual(everywhere('accepted'));
  });
});

// ── Fix round 2 (XR-SH-ACCEPT-C2PA, findings F1 to F4) ─────────────────────────────────────────────────────────────
/** A well-formed store holding only harmless JSON: a damaged-store refusal must not depend on markup. */
const harmless = c2paStore(manifest(jumbfBox('json', ascii('{}'))));
/** A store holding only JSON whose deepest superbox is at level `levels` (the store is level 1). */
function deepHarmless(levels: number): Uint8Array<ArrayBuffer> {
  let inner = superbox(jumd(c2paUuid('c2ma'), `level-${levels}`), jumbfBox('json', ascii('{}')));
  for (let level = levels - 1; level >= 2; level -= 1) inner = superbox(jumd(c2paUuid('c2ma'), `level-${level}`), inner);
  return c2paStore(inner);
}
/** A box that is not C2PA (its description has another UUID) holding `json`. */
const otherJumbf = (json: string) => superbox(jumd(c2paUuid('json'), 'x'), jumbfBox('json', ascii(json)));
/** APP11 parts of `box` whose first part's data ends three bytes into `text`, so that no part holds `text` whole. */
function splitAt(box: Uint8Array, text: string, instance: number): Uint8Array<ArrayBuffer>[] {
  const parts = jpegJumbfSegments(box, { instance, partBytes: Buffer.from(box.subarray(8)).indexOf(text) + 3 });
  if (parts.length < 2 || parts.some((part) => holds(part, text))) throw new Error(`"${text}" is not split`);
  return parts;
}

describe('a picture holds at most one C2PA store (fix round 2, F1)', () => {
  it('JPEG: a second store with a script split across two APP11 parts is refused, after a first store with an icon too', () => {
    const second = splitAt(c2paStore(manifest(jumbfBox('json', ascii('<script>alert(1)</script>')))), '<script', 2);
    expect(outcome(jpegWith(second))).toBe('embedded_markup'); // alone: the one store, scanned as rebuilt
    expect(outcome(jpegWith([...jpegJumbfSegments(syntheticStore()), ...second]))).toBe('malformed'); // accepted on fa83a2e4d
  });

  it('two stores are refused as damaged even when both hold only JSON, in PNG, JPEG and WebP', () => {
    expect(outcome(pngWith(caBX(harmless), caBX(harmless)))).toBe('malformed');
    expect(outcome(jpegWith([...jpegJumbfSegments(harmless), ...jpegJumbfSegments(harmless, { instance: 2 })]))).toBe('malformed');
    expect(outcome(webpWith(webpChunk('C2PA', harmless), webpChunk('C2PA', harmless)))).toBe('malformed');
    expect(inEveryCarrier(harmless)).toEqual(everywhere('accepted'));
  });

  it('JPEG: every other JUMBF box is also scanned as its parts rebuild it, so a script split across two parts is found', () => {
    const parts = splitAt(otherJumbf('{"x":"<script>alert(1)</script>"}'), '<script', 2);
    expect(outcome(jpegWith(parts))).toBe('embedded_markup');
    expect(outcome(jpegWith([...jpegJumbfSegments(syntheticStore()), ...parts]))).toBe('embedded_markup');
    expect(outcome(jpegWith([...jpegJumbfSegments(syntheticStore()), ...jpegJumbfSegments(otherJumbf('{}'), { instance: 2, partBytes: 50 })]))).toBe('accepted');
  });
});

describe('a C2PA store that is damaged or incomplete refuses the picture as damaged, whatever it holds (fix round 2, F3)', () => {
  it.each([0, 1, 7, harmless.length - 1, harmless.length + 1, 0xffffffff])('a store holding only JSON with its LBox set to %i → malformed in every carrier', (length) => {
    expect(inEveryCarrier(withU32(harmless, 0, length))).toEqual(everywhere('malformed'));
  });

  it('JPEG: that store with LBox 1 whose parts repeat only 8 header bytes (the review reproduction) → malformed', () => {
    const lboxOne = withU32(harmless, 0, 1);
    expect(outcome(jpegWith(jpegJumbfSegments(lboxOne, { headerBytes: 8 })))).toBe('malformed');
    expect(outcome(jpegWith(jpegJumbfSegments(lboxOne, { headerBytes: 8, partBytes: 50 })))).toBe('malformed');
  });

  it('a store holding only JSON nested 17 or 21 levels deep → malformed in every carrier (16 levels are accepted)', () => {
    expect(inEveryCarrier(deepHarmless(16))).toEqual(everywhere('accepted'));
    expect(inEveryCarrier(deepHarmless(17))).toEqual(everywhere('malformed'));
    expect(inEveryCarrier(deepHarmless(21))).toEqual(everywhere('malformed'));
  });

  it('JPEG: a store holding only JSON with its last APP11 part missing, or its parts out of order → malformed', () => {
    const parts = jpegJumbfSegments(harmless, { partBytes: 50 });
    expect(outcome(jpegWith(parts.slice(0, -1)))).toBe('malformed');
    expect(outcome(jpegWith([...parts.slice(1), ...parts.slice(0, 1)]))).toBe('malformed');
  });

  it('PNG and WebP: a store chunk of harmless bytes that are no JUMBF, or an empty one → malformed', () => {
    expect(outcome(pngWith(caBX(ascii('{"json":"only"}'))))).toBe('malformed');
    expect(outcome(pngWith(caBX(new Uint8Array())))).toBe('malformed');
    expect(outcome(webpWith(webpChunk('C2PA', ascii('{"json":"only"}'))))).toBe('malformed');
    expect(outcome(webpWith(webpChunk('C2PA', new Uint8Array())))).toBe('malformed');
  });

  it('JPEG: a damaged JUMBF box that shows another UUID is no store: scanned as before, accepted when it holds no markup', () => {
    // Its first part shows the whole description (UUID 'json'); the last part is missing.
    expect(outcome(jpegWith(jpegJumbfSegments(otherJumbf('{}'), { partBytes: 30 }).slice(0, -1)))).toBe('accepted');
  });
});

describe('JPEG APP11 parts are read only inside their segments (fix round 2, F4)', () => {
  // One part: 'JP', instance 1, sequence 1, then a box header that declares an XLBox (LBox 1, 'jumb') but ends there.
  const cut = concat(new Uint8Array([0x4a, 0x50, 0, 1, 0, 0, 0, 1]), u32be(1), ascii('jumb'));

  it('joining a part whose 16-byte header is cut off reads no byte past the part', () => {
    const bytes = concat(cut, new Uint8Array(32)); // what would follow the part in a file
    const part: JumbfPart = { instance: 1, sequence: 1, start: 0, end: cut.length };
    const outside: number[] = [];
    const observed = new Proxy(bytes, {
      get(target, key) {
        if (typeof key === 'string' && /^\d+$/.test(key) && Number(key) >= part.end) outside.push(Number(key));
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    expect(joinJumbfParts(observed, [part])).toBeNull();
    expect(outside).toEqual([]);
  });

  it('in a picture, that part is a store that does not rebuild → malformed', () => {
    expect(outcome(jpegWith([jpegSegment(0xeb, cut)]))).toBe('malformed');
  });
});

/** SVG files that are not one complete drawing: each refused as a store's icon, in every carrier (fix round 2, F2). */
const INCOMPLETE_SVGS: readonly (readonly [string, string])[] = [
  ['an allowed element after the root', '<svg></svg><path/>'],
  ['a second document after the root', '<svg></svg><title>second document</title>'],
  ['text after the root', '<svg></svg>plain bytes'],
  ['an unfinished root tag', '<svg '],
  ['an element never closed', '<svg><path>'],
  ['the root never closed', '<svg><path/>'],
  ['an end tag closing another element', '<svg><g></path></svg>'],
  ['an end tag after the root', '<svg></svg></svg>'],
  ['an end tag in another case', '<svg></SVG>'],
  ['an end tag with an attribute', '<svg></svg x="1">'],
  ['an unquoted attribute value', '<svg width=1/>'],
  ['an attribute value never closed', '<svg width="1/>'],
  ['attributes with no whitespace between them', '<svg width="1"height="1"/>'],
  ['an attribute without a value', '<svg width/>'],
  ['an attribute name starting with a digit', '<svg 1x="1"/>'],
  ['< inside an attribute value', '<svg><path d="M0 0<g"/></svg>'],
  ['a tag cut off after its name', '<svg><path'],
  ['a self-closing tag cut off', '<svg><path /'],
  ['elements nested 33 deep', `<svg>${'<g>'.repeat(32)}${'</g>'.repeat(32)}</svg>`],
  ['a root in another vocabulary (an XHTML default namespace)', '<svg xmlns="http://www.w3.org/1999/xhtml"><title>text</title></svg>'],
  ['a child moved into another vocabulary', '<svg><g xmlns="http://www.w3.org/1999/xhtml"></g></svg>'],
];

/** Complete static drawings: each accepted as a store's icon, in every carrier. */
const COMPLETE_SVGS: readonly (readonly [string, string])[] = [
  ['an empty root', '<svg/>'],
  ['XML whitespace after the root', '<svg></svg>\n\t \r\n'],
  ['end tags with whitespace before >', '<svg><g ></g\n></svg >'],
  ['single-quoted values and a spaced =', "<svg width = '1' height='2'><path d='M0 0'/></svg>"],
  ['elements nested 32 deep', `<svg>${'<g>'.repeat(31)}${'</g>'.repeat(31)}</svg>`],
  ['the SVG namespace, on a child too', '<svg xmlns="http://www.w3.org/2000/svg"><g xmlns="http://www.w3.org/2000/svg"/></svg>'],
];

describe('an embedded SVG must be one complete drawing, read by a bounded tokenizer (fix round 2, F2)', () => {
  it.each(INCOMPLETE_SVGS)('%s → embedded_markup in every carrier', (_name, svg) => {
    expect(inEveryCarrier(syntheticStore({ icon: svg }))).toEqual(everywhere('embedded_markup'));
  });

  it.each(COMPLETE_SVGS)('%s → accepted in every carrier', (_name, svg) => {
    expect(inEveryCarrier(syntheticStore({ icon: svg }))).toEqual(everywhere('accepted'));
  });
});

// ── Fix round 3 (XR-SH-ACCEPT-C2PA-R2, findings F1 and F2) ─────────────────────────────────────────────────────────
/** A store whose description box has the extended 16-byte header (LBox 1, then an XLBox). */
const xlStore = (...children: readonly Uint8Array[]) => superbox(withXlBox(jumd(c2paUuid('c2pa'), 'c2pa')), ...children);
const xlHarmless = xlStore(manifest(jumbfBox('json', ascii('{}'))));

describe('a description box with a 16-byte (XLBox) header is read as it is (fix round 3, F1)', () => {
  it('a store with that description and a static icon is accepted in every carrier (on fa83a2e4d too), its outer box extended or not', () => {
    expect(inEveryCarrier(xlStore(manifest(iconBox('<svg><path/></svg>'))))).toEqual(everywhere('accepted'));
    expect(inEveryCarrier(withXlBox(xlStore(manifest(iconBox(OPENAI_LIKE_ICON)))))).toEqual(everywhere('accepted'));
    expect(inEveryCarrier(xlHarmless)).toEqual(everywhere('accepted'));
  });

  it('two stores, one with that description, are refused as damaged in PNG, JPEG and WebP, in either order', () => {
    for (const [first, second] of [[harmless, xlHarmless], [xlHarmless, harmless]] as const) {
      expect(outcome(pngWith(caBX(first), caBX(second)))).toBe('malformed');
      expect(outcome(jpegWith([...jpegJumbfSegments(first), ...jpegJumbfSegments(second, { instance: 2 })]))).toBe('malformed');
      expect(outcome(webpWith(webpChunk('C2PA', first), webpChunk('C2PA', second)))).toBe('malformed');
    }
  });

  it.each([0, 1, 7, xlHarmless.length - 1, xlHarmless.length + 1, 0xffffffff])('that store holding only JSON with its LBox set to %i → malformed in every carrier', (length) => {
    expect(inEveryCarrier(withU32(xlHarmless, 0, length))).toEqual(everywhere('malformed'));
  });

  it('JPEG: that store with its last APP11 part missing, its first part moved last, or a first part ending inside its UUID → malformed', () => {
    const parts = jpegJumbfSegments(xlHarmless, { partBytes: 50 });
    expect(outcome(jpegWith(parts.slice(0, -1)))).toBe('malformed');
    expect(outcome(jpegWith([...parts.slice(1), ...parts.slice(0, 1)]))).toBe('malformed');
    // A first part holding the 16-byte description header and 10 bytes of the UUID, and the last part missing.
    expect(outcome(jpegWith(jpegJumbfSegments(xlHarmless, { partBytes: 26 }).slice(0, -1)))).toBe('malformed');
  });

  it('JPEG: another JUMBF box with that kind of description is no store: accepted beside a store, and scanned as before when damaged', () => {
    const other = superbox(withXlBox(jumd(c2paUuid('json'), 'x')), jumbfBox('json', ascii('{}')));
    expect(outcome(jpegWith([...jpegJumbfSegments(syntheticStore()), ...jpegJumbfSegments(other, { instance: 2 })]))).toBe('accepted');
    // Its first part shows the whole description (UUID 'json'); the last part is missing.
    expect(outcome(jpegWith(jpegJumbfSegments(other, { partBytes: 40 }).slice(0, -1)))).toBe('accepted');
  });
});

describe('every element counts toward the depth limit, an empty one too (fix round 3, F2)', () => {
  /** `leaf` under `parents` nested `<g>` elements in the root: the leaf is at level parents + 2. */
  const iconAt = (parents: number, leaf: string) => `<svg>${'<g>'.repeat(parents)}${leaf}${'</g>'.repeat(parents)}</svg>`;

  it.each([
    ['<path/> at level 32', 'accepted', iconAt(30, '<path/>')],
    ['<path></path> at level 32', 'accepted', iconAt(30, '<path></path>')],
    ['<path/> at level 33', 'embedded_markup', iconAt(31, '<path/>')],
    ['<path></path> at level 33', 'embedded_markup', iconAt(31, '<path></path>')],
  ] as const)('%s → %s in every carrier', (_name, result, svg) => {
    expect(inEveryCarrier(syntheticStore({ icon: svg }))).toEqual(everywhere(result));
  });
});

// ── Fix round 4 (XR-SH-ACCEPT-C2PA-R3, finding F1) ─────────────────────────────────────────────────────────────────
describe('a description box is read only inside its own declared length (fix round 4, F1)', () => {
  const harmlessManifest = manifest(jumbfBox('json', ascii('{}')));
  const jpegOf = (s: Uint8Array) => jpegWith(jpegJumbfSegments(s));
  const headers = [
    ['8-byte', (box: Uint8Array): Uint8Array => box],
    ['16-byte (XLBox)', withXlBox],
  ] as const;

  describe.each(headers)('a description with a %s header', (_size, header) => {
    /** A description holding only the first 15 of its UUID's 16 bytes; the next box is a sibling manifest. */
    const cut = header(jumbfBox('jumd', c2paUuid('c2pa').subarray(0, 15)));
    const broken = superbox(cut, harmlessManifest);

    it('controls: whole C2PA and other-UUID descriptions accepted; the cut one alone in JPEG, and in PNG and WebP, malformed', () => {
      expect(outcome(jpegOf(superbox(header(jumd(c2paUuid('c2pa'), 'c2pa')), harmlessManifest)))).toBe('accepted');
      expect(outcome(jpegOf(superbox(header(jumd(c2paUuid('json'), 'x')), jumbfBox('json', ascii('{}')))))).toBe('accepted');
      expect(outcome(jpegOf(superbox(cut)))).toBe('malformed');
      expect(outcome(pngWith(caBX(broken)))).toBe('malformed');
      expect(outcome(webpWith(webpChunk('C2PA', broken)))).toBe('malformed');
    });

    it('JPEG: a UUID cut off by the description end does not read the next box → malformed', () => {
      expect(outcome(jpegOf(broken))).toBe('malformed');
    });

    it('JPEG: that description beside a valid store → malformed', () => {
      expect(outcome(jpegWith([...jpegJumbfSegments(harmless), ...jpegJumbfSegments(broken, { instance: 2 })]))).toBe('malformed');
    });

    it('JPEG: that description with the last APP11 part missing → malformed', () => {
      const parts = jpegJumbfSegments(broken, { partBytes: 50 });
      expect(parts.length).toBeGreaterThan(1);
      expect(outcome(jpegWith(parts.slice(0, -1)))).toBe('malformed');
    });
  });

  // The audit of the other reads in the store walk: each field of a description is read inside the description, so a
  // field cut off by its end is never completed by the next box's bytes (here a sibling manifest, whose first byte is 0).
  const store = (description: Uint8Array) => superbox(description, harmlessManifest);
  const fields = (toggles: number, ...rest: readonly Uint8Array[]) => jumbfBox('jumd', concat(c2paUuid('c2pa'), new Uint8Array([toggles]), ...rest));
  it.each([
    ['a label whose NUL would be the next box first byte', store(fields(0x03, ascii('c2pa')))],
    ['an ID (toggle 0x04) cut off by the description end', store(fields(0x07, ascii('c2pa\0'), new Uint8Array(2)))],
    ['a signature (toggle 0x08) cut off by the description end', store(fields(0x0b, ascii('c2pa\0'), new Uint8Array(20)))],
    ['a private box running past the description end', store(fields(0x13, ascii('c2pa\0'), u32be(24), ascii('c2sh')))],
  ])('a store whose description has %s → malformed in every carrier', (_name, s) => {
    expect(inEveryCarrier(s)).toEqual(everywhere('malformed'));
  });

  it('JPEG: a superbox whose declared length ends inside its description shows no whole description, even one of another UUID → malformed', () => {
    const other = superbox(jumd(c2paUuid('json'), 'x'), jumbfBox('json', ascii('{}')));
    expect(outcome(jpegOf(other))).toBe('accepted');
    expect(outcome(jpegOf(withU32(other, 0, 8 + 20)))).toBe('malformed'); // its description is 27 bytes long
  });

  it('a file description (bfdb) cut before its NUL gives its SVG no exception → embedded_markup in every carrier', () => {
    const icon = iconBox(OPENAI_LIKE_ICON, { boxes: [jumbfBox('bfdb', concat(new Uint8Array([0]), ascii('image/svg+xml'))), jumbfBox('bidb', ascii(OPENAI_LIKE_ICON))] });
    expect(inEveryCarrier(c2paStore(manifest(icon)))).toEqual(everywhere('embedded_markup'));
  });
});
