/**
 * Checks the Link Marines kit: every required file is here with its exact pixel size, every PNG has its SVG source
 * and is a fresh render of it, assignment.json is exactly what assign.mjs prints, the mark keeps its clear space and
 * fits a round crop, the X banner keeps its avatar corner bare, words stay clear of the edges, the palette holds no
 * blue, the brand book's contrast numbers are right, the storybook matches the scenes, the docs match the registry
 * settings, and the kit's words follow the brand rules. No network.
 *
 *   node check.mjs        exit 0 when everything passes, 1 otherwise
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assignment, variantFor, squadFor, VARIANT_NAMES } from './assign.mjs';
import { pieces, builders } from './build-art.mjs';
import { SCENES } from './src/scenes.mjs';
import { logoSvg, avatarSvg, markBareSvg, xBannerSvg, xBannerBareSvg, AVATAR_CORNER, MARK_GRID, MARK_CLEAR, COVER_LINE } from './src/brand.mjs';
import { loadResvg, toPng } from './src/render.mjs';
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
const RECORD = 'SH-KIT-LINK-MARINES.md';
const FIXED = [
  ['art/logo', 1024, 1024], ['art/x-avatar', 400, 400], ['art/x-banner', 1500, 500],
  ['art/cover', 1200, 630], ['art/box-banner', 2400, 600],
];
const ITEM_PX = 1024;
const SCENE_PX = 1200;
/** The registry folder: the repository's, or another folder holding link-marines.json, to try a changed row. */
const REGISTRY = process.env.LINK_MARINES_REGISTRY
  ? pathToFileURL(`${resolve(process.env.LINK_MARINES_REGISTRY)}/`)
  : at('../../../packages/box-spec/examples/v2/');
const BOX_ID = 'link-marines';
const COUNT = 420;
/** The ticker the founder chose (2026-10-23), as the registry has it. */
const TICKER = 'MARINE';

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
  for (const n of items) checkPair(`art/items/variant-${n}`, ITEM_PX, ITEM_PX);
  const scenes = numbered('art/scenes', 'scene', 5, 7);
  for (const n of scenes) checkPair(`art/scenes/scene-${n}`, SCENE_PX, SCENE_PX);
  return { items, scenes };
}

function checkAssignment(items) {
  const a = assignment();
  check(existsSync(at('assignment.json')) && text('assignment.json') === `${JSON.stringify(a, null, 2)}\n`, 'assignment.json differs from `node assign.mjs` output');
  check(a.items.length === COUNT && a.items.every((it, i) => it.id === String(i + 1)), `assignment must list ids 1 to ${COUNT} in order`);
  check(a.items.every((it) => items.includes(it.variant) && existsSync(at(it.image))), 'every assigned picture must exist');
  check(a.variants.length === items.length && VARIANT_NAMES.length === items.length, 'assign.mjs must name exactly the variants in art/items');
  check(a.variants.reduce((sum, v) => sum + BigInt(v.count), 0n) === BigInt(COUNT), `variant counts must add up to ${COUNT}`);
  check(a.variants.every((v) => v.count === String(COUNT / items.length)), `every picture must appear ${COUNT / items.length} times, so none is rarer`);
  check(variantFor('1') === '01' && variantFor('12') === '12' && variantFor('13') === '01' && variantFor('420') === '12', 'marine #1 shows 01, #13 starts again at 01, and #420 shows 12');
  check(squadFor('1') === '1' && squadFor('12') === '1' && squadFor('13') === '2' && squadFor('420') === '35' && a.squads === '35', 'marines 1 to 12 are squad 1, 13 starts squad 2, and 420 closes squad 35');
  const squads = new Map();
  for (const it of a.items) squads.set(it.squad, [...(squads.get(it.squad) ?? []), it.variant]);
  check(squads.size === COUNT / items.length && [...squads.values()].every((vs) => new Set(vs).size === items.length), 'every squad must hold one marine of each kind');
  for (const bad of ['0', '421', '01', '-1', '1.0', '', ' 1', 4, null]) {
    let threw = false;
    try { variantFor(bad); } catch { threw = true; }
    check(threw, `variantFor must refuse ${JSON.stringify(bad)}`);
  }
}

