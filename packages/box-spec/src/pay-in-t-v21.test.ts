import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { encodeAbiParameters, type Hex } from 'viem';
import { decodeBoxSpecV2, decodeReleaseContextV2, validateBoxSpecV2 } from './generated/box-spec.v2';
const vectors = JSON.parse(readFileSync(new URL('../../contracts/test/vectors/box-spec/box-spec-v2.json', import.meta.url), 'utf8'));
it.each(['buyers', 'sellers'] as const)('T01 admits canonical BuyT/Holders on %s', side => {
  const i = vectors.columns.reason.indexOf(0);
  const spec = decodeBoxSpecV2(vectors.columns.encoded[i] as Hex);
  const ctx = decodeReleaseContextV2(vectors.contexts[vectors.columns.context[i]].encoded as Hex);
  const params = (currency: number) => encodeAbiParameters([{ type: 'uint8' }], [currency]);
  const changed = { ...spec, [side]: { ...spec[side], a: { leg: 2, dest: 6, legParams: '0x', destParams: params(2) } } };
  expect(validateBoxSpecV2(changed, ctx)).toEqual({ reason: 0, field: 0 });
  for (const destParams of ['0x', params(1), `${params(2)}00`]) {
    expect(validateBoxSpecV2({ ...changed, [side]: { ...changed[side], a: { ...changed[side].a, destParams } } }, ctx).reason).not.toBe(0);
  }
});
