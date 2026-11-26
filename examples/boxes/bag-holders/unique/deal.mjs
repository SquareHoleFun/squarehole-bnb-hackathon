import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { COUNT, FIRST_ID, variantFor } from '../assign.mjs';

export const SPEC = JSON.parse(readFileSync(new URL('./traits.json', import.meta.url), 'utf8'));
export const SEED = SPEC.seed;
export const FIELDS = Object.keys(SPEC.traits);
export const values = field => SPEC.traits[field].map(v => v.value);
export function validateTraits(traits) {
  assert.deepEqual(Object.keys(traits).sort(), [...FIELDS].sort(), 'exact trait fields');
  for (const field of FIELDS) assert.ok(values(field).includes(traits[field]), `unknown ${field}`);
}
export const traitKey = traits => FIELDS.map(field => traits[field]).join('|');

/** Each kind gets the entire 5 x 7 product, permuted by a domain-separated SHA-256 rank.
 * No rejection, floating randomness, time, id decoration or hidden model seed.
 * Tags/stitches rotate through six pairs; the twelve kinds balance every rotation.
 */
export function deal(seed = SEED) {
  assert.ok(typeof seed === 'string' && seed.length > 0, 'seed string');
  const decks = values('kind').map((kind, k) => {
    const deck = values('trim').flatMap((trim, c) => values('repair').map((repair, r) => ({
      kind, trim, repair, tag: values('tag')[(k + r + c) % 3], stitch: values('stitch')[(k + r + c) % 2],
    })));
    const rank = t => createHmac('sha256', seed).update(`bag-holders/deal/v1/${traitKey(t)}`).digest('hex');
    return deck.map(traits => ({ traits, rank: rank(traits) })).sort((a, b) =>
      a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : traitKey(a.traits) < traitKey(b.traits) ? -1 : 1);
  });
  const offsets = new Map(values('kind').map(kind => [kind, 0]));
  const rows = [];
  for (let n = FIRST_ID; n <= COUNT; n++) {
    const id = n.toString(), kind = variantFor(id), at = offsets.get(kind);
    const deck = decks[values('kind').indexOf(kind)];
    rows.push({ id, traits: { ...deck[at].traits } });
    offsets.set(kind, at + 1);
  }
  validateDeal(rows);
  return rows;
}

/** Independently recount and check the final edition, including the original id/kind contract. */
export function validateDeal(rows) {
  assert.equal(BigInt(rows.length), COUNT);
  const keys = new Set();
  let expectedId = FIRST_ID;
  for (const { id, traits } of rows) {
    assert.equal(id, (expectedId++).toString(), 'ordered complete ids');
    validateTraits(traits);
    assert.equal(traits.kind, variantFor(id), 'original bag kind');
    assert.ok(!keys.has(traitKey(traits)), 'duplicate traits');
    keys.add(traitKey(traits));
  }
  for (const field of FIELDS) {
    assert.equal(SPEC.traits[field].reduce((sum, v) => sum + BigInt(v.count), 0n), COUNT);
    for (const { value, count } of SPEC.traits[field]) {
      assert.equal(BigInt(rows.filter(r => r.traits[field] === value).length), BigInt(count), `${field}/${value} count`);
    }
  }
  return rows;
}

if (import.meta.main) process.stdout.write(`${JSON.stringify(deal(), null, 2)}\n`);
