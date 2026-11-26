import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { decodeBoxSpecV2, decodeReleaseContextV2, validateBoxSpecV2 } from './generated/box-spec.v2';
import type { Hex } from 'viem';
const vectors = JSON.parse(readFileSync(new URL('../../contracts/test/vectors/box-spec/box-spec-v2.json', import.meta.url), 'utf8'));
it.each(['buyers', 'sellers'] as const)('EAT11 admits AsPaid/Eat on %s with canonical empty params', side => {
  const i = vectors.columns.reason.indexOf(0);
  const spec = decodeBoxSpecV2(vectors.columns.encoded[i] as Hex);
  const ctx = decodeReleaseContextV2(vectors.contexts[vectors.columns.context[i]].encoded as Hex);
  const changed = { ...spec, [side]: { ...spec[side], a: { leg: 1, dest: 1, legParams: '0x', destParams: '0x' } } };
  expect(validateBoxSpecV2(changed, ctx)).toEqual({ reason: 0, field: 0 });
  expect(validateBoxSpecV2({ ...changed, [side]: { ...changed[side], a: { ...changed[side].a, destParams: '0x01' } } }, ctx).reason).not.toBe(0);
});
