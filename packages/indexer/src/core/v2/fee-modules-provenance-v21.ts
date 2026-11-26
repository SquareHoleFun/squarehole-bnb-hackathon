import { type Address, type Hex } from 'viem';
import type { BoxSpecV2 } from './chain-v2';

/** After receiver clone/registry authentication, read its immutable future-action snapshots. */
export function moduleSnapshotsV21(spec: BoxSpecV2, runtime: Hex): readonly { module: Address; codeHash: Hex }[] {
  const sides = [spec.buyers, spec.sellers];
  if (!sides.some(side => side.a.dest === 9)) return [];
  const args = runtime.slice(92);
  if (args.length !== 782) throw new Error('invalid module receiver length');
  return sides.flatMap((side, i) => {
    const snapshot = args.slice(574 + i * 104, 678 + i * 104);
    if (side.a.dest !== 9) {
      if (!/^0{104}$/.test(snapshot)) throw new Error('unused module snapshot must be zero');
      return [];
    }
    if (args.slice(440 + i * 2, 442 + i * 2) !== '0a') throw new Error('module choice mismatch');
    const module = `0x${snapshot.slice(0, 40)}` as Address;
    const codeHash = `0x${snapshot.slice(40)}` as Hex;
    if (/^0x0+$/.test(module) || /^0x0+$/.test(codeHash)) throw new Error('empty module snapshot');
    return [{ module, codeHash }];
  });
}
