/** F143 manifest shape beside the older synthetic worlds. Both addresses and hashes are the box-spec pins. */
import { DRAND_SOURCE, DRAND_SOURCE_CODE_HASH, RANDOMNESS_SOURCE, RANDOMNESS_SOURCE_CODE_HASH } from '@squarehole/box-spec';
import type { DeployedCoreManifest } from '@squarehole/chain';
import { synthBox, synthManifest } from './core-synth';

export const F143_DRAND = { address: DRAND_SOURCE, codeHash: DRAND_SOURCE_CODE_HASH };

export function withF143<T extends Pick<DeployedCoreManifest, 'chain'>>(manifest: T): T {
  return { ...manifest, chain: { ...manifest.chain, randomness: { address: RANDOMNESS_SOURCE, codeHash: RANDOMNESS_SOURCE_CODE_HASH } } };
}

export const f143Manifest = () => withF143(synthManifest());
export function f143Box() {
  const box = synthBox({ boxId: 0n, creationBlock: 12n });
  return { ...box, row: { ...box.row, randomness: RANDOMNESS_SOURCE }, record: { ...box.record, randomness: RANDOMNESS_SOURCE } };
}
