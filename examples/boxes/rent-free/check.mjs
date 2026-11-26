/**
 * Checks the Rent Free kit. Every file the kit lists is here with its exact pixel size, and the art is byte for byte
 * the image set the founder approved, each picture with the untouched generated original beside it. The 48 px mark is
 * a fresh render. The calm places really are bare cream: the X banner's avatar corner, the strips the site's 4:1 crop
 * cuts off the box banner, the mark's clear space and round crop, and every edge. The palette describes the art, and
 * the contrast numbers are right. assignment.json is exactly what assign.mjs prints. The docs match the registry row
 * and the fee pies' numbers, the storybook matches its pictures, and the words follow the brand rules. No network.
 *
 *   node check.mjs        exit 0 when everything passes, 1 otherwise
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import { assignment, variantFor } from './assign.mjs';
import { loadResvg, logoAt } from './preview.mjs';

const root = new URL('./', import.meta.url);
const at = (rel) => new URL(rel, root);
const text = (rel) => (existsSync(at(rel)) ? readFileSync(at(rel), 'utf8') : '');
/**
 * Files an operating system adds to folders on its own, such as .DS_Store, Thumbs.db, desktop.ini or a desktop's
 * .directory, and the __MACOSX folder of an unzipped archive. Every folder listing in this check skips them, and
 * nothing here deletes them.
 */
const OS_FILE = /^(\.DS_Store|\._.+|\.AppleDouble|__MACOSX|\.localized|\.Spotlight-V100|\.Trashes|\.fseventsd|\.TemporaryItems|\.DocumentRevisions-V100|\.apdisk|Icon\r|Thumbs\.db|ehthumbs(_vista)?\.db|desktop\.ini|\$RECYCLE\.BIN|\.directory|\.Trash-.+)$/i;
/** The names in a folder of the kit, without those files. */
const list = (rel) => readdirSync(at(rel)).filter((n) => !OS_FILE.test(n));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const problems = [];
let passed = 0;
const check = (ok, message) => { if (ok) passed += 1; else problems.push(message); return ok; };

const DOCS = ['README.md', 'brand-book.md', 'storybook.md', 'details.md', 'art-notes.md'];
const RECORD = 'SH-KIT-RENT-FREE.md';
const SCRIPTS = ['assign.mjs', 'assignment.json', 'preview.mjs', 'check.mjs', '.gitattributes'];
const BOX_ID = 'rent-free';
const COUNT = 500;
const two = (n) => String(n).padStart(2, '0');

/** The twelve houses, in variant order. README.md and art-notes.md use the same names. */
const HOUSES = ['Cottage', 'Townhouse', 'Bungalow', 'A-frame', 'Awning', 'Arch roof', 'Clay roof', 'Step gable', 'Lean-to', 'Clay dome', 'Dormer', 'Roof garden'];
/** The storybook uses scenes 01 to 07. Scene 08 stays in art/ as it came and is not part of the story. */
const STORY = [1, 2, 3, 4, 5, 6, 7].map(two);

/**
 * Every file in art/ with its pixel size and SHA-256, except art/logo-48.png, which is checked against a fresh render.
 * The pictures are the approved image set, and each `-original.png` is the untouched generated output it was cut or
 * scaled from (a whole sheet where one sheet gave several pictures). The fee pies come unchanged from the landing.
 */
const SHEET = { houses1: 'c448dcbdc287ab1bb7284f617d49ec6bb6ed194c9986c4a2a73495ccaf0b0540', houses2: 'c154160142e6a7336940e6223edc8744a4bf76ba0b194bae5f965541af27ff83',
  scenes1: 'e2db414a0ea6a82797878799b80844c12cb658cae4b621cf74639042f4bcbdd6', scenes2: '84bbdf6d43f33100321ff50ad4b182a823ad4cb2b6e0dead8aaa3e776f3e7602',
  mark: 'c161e0f8957e16a2f264d239ef8747a9e6b42a3e24de1405f13f4592c4a319b7', wide: '1406b523ee2fd6ea0f8250d736a01c0ce917920f84e326a297dd3a8ccb969024' };
