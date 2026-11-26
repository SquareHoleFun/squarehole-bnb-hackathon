import { decodeAbiParameters, encodeAbiParameters, parseAbiParameters, type Hex } from 'viem';
import type { BoxSpecV2, SideV2 } from './spec-v2';

const pileParameters = parseAbiParameters('address asset,uint256 seedAmount');
/** S1: one fixed asset and seed commitment; a commitment is never received money. */
export function pileConfigV2(contents: Hex) {
  const extended = contents.length === 194;
  const parameters = extended ? parseAbiParameters('address asset,uint256 seedAmount,uint16 leaveBehindBps') : pileParameters;
  const values = decodeAbiParameters(parameters, contents);
  if (encodeAbiParameters(parameters, values).toLowerCase() !== contents.toLowerCase()) throw new Error('noncanonical pile config');
  const leaveBehindBps = extended ? BigInt(values[2] as number) : 0n;
  if (leaveBehindBps !== 0n && leaveBehindBps !== 500n) throw new Error('invalid pile leave-behind preset');
  return { asset: values[0], seedAmount: values[1], leaveBehindBps };
}
/** Zero is reserved for a non-Items side; missing policy bytes never mean Keep. */
export function itemPolicyV2(side: SideV2): 0 | 1 | 2 | 3 {
  if (side.a.dest !== 8) return 0;
  if (!/^0x0{63}[123]$/i.test(side.a.destParams)) throw new Error('noncanonical item policy');
  return side.a.destParams.endsWith('1') ? 1 : side.a.destParams.endsWith('2') ? 2 : 3;
}
export function itemPoliciesV2(spec: BoxSpecV2) {
  return { buyers: itemPolicyV2(spec.buyers), sellers: itemPolicyV2(spec.sellers) };
}
