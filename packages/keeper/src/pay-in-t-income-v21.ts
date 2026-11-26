/** Only finalized reward-buy tips with a directly authenticated keeper beneficiary enter F111 income. */
import { getAbiItem, type AbiEvent, type Address } from 'viem';
import { receiverPayInTV21Abi } from '../../chain/src/core/v2/abi-v2';
import type { ReceiptLog } from './income-read';
/**
 * `ours` authenticates a direct `buyBack(keeper)` call to this receiver; an unknown or nested beneficiary receives no
 * income credit. The caller reads that transaction once and keeps the answer (SH-247).
 */
export async function rewardTipsV21(ours: (l: ReceiptLog) => Promise<boolean>, receiver: Address,
  logs: (address: Address, event: AbiEvent) => Promise<readonly ReceiptLog[]>,
  value: (l: ReceiptLog, amount: bigint) => Promise<bigint> = async (_l, amount) => amount): Promise<bigint> {
  let tips = 0n;
  for (const l of await logs(receiver, getAbiItem({ abi: receiverPayInTV21Abi, name: 'RewardsBought' }))) {
    const amount = l.args.tipP;
    if (typeof amount !== 'bigint' || amount < 0n) throw new Error('invalid reward tip');
    if (amount === 0n) continue;
    if (await ours(l)) tips += await value(l, amount);
  }
  return tips;
}
