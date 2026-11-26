/** V2.1 reads are bound to one canonical block hash; no balance is converted to a JS number. */
import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from 'viem';
import { listingBurnV21Abi, receiverEatV21Abi } from './abi-v2';
import type { WriteCallV2, WriteTargetV2 } from './write-calls-v2';

export interface EatReaderV21 { callAt(to: Address, data: Hex, hash: Hex): Promise<Hex> }
export interface EatStateV21 {
  readonly pendingP: bigint;
  readonly eatenP: bigint;
  readonly burnSelector: Hex;
}
/** Read the receiver's creation snapshot and cumulative/pending totals. A failed read remains an error. */
export async function readEatStateV21(reader: EatReaderV21, receiver: Address, hash: Hex): Promise<EatStateV21> {
  const read = async (functionName: 'eatPendingP' | 'eatenP' | 'priceBurnSelector') => {
    const data = encodeFunctionData({ abi: receiverEatV21Abi, functionName });
    return decodeFunctionResult({ abi: receiverEatV21Abi, functionName, data: await reader.callAt(receiver, data, hash) });
  };
  const [pendingP, eatenP, burnSelector] = await Promise.all([read('eatPendingP'), read('eatenP'), read('priceBurnSelector')]);
  return { pendingP: pendingP as bigint, eatenP: eatenP as bigint, burnSelector: burnSelector as Hex };
}
/** Listing capability is explicit; never infer burnability from a ticker, token class or a selector's existence. */
export async function readCheckedBurnV21(reader: EatReaderV21, registry: Address, token: Address, hash: Hex): Promise<Hex> {
  const data = encodeFunctionData({ abi: listingBurnV21Abi, functionName: 'checkedBurnSelector', args: [token] });
  return decodeFunctionResult({ abi: listingBurnV21Abi, functionName: 'checkedBurnSelector', data: await reader.callAt(registry, data, hash) });
}
/** Prepared receiver only; the shared write guard rechecks target, canonical calldata and zero value. */
export function eatPriceCoinCallV21(target: WriteTargetV2): WriteCallV2 {
  return { to: target.receiver, data: encodeFunctionData({ abi: receiverEatV21Abi, functionName: 'eatPriceCoin' }), value: 0n };
}
/** Site/launch owners can use this wording with the checked creation snapshot. */
export function eatLabelV21(symbol: string, burnSelector: Hex): string {
  return `${burnSelector === '0x00000000' ? 'Lock' : 'Burn'} ${symbol}`;
}
