import { holderBatchInTV21 } from './pay-in-t-v21';
import { poolManagerAbi } from '@squarehole/chain/abi';
import { decodeFunctionResult, encodeFunctionData, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import type { CoreReader } from '../core-reader';
import type { BoxRowV2 } from '../core-row';
import { coordinatorV2Abi, holderLedgerV2Abi, hookV2Abi, receiverV2Abi, shopVaultV2Abi, starterSetLoaderV2Abi } from './chain-v2';

type Reader = Pick<CoreReader, 'callAt'>;
export interface HolderClaimReaderV2 extends Reader {
  /** Read-only simulation, with the rightful holder as sender. Omit when the RPC cannot simulate at a hash. */
  callFromAt?(from: Address, to: Address, data: Hex, hash: Hex): Promise<Hex>;
}
const read = async <T>(reader: Reader, hash: Hex, to: Address, abi: Abi, fn: string, args: readonly unknown[] = []): Promise<T> =>
  decodeFunctionResult({ abi, functionName: fn, data: await reader.callAt(to, encodeFunctionData({ abi, functionName: fn, args }), hash) }) as T;

/** Uses canonical EIP-1898 eth_call only; no wallet, signature or transaction. */
export function m2RpcReaderV2(client: Pick<PublicClient, 'request'>): HolderClaimReaderV2 {
  const call = (to: Address, data: Hex, hash: Hex, from?: Address) => client.request({ method: 'eth_call', params: [{ to, data, ...(from ? { from } : {}) }, { blockHash: hash, requireCanonical: true }] } as never) as Promise<Hex>;
  return { callAt: call, callFromAt: (from, to, data, hash) => call(to, data, hash, from) };
}
function reverted(error: unknown): boolean {
  for (let i = 0; i < 10 && error && typeof error === 'object'; i++) {
    const e = error as { code?: number; name?: string; cause?: unknown };
    if (e.code === 3 || e.name === 'ExecutionRevertedError') return true;
    error = e.cause;
  }
  return false;
}

/** One bounded holder/batch query on an authenticated row. Never reconstruct credits from transfers or gross fees. */
export async function readHolderClaimV2(reader: HolderClaimReaderV2, row: BoxRowV2, request: { readonly batchId: bigint; readonly holder: Address }, hash: Hex) {
  const ledger = row.contracts.holderLedger; const { batchId, holder } = request;
  if (!ledger || batchId <= 0n || /^0x0{40}$/i.test(holder)) throw new Error('holder claim requires a ledger, positive batch and nonzero holder');
  const [receipt, fundingFinal, funding, batch, credit, failedBox] = await Promise.all([
    read<{ closed: boolean; netP: bigint }>(reader, hash, row.contracts.hook as Address, hookV2Abi, 'tradeBatch', [batchId]),
    read<boolean>(reader, hash, row.contracts.receiver as Address, receiverV2Abi, 'holderBatchClosed', [batchId]),
    read<bigint>(reader, hash, row.contracts.receiver as Address, receiverV2Abi, 'holderBatchPaid', [batchId]),
    read<readonly [boolean, bigint, bigint, bigint]>(reader, hash, ledger, holderLedgerV2Abi, 'batchState', [batchId]),
    read<bigint>(reader, hash, ledger, holderLedgerV2Abi, 'claimable', [batchId, holder]),
    read<boolean>(reader, hash, row.contracts.coordinator as Address, coordinatorV2Abi, 'failed'),
  ]);
  const inT = holderBatchInTV21(row.spec, batchId);
  const [complete, holderCursor, noticeCursor, residueP] = batch;
  if ((fundingFinal && !receipt.closed) || (complete && !fundingFinal) || (!inT && funding > receipt.netP)
    || credit + residueP > funding || (credit !== 0n && (!fundingFinal || (!inT && !complete)))) throw new Error('inconsistent holder batch reads');
  // SH-279: a batch paid in the price coin whose funding is final and zero can never credit anyone (credit + residue never
  // exceeds the funding, checked above), so it is settled with nothing to claim, whether or not the ledger's settlement
  // step ever runs (nobody pays to complete an empty batch). A batch paid in the box token keeps its rule: its credit
  // follows tranches bought after the funding, so a zero there is not known to be final.
  const empty = !inT && fundingFinal && funding === 0n;
  const status = !receipt.closed ? 'open' : !fundingFinal ? 'awaiting_funding' : !complete && !empty ? 'settling' : 'settled';
  const next = inT && credit > (1n << 127n) - 1n ? (1n << 127n) - 1n : credit;
  const claimableP = status === 'settled' || (inT && credit > 0n) ? next : null;
  let payout: 'not_ready' | 'empty' | 'unverified' | 'available' | 'unavailable' = claimableP === null ? 'not_ready' : credit === 0n ? 'empty' : 'unverified';
  if (claimableP !== null && credit > 0n && reader.callFromAt) {
    try {
      const data = await reader.callFromAt(holder, ledger, encodeFunctionData({ abi: holderLedgerV2Abi, functionName: 'claim', args: [batchId, holder] }), hash);
      payout = decodeFunctionResult({ abi: holderLedgerV2Abi, functionName: 'claim', data }) === next ? 'available' : 'unverified';
    } catch (error) { payout = reverted(error) ? 'unavailable' : 'unverified'; }
  }
  const t = inT ? { token: row.contracts.token, fundingT: fundingFinal ? funding : null, residueT: residueP, creditT: credit, claimableT: claimableP, payout } : undefined;
  return { ...(t ? { t } : {}), hash, batchId, holder, status, hookClosed: receipt.closed, fundingFinal, fundingP: inT ? 0n : fundingFinal ? funding : null,
    complete, holderCursor, noticeCursor, residueP: inT ? 0n : residueP, claimableP: inT ? 0n : claimableP, failedBox, payout: inT ? 'empty' as const : payout };
}

/** Current custody and gate reads supplement logs; never turn seed commitments into received money. */
export async function readM2MoneyV2(reader: Reader, row: BoxRowV2, hash: Hex) {
  const shopAddress = row.spec.boxType === 4 ? row.contracts.vault : null;
  const loader = row.spec.boxType === 4 ? row.contracts.starterSetLoader : null;
  const holderBalanceP = row.contracts.holderLedger ? await read<bigint>(reader, hash, row.poolManager, poolManagerAbi, 'balanceOf', [row.contracts.holderLedger, BigInt(row.q)]) : null;
  let shop = null;
  if (shopAddress) {
    const at = <T>(fn: string) => read<T>(reader, hash, shopAddress, shopVaultV2Abi, fn);
    const [budgetT, failedT, seedReady, inside, collectionSize, curator, pendingCurator, nextAdditionAt] = await Promise.all([
      at<bigint>('budgetT'), at<bigint>('failedT'), at<boolean>('seedReady'), at<bigint>('inside'), at<bigint>('collectionSize'),
      at<Address>('curator'), at<Address>('pendingCurator'), at<bigint>('nextAdditionAt'),
    ]);
    shop = { budgetT, failedT, seedReady, inside, collectionSize, curator, pendingCurator, nextAdditionAt };
  }
  const progress = loader ? await read<readonly [number, Hex, boolean]>(reader, hash, loader, starterSetLoaderV2Abi, 'progress') : null;
  return { hash, holderBalanceP, shop, starter: progress ? { loaded: progress[0], remainingHash: progress[1], notified: progress[2] } : null };
}
export type M2MoneyV2 = Awaited<ReturnType<typeof readM2MoneyV2>>;
