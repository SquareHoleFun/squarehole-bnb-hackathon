import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { baseMarines } from '../ranks.mjs';

export const schema = JSON.parse(readFileSync(new URL('./traits.json', import.meta.url), 'utf8'));
const CORE = ['Face', 'Eyes', 'Grooming', 'Collar'];
export const LOOK = [...CORE, 'Mouth', 'Prop'];
export const lookKey = row => LOOK.map(key => row.traits[key]).join('|');
// Labelled SHA-256 sort keys: no runtime PRNG, locale sort, clock, retry or mutable state.
function shuffle(values, seed, label) {
  return values.map((value, i) => ({ value, i, key: createHmac('sha256', seed).update(`${label}\0${i}`).digest('hex') }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : a.i - b.i).map(r => r.value);
}
export function deal(seed = schema.seed) {
  assert.equal(typeof seed, 'string');
  let core = [{}];
  for (const key of CORE) core = core.flatMap(row => Object.keys(schema.traits[key]).map(value => ({ ...row, [key]: value })));
  core = shuffle(core, seed, 'characters');
  const decks = Object.fromEntries(['Mouth', 'Prop', 'Wall'].map(key => {
    const cards = [];
    for (const [value, count] of Object.entries(schema.traits[key])) for (let n = 0n; n < BigInt(count); n++) cards.push(value);
    return [key, shuffle(cards, seed, key)];
  }));
  const rows = baseMarines().map(({ id, rank, squad }, i) => ({ id, traits: {
    Rank: rank, Squad: squad, ...core[i], Mouth: decks.Mouth[i], Prop: decks.Prop[i], Wall: decks.Wall[i],
  } }));
  validateDeal(rows);
  return rows;
}
export function validateDeal(rows) {
  const base = baseMarines();
  assert.equal(BigInt(rows.length), BigInt(schema.count), 'edition count');
  assert.equal(new Set(rows.map(lookKey)).size, rows.length, 'unique character keys without rank, squad or wall');
  for (const [i, row] of rows.entries()) {
    assert.equal(row.id, base[i].id, 'ordered canonical ids');
    assert.deepEqual(Object.keys(row.traits), Object.keys(schema.traits), 'exact trait columns');
    assert.equal(row.traits.Rank, base[i].rank, 'rank unchanged');
    assert.equal(row.traits.Squad, base[i].squad, 'squad unchanged');
  }
  for (const [key, values] of Object.entries(schema.traits)) {
    const counts = new Map();
    for (const row of rows) {
      assert.ok(Object.hasOwn(values, row.traits[key]), `known ${key}`);
      counts.set(row.traits[key], (counts.get(row.traits[key]) ?? 0n) + 1n);
    }
    assert.equal(Object.values(values).reduce((a, n) => a + BigInt(n), 0n), 420n, `${key} totals`);
    for (const [value, count] of Object.entries(values)) assert.equal(counts.get(value), BigInt(count), `${key} ${value}`);
  }
}
if (import.meta.main) process.stdout.write(`${JSON.stringify(deal(), null, 2)}\n`);
