/**
 * Checks the Exit Liquidity kit: every required file is here with its exact pixel size, every PNG has its SVG
 * source, assignment.json is exactly what assign.mjs prints, the storybook matches the scenes, and the kit's
 * words follow the brand rules. Builds the unique edition with the pinned local dependencies; no network.
 *
 *   node check.mjs        exit 0 when everything passes, 1 otherwise
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { assignment, assignmentJson, variantFor, VARIANT_NAMES, COUNT } from './assign.mjs';
import { pieces } from './build-art.mjs';
import { SCENES } from './src/scenes.mjs';
import { logoSvg } from './src/brand.mjs';
import { loadResvg, toPng } from './src/render.mjs';

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
const FIXED = [
  ['art/logo', 1024, 1024], ['art/x-avatar', 400, 400], ['art/x-banner', 1500, 500],
  ['art/cover', 1200, 630], ['art/box-banner', 2400, 600],
];
const ITEM_PX = 1024;
const SCENE_PX = 1200;

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
  const external = /<image\b|<text\b|<script\b|\bhref=|url\((?!#)/i.test(s);
  return { w: num('width'), h: num('height'), viewBox: /viewBox="0 0 \d+ \d+"/.test(head), external, title: /<title>[^<]+<\/title>/.test(s) };
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
  check(f.title, `${svg} needs a <title>`);
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
  for (const doc of DOCS) check(existsSync(at(doc)) && text(doc).trim().length > 200, `missing or empty ${doc}`);
  for (const f of ['assign.mjs', 'assignment.json', 'build-art.mjs', 'check.mjs']) check(existsSync(at(f)), `missing ${f}`);
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
  // Keep the library checks separate from the edition: these twelve inputs are still used by the generator.
  check(VARIANT_NAMES.length === items.length && items.length === 12, 'assign.mjs must name exactly the 12 base families in art/items');
  check(variantFor('404') === '08' && variantFor('1') === '01', 'sign #1 keeps base family 01 and sign #404 keeps base family 08');
  for (const bad of ['0', '405', '01', '-1', '1.0', '', 4, null]) {
    let threw = false;
    try { variantFor(bad); } catch { threw = true; }
    check(threw, `variantFor must refuse ${JSON.stringify(bad)}`);
  }

  try {
    const a = await assignment();
    check(text('assignment.json') === assignmentJson(a), 'assignment.json differs from `node assign.mjs` output');
    const reviewed = JSON.parse(text('unique/manifest.json'));
    check(a.count === COUNT.toString() && BigInt(a.items.length) === COUNT
      && a.items.every((it, i) => it.id === (BigInt(i) + 1n).toString()), 'assignment must list ids 1 to 404 in order');
    check(a.modelPolicy === '2d' && a.items.every(it => it.model === null), '2D edition must assign no models, including review GLBs');
    check(a.seed === reviewed.seed, 'assignment must retain the reviewed seed');
    check(new Set(a.items.map(it => it.picture.sha256)).size === a.items.length, 'every assigned picture must be unique');
    for (const [i, it] of a.items.entries()) {
      const original = reviewed.items[i];
      check(original?.id === it.id && isDeepStrictEqual(it.traits, original.traits), `id ${it.id}: all traits must match the reviewed manifest`);
      check(isDeepStrictEqual(Object.keys(it.traits), a.columns), `id ${it.id}: complete ordered trait columns`);
      check(it.traits.sign === variantFor(it.id) && items.includes(it.traits.sign), `id ${it.id}: original base family must exist`);
      const bytes = readFileSync(it.picture.path);
      check(it.picture.sha256 === `0x${original.picture.sha256}`
        && it.picture.sha256 === `0x${createHash('sha256').update(bytes).digest('hex')}`
        && it.picture.bytes === bytes.length && bytes.length === original.picture.bytes,
      `id ${it.id}: generated picture must match the reviewed sha256 and byte length`);
    }
    const counts = items.map(sign => BigInt(a.items.filter(it => it.traits.sign === sign).length));
    check(counts.reduce((sum, count) => sum + count, 0n) === COUNT, 'base family counts must add up to 404');
    check(counts.every((count, i) => count === (i < 8 ? 34n : 33n)), 'base family counts must remain 34 for 01..08 and 33 for 09..12');
  } catch (error) {
    problems.push(`unique edition verification failed: ${error.message}`);
  }
}

/** Storybook: one picture per scene, each referenced once, at most two sentences under it, same words as src. */
function checkStorybook(scenes) {
  const md = text('storybook.md');
  for (const n of scenes) {
    const ref = `art/scenes/scene-${n}.png`;
    check(md.split(ref).length === 2, `storybook.md must show ${ref} exactly once`);
  }
  for (const s of SCENES) {
    check(md.includes(`![${s.alt}](art/scenes/scene-${s.n}.png)`), `storybook.md scene ${s.n} must use the alt text from src/scenes.mjs`);
    for (const line of s.caption) check(md.includes(line), `storybook.md scene ${s.n} must say: ${line}`);
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
];
const SHAPES = [
  [/\u2014/, 'an em dash'], [/\s\u2013\s/, 'a dash used as a pause'], [/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'an emoji or dingbat'],
  [/0x[0-9a-fA-F]{6,}/, 'an address'], [/\b20\d\d-\d\d-\d\d\b/, 'a date'], [/\$\s?\d/, 'a dollar amount'],
  [/\b\d[\d,]*(\.\d+)?\s?(USDC|ETH|USD)\b/, 'a coin amount'],
];

/** The rules apply to every doc in the kit and to the titles and descriptions inside the SVGs. */
function checkWords() {
  const sources = [...DOCS, 'SH-KIT-EXIT-LIQUIDITY.md'].map((d) => [d, text(d)]);
  const svgs = ['art', 'art/items', 'art/scenes'].filter((dir) => existsSync(at(dir)))
    .flatMap((dir) => list(dir).filter((n) => n.endsWith('.svg')).map((n) => `${dir}/${n}`));
  for (const f of svgs) sources.push([f, (text(f).match(/<(title|desc)>[^<]*<\/\1>/g) ?? []).join(' ')]);
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
  for (const doc of [...DOCS, 'SH-KIT-EXIT-LIQUIDITY.md']) {
    for (const [, target] of text(doc).matchAll(/\]\(([^)\s#]+)(#[^)]*)?\)/g)) {
      if (/^[a-z]+:/i.test(target)) continue;
      const leavesKit = target.startsWith('../');
      if (leavesKit && !inRepo) continue;
      check(existsSync(at(target)), `${doc} links to ${target}, which does not exist`);
    }
  }
}

/** README lists every file and folder at the top of the kit, and every art piece. */
function checkReadme(items, scenes) {
  const readme = text('README.md');
  const top = list('./').filter((n) => !n.startsWith('.'));
  for (const name of top) check(readme.includes(name), `README.md does not list ${name}`);
  for (const [base] of FIXED) check(readme.includes(`${base}.png`), `README.md does not list ${base}.png`);
  check(readme.includes(`variant-${items.at(-1)}`) && readme.includes(`scene-${scenes.at(-1)}`), 'README.md must name the last variant and the last scene');
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

const { items, scenes } = checkFiles();
await checkAssignment(items);
checkStorybook(scenes);
checkWords();
checkReadme(items, scenes);
checkLinks();
await checkFresh();

if (problems.length) {
  process.stderr.write(`${problems.map((p) => `FAIL ${p}`).join('\n')}\n${problems.length} problem(s), ${passed} checks passed\n`);
  process.exit(1);
}
process.stdout.write(`ok: ${passed} checks passed (404 unique 2D pictures, ${items.length} base families, ${scenes.length} scenes)\n`);
