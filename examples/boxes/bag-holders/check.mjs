/**
 * Checks the Bag Holders kit: every required file is here with its exact pixel size, every PNG has its SVG source
 * and is a fresh render of it, assignment.json is exactly what assign.mjs prints, the storybook matches the scenes,
 * the docs match the registry settings, the X avatar corner holds only bare wall, and the kit's words follow the
 * brand rules. No network.
 *
 *   node check.mjs        exit 0 when everything passes, 1 otherwise
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { assignment, variantFor, VARIANT_NAMES, COUNT } from './assign.mjs';
import { normalizeUniqueManifest } from '../../../scripts/kits/unique.mjs';
import { reviewedJsonForPlatform, reviewedManifestForPlatform } from '../../../scripts/kits/bag-holders-normal-zero-platform-exception.mjs';
import { pieces } from './build-art.mjs';
import { SCENES } from './src/scenes.mjs';
import { logoSvg, avatarSvg, logoWallSvg, xBannerSvg, xBannerWallSvg, X_CALM, MARK_MODULES, MARK_CLEAR } from './src/brand.mjs';
import { loadResvg, toPng } from './src/render.mjs';
import { C, MIX } from './src/palette.mjs';

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
const problems = [];
let passed = 0;
const check = (ok, message) => { if (ok) passed += 1; else problems.push(message); return ok; };

const DOCS = ['README.md', 'brand-book.md', 'storybook.md', 'details.md', 'art-notes.md'];
const RECORD = 'SH-KIT-BAG-HOLDERS.md';
const FIXED = [
  ['art/logo', 1024, 1024], ['art/x-avatar', 400, 400], ['art/x-banner', 1500, 500],
  ['art/cover', 1200, 630], ['art/box-banner', 2400, 600],
];
const ITEM_PX = 1024;
const SCENE_PX = 1200;
const REGISTRY = '../../../packages/box-spec/examples/v2/';

/** Width and height from a PNG's IHDR chunk. */
function pngSize(rel) {
  const b = readFileSync(at(rel));
  if (b.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || b.subarray(12, 16).toString() !== 'IHDR') return null;
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

/** Width and height on an SVG's root element, plus whether it is self-contained. */
function svgFacts(rel) {
  const s = text(rel);
  const head = s.match(/<svg\b[^>]*>/)?.[0] ?? '';
  const num = (name) => Number(head.match(new RegExp(`\\s${name}="(\\d+)"`))?.[1]);
  const external = /<image\b|<text\b|<script\b|<foreignObject\b|\bhref=|url\((?!#)/i.test(s);
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
  const names = existsSync(at(dir)) ? list(dir) : [];
  const nums = [...new Set(names.map((n) => n.match(new RegExp(`^${prefix}-(\\d\\d)\\.(svg|png)$`))?.[1]).filter(Boolean))].sort();
  check(nums.length >= min && nums.length <= max, `${dir}: expected ${min} to ${max} ${prefix} files, found ${nums.length}`);
  check(nums.every((n, i) => n === String(i + 1).padStart(2, '0')), `${dir}: numbering must run 01, 02, ... without gaps`);
  check(names.every((n) => new RegExp(`^${prefix}-\\d\\d\\.(svg|png)$`).test(n)), `${dir}: holds a file that is not a ${prefix} picture`);
  return nums;
}

function checkFiles() {
  for (const doc of [...DOCS, RECORD]) check(existsSync(at(doc)) && text(doc).trim().length > 200, `missing or empty ${doc}`);
  for (const f of ['assign.mjs', 'assignment.json', 'build-art.mjs', 'check.mjs', '.gitattributes']) check(existsSync(at(f)), `missing ${f}`);
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
  // assignment() consumes buildUniqueSet: fresh bytes are checked against the reviewed manifest there.
  const a = await assignment();
  const armReviewed = JSON.parse(text('unique/manifest.json'));
  const reviewed = normalizeUniqueManifest('bag-holders', reviewedManifestForPlatform('bag-holders', armReviewed));
  check(existsSync(at('assignment.json')) && reviewedJsonForPlatform(text('assignment.json'), armReviewed, process.arch, '0x') === `${JSON.stringify(a, null, 2)}\n`, 'assignment.json differs from `node assign.mjs` output');
  check(BigInt(a.items.length) === COUNT && a.items.every((it, i) => it.id === String(i + 1)), `assignment must list ids 1 to ${COUNT} in order`);
  check(a.count === reviewed.count && a.seed === reviewed.seed && isDeepStrictEqual(a.columns, reviewed.columns), 'assignment must preserve the fixed seed, count and all trait columns');
  check(a.modelPolicy === '3d' && a.modelPolicy === reviewed.modelPolicy, 'every Bag Holder requires its 3D model');
  for (const [index, it] of a.items.entries()) {
    const expected = reviewed.items[index];
    check(isDeepStrictEqual(it.traits, expected.traits), `bag ${it.id}: every trait must match the reviewed manifest`);
    for (const role of ['picture', 'model']) {
      const { file, sha256, bytes } = expected[role];
      check(isDeepStrictEqual(it[role], { path: file, sha256, bytes }), `bag ${it.id}: ${role} path, sha256 and bytes must match the reviewed manifest`);
    }
  }
  check(new Set(a.items.map(it => it.picture.sha256)).size === a.items.length, 'every active picture must be distinct');
  // Check the twelve-family input library separately from the 420 finished pictures.
  check(VARIANT_NAMES.length === items.length, 'assign.mjs must name exactly the base families in art/items');
  check(a.items.every(it => items.includes(it.traits.kind) && it.traits.kind === variantFor(it.id)), 'every bag must keep its original base family');
  const counts = items.map(kind => BigInt(a.items.filter(it => it.traits.kind === kind).length));
  check(counts.reduce((sum, n) => sum + n, 0n) === COUNT, `base family counts must add up to ${COUNT}`);
  check(counts.every(n => n === COUNT / BigInt(items.length)), 'every base family must appear 35 times');
  check(variantFor('1') === '01' && variantFor('12') === '12' && variantFor('13') === '01' && variantFor('420') === '12', 'bags #1 and #13 use base family 01, and #420 uses base family 12');
  for (const bad of ['0', '421', '01', '-1', '1.0', '', ' 1', 4, null]) {
    let threw = false;
    try { variantFor(bad); } catch { threw = true; }
    check(threw, `variantFor must refuse ${JSON.stringify(bad)}`);
  }
}

/** Every color in every SVG comes from the palette, and no source file but src/palette.mjs defines one. */
function checkPalette() {
  const allowed = new Set([...Object.values(C), ...Object.values(MIX)].map((c) => c.toUpperCase()));
  for (const [base, svg] of pieces()) {
    const stray = [...new Set((svg.match(/#[0-9A-Fa-f]{6}\b/g) ?? []).map((c) => c.toUpperCase()))].filter((c) => !allowed.has(c));
    check(stray.length === 0, `${base}.svg uses colors outside the palette: ${stray.join(', ')}`);
  }
  for (const f of list('src').filter((n) => n !== 'palette.mjs')) {
    check(!/#[0-9A-Fa-f]{6}\b/.test(text(`src/${f}`)), `src/${f} defines a color; colors live in src/palette.mjs`);
  }
  const book = text('brand-book.md');
  for (const [name, hex] of Object.entries(C)) check(book.includes(`\`${hex}\``), `brand-book.md must list the palette color ${name} ${hex}`);
}

/** The docs say what the registry says. Skipped when the kit is copied out of the repository. */
function checkRegistry() {
  if (!existsSync(at(`${REGISTRY}bag-holders.json`))) return;
  const box = JSON.parse(text(`${REGISTRY}bag-holders.json`));
  check(box.contents.kind === 'collection' && box.contents.size === String(COUNT), `registry: bag-holders is expected to hold ${COUNT} items; review the kit if that changed`);
  check(box.fees.buyers.choice === 'items' && box.fees.sellers.choice === 'items' && box.fees.buyers.inside === 'keep' && box.fees.sellers.inside === 'keep',
    'registry: both fee sides are expected to go to the items and keep the inside share; review the kit if that changed');
  check(box.priceCoin.symbol === 'LINK', 'registry: the price coin is expected to be LINK; review the kit if that changed');
  const details = text('details.md');
  const facts = [box.name, box.ticker, box.status, box.template.id, box.priceCoin.symbol, box.priceCoin.decimals, box.contents.kind, box.contents.size,
    box.contents.label, box.contents.art.mode, box.contents.pickFeeBps, box.raise.policy, box.deadline.days, box.royalties.bps,
    box.fees.buyers.choice, box.fees.buyers.inside, box.life, ...box.properties];
  for (const fact of facts) check(details.includes(`\`${fact}\``), `details.md must show the registry value \`${fact}\``);
  check(text('brand-book.md').includes(`**Name:** ${box.name}. **Ticker:** ${box.ticker}.`), `brand-book.md must name ${box.name} and ${box.ticker}`);
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
    check(s.caption.length <= 2, `scene ${s.n} has more than two caption sentences`);
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
  /\binvest(ment|ments|or|ors|ing)?\b/i, /\bincome\b/i, /\bprofits?\b/i, /\bpassive\b/i, /\bAPY\b/, /\bAPR\b/,
  /\bguarantee(d|s)?\b/i, /\bunlock(s|ed|ing)?\b/i, /\bseamless(ly)?\b/i, /\brevolutionary\b/i, /\bjourney\b/i,
  /\bpump(s|ed|ing)?\b/i, /\bfloor price\b/i, /\bget in early\b/i, /\bFIT\b/, /\bmisfits?\b/i, /\bdemo\b/i,
  /\bprizes?\b/i, /\bjackpot\b/i, /\breward(s|ed|ing)?\b/i, /\bdividends?\b/i, /\bwealth\b/i,
  // The kit never names the project or company behind the price coin.
  /chain\s?link/i,
];
const SHAPES = [
  [/—/, 'an em dash'], [/\s–\s/, 'a dash used as a pause'], [/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'an emoji or dingbat'],
  [/0x[0-9a-fA-F]{6,}/, 'an address'], [/\b(19|20)\d\d\b/, 'a year or date'], [/\$\s?\d/, 'a dollar amount'],
  [/\b\d[\d,]*(\.\d+)?\s?(USDC|ETH|USD|LINK|TOTE)\b/, 'a coin amount'],
];

/** The rules apply to every doc in the kit and to the titles and descriptions inside the SVGs. */
function checkWords() {
  const sources = [...DOCS, RECORD].map((d) => [d, text(d)]);
  const svgs = ['art', 'art/items', 'art/scenes'].filter((dir) => existsSync(at(dir)))
    .flatMap((dir) => list(dir).filter((n) => n.endsWith('.svg')).map((n) => `${dir}/${n}`));
  for (const f of svgs) {
    const words = (text(f).match(/<(title|desc)>[^<]*<\/\1>/g) ?? []).join(' ');
    sources.push([f, words]);
    check(!/\bLINK\b/i.test(words), `${f} names the price coin; pictures and their text never do, so the art fits any community coin`);
  }
  for (const [name, raw] of sources) {
    const inside = raw.split(AVOID_START);
    const body = [inside[0], ...inside.slice(1).map((part) => part.split(AVOID_END).slice(1).join(''))].join('\n');
    const issues = [];
    body.split('\n').forEach((line, i) => {
      const clean = line.replace(/\]\([^)]*\)/g, ']').replace(/`[^`]*`/g, '');
      const where = `${name}:${i + 1}`;
      for (const re of BANNED) if (re.test(clean)) issues.push(`${where} uses a word the kit avoids (${re.source}): ${line.trim().slice(0, 80)}`);
      for (const [re, what] of SHAPES) if (re.test(clean)) issues.push(`${where} contains ${what}: ${line.trim().slice(0, 80)}`);
    });
    if (issues.length) problems.push(...issues);
    else passed += 1;
  }
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
  const top = list('./').filter((n) => !n.startsWith('.') || n === '.gitattributes');
  for (const name of top) check(readme.includes(name), `README.md does not list ${name}`);
  for (const [base] of FIXED) check(readme.includes(`${base}.png`), `README.md does not list ${base}.png`);
  check(readme.includes('art/logo-48.png'), 'README.md must name art/logo-48.png');
  check(readme.includes(`variant-${items.at(-1)}`) && readme.includes(`scene-${scenes.at(-1)}`), 'README.md must name the last variant and the last scene');
  for (const f of list('src')) check(text('art-notes.md').includes(`src/${f}`), `src/${f} is not described in art-notes.md`);
}

/** The committed SVGs are what src/ builds today, each PNG is that SVG rendered, and the avatar corner is bare wall. */
async function checkFresh() {
  let Resvg = null;
  try { Resvg = await loadResvg(); } catch { problems.push('cannot load @resvg/resvg-js, so the PNGs could not be compared with their SVGs'); }
  for (const [base, svg] of pieces()) {
    check(existsSync(at(`${base}.svg`)) && text(`${base}.svg`) === svg, `${base}.svg is not what src/ builds; run node build-art.mjs`);
    if (Resvg && existsSync(at(`${base}.png`))) {
      check(Buffer.compare(readFileSync(at(`${base}.png`)), toPng(Resvg, svg)) === 0, `${base}.png is not a fresh render of its SVG; run node build-art.mjs`);
    }
  }
  if (!Resvg) return;
  if (existsSync(at('art/logo-48.png'))) {
    check(Buffer.compare(readFileSync(at('art/logo-48.png')), toPng(Resvg, logoSvg(), 48)) === 0, 'art/logo-48.png is not a fresh render; run node build-art.mjs');
  }
  // Read each pixel buffer once: every access to `.pixels` copies the whole image.
  const render = (svg) => {
    const img = new Resvg(svg, { font: { loadSystemFonts: false } }).render();
    return { width: img.width, height: img.height, rgba: img.pixels };
  };
  /** Every pixel where a picture differs from its bare wall: what the art draws on top of the pegboard. */
  const drawn = (svg, wallSvg) => {
    const a = render(svg);
    const b = render(wallSvg);
    const out = [];
    for (let i = 0; i < a.rgba.length; i += 4) {
      if (a.rgba[i] !== b.rgba[i] || a.rgba[i + 1] !== b.rgba[i + 1] || a.rgba[i + 2] !== b.rgba[i + 2]) out.push([(i / 4) % a.width, Math.floor(i / 4 / a.width)]);
    }
    return out;
  };
  const [x0, y0, w, h] = X_CALM;
  const inCorner = drawn(xBannerSvg(), xBannerWallSvg()).filter(([x, y]) => x >= x0 && x < x0 + w && y >= y0 && y < y0 + h).length;
  check(inCorner === 0, `the X banner's avatar corner (x ${x0} to ${x0 + w}, y ${y0} to ${y0 + h}) must show only bare pegboard; ${inCorner} pixels differ`);
  for (const [name, svg, size] of [['logo', logoSvg(), 1024], ['x-avatar', avatarSvg(), 400]]) {
    const marks = drawn(svg, logoWallSvg(size));
    const band = (size / MARK_MODULES) * MARK_CLEAR;
    const crowding = marks.filter(([x, y]) => x < band || y < band || x >= size - band || y >= size - band).length;
    check(marks.length > 0 && crowding === 0, `${name}: the mark and its shadow must keep ${MARK_CLEAR} modules of clear space; ${crowding} pixels are closer to the edge`);
    const far = marks.reduce((max, [x, y]) => Math.max(max, Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2)), 0);
    check(far <= 0.95 * (size / 2), `${name}: the mark must sit inside a round crop with a margin; its farthest pixel is at ${(far / (size / 2)).toFixed(3)} of the radius`);
  }
}

const { items, scenes } = checkFiles();
await checkAssignment(items);
checkPalette();
checkRegistry();
checkStorybook(scenes);
checkWords();
checkReadme(items, scenes);
checkLinks();
await checkFresh();

if (problems.length) {
  process.stderr.write(`${problems.map((p) => `FAIL ${p}`).join('\n')}\n${problems.length} problem(s), ${passed} checks passed\n`);
  process.exit(1);
}
process.stdout.write(`ok: ${passed} checks passed (${items.length} base families, ${scenes.length} scenes, ${COUNT} unique bags with 3D models)\n`);
