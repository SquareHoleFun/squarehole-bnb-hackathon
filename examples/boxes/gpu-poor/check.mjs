/**
 * Checks the GPU Poor kit: every required file is here with its exact pixel size, every PNG has its SVG source and
 * is a fresh render of it, the storybook matches the scenes, the docs match the registry settings, the later GPU rule
 * gives every id its own GPU, and the kit's words, both written and drawn, follow the brand rules. No network.
 *
 *   node check.mjs        exit 0 when everything passes, 1 otherwise
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { builders, pieces } from './build-art.mjs';
import { SCENES } from './src/scenes.mjs';
import { logoSvg, PREVIEW_IDS } from './src/brand.mjs';
import { gpuCode, gpuParts, GPU_TRAITS, GPU_COUNT } from './src/gpu.mjs';
import { loadResvg, toPng } from './src/render.mjs';
import { C, MIX } from './src/palette.mjs';
import { recordLettering } from './src/type.mjs';

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
const RECORD = 'SH-KIT-GPU-POOR.md';
const FIXED = [
  ['art/logo', 1024, 1024], ['art/x-avatar', 400, 400], ['art/x-banner', 1500, 500],
  ['art/cover', 1200, 630], ['art/box-banner', 2400, 600], ['art/later/gpu-preview', 1800, 1200],
];
const SCENE_PX = 1200;
const REGISTRY = '../../../packages/box-spec/examples/v2/';
/**
 * The kit's ticker. If the registry row carries another one, details.md must name both. Once the row carries this one,
 * as it does now, no doc may still speak of a fixture ticker.
 */
const KIT_TICKER = 'VRAM';

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
  return nums;
}

function checkFiles() {
  for (const doc of [...DOCS, RECORD]) check(existsSync(at(doc)) && text(doc).trim().length > 200, `missing or empty ${doc}`);
  for (const f of ['build-art.mjs', 'check.mjs', '.gitattributes']) check(existsSync(at(f)), `missing ${f}`);
  for (const [base, w, h] of FIXED) checkPair(base, w, h);
  const small = existsSync(at('art/logo-48.png')) && pngSize('art/logo-48.png');
  check(small && small[0] === 48 && small[1] === 48, 'art/logo-48.png must be exactly 48x48');
  const scenes = numbered('art/scenes', 'scene', 5, 7);
  for (const n of scenes) checkPair(`art/scenes/scene-${n}`, SCENE_PX, SCENE_PX);
  // A token box has no items: no variants and no assignment, so nobody mistakes the preview for this box's items.
  check(!existsSync(at('art/items')) && !existsSync(at('assign.mjs')) && !existsSync(at('assignment.json')), 'GPU Poor has no items: art/items, assign.mjs and assignment.json must not exist');
  return { scenes };
}

/** Hue in degrees, saturation and lightness (HSL, 0 to 1) of a #RRGGBB color. */
function hsl(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { h: 0, s: 0, l };
  const s = delta / (1 - Math.abs(2 * l - 1));
  const h = max === r ? 60 * (((g - b) / delta + 6) % 6) : max === g ? 60 * ((b - r) / delta + 2) : 60 * ((r - g) / delta + 4);
  return { h, s, l };
}

/** A color that reads as green: a hue from 70 to 170 degrees with real color in it. Nvidia's brand green is one. */
const isGreen = (hex) => {
  const { h, s, l } = hsl(hex);
  return s >= 0.25 && l >= 0.1 && l <= 0.92 && h >= 70 && h <= 170;
};

/**
 * Every color in every SVG comes from the palette, no source file but src/palette.mjs defines one, and nothing in
 * the palette or the docs is green, so the kit never takes Nvidia's brand green, or any green, as a color.
 */