const HOUSE_SHA = ['096bb25f70a5d6f360f0abb4b88f3228984e77b0c930c36f9880fe1c4c42f2ca', 'b549afb99bddcb80aa75ec295e2875cbd1ae3720c55d607a2f2ca808fb64942d',
  '7dd44acfd63338221a8e41b12714752360a30ced2a49c851aeba39c5b15b62a7', 'b8a73cd5d4ac8e555111c6b6be2617f3e53af970de05c66ef226ea5a15dbcc35',
  '3e4a5d83adc7870fdf7a2ae5b0159f3ff9e11deddd92889af5ca87e77b6f3be2', 'b99cae99ef2e53ea5821590cf4d89204de630ec3aea788de39459c942a31f6c1',
  '7c30dc1ea0f7ba56c0da98fc3f29d2bf24e70f3764f656be2723d433011a8cbc', '193917dac5d476bfa63162f5aa69bbadd5d49f00d715a483b9b97096086f8da7',
  '874ccd9df6462a31ef5d080b35aefcc949ccb21e8ae8ce21701c0a5694213b09', 'bbb72d352cb6ddd02cc6eeaef643c1c80d46c18362a9b1906baf04535b39fc88',
  '823f3ca504746cbc35795ae1ec223d7339eaa5eed4cb925bc345f3863c877220', 'e4cda3a6e39bce23b423a7cda05ec5a51e50f39283ff886846adcdf2acfbce91'];
const SCENE_SHA = ['19bc320d18840a87928c7c65c9ae480e3d1ff786c8f5cf4dd7a1c9265907ba92', '3edc9d55e57e33b808ee9d41f85ec496569fe4f153181347b397f93f3ecf579d',
  '7e3cffa7225f098190eb89290653bc20c303c9110ef45758e55b203ef79f1501', 'dd09e0e5520913bb02c83570f7624595ba236d67ceb12221b3352a220897af4c',
  'b5fdacdef006801a167ec079e4dcda983079b9bce901519742b1a1cac5b22ae3', '780baa6841322eee3ee2ec2840427597f9cc0b17608aee7de67abad6db31d943',
  '02367b077d1dcdac97c8adaf2fa55775d4c713a2313799010fe66f738652f89e', '3b1151a7e5935d7063051e6a07bcd712e037fbdfccd9401638da25ca4f7e82a8'];
const FILES = Object.freeze({
  'art/logo.png': [1024, 1024, '724516a4d9e0fce02cf1ffe5f9f698bdc1c236bc323f476d145cc5feba627290'],
  'art/logo-original.png': [1254, 1254, SHEET.mark],
  'art/x-avatar.png': [400, 400, '58a01d76f6be0253b04a4e2be2dcce87b67dff812ca4d31ccf912c39a8521df8'],
  'art/x-avatar-original.png': [1254, 1254, SHEET.mark],
  'art/x-banner.png': [1500, 500, 'a9f5f653e116ebdb9ddff0c73636c6217f0490a569dfd2c4433a81b8c3d2a5f9'],
  'art/x-banner-original.png': [2172, 724, SHEET.wide],
  'art/box-banner.png': [1800, 600, '4682b17d8f12ef449b9fecd7fd7fcff8f2c23816513e49e631bc42121298cf5e'],
  'art/box-banner-original.png': [2172, 724, SHEET.wide],
  'art/cover.png': [1200, 630, '1e2836245d9d12cdc8641dcbe2159496209d9241a3d666cdbd07553a9405abec'],
  'art/cover-original.png': [1733, 907, '8af864b06c6adcef2b2cbea29deadefc10877e81e521919d87e26f27a88b4690'],
  ...Object.fromEntries(HOUSE_SHA.flatMap((sha, i) => [
    [`art/houses/variant-${two(i + 1)}.png`, [512, 512, sha]],
    [`art/houses/variant-${two(i + 1)}-original.png`, [1536, 1024, i < 6 ? SHEET.houses1 : SHEET.houses2]],
  ])),
  ...Object.fromEntries(SCENE_SHA.flatMap((sha, i) => [
    [`art/scenes/scene-${two(i + 1)}.png`, [768, 768, sha]],
    [`art/scenes/scene-${two(i + 1)}-original.png`, [1254, 1254, i < 4 ? SHEET.scenes1 : SHEET.scenes2]],
  ])),
  'art/fees/fees-1080x1080.png': [1080, 1080, '9e31cbbf2b8f0a9d6ce3616f151465cbb172ce9090552453f04eb862e69640cb'],
  'art/fees/fees-1080x1080.svg': [1080, 1080, '1ddc8779a0cb52496905b5dc1272607a42a967b8ab6252ab98a6e0399778cf5b'],
  'art/fees/fees-1600x900.png': [1600, 900, 'b8e488e82bc0622c8f71dc9a45075bc952c72abb6052dade2517f753e08235e9'],
  'art/fees/fees-1600x900.svg': [1600, 900, '3e94a7929b686b02ac92014d6da2824335d289a92904f46f84fc3c2221fda267'],
});
const PREVIEW = 'art/logo-48.png';
/** The pictures a page or a post shows: everything in art/ except the generated originals and the SVG sources. */
const SHOWN = Object.keys(FILES).filter((f) => f.endsWith('.png') && !f.endsWith('-original.png'));

/** Width and height from a PNG's IHDR chunk, or null when the bytes are not a PNG. */
function pngSize(bytes) {
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.subarray(12, 16).toString() !== 'IHDR') return null;
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

