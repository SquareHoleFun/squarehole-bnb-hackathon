/**
 * Which certificate each of the 1,929 items shows. Node only, no network.
 *
 * The certificates stay sealed until drawn, so nobody may know which number holds which company before its reveal.
 * The rule is fixed and repeatable, and it takes a seed:
 *
 *   1. Give every id from 1 to 1929 a rank: the SHA-256 of the text `<seed>:<id>`, as 64 hex digits.
 *   2. Sort the ids by rank, smallest first.
 *   3. Deal the certificates in variant order down the sorted list: 213 ids each for the companies 01 to 09, then 4
 *      ids each for the blue chips 10, 11 and 12.
 *
 * Any seed gives nine companies of 213 certificates (1,917) and three blue chips of 4 (12), 1,929 in all. The seed
 * only decides the order. The kit's assignment.json uses the public example seed below to show the shape. A real
 * collection needs its own secret seed of at least 32 characters, kept with the reveal file and shown to nobody until
 * every certificate is revealed, because anyone who knows the seed knows every sealed certificate.
 *
 *   node assign.mjs > assignment.json                              the example, with the public seed
 *   PAPER_CERTIFICATES_SEED=<secret> node assign.mjs --folder <dir>
 *       writes <dir>/1.png ... <dir>/1929.png, each certificate with its own number printed in its number box, plus
 *       <dir>/traits.csv and the private <dir>/assignment.json. Refused without a secret seed and refused inside
 *       this kit. The list never goes to the terminal.
 *   ... --folder <dir> --sample <n>
 *       the same, but renders only the certificates 1 to n, to look at them before the long render.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EDITION = 'paper-certificates';
export const FIRST_ID = 1n;
export const COUNT = 1929n;
/** The public seed of the kit's example. Never use it for a real collection. */
export const EXAMPLE_SEED = 'paper-certificates-example';
export const MIN_SECRET = 32;
export const RULE = 'rank each id by SHA-256("<seed>:<id>"); deal 213 each of 01 to 09, then 4 each of 10 to 12, down the ranked ids';

/** The companies, in variant order 01 to 12. The art (src/items.mjs) takes its names from here. */
export const VARIANT_NAMES = Object.freeze([
  'Bagholder & Sons', 'Exit Liquidity Partners LLP', 'Long Wick Candle Works', 'Rumor Mill Flour Co.',
  'Sell the News Printing Co.', 'Sideways Crab Shipping Co.', 'Slippage Banana Co.', 'Dip Buyers Fondue Co.',
  'Margin Call Telephone Co.', 'Blue Chip Chip Shop', 'Blue Chip Wood Chip Co.', 'Blue Chip Paint Chip Co.',
]);
/** The blue chips: the box's special series. */
export const BLUE_CHIPS = Object.freeze(['10', '11', '12']);
/** How many items show each variant. */
export const COUNTS = Object.freeze(VARIANT_NAMES.map((_, i) => (i < 9 ? 213n : 4n)));
/** Traits for marketplaces: each certificate's ink and series. */
export const TRAITS = Object.freeze([
  ['Sepia', 'Company'], ['Teal', 'Company'], ['Vermilion', 'Company'], ['Olive', 'Company'], ['Slate', 'Company'],
  ['Crimson', 'Company'], ['Ochre', 'Company'], ['Plum', 'Company'], ['Green', 'Company'],
  ['Blue', 'Blue chip'], ['Blue', 'Blue chip'], ['Blue', 'Blue chip'],
]);

const two = (n) => n.toString().padStart(2, '0');

/** An item id as a canonical decimal string, such as "1929", checked and returned as a bigint. */
function parseId(id) {
  if (typeof id !== 'string' || !/^[1-9][0-9]*$/.test(id)) throw new TypeError('item id must be a canonical decimal string, such as "1929"');
  const n = BigInt(id);
  if (n < FIRST_ID || n > COUNT) throw new RangeError('item id must be between 1 and 1929');
  return n;
}

function checkSeed(seed) {
  if (typeof seed !== 'string' || seed.length === 0 || /[\r\n]/.test(seed)) throw new TypeError('the seed must be one line of text');
  return seed;
}

/** An id's rank under a seed: the SHA-256 of `<seed>:<id>` as 64 hex digits. */
export function rankOf(id, seed = EXAMPLE_SEED) {
  return createHash('sha256').update(`${checkSeed(seed)}:${parseId(id)}`).digest('hex');
}

/** Every id with its variant under a seed, in id order. */
function deal(seed) {
  const ids = [];
  for (let n = FIRST_ID; n <= COUNT; n += 1n) ids.push(n.toString());
  const ranked = ids.map((id) => ({ id, rank: rankOf(id, seed) }))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : Number(BigInt(a.id) - BigInt(b.id))));
  const deck = COUNTS.flatMap((count, i) => Array.from({ length: Number(count) }, () => two(i + 1)));
  if (deck.length !== ids.length) throw new Error(`the variant counts add up to ${deck.length}, and they must add up to ${COUNT}`);
  const byId = new Map(ranked.map(({ id }, i) => [id, deck[i]]));
  return ids.map((id) => ({ id, variant: byId.get(id) }));
}

