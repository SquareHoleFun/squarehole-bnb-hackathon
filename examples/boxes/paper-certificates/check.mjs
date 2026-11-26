/**
 * Checks the Paper Certificates kit: every required file is here with its exact pixel size, every PNG has its SVG
 * source and is a fresh render of it, the hidden picture fits the on-chain field, assignment.json is exactly what
 * assign.mjs prints and the secret-seed rules hold, a certificate's own number changes only its number box, the mark
 * keeps its clear space and fits a round crop, both X banners keep their avatar corner bare, words stay clear of the
 * edges, the palette and contrast numbers are right, the storybook matches the scenes, the docs match the registry
 * row, and the kit's words follow the brand rules. No network.
 *
 *   node check.mjs        exit 0 when everything passes, 1 otherwise
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assignment, folderTarget, rankOf, variantFor, BLUE_CHIPS, COUNTS, EXAMPLE_SEED, MIN_SECRET, VARIANT_NAMES } from './assign.mjs';
import { builders, pieces, references } from './build-art.mjs';
import { AVATAR_CORNER, MARK_CLEAR, MARK_GRID, avatarSvg, logoSvg, markBareSvg, xBannerBareSvg, xBannerSvg } from './src/brand.mjs';
import { NUMBER_BOX, serialText } from './src/certificate.mjs';
import { EDITIONS, LITERAL_LINE, coverSentence } from './src/edition.mjs';
import { HIDDEN_MAX_BYTES, hiddenSvg } from './src/hidden.mjs';
import { ITEM_PX, VARIANTS, itemSvg } from './src/items.mjs';
import { C, MIX } from './src/palette.mjs';
import { loadResvg, pixels, toPng } from './src/render.mjs';
import { SCENES, SCENE_PX, captionFor } from './src/scenes.mjs';
import { DRAWN } from './src/type.mjs';

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
const check = (ok, message) => {
  if (ok) passed += 1;
  else problems.push(message);
  return ok;
};

const DOCS = ['README.md', 'brand-book.md', 'storybook.md', 'details.md', 'art-notes.md'];
const RECORD = 'SH-KIT-PAPER-CERTIFICATES.md';
const BOX_ID = 'paper-certificates';
const COUNT = 1929;
/** The create page takes item pictures of at most one raw block, 1 MiB. */
const ITEM_MAX_BYTES = 1024 * 1024;
/** The registry folder: the repository's, or another folder holding paper-certificates.json, to try a changed row. */
const REGISTRY = process.env.PAPER_CERTIFICATES_REGISTRY
  ? pathToFileURL(`${resolve(process.env.PAPER_CERTIFICATES_REGISTRY)}/`)
  : at('../../../packages/box-spec/examples/v2/');
const GOLD = EDITIONS.gold;
const PAPER = EDITIONS.paper;

