import { itemClaimTQuoteV21 } from './pay-in-t-reads-v21';
import { boxCollectionAbi, boxTokenAbi, poolManagerAbi } from '@squarehole/chain/abi';
import { decodeFunctionResult, encodeFunctionData, type Abi, type Address, type Hex } from 'viem';
import type { CoreReader } from '../core-reader';
import type { BoxRowV2 } from '../core-row';
import { coordinatorV2Abi, itemLedgerV2Abi, pileConfigV2, pileVaultV2Abi, receiverItemsV2Abi, vaultItemsV2Abi } from './chain-v2';
import type { M3ViewV2 } from './m3-views-v2';
import type { HolderClaimReaderV2 } from './m2-reads-v2';

type Reader = Pick<CoreReader, 'callAt'>;
// ItemLedgerV2.claim caps each PM burn/take at int128.max; unpaid credit stays with the NFT.
const MAX_ITEM_CLAIM_P = (1n << 127n) - 1n;
const read = async <T>(r: Reader, hash: Hex, to: Address, abi: Abi, fn: string, args: readonly unknown[] = []): Promise<T> =>
  decodeFunctionResult({ abi, functionName: fn, data: await r.callAt(to, encodeFunctionData({ abi, functionName: fn, args }), hash) }) as T;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const balance = (r: Reader, row: BoxRowV2, ledger: Address, hash: Hex) => read<bigint>(r, hash, row.poolManager, poolManagerAbi, 'balanceOf', [ledger, BigInt(row.q)]);
async function progress(r: Reader, row: BoxRowV2, hash: Hex) {
  const ledger = row.contracts.itemLedger;
  if (!ledger || !row.contracts.vault || !row.contracts.receiver) throw new Error('item ledger and history roles required');
  const [fundingCursor, lifecycleCursor, fundingCount, lifecycleCount, balanceP] = await Promise.all([
    read<bigint>(r, hash, ledger, itemLedgerV2Abi, 'fundingCursor'),
    read<bigint>(r, hash, ledger, itemLedgerV2Abi, 'lifecycleCursor'),
    read<bigint>(r, hash, row.contracts.receiver, receiverItemsV2Abi, 'itemFundingCount'),
    read<bigint>(r, hash, row.contracts.vault, vaultItemsV2Abi, 'itemLifecycleCount'), balance(r, row, ledger, hash),
  ]);
  if (fundingCursor > fundingCount || lifecycleCursor > lifecycleCount) throw new Error('item cursor exceeds history');
  return { fundingCursor, lifecycleCursor, fundingCount, lifecycleCount, balanceP,
    status: fundingCursor === fundingCount && lifecycleCursor === lifecycleCount ? 'synced' as const : 'sync_pending' as const };
}
function reverted(error: unknown): boolean {
  for (let i = 0; i < 10 && error && typeof error === 'object'; ++i) {
    const e = error as { code?: number; name?: string; cause?: unknown };
    if (e.code === 3 || e.name === 'ExecutionRevertedError') return true;
    error = e.cause;
  }
  return false;
}

/** Current-owner query: outsideP/stashP are full credit; claimableP is the next bounded payment. */
export async function readItemClaimV2(r: HolderClaimReaderV2, row: BoxRowV2, request: { readonly id: bigint }, hash: Hex) {
  const { id } = request; const ledger = row.contracts.itemLedger; const collection = row.contracts.collection;
  const coordinator = row.contracts.coordinator; const vault = row.contracts.vault;
  if (!ledger || !collection || !coordinator || !vault || row.spec.boxType !== 1 || id < row.spec.firstId || id >= row.spec.firstId + BigInt(row.spec.n)) throw new Error('invalid item claim');
  const [p, credit, owner, failed, graduated] = await Promise.all([
    progress(r, row, hash), read<readonly [bigint, bigint]>(r, hash, ledger, itemLedgerV2Abi, 'itemCredit', [id]),
    read<Address>(r, hash, collection, boxCollectionAbi, 'ownerOf', [id]),
    read<boolean>(r, hash, coordinator, coordinatorV2Abi, 'failed'),
    read<boolean>(r, hash, coordinator, coordinatorV2Abi, 'graduated'),
  ]);
  const ready = p.status === 'synced';
  const totalP = credit[0] + credit[1];
  if (totalP > p.balanceP || (failed && totalP > 0n)) throw new Error('item credit is not backed');
  const eligible = !same(owner, vault) && !/^0x0{40}$/i.test(owner) && graduated && !failed;
  const outsideP = ready ? credit[0] : null; const stashP = ready ? credit[1] : null;
  const nextP = totalP > MAX_ITEM_CLAIM_P ? MAX_ITEM_CLAIM_P : totalP;
  const claimableP = ready ? eligible ? nextP : 0n : null;
  let payout: 'not_ready' | 'not_owner_claimable' | 'empty' | 'unverified' | 'available' | 'unavailable' = !ready ? 'not_ready' : !eligible ? 'not_owner_claimable' : claimableP === 0n ? 'empty' : 'unverified';
  if (payout === 'unverified' && r.callFromAt) {
    try {
      const data = await r.callFromAt(owner, ledger, encodeFunctionData({ abi: itemLedgerV2Abi, functionName: 'claim', args: [[id], owner] }), hash);
      payout = decodeFunctionResult({ abi: itemLedgerV2Abi, functionName: 'claim', data }) === claimableP ? 'available' : 'unverified';
    } catch (error) { payout = reverted(error) ? 'unavailable' : 'unverified'; }
  }
  const t = await itemClaimTQuoteV21(r, row, hash, id, owner, ready, eligible, reverted);
  return { ...(t ? { t } : {}), hash, id, owner, ...p, outsideP, stashP, claimableP, failed, graduated, payout };
}

