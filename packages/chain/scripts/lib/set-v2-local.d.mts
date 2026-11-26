import type { SetCoreManifest, SetReleaseManifest } from '../../src/core/set-v2/manifest-set-v2';
export function sparseSetIds(): bigint[];
export function setManifestFromReads(input: {
  chainId: number; factory: string; startBlock: string; block: bigint; core: SetCoreManifest;
  pin: (address: string, block: bigint) => Promise<unknown>;
  read: (fn: string, args: unknown[], block: bigint) => Promise<unknown>;
}): Promise<SetReleaseManifest>;
