import { rewardArgsSuffixV21, receiverArgsHexLengthV21 } from './pay-in-t-provenance-v21';
import { toHex, type Address, type Hex } from 'viem';
import { itemPoliciesV2, pileConfigV2, type BoxRecordV2, type BoxSpecV2 } from './chain-v2';

/** S1/S6 wiring after release implementation and recorded runtime hash verification. */
export function m3WiringProblem(record: BoxRecordV2, spec: BoxSpecV2, code: (a: Address) => Hex): string | null {
  const at = (i: number) => record.contracts[i] as Address;
  const args = (i: number) => code(at(i)).slice(92).toLowerCase();
  const pack = (...xs: Hex[]) => xs.map(x => x.slice(2)).join('').toLowerCase();
  const field = (i: number, offset: number, value: Hex) => args(i).slice(offset * 2, offset * 2 + value.length - 2) === value.slice(2).toLowerCase();
  const isZero = (i: number) => /^0x0{40}$/i.test(at(i));
  try {
    const policies = itemPoliciesV2(spec);
    const items = policies.buyers !== 0 || policies.sellers !== 0;
    const pile = spec.boxType === 5;
    if (items !== !isZero(16)) return 'item choice and item ledger role disagree';
    if (!items && !pile) return null;
    // Only the seeded pile aliases a role; no other shared emitter is admitted.
    const seen = new Map<string, number>();
    for (let i = 0; i < record.contracts.length; i++) {
      if (isZero(i)) continue;
      const key = at(i).toLowerCase(); const prior = seen.get(key);
      if (prior !== undefined && !(pile && prior === 3 && i === 19)) return 'unexpected M3 role alias';
      seen.set(key, i);
    }
    if (args(5).length !== receiverArgsHexLengthV21(spec) || !field(5, 0, at(0)) || !field(5, 20, at(2)) || !field(5, 40, record.q)
      || !field(5, 60, at(1)) || !field(5, 223, at(17)) || !field(5, 243, at(16))) return 'receiver M3 wiring mismatch';
    if (items) {
      if (spec.boxType !== 1 || spec.n === 0 || isZero(3) || isZero(4)) return 'items require the own new collection';
      if (!isZero(7) !== spec.addOns.some(a => a.id === 1)) return 'item tickets role disagrees with add-on';
      const minimum = `0x${args(5).slice(344, 376)}` as Hex;
      const tip = `0x${args(5).slice(376, 408)}` as Hex;
      const expected = pack(at(0), at(3), at(4), at(7), at(5), at(2), record.q,
        toHex(policies.buyers, { size: 1 }), toHex(policies.sellers, { size: 1 }),
        toHex(BigInt(minimum), { size: 32 }), toHex(BigInt(tip), { size: 32 }));
      if (args(16) !== expected + rewardArgsSuffixV21(spec, 8, at(1))) return 'item ledger M3 wiring mismatch';
    }
    if (pile) {
      const config = pileConfigV2(spec.contentsParams);
      const pileFees = [spec.buyers, spec.sellers].some(s => s.a.leg === 1 && s.a.dest === 7);
      if (pileFees && (config.asset.toLowerCase() !== record.q.toLowerCase() || !field(5, 267, at(3)))) return 'pile fee receiver mismatch';
      if (pileFees && ![spec.buyers, spec.sellers].some(s => s.a.leg === 1 && s.a.dest === 1) && !field(5, 263, '0x00000000')) return 'unexpected pile burn selector';
      if (items || !isZero(4) || !isZero(7) || !isZero(16) || spec.n !== 0 || spec.firstId !== 0n
        || spec.collectionName !== '' || spec.collectionSymbol !== '' || spec.pickFeeBps !== 0
        || spec.addOns.some(a => a.id !== 4)) return 'pile has collection-only roles or fields';
      if (config.asset.toLowerCase() === at(1).toLowerCase()) return 'pile asset cannot be own T';
      if (config.seedAmount > 0n ? at(19).toLowerCase() !== at(3).toLowerCase() : !isZero(19)) return 'pile seed loader alias mismatch';
      if (args(3) !== pack(at(0), at(1), config.asset, record.creator, toHex(config.seedAmount, { size: 32 })) + (spec.contentsParams.length === 194 ? toHex(config.leaveBehindBps, { size: 2 }).slice(2) : '')) return 'pile M3 wiring mismatch';
    }
    return null;
  } catch { return 'invalid M3 parameters or clone arguments'; }
}
