/** SH-SNIFF-HANDLERS / ART-01 / UI-10: active markup in metadata, without decoding image data. */
import { describe, expect, it } from 'vitest';
import { inspectImage } from './sniff';
import { c2paStore, c2paUuid, iconBox, jpegJumbfSegments, jumbfBox, jumd, manifest, OPENAI_LIKE_ICON, superbox, syntheticStore } from './test-support/c2pa';
import { ascii, concat, jpegSegment, makeJpeg, makePng, makeWebp, pngChunk, webpChunk } from './test-support/images';

const size = { width: 512, height: 512 };
const padding = new Uint8Array(80).fill(0x2e);
type Carrier = readonly [string, (payload: Uint8Array) => Uint8Array];
// Keep payloads beyond the independent first-64-byte scan: every carrier must do its own work.
const carriers: readonly Carrier[] = [
  ...['tEXt', 'iTXt', 'zTXt', 'prVt'].map((type): Carrier => [`PNG ${type}`, (payload) => makePng({ ...size, before: [pngChunk('paDd', padding), pngChunk(type, payload)] })]),
  ...[0xfe, ...Array.from({ length: 16 }, (_, i) => 0xe0 + i)].map((marker): Carrier => [`JPEG ${marker.toString(16)}`, (payload) => makeJpeg({ ...size, segments: [jpegSegment(0xfe, padding), jpegSegment(marker, payload)] })]),
  ...['XMP ', 'EXIF', 'prvt'].map((type): Carrier => [`WebP ${type}`, (payload) => makeWebp({ ...size, extra: [webpChunk('PAD ', padding), webpChunk(type, payload)] })]),
];
const storeCarriers: readonly Carrier[] = [
  ['PNG caBX', (store) => makePng({ ...size, before: [pngChunk('caBX', store)] })],
  ['JPEG APP11', (store) => makeJpeg({ ...size, segments: jpegJumbfSegments(store, { partBytes: 50 }) })],
  ['WebP C2PA', (store) => makeWebp({ ...size, extra: [webpChunk('C2PA', store)] })],
];
const outcome = (bytes: Uint8Array): string => {
  const result = inspectImage(bytes);
  return result.ok ? 'accepted' : result.code;
};

