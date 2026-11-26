import { DRAND_SOURCE, DRAND_SOURCE_CODE_HASH, RANDOMNESS_SOURCE, RANDOMNESS_SOURCE_CODE_HASH } from '@squarehole/box-spec';
import { describe, expect, it } from 'vitest';
import * as chain from '../index';

describe('F143: the DrandSource behind a manifest', () => {
  it('the backed source code pin selects its constant DrandSource and code pin', () => {
    const manifest = { chain: { randomness: { address: RANDOMNESS_SOURCE, codeHash: RANDOMNESS_SOURCE_CODE_HASH } } };
    expect(chain.drandSourceOf(manifest)).toEqual({ address: DRAND_SOURCE, codeHash: DRAND_SOURCE_CODE_HASH });
    expect(chain.drandSourceOf({ chain: { randomness: { ...manifest.chain.randomness, codeHash: RANDOMNESS_SOURCE_CODE_HASH.toUpperCase() as `0x${string}` } } })).toEqual({ address: DRAND_SOURCE, codeHash: DRAND_SOURCE_CODE_HASH });
  });

  it('every other code hash keeps the manifest entry itself, including pre-F143 manifests', () => {
    for (const codeHash of [DRAND_SOURCE_CODE_HASH, `0x${'ab'.repeat(32)}` as const]) {
      const randomness = { address: RANDOMNESS_SOURCE, codeHash };
      expect(chain.drandSourceOf({ chain: { randomness } })).toBe(randomness);
    }
  });
});