/** The variant ('01' to '12') of one item id under a seed. */
export function variantFor(id, seed = EXAMPLE_SEED) {
  return deal(seed)[Number(parseId(id) - FIRST_ID)].variant;
}

/** The whole collection under a seed: every id with its picture, and how often each variant appears. */
export function assignment(seed = EXAMPLE_SEED) {
  const items = deal(seed).map(({ id, variant }) => ({ id, variant, image: `art/items/variant-${variant}.png` }));
  const counts = new Map(VARIANT_NAMES.map((_, i) => [two(i + 1), 0n]));
  for (const it of items) counts.set(it.variant, counts.get(it.variant) + 1n);
  return {
    edition: EDITION,
    firstId: FIRST_ID.toString(),
    count: COUNT.toString(),
    seed: seed === EXAMPLE_SEED ? EXAMPLE_SEED : 'private',
    example: seed === EXAMPLE_SEED,
    rule: RULE,
    numbers: 'each picture prints its own item id in the number box; the kit\'s variant pictures print the specimen number 0',
    specials: { label: 'Blue chip', count: BLUE_CHIPS.reduce((sum, n) => sum + counts.get(n), 0n).toString() },
    variants: VARIANT_NAMES.map((name, i) => {
      const variant = two(i + 1);
      const [ink, series] = TRAITS[i];
      return { variant, name, ink, series, count: counts.get(variant).toString(), image: `art/items/variant-${variant}.png`, svg: `art/items/variant-${variant}.svg` };
    }),
    items,
  };
}

/** A path with every link in its existing part resolved, so a linked route into the kit is still seen as the kit. */
function realPath(p) {
  let existing = resolve(p);
  const rest = [];
  while (!existsSync(existing)) {
    rest.unshift(basename(existing));
    existing = dirname(existing);
  }
  return join(realpathSync(existing), ...rest);
}

/** Where a real collection's private folder may go: anywhere but inside this kit, so it is never committed. */
export function folderTarget(dir) {
  const kit = realpathSync(fileURLToPath(new URL('./', import.meta.url)));
  const target = realPath(dir);
  if (`${target}${sep}`.startsWith(`${kit}${sep}`)) throw new Error('write the private folder outside this kit, so it is never committed');
  return target;
}

/** The create page's files for a real collection: each certificate with its own number, and a traits file. */
/**
 * The create page's files for a real collection: each certificate with its own number, and a traits file. `sample`
 * writes only the first ids, to look at the files before the long render; the private list always has every id.
 */
async function writeFolder(dir, seed, sample = Number(COUNT)) {
  const target = folderTarget(dir);
  const [{ loadResvg, toPng }, { VARIANTS, itemSvg }] = await Promise.all([import('./src/render.mjs'), import('./src/items.mjs')]);
  const Resvg = await loadResvg();
  mkdirSync(target, { recursive: true });
  const a = assignment(seed);
  const rows = ['id,Company,Ink,Series'];
  for (const it of a.items.slice(0, sample)) {
    const i = Number(it.variant) - 1;
    writeFileSync(resolve(target, `${it.id}.png`), toPng(Resvg, itemSvg(VARIANTS[i], it.id)));
    rows.push(`${it.id},${VARIANT_NAMES[i]},${TRAITS[i][0]},${TRAITS[i][1]}`);
  }
  writeFileSync(resolve(target, 'traits.csv'), `${rows.join('\n')}\n`);
  writeFileSync(resolve(target, 'assignment.json'), `${JSON.stringify(a, null, 2)}\n`);
  return rows.length - 1;
}

async function main(args) {
  const secret = process.env.PAPER_CERTIFICATES_SEED;
  if (secret !== undefined && secret.length < MIN_SECRET) throw new Error(`PAPER_CERTIFICATES_SEED must be at least ${MIN_SECRET} characters of random text`);
  const at = args.indexOf('--folder');
  if (at === -1) {
    process.stdout.write(`${JSON.stringify(assignment(secret ?? EXAMPLE_SEED), null, 2)}\n`);
    return;
  }
  // A real collection: the list goes into the private folder, never to the terminal.
  if (secret === undefined) throw new Error('set PAPER_CERTIFICATES_SEED to a secret seed first: the example seed is public');
  const dir = args[at + 1];
  if (!dir || dir.startsWith('--')) throw new Error('--folder needs a directory');
  const s = args.indexOf('--sample');
  const sample = s === -1 ? Number(COUNT) : Number(args[s + 1]);
  if (!Number.isInteger(sample) || sample < 1 || sample > Number(COUNT)) throw new Error('--sample needs a whole number of certificates from 1 to 1929');
  const n = await writeFolder(dir, secret, sample);
  process.stderr.write(`wrote ${n} certificates, traits.csv and assignment.json to ${resolve(dir)}; keep this folder and the seed private\n`);
}

// No top-level await: src/items.mjs imports this module, and an entry module still awaiting would never finish loading.
if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
