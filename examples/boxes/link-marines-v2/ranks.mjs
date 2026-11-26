/** Fixed base ranks and squads. No dependency on the active edition or its generator. */
export const EDITION = 'link-marines-v2';
export const FIRST_ID = 1n;
export const COUNT = 420n;
export const RULE = 'variant = ((id - 1) mod 12) + 1, as two digits; squad = ((id - 1) div 12) + 1';

/** The ranks, in variant order 01 to 12: one squad, from Private to General. The art library and unique generator share these names. */
export const VARIANT_NAMES = Object.freeze([
  'Private', 'Specialist', 'Corporal', 'Sergeant', 'Staff Sergeant', 'Master Sergeant',
  'Sergeant Major', 'Lieutenant', 'Captain', 'Major', 'Colonel', 'General',
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

/** The original rank/squad computation, independent of pictures and unique traits. */
export function baseMarines() {
  const items = [];
  for (let n = FIRST_ID; n <= COUNT; n += 1n) {
    const id = n.toString();
    const variant = variantFor(id);
    items.push({ id, variant, rank: VARIANT_NAMES[Number(variant) - 1], squad: squadFor(id) });
  }
  return items;
}

/** Twelve base art inputs; their pictures do not identify active edition items. */
export function rankLibrary() {
  return VARIANT_NAMES.map((rank, i) => {
    const variant = two(BigInt(i + 1));
    return { variant, rank, count: (COUNT / VARIANTS).toString(), image: `art/items/variant-${variant}.png`, svg: `art/items/variant-${variant}.svg` };
  });
}
