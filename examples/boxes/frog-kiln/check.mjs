/**
 * Checks the Frog Kiln kit: every required file is here with its exact pixel size, every PNG has its SVG source and
 * is a fresh render of it, the hidden picture fits the on-chain field, assignment.json is exactly what assign.mjs
 * prints and the secret-seed rules hold, the mark keeps its clear space and fits a round crop, the X banner keeps its
 * avatar corner bare, words stay clear of the edges, the palette and contrast numbers are right, the storybook matches
 * the scenes, the docs match the registry settings, and the kit's words follow the brand rules. No network.
 *
 *   node check.mjs        exit 0 when everything passes, 1 otherwise
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assignment, folderTarget, variantFor, rankOf, VARIANT_NAMES, CRACKED, COUNTS, EXAMPLE_SEED, MIN_SECRET } from './assign.mjs';
import { pieces, builders } from './build-art.mjs';
import { SCENES, SCENE_PX } from './src/scenes.mjs';
import { ITEM_PX, VARIANTS } from './src/items.mjs';
import { logoSvg, avatarSvg, markBareSvg, xBannerSvg, xBannerBareSvg, AVATAR_CORNER, MARK_GRID, MARK_CLEAR, COVER_LINE, LITERAL_LINE } from './src/brand.mjs';
import { hiddenSvg, HIDDEN_MAX_BYTES } from './src/hidden.mjs';
import { loadResvg, toPng, pixels } from './src/render.mjs';
import { DRAWN } from './src/type.mjs';
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
const RECORD = 'SH-KIT-FROG-KILN.md';
const FIXED = [
  ['art/logo', 1024, 1024], ['art/x-avatar', 400, 400], ['art/x-banner', 1500, 500],
  ['art/cover', 1200, 630], ['art/box-banner', 2400, 600], ['art/hidden', 1024, 1024],
];
/** The create page takes item pictures of at most one raw block, 1 MiB. */
const ITEM_MAX_BYTES = 1024 * 1024;
/** The registry folder: the repository's, or another folder holding frog-kiln.json, to try a changed row. */
const REGISTRY = process.env.FROG_KILN_REGISTRY
  ? pathToFileURL(`${resolve(process.env.FROG_KILN_REGISTRY)}/`)
  : at('../../../packages/box-spec/examples/v2/');
const BOX_ID = 'frog-kiln';
const COUNT = 420;

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
  for (const [base, w, h] of FIXED) checkPair(base, w, h);
  const small = existsSync(at('art/logo-48.png')) && pngSize('art/logo-48.png');
  check(small && small[0] === 48 && small[1] === 48, 'art/logo-48.png must be exactly 48x48');
  const items = numbered('art/items', 'variant', 8, 12);
  for (const n of items) {
    checkPair(`art/items/variant-${n}`, ITEM_PX, ITEM_PX);
    const png = at(`art/items/variant-${n}.png`);
    if (existsSync(png)) check(statSync(png).size <= ITEM_MAX_BYTES, `art/items/variant-${n}.png is over 1 MiB, more than the create page takes`);
  }
  const scenes = numbered('art/scenes', 'scene', 5, 7);
  for (const n of scenes) checkPair(`art/scenes/scene-${n}`, SCENE_PX, SCENE_PX);
  return { items, scenes };
}