/** Width and height from a PNG's IHDR chunk. */
function pngSize(rel) {
  const b = readFileSync(at(rel));
  if (b.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || b.subarray(12, 16).toString() !== 'IHDR') return null;
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

/** What an SVG's root element declares, and whether the file is self-contained and titled. */
function svgFacts(rel) {
  const s = text(rel);
  const head = s.match(/<svg\b[^>]*>/)?.[0] ?? '';
  const num = (name) => Number(head.match(new RegExp(`\\s${name}="(\\d+)"`))?.[1]);
  const external = /<image\b|<text\b|<script\b|<foreignObject\b|<use\b|\bhref=|url\((?!#)|@import|<style\b/i.test(s);
  return { w: num('width'), h: num('height'), viewBox: /viewBox="0 0 \d+ \d+"/.test(head), external, title: /<title>[^<]+<\/title>/.test(s), desc: /<desc>[^<]+<\/desc>/.test(s) };
}

function checkPair(base, w, h) {
  const [png, svg] = [`${base}.png`, `${base}.svg`];
  if (!check(existsSync(at(png)), `missing ${png}`) || !check(existsSync(at(svg)), `missing ${svg}`)) return;
  const size = pngSize(png);
  check(size && size[0] === w && size[1] === h, `${png} is ${size ? size.join('x') : 'not a PNG'}, expected ${w}x${h}`);
  const f = svgFacts(svg);
  check(f.w === w && f.h === h && f.viewBox, `${svg} must declare width ${w}, height ${h} and a viewBox`);
  check(!f.external, `${svg} must not load images, fonts, styles, scripts or outside references`);
  check(f.title && f.desc, `${svg} needs a <title> and a <desc>`);
}

/** Numbered files NN in a folder: returns the sorted numbers and checks they run 01, 02, ... without gaps. */
function numbered(dir, prefix, min, max) {
  const names = existsSync(at(dir)) ? list(dir) : [];
  const nums = [...new Set(names.map((n) => n.match(new RegExp(`^${prefix}-(\\d\\d)\\.(svg|png)$`))?.[1]).filter(Boolean))].sort();
  check(nums.length >= min && nums.length <= max, `${dir}: expected ${min} to ${max} ${prefix} files, found ${nums.length}`);
  check(nums.every((n, i) => n === String(i + 1).padStart(2, '0')), `${dir}: numbering must run 01, 02, ... without gaps`);
  check(names.every((n) => new RegExp(`^${prefix}-\\d\\d\\.(svg|png)$`).test(n)), `${dir} holds files that are not ${prefix}-NN.svg or .png`);
  return nums;
}

function checkFiles() {
  for (const doc of [...DOCS, RECORD]) check(existsSync(at(doc)) && text(doc).trim().length > 200, `missing or empty ${doc}`);
  for (const f of ['assign.mjs', 'assignment.json', 'build-art.mjs', 'check.mjs', '.gitattributes']) check(existsSync(at(f)), `missing ${f}`);
  check(/^art\/\*\* -text$/m.test(text('.gitattributes')) && /^assignment\.json -text$/m.test(text('.gitattributes')), '.gitattributes must mark art/** and assignment.json as -text');
  for (const [base, w, h] of builders()) checkPair(base, w, h);
  check(builders().filter(([b]) => b.includes('/items/')).every(([, w, h]) => w === ITEM_PX && h === ITEM_PX), `item pictures must be ${ITEM_PX} px square`);
  check(builders().filter(([b]) => b.includes('/scenes/')).every(([, w, h]) => w === SCENE_PX && h === SCENE_PX), `scenes must be ${SCENE_PX} px square`);
  const small = existsSync(at('art/logo-48.png')) && pngSize('art/logo-48.png');
  check(small && small[0] === 48 && small[1] === 48, 'art/logo-48.png must be exactly 48x48');
  const items = numbered('art/items', 'variant', 8, 12);
  for (const n of items) {
    const png = at(`art/items/variant-${n}.png`);
    if (existsSync(png)) check(statSync(png).size <= ITEM_MAX_BYTES, `art/items/variant-${n}.png is over 1 MiB, more than the create page takes`);
  }
  const scenes = numbered('art/scenes', 'scene', 5, 7);
  const paperScenes = numbered('art/paper/scenes', 'scene', 5, 7);
  check(paperScenes.join() === scenes.join(), 'art/paper/scenes must hold the same scenes as art/scenes');
  // Nothing else may sit in art/: a stray file would ship without a source. The word-free PNGs in art/reference/ have
  // theirs too: `node build-art.mjs --no-words` builds them from references().
  const expected = new Set([...builders().flatMap(([b]) => [`${b}.svg`, `${b}.png`]), ...references().map(([b]) => `${b}.png`), 'art/logo-48.png']);
  const walk = (dir) => readdirSync(at(dir), { withFileTypes: true }).filter((e) => !OS_FILE.test(e.name)).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
  const stray = walk('art').filter((f) => !expected.has(f));
  check(stray.length === 0, `art/ holds files no source builds: ${stray.join(', ')}`);
  return { items, scenes };
}

/** The hidden picture goes on chain as it is: one line of printable ASCII, at most 4,096 bytes. */
function checkHidden() {
  const svg = hiddenSvg();
  const bytes = Buffer.byteLength(svg, 'utf8');
  check(bytes <= HIDDEN_MAX_BYTES, `the hidden picture is ${bytes} bytes; the on-chain field takes at most ${HIDDEN_MAX_BYTES}`);
  check([...svg].every((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) <= 126), 'the hidden picture must be printable ASCII on one line');
  check(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"') && svg.endsWith('</svg>'), 'the hidden picture must be one bare <svg> element');
  check(text('art/hidden.svg') === svg, 'art/hidden.svg must be exactly the text src/hidden.mjs makes, with no line break added');
}

function checkAssignment(items) {
  let a;
  try {
    a = assignment();
  } catch (error) {
    check(false, `assign.mjs cannot deal the certificates: ${error.message}`);
    return;
  }
  check(text('assignment.json') === `${JSON.stringify(a, null, 2)}\n`, 'assignment.json differs from `node assign.mjs` output');
  check(a.seed === EXAMPLE_SEED && a.example === true, 'assignment.json must be the example, made with the public example seed');
  check(a.items.length === COUNT && a.items.every((it, i) => it.id === String(i + 1)), `the assignment must list ids 1 to ${COUNT} in order`);
  check(a.items.every((it) => items.includes(it.variant) && existsSync(at(it.image))), 'every assigned picture must exist');
  check(a.variants.length === items.length && VARIANT_NAMES.length === items.length && VARIANTS.length === items.length, 'assign.mjs, src/items.mjs and art/items must have the same variants');
  check(a.variants.every((v, i) => v.count === COUNTS[i].toString()), 'each variant must appear exactly as often as COUNTS says');
  check(a.variants.slice(0, 9).every((v) => v.count === '213') && a.variants.slice(9).every((v) => v.count === '4'), 'nine companies of 213 certificates and three blue chips of 4');
  check(COUNTS.reduce((sum, n) => sum + n, 0n) === BigInt(COUNT), `variant counts must add up to ${COUNT}`);
  check(a.specials.label === 'Blue chip' && a.specials.count === '12' && BLUE_CHIPS.join() === '10,11,12', 'the special series is 12 blue chips, variants 10 to 12');
  check(VARIANTS.every((v, i) => v.special === BLUE_CHIPS.includes(v.n) && v.name === VARIANT_NAMES[i]), 'the art must draw the blue chips as the special series, with the names from assign.mjs');
  check(variantFor('1') === a.items[0].variant && variantFor('1929') === a.items[1928].variant, 'variantFor must agree with the assignment');
  check(rankOf('7') === createHash('sha256').update(`${EXAMPLE_SEED}:7`).digest('hex'), 'an id\'s rank must be the SHA-256 of "<seed>:<id>"');
  const other = assignment('a-different-seed-for-the-check-only-0123456789');
  check(other.variants.every((v, i) => v.count === a.variants[i].count), 'every seed must give the same counts');
  check(other.items.some((it, i) => it.variant !== a.items[i].variant), 'a different seed must give a different order');
  check(JSON.stringify(assignment()) === JSON.stringify(a), 'the same seed must give the same order');
  for (const bad of ['0', '1930', '01', '-1', '1.0', '', ' 1', 4, null]) {
    let refused = false;
    try { variantFor(bad); } catch (error) { refused = /^item id must be/.test(error.message); }
    check(refused, `variantFor must refuse ${JSON.stringify(bad)} as an item id`);
  }
  // The real collection's rules: a short seed is refused, the folder needs a secret, and never inside the kit. The
  // inside-kit rule is asked of folderTarget() directly, so a broken rule can never write into the kit.
  const run = (args, extra) => {
    const env = Object.fromEntries(Object.entries({ ...process.env, ...extra }).filter(([, v]) => v !== undefined));
    return spawnSync(process.execPath, [fileURLToPath(at('assign.mjs')), ...args], { env, encoding: 'utf8' });
  };
  check(run([], { PAPER_CERTIFICATES_SEED: 'x'.repeat(MIN_SECRET - 1) }).status !== 0, `assign.mjs must refuse a seed shorter than ${MIN_SECRET} characters`);
  const scratch = mkdtempSync(join(tmpdir(), 'paper-certificates-check-'));
  try {
    const noSecret = run(['--folder', join(scratch, 'out')], { PAPER_CERTIFICATES_SEED: undefined });
    check(noSecret.status !== 0 && !existsSync(join(scratch, 'out')), 'assign.mjs --folder must refuse to run without a secret seed');
    let inside = false;
    try { folderTarget(fileURLToPath(at('private'))); } catch { inside = true; }
    check(inside, 'assign.mjs must refuse a private folder inside the kit');
    check(folderTarget(join(scratch, 'out')).endsWith(`${sep}out`), 'assign.mjs must accept a private folder outside the kit');
    // A real run, cut short with --sample: the command itself works, and writes what the create page reads.
    const secret = 'a-long-seed-for-the-check-only-never-for-a-real-box';
    const sample = run(['--folder', join(scratch, 'sample'), '--sample', '2'], { PAPER_CERTIFICATES_SEED: secret });
    check(sample.status === 0 && sample.stdout === '', `assign.mjs --folder --sample must run and print nothing to stdout (${sample.stderr.trim().slice(0, 120)})`);
    const file = (name) => join(scratch, 'sample', name);
    if (check(existsSync(file('1.png')) && existsSync(file('2.png')) && !existsSync(file('3.png')), 'assign.mjs --sample 2 must write 1.png and 2.png only')) {
      const real = assignment(secret);
      const rows = readFileSync(file('traits.csv'), 'utf8').trim().split('\n');
      check(rows[0] === 'id,Company,Ink,Series' && rows.length === 3, 'traits.csv must have its header and one row per written certificate');
      check(rows.slice(1).every((row, i) => row === `${i + 1},${VARIANT_NAMES[Number(real.items[i].variant) - 1]},${real.variants[Number(real.items[i].variant) - 1].ink},${real.variants[Number(real.items[i].variant) - 1].series}`),
        'traits.csv rows must follow the private assignment');
      check(rows.every((row) => row.split(',').every((cell) => cell.length >= 1 && cell.length <= 255 && /^[\x20-\x7e]+$/.test(cell) && !/["\\]/.test(cell))),
        'traits must fit the on-chain table: printable ASCII without quotes or backslashes, 1 to 255 bytes');
      const priv = JSON.parse(readFileSync(file('assignment.json'), 'utf8'));
      check(priv.seed === 'private' && priv.example === false && priv.items.length === COUNT, 'the private assignment.json must hide the seed and list every id');
      if (Resvg) {
        const v = VARIANTS[Number(real.items[0].variant) - 1];
        check(Buffer.compare(readFileSync(file('1.png')), toPng(Resvg, itemSvg(v, '1'))) === 0, '1.png must be its certificate rendered with the number 1');
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
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

/** A certificate's own number changes only its number box, so the real files differ from the kit's only there. */
function checkNumbers(Resvg) {
  check(serialText(null) === '0' && serialText('1929') === '1,929' && serialText('7') === '7', 'certificate numbers print as 0 for the specimen and as grouped ids such as 1,929');
  let refused = false;
  try { serialText('01'); } catch { refused = true; }
  check(refused, 'a certificate number must be a canonical item id');
  for (const v of [VARIANTS[0], VARIANTS[9]]) {
    const specimen = pixels(Resvg, itemSvg(v));
    const numbered = pixels(Resvg, itemSvg(v, '1929'));
    const { x, y, w, h } = NUMBER_BOX;
    const outside = differences(specimen, numbered, (px, py) => px < x || px >= x + w || py < y || py >= y + h);
    const inside = differences(specimen, numbered, (px, py) => px >= x && px < x + w && py >= y && py < y + h);
    check(outside === 0 && inside > 0, `variant ${v.n}: an item's own number must change its number box and nothing else (${outside} pixels outside)`);
  }
}

/**
 * Every color in every SVG comes from the palette, and only src/palette.mjs defines one. Both the fresh build and the
 * committed file are read, so a hand edit is named for what it is as well as for being stale.
 */
function checkPalette(all) {
  const allowed = new Set([...Object.values(C), ...Object.values(MIX)].map((c) => c.toUpperCase()));
  const committed = all.map(([base]) => [base, text(`${base}.svg`)]).filter(([, svg], i) => svg && svg !== all[i][1]);
  for (const [base, svg] of [...all, ...committed]) {
    const stray = [...new Set((svg.match(/#[0-9A-Fa-f]{6}\b/g) ?? []).map((c) => c.toUpperCase()))].filter((c) => !allowed.has(c));
    check(stray.length === 0, `${base}.svg uses colors outside the palette: ${stray.join(', ')}`);
    check(!/\b(fill|stroke)="(?!none|url\(#)[a-z]+"/i.test(svg), `${base}.svg uses a named color; colors come from src/palette.mjs`);
    check(!/Gradient|filter|opacity|<mask\b/i.test(svg), `${base}.svg uses a gradient, filter, mask or opacity; the art is flat ink and lines only`);
  }
  for (const f of list('src').filter((n) => n !== 'palette.mjs')) {
    check(!/#[0-9A-Fa-f]{6}\b/.test(text(`src/${f}`)), `src/${f} defines a color; colors live in src/palette.mjs`);
  }
  const book = text('brand-book.md');
  for (const [name, hex] of Object.entries(C)) check(book.includes(`\`${hex}\``), `brand-book.md must list the palette color ${name} ${hex}`);
}

/** WCAG 2.2 contrast ratio of two #RRGGBB colors. */
function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The pairs the brand book's accessibility table lists, as [text color, ground color, minimum]. */
const PAIRS = [
  ['ink', 'paper', 4.5], ['ink', 'lilac', 4.5], ['ink', 'vellum', 4.5], ['paper', 'iron', 4.5], ['ink', 'tag', 4.5],
  ['scrip', 'paper', 4.5], ['blue', 'paper', 4.5], ['ink', 'gold', 4.5], ['seal', 'paper', 4.5], ['scrip', 'lilac', 4.5],
  ['bond', 'paper', 4.5], ['goldInk', 'paper', 4.5], ['ink', 'chip', 4.5], ['ink', 'flame', 4.5], ['ink', 'steel', 4.5],
  ['ink', 'wood', 3],
];

function checkContrast() {
  const book = text('brand-book.md');
  for (const [fg, bg, min] of PAIRS) {
    const ratio = contrast(C[fg], C[bg]);
    const shown = `${(Math.floor(ratio * 100) / 100).toFixed(2)}:1`;
    check(book.includes(`| ${shown} |`), `brand-book.md must give ${fg} on ${bg} as ${shown}`);
    check(ratio >= min, `${fg} on ${bg} is ${shown}, below the ${min}:1 the brand book uses it for`);
  }
  check(contrast(C.ink, C.paper) >= 7, 'body text, ink on paper, must reach 7:1');
}

/**
 * The docs say what the registry says. The row is accepted in two forms: pending on V21-02 with its stand-ins (LINK,
 * and items paid in the price coin for the sellers), or ready with items paid in SCRIP for the sellers. Both keep Burn
 * for the buyers. Anything else asks for a review. Skipped when the kit is copied out of the repository.
 */
function checkRegistry() {
  const row = new URL(`${BOX_ID}.json`, REGISTRY);
  if (!existsSync(row)) {
    check(!existsSync(at('../../../packages/box-spec')), `registry: ${BOX_ID}.json is missing from the example registry`);
    return;
  }
  const box = JSON.parse(readFileSync(row, 'utf8'));
  check(box.name === GOLD.name && box.ticker === 'SCRIP', `registry: the box is expected to be ${GOLD.name}, SCRIP; review the kit if that changed`);
  check(box.contents.kind === 'collection' && box.contents.size === String(COUNT) && box.contents.label === 'Certificates' && box.contents.art.mode === 'hidden',
    `registry: a collection of ${COUNT} Certificates with hidden art is expected; review the kit if that changed`);
  check(box.deadline.days === '30' && box.royalties.bps === '0' && box.contents.pickFeeBps === '100' && box.template.id === 'collection-burn',
    'registry: a 30-day deadline, no royalties, a 1% pick fee and the Collection that burns template are expected; review the kit if that changed');
  check(box.fees.buyers.choice === 'burn' && !box.fees.buyers.inside, 'registry: the buyers\' fees must buy SCRIP and burn it; review the kit if that changed');
  const standIn = box.status === 'pending' && box.pendingStep === 'V21-02' && box.priceCoin.symbol === 'LINK'
    && box.fees.sellers.choice === 'items' && box.fees.sellers.inside === 'burn';
  const real = box.status === 'ready' && box.fees.sellers.choice === 'items-t' && box.fees.sellers.inside === 'burn';
  // TA-24: the real gold edition, waiting only for its lives. The gold coin is a name the kit never writes.
  const gold = neverNames(box.priceCoin.symbol).length > 0;
  const kit = box.status === 'pending' && box.pendingStep === 'EXAMPLE-LIFE' && gold && box.fees.sellers.choice === 'items-t' && box.fees.sellers.inside === 'burn';
  check(standIn || kit || real, 'registry: the row is expected to be pending on V21-02 with its stand-ins, pending on EXAMPLE-LIFE on the gold coin, or ready with items paid in SCRIP; review the kit');
  check(!JSON.stringify(box.fees).includes('"eat"') && !box.properties.includes('price-coin-eaten'), 'registry: this box never eats its price coin');
  const details = text('details.md');
  // A price coin the kit never names is shown as "the gold coin" (checked below) instead of its symbol.
  if (gold) check(details.includes('| Price coin | the gold coin, '), 'details.md must show the price coin as the gold coin');
  const facts = [box.name, box.ticker, box.status, box.template.id, box.template.name, ...(gold ? [] : [box.priceCoin.symbol]), box.priceCoin.decimals, box.contents.kind,
    box.contents.size, box.contents.label, box.contents.art.mode, box.contents.pickFeeBps, box.raise.policy, box.deadline.days, box.royalties.bps,
    box.royalties.destination, box.fees.buyers.choice, box.fees.sellers.choice, box.fees.sellers.inside, box.life, ...box.properties];
  for (const fact of facts) check(details.includes(`\`${fact}\``), `details.md must show the registry value \`${fact}\``);
  if (box.status === 'pending') check(details.includes(`\`${box.pendingStep}\``), `details.md must name the pending step \`${box.pendingStep}\``);
  const book = text('brand-book.md');
  check(book.includes(`**Name:** ${GOLD.name}, then ${PAPER.name}.`) && book.includes(`**Ticker:** ${box.ticker}.`), `brand-book.md must name both editions and ${box.ticker}`);
}

/** Storybook: one picture per scene, the gold edition's words, at most two sentences, and the paper edition named. */
function checkStorybook(scenes) {
  const md = text('storybook.md');
  for (const n of scenes) check(md.split(`(art/scenes/scene-${n}.png)`).length === 2, `storybook.md must show art/scenes/scene-${n}.png exactly once`);
  check(md.includes('art/paper/scenes/'), 'storybook.md must point to the paper edition\'s scenes');
  for (const s of SCENES) {
    check(md.includes(`## ${s.n} · ${s.title}\n`), `storybook.md must have the heading "${s.n} · ${s.title}"`);
    check(md.includes(`![${s.alt.replaceAll('${coin}', GOLD.coinName)}](art/scenes/scene-${s.n}.png)`), `storybook.md scene ${s.n} must use the alt text from src/scenes.mjs`);
    for (const line of captionFor(s, GOLD)) check(md.includes(line), `storybook.md scene ${s.n} must say: ${line}`);
    check(s.caption.length <= 2, `scene ${s.n} has more than two caption sentences in src/scenes.mjs`);
    const swapped = captionFor(s, GOLD).map((c) => c.replaceAll(GOLD.coinName, PAPER.coinName).replaceAll('The gold coin', 'The index coin'));
    check(JSON.stringify(captionFor(s, PAPER)) === JSON.stringify(swapped), `scene ${s.n}: the paper edition's caption must differ only in the price coin`);
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
  /\bdividends?\b/i, /\binterest\b/i, /\brewards?\b/i, /\bprizes?\b/i, /\bjackpot\b/i, /\bwealth\b/i, /\bupside\b/i, /\bflywheel\b/i,
  /\bappreciat\w*/i, /\baccru\w*/i, /\bscarc\w*/i, /\bdeflation\w*/i, /\bhodl\b/i, /\bdiamond hands\b/i, /\bbullish\b/i,
  /\brare\b/i, /\brarity\b/i, /\bgrails?\b/i, /\bvaluable\b/i, /\bworth\b/i, /\blottery\b/i, /\bgambl\w*/i, /\bloot\b/i,
  /\bwin(s|ning|ner|ners)?\b/i, /\bluck(y)?\b/i, /\beat(s|en|ing)?\b/i,
  // Square Hole's own token and collection, and the word the founder took out of the UI (F130).
  /\bFIT\b/, /\bmisfits?\b/i, /\bdemo\b/i,
];
const SHAPES = [
  [/—/, 'an em dash'], [/\s–\s/, 'a dash used as a pause'], [/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'an emoji or dingbat'],
  [/0x[0-9a-fA-F]{6,}/, 'an address'], [/\b(19|20)\d\d\b/, 'a year or date'], [/\$\s?\d/, 'a dollar amount'],
  [/\b\d[\d,]*(\.\d+)?\s?(USDC|ETH|USD|LINK|SCRIP)\b/, 'a coin amount'], [/\bnot\b[^.;]*,\s*but\b/i, 'a "not X, but Y" turn'],
];
/** A stock or the gold coin is never burned, and no text may say it is. A sentence that says "never" or "not" may. */
const BURNS_COIN = [
  /\bburn(s|ed|ing|t)?\s+(the\s+|a\s+|any\s+|some\s+)?(gold|stocks?|index coin|price coin)\b/i,
  /\b(gold|gold coin|stocks?|index coin|price coin)(\s+itself)?\s+(is|are|was|were|gets|get|be|been)\s+(burned|burnt|eaten)\b/i,
];
/**
 * Names the kit never writes: the gold coin's and the index coin's own names and tickers, their issuers, the index and
 * the fund behind it, and the big exchanges. Kept as the first 16 hex digits of each lowercase word's or word pair's
 * SHA-256, so this file never spells them either.
 */
const NEVER = new Set([
  'ba3c96e4ae07bc01', '9f7ec935a5879e86', '8ab9c38f2a391c77', '3dc7089d175e3fa1', '64129b6e11a4b70d', '57d4aa377250296d',
  '5575e723ae5922fd', 'e745a89c9d21314a', '28dbbd1da91e8266', 'fc1b192ed5829737', 'e883da666daa0aba', '96169bd53e5b6a32',
  'a2d990b6032c4640', '6646a7440929f1f3', 'c3290277734d0521',
]);
const fingerprint = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/**
 * The words and word pairs of a text that match a name the kit never writes. In source code, pairs with a one-letter
 * word are skipped, because variable names like `s` and `p` sit next to each other all the time.
 */
function neverNames(raw, { code = false } = {}) {
  const words = raw.toLowerCase().match(/[a-z]+/g) ?? [];
  const hits = [];
  words.forEach((w, i) => {
    if (NEVER.has(fingerprint(w))) hits.push(w);
    const next = words[i + 1];
    if (next !== undefined && !(code && (w.length === 1 || next.length === 1)) && NEVER.has(fingerprint(`${w} ${next}`))) hits.push(`${w} ${next}`);
  });
  return hits;
}

/** The rules apply to every doc, to the titles and descriptions inside the SVGs and to every drawn word. */
function checkWords(all) {
  const sources = [...DOCS, RECORD].map((d) => [d, text(d)]);
  for (const [base, svg] of all) sources.push([`${base}.svg`, (svg.match(/<(title|desc)>[^<]*<\/\1>/g) ?? []).join('\n')]);
  for (const [base, , , build] of builders()) {
    DRAWN.length = 0;
    build();
    sources.push([`${base} lettering`, DRAWN.map((w) => w.text).join('\n')]);
  }
  for (const f of [...list('src').map((n) => `src/${n}`), 'assign.mjs', 'build-art.mjs', 'check.mjs']) {
    const hits = neverNames(text(f), { code: true });
    check(hits.length === 0, `${f} names something the kit never names (${hits.length} hit${hits.length === 1 ? '' : 's'})`);
  }
  for (const [name, raw] of sources) {
    const hits = neverNames(raw);
    check(hits.length === 0, `${name} names something the kit never names (${hits.length} hit${hits.length === 1 ? '' : 's'}); say "the gold coin" or "the index coin"`);
    const parts = raw.split(AVOID_START);
    const body = [parts[0], ...parts.slice(1).map((part) => part.split(AVOID_END).slice(1).join(''))].join('\n');
    const issues = [];
    const strip = (line) => line.replace(/\]\([^)]*\)/g, ']').replace(/`[^`]*`/g, '');
    // Single words line by line, so a failure names its line.
    body.split('\n').forEach((line, i) => {
      const clean = strip(line);
      const where = `${name}:${i + 1}`;
      for (const re of BANNED.filter((r) => !r.source.includes(' '))) if (re.test(clean)) issues.push(`${where} uses a word the kit avoids (${re.source}): ${line.trim().slice(0, 90)}`);
      for (const [re, what] of SHAPES) if (re.test(clean)) issues.push(`${where} contains ${what}: ${line.trim().slice(0, 90)}`);
    });
    // Phrases and whole sentences across line breaks, so wrapping a line cannot hide them.
    const joined = body.split('\n').map(strip).join(' ').replace(/\s+/g, ' ');
    for (const re of BANNED.filter((r) => r.source.includes(' '))) if (re.test(joined)) issues.push(`${name} uses a phrase the kit avoids (${re.source})`);
    for (const sentence of joined.split(/(?<=[.!?|])\s+/)) {
      if (BURNS_COIN.some((re) => re.test(sentence)) && !/\b(never|not|no)\b/i.test(sentence)) issues.push(`${name} says a stock or the gold coin is burned: ${sentence.trim().slice(0, 90)}`);
    }
    if (issues.length) problems.push(...issues);
    else passed += 1;
  }
  const book = text('brand-book.md');
  for (const e of [GOLD, PAPER]) {
    const cover = coverSentence(e);
    check(book.includes(`"${cover}"`), `brand-book.md must carry the ${e.name} cover line "${cover}"`);
  }
  check(book.includes(`**Cover line:** "${coverSentence(GOLD)}"`) && book.includes(`| Cover | "${coverSentence(GOLD)}" |`), 'brand-book.md must carry the gold cover line in Identity and in the example lines');
  check(book.includes(`**The literal line next to it:** "${LITERAL_LINE}"`) && book.includes(`| Literal line | "${LITERAL_LINE}" |`),
    'brand-book.md must carry the literal line next to the cover line, in Identity and in the example lines');
  check(text('README.md').includes('the gold coin') && text('details.md').includes('the gold coin') && text('details.md').includes('the index coin'),
    'README.md and details.md must call the price coins "the gold coin" and "the index coin"');
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
  for (const name of list('./').filter((n) => !n.startsWith('.') || n === '.gitattributes')) check(readme.includes(name), `README.md does not list ${name}`);
  for (const [base] of builders()) {
    if (/\/(items|scenes)\//.test(base)) continue;
    check(readme.includes(`${base}.png`), `README.md does not list ${base}.png`);
  }
  check(readme.includes('art/logo-48.png') && readme.includes('art/paper/scenes/'), 'README.md must name art/logo-48.png and the paper edition\'s scenes');
  check(readme.includes(`variant-${items.at(-1)}`) && readme.includes(`scene-${scenes.at(-1)}`), 'README.md must name the last variant and the last scene');
  for (const f of list('src')) check(text('art-notes.md').includes(`src/${f}`), `src/${f} is not described in art-notes.md`);
  VARIANT_NAMES.forEach((name, i) => check(readme.includes(`| ${String(i + 1).padStart(2, '0')} | ${name} |`), `README.md must name the variant ${name} in its table`));
}

/** Words stay clear of the edges: 60 px on the X banners, 48 px everywhere else. */
function checkMargins() {
  for (const [base, w, h, build] of builders()) {
    DRAWN.length = 0;
    build();
    const edge = /x-banner$/.test(base) ? 60 : 48;
    for (const { text: words, box } of DRAWN) {
      const ok = box.x >= edge && box.y >= edge && box.x + box.w <= w - edge && box.y + box.h <= h - edge;
      check(ok, `${base}: "${words}" comes within ${edge} px of an edge (box ${Math.round(box.x)}, ${Math.round(box.y)}, ${Math.round(box.w)} x ${Math.round(box.h)})`);
    }
  }
}

/** The mark keeps 2 modules of bare paper on every side and sits inside 95% of a round crop. */
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

/** Each X banner's bottom-left corner is its bare ground, so the avatar can overlap it. */
function checkCorner(Resvg) {
  for (const e of [GOLD, PAPER]) {
    const art = pixels(Resvg, xBannerSvg(e));
    const bare = pixels(Resvg, xBannerBareSvg(e));
    const { x: cx, y: cy, w: cw, h: ch } = AVATAR_CORNER;
    const n = differences(art, bare, (x, y) => x >= cx && x < cx + cw && y >= cy && y < cy + ch);
    check(n === 0, `${e.dir}/x-banner: ${n} pixels in the avatar corner (x ${cx} to ${cx + cw}, y ${cy} to ${cy + ch}) differ from the bare ground`);
  }
}

/** The committed SVGs are what src/ builds today, and each PNG is that SVG rendered. */
function checkFresh(Resvg, all) {
  for (const [base, svg] of all) {
    check(text(`${base}.svg`) === svg, `${base}.svg is not what src/ builds; run node build-art.mjs`);
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
checkHidden();
checkAssignment(items);
checkPalette(all);
checkContrast();
checkRegistry();
checkStorybook(scenes);
checkWords(all);
checkReadme(items, scenes);
checkLinks();
checkMargins();
if (Resvg) {
  checkNumbers(Resvg);
  checkMark(Resvg);
  checkCorner(Resvg);
}
checkFresh(Resvg, all);

if (problems.length) {
  process.stderr.write(`${problems.map((p) => `FAIL ${p}`).join('\n')}\n${problems.length} problem(s), ${passed} checks passed\n`);
  process.exit(1);
}
process.stdout.write(`ok: ${passed} checks passed (${items.length} variants, ${scenes.length} scenes in each edition, ${COUNT} certificates)\n`);
