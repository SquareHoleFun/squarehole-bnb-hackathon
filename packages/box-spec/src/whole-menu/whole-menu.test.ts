/** CQ11-D: all sixteen menu pairs, seeded drafts, explicit refusals and deterministic shared test data. */
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { validateBoxSpecV2 } from '../generated/box-spec.v2';
import { buildVectors, vectorsJson } from './generate';
const vectors = buildVectors();
it('covers all sixteen choices for every test listing and agrees with the frozen twin', () => {
  for (const l of vectors.listings) {
    expect(vectors.valid.filter((v) => v.name.startsWith(`menu-${l.id}-`))).toHaveLength(16);
  }
  for (const v of vectors.valid) expect(validateBoxSpecV2(v.spec, v.ctx), v.name).toEqual({ reason: 0, field: 0 });
  for (const v of vectors.invalid) expect(validateBoxSpecV2(v.spec, v.ctx), v.name).toEqual({ reason: v.reason, field: v.field });
});
it('refuses empty holder and item params before checking the leg/destination pair', () => {
  for (const name of ['buyers', 'sellers'] as const) for (const dest of [6, 8]) {
    const v = vectors.invalid.find((x) => x.name === `${name}-missing-dest-params-${dest}`);
    if (!v) throw new Error('missing parameter refusal');
    expect(validateBoxSpecV2(v.spec, v.ctx)).toEqual({ reason: 23, field: name === 'buyers' ? 17004 : 18004 });
  }
});
it('keeps raw amounts exact and writes deterministic vectors for phase-two consumers', () => {
  expect(vectorsJson(buildVectors())).toBe(vectorsJson(vectors));
  expect(vectors.valid.every((v) => typeof v.spec.raise === 'bigint')).toBe(true);
  const file = new URL('../../../contracts/test/vectors/whole-menu/whole-menu.v2.json', import.meta.url);
  if (process.env.SH_WRITE_VECTORS === '1') writeFileSync(file, vectorsJson(vectors));
  expect(readFileSync(file, 'utf8')).toBe(vectorsJson(vectors));
});
