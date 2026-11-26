import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { encodeAbiParameters, type Hex } from 'viem';
import { decodeBoxSpecV2, decodeReleaseContextV2, validateBoxSpecV2, type BoxSpecV2 } from './generated/box-spec.v2';
const vectors = JSON.parse(readFileSync(new URL('../../contracts/test/vectors/box-spec/box-spec-v2.json', import.meta.url), 'utf8'));
it.each(['buyers', 'sellers'] as const)('PF03 admits same-P pile fees and both presets on %s', side => {
  const i = vectors.columns.reason.indexOf(0);
  const old = decodeBoxSpecV2(vectors.columns.encoded[i] as Hex);
  const ctx = decodeReleaseContextV2(vectors.contexts[vectors.columns.context[i]].encoded as Hex);
  const params = (bps: number) => encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint16' }], [old.pricing.token, 1000n, bps]);
  const spec: BoxSpecV2 = { ...old, boxType: 5, n: 0, firstId: 0n, collectionName: '', collectionSymbol: '', collectionCoverSha256: `0x${'00'.repeat(32)}`, artMode: 0, revealRoot: `0x${'00'.repeat(32)}`, metadataTable: '0x', generatorHash: `0x${'00'.repeat(32)}`, revealListId: `0x${'00'.repeat(32)}`, marketplaceOwner: `0x${'00'.repeat(20)}`, pickFeeBps: 0, creatorFeeRecipient: `0x${'00'.repeat(20)}`, addOns: [], contentsParams: params(500), [side]: { ...old[side], a: { leg: 1, dest: 7, legParams: '0x', destParams: '0x' } } };
  for (const bps of [0, 500]) expect(validateBoxSpecV2({ ...spec, contentsParams: params(bps) }, ctx)).toEqual({ reason: 0, field: 0 });
  expect(validateBoxSpecV2({ ...spec, contentsParams: params(499) }, ctx).reason).not.toBe(0);
  expect(validateBoxSpecV2({ ...spec, contentsParams: `${params(500)}00` }, ctx).reason).not.toBe(0);
  expect(validateBoxSpecV2({ ...old, [side]: spec[side] }, ctx).reason).not.toBe(0);
});
