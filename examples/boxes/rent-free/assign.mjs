import { relative } from 'node:path';
import { buildUniqueSet } from '../../../scripts/kits/unique.mjs';

/** Base family only. The unique dealer preserves this mapping; fees do not depend on art. */
export function variantFor(tokenId) {
  if (typeof tokenId !== 'string' || !/^[1-9][0-9]*$/.test(tokenId)) {
    throw new TypeError('token id must be a canonical decimal string');
  }
  const id = BigInt(tokenId);
  if (id > 500n) throw new RangeError('token id must be in 1–500');
  return (((id - 1n) % 12n) + 1n).toString().padStart(2, '0');
}

/** Serialize T02's verified set with paths relative to its full output, never a scratch directory. */
export async function assignment() {
  const { directory, ...set } = await buildUniqueSet('rent-free');
  const asset = value => ({ ...value, path: relative(directory, value.path) });
  return {
    ...set,
    items: set.items.map(item => ({ ...item, picture: asset(item.picture), model: asset(item.model) })),
  };
}

// Do not top-level await: the dynamically imported producer imports variantFor from this module.
if (import.meta.main) assignment().then(value => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
