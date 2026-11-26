import { expect, it } from 'vitest';
import { encodeAbiParameters } from 'viem';
import { itemPolicyV2 } from './m3-spec-v2';
import { decodeBoxSpecV2, encodeBoxSpecV2, recipeOf, type SideV2 } from './spec-v2';
import { synthBoxV2 } from './test-support/synth-v2';

it('IP06 decodes Depth for both P and T item sides and keeps legacy values', () => {
  for (const leg of [1, 2]) for (const policy of [1, 2, 3]) {
    const side: SideV2 = { split: 1, splitParams: '0x',
      a: { leg, dest: 8, legParams: '0x', destParams: encodeAbiParameters([{ type: 'uint8' }], [policy]) },
      b: { leg: 0, dest: 0, legParams: '0x', destParams: '0x' } };
    expect(itemPolicyV2(side)).toBe(policy);
    const box = synthBoxV2({ boxId: 1n, specOf: spec => ({ ...spec, buyers: side, sellers: side }) });
    const wire = box.spec;
    const encoded = encodeBoxSpecV2(wire);
    expect(encodeBoxSpecV2(decodeBoxSpecV2(encoded, box.record))).toBe(encoded);
    expect(recipeOf(wire).buyers.a.destParams).toEqual({ insidePolicy: policy });
    expect(recipeOf(wire).sellers.a.destParams).toEqual({ insidePolicy: policy });
    expect(() => itemPolicyV2({ ...side, a: { ...side.a, destParams: encodeAbiParameters([{ type: 'uint8' }], [4]) } })).toThrow();
  }
});