function checkPalette() {
  const allowed = new Set([...Object.values(C), ...Object.values(MIX)].map((c) => c.toUpperCase()));
  for (const [base, svg] of pieces()) {
    const stray = [...new Set((svg.match(/#[0-9A-Fa-f]{6}\b/g) ?? []).map((c) => c.toUpperCase()))].filter((c) => !allowed.has(c));
    check(stray.length === 0, `${base}.svg uses colors outside the palette: ${stray.join(', ')}`);
  }
  for (const f of list('src').filter((n) => n !== 'palette.mjs')) {
    check(!/#[0-9A-Fa-f]{6}\b/.test(text(`src/${f}`)), `src/${f} defines a color; colors live in src/palette.mjs`);
  }
  for (const [name, hex] of [...Object.entries(C), ...Object.entries(MIX)]) check(!isGreen(hex), `the palette color ${name} ${hex} is green; the kit uses no green`);
  for (const doc of [...DOCS, RECORD]) {
    const greens = (text(doc).match(/#[0-9A-Fa-f]{6}\b/g) ?? []).filter(isGreen);
    check(greens.length === 0, `${doc} lists green colors (${greens.join(', ')}); the kit uses no green`);
  }
}

/** The docs say what the registry says. Skipped when the kit is copied out of the repository. */
function checkRegistry() {
  if (!existsSync(at(`${REGISTRY}gpu-poor.json`))) return;
  const box = JSON.parse(text(`${REGISTRY}gpu-poor.json`));
  check(box.contents.kind === 'token' && box.contents.size === '0', 'registry: gpu-poor is expected to be a token with no items; review the kit if that changed');
  check(box.fees.buyers.choice === 'burn' && box.fees.sellers.choice === 'burn', 'registry: both fee sides are expected to burn; review the kit if that changed');
  const details = text('details.md');
  const facts = [box.name, box.ticker, box.status, box.template.id, box.priceCoin.symbol, box.priceCoin.decimals, box.contents.kind,
    box.raise.policy, box.deadline.days, box.fees.buyers.choice, box.life, ...box.properties];
  for (const fact of facts) check(details.includes(`\`${fact}\``), `details.md must show the registry value \`${fact}\``);
  const book = text('brand-book.md');
  check(book.includes(`**Ticker:** ${KIT_TICKER}.`) && book.includes(`**Name:** ${box.name}.`), `brand-book.md must name ${box.name} and the kit ticker ${KIT_TICKER}`);
  if (box.ticker !== KIT_TICKER) {
    const note = `The example registry still lists the fixture ticker ${box.ticker}.`;
    check(book.includes(note) && text('README.md').includes(note), `brand-book.md and README.md must say: ${note}`);
    check(details.includes(`\`${KIT_TICKER}\``), `details.md must name the kit ticker \`${KIT_TICKER}\` next to the registry's`);
  } else {
    for (const doc of DOCS) check(!/\bfixture ticker\b/i.test(text(doc)), `${doc} still speaks of a fixture ticker; the registry row now carries ${KIT_TICKER}`);
  }
  if (existsSync(at(`${REGISTRY}gpu-poor-miners.json`))) {
    const later = JSON.parse(text(`${REGISTRY}gpu-poor-miners.json`));
    const step = later.status === 'pending' ? later.pendingStep : later.status;
    check(details.includes(`\`${step}\``) && details.includes(`\`${later.ticker}\``) && details.includes(`\`${later.contents.size}\``), 'details.md must describe the miners row as the registry has it');
  }
}

/** The later GPU rule: 1,024 ids, 1,024 different mixes, each choice exactly 256 times; the preview is balanced. */
function checkGpuRule() {
  const codes = new Set();
  const counts = Object.fromEntries(Object.keys(GPU_TRAITS).map((k) => [k, new Map()]));
  for (let id = 1; id <= GPU_COUNT; id += 1) {
    const p = gpuParts(id);
    codes.add(gpuCode(id));
    for (const k of Object.keys(GPU_TRAITS)) counts[k].set(String(p[k]), (counts[k].get(String(p[k])) ?? 0) + 1);
  }
  check(codes.size === GPU_COUNT, `the GPU rule must give ${GPU_COUNT} different mixes, gave ${codes.size}`);
  for (const [k, m] of Object.entries(counts)) check(m.size === 4 && [...m.values()].every((v) => v === 256), `every ${k} choice must appear on exactly 256 GPUs`);
  for (const bad of [0, 1025, 1.5, '1', Number.NaN, null]) {
    let threw = false;
    try { gpuParts(bad); } catch { threw = true; }
    check(threw, `gpuParts must refuse ${JSON.stringify(bad)}`);
  }
  const shown = Object.fromEntries(Object.keys(GPU_TRAITS).map((k) => [k, new Map()]));
  for (const id of PREVIEW_IDS) for (const k of Object.keys(GPU_TRAITS)) shown[k].set(String(gpuParts(id)[k]), (shown[k].get(String(gpuParts(id)[k])) ?? 0) + 1);
  check(PREVIEW_IDS.length === 12 && Object.values(shown).every((m) => m.size === 4 && [...m.values()].every((v) => v === 3)), 'the preview must show every choice of every part exactly three times');
}

/** The storybook's scenes end at a line of three dashes. The short note after it is no scene. */
const NOTE_RULE = /^---$/m;
/** The note after the scenes holds the legal lines, so it may be a little longer than a caption. */
const NOTE_MAX_SENTENCES = 3;

/**
 * Storybook: one picture per scene, each referenced once, at most two sentences under it, same words as src, and
 * after the last scene one short note below a rule.
 */
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
  }
  const [story, ...after] = md.split(NOTE_RULE);
  const note = after.join('').trim();
  const noteSentences = note.split(/(?<=[.!?])\s+/).filter((x) => x.trim()).length;
  check(after.length === 1 && note.length > 0 && !/^#/m.test(note) && !note.includes('!['), 'storybook.md must end with one note after a --- line, with no heading and no picture');
  check(noteSentences <= NOTE_MAX_SENTENCES, `the storybook's closing note has ${noteSentences} sentences, at most ${NOTE_MAX_SENTENCES}`);
  const sections = story.split(/^## /m).slice(1);
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
  // No other company: no other chip maker and no graphics card brand. Nvidia and Ondo only in the forms of NAME_FORMS.
  /\bgeforce\b/i, /\bradeon\b/i, /\bAMD\b/, /\bintel\b/i,
  // Nvidia's product names are never branding here, and its CEO's name and look never appear.
  /\bRTX\b/i, /\bGTX\b/i, /\bquadro\b/i, /\btitan\b/i, /\bcuda\b/i, /\bdlss\b/i, /\bnvlink\b/i, /\bdgx\b/i, /\bblackwell\b/i,
  /\bjetson\b/i, /\btegra\b/i, /\bjensen\b/i, /\bhuang\b/i, /\bleather jacket\b/i,
];
const SHAPES = [
  [/—/, 'an em dash'], [/\s–\s/, 'a dash used as a pause'], [/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'an emoji or dingbat'],
  [/0x[0-9a-fA-F]{6,}/, 'an address'], [/\b(19|20)\d\d\b/, 'a year or date'], [/\$\s?\d/, 'a dollar amount'],
  [/\b\d[\d,]*(\.\d+)?\s?\$?(USDC|ETH|USD|NVDAon|NVDA|VRAM)\b/, 'a coin amount'], [/\bnot\b[^.;|]*,\s*but\b/i, 'a "not X, but Y" turn'],
];

/**
 * The founder's version 2 names the stock. The kit writes the company as Nvidia, the stock as $NVDA, the exact setting
 * as NVDAon and the issuer as Ondo. Any other spelling fails: NVIDIA in capitals, a bare NVDA, $NVDAon or ONDO.
 */
const NAME_FORMS = [
  [/\$?\bnvda\w*/gi, ['$NVDA', 'NVDAon'], 'write the stock as $NVDA, and NVDAon only for the exact setting'],
  [/\bnvidia\w*/gi, ['Nvidia'], 'write the company as Nvidia'],
  [/\bondo\w*/gi, ['Ondo'], 'write the issuer as Ondo'],
];
const badForms = (line) => NAME_FORMS.flatMap(([re, ok, hint]) => [...line.matchAll(re)].filter((m) => !ok.includes(m[0])).map((m) => `${m[0]} (${hint})`));

/**
 * A sentence that names Nvidia, Ondo or the stock next to a logo, a color, a face or the CEO must refuse them, with a
 * word such as never, no or not. So the docs can say that the logos never appear, and cannot put one anywhere.
 */
const BRAND = /\b(Nvidia|Ondo|NVDAon)\b|\$NVDA\b/i;
const MARKS = /\b(logos?|wordmarks?|emblems?|badges?|eyes?|swirls?|green|CEO|likeness|faces?|portraits?|photos?)\b/i;
const REFUSES = /\b(never|no|not|nor|none|neither|without|avoid)\b|n't\b/i;
/** The pictures may letter $NVDA and nothing else of these names, and their descriptions name no logo but our own. */
const ART_NAMES = /nvidia|ondo|nvdaon/i;
const ART_MARKS = (words) => /\b(logos?|green)\b/i.test(words.replace(/GPU Poor logo/g, ''));

/**
 * Only ten of every 15 fee parts buy VRAM and burn it. Two go into the box's own pool and three go to Square Hole. A
 * sentence that has the fee buy VRAM and burn it, in any order, or has the fees go to the burn or the fire, must say
 * how much with "ten of" or "10 of", such as "ten of every 15 fee parts" or "10 of 15". For this rule a sentence also
 * ends after a closing quote, so a quoted line is read on its own.
 */
const FEE_BURNS = [
  /^(?=.*\bfees?\b)(?=.*\b(buy|buys|bought|buying)\b)(?=.*\bVRAM\b)(?=.*\bburn)/i,
  /\bfees?\b.*\b(go|goes|going|went)\s+(in)?to\s+the\s+(burn|fire)\b/i,
];
const FEE_SHARE = /\b(ten|10) of\b/i;
const QUOTED_SENTENCE_END = /(?<=[.!?|]["'”’)\]]*)\s+/;

/** A line without link targets, code and bold marks, so a sentence that ends in bold still ends there. */
const stripLine = (line) => line.replace(/\]\([^)]*\)/g, ']').replace(/`[^`]*`/g, '').replace(/\*\*/g, '');
/** The text with the avoid list blanked out, line breaks kept, so line numbers stay true. */
const outsideAvoidList = (raw) => raw.replace(new RegExp(`${AVOID_START}[\\s\\S]*?${AVOID_END}`, 'g'), (block) => block.replace(/[^\n]/g, ''));

/** Words, shapes and name forms line by line, phrases and sentences across line breaks. */
function wordIssues(name, raw) {
  const body = outsideAvoidList(raw);
  const issues = [];
  body.split('\n').forEach((line, i) => {
    const clean = stripLine(line);
    const where = `${name}:${i + 1}`;
    for (const re of BANNED.filter((r) => !r.source.includes(' '))) if (re.test(clean)) issues.push(`${where} uses a word the kit avoids (${re.source}): ${line.trim().slice(0, 80)}`);
    for (const [re, what] of SHAPES) if (re.test(clean)) issues.push(`${where} contains ${what}: ${line.trim().slice(0, 80)}`);
    for (const bad of badForms(clean)) issues.push(`${where} writes ${bad}: ${line.trim().slice(0, 80)}`);
  });
  const joined = body.split('\n').map(stripLine).join(' ').replace(/\s+/g, ' ');
  for (const re of BANNED.filter((r) => r.source.includes(' '))) if (re.test(joined)) issues.push(`${name} uses a phrase the kit avoids (${re.source})`);
  for (const sentence of joined.split(/(?<=[.!?|])\s+/)) {
    if (BRAND.test(sentence) && MARKS.test(sentence) && !REFUSES.test(sentence)) issues.push(`${name} names Nvidia, Ondo or $NVDA with a logo, color or person and does not refuse it: ${sentence.trim().slice(0, 90)}`);
  }
  for (const sentence of joined.split(QUOTED_SENTENCE_END)) {
    if (FEE_BURNS.some((re) => re.test(sentence)) && !FEE_SHARE.test(sentence)) issues.push(`${name} has the fee buy VRAM and burn it without saying that only ten of every 15 fee parts do: ${sentence.trim().slice(0, 90)}`);
  }
  return issues;
}

/**
 * The rules apply to every doc in the kit, to the titles and descriptions inside the SVGs and to every word the
 * pictures draw. The pictures may letter $NVDA. They never letter Nvidia, Ondo or NVDAon, and the mark letters nothing.
 */
function checkWords() {
  const sources = [...DOCS, RECORD].map((d) => [d, text(d)]);
  const words = (svg) => (svg.match(/<(title|desc)>[^<]*<\/\1>/g) ?? []).join('\n');
  const svgs = ['art', 'art/scenes', 'art/later'].filter((dir) => existsSync(at(dir)))
    .flatMap((dir) => list(dir).filter((n) => n.endsWith('.svg')).map((n) => [`${dir}/${n}`, text(`${dir}/${n}`)]));
  for (const [base, build] of builders()) {
    let svg = '';
    const drawn = recordLettering(() => { svg = build(); });
    svgs.push([`${base}.svg as src/ builds it`, svg]);
    sources.push([`${base} lettering`, drawn.join('\n')]);
    check(!drawn.some((w) => ART_NAMES.test(w)), `${base} letters Nvidia, Ondo or NVDAon; a picture letters only $NVDA`);
    if (base === 'art/logo' || base === 'art/x-avatar') check(drawn.length === 0, `${base} letters ${drawn.join(', ')}; the mark carries no letters`);
  }
  for (const [f, svg] of svgs) {
    const said = words(svg);
    sources.push([f, said]);
    check(!ART_NAMES.test(said) && !ART_MARKS(said), `${f} names Nvidia, Ondo, NVDAon, a logo or green; a picture shows only $NVDA`);
  }
  for (const [name, raw] of sources) {
    const issues = wordIssues(name, raw);
    if (issues.length) problems.push(...issues);
    else passed += 1;
  }
  check(text('brand-book.md').includes('"Sell a stock to prop up a memecoin."'), "brand-book.md must carry the founder's headline word for word");
}

/** The lines the founder kept for version 2, word for word, and the one-line explanation of the exact setting. */
const LINES = Object.freeze({
  'not-affiliated': 'Nvidia and Ondo did not make, approve or endorse this box.',
  'US persons': 'The stock coin may not be offered to US persons.',
  issuer: 'Ondo can pause the stock coin. Then this box waits too.',
});
const SETTING_LINE = "NVDAon is Ondo's tokenized Nvidia stock";
/** The docs, besides the brand book and the README, that repeat lines word for word, and which lines each repeats. */
const CARRIES = Object.freeze({ 'details.md': ['not-affiliated', 'US persons', 'issuer'], 'storybook.md': ['not-affiliated', 'US persons'] });
/** X's limit for a bio, in characters. */
const X_BIO_MAX = 160;
/** The pieces people see first, which must letter the stock's name. */
const NAMED_PIECES = ['art/cover', 'art/x-banner', 'art/box-banner'];

/**
 * The names and lines of version 2 are where they belong: the brand book's voice table holds the three lines, the
 * README repeats them, details.md and the storybook's closing note repeat the lines CARRIES names, details.md explains
 * NVDAon in one line, the X bio fits X with both legal lines in it, and the cover and both banners letter $NVDA and
 * say so in their descriptions.
 */
function checkLines() {
  const flat = (doc) => text(doc).replace(/\s+/g, ' ');
  const book = flat('brand-book.md');
  check(book.includes("**Price coin:** $NVDA, Nvidia's stock. The exact setting is NVDAon, Ondo's tokenized Nvidia stock."), "brand-book.md must give the price coin as $NVDA, Nvidia's stock, and the setting as NVDAon, Ondo's tokenized Nvidia stock");
  const rows = { 'not-affiliated': 'Not affiliated', 'US persons': 'US persons line', issuer: 'Issuer line' };
  for (const [key, line] of Object.entries(LINES)) {
    check(book.includes(`| ${rows[key]} | "${line}" |`), `brand-book.md must carry the ${key} line in its voice table: "${line}"`);
    check(flat('README.md').includes(line), `README.md must carry the ${key} line: "${line}"`);
  }
  for (const [doc, keys] of Object.entries(CARRIES)) {
    for (const key of keys) check(flat(doc).includes(LINES[key]), `${doc} must carry the ${key} line: "${LINES[key]}"`);
  }
  // The storybook's lines stand in its closing note, and the issuer line stands in the risks of details.md.
  const note = text('storybook.md').split(NOTE_RULE).slice(1).join('').replace(/\s+/g, ' ');
  for (const key of CARRIES['storybook.md']) check(note.includes(LINES[key]), `storybook.md must carry the ${key} line in its closing note`);
  const risks = (text('details.md').split(/^## /m).find((part) => part.startsWith('Risks in plain words')) ?? '').replace(/\s+/g, ' ');
  check(risks.includes(LINES.issuer), 'details.md must carry the issuer line in its risks');
  check(flat('details.md').includes(SETTING_LINE), `details.md must explain the setting in one line: "${SETTING_LINE}"`);
  const bio = book.match(/\| X bio \| "([^"]+)" \|/)?.[1] ?? '';
  check(bio.length > 0 && [...bio].length <= X_BIO_MAX, `the X bio must fit X's ${X_BIO_MAX} characters, it has ${[...bio].length}`);
  check(bio.includes(LINES['US persons']) && bio.includes(LINES['not-affiliated']), 'the X bio must carry the US persons and not-affiliated lines');
  const built = new Map(builders());
  for (const base of NAMED_PIECES) {
    let svg = '';
    const drawn = recordLettering(() => { svg = built.get(base)(); });
    check(drawn.includes('$NVDA'), `${base} must letter $NVDA, so a viewer sees which stock it is`);
    check((svg.match(/<desc>([^<]*)<\/desc>/)?.[1] ?? '').includes('$NVDA'), `${base}.svg must say $NVDA in its description`);
  }
}

/** A post often shows a scene or the cover, both 1200 px wide, this many pixels wide. */
const POST_W = 500;
/** The smallest cap height, in pixels at post size, at which a word in a picture still reads. */
const MIN_POST_CAP = 7.5;
/** The pictures that go into posts. */
const POSTED = (base) => base.startsWith('art/scenes/') || base === 'art/cover';

/** Every word a posted picture letters is still at least MIN_POST_CAP tall when a post shows it POST_W px wide. */
function checkPostSize() {
  const widths = new Map(FIXED.map(([base, w]) => [base, w]));
  for (const [base, build] of builders().filter(([b]) => POSTED(b))) {
    const width = widths.get(base) ?? SCENE_PX;
    for (const { text: word, size } of recordLettering(build, { sizes: true })) {
      const px = (size * POST_W) / width;
      check(px >= MIN_POST_CAP, `${base} letters "${word}" ${px.toFixed(1)} px tall when a post shows it ${POST_W} px wide; words must be at least ${MIN_POST_CAP} px there`);
    }
  }
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

/** The rows of the brand book's contrast table, as [pair, text color, ground color]. Each passes AA, 4.5:1. */
const PAIRS = [
  ['White-hot on night', C.white, C.night], ['Paper on night', C.paper, C.night], ['Amber on night', C.amber, C.night],
  ['Ice on night', C.ice, C.night], ['Orange on night', C.orange, C.night], ['Magenta on night', C.magenta, C.night],
  ['Violet on night', C.violet, C.night], ['Night on amber', C.night, C.amber], ['Night on ice', C.night, C.ice],
  ['Night on paper', C.night, C.paper], ['Deep violet on paper', C.deep, C.paper], ['Deep ice on ice', MIX.iceDeep, C.ice],
];

/** The brand book gives every pair's real ratio, rounded to two places, and every pair passes AA. */
function checkContrast() {
  const book = text('brand-book.md');
  for (const [pair, fg, bg] of PAIRS) {
    const ratio = contrast(fg, bg);
    const shown = `${ratio.toFixed(2)}:1`;
    check(book.includes(`| ${pair} | ${shown} |`), `brand-book.md must give ${pair} as ${shown}`);
    check(ratio >= 4.5, `${pair} is ${shown}, below the 4.5:1 of WCAG AA`);
  }
}

/** Every local Markdown link resolves. Links into the repository are checked when the repository is present. */
function checkLinks() {
  const inRepo = existsSync(at('../../../packages/box-spec'));
  for (const doc of [...DOCS, RECORD]) {
    for (const [, target] of text(doc).matchAll(/\]\(([^)\s#]+)(#[^)]*)?\)/g)) {
      if (/^[a-z]+:/i.test(target)) continue;
      const leavesKit = target.startsWith('../');
      if (leavesKit && !inRepo) continue;
      check(existsSync(at(target)), `${doc} links to ${target}, which does not exist`);
    }
  }
}

/** README lists every file and folder at the top of the kit, and every art piece. */
function checkReadme(scenes) {
  const readme = text('README.md');
  const top = list('./').filter((n) => !n.startsWith('.') || n === '.gitattributes');
  for (const name of top) check(readme.includes(name), `README.md does not list ${name}`);
  for (const [base] of FIXED) check(readme.includes(`${base}.png`), `README.md does not list ${base}.png`);
  check(readme.includes('art/logo-48.png') && readme.includes(`scene-${scenes.at(-1)}`), 'README.md must name art/logo-48.png and the last scene');
  for (const f of list('src')) check(readme.includes(`src/${f}`) || text('art-notes.md').includes(`src/${f}`), `src/${f} is not described in README.md or art-notes.md`);
}

/** The committed SVGs are what src/ builds today, and each PNG is that SVG rendered (needs @resvg/resvg-js). */
async function checkFresh() {
  let Resvg = null;
  try { Resvg = await loadResvg(); } catch { problems.push('cannot load @resvg/resvg-js, so the PNGs could not be compared with their SVGs'); }
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

const { scenes } = checkFiles();
checkPalette();
checkRegistry();
checkGpuRule();
checkStorybook(scenes);
checkWords();
checkLines();
checkPostSize();
checkContrast();
checkReadme(scenes);
checkLinks();
await checkFresh();

if (problems.length) {
  process.stderr.write(`${problems.map((p) => `FAIL ${p}`).join('\n')}\n${problems.length} problem(s), ${passed} checks passed\n`);
  process.exit(1);
}
process.stdout.write(`ok: ${passed} checks passed (${scenes.length} scenes, ${GPU_COUNT} later GPUs, no items)\n`);
