/**
 * Checks the Link Marines version 2 kit: every required file is here with its exact pixel size, every PNG has its SVG
 * source and is a fresh render of it, assignment.json is exactly what assign.mjs prints, the mark keeps its clear space
 * and fits a round crop, the X banner keeps its avatar corner bare, words stay clear of the edges, the colour fence
 * holds (blue only as cloth, nothing near the price coin project's blues or another LINK-paired token's colors), the
 * kit has one flannel shirt and one quiet seven, the brand book's contrast numbers are right, the storybook matches the
 * scenes, the docs match the registry row, and the kit's words follow the brand rules. No network.
 *
 *   node check.mjs        exit 0 when everything passes, 1 otherwise
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assignment } from './assign.mjs';
import { variantFor, squadFor, VARIANT_NAMES, rankLibrary } from './ranks.mjs';
import { pieces, builders } from './build-art.mjs';
import { SCENES } from './src/scenes.mjs';
import { logoSvg, avatarSvg, markBareSvg, xBannerSvg, xBannerBareSvg, AVATAR_CORNER, MARK_GRID, MARK_CLEAR, COVER_LINE, BANNER_CANDLES } from './src/brand.mjs';
import { loadResvg, toPng } from './src/render.mjs';
import { DRAWN, lettering } from './src/type.mjs';
import { C, MIX, CLOTH } from './src/palette.mjs';
import { WALLS } from './src/poster.mjs';
import { CANDLES } from './src/props.mjs';
import { Doc } from './src/doc.mjs';

const root = new URL('./', import.meta.url);
const at = (rel) => new URL(rel, root);
const text = (rel) => (existsSync(at(rel)) ? readFileSync(at(rel), 'utf8') : '');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const problems = [];
let passed = 0;
const check = (ok, message) => { if (ok) passed += 1; else problems.push(message); return ok; };

const DOCS = ['README.md', 'brand-book.md', 'storybook.md', 'details.md', 'art-notes.md'];
const RECORD = 'SH-KIT-LINK-MARINES-V2.md';
const SCRIPTS = ['ranks.mjs', 'assign.test.mjs', 'assign.mjs', 'assignment.json', 'build-art.mjs', 'check.mjs', '.gitattributes'];
const FIXED = [
  ['art/logo', 1024, 1024], ['art/x-avatar', 400, 400], ['art/x-banner', 1500, 500],
  ['art/cover', 1200, 630], ['art/box-banner', 2400, 600],
];
const ITEM_PX = 1024;
const SCENE_PX = 1200;
/** The registry folder: the repository's, or another folder holding link-marines-v2.json, to try a changed row. */
const REGISTRY = process.env.LINK_MARINES_V2_REGISTRY
  ? pathToFileURL(`${resolve(process.env.LINK_MARINES_V2_REGISTRY)}/`)
  : at('../../../packages/box-spec/examples/v2/');
const BOX_ID = 'link-marines-v2';
const COUNT = 420;
/** The ticker the founder chose, also the registry row's. */
const TICKER = 'MARINE';
/** The twelve ranks, Private to General, as the community's ladder names them. */
const RANKS = ['Private', 'Specialist', 'Corporal', 'Sergeant', 'Staff Sergeant', 'Master Sergeant', 'Sergeant Major', 'Lieutenant', 'Captain', 'Major', 'Colonel', 'General'];
const RANK_LINE = 'Rank is only the picture.';

