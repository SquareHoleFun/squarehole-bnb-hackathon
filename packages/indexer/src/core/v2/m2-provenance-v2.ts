import { rewardArgsSuffixV21, receiverArgsHexLengthV21 } from './pay-in-t-provenance-v21';
import { toHex, type Address, type Hex } from 'viem';
import { shopConfigV2, starterCommitmentV2, type BoxRecordV2, type BoxSpecV2 } from './chain-v2';

/** Called only after proxy implementation and recorded runtime hashes have been checked. */
export function m2WiringProblem(record: BoxRecordV2, spec: BoxSpecV2, code: (a: Address) => Hex): string | null {
  const at = (i: number) => record.contracts[i] as Address;
  const pack = (...xs: Hex[]) => xs.map(x => x.slice(2)).join('').toLowerCase();
  const args = (i: number) => code(at(i)).slice(92).toLowerCase();
  const field = (i: number, offset: number, value: Hex) => args(i).slice(offset * 2, offset * 2 + value.length - 2) === value.slice(2).toLowerCase();
  const holder = !/^0x0{40}$/i.test(at(17));
  const shop = spec.boxType === 4;
  if (!holder && !shop) return null;
  if (args(5).length !== receiverArgsHexLengthV21(spec) || !field(5, 0, at(0)) || !field(5, 20, at(2)) || !field(5, 40, record.q)
    || !field(5, 60, at(1)) || !field(5, 223, at(17))) return 'receiver M2 wiring mismatch';
  if (holder) {
    if (args(17) !== pack(at(0), at(1), at(2), at(5), record.q) + rewardArgsSuffixV21(spec, 6, at(1))) return 'holderLedger M2 wiring mismatch';
    if (args(2).length !== 462 || !field(2, 0, record.q) || !field(2, 20, at(1)) || !field(2, 139, at(0))
      || !field(2, 159, at(5)) || !field(2, 211, at(17))) return 'hook M2 wiring mismatch';
  }
  if (shop) {
    if (args(0).length !== 470 || !field(0, 234, '0x04')) return 'coordinator SHOP tag mismatch';
    const shopPreset = spec.sellers.a.leg === 2 && spec.sellers.a.dest === 7 ? spec.sellers.a.destParams.slice(-2).toLowerCase() : '';
    if (args(3) !== pack(at(0), at(1), at(19), spec.contentsParams) + shopPreset) return 'shop M2 wiring mismatch';
    try {
      const config = shopConfigV2(spec.contentsParams);
      const starter = starterCommitmentV2(spec);
      if (config.seedT > 0n && !starter) return 'shop seed requires starter loader';
      if (starter && args(19) !== pack(at(0), at(3), starter.setHash, toHex(starter.count, { size: 4 }))) return 'starterSetLoader M2 wiring mismatch';
    } catch { return 'invalid shop or starter commitment'; }
  }
  return null;
}