/** Width and height on an SVG's root element. */
function svgSize(source) {
  const head = source.match(/<svg\b[^>]*>/)?.[0] ?? '';
  return ['width', 'height'].map((name) => Number(head.match(new RegExp(`\\s${name}="(\\d+)"`))?.[1]));
}

/** Decodes an 8-bit, non-interlaced RGB or RGBA PNG (every picture in this kit) to RGB bytes, alpha dropped. */
function decodePng(bytes) {
  let pos = 8;
  let head = null;
  const data = [];
  while (pos < bytes.length) {
    const length = bytes.readUInt32BE(pos);
    const kind = bytes.subarray(pos + 4, pos + 8).toString('latin1');
    const body = bytes.subarray(pos + 8, pos + 8 + length);
    if (kind === 'IHDR') head = { w: body.readUInt32BE(0), h: body.readUInt32BE(4), depth: body[8], type: body[9], interlace: body[12] };
    if (kind === 'IDAT') data.push(body);
    if (kind === 'IEND') break;
    pos += 12 + length;
  }
  if (!head || head.depth !== 8 || (head.type !== 2 && head.type !== 6) || head.interlace !== 0) throw new Error('not an 8-bit RGB or RGBA PNG');
  const { w, h } = head;
  const ch = head.type === 6 ? 4 : 3;
  const stride = w * ch;
  const raw = inflateSync(Buffer.concat(data));
  const rgb = Buffer.alloc(w * h * 3);
  let prev = Buffer.alloc(stride);
  let line = Buffer.alloc(stride);
  for (let y = 0; y < h; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const a = x >= ch ? line[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      line[x] = (src[x] + [0, a, b, (a + b) >> 1, paeth][filter]) & 255;
    }
    for (let x = 0; x < w; x += 1) line.copy(rgb, (y * w + x) * 3, x * ch, x * ch + 3);
    [prev, line] = [line, prev];
  }
  return { w, h, rgb };
}

const HEX = (hex) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
const far = (rgb, i, color) => Math.max(Math.abs(rgb[i] - color[0]), Math.abs(rgb[i + 1] - color[1]), Math.abs(rgb[i + 2] - color[2]));

