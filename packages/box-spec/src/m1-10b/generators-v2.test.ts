/** CQ11-D: independent hand-declared verdicts, frozen wire round trips and generator reproducibility. */
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { keccak256, type Hex } from 'viem';
import { loadModelV2, readSourcesV2, outputsV2 } from '../../scripts/lib/outputs-v2.mjs';
import { decodeBoxSpecV2, encodeBoxSpecV2, decodeReleaseContextV2, encodeReleaseContextV2, validateBoxSpecV2, specHashV2 } from '../generated/box-spec.v2';

const v = JSON.parse(readFileSync(new URL('../../../contracts/test/vectors/box-spec/box-spec-v2.json', import.meta.url), 'utf8')) as {
  count: number; contexts: { encoded: Hex }[]; columns: { name: string[]; encoded: Hex[]; context: number[]; reason: number[]; field: number[]; specHash: Hex[] };
};
it('BC-230 generated files reproduce the frozen specification', () => {
  const outputs = outputsV2(loadModelV2(readSourcesV2()));
  expect(outputs).toHaveLength(2);
});
for (let i = 0; i < v.count; ++i) {
  it(`BC-230 independent verdict: ${v.columns.name[i]}`, () => {
    const encoded = v.columns.encoded[i];
    const contextId = v.columns.context[i];
    if (encoded === undefined || contextId === undefined) throw new Error(`incomplete vector ${i}`);
    const s = decodeBoxSpecV2(encoded);
    const encodedCtx = v.contexts[contextId]?.encoded;
    if (encodedCtx === undefined) throw new Error(`missing context ${contextId}`);
    const ctx = decodeReleaseContextV2(encodedCtx);
    expect(encodeBoxSpecV2(s)).toBe(encoded);
    expect(encodeReleaseContextV2(ctx)).toBe(encodedCtx);
    expect(specHashV2(s)).toBe(keccak256(encoded));
    expect(specHashV2(s)).toBe(v.columns.specHash[i]);
    expect(validateBoxSpecV2(s, ctx)).toEqual({ reason: v.columns.reason[i], field: v.columns.field[i] });
  });
}
