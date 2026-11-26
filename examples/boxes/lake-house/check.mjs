/**
 * Checks the Lake House kit offline: every file is here; the art is a fresh build of src/ (which samples the palette
 * again from the reference pictures, ADR-0004); the mark is 1024 x 1024 and 48 x 48 and its SVG is self-contained;
 * the registry row and the About line agree; the storybook keeps its seven scenes with a picture line and two caption
 * lines each; every picture link resolves; and the kit's words follow the public wording rules (F158).
 *
 *   node examples/boxes/lake-house/check.mjs    exit 0 when everything passes, 1 otherwise
 */
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { pieces } from './build-art.mjs';
import { loadResvg } from './src/render.mjs';
import { validateExample } from '../../../packages/box-spec/examples/v2/registry.mjs';
import { KIT_TEXT } from '../../../scripts/kits/catalog.mjs';

const root = new URL('./', import.meta.url);
const repo = new URL('../../../', import.meta.url);
export const ABOUT = 'Test coins. Mock house, not legal title. Payments go into the pile; hand in HOUSE for a share.';
const DOCS = ['README.md', 'storybook.md', 'art-notes.md'];
const CODE = ['build-art.mjs', 'check.mjs', 'src/logo.mjs', 'src/palette.mjs', 'src/render.mjs', 'src/sample.mjs'];
const SIZES = { 'art/logo.png': 1024, 'art/logo-48.png': 48 };
const SCENES = ['The house', 'The company', 'The manager', 'The cap', 'Guests pay', 'Into the pile', 'Hand in HOUSE'];
/** The one README line that names the refused words, so a reader knows them; every other line is checked. */
const RULE_LINE = '- Never, in anything public: earn, yield, APY, rent income, returns (F158: they wait for counsel). No "LLC": the';
const RULES = [
  /\bearn(?:s|ed|ing|ings)?\b/i, /\byields?\b/i, /\bapy\b/i, /\brent(?:al)? income\b/i, /\breturns?\b/i,
  /\bprofits?\b/i, /\bdividends?\b/i, /\bpassive\b/i, /\binvest(?:s|ed|ing|ment|ments|or|ors)?\b/i,
  /\bguarantee[sd]?\b/i, /\brisk[\s-]*free\b/i, /\bLLC\b/, /—/,
];
export const wordProblems = text => text.split('\n').filter(line => line !== RULE_LINE)
  .flatMap(line => RULES.filter(rule => rule.test(line)).map(rule => `word rule ${rule}`));

/** Read injection lets tests corrupt one input without touching a kit file. */
export function checkKit({ read = file => readFileSync(new URL(file, root)), Resvg }) {
  const problems = [];
  const check = (ok, message) => { if (!ok) problems.push(message); return ok; };
  const get = file => { try { return read(file); } catch { problems.push(`${file}: missing or unreadable`); return null; } };
  const docs = {};
  for (const file of DOCS) {
    const data = get(file);
    if (!data) continue;
    const text = data.toString();
    docs[file] = text;
    for (const problem of wordProblems(text)) problems.push(`${file}: ${problem}`);
    for (const [, link] of text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) if (!/^https?:/.test(link)) get(link);
  }
  for (const file of CODE) get(file);
  let built = [];
  try {
    built = pieces(Resvg, path => readFileSync(new URL(path, repo)));
  } catch (error) { problems.push(`palette: ${error.message}`); }
  for (const [path, bytes] of built) {
    const stored = get(path);
    if (stored) check(stored.equals(bytes), `${path}: stale; run build-art.mjs`);
  }
  for (const [path, side] of Object.entries(SIZES)) {
    const png = get(path);
    if (!png) continue;
    const ok = png.length > 24 && png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' && png.subarray(12, 16).toString() === 'IHDR';
    check(ok && png.readUInt32BE(16) === side && png.readUInt32BE(20) === side, `${path}: expected ${side} x ${side}`);
  }
  const svg = get('art/logo.svg')?.toString() ?? '';
  check(!/<(?:text|image|script|foreignObject|style)\b|\bhref\s*=|url\(|@import|\bon[a-z]+\s*=/i.test(svg), 'art/logo.svg: must be self-contained shapes');
  check(svg.includes('width="1024" height="1024" viewBox="0 0 1024 1024"'), 'art/logo.svg: wrong dimensions');
  check(/<title>[^<]+<\/title>/.test(svg) && /<desc>[^<]+<\/desc>/.test(svg), 'art/logo.svg: a title and a description are required');
  for (const problem of wordProblems(svg)) problems.push(`art/logo.svg: ${problem}`);
  const row = JSON.parse(readFileSync(new URL('packages/box-spec/examples/v2/lake-house.json', repo), 'utf8'));
  try { validateExample(row); } catch (error) { problems.push(`registry row: ${error.message}`); }
  check(row.logo === 'examples/boxes/lake-house/art/logo.png', 'registry row: logo must be art/logo.png');
  check(row.name === 'Lake House' && row.ticker === 'HOUSE', 'registry row: name Lake House, ticker HOUSE');
  check(KIT_TEXT['lake-house'] === ABOUT, 'scripts/kits/catalog.mjs: the About line differs from the design');
  check((docs['README.md'] ?? '').includes(`**${ABOUT}**`), 'README.md: the About line must appear in bold, exactly');
  const story = docs['storybook.md'] ?? '';
  const scenes = [...story.matchAll(/^## (\d\d) · (.+)\n\n(Picture: .+)\n\n(.+)\n(.+)\n/gm)];
  check(scenes.length === SCENES.length, `storybook.md: ${SCENES.length} scenes with a picture line and two caption lines expected, found ${scenes.length}`);
  scenes.forEach((scene, i) => check(scene[1] === String(i + 1).padStart(2, '0') && scene[2] === SCENES[i], `storybook.md: scene ${i + 1} must be ${SCENES[i]}`));
  return problems;
}

function startedDirectly() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (startedDirectly()) {
  const problems = checkKit({ Resvg: await loadResvg() });
  if (problems.length) { process.stderr.write(`${problems.join('\n')}\n`); process.exitCode = 1; }
  else process.stdout.write(`lake-house kit: ok (${DOCS.length} pages, 4 built files, ${SCENES.length} scenes)\n`);
}