/** The most common color of a picture, its ground. */
function groundOf({ w, h, rgb }) {
  const counts = new Map();
  for (let i = 0; i < w * h * 3; i += 3) {
    const key = (rgb[i] << 16) | (rgb[i + 1] << 8) | rgb[i + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const [key] = [...counts.entries()].reduce((best, entry) => (entry[1] > best[1] ? entry : best));
  return [key >> 16, (key >> 8) & 255, key & 255];
}

const decoded = new Map();
const picture = (rel) => {
  if (!decoded.has(rel)) decoded.set(rel, decodePng(readFileSync(at(rel))));
  return decoded.get(rel);
};

function listArt(dir = 'art') {
  if (!existsSync(at(dir))) return [];
  return readdirSync(at(dir), { withFileTypes: true }).filter((e) => !OS_FILE.test(e.name)).flatMap((e) => (e.isDirectory() ? listArt(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
}

function checkFiles() {
  for (const doc of [...DOCS, RECORD]) check(text(doc).trim().length > 200, `missing or empty ${doc}`);
  for (const f of SCRIPTS) check(existsSync(at(f)), `missing ${f}`);
  check(/^art\/\*\* -text$/m.test(text('.gitattributes')) && /^assignment\.json -text$/m.test(text('.gitattributes')), '.gitattributes must mark art/** and assignment.json as -text');
  for (const [rel, [w, h, sha]] of Object.entries(FILES)) {
    if (!check(existsSync(at(rel)), `missing ${rel}`)) continue;
    const bytes = readFileSync(at(rel));
    const size = rel.endsWith('.svg') ? svgSize(bytes.toString('utf8')) : pngSize(bytes);
    check(size && size[0] === w && size[1] === h, `${rel} is ${size ? size.join('x') : 'not a PNG'}, expected ${w}x${h}`);
    check(sha256(bytes) === sha, `${rel} is not the approved picture (its SHA-256 changed); the kit keeps the image set byte for byte`);
  }
  const stray = listArt().filter((f) => !(f in FILES) && f !== PREVIEW);
  check(stray.length === 0, `art/ holds files the kit does not list: ${stray.join(', ')}`);
  for (const f of SHOWN.filter((s) => !s.startsWith('art/fees/'))) check(`${f.replace(/\.png$/, '')}-original.png` in FILES, `${f} has no untouched original listed beside it`);
  for (const f of Object.keys(FILES).filter((s) => s.endsWith('.svg'))) {
    check(!/<image\b|<text\b|<script\b|<foreignObject\b|\bhref=|url\((?!#)|@import/i.test(text(f)), `${f} must hold only shapes, with no fonts, images, scripts or links`);
  }
  for (let n = 1; n <= 12; n += 1) {
    const f = `art/houses/variant-${two(n)}.png`;
    if (existsSync(at(f))) check(statSync(at(f)).size <= 1_048_576, `${f} is over 1 MiB, more than the create page takes for an item picture`);
  }
  const [bw, bh] = FILES['art/box-banner.png'];
  check(bw >= 2 * bh, 'the box banner must be at least 2:1, or the create page refuses it');
}

/** art/logo-48.png is exactly what preview.mjs renders from art/logo.png today. */
function checkPreview(Resvg) {
  if (!check(existsSync(at(PREVIEW)), `missing ${PREVIEW}; run node preview.mjs`)) return;
  const size = pngSize(readFileSync(at(PREVIEW)));
  check(size && size[0] === 48 && size[1] === 48, `${PREVIEW} must be exactly 48x48`);
  if (Resvg) check(Buffer.compare(readFileSync(at(PREVIEW)), logoAt(Resvg, 48)) === 0, `${PREVIEW} is not a fresh render of art/logo.png; run node preview.mjs`);
}

/** How many pixels `inside(x, y)` selects that differ from the picture's ground by more than a soft edge. */
function busy(rel, inside) {
  const pic = picture(rel);
  const ground = groundOf(pic);
  let n = 0;
  for (let y = 0; y < pic.h; y += 1) {
    for (let x = 0; x < pic.w; x += 1) if (inside(x, y, pic.w, pic.h) && far(pic.rgb, (y * pic.w + x) * 3, ground) > 12) n += 1;
  }
  return n;
}

/** The calm places are bare cream, and nothing touches an edge. */
function checkCalm() {
  const cream = HEX('#FFF7E6');
  for (const f of SHOWN) {
    if (!existsSync(at(f))) continue;
    const pic = picture(f);
    const ground = groundOf(pic);
    check(Math.max(...ground.map((v, i) => Math.abs(v - cream[i]))) <= 8, `${f}: the ground is not cream`);
    const edge = busy(f, (x, y, w, h) => x < 4 || y < 4 || x >= w - 4 || y >= h - 4);
    check(edge === 0, `${f}: ${edge} pixels of the drawing touch the outer 4 px, so something is cut off`);
  }
  const corner = busy('art/x-banner.png', (x, y) => x < 420 && y >= 270);
  check(corner === 0, `art/x-banner.png: ${corner} pixels of the drawing sit in the avatar corner (x 0 to 420, y 270 to 500)`);
  const crop = busy('art/box-banner.png', (x, y) => y < 75 || y >= 525);
  check(crop === 0, `art/box-banner.png: ${crop} pixels of the drawing sit in the strips the site's 4:1 crop cuts off (y 0 to 75 and 525 to 600)`);
  for (const [f, margin] of [['art/cover.png', 48], ['art/box-banner.png', 48], ['art/x-banner.png', 60]]) {
    const near = busy(f, (x, y, w, h) => x < margin || y < margin || x >= w - margin || y >= h - margin);
    check(near === 0, `${f}: ${near} pixels of the drawing come within ${margin} px of an edge`);
  }
  for (const f of ['art/logo.png', 'art/x-avatar.png']) {
    const band = busy(f, (x, y, w) => Math.min(x, y, w - 1 - x, w - 1 - y) < (2 * w) / 32);
    check(band === 0, `${f}: ${band} pixels of the mark fall in the 2-module clear space`);
    const round = busy(f, (x, y, w) => (x + 0.5 - w / 2) ** 2 + (y + 0.5 - w / 2) ** 2 > (0.95 * w / 2) ** 2);
    check(round === 0, `${f}: ${round} pixels of the mark fall outside 95% of a round crop`);
  }
}

/** The brand book's palette: the design colors the art was made in, by name. */
const PALETTE = Object.freeze({
  Cream: '#FFF7E6', Forest: '#173D32', 'House green': '#73B98C', 'Roof green': '#3A6D51', Butter: '#F3CA66',
  Clay: '#DA795B', Sky: '#62B8DF', Card: '#EDDEB9', Mist: '#C9D9CB',
});

/** Every palette color is in the brand book and really is in the pictures (at least 2,000 pixels within 24 levels). */
function checkPalette() {
  const book = text('brand-book.md');
  const counts = Object.fromEntries(Object.keys(PALETTE).map((name) => [name, 0]));
  for (const f of SHOWN.filter((s) => existsSync(at(s)))) {
    const { rgb } = picture(f);
    for (const [name, hex] of Object.entries(PALETTE)) {
      const color = HEX(hex);
      for (let i = 0; i < rgb.length; i += 3) if (far(rgb, i, color) <= 24) counts[name] += 1;
    }
  }
  for (const [name, hex] of Object.entries(PALETTE)) {
    check(book.includes(`| ${name} | \`${hex}\` |`), `brand-book.md must list the palette color ${name} as ${hex}`);
    check(counts[name] >= 2000, `${name} ${hex} is in only ${counts[name]} pixels of the art; the palette must describe the pictures`);
  }
}

/** WCAG 2.2 contrast ratio of two #RRGGBB colors. */
function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = HEX(hex).map((v) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The brand book's contrast table, as [text color, ground color, the least ratio it is used at]. */
const PAIRS = [
  ['Forest', 'Cream', 4.5], ['Cream', 'Forest', 4.5], ['Forest', 'Card', 4.5], ['Forest', 'Mist', 4.5], ['Forest', 'Butter', 4.5],
  ['Cream', 'Roof green', 4.5], ['Forest', 'Sky', 4.5], ['Forest', 'House green', 4.5], ['Forest', 'Clay', 3],
];

function checkContrast() {
  const book = text('brand-book.md');
  for (const [fg, bg, min] of PAIRS) {
    const ratio = contrast(PALETTE[fg], PALETTE[bg]);
    const shown = `${(Math.floor(ratio * 100) / 100).toFixed(2)}:1`;
    check(book.includes(`| ${fg} on ${bg.toLowerCase()} | ${shown} |`), `brand-book.md must give ${fg} on ${bg.toLowerCase()} as ${shown}`);
    check(ratio >= min, `${fg} on ${bg} is ${shown}, below the ${min}:1 the brand book uses it for`);
  }
}

async function checkAssignment() {
  // assignment() consumes buildUniqueSet: every freshly generated PNG, GLB and SVG is hash-checked there.
  const a = await assignment();
  const manifest = JSON.parse(text('unique/manifest.json'));
  check(text('assignment.json') === `${JSON.stringify(a, null, 2)}\n`, 'assignment.json differs from `node assign.mjs` output');
  check(a.count === String(COUNT) && a.modelPolicy === '3d', 'the assignment must cover 500 houses, each with a 3D model');
  check(a.seed === manifest.seed, 'the assignment must preserve the reviewed seed');
  check(isDeepStrictEqual(a.columns, ['house', 'door', 'window', 'post', 'plant', 'step']), 'all six trait columns must be present');
  check(a.items.length === COUNT && a.items.every((it, i) => it.id === String(i + 1)), `the assignment must list ids 1 to ${COUNT} in order`);
  for (const [index, item] of a.items.entries()) {
    const reviewed = manifest.entries[index];
    check(item.id === reviewed.id && isDeepStrictEqual(item.traits, reviewed.traits), `house ${item.id} traits differ from the reviewed manifest`);
    for (const kind of ['picture', 'model']) {
      check(isDeepStrictEqual(item[kind], { path: reviewed[kind].file, sha256: `0x${reviewed[kind].sha256}`, bytes: reviewed[kind].bytes }),
        `house ${item.id} ${kind} differs from the reviewed manifest`);
    }
    check(item.traits.house === variantFor(item.id), `house ${item.id} changed base family`);
  }
  for (const kind of ['picture', 'model']) check(new Set(a.items.map(item => item[kind]?.sha256)).size === COUNT, `all 500 ${kind} hashes must be distinct`);
  const counts = HOUSES.map((_, i) => a.items.filter(it => it.traits.house === two(i + 1)).length);
  check(counts.join() === '42,42,42,42,42,42,42,42,41,41,41,41', `families 01 to 08 appear 42 times and 09 to 12 appear 41 times, not ${counts.join()}`);
  check(variantFor('1') === '01' && variantFor('12') === '12' && variantFor('13') === '01' && variantFor('500') === '08', 'houses 1 and 13 use family 01, 12 uses 12 and 500 uses 08');
  for (const bad of ['0', '501', '01', '-1', '1.0', '', ' 1', '1e2', 4, 4n, null]) {
    let refused = false;
    try { variantFor(bad); } catch (error) { refused = /token id/.test(error.message); }
    check(refused, `variantFor must refuse ${typeof bad === 'bigint' ? `${bad}n` : JSON.stringify(bad)}`);
  }
}

/** The docs say what the registry row says. Skipped when the kit is copied out of the repository. */
function checkRegistry() {
  const row = at(`../../../packages/box-spec/examples/v2/${BOX_ID}.json`);
  if (!existsSync(row)) {
    check(!existsSync(at('../../../packages/box-spec')), `registry: ${BOX_ID}.json is missing from the example registry`);
    return null;
  }
  const box = JSON.parse(readFileSync(row, 'utf8'));
  const expected = box.name === 'Rent Free' && box.ticker === 'RENT' && box.status === 'ready' && box.priceCoin.symbol === 'USDC'
    && box.contents.kind === 'collection' && box.contents.size === String(COUNT) && box.contents.art.mode === 'open'
    && box.fees.buyers.choice === 'items' && box.fees.buyers.inside === 'burn' && box.fees.sellers.choice === 'burn';
  check(expected, 'registry: Rent Free is expected to be ready, in USDC, with 500 open-art houses, buyers to items with inside burn and sellers Burn; review the kit');
  const details = text('details.md');
  const facts = [box.name, box.ticker, box.status, box.template.id, box.template.name, box.priceCoin.symbol, box.priceCoin.decimals, box.contents.kind,
    box.contents.size, box.contents.label, box.contents.art.mode, box.contents.pickFeeBps, box.raise.policy, box.deadline.days, box.royalties.bps,
    box.royalties.destination, box.fees.buyers.choice, box.fees.buyers.inside, box.fees.sellers.choice, box.life, ...box.properties];
  for (const fact of facts) check(details.includes(`\`${fact}\``), `details.md must show the registry value \`${fact}\``);
  const book = text('brand-book.md');
  check(book.includes(`**Name:** ${box.name}.`) && book.includes(`**Ticker:** ${box.ticker}.`), `brand-book.md must name ${box.name} and ${box.ticker}`);
  return box;
}

/** A share of a fee in fifteenths, in the coin's smallest units, written with three decimals as the fee pies do. */
function fifteenths(feeUnits, parts, decimals) {
  const raw = (feeUnits / 15n) * parts;
  const scale = 10n ** BigInt(decimals - 3);
  const thousandths = (raw + scale / 2n) / scale;
  return `${thousandths / 1000n}.${String(thousandths % 1000n).padStart(3, '0')}`;
}

/** details.md shows the fee pies and uses their numbers: on 100 USDC the fee is 1 USDC, split 10, 2 and 3 of 15. */
function checkFees(box) {
  const decimals = Number(box?.priceCoin.decimals ?? '6');
  const fee = (100n * 10n ** BigInt(decimals)) / 100n;
  const [choice, pool, squareHole] = [10n, 2n, 3n].map((parts) => fifteenths(fee, parts, decimals));
  check(`${choice}|${pool}|${squareHole}` === '0.667|0.133|0.200', `the split of a 1 USDC fee must read 0.667, 0.133 and 0.200, not ${choice}, ${pool} and ${squareHole}`);
  const details = text('details.md');
  const block = details.split('<!-- fee-example:start -->')[1]?.split('<!-- fee-example:end -->')[0] ?? '';
  const lines = [
    '| The fee, 1% | 1 USDC | 1 USDC |',
    `| 10 parts, the box's choice | ${choice} USDC to the houses | ${choice} USDC buys RENT and burns it |`,
    `| 2 parts, the box's own pool | ${pool} USDC | ${pool} USDC |`,
    `| 3 parts, Square Hole (its platform and its buy-back) | ${squareHole} USDC | ${squareHole} USDC |`,
  ];
  check(block.includes('| On a trade of 100 USDC | A buy | A sale |'), 'details.md must open its fee example with a trade of 100 USDC, as the fee pies do');
  for (const line of lines) check(block.includes(line), `details.md's fee example must say: ${line}`);
  for (const f of ['art/fees/fees-1600x900.png', 'art/fees/fees-1080x1080.png']) check(details.includes(`](${f})`), `details.md must show or link ${f}`);
}

/** Storybook: seven scenes, 01 to 07 in order, one picture each with alt text, and at most two sentences under it. */
function checkStorybook() {
  const md = text('storybook.md');
  const sections = md.split(/^## /m).slice(1);
  check(sections.length === STORY.length, `storybook.md has ${sections.length} scenes; the story uses ${STORY.length}`);
  check(!md.includes('scene-08'), 'scene 08 is not part of the story (see README.md)');
  sections.forEach((s, i) => {
    const n = STORY[i];
    const [heading, ...rest] = s.split('\n');
    check(heading.startsWith(`${n} · `), `storybook scene ${i + 1} must be headed "${n} · ..."`);
    const images = [...s.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)];
    check(images.length === 1 && images[0][2] === `art/scenes/scene-${n}.png`, `storybook scene ${n} must show art/scenes/scene-${n}.png and nothing else`);
    check(images.length === 1 && images[0][1].length >= 60, `storybook scene ${n} needs alt text that describes the picture`);
    const body = rest.filter((l) => l.trim() && !l.startsWith('![')).join(' ');
    const sentences = body.split(/(?<=[.!?]["”]?)\s+/).filter((x) => x.trim());
    check(sentences.length >= 1 && sentences.length <= 2, `storybook scene ${n} has ${sentences.length} sentences, one or two`);
  });
  for (const n of STORY) check(md.split(`art/scenes/scene-${n}.png`).length === 2, `storybook.md must show art/scenes/scene-${n}.png exactly once`);
}

const AVOID_START = '<!-- avoid-list:start -->';
const AVOID_END = '<!-- avoid-list:end -->';
const BANNED = [
  /\bearn(s|ed|ing|ings)?\b/i, /\byields?\b/i, /\breturns?\b/i, /\bgains?\b/i, /\bmoon(ing)?\b/i, /\b100x\b/i,
  /\binvest(ment|ments|or|ors|ing)?\b/i, /\bincome\b/i, /\bprofit(s|able)?\b/i, /\bpassive\b/i, /\bAPY\b/, /\bAPR\b/, /\bROI\b/,
  /\bguarantee(d|s)?\b/i, /\bunlock(s|ed|ing)?\b/i, /\bseamless(ly)?\b/i, /\brevolutionary\b/i, /\bjourney\b/i,
  /\bpump(s|ed|ing)?\b/i, /\bfloor price\b/i, /\bprice (floor|support|rise)\b/i, /\bget in early\b/i, /\bnumber go up\b/i,
  /\bdividends?\b/i, /\brewards?\b/i, /\bprizes?\b/i, /\bjackpot\b/i, /\bwealth\b/i, /\bupside\b/i, /\bflywheel\b/i,
  /\bappreciat\w*/i, /\baccru\w*/i, /\bscarc\w*/i, /\bdeflation\w*/i, /\bhodl\b/i, /\bbullish\b/i,
  /\brare\b/i, /\brarity\b/i, /\bgrails?\b/i, /\bvaluable\b/i, /\bworth\b/i, /\blottery\b/i, /\bgambl\w*/i,
  // Houses are pictures, and "rent" is a joke: no property, tenancy or pay words.
  /\breal estate\b/i, /\brealty\b/i, /\bmortgages?\b/i, /\blandlords?\b/i, /\btenan(t|ts|cy)\b/i, /\bleas(e|es|ed|ing)\b/i, /\brentals?\b/i,
  /\bcash ?flow\b/i, /\bpayday\b/i, /\bpaychecks?\b/i, /\bsalar(y|ies)\b/i, /\binterest\b/i, /\bequity\b/i, /\bportfolio\b/i, /\bdeeds?\b/i,
  /\bpays? (you|its owner|the owner|owners)\b/i, /\bget(s|ting)? paid\b/i, /\bmakes? money\b/i, /\bfree money\b/i,
  // Square Hole's own token and collection, the pun the brief rules out, and the word the founder took out of the UI (F130).
  /\bfit(s|ted|ting)?\b/i, /\bmisfits?\b/i, /\bdemo\b/i,
];
const SHAPES = [
  [/—/, 'an em dash'], [/\s–\s/, 'a dash used as a pause'], [/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'an emoji or dingbat'],
  [/0x[0-9a-fA-F]{6,}/, 'an address'], [/\b(19|20)\d\d\b/, 'a year or date'], [/\$\s?\d/, 'a dollar amount'],
  [/\bnot\b[^.;]*,\s*but\b/i, 'a "not X, but Y" turn'],
];
const AMOUNT = /\b\d[\d,]*(\.\d+)?\s?(USDC|ETH|USD|RENT)\b/;
/**
 * Names the kit never writes: other tokens that use the ticker, a property board game, and property and travel
 * brands. Kept as the first 16 hex digits of each lowercase word's SHA-256, so this file never spells them either.
 */
const NEVER = new Set(['cb3b5639a043f55b', '3d36ad92fc4427e1', 'ab7d0a36ecbe10c2', '5a08fbb37039e825', '0f184726684b9899', '12d4e6fc471fbe07',
  '4401c6ea53ee02b3', '55923d05a0271f81', '5b81d52d431080c4']);
const fingerprint = (s) => sha256(s).slice(0, 16);

/** The joke words are quoted every time: "rent" and "property tax". RENT is the token and Rent Free the name. */
function unquotedJoke(line) {
  const rest = line.replace(/Rent Free/g, '').replace(/\bRENT\b/g, '').replace(/["“]rent["”]/gi, '').replace(/["“]property tax["”]/gi, '');
  return /\brent\w*/i.test(rest) || /\bpropert(y|ies)\b/i.test(rest);
}

/**
 * The prose of a doc as paragraphs, each with its first line number and whether it sits in the fee example. Lines are
 * joined, so a phrase broken across two lines is still read whole. The avoid list, code blocks, code spans and link
 * targets are left out: they are not prose.
 */
function paragraphs(raw) {
  const out = [];
  let state = { avoid: false, fenced: false, example: false };
  let current = null;
  const close = () => { if (current) out.push(current); current = null; };
  raw.split('\n').forEach((line, i) => {
    const marker = line.includes(AVOID_START) || line.includes(AVOID_END) || line.includes('<!-- fee-example:');
    if (line.includes(AVOID_START)) state = { ...state, avoid: true };
    if (line.includes(AVOID_END)) state = { ...state, avoid: false };
    if (line.includes('<!-- fee-example:start -->')) state = { ...state, example: true };
    if (line.includes('<!-- fee-example:end -->')) state = { ...state, example: false };
    if (line.startsWith('```')) state = { ...state, fenced: !state.fenced };
    if (marker || line.startsWith('```') || state.avoid || state.fenced || !line.trim()) return close();
    // A heading, a table row and a list item each start a paragraph of their own; an indented line continues one.
    if (/^(#|\||[-*] |\d+\. )/.test(line)) close();
    const clean = line.replace(/\]\([^)]*\)/g, ']').replace(/`[^`]*`/g, '');
    if (!current) current = { line: i + 1, text: clean, example: state.example };
    else current = { ...current, text: `${current.text} ${clean}` };
  });
  close();
  return out;
}

/** The rules apply to every doc in the kit, and the names the kit never writes to its scripts too. */
function checkWords() {
  for (const f of [...DOCS, RECORD, ...SCRIPTS.filter((s) => s.endsWith('.mjs'))]) {
    const hits = (text(f).toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => NEVER.has(fingerprint(w)));
    check(hits.length === 0, `${f} names something the kit never names (${hits.length} hit${hits.length === 1 ? '' : 's'})`);
  }
  for (const name of [...DOCS, RECORD]) {
    const issues = [];
    for (const p of paragraphs(text(name))) {
      const where = `${name}:${p.line}`;
      const quote = p.text.trim().slice(0, 90);
      for (const re of BANNED) if (re.test(p.text)) issues.push(`${where} uses a word the kit avoids (${re.source}): ${quote}`);
      for (const [re, what] of SHAPES) if (re.test(p.text)) issues.push(`${where} contains ${what}: ${quote}`);
      if (!p.example && AMOUNT.test(p.text)) issues.push(`${where} contains a coin amount outside the fee example: ${quote}`);
      if (unquotedJoke(p.text)) issues.push(`${where} uses rent or property without quotes; the joke words are always "rent" and "property tax": ${quote}`);
    }
    if (issues.length) problems.push(...issues);
    else passed += 1;
  }
}

/** Every local Markdown link resolves. Links into the repository are checked when the repository is present. */
function checkLinks() {
  const inRepo = existsSync(at('../../../packages/box-spec'));
  for (const doc of [...DOCS, RECORD]) {
    for (const [, target] of text(doc).matchAll(/\]\(([^)\s#]+)(#[^)]*)?\)/g)) {
      if (/^[a-z]+:/i.test(target) || (target.startsWith('../') && !inRepo)) continue;
      check(existsSync(at(target)), `${doc} links to ${target}, which does not exist`);
    }
  }
}

/** README lists every file and folder at the top of the kit, every art piece and the twelve houses by name. */
function checkReadme() {
  const readme = text('README.md');
  const notes = text('art-notes.md');
  for (const name of list('./').filter((n) => !n.startsWith('.') || n === '.gitattributes')) check(readme.includes(name), `README.md does not list ${name}`);
  for (const f of [...SHOWN.filter((s) => !/variant-|scene-/.test(s)), PREVIEW]) check(readme.includes(f), `README.md does not list ${f}`);
  check(readme.includes('variant-12') && readme.includes('scene-08') && readme.includes('-original.png'), 'README.md must name the last house, the last scene and the originals');
  HOUSES.forEach((house, i) => {
    check(readme.includes(`| ${two(i + 1)} | ${house} |`), `README.md must name house ${two(i + 1)} ${house} in its table`);
    check(notes.includes(`| ${two(i + 1)} | ${house} |`), `art-notes.md must describe house ${two(i + 1)} ${house} in its table`);
  });
}

let Resvg = null;
try { Resvg = await loadResvg(); } catch { problems.push('cannot load @resvg/resvg-js, so art/logo-48.png could not be compared with a fresh render'); }

checkFiles();
checkPreview(Resvg);
checkCalm();
checkPalette();
checkContrast();
await checkAssignment();
const box = checkRegistry();
checkFees(box);
checkStorybook();
checkWords();
checkLinks();
checkReadme();

if (problems.length) {
  process.stderr.write(`${problems.map((p) => `FAIL ${p}`).join('\n')}\n${problems.length} problem(s), ${passed} checks passed\n`);
  process.exit(1);
}
process.stdout.write(`ok: ${passed} checks passed (${Object.keys(FILES).length + 1} art files, ${STORY.length} story scenes, ${COUNT} houses)\n`);