/** Hue in degrees and saturation (0 to 1) of a #RRGGBB color. */
function hueSat(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d === 0) return [0, 0];
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s];
}

/** Every color in every SVG comes from the palette, the palette holds no blue, and only src/palette.mjs defines one. */
function checkPalette() {
  const allowed = new Set([...Object.values(C), ...Object.values(MIX)].map((c) => c.toUpperCase()));
  for (const [base, svg] of pieces()) {
    const stray = [...new Set((svg.match(/#[0-9A-Fa-f]{6}\b/g) ?? []).map((c) => c.toUpperCase()))].filter((c) => !allowed.has(c));
    check(stray.length === 0, `${base}.svg uses colors outside the palette: ${stray.join(', ')}`);
    check(!/\b(fill|stroke|stop-color)="(?!none|url\(#)[a-z]+"/i.test(svg), `${base}.svg uses a named color; colors come from src/palette.mjs`);
  }
  for (const [name, hex] of [...Object.entries(C), ...Object.entries(MIX)]) {
    const [h, s] = hueSat(hex);
    // The price coin's project owns a blue look; the kit keeps every blue and cyan out, even as a shade.
    check(!(h >= 170 && h <= 265 && s > 0.12), `palette color ${name} ${hex} is blue (hue ${Math.round(h)}); the kit uses no blue`);
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
  ['ink', 'paper', 4.5], ['paper', 'night', 4.5], ['ink', 'gold', 4.5], ['ink', 'khaki', 4.5], ['gold', 'night', 4.5],
  ['ink', 'steel', 4.5], ['ink', 'sage', 4.5], ['paper', 'olive', 4.5], ['ink', 'crate', 4.5], ['ink', 'orange', 4.5],
  ['gold', 'olive', 3], ['khaki', 'olive', 3],
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
 * The docs say what the registry says. The row is accepted in one of its two known states: pending with Burn as its
 * starting recipe (main today), or ready with Eat on both sides (v2.1 step 1). Anything else asks for a review.
 * Skipped when the kit is copied out of the repository.
 */
function checkRegistry() {
  const row = new URL(`${BOX_ID}.json`, REGISTRY);
  if (!existsSync(row)) return;
  const box = JSON.parse(readFileSync(row, 'utf8'));
  check(box.name === 'Link Marines' && box.contents.kind === 'collection' && box.contents.size === String(COUNT) && box.contents.label === 'Marines',
    `registry: ${BOX_ID} is expected to be a collection of ${COUNT} Marines; review the kit if that changed`);
  check(box.priceCoin.symbol === 'LINK' && box.priceCoin.decimals === '18', 'registry: the price coin is expected to be LINK with 18 decimals; review the kit if that changed');
  check(box.deadline.days === '90' && box.royalties.bps === '0' && box.contents.art.mode === 'open' && box.contents.pickFeeBps === '100',
    'registry: a 90-day deadline, no royalties, open art and a 1% pick fee are expected; review the kit if that changed');
  const pending = box.status === 'pending' && box.pendingStep === 'V21-01-EAT' && box.fees.buyers.choice === 'burn' && box.fees.sellers.choice === 'burn';
  const eating = box.status === 'ready' && box.fees.buyers.choice === 'eat' && box.fees.sellers.choice === 'eat' && box.properties.includes('price-coin-eaten');
  check(pending || eating, 'registry: the row is expected to be pending on V21-01-EAT with Burn, or ready with Eat on both sides; review the kit');
  const details = text('details.md');
  const facts = [box.name, box.ticker, box.status, box.template.id, box.template.name, box.priceCoin.symbol, box.priceCoin.decimals, box.contents.kind,
    box.contents.size, box.contents.label, box.contents.art.mode, box.contents.pickFeeBps, box.raise.policy, box.deadline.days, box.royalties.bps,
    box.royalties.destination, box.fees.buyers.choice, box.fees.sellers.choice, box.life, ...box.properties];
  for (const fact of facts) check(details.includes(`\`${fact}\``), `details.md must show the registry value \`${fact}\``);
  if (box.status === 'pending') check(details.includes(`\`${box.pendingStep}\``), `details.md must name the pending step \`${box.pendingStep}\``);
  const book = text('brand-book.md');
  check(box.ticker === TICKER, `registry: the ticker is expected to be ${TICKER}; review the kit if that changed`);
  check(book.includes(`**Name:** ${box.name}.`) && book.includes(`**Ticker:** ${TICKER}`) && book.includes(`\`${box.ticker}\``), `brand-book.md must name ${box.name} and the ticker ${TICKER}`);
  for (const doc of DOCS) check(!text(doc).includes('EATIT'), `${doc} still names the old working ticker`);
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
  // Square Hole's own token and collection, and the word the founder took out of the UI (F130).
  /\bFIT\b/, /\bmisfits?\b/i, /\bdemo\b/i,
  // The homage names nothing: not the project or company behind the price coin, nor its product words.
  /chain\s?link/i, /\boracles?\b/i,
  // The marines are caricatures of nobody: no real service's names, mottos, nicknames or jokes about its people.
  /\busmc\b/i, /\bsemper\b/i, /\boorah\b/i, /\bjarheads?\b/i, /\bleathernecks?\b/i, /\bdevil dogs?\b/i, /\bcrayons?\b/i,
  // LINK is locked, never burned, and the kit never claims that LINK's supply goes down (the founder's notes).
  /\bburn(s|ed|ing)?\s+(the\s+)?LINK\b/i, /\bLINK\s+(is|gets|was|will be)\s+burn/i,
];
const SHAPES = [
  [/—/, 'an em dash'], [/\s–\s/, 'a dash used as a pause'], [/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'an emoji or dingbat'],
  [/0x[0-9a-fA-F]{6,}/, 'an address'], [/\b(19|20)\d\d\b/, 'a year or date'], [/\$\s?\d/, 'a dollar amount'],
  [/\b\d[\d,]*(\.\d+)?\s?(USDC|ETH|USD|LINK|MARINE)\b/, 'a coin amount'], [/\bnot\b[^.;]*,\s*but\b/i, 'a "not X, but Y" turn'],
  [/\bsupply\b.*\b(shrink\w*|reduc\w*|decreas\w*|smaller|lower)\b|\b(shrink\w*|reduc\w*|decreas\w*)\b.*\bsupply\b/i, 'a claim about a supply going down'],
];

/** The rules apply to every doc in the kit and to the titles and descriptions inside the SVGs. */
function checkWords() {
  const sources = [...DOCS, RECORD].map((d) => [d, text(d)]);
  const svgs = ['art', 'art/items', 'art/scenes'].filter((dir) => existsSync(at(dir)))
    .flatMap((dir) => list(dir).filter((n) => n.endsWith('.svg')).map((n) => `${dir}/${n}`));
  for (const f of svgs) {
    const words = (text(f).match(/<(title|desc)>[^<]*<\/\1>/g) ?? []).join(' ');
    sources.push([f, words]);
    check(!/\bLINK\b/i.test(words.replace(/\bLink Marines\b/gi, '').replace(/\bLINK MARINES\b/g, '')),
      `${f} names the price coin; pictures name only the box, so the coins fit any community coin`);
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
  const book = text('brand-book.md');
  const joined = COVER_LINE.join(' ');
  const cover = joined[0] + joined.slice(1).toLowerCase();
  check(book.includes(`**Cover line:** "${cover}"`) && book.includes(`| Cover | "${cover}" |`), `brand-book.md must carry the cover line "${cover}" in Identity and in the example lines`);
  const quoted = [...book.matchAll(/"([^"]*\beat the fees\b[^"]*)"/gi)].map((m) => m[1]);
  check(quoted.every((q) => q === cover), `brand-book.md quotes a cover line that differs from the art: ${quoted.filter((q) => q !== cover).join(' | ')}`);
  check(book.includes('"In plain words, after graduation ten of every fifteen fee coins are locked away for good."'), 'brand-book.md must carry the literal line next to the cover line');
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
  for (const v of VARIANT_NAMES) check(readme.includes(`| ${v} |`), `README.md must name the variant ${v} in its table`);
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

/** Raw RGBA pixels of an SVG, rendered with system fonts off. Read `.pixels` once: each access copies the image. */
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
process.stdout.write(`ok: ${passed} checks passed (${items.length} variants, ${scenes.length} scenes, ${COUNT} marines)\n`);
