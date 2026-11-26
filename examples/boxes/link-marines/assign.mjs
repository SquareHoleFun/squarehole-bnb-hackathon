/**
 * Which picture each Link Marine shows. No dependencies, no network, no randomness.
 *
 * The 420 marines form 35 squads of 12, and every squad has one marine of each of the 12 kinds, in the same order.
 * Rule: variant = ((id - 1) mod 12) + 1, written with two digits; squad = ((id - 1) div 12) + 1.
 * Item ids are the decimal strings 1 to 420 (Square Hole collections start at id 1). 420 is 12 x 35, so every
 * picture appears exactly 35 times. A picture changes nothing about fees, the box or anything an owner gets.
 *
 *   node assign.mjs > assignment.json     prints the full list; writes nothing itself
 */
export const EDITION = 'link-marines';
export const FIRST_ID = 1n;
export const COUNT = 420n;
export const RULE = 'variant = ((id - 1) mod 12) + 1, as two digits; squad = ((id - 1) div 12) + 1';

/** Variant names, in variant order 01 to 12: one squad. The art (src/items.mjs) takes its names from here. */
export const VARIANT_NAMES = Object.freeze([
  'Private', 'Sergeant', 'Cook', 'Bugler', 'Pilot', 'Diver',
  'Jungle', 'Arctic', 'Officer', 'Mechanic', 'Scout', 'Night watch',
]);

const VARIANTS = BigInt(VARIANT_NAMES.length);
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

/** The variant ('01' to '12') for one item id. */
export function variantFor(id) {
  return two(((parseId(id) - FIRST_ID) % VARIANTS) + 1n);
}

/** The squad ('1' to '35') one item id belongs to. */
export function squadFor(id) {
  return (((parseId(id) - FIRST_ID) / VARIANTS) + 1n).toString();
}

/** The whole edition: every id with its squad, variant and picture, plus how often each variant appears. */
export function assignment() {
  const items = [];
  const counts = new Map(VARIANT_NAMES.map((_, i) => [two(BigInt(i + 1)), 0n]));
  for (let n = FIRST_ID; n <= COUNT; n += 1n) {
    const id = n.toString();
    const variant = variantFor(id);
    counts.set(variant, counts.get(variant) + 1n);
    items.push({ id, squad: squadFor(id), variant, image: `art/items/variant-${variant}.png` });
  }
  return {
    edition: EDITION,
    firstId: FIRST_ID.toString(),
    count: COUNT.toString(),
    squads: (COUNT / VARIANTS).toString(),
    rule: RULE,
    variants: VARIANT_NAMES.map((name, i) => {
      const variant = two(BigInt(i + 1));
      return { variant, name, count: counts.get(variant).toString(), image: `art/items/variant-${variant}.png`, svg: `art/items/variant-${variant}.svg` };
    }),
    items,
  };
}

if (import.meta.main) process.stdout.write(`${JSON.stringify(assignment(), null, 2)}\n`);
