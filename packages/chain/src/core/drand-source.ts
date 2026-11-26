import { DRAND_SOURCE, DRAND_SOURCE_CODE_HASH, RANDOMNESS_SOURCE_CODE_HASH } from '@squarehole/box-spec';
import type { DeployedCoreManifest } from '../config/core-manifest';

type Source = DeployedCoreManifest['chain']['randomness'];

/** F143: the pinned backed source's DRAND() is constant; older manifests already name DrandSource. No RPC read. */
export function drandSourceOf(manifest: { readonly chain: { readonly randomness: Source } }): Source {
  return manifest.chain.randomness.codeHash.toLowerCase() === RANDOMNESS_SOURCE_CODE_HASH.toLowerCase()
    ? { address: DRAND_SOURCE, codeHash: DRAND_SOURCE_CODE_HASH }
    : manifest.chain.randomness;
}