/** Ticket start excludes graduation base. It is an index, not a timestamp or a claimable wallet balance. */
export async function readItemTicketV2(r: Reader, row: BoxRowV2, key: Hex, hash: Hex) {
  if (!row.contracts.itemLedger || !/^0x[0-9a-f]{64}$/i.test(key) || /^0x0{64}$/i.test(key)) throw new Error('invalid item ticket key');
  const [p, ticket] = await Promise.all([progress(r, row, hash), read<readonly [bigint, bigint, boolean]>(r, hash, row.contracts.itemLedger, itemLedgerV2Abi, 'ticketCredit', [key])]);
  if (ticket[1] > p.balanceP || (!ticket[2] && ticket[1] !== 0n)) throw new Error('ticket credit is not backed');
  const ready = p.status === 'synced';
  return { hash, key, ...p, start: ready ? ticket[0] : null, outsideP: ready ? ticket[1] : null, open: ready ? ticket[2] : null };
}

/** Bounded custody reads. quoteRedeem(totalSupply) equals the live fixed-asset balance even for native P. */
export async function readM3MoneyV2(r: Reader, row: BoxRowV2, view: M3ViewV2, hash: Hex) {
  const itemBalanceP = row.contracts.itemLedger ? await balance(r, row, row.contracts.itemLedger, hash) : null;
  if (view.items) {
    const outstanding = view.items.fundedP - view.items.paidP - view.items.flushedP;
    if (outstanding < 0n || itemBalanceP === null || outstanding > itemBalanceP) throw new Error('item obligations are not backed');
  }
  let pile = null;
  if (row.spec.boxType === 5) {
    const vault = row.contracts.vault; const token = row.contracts.token; const coordinator = row.contracts.coordinator;
    if (!vault || !token || !coordinator || !view.pile) throw new Error('pile roles and history required');
    const [asset, seeder, seedAmount, supply, graduated, failed] = await Promise.all([
      read<Address>(r, hash, vault, pileVaultV2Abi, 'asset'), read<Address>(r, hash, vault, pileVaultV2Abi, 'seeder'),
      read<bigint>(r, hash, vault, pileVaultV2Abi, 'seedAmount'), read<bigint>(r, hash, token, boxTokenAbi, 'totalSupply'),
      read<boolean>(r, hash, coordinator, coordinatorV2Abi, 'graduated'), read<boolean>(r, hash, coordinator, coordinatorV2Abi, 'failed'),
    ]);
    const config = pileConfigV2(row.spec.contentsParams);
    if (!same(config.asset, asset) || config.seedAmount !== seedAmount || !same(seeder, row.creator)) throw new Error('pile reads disagree with immutable wiring');
    const leaveBehindBps = row.spec.contentsParams.length === 194 ? await read<bigint>(r, hash, vault, pileVaultV2Abi, 'leaveBehindBps') : 0n;
    if (config.leaveBehindBps !== leaveBehindBps) throw new Error('pile preset disagrees with immutable wiring');
    // At zero supply quoteRedeem(0) returns zero without reading custody; never label that as an empty pile.
    const liveBalance = supply > 0n ? await read<bigint>(r, hash, vault, pileVaultV2Abi, 'quoteRedeem', [supply]) : null;
    const seedReturnDue = failed && !view.pile.seedReturned ? view.pile.loadedAmount : 0n;
    pile = { asset, seeder, seedAmount, leaveBehindBps, balance: liveBalance, balanceStatus: liveBalance === null ? 'unavailable_zero_supply' as const : 'verified' as const,
      supply, graduated, failed, seedReceived: view.pile.seedLoaded, seedReturnDue,
      seedReturnBacked: liveBalance === null ? null : seedReturnDue <= liveBalance,
      redemptionOpen: graduated && !failed && view.pile.graduated && supply > 0n };
  }
  return { hash, itemBalanceP, pile };
}
export type M3MoneyV2 = Awaited<ReturnType<typeof readM3MoneyV2>>;

/** Read-only quote, not a transaction or a promise of payout. The caller still supplies its own T and minOut. */
export async function readPileQuoteV2(r: Reader, row: BoxRowV2, tIn: bigint, hash: Hex) {
  const coordinator = row.contracts.coordinator;
  if (row.spec.boxType !== 5 || !row.contracts.vault || !row.contracts.token || !coordinator || tIn <= 0n) throw new Error('invalid pile quote');
  const [supply, graduated, failed] = await Promise.all([
    read<bigint>(r, hash, row.contracts.token, boxTokenAbi, 'totalSupply'),
    read<boolean>(r, hash, coordinator, coordinatorV2Abi, 'graduated'), read<boolean>(r, hash, coordinator, coordinatorV2Abi, 'failed'),
  ]);
  if (tIn > supply) throw new Error('pile quote exceeds supply');
  const assetOut = graduated && !failed ? await read<bigint>(r, hash, row.contracts.vault, pileVaultV2Abi, 'quoteRedeem', [tIn]) : null;
  return { hash, ...pileConfigV2(row.spec.contentsParams), tIn, supply, assetOut, graduated, failed };
}
