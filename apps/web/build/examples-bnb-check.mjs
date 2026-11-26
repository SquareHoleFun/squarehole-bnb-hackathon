/**
 * SH-323: the BNB Chain version of the examples page. apps/web/build/examples-bnb/ holds only the files of
 * apps/web/public/examples that differ on the hackathon site (BNB Chain test network): the page and the scripts whose
 * words name the price coin, and every size and format of each slide whose picture letters it on a coin. A build lays
 * the folder over a copy of the page, so it may only replace files, never add new names.
 *
 *   node apps/web/build/examples-bnb-check.mjs
 *
 * Checks, with plain Node and no dependency:
 *   1. every file under build/examples-bnb exists under public/examples at the same relative path;
 *   2. the overlay's index.html and scripts hold no "ETH" and no "Ethereum" as a word;
 *   3. for each re-lettered slide (a slide with a picture in the overlay's art folder), every picture address the
 *      overlay's index.html names for it exists in the overlay, and so does every size and format the source has.
 * Prints the count of overlay files and exits 0, or lists the problems and exits 1.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OVERLAY = join(HERE, 'examples-bnb');
const SOURCE = join(HERE, '..', 'public', 'examples');

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const rel = (root, p) => relative(root, p).split(sep).join('/');

const problems = [];
if (!existsSync(OVERLAY) || !statSync(OVERLAY).isDirectory()) {
  console.error(`examples-bnb: no overlay folder at ${OVERLAY}`);
  process.exit(1);
}
const files = walk(OVERLAY).map((p) => rel(OVERLAY, p)).sort();

// 1. the overlay only replaces files
for (const f of files) if (!existsSync(join(SOURCE, f))) problems.push(`${f}: no file of that name under public/examples`);

// 2. no ETH and no Ethereum in the page or its scripts
const WORD = /\b(ETH|Ethereum)\b/g;
for (const f of files.filter((n) => /\.(html|js)$/.test(n))) {
  readFileSync(join(OVERLAY, f), 'utf8').split('\n').forEach((line, i) => {
    for (const m of line.matchAll(WORD)) problems.push(`${f}:${i + 1}: "${m[0]}" near "${line.slice(Math.max(0, m.index - 30), m.index + 30)}"`);
  });
}

// 3. the re-lettered slides are complete
// The slides whose pictures letter the price coin (ETH in the source). Dragon's Hoard's slides show plain gold coins.
const RELETTERED = ['basics-1', 'basics-2', 'basics-3'];
const slides = [...new Set(files.map((f) => f.match(/^art\/slide-(.+)-(tall|wide)-\d+x\d+\.(avif|webp|jpg)$/)?.[1]).filter(Boolean))].sort();
for (const s of slides) if (!RELETTERED.includes(s)) problems.push(`slide-${s}: pictures in the overlay, but not a re-lettered slide`);
for (const s of RELETTERED) if (!slides.includes(s)) slides.push(s);
slides.sort();
for (const f of files) if (f.startsWith('art/') && !/^art\/slide-/.test(f)) problems.push(`${f}: only slide pictures belong in the overlay's art folder`);
const page = files.includes('index.html') ? readFileSync(join(OVERLAY, 'index.html'), 'utf8') : '';
if (!page) problems.push('index.html: missing from the overlay');
for (const s of slides) {
  const named = [...new Set(page.match(new RegExp(`/examples/art/slide-${s}-(?:tall|wide)-\\d+x\\d+\\.(?:avif|webp|jpg)`, 'g')) ?? [])];
  if (named.length === 0) problems.push(`slide-${s}: index.html names no picture of it`);
  for (const a of named) if (!files.includes(a.replace('/examples/', ''))) problems.push(`slide-${s}: index.html names ${a}, not in the overlay`);
  for (const f of readdirSync(join(SOURCE, 'art')).filter((n) => n.startsWith(`slide-${s}-`)))
    if (!files.includes(`art/${f}`)) problems.push(`slide-${s}: the source has art/${f}, the overlay does not`);
}

if (problems.length) {
  console.error(`examples-bnb: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
const art = files.filter((f) => f.startsWith('art/')).length;
process.stdout.write(`examples-bnb: ${files.length} overlay files (${files.length - art} page and script files, ${art} pictures of ${slides.length} re-lettered slides: ${slides.join(', ')}); all checks pass\n`);
