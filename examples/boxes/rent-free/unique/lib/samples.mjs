import assert from 'node:assert/strict';
import { SPEC, KEYS } from '../deal.mjs';

export function selectSamples(rows) {
  const selected = [], seen = new Set(), perHouse = new Map();
  const tags = row => KEYS.map(key => `${key}/${row.traits[key]}`);
  for (let round = 0; round < 4; round++) {
    for (const house of SPEC.traits.house) {
      const local = perHouse.get(house.value) ?? new Set();
      let best, bestScore = -1;
      for (const row of rows.filter(row => row.traits.house === house.value && !selected.includes(row.id))) {
        const score = tags(row).reduce((sum, tag) => sum + (seen.has(tag) ? 0 : 100) + (local.has(tag) ? 0 : 1), 0);
        if (score > bestScore) { best = row; bestScore = score; }
      }
      selected.push(best.id);
      for (const tag of tags(best)) { seen.add(tag); local.add(tag); }
      perHouse.set(house.value, local);
    }
  }
  for (const key of KEYS) for (const v of SPEC.traits[key]) assert.ok(seen.has(`${key}/${v.value}`), `sample misses ${key} ${v.value}`);
  const ordered = ids => ids.toSorted((a, b) => {
    const ha = rows.find(row => row.id === a).traits.house, hb = rows.find(row => row.id === b).traits.house;
    return ha < hb ? -1 : ha > hb ? 1 : BigInt(a) < BigInt(b) ? -1 : 1;
  });
  return { pictures: ordered(selected), models: ordered(selected.slice(0, 24)) };
}
