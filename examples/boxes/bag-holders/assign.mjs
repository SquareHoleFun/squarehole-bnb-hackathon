/**
 * The active Bag Holders edition, built and verified by the shared unique producer interface.
 *
 * The twelve base families remain generator inputs. Each ID has its own picture, full traits and model.
 * Serialized asset paths are relative to the generated set's directory; no scratch path enters the assignment.
 *
 *   node assign.mjs > assignment.json     builds in ignored scratch and prints the full list
 */
import { relative } from 'node:path';
import { buildUniqueSet } from '../../../scripts/kits/unique.mjs';

export const EDITION = 'bag-holders';
export const FIRST_ID = 1n;
export const COUNT = 420n;
export const RULE = 'variant = ((id - 1) mod 12) + 1, as two digits';

/** Variant names, in variant order 01 to 12. The art (src/items.mjs) takes its names from here. */
export const VARIANT_NAMES = Object.freeze([
  'Tote', 'Paper bag', 'Tea bag', 'Sandbag', 'Bean bag', 'Punching bag',
  'Sleeping bag', 'Gift bag', 'Duffel bag', 'Backpack', 'Bag of chips', 'Bag of lemons',
]);

const VARIANTS = BigInt(VARIANT_NAMES.length);
const two = (n) => n.toString().padStart(2, '0');

/** The base family ('01' to '12'), not the finished picture, for a canonical decimal item id. */
export function variantFor(id) {
  if (typeof id !== 'string' || !/^[1-9][0-9]*$/.test(id)) {
    throw new TypeError('item id must be a canonical decimal string, such as "420"');
  }
  const n = BigInt(id);
  if (n < FIRST_ID || n > COUNT) throw new RangeError('item id must be between 1 and 420');
  return two(((n - FIRST_ID) % VARIANTS) + 1n);
}

/** Preserve the shared result's policy, traits and hashes; only make its file paths portable for JSON. */
export async function assignment() {
  const { directory, items, ...set } = await buildUniqueSet(EDITION);
  const portable = asset => ({ ...asset, path: relative(directory, asset.path) });
  return {
    edition: EDITION,
    firstId: FIRST_ID.toString(),
    ...set,
    items: items.map(item => ({ ...item, picture: portable(item.picture), model: portable(item.model) })),
  };
}

// Finish evaluating this module before the producer imports its base helpers from here.
// Top-level await would deadlock assign -> buildUniqueSet -> unique/deal -> assign.
if (import.meta.main) assignment().then(result => {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
