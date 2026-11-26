import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from 'viem';
import { poolManagerAbi } from '@squarehole/chain/abi';
import { readPayInTStateV21, type PayInTStateV21 } from './chain-v2';
import type { BoxRowV2 } from '../core-row';
import type { CoreReader } from '../core-reader';
export interface PayInTMoneyV21 extends PayInTStateV21 { readonly holderBalanceT: bigint; readonly itemBalanceT: bigint; readonly receiverBalanceT: bigint }
export async function readPayInTMoneyV21(reader: Pick<CoreReader, 'callAt'>, row: BoxRowV2, hash: Hex): Promise<PayInTMoneyV21> {
  const claims = async (address?: string | null): Promise<bigint> => {
    if (!address || /^0x0{40}$/i.test(address)) return 0n;
    const data = encodeFunctionData({ abi: poolManagerAbi, functionName: 'balanceOf', args: [address as Address, BigInt(row.contracts.token as string)] });
    return decodeFunctionResult({ abi: poolManagerAbi, functionName: 'balanceOf', data: await reader.callAt(row.poolManager, data, hash) }) as bigint;
  };
  const [state, holderBalanceT, itemBalanceT, receiverBalanceT] = await Promise.all([
    readPayInTStateV21(reader, row.contracts.receiver as Address, hash), claims(row.contracts.holderLedger), claims(row.contracts.itemLedger), claims(row.contracts.receiver),
  ]);
  return { ...state, holderBalanceT, itemBalanceT, receiverBalanceT };
}

import { itemLedgerV2Abi, readItemCreditTV21 } from './chain-v2';
import type { HolderClaimReaderV2 } from './m2-reads-v2';
/** Attach the independent T quote to the legacy P item response; a failed simulation never invents availability. */
export async function itemClaimTQuoteV21(reader: HolderClaimReaderV2, row: BoxRowV2, hash: Hex,
  id: bigint, owner: Address, ready: boolean, eligible: boolean, reverted: (error: unknown) => boolean) {
  if (![row.spec.buyers, row.spec.sellers].some(s => s.a.leg === 2 && s.a.dest === 8)) return undefined;
  const ledger = row.contracts.itemLedger as Address;
  const [credit, money] = await Promise.all([readItemCreditTV21(reader, ledger, id, hash), readPayInTMoneyV21(reader, row, hash)]);
  const total = credit[0] + credit[1], max = (1n << 127n) - 1n;
  if (total > money.itemBalanceT) throw new Error('item T credit is not backed');
  const claimableT = ready ? eligible ? total > max ? max : total : 0n : null;
  let payout: 'not_ready' | 'not_owner_claimable' | 'empty' | 'unverified' | 'available' | 'unavailable' = !ready ? 'not_ready' : !eligible ? 'not_owner_claimable' : total === 0n ? 'empty' : 'unverified';
  if (payout === 'unverified' && reader.callFromAt) {
    try {
      const data = await reader.callFromAt(owner, ledger, encodeFunctionData({ abi: itemLedgerV2Abi, functionName: 'claimT', args: [[id], owner] }), hash);
      if (decodeFunctionResult({ abi: itemLedgerV2Abi, functionName: 'claimT', data }) === claimableT) payout = 'available';
    } catch (error) { payout = reverted(error) ? 'unavailable' : 'unverified'; }
  }
  return { token: row.contracts.token, balanceT: money.itemBalanceT, outsideT: ready ? credit[0] : null, stashT: ready ? credit[1] : null, claimableT, payout };
}