/** Width and height from a PNG's IHDR chunk. */
function pngSize(rel) {
  const b = readFileSync(at(rel));
  if (b.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || b.subarray(12, 16).toString() !== 'IHDR') return null;
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

/** Width and height on an SVG's root element, and whether it is self-contained and titled. */
function svgFacts(rel) {
  const s = text(rel);
  const head = s.match(/<svg\b[^>]*>/)?.[0] ?? '';
  const num = (name) => Number(head.match(new RegExp(`\\s${name}="(\\d+)"`))?.[1]);
  const external = /<image\b|<text\b|<script\b|<foreignObject\b|\bhref=|url\((?!#)|@import/i.test(s);
  return { w: num('width'), h: num('height'), viewBox: /viewBox="0 0 \d+ \d+"/.test(head), external, title: /<title>[^<]+<\/title>/.test(s), desc: /<desc>[^<]+<\/desc>/.test(s) };
}

function checkPair(base, w, h) {
  const png = `${base}.png`;
  const svg = `${base}.svg`;
  if (!check(existsSync(at(png)), `missing ${png}`) || !check(existsSync(at(svg)), `missing ${svg}`)) return;
  const size = pngSize(png);
  check(size && size[0] === w && size[1] === h, `${png} is ${size ? size.join('x') : 'not a PNG'}, expected ${w}x${h}`);
  const f = svgFacts(svg);
  check(f.w === w && f.h === h && f.viewBox, `${svg} must declare width ${w}, height ${h} and a viewBox`);
  check(!f.external, `${svg} must not load images, fonts, scripts or outside references`);
  check(f.title && f.desc, `${svg} needs a <title> and a <desc>`);
}

/** Numbered files NN in a folder: returns the sorted numbers and checks they run 01, 02, ... without gaps. */
function numbered(dir, prefix, min, max) {
  const names = existsSync(at(dir)) ? readdirSync(at(dir)) : [];
  const nums = [...new Set(names.map((n) => n.match(new RegExp(`^${prefix}-(\\d\\d)\\.(svg|png)$`))?.[1]).filter(Boolean))].sort();
  check(nums.length >= min && nums.length <= max, `${dir}: expected ${min} to ${max} ${prefix} files, found ${nums.length}`);
  check(nums.every((n, i) => n === String(i + 1).padStart(2, '0')), `${dir}: numbering must run 01, 02, ... without gaps`);
  check(names.every((n) => new RegExp(`^${prefix}-\\d\\d\\.(svg|png)$`).test(n)), `${dir} holds files that are not ${prefix}-NN.svg or .png`);
  return nums;
}

function checkFiles() {
  for (const doc of [...DOCS, RECORD]) check(existsSync(at(doc)) && text(doc).trim().length > 200, `missing or empty ${doc}`);
  for (const f of SCRIPTS) check(existsSync(at(f)), `missing ${f}`);
  check(/^art\/\*\* -text$/m.test(text('.gitattributes')) && /^assignment\.json -text$/m.test(text('.gitattributes')), '.gitattributes must mark art/** and assignment.json as -text');
  for (const [base, w, h] of FIXED) checkPair(base, w, h);
  const small = existsSync(at('art/logo-48.png')) && pngSize('art/logo-48.png');
  check(small && small[0] === 48 && small[1] === 48, 'art/logo-48.png must be exactly 48x48');
  const items = numbered('art/items', 'variant', 8, 12);
  for (const n of items) checkPair(`art/items/variant-${n}`, ITEM_PX, ITEM_PX);
  const scenes = numbered('art/scenes', 'scene', 5, 7);
  for (const n of scenes) checkPair(`art/scenes/scene-${n}`, SCENE_PX, SCENE_PX);
  return { items, scenes };
}

async function checkAssignment(items) {
  const a = await assignment();
  const reviewed = JSON.parse(text('unique/manifest.json'));
  const library = rankLibrary();
  check(existsSync(at('assignment.json')) && text('assignment.json') === `${JSON.stringify(a, null, 2)}\n`, 'assignment.json differs from `node assign.mjs` output');
  check(JSON.stringify(VARIANT_NAMES) === JSON.stringify(RANKS), `the 12 variants must be the ranks from Private to General, in order: ${RANKS.join(', ')}`);
  check(a.items.length === COUNT && a.items.every((it, i) => it.id === String(i + 1)), `assignment must list ids 1 to ${COUNT} in order`);
  check(a.count === reviewed.count && a.seed === reviewed.seed, 'active edition count and seed must match the reviewed manifest');
  check(a.modelPolicy === '2d' && a.items.every((it) => it.model === null), '2D marines must never carry review models');
  check(JSON.stringify(a.columns) === JSON.stringify(Object.keys(reviewed.items[0].traits)), 'all nine trait columns must remain in manifest order');
  check(new Set(a.items.map((it) => it.picture.sha256)).size === COUNT, 'all 420 active picture hashes must be distinct');
  for (const [i, it] of a.items.entries()) {
    const expected = reviewed.items[i];
    check(it.id === expected.id && JSON.stringify(it.traits) === JSON.stringify(expected.traits), `marine ${it.id} traits differ from the reviewed manifest`);
    check(it.picture.file === expected.picture.file && it.picture.sha256.slice(2) === expected.picture.sha256 && it.picture.bytes === expected.picture.bytes,
      `marine ${it.id} picture differs from the reviewed manifest`);
    check(it.traits.Rank === RANKS[Number(variantFor(it.id)) - 1] && it.traits.Squad === squadFor(it.id), `marine ${it.id} changed rank or squad`);
  }
  check(library.every((it) => items.includes(it.variant) && existsSync(at(it.image)) && existsSync(at(it.svg)) && it.rank === RANKS[Number(it.variant) - 1]), 'every base rank picture and source must exist and carry its rank');
  check(library.length === items.length && VARIANT_NAMES.length === items.length, 'ranks.mjs must name exactly the variants in art/items');
  check(library.reduce((sum, v) => sum + BigInt(v.count), 0n) === BigInt(COUNT), `variant counts must add up to ${COUNT}`);
  check(library.every((v) => v.count === String(COUNT / items.length)), `every rank must appear ${COUNT / items.length} times, so none is rarer`);
  check(variantFor('1') === '01' && variantFor('12') === '12' && variantFor('13') === '01' && variantFor('420') === '12', 'marine #1 is a Private, #13 starts again at the Private, and #420 is a General');
  check(squadFor('1') === '1' && squadFor('12') === '1' && squadFor('13') === '2' && squadFor('420') === '35' && a.squads === '35', 'marines 1 to 12 are squad 1, 13 starts squad 2, and 420 closes squad 35');
  const squads = new Map();
  for (const it of a.items) squads.set(it.traits.Squad, [...(squads.get(it.traits.Squad) ?? []), it.traits.Rank]);
  check(squads.size === COUNT / items.length && [...squads.values()].every((vs) => new Set(vs).size === items.length), 'every squad must hold one marine of each rank');
  check(a.note.startsWith(RANK_LINE), `assignment.json must say "${RANK_LINE}"`);
  for (const bad of ['0', '421', '01', '-1', '1.0', '', ' 1', 4, null]) {
    let threw = false;
    try { variantFor(bad); } catch { threw = true; }
    check(threw, `variantFor must refuse ${JSON.stringify(bad)}`);
  }
}

const rgb = (hex) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** Hue in degrees, HSL saturation (0 to 1) and lightness of a #RRGGBB color. */
function hsl(hex) {
  const [r, g, b] = rgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

/** CIE Lab (D65) of a #RRGGBB color. */
function lab(hex) {
  const [r, g, b] = rgb(hex).map(linear);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** The CIEDE2000 color difference of two #RRGGBB colors. */
function deltaE2000(h1, h2) {
  const [L1, a1, b1] = lab(h1);
  const [L2, a2, b2] = lab(h2);
  const rad = Math.PI / 180;
  const Cbar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const [a1p, a2p] = [(1 + G) * a1, (1 + G) * a2];
  const [C1, C2] = [Math.hypot(a1p, b1), Math.hypot(a2p, b2)];
  const hue = (b, a) => (b === 0 && a === 0 ? 0 : (Math.atan2(b, a) / rad + 360) % 360);
  const [h1p, h2p] = [hue(b1, a1p), hue(b2, a2p)];
  let dh = 0;
  if (C1 * C2 !== 0) dh = h2p - h1p > 180 ? h2p - h1p - 360 : h2p - h1p < -180 ? h2p - h1p + 360 : h2p - h1p;
  const dL = L2 - L1;
  const dC = C2 - C1;
  const dH = 2 * Math.sqrt(C1 * C2) * Math.sin((dh / 2) * rad);
  const Lb = (L1 + L2) / 2;
  const Cb = (C1 + C2) / 2;
  let hb = h1p + h2p;
  if (C1 * C2 !== 0) hb = Math.abs(h1p - h2p) > 180 ? (h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2) : (h1p + h2p) / 2;
  const T = 1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad) + 0.32 * Math.cos((3 * hb + 6) * rad) - 0.2 * Math.cos((4 * hb - 63) * rad);
  const Rc = 2 * Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2);
  const Sc = 1 + 0.045 * Cb;
  const Sh = 1 + 0.015 * Cb * T;
  const Rt = -Math.sin(2 * 30 * Math.exp(-(((hb - 275) / 25) ** 2)) * rad) * Rc;
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}

/**
 * The colour fence from the kit's research: the price coin project's brand blues (today's, its old logo's, its light
 * and dark), and the colors of another LINK-paired token with the same name. Nothing in the kit comes within ΔE 8.
 */
const FENCE = ['#0847F7', '#375BD2', '#2A5ADA', '#052DA7', '#DCEBFF', '#0E1119', '#4A7AFF', '#9FB0E0', '#0A0F1F'];
const FENCE_DE = 8;
/** Any blue or cyan at all, even greyed: allowed only as cloth. */
const bluish = (hex) => { const [h, s] = hsl(hex); return h >= 170 && h <= 265 && s > 0.12; };
/** A vivid blue: refused everywhere, cloth included. */
const vivid = (hex) => { const [h, s] = hsl(hex); return h >= 190 && h <= 250 && s > 0.45; };
const luminance = (hex) => { const [r, g, b] = rgb(hex).map(linear); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };

/** Every color in every SVG comes from the palette, and only src/palette.mjs defines one. */
function checkPalette(all) {
  const allowed = new Set([...Object.values(C), ...Object.values(MIX)].map((c) => c.toUpperCase()));
  for (const [base, svg] of all) {
    const stray = [...new Set((svg.match(/#[0-9A-Fa-f]{6}\b/g) ?? []).map((c) => c.toUpperCase()))].filter((c) => !allowed.has(c));
    check(stray.length === 0, `${base}.svg uses colors outside the palette: ${stray.join(', ')}`);
    check(!/\b(fill|stroke|stop-color)="(?!none|url\(#)[a-z]+"/i.test(svg), `${base}.svg uses a named color; colors come from src/palette.mjs`);
  }
  for (const f of readdirSync(at('src')).filter((n) => n !== 'palette.mjs')) {
    check(!/#[0-9A-Fa-f]{6}\b/.test(text(`src/${f}`)), `src/${f} defines a color; colors live in src/palette.mjs`);
  }
  const book = text('brand-book.md');
  for (const [name, hex] of Object.entries(C)) check(book.includes(`\`${hex}\``), `brand-book.md must list the palette color ${name} ${hex}`);
}

/** The colour fence: no vivid blue, nothing near a fenced color, blue only as cloth, and never on a wall, ground or letter. */
function checkFence(all, Resvg) {
  // The bridges cut out of a stencil mask are pure black, which only hides; it is never painted, so it is no color.
  for (const [base, svg] of all) check(!svg.replace(/<mask\b[\s\S]*?<\/mask>/g, '').includes(MIX.cut), `${base}.svg paints the mask black ${MIX.cut} outside a stencil mask`);
  for (const [name, hex] of [...Object.entries(C), ...Object.entries(MIX)].filter(([name]) => name !== 'cut')) {
    const [h, s] = hsl(hex);
    check(!vivid(hex), `palette color ${name} ${hex} is a vivid blue (hue ${Math.round(h)}, saturation ${s.toFixed(2)})`);
    const near = FENCE.map((f) => [f, deltaE2000(hex, f)]).sort((p, q) => p[1] - q[1])[0];
    check(near[1] >= FENCE_DE, `palette color ${name} ${hex} is ΔE ${near[1].toFixed(1)} from the fenced ${near[0]}; keep at least ${FENCE_DE}`);
    check(!bluish(hex) || CLOTH.includes(hex), `palette color ${name} ${hex} is blue but not one of the cloth colors`);
    check(!bluish(hex) || luminance(hex) >= luminance(C.navy), `palette color ${name} ${hex} is a blue darker than dress navy`);
  }
  for (const [wall, inks] of Object.entries(WALLS)) check(inks.every((hex) => !bluish(hex)), `the ${wall} wall uses a blue ink`);
  for (const color of CLOTH) {
    let threw = false;
    try { lettering(new Doc(10, 10, 't', 'd'), 'A', { x: 0, y: 0, cap: 10, color }); } catch { threw = true; }
    check(threw, `lettering must refuse the cloth color ${color}`);
  }
  for (const [base, svg] of all) {
    const inks = [...svg.matchAll(/<g mask="url\(#stencil\d+\)" fill="none" stroke="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1]);
    check(inks.every((hex) => !bluish(hex)), `${base}.svg letters words in a blue ink`);
    // The wall is the first shape of every picture, before any person or prop.
    const first = svg.match(/<\/defs>\n<rect [^>]*fill="(#[0-9A-Fa-f]{6})"/)?.[1] ?? svg.match(/<\/defs>\n<g [^>]*><rect [^>]*fill="(#[0-9A-Fa-f]{6})"/)?.[1];
    check(first && !bluish(first), `${base}.svg must start with a wall that is not blue`);
    if (Resvg) {
      const { data, w } = pixels(Resvg, svg);
      const corners = [[2, 2], [w - 3, 2]].map(([x, y]) => (y * w + x) * 4).map((i) => `#${[0, 1, 2].map((k) => data[i + k].toString(16).padStart(2, '0')).join('')}`);
      check(corners.every((hex) => !bluish(hex)), `${base}: the wall in the top corners renders blue (${corners.join(', ')})`);
    }
  }
}

/** One flannel shirt and one quiet seven: the plaid is in one picture, seven candles stand in one, and no 777. */
function checkTouches() {
  const plaids = pieces().filter(([, svg]) => /<pattern id="plaid-/.test(svg)).map(([base]) => base);
  check(plaids.length === 1 && plaids[0] === 'art/scenes/scene-03', `the flannel must appear in exactly one picture, scene 03; found ${plaids.join(', ') || 'none'}`);
  const counts = builders().map(([base, build]) => { CANDLES.length = 0; build(); return [base, CANDLES.length]; });
  const sevens = counts.filter(([, n]) => n >= 7);
  check(BANNER_CANDLES === 7 && sevens.length === 1 && sevens[0][0] === 'art/box-banner' && sevens[0][1] === 7,
    `seven candles must stand on the box banner only; found ${counts.filter(([, n]) => n > 0).map(([b, n]) => `${b} ${n}`).join(', ')}`);
  let threw = false;
  try { lettering(new Doc(10, 10, 't', 'd'), '777', { x: 0, y: 0, cap: 10, color: C.ink }); } catch { threw = true; }
  check(threw, 'lettering must refuse 777');
}

/** WCAG 2.2 contrast ratio of two #RRGGBB colors. */
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The pairs the brand book's accessibility table lists, as [text color, ground color, minimum]. */
const PAIRS = [
  ['ink', 'white', 4.5], ['ink', 'paper', 4.5], ['ink', 'gold', 4.5], ['ink', 'khaki', 4.5], ['white', 'walnut', 4.5],
  ['ink', 'steel', 4.5], ['paper', 'walnut', 4.5], ['ink', 'sage', 4.5], ['ink', 'crate', 4.5], ['ink', 'orange', 4.5],
  ['gold', 'walnut', 4.5], ['khaki', 'walnut', 3],
];

function checkContrast() {
  const book = text('brand-book.md');
  for (const [fg, bg, min] of PAIRS) {
    const ratio = contrast(C[fg], C[bg]);
    const shown = `${(Math.floor(ratio * 100) / 100).toFixed(2)}:1`;
    check(book.includes(`| ${shown} |`), `brand-book.md must give ${fg} on ${bg} as ${shown}`);
    check(ratio >= min, `${fg} on ${bg} is ${shown}, below the ${min}:1 the brand book uses it for`);
  }
}

/**
 * The docs match the current Items/Depth recipe. It became ready in a reviewed integration once its contract and
 * browser lives passed (SH-EX-LMV2); pending on EXAMPLE-LIFE is still accepted. Skipped when copied out of the repository.
 */
function checkRegistry() {
  const row = new URL(`${BOX_ID}.json`, REGISTRY);
  if (!existsSync(row)) return;
  const box = JSON.parse(readFileSync(row, 'utf8'));
  check(box.name === 'Link Marines' && box.ticker === TICKER, `registry: ${BOX_ID} is expected to be Link Marines with the ticker ${TICKER}; review the kit if that changed`);
  check(box.contents.kind === 'collection' && box.contents.size === String(COUNT) && box.contents.label === 'Marines' && box.template.id === 'collection',
    `registry: ${BOX_ID} is expected to be a Collection of ${COUNT} Marines; review the kit if that changed`);
  check(box.priceCoin.symbol === 'LINK' && box.priceCoin.decimals === '18', 'registry: the price coin is expected to be LINK with 18 decimals; review the kit if that changed');
  check(box.deadline.days === '90' && box.contents.art.mode === 'open' && box.contents.pickFeeBps === '100' && box.royalties.destination === 'fees' && box.royalties.bps === '250',
    'registry: a 90-day deadline, open art, a 1% pick fee and 2.5% royalties into the fees are expected; review the kit if that changed');
  const items = box.fees.buyers.choice === 'items' && box.fees.sellers.choice === 'items';
  const pending = box.status === 'pending' && box.pendingStep === 'EXAMPLE-LIFE' && Boolean(box.pendingReason);
  const ready = box.status === 'ready' && !box.pendingStep && !box.pendingReason;
  check(items && (pending || ready) && box.fees.buyers.inside === 'depth' && box.fees.sellers.inside === 'depth',
    'registry: Items/Depth is required on both sides, pending EXAMPLE-LIFE or reviewed ready');
  check(box.properties.includes('item-claim'), 'registry: the row must prove that a marine\'s owner can claim its share (item-claim)');
  const details = text('details.md');
  const facts = [box.name, box.ticker, box.status, box.template.id, box.template.name, box.priceCoin.symbol, box.priceCoin.decimals, box.contents.kind,
    box.contents.size, box.contents.label, box.contents.art.mode, box.contents.pickFeeBps, box.raise.policy, box.deadline.days, box.royalties.bps,
    box.royalties.destination, box.fees.buyers.choice, box.fees.buyers.inside, box.fees.sellers.choice, box.fees.sellers.inside, box.life, ...box.properties];
  for (const fact of facts) check(details.includes(`\`${fact}\``), `details.md must show the registry value \`${fact}\``);
  if (box.status === 'pending') check(details.includes(`\`${box.pendingStep}\``), `details.md must name the pending step \`${box.pendingStep}\``);
  const book = text('brand-book.md');
  check(book.includes(`**Name:** ${box.name}, version 2.`) && book.includes(`**Ticker:** ${TICKER}`), `brand-book.md must name ${box.name}, version 2, and the ticker ${TICKER}`);
}

/** Storybook: one picture per scene, each referenced once, at most two sentences under it, same words as src. */
function checkStorybook(scenes) {
  const md = text('storybook.md');
  for (const n of scenes) {
    const ref = `art/scenes/scene-${n}.png`;
    check(md.split(ref).length === 2, `storybook.md must show ${ref} exactly once`);
  }
  for (const s of SCENES) {
    check(md.includes(`## ${s.n} · ${s.title}\n`), `storybook.md must have the heading "${s.n} · ${s.title}"`);
    check(md.includes(`![${s.alt}](art/scenes/scene-${s.n}.png)`), `storybook.md scene ${s.n} must use the alt text from src/scenes.mjs`);
    for (const line of s.caption) check(md.includes(line), `storybook.md scene ${s.n} must say: ${line}`);
    check(s.caption.length <= 2, `scene ${s.n} has more than two caption sentences in src/scenes.mjs`);
  }
  const sections = md.split(/^## /m).slice(1);
  check(sections.length === scenes.length, `storybook.md has ${sections.length} scenes, art has ${scenes.length}`);
  for (const s of sections) {
    const body = s.split('\n').slice(1).filter((l) => l.trim() && !l.startsWith('![')).join(' ');
    const sentences = body.split(/(?<=[.!?])\s+/).filter((x) => x.trim());
    check(sentences.length <= 2, `storybook scene "${s.split('\n')[0]}" has ${sentences.length} sentences, at most 2`);
  }
}

const AVOID_START = '<!-- avoid-list:start -->';
const AVOID_END = '<!-- avoid-list:end -->';
const BANNED = [
  /\bearn(s|ed|ing|ings)?\b/i, /\byields?\b/i, /\breturns?\b/i, /\bgains?\b/i, /\bmoon(ing)?\b/i, /\b100x\b/i,
  /\binvest(ment|ments|or|ors|ing)?\b/i, /\bincome\b/i, /\bprofit(s|able)?\b/i, /\bpassive\b/i, /\bAPY\b/, /\bAPR\b/, /\bROI\b/,
  /\bguarantee(d|s)?\b/i, /\bunlock(s|ed|ing)?\b/i, /\bseamless(ly)?\b/i, /\brevolutionary\b/i, /\bjourney\b/i,
  /\bpump(s|ed|ing)?\b/i, /\bfloor price\b/i, /\bprice (floor|support|rise)\b/i, /\bget in early\b/i, /\bnumber go up\b/i,
  /\bdividends?\b/i, /\brewards?\b/i, /\bprizes?\b/i, /\bjackpot\b/i, /\bwealth\b/i, /\bupside\b/i, /\bflywheel\b/i,
  /\bappreciat\w*/i, /\baccru\w*/i, /\bscarc\w*/i, /\bdeflation\w*/i, /\bhodl\b/i, /\bdiamond hands\b/i, /\bbullish\b/i,
  /\blotter(y|ies)\b/i, /\bgambl\w*/i, /\brare\b/i, /\brarity\b/i,
  // A ration is a share of the fees that its owner claims, never pay: none of another LINK-paired token's words.
  /\bsalar(y|ies)\b/i, /\bpayroll\b/i, /\bwages?\b/i, /\bpaychecks?\b/i, /\bpayday\b/i, /\breflections?\b/i, /\bpaid in\b/i,
  /\bget(s|ting)? paid\b/i, /\bpays? (you|its owner|the owner|owners|holders)\b/i, /\bmakes? money\b/i, /\bfree money\b/i, /\bcash ?flow\b/i,
  // Square Hole's own token and collection, and the word the founder took out of the UI (F130).
  /\bFIT\b/, /\bmisfits?\b/i, /\bdemo\b/i,
  // The homage names nothing: not the project or company behind the price coin, nor its product words.
  /chain\s?link/i, /\boracles?\b/i, /\bCCIP\b/, /\bdata feeds?\b/i, /\breserves?\b/i, /\bstak(e|es|ed|ing)\b/i, /\bthe standard\b/i, /\bfundamentally\b/i,
  // No real person and no character: no general of the project, no burger, no frog.
  /\bfive[- ]star\b/i, /\buncle\b/i, /\bbig macs?\b/i, /\bmcdonald\w*/i, /\bpepe\b/i, /\bfrogs?\b/i, /\btoads?\b/i,
  // The marines are caricatures of nobody: no real service's names, mottos, nicknames, ranks of its own or recruiting.
  /\busmc\b/i, /\bmarine corps\b/i, /\bcorps\b/i, /\bsemper\b/i, /\boorah\b/i, /\bjarheads?\b/i, /\bleathernecks?\b/i, /\bdevil dogs?\b/i,
  /\bcrayons?\b/i, /\bthe few\b/i, /\benlist\w*/i, /\bwants you\b/i, /\brecruit\w*/i, /\bcommandant\b/i, /\bboots?\b(?![\s-]+black)/i,
  // The community's words we leave out: price memes, rude or dark slang, old fights.
  /\bEOY\b/i, /\bWAGMI\b/i, /\blinkpilled\b/i, /\bfrens\b/i, /\bbreadcrumbs?\b/i, /\bgod protocol\b/i, /\b4IR\b/i, /\bstinky\b/i,
  /\blink(y|ies)\b/i, /\bdidn'?t read\b/i, /\bnolinkers?\b/i, /\bfudders?\b/i, /\bFUD\b/, /\blinklets?\b/i, /\bnormies\b/i,
  /\bsuicide\b/i, /\bropes?\b/i, /\bswinglinkers?\b/i, /\bXRP\b/i, /\bripple\b/i, /\bzeus\b/i, /777/,
  // This box never burns or eats LINK, and the kit never claims that LINK's supply goes down.
  /\bburn(s|ed|ing)?\s+(the\s+)?LINK\b/i, /\bLINK\s+(is|gets|was|will be)\s+burn/i,
];
/** A year, so a date. Only the brand book's ticker section may carry one, the day the other MARINE token began. */
const YEAR = /\b(19|20)\d\d\b/;
const SHAPES = [
  [/—/, 'an em dash'], [/\s–\s/, 'a dash used as a pause'], [/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'an emoji or dingbat'],
  [/0x[0-9a-fA-F]{6,}/, 'an address'], [YEAR, 'a year or date'], [/\$\s?\d/, 'a dollar amount'],
  [/\b\d[\d,]*(\.\d+)?\s?(USDC|ETH|USD|LINK|EATIT|MARINE)\b/, 'a coin amount'], [/\bnot\b[^.;]*,\s*but\b/i, 'a "not X, but Y" turn'],
  [/\bsupply\b.*\b(shrink\w*|reduc\w*|decreas\w*|smaller|lower)\b|\b(shrink\w*|reduc\w*|decreas\w*)\b.*\bsupply\b/i, 'a claim about a supply going down'],
];
/**
 * Names the kit never writes, not even in the avoid list, kept as the first 16 hex digits of each lowercase word's
 * SHA-256 so this file never spells them either: the price coin project's co-founder, and another LINK-paired marines
 * token's launchpad, chain and site.
 */
const NEVER = new Set(['e2d279cba45ada22', '0446c9c98d199835', 'dc48c8a9ec45cf24', '615666dae9d3625a', '4bccec7383184d95']);
const fingerprint = (s) => sha256(s).slice(0, 16);
/**
 * The one exception: the brand book's ticker section names that other token's chain, once, so readers know why every
 * page shows the chain and the full contract address. It names nothing else from NEVER, and no other place names it.
 */
const CHAIN = '615666dae9d3625a';
const TICKER_HEADING = '## The ticker';

/** The brand book's ticker section, from its heading up to the next heading, with its first and last line numbers. */
function tickerSection(book) {
  const lines = book.split('\n');
  const start = lines.indexOf(TICKER_HEADING);
  if (start === -1) return null;
  const next = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  const end = next === -1 ? lines.length : next;
  return { first: start + 1, last: end, text: lines.slice(start, end).join('\n') };
}

/**
 * The prose of a doc as paragraphs, each with its first line number. Lines are joined, so a phrase broken across two
 * lines is still read whole. The avoid list, code blocks, code spans and link targets are left out: they are not prose.
 */
function paragraphs(raw) {
  const out = [];
  let avoid = false;
  let fenced = false;
  let current = null;
  const close = () => { if (current) out.push(current); current = null; };
  raw.split('\n').forEach((line, i) => {
    const marker = line.includes(AVOID_START) || line.includes(AVOID_END);
    if (line.includes(AVOID_START)) avoid = true;
    if (line.includes(AVOID_END)) avoid = false;
    if (line.startsWith('```')) fenced = !fenced;
    if (marker || line.startsWith('```') || avoid || fenced || !line.trim()) return close();
    // A heading, a table row and a list item each start a paragraph of their own; an indented line continues one.
    if (/^(#|\||[-*] |\d+\. )/.test(line)) close();
    const clean = line.replace(/\]\([^)]*\)/g, ']').replace(/`[^`]*`/g, '');
    if (!current) current = { line: i + 1, text: clean };
    else current = { ...current, text: `${current.text} ${clean}` };
  });
  close();
  return out;
}

/** The rules apply to every doc in the kit and to the titles and descriptions inside the SVGs. */
function checkWords(all) {
  const book = text('brand-book.md');
  const note = tickerSection(book);
  const words = (s) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const f of [...DOCS, RECORD, ...SCRIPTS.filter((s) => s.endsWith('.mjs')), ...readdirSync(at('src')).map((n) => `src/${n}`)]) {
    const own = f === 'brand-book.md' && note ? book.replace(note.text, '') : text(f);
    const hits = words(own).filter((w) => NEVER.has(fingerprint(w)));
    check(hits.length === 0, `${f} names something the kit never names (${hits.length} hit${hits.length === 1 ? '' : 's'})`);
  }
  if (check(note !== null, `brand-book.md must have the section "${TICKER_HEADING}"`)) {
    const named = words(note.text).map(fingerprint).filter((h) => NEVER.has(h));
    check(named.length === 1 && named[0] === CHAIN, `brand-book.md's ticker section must name the other token's chain exactly once and nothing else the kit never names (${named.length} hit${named.length === 1 ? '' : 's'})`);
    check(note.text.replace(/\s+/g, ' ').includes('the chain and the full contract address'), 'brand-book.md\'s ticker section must say that pages show the chain and the full contract address');
  }
  const inNote = (name, line) => name === 'brand-book.md' && note !== null && line >= note.first && line <= note.last;
  const sources = [...DOCS, RECORD].map((d) => [d, paragraphs(text(d))]);
  for (const [base, svg] of all) {
    const words = (svg.match(/<(title|desc)>[^<]*<\/\1>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join(' ');
    sources.push([`${base}.svg`, [{ line: 1, text: words }]]);
    check(!/\bLINK\b/i.test(words.replace(/\bLink Marines\b/gi, '').replace(/\bLINK MARINES\b/g, '')),
      `${base}.svg names the price coin; pictures name only the box, so the coins fit any community coin`);
  }
  for (const [name, paras] of sources) {
    const issues = [];
    for (const p of paras) {
      const where = `${name}:${p.line}`;
      const quote = p.text.trim().slice(0, 90);
      for (const re of BANNED) if (re.test(p.text)) issues.push(`${where} uses a word the kit avoids (${re.source}): ${quote}`);
      for (const [re, what] of SHAPES) {
        // The ticker section may give one date: the day the other token with this ticker began.
        if (re === YEAR && inNote(name, p.line)) {
          if ((p.text.match(new RegExp(YEAR.source, 'g')) ?? []).length > 1) issues.push(`${where} gives more than one date in the ticker section: ${quote}`);
        } else if (re.test(p.text)) issues.push(`${where} contains ${what}: ${quote}`);
      }
    }
    if (issues.length) problems.push(...issues);
    else passed += 1;
  }
  const joined = COVER_LINE.join(' ');
  const cover = joined[0] + joined.slice(1).toLowerCase();
  check(book.includes(`**Cover line:** "${cover}"`) && book.includes(`| Cover | "${cover}" |`), `brand-book.md must carry the cover line "${cover}" in Identity and in the example lines`);
  check(book.includes('"In plain words, ten of every fifteen fee coins are split into 420 equal shares, one for each marine, whatever its rank."'), 'brand-book.md must carry the literal line next to the cover line');
  check(book.includes('**Motto:** "Not selling."') && book.includes('"In plain words, a marine keeps its rations until its owner claims them. Nobody else can take them."'),
    'brand-book.md must carry the motto with its literal line');
  for (const doc of ['README.md', 'brand-book.md', 'details.md']) check(text(doc).includes(RANK_LINE), `${doc} must say "${RANK_LINE}"`);
}

/** Every local Markdown link resolves. Links into the repository are checked when the repository is present. */
function checkLinks() {
  const inRepo = existsSync(at('../../../packages/box-spec'));
  for (const doc of [...DOCS, RECORD]) {
    for (const [, target] of text(doc).matchAll(/\]\(([^)\s#]+)(#[^)]*)?\)/g)) {
      if (/^[a-z]+:/i.test(target)) continue;
      if (target.startsWith('../') && !inRepo) continue;
      check(existsSync(at(target)), `${doc} links to ${target}, which does not exist`);
    }
  }
}

/** README lists every file and folder at the top of the kit and every art piece; every source file is described. */
function checkReadme(items, scenes) {
  const readme = text('README.md');
  const top = readdirSync(root).filter((n) => !n.startsWith('.') || n === '.gitattributes');
  for (const name of top) check(readme.includes(name), `README.md does not list ${name}`);
  for (const [base] of FIXED) check(readme.includes(`${base}.png`), `README.md does not list ${base}.png`);
  check(readme.includes('art/logo-48.png'), 'README.md must name art/logo-48.png');
  check(readme.includes(`variant-${items.at(-1)}`) && readme.includes(`scene-${scenes.at(-1)}`), 'README.md must name the last variant and the last scene');
  for (const f of readdirSync(at('src'))) check(text('art-notes.md').includes(`src/${f}`), `src/${f} is not described in art-notes.md`);
  for (const v of VARIANT_NAMES) check(readme.includes(`| ${v} |`), `README.md must name the rank ${v} in its table`);
}

/** Words stay clear of the edges: 60 px on the X banner, 48 px everywhere else. */
function checkMargins() {
  const sizes = Object.fromEntries([...FIXED.map(([b, w, h]) => [b, [w, h]]), ...SCENES.map((s) => [`art/scenes/scene-${s.n}`, [SCENE_PX, SCENE_PX]])]);
  for (const [base, build] of builders()) {
    DRAWN.length = 0;
    const svg = build();
    const [w, h] = sizes[base] ?? [ITEM_PX, ITEM_PX];
    const edge = base === 'art/x-banner' ? 60 : 48;
    for (const { text: words, box } of DRAWN) {
      const ok = box.x >= edge && box.y >= edge && box.x + box.w <= w - edge && box.y + box.h <= h - edge;
      check(ok, `${base}: "${words}" comes within ${edge} px of an edge (box ${Math.round(box.x)}, ${Math.round(box.y)}, ${Math.round(box.w)} x ${Math.round(box.h)})`);
    }
    check(svg.length > 0, `${base} did not build`);
  }
}

/** Raw RGBA pixels of an SVG, rendered with system fonts off. */
function pixels(Resvg, svg) {
  const img = new Resvg(svg, { font: { loadSystemFonts: false }, fitTo: { mode: 'original' } }).render();
  return { data: img.pixels, w: img.width, h: img.height };
}

/** Counts pixels where two renders differ, among those `inside(x, y)` selects. */
function differences(a, b, inside) {
  let n = 0;
  for (let y = 0; y < a.h; y += 1) {
    for (let x = 0; x < a.w; x += 1) {
      if (!inside(x, y)) continue;
      const i = (y * a.w + x) * 4;
      if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3]) n += 1;
    }
  }
  return n;
}

/** The mark keeps 2 modules of bare wall on every side and sits inside 95% of a round crop. */
function checkMark(Resvg) {
  for (const [name, size, svg] of [['logo', 1024, logoSvg()], ['x-avatar', 400, avatarSvg()]]) {
    const art = pixels(Resvg, svg);
    const bare = pixels(Resvg, markBareSvg(size));
    const m = size / MARK_GRID;
    const band = differences(art, bare, (x, y) => x < MARK_CLEAR * m || y < MARK_CLEAR * m || x >= size - MARK_CLEAR * m || y >= size - MARK_CLEAR * m);
    check(band === 0, `${name}: ${band} pixels of the mark fall in the ${MARK_CLEAR}-module clear space`);
    const r = (size / 2) * 0.95;
    const round = differences(art, bare, (x, y) => (x + 0.5 - size / 2) ** 2 + (y + 0.5 - size / 2) ** 2 > r * r);
    check(round === 0, `${name}: ${round} pixels of the mark fall outside 95% of a round crop`);
    check(differences(art, bare, () => true) > 0, `${name}: the mark is missing`);
  }
}

/** The X banner's bottom-left corner is the bare wall, so the avatar can overlap it. */
function checkCorner(Resvg) {
  const art = pixels(Resvg, xBannerSvg());
  const bare = pixels(Resvg, xBannerBareSvg());
  const { x: cx, y: cy, w: cw, h: ch } = AVATAR_CORNER;
  const n = differences(art, bare, (x, y) => x >= cx && x < cx + cw && y >= cy && y < cy + ch);
  check(n === 0, `x-banner: ${n} pixels in the avatar corner (x ${cx} to ${cx + cw}, y ${cy} to ${cy + ch}) differ from bare wall`);
}

/** The committed SVGs are what src/ builds today, and each PNG is that SVG rendered. */
function checkFresh(all, Resvg) {
  for (const [base, svg] of all) {
    check(existsSync(at(`${base}.svg`)) && text(`${base}.svg`) === svg, `${base}.svg is not what src/ builds; run node build-art.mjs`);
    if (Resvg && existsSync(at(`${base}.png`))) {
      check(Buffer.compare(readFileSync(at(`${base}.png`)), toPng(Resvg, svg)) === 0, `${base}.png is not a fresh render of its SVG; run node build-art.mjs`);
    }
  }
  if (Resvg && existsSync(at('art/logo-48.png'))) {
    check(Buffer.compare(readFileSync(at('art/logo-48.png')), toPng(Resvg, logoSvg(), 48)) === 0, 'art/logo-48.png is not a fresh render; run node build-art.mjs');
  }
}

let Resvg = null;
try { Resvg = await loadResvg(); } catch { problems.push('cannot load @resvg/resvg-js, so the PNGs could not be rendered or compared'); }

const all = pieces();
const { items, scenes } = checkFiles();
await checkAssignment(items);
checkPalette(all);
checkFence(all, Resvg);
checkTouches();
checkContrast();
checkRegistry();
checkStorybook(scenes);
checkWords(all);
checkReadme(items, scenes);
checkLinks();
checkMargins();
if (Resvg) {
  checkMark(Resvg);
  checkCorner(Resvg);
}
checkFresh(all, Resvg);

if (problems.length) {
  process.stderr.write(`${problems.map((p) => `FAIL ${p}`).join('\n')}\n${problems.length} problem(s), ${passed} checks passed\n`);
  process.exit(1);
}
process.stdout.write(`ok: ${passed} checks passed (${items.length} ranks, ${scenes.length} scenes, ${COUNT} marines)\n`);
