/** Pending and cumulative pile fees are read at one canonical block hash. */
import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from 'viem';
import { receiverPileV21Abi } from './abi-v2';
import type { WriteCallV2, WriteTargetV2 } from './write-calls-v2';
export interface PileFeeStateV21 { readonly pendingP: bigint; readonly movedP: bigint }
export async function readPileFeeStateV21(reader: { callAt(to: Address, data: Hex, hash: Hex): Promise<Hex> }, receiver: Address, hash: Hex): Promise<PileFeeStateV21> {
  const read = async (functionName: 'pilePendingP' | 'pileMovedP') => decodeFunctionResult({ abi: receiverPileV21Abi, functionName,
    data: await reader.callAt(receiver, encodeFunctionData({ abi: receiverPileV21Abi, functionName }), hash) });
  const [pendingP, movedP] = await Promise.all([read('pilePendingP'), read('pileMovedP')]);
  return { pendingP, movedP };
}
/** Permissionless, fixed pile recipient, no caller-selected amount and no value. */
export function moveToPileCallV21(target: WriteTargetV2): WriteCallV2 {
  return { to: target.receiver, data: encodeFunctionData({ abi: receiverPileV21Abi, functionName: 'moveToPile' }), value: 0n };
}
