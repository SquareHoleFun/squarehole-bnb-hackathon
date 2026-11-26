/**
 * The active Exit Liquidity edition, verified through T02's shared producer boundary.
 *
 * The twelve original signs remain base families. Every id has its own picture and six traits.
 * Models are review inputs only: buildUniqueSet explicitly applies the kit's 2D policy.
 *
 *   node assign.mjs > assignment.json     builds in fresh ignored scratch and prints portable JSON
 */
import { relative } from 'node:path';
import { buildUniqueSet } from '../../../scripts/kits/unique.mjs';

export const EDITION = 'exit-liquidity';
export const FIRST_ID = 1n;
export const COUNT = 404n;
export const RULE = 'variant = ((id - 1) mod 12) + 1, as two digits';

/** Variant names, in variant order 01 to 12. The art (src/items.mjs) takes its names from here. */
export const VARIANT_NAMES = Object.freeze([
  'Exit?', 'Not found', 'No exit', 'Both ways', 'Burnt out', 'Backwards',
  'Down', '404', 'Up', 'Loop', 'Error', 'Try again',
]);

const VARIANTS = BigInt(VARIANT_NAMES.length);
const two = (n) => n.toString().padStart(2, '0');

/** The base family ('01' to '12'), not the assigned picture, for a canonical decimal item id. */
export function variantFor(id) {
  if (typeof id !== 'string' || !/^[1-9][0-9]*$/.test(id)) {
    throw new TypeError('item id must be a canonical decimal string, such as "404"');
  }
  const n = BigInt(id);
  if (n < FIRST_ID || n > COUNT) throw new RangeError('item id must be between 1 and 404');
  return two(((n - FIRST_ID) % VARIANTS) + 1n);
}

/** Return the common interface unchanged, including its generated directory and exact input paths. */
export function assignment() {
  return buildUniqueSet(EDITION);
}

/** Persist the same records with picture paths relative to the generated directory; no scratch location. */
export function assignmentJson(set) {
  const { directory, ...edition } = set;
  return `${JSON.stringify({ ...edition, items: edition.items.map(item => ({
    ...item, picture: { ...item.picture, path: relative(directory, item.picture.path) },
  })) }, null, 2)}\n`;
}

// Finish module evaluation before importing the producer, whose dealer uses variantFor above.
// Top-level await here would deadlock the CLI's dynamic import of that producer.
if (import.meta.main) assignment().then(set => process.stdout.write(assignmentJson(set))).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
