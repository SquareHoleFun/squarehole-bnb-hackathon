import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';

export const root = dirname(fileURLToPath(import.meta.url));
/** The repository this kit sits in (examples/boxes/junkyard). */
export const repository = resolve(root, '../../..');
export const sizes = {
  'art/logo.png': [1024, 1024],
  'art/x-avatar.png': [400, 400],
  'art/x-banner.png': [1500, 500],
  'art/cover.png': [1200, 630],
  'art/box-banner.png': [1600, 600],
  ...Object.fromEntries(Array.from({ length: 8 }, (_, i) =>
    [`art/scenes/scene-${String(i + 1).padStart(2, '0')}.png`, [1200, 800]])),
};
const texts = ['README.md', 'brand-book.md', 'storybook.md', 'details.md', 'prompts.md'];
export const original = (name) => name.replace(/\.png$/, '-original.png');
const earlierOriginal = 'art/scenes/scene-04-first-original.png';
const sha = (data) => createHash('sha256').update(data).digest('hex');
/** Lines the founder approved word for word for every shop box (desk round 48). details.md carries each one. */
export const approved = [
  'Fees fill the shop up to a ceiling, then go to holders.',
  'whoever picks the collections decides who can sell into a budget the fees pay for',
];

/** The approved lines a text leaves out. A line break inside a line still counts as a space. */
export function missingApproved(text) {
  const flat = text.replace(/\s+/g, ' ');
  return approved.filter((line) => !flat.includes(line));
}

export function scanText(text) {
  const rules = [
    ['banned word', /\b(?:earn\w*|yield\w*|returns?|gains?|profit\w*|income\w*|invest\w*|moon\w*|100x|prices|fit|misfits?)\b/gi],
    ['calendar date', /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b|\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b|\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}\b|\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/gi],
    ['wallet address', /\b0x[a-f\d]{40}\b|\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g],
    ['market quote', /[$€£]\s*\d|\b\d+(?:\.\d+)?\s*(?:USD|EUR|GBP)\b/gi],
    ['em dash', /\u2014/g],
  ];
  return rules.flatMap(([name, pattern]) => [...text.matchAll(pattern)].map((m) => `${name}: ${m[0]}`));
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function pngSize(data) {
  if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw Error('not PNG');
  let offset = 8;
  let header;
  let ended = false;
  const compressed = [];
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > data.length) throw Error('truncated PNG');
    const type = data.toString('ascii', offset + 4, offset + 8);
    const payload = data.subarray(offset + 8, end - 4);
    if (crc32(data.subarray(offset + 4, end - 4)) !== data.readUInt32BE(end - 4)) throw Error('PNG CRC mismatch');
    if (offset === 8 && type !== 'IHDR') throw Error('missing PNG header');
    if (type === 'IHDR') {
      if (header || length !== 13) throw Error('invalid PNG header');
      header = payload;
    }
    if (type === 'IDAT') compressed.push(payload);
    if (type === 'IEND') { ended = true; offset = end; break; }
    offset = end;
  }
  if (!header || !ended || offset !== data.length || !compressed.length) throw Error('incomplete PNG');
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header[9]];
  if (!width || !height || !channels || header[12] !== 0) throw Error('unsupported PNG layout');
  const stride = Math.ceil(width * channels * header[8] / 8) + 1;
  const pixels = inflateSync(Buffer.concat(compressed), { maxOutputLength: stride * height });
  if (pixels.length !== stride * height) throw Error('invalid PNG pixels');
  for (let row = 0; row < height; row++) if (pixels[row * stride] > 4) throw Error('invalid PNG filter');
  return [width, height];
}

/**
 * Files other tickets own and test beside the kit, listed one by one: TA-23's generated Create settings (scripts/kits)
 * and exactly the files TA-40 added for its Sepolia test collections (c5efaf84d: five collections, pictures 1 and 2 as
 * SVG and PNG with a traits file, the catalog, pin manifest, scripts and tests). Anything else is unexpected, at any
 * depth. `build/` is the ignored kit bundle output.
 */
export const neighbours = Object.freeze([
  'settings/junkyard-boxspec-v2.json',
  // The registry row's logo: art/logo.png at 256 px by the kit encoder (scripts/kits/pictures.mjs encodePicture), 92,714 B,
  // inside one raw block and Sepolia's free Arweave item; the 1 MB original fits neither.
  'art/logo-256.png',
  ...['README.md', 'art.mjs', 'art.test.mjs', 'build-art.mjs', 'catalog.json', 'export-car.mjs', 'pin-manifest.json',
    'settings.mjs', 'settings.test.mjs'].map((name) => `test-collections/${name}`),
  ...['bent-cans', 'cracked-mugs', 'lost-cogs', 'split-boots', 'tangled-wires'].flatMap((key) =>
    ['1.png', '1.svg', '2.png', '2.svg', 'traits.json'].map((name) => `test-collections/art/${key}/${name}`)),
]);
/** The one link out of the kit: TA-23's shared kit-settings guide (the Load it line). */
export const settingsGuide = '../../../scripts/kits/README.md';
/** The guide link resolves, through any symlink, to that regular file inside the repository. */
function guideInside(dir, repo) {
  try {
    const target = realpathSync(resolve(dir, settingsGuide));
    return relative(realpathSync(repo), target) === join('scripts', 'kits', 'README.md') && statSync(target).isFile();
  } catch { return false; }
}

