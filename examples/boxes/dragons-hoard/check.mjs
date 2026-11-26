/**
 * Checks the Dragon's Hoard kit: every required file is here with its exact pixel size, every PNG has its SVG source
 * and is a fresh render of it, the mark keeps its clear space and fits a round crop, the X banner keeps its avatar
 * corner bare, words stay clear of the edges, the storybook matches the scenes, the docs match the registry
 * settings, and the kit's words follow the brand rules. No network.
 *
 *   node check.mjs        exit 0 when everything passes, 1 otherwise
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { pieces, builders } from './build-art.mjs';
import { SCENES } from './src/scenes.mjs';
import { logoSvg, avatarSvg, markBareSvg, xBannerSvg, xBannerBareSvg, AVATAR_CORNER, MARK_GRID, COVER_LINE } from './src/brand.mjs';
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
const RECORD = 'SH-KIT-DRAGONS-HOARD.md';
const FIXED = [
  ['art/logo', 1024, 1024], ['art/x-avatar', 400, 400], ['art/x-banner', 1500, 500],
  ['art/cover', 1200, 630], ['art/box-banner', 2400, 600],
];
const SCENE_PX = 1200;
const REGISTRY = '../../../packages/box-spec/examples/v2/';
const BOX_ID = 'dragons-hoard';

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
  check(!existsSync(at('art/items')) && !existsSync(at('assign.mjs')) && !existsSync(at('assignment.json')), "Dragon's Hoard is a coin pile: art/items, assign.mjs and assignment.json must not exist");
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
  check(box.contents.kind === 'pile' && box.contents.size === '0', 'registry: dragons-hoard is expected to be a coin pile; review the kit if that changed');
  check(box.fees.buyers.choice === 'pile' && box.fees.sellers.choice === 'burn', 'registry: buyers are expected to feed the pile and sellers to burn; review the kit if that changed');
  check(box.contents.leaveBehindBps === '500', 'registry: the leave-behind is expected to be 500 basis points; review the kit if that changed');
  check(box.contents.seed?.symbol === box.priceCoin.symbol, 'registry: the pile is expected to hold the price coin; review the kit if that changed');
  const details = text('details.md');
  const facts = [box.name, box.ticker, box.status, box.template.id, box.priceCoin.symbol, box.priceCoin.decimals, box.contents.kind,
    box.contents.seed.amount, box.contents.leaveBehindBps, box.contents.pickFeeBps, box.raise.policy, box.deadline.days,
    box.royalties.bps, box.fees.buyers.choice, box.fees.sellers.choice, box.life, ...box.properties];
  for (const fact of facts) check(details.includes(`\`${fact}\``), `details.md must show the registry value \`${fact}\``);
  if (box.status === 'pending') check(details.includes(`\`${box.pendingStep}\``), `details.md must name the pending step \`${box.pendingStep}\``);
  const book = text('brand-book.md');
  check(book.includes(`**Name:** ${box.name}.`) && book.includes(`**Ticker:** ${box.ticker}.`), `brand-book.md must name ${box.name} and ${box.ticker}`);
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
  /\bdividends?\b/i, /\brewards?\b/i, /\bprize\b/i, /\bjackpot\b/i, /\bwealth\b/i, /\briches\b/i, /\bfortune\b/i,
  /\btreasure\b/i, /\bloot\b/i, /\binterest\b/i, /\bupside\b/i, /\bflywheel\b/i, /\bgrow(s|ing|th|n)?\b/i,
  /\bincreas(e|es|ed|ing)\b/i, /\bris(e|es|en|ing)\b/i, /\bapprec\w*/i, /\baccru\w*/i, /\bback(ed|ing)\b/i,
  /\bscarc\w*/i, /\bdeflation\w*/i, /\bfair share\b/i, /\bhodl\b/i, /\bdiamond hands\b/i, /\bpaper hands\b/i,
  // Square Hole's own token and collection, and the word the founder took out of the UI (F130).
  /\bFIT\b/, /\bmisfits?\b/i, /\bdemo\b/i,
  // The homage names nothing: no project behind the guild-bank idea, and no story, film or game dragon.
  /\bmoloch\b/i, /\brage[- ]?quit\w*/i, /\bsmaug\b/i, /\bhobbit\b/i, /\btolkien\b/i, /\btoothless\b/i, /\bspyro\b/i,
  /\btargaryen\b/i, /\bskyrim\b/i, /\bgame of thrones\b/i, /\bdungeons\b/i, /\bD&D\b/,
];
const SHAPES = [
  [/—/, 'an em dash'], [/\s–\s/, 'a dash used as a pause'], [/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'an emoji or dingbat'],
  [/0x[0-9a-fA-F]{6,}/, 'an address'], [/\b(19|20)\d\d\b/, 'a year or date'], [/\$\s?\d/, 'a dollar amount'],
  [/\b\d[\d,]*(\.\d+)?\s?(ETH|HOARD|USDC|USD|WETH)\b/, 'a coin amount'],
];

/** The rules apply to every doc in the kit and to the titles and descriptions inside the SVGs. */
function checkWords() {
  const sources = [...DOCS, RECORD].map((d) => [d, text(d)]);
  const svgs = ['art', 'art/scenes'].filter((dir) => existsSync(at(dir)))
    .flatMap((dir) => list(dir).filter((n) => n.endsWith('.svg')).map((n) => `${dir}/${n}`));
  for (const f of svgs) {
    const words = (text(f).match(/<(title|desc)>[^<]*<\/\1>/g) ?? []).join(' ');
    sources.push([f, words]);
    check(!/\bETH\b/.test(words), `${f} names the price coin; the art only ever shows plain coins`);
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
  const cover = COVER_LINE.map((l) => l[0] + l.slice(1).toLowerCase()).join(' ');
  check(book.includes(`**Cover line:** "${cover}"`) && book.includes(`| Cover | "${cover}" |`), `brand-book.md must carry the cover line "${cover}" in Identity and in the example lines`);
  const quoted = [...book.matchAll(/"([^"]*\bfeed the\b[^"]*)"/g)].map((m) => m[1]);
  check(quoted.every((q) => q === cover), `brand-book.md quotes a cover line that differs from the art: ${quoted.filter((q) => q !== cover).join(' | ')}`);
  check(book.includes('"In plain words, buyers\' fees go to the pile, and sellers\' fees buy HOARD and burn it."'), 'brand-book.md must carry the literal line next to the cover line');
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
