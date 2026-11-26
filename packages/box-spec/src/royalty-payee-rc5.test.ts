import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { encodeAbiParameters, zeroAddress, type Hex } from 'viem';
import { decodeBoxSpecV2, decodeReleaseContextV2, validateBoxSpecV2 } from './generated/box-spec.v2';

const vectors = JSON.parse(readFileSync(new URL('../../contracts/test/vectors/box-spec/box-spec-v2.json', import.meta.url), 'utf8'));
it.each([1, 2, 3])('RC6 royalty destination %s admits only fee handling with an in-kind payee', destination => {
  const i = vectors.columns.reason.findIndex((reason: number, n: number) => reason === 0 && decodeBoxSpecV2(vectors.columns.encoded[n]).boxType === 1);
  const old = decodeBoxSpecV2(vectors.columns.encoded[i] as Hex);
  const ctx = decodeReleaseContextV2(vectors.contexts[vectors.columns.context[i]].encoded as Hex);
  const side = { a: { leg: 1, dest: 4, legParams: '0x' as Hex, destParams: '0x' as Hex }, b: { leg: 0, dest: 0, legParams: '0x' as Hex, destParams: '0x' as Hex }, split: 1, splitParams: '0x' as Hex };
  const spec = { ...old, buyers: side, sellers: side, addOns: [{ id: 4, params: encodeAbiParameters([{ type: 'uint16' }, { type: 'uint8' }], [500, destination]) }], creatorFeeRecipient: zeroAddress };
  if (destination !== 1) {
    expect(validateBoxSpecV2({ ...spec, creatorFeeRecipient: '0x000000000000000000000000000000000000cafe' }, ctx).reason).not.toBe(0);
    return;
  }
  expect(validateBoxSpecV2(spec, ctx)).toEqual({ reason: 7, field: 26 });
  expect(validateBoxSpecV2({ ...spec, creatorFeeRecipient: '0x000000000000000000000000000000000000cafe' }, ctx)).toEqual({ reason: 0, field: 0 });
});