// iframe already fails on the base; it is a legacy control below, not a new refusal.
const elements = ['img', 'image', 'a', 'form', 'input', 'button', 'link', 'style', 'base', 'video', 'audio', 'source', 'track', 'frame', 'frameset', 'details', 'marquee', 'math', 'template', 'textarea', 'select', 'option', 'applet', 'bgsound', 'portal', 'use', 'animate', 'animatemotion', 'animatetransform', 'set', 'foreignobject', 'feimage'];
const newRefusals: readonly string[] = [
  ...elements.flatMap((name) => [`<${name}>`, `<${name.toUpperCase()}\t\r\n\f data-x = 'value' />`]),
  '<img src=x onerror=alert(1)>',
  '<a href="java&#115;cript:alert(1)">',
  ...[' ', '\t', '\n', '\r', '\f', '/', ' \t\r\n\f'].flatMap((space) => [
    `<div${space}onerror=alert(1)>`,
    `<custom-tag${space}OnCuStOm \t\r\n\f = \t 'run()'>`,
  ]),
  '<div title="text"onload="run()">',
  "<div title='text'onclick='run()'>",
  '<rdf:Description onload = "run()"/>',
  '<p data-note="a > b" OnX = run()>',
  '<p onabcdefghijklmnopqrstuvwxyz = run()>',
  '<p onabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz = run()>',
  '<p once="text"/>',
  '<p onion="text"/>',
  '<p style="background:url(https://example.invalid/image)">',
  "<p STYLE \t\r\n\f = 'width:EXPRESSION(run())'>",
  '<p/style=background:UrL(x)>',
  '<p data-note="a > b" style = "color:red; width:expression(run())">',
  // Fix round af1 / F1: '<' must not hide later attributes in the same start tag.
  '<div < onmouseover=run()>',
  '<div x=<3 onmouseover=run()>',
  '<div < style="background:url(x)">',
  '<div x=<3 style="background:url(x)">',
  '<DIV data<3note\tOnMouseOver \f= run()>',
  '<DIV x=1<3\tOnMouseOver \f= run()>',
  "<DIV data<3note\tSTYLE \f= 'width:EXPRESSION(run())'>",
  "<DIV x=1<3\tSTYLE \f= 'width:EXPRESSION(run())'>",
  // Fix round af2 / F1: keep the whole candidate span, including '<' bytes in its name.
  ...['div<', 'div<3'].flatMap((name) => [
    `<${name} onmouseover=run()>`,
    `<${name} style="background:url(x)">`,
    `<${name.toUpperCase()}\tOnMouseOver \f= run()>`,
    `<${name.toUpperCase()}\tSTYLE \f= 'width:EXPRESSION(run())'>`,
    `<${name}/style=background:UrL(x)>`,
    `<${name} onmouseover=run() style="background:url(x)">`,
    `<${name} onmouseover=`,
    `<${name} style="background:url(x)`,
  ]),
  // Conservative span matching also covers quoted text and each nested candidate independently.
  '<annotation data-onload="onerror=run()" rdf:about="url(x)"/>',
  '<p title="onerror=run()" data-style="url(x)" style="color:red"/>',
  '<div<onmouseover=run()>',
  '<div<style="url(x)">',
  '<div<3"OnMouseOver = run()>',
  "<div<3'STYLE = 'expression(run())'>",
  '<div title="<p onmouseover=run()>">',
  "<div title='<p style=expression(run())>'>",
  '<div title="<img>">',
  '<div title="<p\' > onmouseover=run()>',
  '<div title="<p\' > style=url(x)>',
  '<div title="<p\' >\' > onmouseover=run()>',
  '<div title="<p\' >\' > style=url(x)>',
  '<onmouseover=run()>',
  '<img<3>',
  '<img',
];
// These later/overlapping candidates were already refused on the af2 base; retain them as controls.
const existingSpanRefusals = [
  '<div title="<p>" onmouseover=run()>',
  '<div title="<p>" style="url(x)">',
  '<div<3>plain <p onmouseover=run()>',
  '<div<3>plain <p style="url(x)">',
];
// Fix round af1 / F2: cover the entire legacy pattern set in joined JPEG metadata.
// iframe already passes every split on the fix-round base, so it remains a separate control.
const legacySplitRefusals = [
  '<script>alert(1)</script>',
  '<object data="https://example.invalid/a"></object>',
  '<embed src="https://example.invalid/a">',
  '<html>', '<body>', '<head>', '<svg>', '<!doctype html>', '<?php echo 1;?>', '<meta>',
  'javascript:run()', 'vbscript:run()', 'data:text/html,active',
].flatMap((text) => [text, text.toUpperCase()]);
const controls = [
  '<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description rdf:about="" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>',
  `${elements.join(' ')} iframe onerror=alert(1) style=url(x) expression(x)`,
  '<p data-once="text" data-onion="text" on="text" onload-extra="text" onload2="text"/>',
  '<annotation data-onload="plain" rdf:about="url(x)"/>',
  '<p title="x-onerror=run()" data-style="url(x)" style="color:red"/>',
  '<imageName/><image:Description/><a-b/><inputData/><styleSheet/>',
  '<p title="a > b" style="color:blue"/>',
  '<p title="a < b" style="color:blue"/>',
  "<p title='a < b' style='color:blue'/>",
  '<rdf:Description rdf:about="&lt;3" note="a &lt; b"/>',
  // HTML retains '<' in attribute names and unquoted values; it alone is not active content.
  '<div <>',
  '<div data<note=plain>',
  '<div x=<3>',
  '<div x=1<3>',
  '<div< style="color:red">',
  '<div<3 data-note="url(x)">',
  '<div<3> onmouseover=run() style="url(x)"',
  '<p title="style=plain >"/> url(x)',
  '<p title=\'style="plain>\'>url(x)"',
  '<p style="plain">url(x)',
  '<p style=plain url(x)>',
  '<p style=plain>url(x)',
  '<p style=plain/style=plain>url(x)',
  '<p data-style="url(x)" onload2=run()>',
  '"<p> onmouseover=run() style="url(x)"',
  '<p title="<div>"/> onmouseover=run()',
  '<p title="<div>"/> style=url(x)',
  '</img></image></a> &lt;img src=x onerror=run()&gt; <3',
];

describe.each(carriers)('%s metadata', (_name, carry) => {
  it.each(newRefusals)('new refusal: %s', (text) => {
    expect(outcome(carry(ascii(text)))).toBe('embedded_markup');
  });
  it.each(controls)('accepts control: %s', (text) => {
    expect(outcome(carry(ascii(text)))).toBe('accepted');
  });
  it('keeps the existing iframe refusal', () => {
    expect(outcome(carry(ascii('<IFRAME src=x>')))).toBe('embedded_markup');
  });
  it.each(existingSpanRefusals)('keeps the existing span refusal: %s', (text) => {
    expect(outcome(carry(ascii(text)))).toBe('embedded_markup');
  });
});