function listFiles(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const name = prefix + entry.name;
    if (entry.isSymbolicLink()) throw Error(`symlink refused: ${name}`);
    return entry.isDirectory() ? listFiles(join(dir, entry.name), name + '/') : [name];
  });
}

export function checkKit(dir = root, repo = repository) {
  const errors = [];
  try {
    const row = JSON.parse(readFileSync(join(repo, 'packages/box-spec/examples/v2/junkyard.json'), 'utf8'));
    if (row.template?.id !== 'shop' || row.template?.name !== 'Shop') errors.push('registry: expected the Shop template');
  } catch (error) { errors.push(`registry: ${error.message}`); }
  const required = [...texts, 'check.mjs', 'check.test.mjs', 'assets.json', earlierOriginal, ...Object.keys(sizes).flatMap((name) => [name, original(name)])];
  const actual = listFiles(dir).filter((name) => !name.startsWith('build/'));
  for (const name of required) if (!actual.includes(name)) errors.push(`missing ${name}`);
  for (const name of actual) if (!required.includes(name) && !neighbours.includes(name)) errors.push(`unexpected ${name}`);
  for (const name of texts.filter((name) => actual.includes(name))) {
    const body = readFileSync(join(dir, name), 'utf8');
    if (!body.trim()) errors.push(`empty ${name}`);
    errors.push(...scanText(body).map((error) => `${name}: ${error}`));
    for (const [, link] of body.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^https:\/\//.test(link)) continue;
      const file = link.split('#')[0];
      if (file && !actual.includes(file) && !(file === settingsGuide && guideInside(dir, repo))) errors.push(`${name}: broken link ${link}`);
    }
  }
  if (actual.includes('details.md')) {
    const details = readFileSync(join(dir, 'details.md'), 'utf8');
    errors.push(...missingApproved(details).map((line) => `details.md: missing the approved line "${line}"`));
  }
  if (actual.includes('assets.json')) {
    try {
      const assets = JSON.parse(readFileSync(join(dir, 'assets.json'), 'utf8'));
      if (Object.keys(assets).sort().join() !== Object.keys(sizes).sort().join()) errors.push('asset manifest file set differs');
      for (const [name, expected] of Object.entries(sizes)) {
        const entry = assets[name];
        if (JSON.stringify(entry?.size) !== JSON.stringify(expected)) errors.push(`manifest size differs ${name}`);
        const variants = [[name, expected, entry?.sha256], [original(name), entry?.originalSize, entry?.originalSha256]];
        if (name === 'art/scenes/scene-04.png') variants.push([earlierOriginal, entry?.earlierOriginalSize, entry?.earlierOriginalSha256]);
        for (const [path, dimensions, hash] of variants) {
          if (!actual.includes(path)) continue;
          const data = readFileSync(join(dir, path));
          try {
            if (JSON.stringify(pngSize(data)) !== JSON.stringify(dimensions)) errors.push(`wrong size ${path}`);
          } catch (error) { errors.push(`${path}: ${error.message}`); }
          if (sha(data) !== hash) errors.push(`hash differs ${path}`);
        }
      }
    } catch (error) { errors.push(`manifest: ${error.message}`); }
  }
  if (actual.includes('storybook.md')) {
    const story = readFileSync(join(dir, 'storybook.md'), 'utf8');
    const scenes = story.split(/^## /m).slice(1);
    if (scenes.length !== 8) errors.push('storybook needs eight scenes');
    scenes.forEach((scene, i) => {
      const caption = scene.split('\n').slice(1).filter((line) => line.trim() && !line.startsWith('![')).join(' ');
      if (!caption || caption.split(/[.!?]+(?=\s|$)/).filter((s) => s.trim()).length > 2 || caption.split(/\s+/).length > 45) errors.push(`scene ${i + 1}: caption too long or missing`);
      if (!scene.includes(`art/scenes/scene-${String(i + 1).padStart(2, '0')}.png`)) errors.push(`scene ${i + 1}: missing picture`);
    });
  }
  if (actual.includes('prompts.md')) {
    const prompts = readFileSync(join(dir, 'prompts.md'), 'utf8');
    const records = [...prompts.matchAll(/^## \d{2}\. (art\/\S+\.png)$/gm)].map((match) => match[1]);
    if (records.join() !== [...Object.keys(sizes), 'art/scenes/scene-04.png'].join()) errors.push('prompt order or asset coverage differs');
    for (const [, ref] of prompts.matchAll(/`(art\/[^`]+-original\.png)`/g)) {
      if (!actual.includes(ref)) errors.push(`missing prompt reference ${ref}`);
    }
  }
  return errors;
}

// Node gives import.meta.url as the real path, so compare it with the real path of the started file (symlinks).
function startedDirectly() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (startedDirectly()) {
  const errors = checkKit();
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else process.stdout.write('PASS: 13 finished PNGs, 14 intact originals, five texts, approved lines, links, captions and manifest.\n');
}