/** The hidden picture goes on chain as it is: one line of printable ASCII, at most 4,096 bytes. */
function checkHidden() {
  const svg = hiddenSvg();
  const bytes = Buffer.byteLength(svg, 'utf8');
  check(bytes <= HIDDEN_MAX_BYTES, `the hidden picture is ${bytes} bytes; the on-chain field takes at most ${HIDDEN_MAX_BYTES}`);
  check([...svg].every((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) <= 126), 'the hidden picture must be printable ASCII on one line, as the on-chain SVG rule asks');
  check(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"') && svg.endsWith('</svg>'), 'the hidden picture must be one bare <svg> element');
  check(text('art/hidden.svg') === svg, 'art/hidden.svg must be exactly the text src/hidden.mjs makes, with no line break added');
}

function checkAssignment(items) {
  const a = assignment();
  check(existsSync(at('assignment.json')) && text('assignment.json') === `${JSON.stringify(a, null, 2)}\n`, 'assignment.json differs from `node assign.mjs` output');
  check(a.seed === EXAMPLE_SEED && a.example === true, 'assignment.json must be the example, made with the public example seed');
  check(a.items.length === COUNT && a.items.every((it, i) => it.id === String(i + 1)), `assignment must list ids 1 to ${COUNT} in order`);
  check(a.items.every((it) => items.includes(it.variant) && existsSync(at(it.image))), 'every assigned picture must exist');
  check(a.variants.length === items.length && VARIANT_NAMES.length === items.length && VARIANTS.length === items.length, 'assign.mjs, src/items.mjs and art/items must have the same variants');
  check(a.variants.every((v, i) => v.count === COUNTS[i].toString()), 'each variant must appear exactly as often as COUNTS says');
  check(a.variants.slice(0, 9).every((v) => v.count === '44') && a.variants.slice(9).every((v) => v.count === '8'), 'nine glazes of 44 toads and three cracked toads of 8');
  check(COUNTS.reduce((sum, n) => sum + n, 0n) === BigInt(COUNT), `variant counts must add up to ${COUNT}`);
  check(a.specials.label === 'Cracked' && a.specials.count === '24' && CRACKED.join() === '10,11,12', 'the special series is 24 cracked toads, variants 10 to 12');
  check(variantFor('1') === a.items[0].variant && variantFor('420') === a.items[419].variant, 'variantFor must agree with the assignment');
  check(rankOf('7') === createHash('sha256').update(`${EXAMPLE_SEED}:7`).digest('hex'), 'an id\'s rank must be the SHA-256 of "<seed>:<id>"');
  // Another seed gives a different order with the same counts; the same seed always gives the same order.
  const other = assignment('a-different-seed-for-the-check-only-0123456789');
  check(other.variants.every((v, i) => v.count === a.variants[i].count), 'every seed must give the same counts');
  check(other.items.some((it, i) => it.variant !== a.items[i].variant), 'a different seed must give a different order');
  check(JSON.stringify(assignment()) === JSON.stringify(a), 'the same seed must give the same order');
  for (const bad of ['0', '421', '01', '-1', '1.0', '', ' 1', 4, null]) {
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
  check(run([], { FROG_KILN_SEED: 'x'.repeat(MIN_SECRET - 1) }).status !== 0, `assign.mjs must refuse a seed shorter than ${MIN_SECRET} characters`);
  const scratch = mkdtempSync(join(tmpdir(), 'frog-kiln-check-'));
  try {
    const noSecret = run(['--folder', join(scratch, 'out')], { FROG_KILN_SEED: undefined });
    check(noSecret.status !== 0 && !existsSync(join(scratch, 'out')), 'assign.mjs --folder must refuse to run without a secret seed');
    let inside = false;
    try { folderTarget(fileURLToPath(at('private'))); } catch { inside = true; }
    check(inside, 'assign.mjs must refuse a private folder inside the kit');
    check(folderTarget(join(scratch, 'out')).endsWith(`${sep}out`), 'assign.mjs must accept a private folder outside the kit');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Every color in every SVG comes from the palette, and only src/palette.mjs defines one. */
function checkPalette() {
  const allowed = new Set([...Object.values(C), ...Object.values(MIX)].map((c) => c.toUpperCase()));
  for (const [base, svg] of pieces()) {
    const stray = [...new Set((svg.match(/#[0-9A-Fa-f]{6}\b/g) ?? []).map((c) => c.toUpperCase()))].filter((c) => !allowed.has(c));
    check(stray.length === 0, `${base}.svg uses colors outside the palette: ${stray.join(', ')}`);
    check(!/\b(fill|stroke|stop-color)="(?!none|url\(#)[a-z]+"/i.test(svg), `${base}.svg uses a named color; colors come from src/palette.mjs`);
    check(!/Gradient|filter=|opacity/i.test(svg), `${base}.svg uses a gradient, filter or opacity; the art is flat glaze only`);
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
  ['soot', 'bisque', 4.5], ['bisque', 'slab', 4.5], ['soot', 'celadon', 4.5], ['soot', 'ember', 4.5], ['soot', 'gold', 4.5],
  ['ember', 'slab', 4.5], ['bisque', 'brick', 4.5], ['soot', 'ash', 4.5], ['soot', 'frog', 4.5],
  ['soot', 'flame', 3], ['soot', 'clay', 3], ['soot', 'pond', 3], ['soot', 'wood', 3],
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
 * The docs say what the registry says. The row is accepted in one of three forms (TA-24 added the second): pending on V21-02 with its
 * stand-in recipe (LINK, Burn for the buyers, items paid in the price coin for the sellers), or ready with Eat for
 * the buyers and items paid in KILN for the sellers. Anything else asks for a review. Skipped when the kit is copied
 * out of the repository.
 */
function checkRegistry() {
  const row = new URL(`${BOX_ID}.json`, REGISTRY);
  if (!existsSync(row)) {
    check(!existsSync(at('../../../packages/box-spec')), 'registry: frog-kiln.json is missing from the example registry');
    return;
  }
  const box = JSON.parse(readFileSync(row, 'utf8'));
  check(box.name === 'Frog Kiln' && box.ticker === 'KILN', 'registry: the box is expected to be Frog Kiln, KILN; review the kit if that changed');
  check(box.contents.kind === 'collection' && box.contents.size === String(COUNT) && box.contents.label === 'Toads' && box.contents.art.mode === 'hidden',
    `registry: a collection of ${COUNT} Toads with hidden art is expected; review the kit if that changed`);
  check(box.deadline.days === '30' && box.royalties.bps === '0' && box.contents.pickFeeBps === '100' && box.template.id === 'collection-burn',
    'registry: a 30-day deadline, no royalties, a 1% pick fee and the Collection that burns template are expected; review the kit if that changed');
  const standIn = box.status === 'pending' && box.pendingStep === 'V21-02' && box.priceCoin.symbol === 'LINK'
    && box.fees.buyers.choice === 'burn' && box.fees.sellers.choice === 'items' && box.fees.sellers.inside === 'burn';
  // TA-24: the real fees on a LINK stand-in, waiting only for its lives and the frog coin's listing.
  const kit = box.status === 'pending' && box.pendingStep === 'EXAMPLE-LIFE' && box.priceCoin.symbol === 'LINK' && box.fees.buyers.choice === 'eat'
    && box.fees.sellers.choice === 'items-t' && box.fees.sellers.inside === 'burn' && box.properties.includes('price-coin-eaten');
  const real = box.status === 'ready' && box.fees.buyers.choice === 'eat' && box.fees.sellers.choice === 'items-t' && box.fees.sellers.inside === 'burn'
    && box.properties.includes('price-coin-eaten');
  check(standIn || kit || real, 'registry: the row is expected to be pending on V21-02 with its stand-in recipe, pending on EXAMPLE-LIFE or ready with Eat and items paid in KILN; review the kit');
  const details = text('details.md');
  const facts = [box.name, box.ticker, box.status, box.template.id, box.template.name, box.priceCoin.symbol, box.priceCoin.decimals, box.contents.kind,
    box.contents.size, box.contents.label, box.contents.art.mode, box.contents.pickFeeBps, box.raise.policy, box.deadline.days, box.royalties.bps,
    box.royalties.destination, box.fees.buyers.choice, box.fees.sellers.choice, box.fees.sellers.inside, box.life, ...box.properties];
  for (const fact of facts) check(details.includes(`\`${fact}\``), `details.md must show the registry value \`${fact}\``);
  if (box.status === 'pending') check(details.includes(`\`${box.pendingStep}\``), `details.md must name the pending step \`${box.pendingStep}\``);
  const book = text('brand-book.md');
  check(book.includes(`**Name:** ${box.name}.`) && book.includes(`**Ticker:** ${box.ticker}.`), `brand-book.md must name ${box.name} and ${box.ticker}`);
}

/** Storybook: one picture per scene, each referenced once, at most two sentences under it, same words as src. */
function checkStorybook(scenes) {
  const md = text('storybook.md');
  for (const n of scenes) check(md.split(`art/scenes/scene-${n}.png`).length === 2, `storybook.md must show art/scenes/scene-${n}.png exactly once`);
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
  /\brare\b/i, /\brarity\b/i, /\bgrails?\b/i, /\bvaluable\b/i, /\bworth\b/i, /\blottery\b/i, /\bgambl\w*/i, /\bloot\b/i,
  // Square Hole's own token and collection, and the word the founder took out of the UI (F130).
  /\bFIT\b/, /\bmisfits?\b/i, /\bdemo\b/i,
];
const SHAPES = [
  [/—/, 'an em dash'], [/\s–\s/, 'a dash used as a pause'], [/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'an emoji or dingbat'],
  [/0x[0-9a-fA-F]{6,}/, 'an address'], [/\b(19|20)\d\d\b/, 'a year or date'], [/\$\s?\d/, 'a dollar amount'],
  [/\b\d[\d,]*(\.\d+)?\s?(USDC|ETH|USD|LINK|KILN)\b/, 'a coin amount'], [/\bnot\b[^.;]*,\s*but\b/i, 'a "not X, but Y" turn'],
];
/**
 * Names the kit never writes: the price coin's own name and ticker, known frog characters and their creators, and a
 * famous toad collection. Kept as the first 16 hex digits of each lowercase word's or word pair's SHA-256, so this
 * file never spells them either.
 */
const NEVER = new Set([
  '7c9e7c1494b2684a', '06ab259ac4a6ed3d', '8d34213794ea9c19', 'a3d92ef00ea150eb', 'f14fa2421fb2351e', '609f2f664a840a79',
  'da38a069467b80b1', '6ff527d141d8fe2a', 'c4edbf09a5a09796', '010d93fae88e4eb6', '4c1e98ff8768faa0', '988384101f66d24d',
  'ada0a0aed9aed0c4', '86e1925dae1c1bc9', '12f32d6b7bb8df7d', '89137a3b3f45ab13', '8f68bb09da5c044c', 'cfb0b6d4ebbe3550',
  'ede077bf4a7d69da', 'f49142c5bf4090fc', '448d6731ee98ea8d', 'efaa37c791c7e79f', '90abf75ac5c492f5', '646d561580080404',
  'def60137a98004fe', '710bdb486eb11d8b', '6f68bd8ab2e49c2c', 'c207745de477c139', 'ad180ab7e1eb7dca', '68780dfe18410fb3',
  '05ecebf75eb85142', '1d8199e6fbf57363',
]);
const fingerprint = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** The words and word pairs of a text that match a name the kit never writes. */
function neverNames(raw) {
  const words = raw.toLowerCase().match(/[a-z]+/g) ?? [];
  const hits = [];
  words.forEach((w, i) => {
    if (NEVER.has(fingerprint(w))) hits.push(w);
    if (i + 1 < words.length && NEVER.has(fingerprint(`${w} ${words[i + 1]}`))) hits.push(`${w} ${words[i + 1]}`);
  });
  return hits;
}

/** The rules apply to every doc in the kit, to the titles and descriptions inside the SVGs and to every drawn word. */
function checkWords() {
  const sources = [...DOCS, RECORD].map((d) => [d, text(d)]);
  const svgs = ['art', 'art/items', 'art/scenes'].filter((dir) => existsSync(at(dir)))
    .flatMap((dir) => list(dir).filter((n) => n.endsWith('.svg')).map((n) => `${dir}/${n}`));
  for (const f of svgs) sources.push([f, (text(f).match(/<(title|desc)>[^<]*<\/\1>/g) ?? []).join(' ')]);
  for (const [base, build] of builders()) {
    DRAWN.length = 0;
    build();
    sources.push([`${base} lettering`, DRAWN.map((w) => w.text).join('\n')]);
  }
  for (const f of [...list('src').map((n) => `src/${n}`), 'assign.mjs', 'build-art.mjs', 'check.mjs']) {
    const hits = neverNames(text(f));
    check(hits.length === 0, `${f} names something the kit never names (${hits.length} hit${hits.length === 1 ? '' : 's'})`);
  }
  for (const [name, raw] of sources) {
    const hits = neverNames(raw);
    check(hits.length === 0, `${name} names something the kit never names (${hits.length} hit${hits.length === 1 ? '' : 's'}); call the price coin "the frog coin"`);
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
  const book = text('brand-book.md');
  const joined = COVER_LINE.join(' ');
  const cover = joined[0] + joined.slice(1).toLowerCase();
  check(book.includes(`**Cover line:** "${cover}"`) && book.includes(`| Cover | "${cover}" |`), `brand-book.md must carry the cover line "${cover}" in Identity and in the example lines`);
  check(book.includes(`**The literal line next to it:** "${LITERAL_LINE}"`) && book.includes(`| Literal line | "${LITERAL_LINE}" |`),
    'brand-book.md must carry the literal line next to the cover line, in Identity and in the example lines');
  check(text('README.md').includes('the frog coin') && text('details.md').includes('the frog coin'), 'README.md and details.md must call the price coin "the frog coin"');
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
  VARIANT_NAMES.forEach((v, i) => check(readme.includes(`| ${String(i + 1).padStart(2, '0')} | ${v} |`), `README.md must name the variant ${v} in its table`));
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

/** The X banner's bottom-left corner is the bare ground, so the avatar can overlap it. */
function checkCorner(Resvg) {
  const art = pixels(Resvg, xBannerSvg());
  const bare = pixels(Resvg, xBannerBareSvg());
  const { x: cx, y: cy, w: cw, h: ch } = AVATAR_CORNER;
  const n = differences(art, bare, (x, y) => x >= cx && x < cx + cw && y >= cy && y < cy + ch);
  check(n === 0, `x-banner: ${n} pixels in the avatar corner (x ${cx} to ${cx + cw}, y ${cy} to ${cy + ch}) differ from the bare ground`);
}

/** The committed SVGs are what src/ builds today, and each PNG is that SVG rendered. */
function checkFresh(Resvg) {
  for (const [base, svg] of pieces()) {
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

const { items, scenes } = checkFiles();
checkHidden();
checkAssignment(items);
checkPalette();
checkContrast();
checkRegistry();
checkStorybook(scenes);
checkWords();
checkReadme(items, scenes);
checkLinks();
checkMargins();
if (Resvg) {
  checkMark(Resvg);
  checkCorner(Resvg);
}
checkFresh(Resvg);

if (problems.length) {
  process.stderr.write(`${problems.map((p) => `FAIL ${p}`).join('\n')}\n${problems.length} problem(s), ${passed} checks passed\n`);
  process.exit(1);
}
process.stdout.write(`ok: ${passed} checks passed (${items.length} variants, ${scenes.length} scenes, ${COUNT} toads)\n`);
