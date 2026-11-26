/**
 * Which picture each Frog Kiln toad shows. Node only, no dependencies, no network.
 *
 * The toads are hidden until drawn, so nobody may know which number holds which toad before its reveal. The rule is
 * fixed and repeatable, and it takes a seed:
 *
 *   1. Give every id from 1 to 420 a rank: the SHA-256 of the text `<seed>:<id>`, read as a 256-bit number.
 *   2. Sort the ids by rank, smallest first (equal ranks by id).
 *   3. Deal the toads in variant order down the sorted list: the first 44 ids get variant 01, the next 44 get 02,
 *      and so on to 09; then 8 ids each get the cracked toads 10, 11 and 12.
 *
 * That gives nine glazes of 44 toads each (396) and three cracked toads of 8 each (24), 420 in all, whatever the seed.
 * The seed only decides the order.
 *
 * The kit's assignment.json uses the public example seed below, to show the shape and the counts. The real
 * collection needs its own secret seed of at least 32 characters, kept with the reveal file and never committed or
 * posted until every toad is revealed. Anyone who knows it, or can guess it, knows every hidden toad.
 *
 *   node assign.mjs > assignment.json                  the example, with the public seed
 *   FROG_KILN_SEED=<secret> node assign.mjs > x.json    a real assignment: keep it private
 *   FROG_KILN_SEED=<secret> node assign.mjs --folder <dir>
 *                                                      also writes <dir>/1.png ... <dir>/420.png and <dir>/traits.csv,
 *                                                      the files the create page reads; refused inside this kit
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EDITION = 'frog-kiln';
export const FIRST_ID = 1n;
export const COUNT = 420n;
/** The public seed of the kit's example assignment. Never use it for a real collection. */
export const EXAMPLE_SEED = 'frog-kiln-example';
export const MIN_SECRET = 32;
export const RULE = 'rank each id by SHA-256("<seed>:<id>"); deal 44 each of 01 to 09, then 8 each of 10 to 12, down the ranked ids';

/** Variant names, in variant order 01 to 12. The art (src/items.mjs) takes its names from here. */
export const VARIANT_NAMES = Object.freeze([
  'Bisque', 'Celadon', 'Tenmoku', 'Shino', 'Oxblood', 'Ash',
  'Cobalt', 'Honey', 'Speckle', 'Gold seam', 'Riveted', 'Ember',
]);
/** The cracked toads: the box's special series. */
export const CRACKED = Object.freeze(['10', '11', '12']);
/** How many toads show each variant. */
export const COUNTS = Object.freeze(VARIANT_NAMES.map((_, i) => (i < 9 ? 44n : 8n)));
/** Traits for marketplaces: the glaze of every variant, and the crack of the cracked ones. */
export const TRAITS = Object.freeze([
  ['Bisque', ''], ['Celadon', ''], ['Tenmoku', ''], ['Shino', ''], ['Oxblood', ''], ['Ash', ''],
  ['Cobalt', ''], ['Honey', ''], ['Speckle', ''], ['Celadon', 'Gold seam'], ['White', 'Riveted'], ['Raku', 'Ember'],
]);

const two = (n) => n.toString().padStart(2, '0');

/** Checks an item id given as a canonical decimal string, such as "420", and returns it as a bigint. */
function parseId(id) {
  if (typeof id !== 'string' || !/^[1-9][0-9]*$/.test(id)) {
    throw new TypeError('item id must be a canonical decimal string, such as "420"');
  }
  const n = BigInt(id);
  if (n < FIRST_ID || n > COUNT) throw new RangeError('item id must be between 1 and 420');
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
  const byId = new Map(ranked.map(({ id }, i) => [id, deck[i]]));
  return ids.map((id) => ({ id, variant: byId.get(id) }));
}

/** The variant ('01' to '12') for one item id under a seed. */
export function variantFor(id, seed = EXAMPLE_SEED) {
  return deal(seed)[Number(parseId(id) - FIRST_ID)].variant;
}

/** The whole edition under a seed: every id with its picture, and how often each variant appears. */
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
    specials: { label: 'Cracked', count: CRACKED.reduce((sum, n) => sum + counts.get(n), 0n).toString() },
    variants: VARIANT_NAMES.map((name, i) => {
      const variant = two(i + 1);
      const [glaze, crack] = TRAITS[i];
      return { variant, name, glaze, crack: crack || null, count: counts.get(variant).toString(), image: `art/items/variant-${variant}.png`, svg: `art/items/variant-${variant}.svg` };
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

/** Where a real collection's private folder goes: anywhere but inside this kit, so it is never committed. */
export function folderTarget(dir) {
  const kit = realpathSync(fileURLToPath(new URL('./', import.meta.url)));
  const target = realPath(dir);
  if (`${target}${sep}`.startsWith(`${kit}${sep}`)) throw new Error('write the private folder outside this kit, so it is never committed');
  return target;
}

/** The create page's files for a real collection: one picture per id, named by id, and a traits file. */
function writeFolder(dir, seed) {
  const target = folderTarget(dir);
  mkdirSync(target, { recursive: true });
  const a = assignment(seed);
  const rows = ['id,Glaze,Crack'];
  for (const it of a.items) {
    copyFileSync(new URL(it.image, import.meta.url), resolve(target, `${it.id}.png`));
    const [glaze, crack] = TRAITS[Number(it.variant) - 1];
    rows.push(`${it.id},${glaze},${crack}`);
  }
  writeFileSync(resolve(target, 'traits.csv'), `${rows.join('\n')}\n`);
  writeFileSync(resolve(target, 'assignment.json'), `${JSON.stringify(a, null, 2)}\n`);
  return a.items.length;
}

function main(args) {
  const secret = process.env.FROG_KILN_SEED;
  if (secret !== undefined && secret.length < MIN_SECRET) throw new Error(`FROG_KILN_SEED must be at least ${MIN_SECRET} characters of random text`);
  const seed = secret ?? EXAMPLE_SEED;
  const at = args.indexOf('--folder');
  if (at === -1) {
    process.stdout.write(`${JSON.stringify(assignment(seed), null, 2)}\n`);
    return;
  }
  // A real collection: the list goes into the private folder, never to the terminal.
  if (secret === undefined) throw new Error('set FROG_KILN_SEED to a secret seed first: the example seed is public');
  const dir = args[at + 1];
  if (!dir) throw new Error('--folder needs a directory');
  if (!existsSync(new URL('art/items/variant-01.png', import.meta.url))) throw new Error('build the art first: node build-art.mjs');
  const n = writeFolder(dir, seed);
  process.stderr.write(`wrote ${n} pictures, traits.csv and assignment.json to ${resolve(dir)}; keep this folder and the seed private\n`);
}

if (import.meta.main) main(process.argv.slice(2));
