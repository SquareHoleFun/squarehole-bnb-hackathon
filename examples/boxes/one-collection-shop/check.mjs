import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pieces } from './src/logo.mjs';
import { toPng } from './build-art.mjs';
import { validateExample } from '../../../packages/box-spec/examples/v2/registry.mjs';
import { KIT_TEXT } from '../../../scripts/kits/catalog.mjs';

export const root = dirname(fileURLToPath(import.meta.url));
/** The repository this kit sits in (examples/boxes/one-collection-shop). */
export const repository = resolve(root, '../../..');
const ID = 'one-collection-shop';
/** Every file of the kit; anything else is unexpected. `build/` is the ignored bundle output. */
export const FILES = Object.freeze(['.gitattributes', 'README.md', 'art/logo.png', 'art/logo.svg', 'build-art.mjs', 'check.mjs', 'check.test.mjs',
  'mint-plan.json', `settings/${ID}-boxspec-v2.json`, 'src/logo.mjs']);
/** Lines the founder approved word for word for every shop box (desk round 48); the README carries both. */
export const APPROVED = Object.freeze(['Fees fill the shop up to a ceiling, then go to holders.',
  'whoever picks the collections decides who can sell into a budget the fees pay for']);
const RULES = [
  ['banned word', /\b(?:earn\w*|yield\w*|returns?|gains?|profit\w*|income\w*|invest\w*|moon\w*|100x|prices|fit|misfits?|apy|guaranteed|risk[\s-]*free)\b/gi],
  ['token wording', /\b(?:token[\s-]+only|just the token)\b/gi],
  ['calendar date', /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b|\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}\b/g],
  ['wallet address', /\b0x[a-fA-F\d]{40}\b/g],
  ['market quote', /[$€£]\s*\d|\b\d+(?:\.\d+)?\s*(?:USD|EUR|GBP)\b/gi],
  ['em dash', /\u2014/g],
];
/** Word rules for the kit's texts and the spec description: no claims, quotes, dates, addresses or em dashes. */
export const wordProblems = text => RULES.flatMap(([name, pattern]) => [...text.matchAll(pattern)].map(m => `${name}: ${m[0]}`));

function listFiles(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const name = prefix + entry.name;
    if (entry.isSymbolicLink()) throw Error(`symlink refused: ${name}`);
    return entry.isDirectory() ? listFiles(join(dir, entry.name), `${name}/`) : [name];
  });
}
/** A relative link must name a regular file inside the repository, through any symlink. */
function linkInside(dir, repo, link) {
  try {
    const target = realpathSync(resolve(dir, link));
    return !relative(realpathSync(repo), target).startsWith('..') && statSync(target).isFile();
  } catch { return false; }
}