describe('JPEG metadata across two APP segments', () => {
  it.each([...newRefusals, ...existingSpanRefusals, ...legacySplitRefusals, '<IFRAME src=x>'])('refuses at every split: %s', (text) => {
    for (let split = 1; split < text.length; split += 1) {
      const bytes = makeJpeg({ ...size, segments: [
        jpegSegment(0xfe, padding),
        jpegSegment(0xe1, ascii(text.slice(0, split))),
        jpegSegment(0xe2, ascii(text.slice(split))),
      ] });
      expect(outcome(bytes), `split ${split}`).toBe('embedded_markup');
    }
  });
  it.each(controls)('checks split control including truncated active names: %s', (text) => {
    for (let split = 1; split < text.length; split += 1) {
      const left = text.slice(0, split);
      // Each segment is also a region: '<a' at its end is active even if the joined name is 'annotation' or 'a-b'.
      const truncatedActiveName = /<(?:a|image|input|style)$/.test(left);
      expect(outcome(makeJpeg({ ...size, segments: [jpegSegment(0xfe, padding), jpegSegment(0xe1, ascii(left)), jpegSegment(0xe2, ascii(text.slice(split)))] })), `split ${split}`).toBe(truncatedActiveName ? 'embedded_markup' : 'accepted');
    }
  });
  it.each(newRefusals)('new refusal in rebuilt non-C2PA JUMBF: %s', (text) => {
    const box = jumbfBox('json', ascii(text));
    expect(outcome(makeJpeg({ ...size, segments: jpegJumbfSegments(box, { partBytes: 3 }) }))).toBe('embedded_markup');
  });
});

describe.each(storeCarriers)('%s store outside its static icon', (_name, carry) => {
  it.each(newRefusals)('new refusal beside an icon: %s', (text) => {
    // End the store at the payload, so unfinished names are tested at a scan boundary too.
    const store = c2paStore(superbox(jumd(c2paUuid('c2ma'), 'manifest'), iconBox(OPENAI_LIKE_ICON), jumbfBox('json', ascii(text))));
    const bytes = carry(store);
    const before = bytes.slice();
    expect(outcome(bytes)).toBe('embedded_markup');
    expect(bytes).toEqual(before);
  });
  it.each(existingSpanRefusals)('keeps the existing span refusal beside an icon: %s', (text) => {
    expect(outcome(carry(c2paStore(manifest(iconBox(OPENAI_LIKE_ICON), jumbfBox('json', ascii(text))))))).toBe('embedded_markup');
  });
  it('accepts its static icon unchanged', () => {
    const bytes = carry(syntheticStore());
    const before = bytes.slice();
    expect(outcome(bytes)).toBe('accepted');
    expect(bytes).toEqual(before);
  });
  it('new refusal before the static icon', () => {
    const store = c2paStore(manifest(jumbfBox('json', ascii('<p onload=run()>')), iconBox(OPENAI_LIKE_ICON)));
    expect(outcome(carry(store))).toBe('embedded_markup');
  });
  it('new refusal in a store without an icon', () => {
    expect(outcome(carry(c2paStore(manifest(jumbfBox('json', ascii('<p style="url(x)">'))))))).toBe('embedded_markup');
  });
  it.each(controls)('accepts metadata control beside an icon: %s', (text) => {
    const store = c2paStore(manifest(iconBox(OPENAI_LIKE_ICON), jumbfBox('json', ascii(text))));
    expect(outcome(carry(store))).toBe('accepted');
  });
});

describe('scan boundaries and image payloads', () => {
  it.each(['<img>', '<p onx=run()>', '<p style="url(x)">'])('new refusal in the first 64 bytes: %s', (text) => {
    expect(outcome(makePng({ ...size, before: [pngChunk('IDAT', ascii(text))] }))).toBe('embedded_markup');
  });
  it.each([['<imageD', 'ata/>'], ['<p onload', '=run()>'], ['<p style="ur', 'l(x)">']])('keeps PNG and WebP chunk bounds: %s | %s', (left, right) => {
    expect(outcome(makePng({ ...size, before: [pngChunk('paDd', padding), pngChunk('tEXt', ascii(left)), pngChunk('tEXt', ascii(right))] }))).toBe('accepted');
    expect(outcome(makeWebp({ ...size, extra: [webpChunk('PAD ', padding), webpChunk('XMP ', ascii(left)), webpChunk('EXIF', ascii(right))] }))).toBe('accepted');
  });
  it('accepts active-looking bytes in PNG IDAT beyond the first 64 bytes', () => {
    expect(outcome(makePng({ ...size, before: [pngChunk('paDd', padding)], after: [pngChunk('IDAT', ascii('<img onerror=run()>'))] }))).toBe('accepted');
  });
  it('accepts active-looking bytes in a JPEG entropy scan', () => {
    const bytes = makeJpeg(size);
    expect(outcome(concat(bytes.subarray(0, bytes.length - 2), padding, ascii('<img onerror=run()>'), bytes.subarray(-2)))).toBe('accepted');
  });
  it('accepts active-looking bytes in WebP ALPH beyond the first 64 bytes', () => {
    expect(outcome(makeWebp({ ...size, extra: [webpChunk('PAD ', padding), webpChunk('ALPH', ascii('<img onerror=run()>'))] }))).toBe('accepted');
  });
  it('accepts active-looking bytes in a WebP bitstream beyond the first 64 bytes', () => {
    const original = makeWebp(size);
    const bytes = concat(original, padding, ascii('<img onerror=run()>'));
    const view = new DataView(bytes.buffer);
    view.setUint32(4, bytes.length - 8, true);
    view.setUint32(16, bytes.length - 20, true);
    expect(outcome(bytes)).toBe('accepted');
  });
});
