/**
 * Checks the One Dollar is all you need kit: every required file is here with its exact pixel size, every PNG has its
 * SVG source and is a fresh render of it, the mark keeps its clear space and fits a round crop, the X banner keeps its
 * avatar corner bare, words stay clear of the edges, the storybook matches the scenes, the docs match the registry
 * settings, the pictures never name the coin and letter no dollar sign, no text writes the ticker 1 with a dollar sign, the bill letters nothing
 * but 1 and ONE, the ticker's trade-offs are written down, the contrast table is true, and the kit's words follow the
 * brand rules. No network.
 *
 *   node check.mjs        exit 0 when everything passes, 1 otherwise
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { pieces, builders } from './build-art.mjs';
import { SCENES } from './src/scenes.mjs';
import { logoSvg, avatarSvg, markBareSvg, xBannerSvg, xBannerBareSvg, AVATAR_CORNER, MARK_GRID, COVER_LINE, COVER_TEXT, LITERAL_LINE, NAME_LINES } from './src/brand.mjs';
import { loadResvg, toPng, pixels } from './src/render.mjs';
import { DRAWN, CHARSET } from './src/type.mjs';
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
const RECORD = 'SH-KIT-ONE-DOLLAR.md';
const FIXED = [
  ['art/logo', 1024, 1024], ['art/x-avatar', 400, 400], ['art/x-banner', 1500, 500],
  ['art/cover', 1200, 630], ['art/box-banner', 2400, 600],
];
const SCENE_PX = 1200;
const REGISTRY = '../../../packages/box-spec/examples/v2/';
const BOX_ID = 'one-dollar';

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
  for (const f of ['build-art.mjs', 'check.mjs', '.gitattributes']) check(existsSync(at(f)), `missing ${f}`);
  check(/^art\/\*\* -text$/m.test(text('.gitattributes')), '.gitattributes must mark art/** as -text');
  for (const [base, w, h] of FIXED) checkPair(base, w, h);
  const small = existsSync(at('art/logo-48.png')) && pngSize('art/logo-48.png');
  check(small && small[0] === 48 && small[1] === 48, 'art/logo-48.png must be exactly 48x48');
  const scenes = numbered('art/scenes', 'scene', 5, 7);
  for (const n of scenes) checkPair(`art/scenes/scene-${n}`, SCENE_PX, SCENE_PX);
  // A coin pile has no items: no variants and no assignment.
  check(!existsSync(at('art/items')) && !existsSync(at('assign.mjs')) && !existsSync(at('assignment.json')), 'One Dollar is a coin pile: art/items, assign.mjs and assignment.json must not exist');
  return { scenes };
}

/** Every color in every SVG comes from the palette, and no source file but src/palette.mjs defines one. */
function checkPalette() {
  const allowed = new Set([...Object.values(C), ...Object.values(MIX)].map((c) => c.toUpperCase()));
  for (const [base, svg] of pieces()) {
    const stray = [...new Set((svg.match(/#[0-9A-Fa-f]{6}\b/g) ?? []).map((c) => c.toUpperCase()))].filter((c) => !allowed.has(c));
    check(stray.length === 0, `${base}.svg uses colors outside the palette: ${stray.join(', ')}`);
    check(!/\b(fill|stroke|stop-color)="(?!none|url\(#)[a-z]+"/i.test(svg), `${base}.svg uses a named color; colors come from src/palette.mjs`);
  }
  for (const f of list('src').filter((n) => n !== 'palette.mjs')) {
    check(!/#[0-9A-Fa-f]{6}\b/.test(text(`src/${f}`)), `src/${f} defines a color; colors live in src/palette.mjs`);
  }
  const book = text('brand-book.md');
  for (const hex of Object.values(C)) check(book.includes(`\`${hex}\``), `brand-book.md must list the brand color ${hex}`);
}

/** The docs say what the registry says. Skipped when the kit is copied out of the repository. */
function checkRegistry() {
  if (!existsSync(at(`${REGISTRY}${BOX_ID}.json`))) return;
  const box = JSON.parse(text(`${REGISTRY}${BOX_ID}.json`));
  check(box.contents.kind === 'pile' && box.contents.size === '0', 'registry: one-dollar is expected to be a coin pile; review the kit if that changed');
  check(box.priceCoin.symbol === 'USDC' && box.priceCoin.decimals === '6', 'registry: One Dollar is expected to be priced in USDC with 6 decimals; review the kit if that changed');
  check(box.contents.seed?.symbol === 'USDC' && box.contents.seed?.amount === '1000000', 'registry: the pile is expected to hold exactly one USDC (1000000 raw); review the kit if that changed');
  check(box.fees.buyers.choice === 'burn' && box.fees.sellers.choice === 'burn', 'registry: both sides are expected to burn; review the kit if that changed');
  check((box.contents.leaveBehindBps ?? '0') === '0', 'registry: no leave-behind is expected; review the kit if that changed');
  const details = text('details.md');
  // The raise is a listing's market amount, so the docs name its policy and never repeat its number.
  check(!details.includes(box.raise.amount), 'details.md must not repeat the raise amount; the listing sets it');
  const facts = [box.name, box.ticker, box.status, box.template.id, box.priceCoin.symbol, box.priceCoin.decimals, box.contents.kind, box.contents.size,
    box.contents.seed.symbol, box.contents.seed.amount, box.contents.pickFeeBps, box.raise.policy, box.deadline.days,
    box.royalties.bps, box.fees.buyers.choice, box.fees.sellers.choice, box.life, ...box.properties];
  for (const fact of facts) check(details.includes(`\`${fact}\``), `details.md must show the registry value \`${fact}\``);
  if (box.status === 'pending') check(details.includes(`\`${box.pendingStep}\``), `details.md must name the pending step \`${box.pendingStep}\``);
  const book = text('brand-book.md');
  check(book.includes(`**Name:** ${box.name}.`) && book.includes(`**Ticker:** ${box.ticker}.`), `brand-book.md must name ${box.name} and ${box.ticker}`);
  // The contract takes a name of 1 to 32 bytes and a ticker of 1 to 11 (BoxSpecV2.sol), and the art letters the name.
  check(Buffer.byteLength(box.name) <= 32 && /^[A-Z0-9]{1,11}$/.test(box.ticker), `registry: the name must fit 32 bytes and the ticker 11 capitals or digits (${box.name}, ${box.ticker})`);
  check(NAME_LINES.join(' ') === box.name.toUpperCase(), `src/brand.mjs: NAME_LINES must letter the registry name ${box.name}`);
  // The founder's rule (2026-10-23): the ticker is written as it is. No text, not even code or an exempt block, puts a
  // dollar sign in front of it.
  for (const doc of [...DOCS, RECORD]) check(!text(doc).includes(`$${box.ticker}`), `${doc} writes the ticker ${box.ticker} with a dollar sign in front`);
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

/** Words of the real note that the bill never copies. Only the bill rules in the brand book may name them. */
const BILL_WORDS = [/\bfederal\b/i, /\breserve\b/i, /\bunited states\b/i, /\bamerica\b/i, /\btreasury\b/i, /\bserial\b/i,
  /\bseals?\b/i, /\bsignatures?\b/i, /\bportraits?\b/i, /\blegal tender\b/i, /\bwashington\b/i, /\bin god\b/i];
/** Any dollar sign: the kit never writes one, so the ticker is 1 and no amount is written as money. */
const DOLLAR_SIGN = /\$/;
/** The four trade-offs of the ticker 1, written down once in details.md and in the kit record. */
const TRADE_OFFS = [
  'On X a cashtag must start with a letter, so the ticker 1 cannot be a cashtag.',
  'Wallets show amounts as `500,000 1`.',
  'Chart sites may put a dollar sign in front of the ticker, where it reads as a price.',
  'A bare 1 in a post can read as a number, so every post says what the token 1 is.',
];

/** Blocks that may hold words the rest of the kit avoids: the avoid list itself, the founder's words and the bill rules. */
const EXEMPT = [['<!-- avoid-list:start -->', '<!-- avoid-list:end -->'], ['<!-- founder-words:start -->', '<!-- founder-words:end -->'],
  ['<!-- bill-rules:start -->', '<!-- bill-rules:end -->']];
const BANNED = [
  /\bearn(s|ed|ing|ings)?\b/i, /\byields?\b/i, /\breturns?\b/i, /\bgains?\b/i, /\bmoon(ing)?\b/i, /\b100x\b/i,
  /\binvest(ment|ments|or|ors|ing)?\b/i, /\bincome\b/i, /\bprofit(s|able)?\b/i, /\bpassive\b/i, /\bAPY\b/, /\bAPR\b/, /\bROI\b/,
  /\bguarantee(d|s)?\b/i, /\bunlock(s|ed|ing)?\b/i, /\bseamless(ly)?\b/i, /\brevolutionary\b/i, /\bjourney\b/i,
  /\bpump(s|ed|ing)?\b/i, /\bfloor price\b/i, /\bprice (floor|support|rise)\b/i, /\bget in early\b/i, /\bnumber go up\b/i,
  /\bdividends?\b/i, /\brewards?\b/i, /\bprize\b/i, /\bjackpot\b/i, /\bwealth\b/i, /\briches\b/i, /\bfortune\b/i,
  /\btreasure\b/i, /\bloot\b/i, /\binterest\b/i, /\bupside\b/i, /\bflywheel\b/i, /\bgrow(s|ing|th|n)?\b/i,
  /\bincreas(e|es|ed|ing)\b/i, /\bris(e|es|en|ing)\b/i, /\bapprec\w*/i, /\baccru\w*/i, /\bback(ed|ing)\b/i,
  /\bscarc\w*/i, /\bdeflation\w*/i, /\bfair share\b/i, /\bhodl\b/i, /\bdiamond hands\b/i, /\bpaper hands\b/i,
  // Value talk the box never makes: what the token or a slice might be worth or how far it might go, and cheapness. The
  // usual name for the value of all the tokens is refused in every file, by checkNeverPhrase below.
  /\bworth\b/i, /\bcheap(er|est)?\b/i, /\bbargain\b/i, /\bundervalued\b/i, /\bpegg?ed\b/i, /\bhow far\b/i,
  // Square Hole's own token and collection, and the word the founder took out of the UI (F130).
  /\bFIT\b/, /\bmisfits?\b/i, /\bdemo\b/i,
  // The homage names nothing: no artwork, artist or museum, no song or paper the name echoes, and no other project
  // that uses the ticker.
  /\bbanana\b/i, /\bduct tape\b/i, /\bcattelan\b/i, /\bcomedian\b/i, /\blouvre\b/i, /\bmona lisa\b/i, /\bharmony\b/i,
  /\bbeatles\b/i, /\battention is\b/i, /\blove is all\b/i,
  // The bill copies no real note: these words stay inside the bill rules in the brand book.
  ...BILL_WORDS,
];
const SHAPES = [
  [/—/, 'an em dash'], [/\s–\s/, 'a dash used as a pause'], [/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'an emoji or dingbat'],
  [/0x[0-9a-fA-F]{6,}/, 'an address'], [/\b(19|20)\d\d\b/, 'a year or date'],
  // No dollar sign at all: the ticker is written 1, and an amount is never written as money.
  [DOLLAR_SIGN, 'a dollar sign'],
  [/\b\d[\d,]*(\.\d+)?\s?(ETH|ONE|USDC|USD|WETH)\b/, 'a coin amount'], [/\b\d[\d,]*(\.\d+)?\s1\b(?![.,]\d)/, 'an amount of the token'],
];

/** Removes the exempt blocks from a text, and reports whether any block sits outside the brand book. */
function withoutExempt(raw) {
  let out = raw;
  let found = 0;
  for (const [start, end] of EXEMPT) {
    const parts = out.split(start);
    found += parts.length - 1;
    out = [parts[0], ...parts.slice(1).map((part) => part.split(end).slice(1).join(''))].join('\n');
  }
  return { body: out, found };
}

/** The rules apply to every doc in the kit and to the titles and descriptions inside the SVGs. */
function checkWords() {
  const sources = [...DOCS, RECORD].map((d) => [d, text(d)]);
  const svgs = ['art', 'art/scenes'].filter((dir) => existsSync(at(dir)))
    .flatMap((dir) => list(dir).filter((n) => n.endsWith('.svg')).map((n) => `${dir}/${n}`));
  for (const f of svgs) {
    const words = (text(f).match(/<(title|desc)>[^<]*<\/\1>/g) ?? []).join(' ');
    sources.push([f, words]);
    check(!/\bUSDC\b/.test(words) && !DOLLAR_SIGN.test(words), `${f} names the coin or a dollar sign; the art shows plain silver coins and the bill`);
  }
  for (const [name, raw] of sources) {
    const { body, found } = withoutExempt(raw);
    if (name !== 'brand-book.md') check(found === 0, `${name} has an exempt block; only brand-book.md may hold one`);
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
  check(COVER_LINE.join(' ') === COVER_TEXT.toUpperCase(), 'src/brand.mjs: COVER_LINE and COVER_TEXT must say the same words');
  check(book.includes(`**Cover line:** "${COVER_TEXT}"`) && book.includes(`| Cover | "${COVER_TEXT}" |`), `brand-book.md must carry the cover line "${COVER_TEXT}" in Identity and in the example lines`);
  const quoted = [...book.matchAll(/"([^"]*\bis in the box\b[^"]*)"/gi)].map((m) => m[1]);
  check(quoted.length >= 2 && quoted.every((q) => q === COVER_TEXT), `brand-book.md quotes a cover line that differs from the art: ${quoted.filter((q) => q !== COVER_TEXT).join(' | ')}`);
  // Every post says what the token is: the bio and the pinned post carry it word for word.
  for (const row of ['X bio', 'Pinned post']) {
    const line = book.split('\n').find((l) => l.startsWith(`| ${row} |`)) ?? '';
    check(line.includes('The token is 1.'), `brand-book.md: the ${row} line must say "The token is 1."`);
  }
  const bio = book.split('\n').find((l) => l.startsWith('| X bio |'))?.match(/^\| X bio \| "([^"]+)" \|$/)?.[1] ?? '';
  check(bio.length > 0 && bio.length <= 160, `brand-book.md: the X bio must fit X's 160 characters, it has ${bio.length}`);
  check(book.includes(`It reads "${LITERAL_LINE}"`) && book.includes(`| Next to the cover line | "${LITERAL_LINE}" |`), 'brand-book.md must carry the literal line next to the cover line, in Identity and in the example lines');
  const literal = [...book.matchAll(/"(In plain words[^"]*)"/g)].map((m) => m[1]);
  check(literal.every((q) => q === LITERAL_LINE), `brand-book.md quotes a literal line that differs from src/brand.mjs: ${literal.filter((q) => q !== LITERAL_LINE).join(' | ')}`);
}

/** The four trade-offs of the ticker stand once in details.md and in the record, word for word. */
function checkTradeOffs() {
  const details = text('details.md');
  const record = text(RECORD);
  for (const line of TRADE_OFFS) {
    check(details.split(line).length === 2, `details.md must say once: ${line}`);
    check(record.includes(line), `${RECORD} must say: ${line}`);
  }
}

/**
 * The words each picture letters. The alphabet draws no dollar sign, and no picture letters one.
 * No picture letters a word of the real note, and the mark and the avatar letter nothing but the bill's 1 and ONE.
 */
function checkDrawn() {
  check(!CHARSET.includes('$'), 'the salon alphabet must not draw a dollar sign');
  const noteWords = /\b(FEDERAL|RESERVE|UNITED|STATES|AMERICA|TREASURY|SERIAL|TENDER|WASHINGTON|GOD|TRUST|SECRETARY|NOTE)\b/;
  for (const [base, build] of builders()) {
    DRAWN.length = 0;
    build();
    const words = DRAWN.map((w) => w.text);
    for (const w of words) {
      check(!DOLLAR_SIGN.test(w), `${base} letters a dollar sign: ${w}`);
      check(!noteWords.test(w), `${base} letters a word of the real note: ${w}`);
    }
    if (base === 'art/logo' || base === 'art/x-avatar') {
      check(words.length > 0 && words.every((w) => w === '1' || w === 'ONE'), `${base} may letter only the bill's 1 and ONE, found: ${words.join(' | ')}`);
    }
  }
  DRAWN.length = 0;
}

/**
 * The usual name for the value of all the tokens together appears nowhere in the kit: in no doc, marked block, SVG,
 * lettered word or script, this one included. The pattern is put together from its two words, so this file does not
 * hold the phrase itself.
 */
const NEVER_PHRASE = new RegExp(`\\b${['market', 'cap'].join('[\\s_-]*')}`, 'i');

/** Folders that are not the kit's own: an install next to a copied kit, and a repository's own store. */
const NOT_KIT = new Set(['node_modules', '.git']);

/** Every file in the kit, as paths from the kit's folder, without the files an operating system adds. */
function kitFiles(dir = '') {
  return readdirSync(at(dir || './'), { withFileTypes: true }).filter((e) => !OS_FILE.test(e.name) && !(e.isDirectory() && NOT_KIT.has(e.name)))
    .flatMap((e) => (e.isDirectory() ? kitFiles(`${dir}${e.name}/`) : [`${dir}${e.name}`]));
}

/**
 * Reads every file of the kit, whatever its name or type. Each is read byte for byte as Latin-1, so text in any
 * encoding and text inside a binary file, such as a comment in a PNG, still shows the phrase's plain letters.
 */
function checkNeverPhrase() {
  const files = kitFiles();
  check(files.includes('check.mjs') && files.includes('brand-book.md') && files.includes('art/logo.png'), 'the never-phrase check must read the scripts, the docs and the art');
  for (const f of files) check(!NEVER_PHRASE.test(readFileSync(at(f)).toString('latin1')), `${f} holds a phrase that may appear nowhere in the kit (NEVER_PHRASE in check.mjs)`);
  for (const [base, build] of builders()) {
    DRAWN.length = 0;
    build();
    // A word lettered on two lines comes back as "FIRST / SECOND", so the lines are joined with a space first.
    check(!DRAWN.some((w) => NEVER_PHRASE.test(w.text.replace(/\s*\/\s*/g, ' '))), `${base} letters a phrase that may appear nowhere in the kit (NEVER_PHRASE in check.mjs)`);
  }
  DRAWN.length = 0;
}

/** Every row of the brand book's contrast table gives the real WCAG ratio to two places, and passes 4.5:1. */
function checkContrast() {
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const named = (name) => {
    const key = name.trim().toLowerCase().replace(/\s+(\w)/g, (_, c) => c.toUpperCase());
    return C[key] ?? MIX[key] ?? null;
  };
  const rows = text('brand-book.md').split('\n').filter((l) => /^\| [A-Z][a-z]+( [a-z]+)? on [a-z]+( [a-z]+)? \| \d+\.\d\d:1 \|/.test(l));
  check(rows.length >= 14, `brand-book.md: expected at least 14 rows in the contrast table, found ${rows.length}`);
  for (const row of rows) {
    const [, fg, bg, stated] = row.match(/^\| (.+?) on (.+?) \| (\d+\.\d\d):1 \|/);
    const [a, b] = [named(fg), named(bg)];
    if (!check(a && b, `brand-book.md contrast row names a color outside the palette: ${fg} on ${bg}`)) continue;
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    const ratio = (hi + 0.05) / (lo + 0.05);
    check(ratio.toFixed(2) === stated, `brand-book.md: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, the table says ${stated}:1`);
    check(ratio >= 4.5, `brand-book.md: ${fg} on ${bg} is below 4.5:1 and cannot be text`);
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

/** README lists every file and folder at the top of the kit, and every art piece. */
function checkReadme(scenes) {
  const readme = text('README.md');
  const top = list('./').filter((n) => !n.startsWith('.') || n === '.gitattributes');
  for (const name of top) check(readme.includes(name), `README.md does not list ${name}`);
  for (const [base] of FIXED) check(readme.includes(`${base}.png`), `README.md does not list ${base}.png`);
  check(readme.includes('art/logo-48.png') && readme.includes(`scene-${scenes.at(-1)}`), 'README.md must name art/logo-48.png and the last scene');
  for (const f of list('src')) check(readme.includes(`src/${f}`) || text('art-notes.md').includes(`src/${f}`), `src/${f} is not described in README.md or art-notes.md`);
}

/** Words stay clear of the edges: 60 px on the X banner, 48 px everywhere else. */
function checkMargins() {
  const sizes = Object.fromEntries([...FIXED.map(([b, w, h]) => [b, [w, h]]), ...SCENES.map((s) => [`art/scenes/scene-${s.n}`, [SCENE_PX, SCENE_PX]])]);
  for (const [base, build] of builders()) {
    DRAWN.length = 0;
    const svg = build();
    const [w, h] = sizes[base];
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

/** The mark keeps 2 modules of bare ground on every side and sits inside 95% of a round crop. */
function checkMark(Resvg) {
  for (const [name, size, svg] of [['logo', 1024, logoSvg()], ['x-avatar', 400, avatarSvg()]]) {
    const art = pixels(Resvg, svg);
    const bare = pixels(Resvg, markBareSvg(size));
    const m = size / MARK_GRID;
    const band = differences(art, bare, (x, y) => x < 2 * m || y < 2 * m || x >= size - 2 * m || y >= size - 2 * m);
    check(band === 0, `${name}: ${band} pixels of the mark fall in the 2-module clear space`);
    const r = (size / 2) * 0.95;
    const round = differences(art, bare, (x, y) => (x + 0.5 - size / 2) ** 2 + (y + 0.5 - size / 2) ** 2 > r * r);
    check(round === 0, `${name}: ${round} pixels of the mark fall outside 95% of a round crop`);
  }
}

/** The X banner's bottom-left corner is the bare ground, so the avatar can overlap it. */
function checkCorner(Resvg) {
  const art = pixels(Resvg, xBannerSvg());
  const bare = pixels(Resvg, xBannerBareSvg());
  const { x: cx, y: cy, w: cw, h: ch } = AVATAR_CORNER;
  const n = differences(art, bare, (x, y) => x >= cx && x < cx + cw && y >= cy && y < cy + ch);
  check(n === 0, `x-banner: ${n} pixels in the avatar corner differ from bare ground`);
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

const { scenes } = checkFiles();
checkPalette();
checkRegistry();
checkStorybook(scenes);
checkWords();
checkTradeOffs();
checkDrawn();
checkNeverPhrase();
checkContrast();
checkReadme(scenes);
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
process.stdout.write(`ok: ${passed} checks passed (${scenes.length} scenes, a coin pile with no items)\n`);
