/** Additive v2.1 T reward reads. All amounts remain bigint and reads share a canonical block hash. */
import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from 'viem';
import { receiverPayInTV21Abi, itemLedgerV2Abi } from './abi-v2';
import type { EatReaderV21 } from './eat-v21';
import type { WriteCallV2, WriteTargetV2 } from './write-calls-v2';
export interface PayInTStateV21 {
  readonly pendingP: bigint;
  readonly holdersP: bigint;
  readonly buyersItemsP: bigint;
  readonly sellersItemsP: bigint;
  readonly burnPendingT: bigint;
}
export async function readPayInTStateV21(reader: EatReaderV21, receiver: Address, hash: Hex): Promise<PayInTStateV21> {
  const read = async (functionName: 'rewardsPendingP' | 'rewardsPendingByKind' | 'rewardBurnPendingT') =>
    decodeFunctionResult({ abi: receiverPayInTV21Abi, functionName, data: await reader.callAt(receiver,
      encodeFunctionData({ abi: receiverPayInTV21Abi, functionName }), hash) });
  const [pending, kinds, burn] = await Promise.all([read('rewardsPendingP'), read('rewardsPendingByKind'), read('rewardBurnPendingT')]);
  const [holdersP, buyersItemsP, sellersItemsP] = kinds as readonly [bigint, bigint, bigint];
  if (pending !== holdersP + buyersItemsP + sellersItemsP) throw new Error('inconsistent T credit pending P');
  return { pendingP: pending as bigint, holdersP, buyersItemsP, sellersItemsP, burnPendingT: burn as bigint };
}
/** Builds a current-owner payout; the contract authenticates the NFT owner before redeeming T. */
export function itemClaimTCallV21(target: WriteTargetV2, id: bigint, owner: Address): WriteCallV2 {
  if (!target.itemLedger || id <= 0n) throw new Error('missing T item claim target');
  return { to: target.itemLedger, data: encodeFunctionData({ abi: itemLedgerV2Abi, functionName: 'claimT', args: [[id], owner] }), value: 0n };
}
/** Credit is denominated in T even when the opposite fee side still pays P. */
export async function readItemCreditTV21(reader: EatReaderV21, ledger: Address, id: bigint, hash: Hex): Promise<readonly [bigint, bigint]> {
  return decodeFunctionResult({ abi: itemLedgerV2Abi, functionName: 'itemCreditT', data: await reader.callAt(ledger,
    encodeFunctionData({ abi: itemLedgerV2Abi, functionName: 'itemCreditT', args: [id] }), hash) });
}