/** `read` lets tests corrupt one input without changing kit files; `dir`/`repo` let them check a copy. */
export function checkKit({ dir = root, repo = repository, read = file => readFileSync(join(dir, file)) } = {}) {
  const problems = [];
  const check = (ok, message) => { if (!ok) problems.push(message); };
  const get = file => { try { return read(file); } catch { problems.push(`${file}: missing or unreadable`); return null; } };
  let actual = [];
  try { actual = listFiles(dir).filter(name => !name.startsWith('build/')); } catch (error) { problems.push(error.message); }
  for (const name of FILES) check(actual.includes(name), `missing ${name}`);
  for (const name of actual) check(FILES.includes(name), `unexpected ${name}`);
  const readme = get('README.md')?.toString() ?? '';
  check(readme.trim().length > 200, 'README.md: missing content');
  problems.push(...wordProblems(readme).map(problem => `README.md: ${problem}`));
  const flat = readme.replace(/\s+/g, ' ');
  for (const line of APPROVED) check(flat.includes(line), `README.md: missing the approved line "${line}"`);
  for (const [, link] of readme.matchAll(/\]\(([^)]+)\)/g)) {
    if (/^(?:https:\/\/|#)/.test(link)) continue;
    check(linkInside(dir, repo, link.split('#')[0]), `README.md: broken link ${link}`);
  }
  problems.push(...wordProblems(KIT_TEXT[ID] ?? '').map(problem => `spec description: ${problem}`));
  check(Buffer.byteLength(KIT_TEXT[ID] ?? '') > 0 && Buffer.byteLength(KIT_TEXT[ID]) <= 1024, 'spec description: 1 to 1,024 bytes');
  for (const { base, w, h, svg } of pieces()) {
    const stored = get(`${base}.svg`)?.toString();
    if (stored !== undefined) {
      check(stored === svg, `${base}.svg: differs from source`);
      check(!/<(?:text|image|script|foreignObject)\b|\bhref\s*=|url\((?!#)|@import|onload\s*=/i.test(stored), `${base}.svg: must be self-contained shapes`);
      check(stored.includes(`width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"`), `${base}.svg: wrong dimensions`);
      check(/<title>[^<]+<\/title>/.test(stored) && /<desc>[^<]+<\/desc>/.test(stored), `${base}.svg: accessible title and description required`);
      problems.push(...wordProblems(stored).map(problem => `${base}.svg: ${problem}`));
    }
    const png = get(`${base}.png`);
    if (png) {
      const valid = png.length >= 24 && png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' && png.subarray(12, 16).toString() === 'IHDR';
      check(valid && png.readUInt32BE(16) === w && png.readUInt32BE(20) === h, `${base}.png: expected ${w} x ${h}`);
      check(png.equals(toPng(svg)), `${base}.png: stale or invalid render`);
      check(png.length <= 1024 * 1024, `${base}.png: exceeds 1 MiB`);
    }
  }
  const rowText = get(`../../../packages/box-spec/examples/v2/${ID}.json`);
  if (rowText) {
    try {
      const e = validateExample(JSON.parse(rowText));
      const s = e.contents.shop;
      check(e.id === ID && e.ticker === 'SHOP' && e.contents.kind === 'shop' && e.status === 'ready', 'recipe identity differs');
      check(e.template.id === 'shop' && e.template.name === 'Shop', 'recipe must use the Shop template');
      check(e.logo === `examples/boxes/${ID}/art/logo.png`, 'recipe must use this kit logo');
      check(s.curator === 'none' && s.collections.length === 1 && s.collections[0].id === 'bent-cans', 'recipe must be one TA-40 collection with no curator');
      check(s.collections[0].starterIds.join() === '3,4,5,6,7,8,9,10,11,12', 'starters must be Bent Cans ids 3 to 12');
      check(BigInt(s.seedT) === 2n * BigInt(s.givePricesT[0]), 'seed must be exactly two sell-backs');
      check(s.pickBps === '20000' && e.priceCoin.symbol === 'ETH', 'pick multiple or price coin differs');
      check(e.fees.buyers.choice === 'holders' && e.fees.sellers.choice === 'shop' && e.fees.sellers.ceilingPreset === '2', 'fee sides differ');
    } catch (error) { problems.push(`registry: ${error.message}`); }
  }
  const settings = get(`settings/${ID}-boxspec-v2.json`);
  if (settings) {
    try {
      const file = JSON.parse(settings);
      const { keccak256 } = createRequire(join(repo, 'packages/chain/package.json'))('viem');
      check(file.format === 'squarehole.boxspec/2' && keccak256(file.encoded) === file.specHash, 'settings: not a Create download or a damaged one');
      check(file.spec?.tokenName === 'One-collection shop' && file.spec?.tokenSymbol === 'SHOP' && file.spec?.boxType === 4, 'settings: not this shop');
      check(file.pictures?.length === 1 && file.pictures[0].role === 'logo' && file.pictures[0].sha256 === file.spec.coverSha256, 'settings: a shop carries its logo alone');
      check(file.revealList === null, 'settings: a shop has no reveal list');
    } catch (error) { problems.push(`settings: ${error.message}`); }
  }
  return problems;
}

// Node gives import.meta.url as the real path, so compare it with the real path of the started file (symlinks).
function isEntry() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (isEntry()) {
  if (process.argv.length > 2) throw new Error('unknown option; run check.mjs without arguments');
  const problems = checkKit();
  if (problems.length) { process.stderr.write(`${problems.join('\n')}\n`); process.exitCode = 1; }
  else process.stdout.write('One-collection shop: checks passed; 1 SVG/PNG pair, the recipe, the settings download and the approved lines\n');
}
