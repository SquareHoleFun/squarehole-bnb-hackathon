import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { pieces, SCENES } from './src/art.mjs';
import { toPng } from './build-art.mjs';
import { validateExample } from '../../../packages/box-spec/examples/v2/registry.mjs';

const root = new URL('./', import.meta.url);
const DOCS = ['README.md', 'SH-KIT-THE-ALCHEMIST.md', 'art-notes.md', 'storybook.md'];
const RULES = [
  /\b(?:fit|misfits?)\b/i, /\$1\b/, /\btoken[\s-]+only\b/i,
  /\b(?:guaranteed|risk[\s-]*free|yield|apy)\b/i, /\b(?:tether|paxos)\b/i,
];
export const wordProblems = text => RULES.filter(rule => rule.test(text)).map(rule => `word rule ${rule}`);

/** Read injection lets tests corrupt a single input without changing or deleting kit files. */
export function checkKit({ read = file => readFileSync(new URL(file, root)) } = {}) {
  const problems = [];
  const check = (ok, message) => { if (!ok) problems.push(message); };
  const get = file => {
    try { return read(file); } catch { problems.push(`${file}: missing or unreadable`); return null; }
  };
  const words = (file, text) => wordProblems(text).forEach(problem => problems.push(`${file}: ${problem}`));
  const docs = {};
  for (const file of DOCS) {
    const data = get(file);
    if (!data) continue;
    const text = data.toString(); docs[file] = text;
    check(text.trim().length > 200, `${file}: missing content`);
    words(file, text);
    for (const [, link] of text.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^(?:https?:|#)/.test(link)) continue;
      const filePath = link.split('#')[0];
      if (filePath) get(filePath);
    }
  }
  const art = pieces();
  check(art.length === 10 && SCENES.length === 7, 'expected ten pictures and seven scenes');
  const seen = new Set();
  for (const { base, w, h, svg } of art) {
    const stored = get(`${base}.svg`);
    if (stored) {
      const text = stored.toString();
      check(text === svg, `${base}.svg: differs from source`);
      check(!/<(?:text|image|script|foreignObject)\b|\bhref\s*=|url\((?!#)|@import|onload\s*=/i.test(text), `${base}.svg: must be self-contained shapes`);
      check(text.includes(`width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"`), `${base}.svg: wrong dimensions`);
      check(/<title>[^<]+<\/title>/.test(text) && /<desc>[^<]+<\/desc>/.test(text), `${base}.svg: accessible title and description required`);
      words(`${base}.svg`, text);
    }
    const png = get(`${base}.png`);
    if (png) {
      const valid = png.length >= 24 && png.subarray(0,8).toString('hex') === '89504e470d0a1a0a' && png.subarray(12,16).toString() === 'IHDR';
      check(valid && png.readUInt32BE(16) === w && png.readUInt32BE(20) === h, `${base}.png: expected ${w} x ${h}`);
      check(png.equals(toPng(svg)), `${base}.png: stale or invalid render`);
      check(png.length <= 1024 * 1024, `${base}.png: exceeds 1 MiB`);
      // PNG bytes are deterministic; ten different pictures must stay different.
      const encoded = png.toString('base64');
      check(!seen.has(encoded), `${base}.png: duplicate picture`); seen.add(encoded);
    }
  }
  for (const s of SCENES) {
    check(docs['storybook.md']?.includes(s.caption), `storybook.md: scene ${s.n} caption differs`);
    check(docs['storybook.md']?.includes(`art/scenes/scene-${s.n}.png`), `storybook.md: scene ${s.n} art link missing`);
  }
  const settings = docs['SH-KIT-THE-ALCHEMIST.md'] ?? '';
  for (const phrase of ['Test PEPE', 'Test Gold', 'TA-30', 'PEPE -> WETH -> gold', '5%', '500', 'zero seed', 'ALCHEMIST-REGISTRATION', 'destination 9', 'choice 10', 'Burn', 'mainnet', 'not listed', 'inbox']) {
    check(settings.includes(phrase), `setup: missing ${phrase}`);
  }
  const row = get('../../../packages/box-spec/examples/v2/the-alchemist.json');
  if (row) {
    try {
      const e = validateExample(JSON.parse(row));
      check(e.id === 'the-alchemist' && e.ticker === 'LEAD' && e.template.id === 'pile' && e.template.name === 'Coin pile', 'recipe identity/template differs');
      check(e.status === 'pending' && e.pendingStep === 'ALCHEMIST-REGISTRATION', 'recipe must wait for chain registration');
      check(e.priceCoin.symbol === 'TEST_PEPE' && e.contents.seed?.symbol === 'TEST_GOLD' && e.contents.seed.amount === '0', 'recipe must use test stand-ins and zero seed');
      check(e.contents.leaveBehindBps === '500' && e.fees.buyers.choice === 'alchemist' && e.fees.sellers.choice === 'burn', 'fee sides or leave-behind differ');
      check(e.logo === 'examples/boxes/the-alchemist/art/logo.png', 'recipe must use this kit logo');
      check(e.contents.size === '0' && e.contents.art.source === null && e.contents.art.mode === 'none', 'pile must not acquire a collection');
    } catch (error) { problems.push(`registry: ${error.message}`); }
  }
  return problems;
}
function isEntry() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (isEntry()) {
  if (process.argv.length > 2) throw new Error('unknown option; run check.mjs without arguments');
  const problems = checkKit();
  if (problems.length) {
    process.stderr.write(`${problems.join('\n')}\n`); process.exitCode = 1;
  } else process.stdout.write('The Alchemist: checks passed; 10 SVG/PNG pairs; 7 scenes\n');
}
