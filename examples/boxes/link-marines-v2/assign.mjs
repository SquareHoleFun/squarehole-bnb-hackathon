/**
 * The active 420-portrait edition, verified by the shared kit builder at the fixed seed.
 * Run from the repository root: node examples/boxes/link-marines-v2/assign.mjs > examples/boxes/link-marines-v2/assignment.json
 * Full generated files stay in the builder's fresh ignored scratch directory.
 */
import { relative } from 'node:path';
import { buildUniqueSet } from '../../../scripts/kits/unique.mjs';
import { EDITION, FIRST_ID, COUNT, RULE, VARIANT_NAMES } from './ranks.mjs';

export { EDITION, FIRST_ID, COUNT, RULE, VARIANT_NAMES, variantFor, squadFor } from './ranks.mjs';

export async function assignment() {
  const set = await buildUniqueSet(EDITION);
  return {
    edition: EDITION,
    firstId: FIRST_ID.toString(),
    count: set.count,
    squads: (COUNT / BigInt(VARIANT_NAMES.length)).toString(),
    rule: RULE,
    note: 'Rank is only the picture. Every marine gets the same ration.',
    seed: set.seed,
    columns: set.columns,
    modelPolicy: set.modelPolicy,
    // Serialize the shared result with filenames relative to its build directory, so the
    // report is stable across fresh builds. Traits, hashes, sizes and policy pass through.
    items: set.items.map(({ id, traits, picture, model }) => ({
      id, traits,
      picture: { file: relative(set.directory, picture.path), sha256: picture.sha256, bytes: picture.bytes },
      model,
    })),
  };
}

if (import.meta.main) process.stdout.write(`${JSON.stringify(await assignment(), null, 2)}\n`);
