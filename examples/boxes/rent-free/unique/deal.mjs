import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { variantFor } from '../assign.mjs';
import { isMain, jsonBytes, requireNode } from './lib/io.mjs';

export const SPEC = JSON.parse(readFileSync(new URL('./traits.json', import.meta.url), 'utf8'));
export const SEED = SPEC.seed;
export const KEYS = Object.keys(SPEC.traits);
const VALUES = Object.fromEntries(KEYS.map(key => [key, new Set(SPEC.traits[key].map(v => v.value))]));
export const identity = traits => KEYS.map(key => traits[key]).join('|');
export function validateTraits(traits) {
  assert.deepEqual(Object.keys(traits).sort(), [...KEYS].sort(), 'exact trait keys');
  for (const key of KEYS) assert.ok(VALUES[key].has(traits[key]), `unknown ${key}: ${traits[key]}`);
}

// Labelled streams and unbiased Fisher-Yates; no time, process state or platform-dependent sorting.
function random(seed, label) {
  let counter = 0n;
  return size => {
    const ceiling = 0x100000000 - 0x100000000 % size;
    for (;;) {
      const n = createHmac('sha256', seed).update(`${label}\0${counter++}`).digest().readUInt32BE(0);
      if (n < ceiling) return n % size;
    }
  };
}
function deck(key, seed) {
  const values = [];
  for (const v of SPEC.traits[key]) for (let n = 0n; n < BigInt(v.count); n++) values.push(v.value);
  const int = random(seed, `deck/${key}`);
  for (let i = values.length - 1; i > 0; i--) { const j = int(i + 1); [values[i], values[j]] = [values[j], values[i]]; }
  return values;
}
const masks = traits => KEYS.map(omit => KEYS.map(key => key === omit ? '*' : traits[key]).join('|'));

export function deal(seed = SEED) {
  assert.ok(typeof seed === 'string' && seed.length > 0, 'nonempty seed string');
  const layers = Object.fromEntries(KEYS.slice(1).map(key => [key, deck(key, seed)]));
  const rows = [];
  for (let id = 1n; id <= BigInt(SPEC.count); id++) {
    const traits = { house: variantFor(id.toString()) };
    for (const key of KEYS.slice(1)) traits[key] = layers[key][rows.length];
    rows.push({ id: id.toString(), traits });
  }
  // A shared masked key means distance 0 or 1. Swap only cosmetic columns, never the house/id mapping.
  const counts = new Map();
  const bump = (row, delta) => { for (const key of masks(row.traits)) counts.set(key, (counts.get(key) ?? 0) + delta); };
  const score = row => masks(row.traits).reduce((sum, key) => sum + Math.max(0, (counts.get(key) ?? 0) - 1), 0);
  rows.forEach(row => bump(row, 1));
  const int = random(seed, 'repair');
  for (const row of rows) {
    for (let tries = 0; score(row) > 0; tries++) {
      assert.ok(tries < 100_000, 'bounded repair failed');
      const partner = rows[int(rows.length)], key = KEYS[1 + int(KEYS.length - 1)];
      if (partner === row || row.traits[key] === partner.traits[key]) continue;
      const before = score(row) + score(partner);
      const swap = () => {
        bump(row, -1); bump(partner, -1);
        [row.traits[key], partner.traits[key]] = [partner.traits[key], row.traits[key]];
        bump(row, 1); bump(partner, 1);
      };
      swap();
      if (score(partner) !== 0 || score(row) >= before) swap();
    }
  }
  validateDeal(rows);
  return rows;
}

// Independent pairwise check rather than trusting the dealer's masked-key bookkeeping.
export function validateDeal(rows) {
  assert.equal(BigInt(rows.length), BigInt(SPEC.count), 'edition length');
  const histogram = Object.fromEntries(KEYS.map(key => [key, new Map()]));
  const identities = new Set();
  for (const [i, row] of rows.entries()) {
    assert.equal(row.id, BigInt(i + 1).toString(), 'ordered canonical id');
    validateTraits(row.traits);
    assert.equal(row.traits.house, variantFor(row.id), 'original house type');
    identities.add(identity(row.traits));
    for (const key of KEYS) histogram[key].set(row.traits[key], (histogram[key].get(row.traits[key]) ?? 0n) + 1n);
  }
  assert.equal(identities.size, rows.length, 'duplicate trait set');
  for (const key of KEYS) {
    assert.equal(SPEC.traits[key].reduce((sum, v) => sum + BigInt(v.count), 0n), BigInt(SPEC.count), `${key} total`);
    for (const v of SPEC.traits[key]) assert.equal(histogram[key].get(v.value), BigInt(v.count), `${key} ${v.value} count`);
  }
  let minimumDistance = KEYS.length;
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    minimumDistance = Math.min(minimumDistance, KEYS.filter(key => rows[i].traits[key] !== rows[j].traits[key]).length);
  }
  assert.ok(minimumDistance >= 2, 'two visible traits must differ');
  return { count: SPEC.count, unique: BigInt(identities.size).toString(), minimumDistance };
}

if (isMain(import.meta.url)) {
  requireNode();
  assert.equal(process.argv.length, 2, 'Usage: node deal.mjs');
  process.stdout.write(jsonBytes(deal()));
}
