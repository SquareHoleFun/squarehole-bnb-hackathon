import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { COUNT, FIRST_ID, variantFor } from '../assign.mjs';
import { jsonBytes, requireNode } from './lib/io.mjs';

export const vocabulary = JSON.parse(readFileSync(new URL('./traits.json', import.meta.url), 'utf8'));
export const SEED = 'exit-liquidity/404-signs/no-way-out/v1';
export const traitKey = traits => vocabulary.layers.map(l => traits[l.key]).join('|');
const keys = vocabulary.layers.map(l => l.key);
const distance = (a, b) => keys.reduce((n, key) => n + (a[key] !== b[key] ? 1 : 0), 0);

// Hash-ranked exact decks: ties resolved by original index, never locale or random/time.
function shuffled(values, domain) {
  return values.map((value, i) => ({ value, i, rank: createHash('sha256').update(`${SEED}\0${domain}\0${i}`).digest('hex') }))
    .sort((a, b) => a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.i - b.i).map(r => r.value);
}

export function validateTraits(traits) {
  assert.deepEqual(Object.keys(traits).sort(), [...keys].sort(), 'exact trait keys');
  for (const layer of vocabulary.layers) assert.ok(layer.values.some(v => v.value === traits[layer.key]), `unknown ${layer.key}`);
}

export function verifyDeal(rows) {
  assert.equal(BigInt(rows.length), COUNT, 'edition count');
  const unique = new Set();
  for (const [i, row] of rows.entries()) {
    assert.equal(row.id, (BigInt(i) + FIRST_ID).toString(), 'ordered id');
    validateTraits(row.traits);
    assert.equal(row.traits.sign, variantFor(row.id), 'original sign');
    const key = traitKey(row.traits);
    assert.ok(!unique.has(key), 'duplicate traits');
    unique.add(key);
    for (let j = 0; j < i; j++) assert.ok(distance(row.traits, rows[j].traits) >= 2, 'near twins');
  }
  for (const layer of vocabulary.layers) {
    assert.equal(layer.values.reduce((n, v) => n + BigInt(v.count), 0n), COUNT, 'deck total');
    for (const value of layer.values) assert.equal(BigInt(rows.filter(r => r.traits[layer.key] === value.value).length), BigInt(value.count), `${layer.key} count`);
  }
  return rows;
}

export function deal() {
  assert.equal(vocabulary.seed, SEED);
  assert.equal(vocabulary.count, COUNT.toString());
  const rows = [];
  for (let id = FIRST_ID; id <= COUNT; id++) rows.push({ id: id.toString(), traits: { sign: variantFor(id.toString()) } });
  for (const layer of vocabulary.layers.slice(1)) {
    const deck = [];
    for (const value of layer.values) for (let n = 0n; n < BigInt(value.count); n++) deck.push(value.value);
    shuffled(deck, layer.key).forEach((value, i) => { rows[i].traits[layer.key] = value; });
  }
  // In-layer swaps preserve exact counts. Each accepted swap removes a near pair and creates none.
  const order = shuffled(rows.map((_, i) => i), 'repair');
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i].traits;
    const clashes = () => rows.reduce((n, r, k) => n + (k === i ? 0 : Math.max(0, 2 - distance(a, r.traits))), 0);
    while (clashes()) {
      const before = clashes();
      let fixed = false;
      outer: for (const layer of keys.slice(1)) for (const j of order) {
        const b = rows[j].traits;
        if (i === j || a[layer] === b[layer]) continue;
        [a[layer], b[layer]] = [b[layer], a[layer]];
        if (clashes() < before && rows.every((r, k) => k === j || distance(b, r.traits) >= 2)) {
          fixed = true; break outer;
        }
        [a[layer], b[layer]] = [b[layer], a[layer]];
      }
      assert.ok(fixed, 'exact-count repair has no improving swap');
    }
  }
  return verifyDeal(rows);
}

if (import.meta.main) {
  requireNode();
  process.stdout.write(jsonBytes(deal()));
}
