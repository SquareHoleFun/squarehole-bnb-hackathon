/** Shop fee reads share one canonical block; raw money stays bigint. */
import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from 'viem';
import { NotSendableError } from '../../write/calls';
import { receiverModulesV21Abi, receiverV2Abi, shopVaultV2Abi } from './abi-v2';
import { assertSendableCallV2, type WriteCallV2, type WriteTargetV2 } from './write-calls-v2';
export interface ShopFeeStateV21 {
  readonly pendingP: bigint; readonly budgetT: bigint; readonly ceilingT: bigint; readonly feesT: bigint; readonly feesWanted: boolean;
}
export async function readShopFeeStateV21(reader: { callAt(to: Address, data: Hex, hash: Hex): Promise<Hex> }, receiver: Address, shop: Address, hash: Hex): Promise<ShopFeeStateV21> {
  const choice = decodeFunctionResult({ abi: receiverV2Abi, functionName: 'sellersChoice',
    data: await reader.callAt(receiver, encodeFunctionData({ abi: receiverV2Abi, functionName: 'sellersChoice' }), hash) });
  if (choice !== 11) throw new Error('receiver does not select the sellers shop choice');
  const read = async (functionName: 'budgetT' | 'ceilingT' | 'feesT' | 'feesWanted') => decodeFunctionResult({ abi: shopVaultV2Abi, functionName,
    data: await reader.callAt(shop, encodeFunctionData({ abi: shopVaultV2Abi, functionName }), hash) });
  const [budgetT, ceilingT, feesT, feesWanted, pendingP] = await Promise.all([
    read('budgetT'), read('ceilingT'), read('feesT'), read('feesWanted'),
    reader.callAt(receiver, encodeFunctionData({ abi: receiverModulesV21Abi, functionName: 'modulePendingP', args: [true] }), hash)
      .then(data => decodeFunctionResult({ abi: receiverModulesV21Abi, functionName: 'modulePendingP', data })),
  ]);
  return { budgetT: budgetT as bigint, ceilingT: ceilingT as bigint, feesT: feesT as bigint, feesWanted: feesWanted as boolean, pendingP };
}
/** Anyone requests a bounded core purchase/refund; caller supplies neither amount nor recipient. */
export function shopFeesCallV21(target: WriteTargetV2): WriteCallV2 {
  // The shared guard also admits the same entry as a directory action (The Alchemist); this writer is only ShopT.
  if (target.sellersChoice !== 11) throw new NotSendableError('only the sellers core shop step is sendable');
  const call = { to: target.receiver, data: encodeFunctionData({ abi: receiverModulesV21Abi, functionName: 'executeModule', args: [true] }), value: 0n };
  assertSendableCallV2(call, target, target.token);
  return call;
}
