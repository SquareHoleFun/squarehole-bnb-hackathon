import { inboxOrderIdV21, readInboxCoinsV21, readRoyaltyStateV21, type InboxCoinV21, type RoyaltyStateV21 } from './chain-v2';
import type { InboxRefreshV21, InboxSaleV21 } from './inbox-v21';
import { readShopFeeStateV21, type ShopFeeStateV21, readFeeModulesV21, type FeeModulesV21 } from './chain-v2';
import { readPayInTMoneyV21, type PayInTMoneyV21 } from './pay-in-t-reads-v21';
/** Reads use the EIP-1898 canonical block hash, never latest. Events remain the independent audit source. */
import { decodeSlot0, poolStateSlot } from '@squarehole/chain';
import { boxTokenAbi, poolManagerAbi } from '@squarehole/chain/abi';
import { decodeFunctionResult, encodeFunctionData, toHex, zeroAddress, type Abi, type Address, type Hex } from 'viem';
import type { AuditReads, AuditResult } from '../audit';
import type { CoreReader } from '../core-reader';
import { batchViews } from '../multicall';
import type { BoxRowV2 } from '../core-row';
import { readPileFeeStateV21, type PileFeeStateV21, readEatStateV21, type EatStateV21, coordinatorV2Abi, hookV2Abi, receiverV2Abi, royaltyRouterV2Abi } from './chain-v2';
import { readFailureQuoteV2 } from './claims-reads-v2';
import type { BoxViewV2, LiveStateV2 } from './views-v2';
import { readM3MoneyV2, type M3MoneyV2 } from './m3-reads-v2';
export { readM3MoneyV2, readItemClaimV2, readItemTicketV2, readPileQuoteV2 } from './m3-reads-v2';
import { readM2MoneyV2, type M2MoneyV2 } from './m2-reads-v2';
export { readM2MoneyV2, readHolderClaimV2, m2RpcReaderV2, type HolderClaimReaderV2 } from './m2-reads-v2';

const OWED = ['fitOwed', 'platformOwed', 'poolHeldP', 'growHeldP', 'creatorP', 'buyBackP', 'itemsHeldP', 'royaltyHeldP', 'tBurnPending'] as const;
export interface InboxMoneyCoinV21 extends InboxCoinV21 {
  readonly lastRefresh: InboxRefreshV21 | null;
  readonly lastSale: InboxSaleV21 | null;
  readonly inKindClaimed: bigint;
  /** Receiver intake includes gifts and sale proceeds; it does not establish a sale. */
  readonly funded: bigint;
  /** Native Flushed totals, separate from receiver intake to avoid double counting. */
  readonly flushed: bigint;
  readonly unwrapped: bigint;
}
export interface MoneyV2 {
  readonly shopFees?: ShopFeeStateV21;
  readonly modules?: FeeModulesV21;
  readonly payInT?: PayInTMoneyV21;
  readonly pileFees?: PileFeeStateV21;
  readonly eat?: EatStateV21;
  readonly m3?: M3MoneyV2;
  readonly m2?: M2MoneyV2;
  readonly block: bigint;
  readonly hash: Hex;
  readonly owed: Readonly<Record<typeof OWED[number], bigint>>;
  readonly safes: { readonly fit: Address; readonly platform: Address; };
  /**
   * `inboxP` (RC6-RR-INBOX): a failed box's inbox P at this hash (`pendingPriceCoin()`), which the next claim first
   * moves into the pot; a no-buyer box's claimState pot already counts it. Null for a live box, a box without an
   * inbox, or an inbox read the chain refused or could not answer (unknown, never 0).
   */
  readonly claim: { readonly pot: bigint; readonly tLeft: bigint; readonly creatorEntitlement: bigint; readonly inboxP: bigint | null };
  readonly royalty?: Omit<RoyaltyStateV21, 'coins'> & { readonly coins: readonly InboxMoneyCoinV21[] };
  readonly values: Readonly<Record<string, string>>;
}

export async function readMoneyV2(reader: Pick<CoreReader, 'callAt'>, row: BoxRowV2, view: BoxViewV2, block: bigint, hash: Hex): Promise<MoneyV2> {
  reader = batchViews(reader);
  const values: Record<string, string> = {};
  const call = async (part: string, to: Address, abi: Abi, fn: string, keys: readonly string[] = [fn], args: readonly unknown[] = []): Promise<void> => {
    const data = encodeFunctionData({ abi, functionName: fn, args });
    const result = decodeFunctionResult({ abi, functionName: fn, data: await reader.callAt(to, data, hash) });
    const items = keys.length === 1 ? [result] : result as readonly unknown[];
    keys.forEach((key, i) => { values[`${part}.${key}`] = typeof items[i] === 'boolean' ? (items[i] ? '1' : '0') : String(items[i]); });
  };
  const receiver = row.contracts.receiver as Address;
  const coordinator = row.contracts.coordinator as Address;
  const hook = row.contracts.hook as Address;
  const pool = async (): Promise<void> => {
    const slot = poolStateSlot(row.poolId);
    const read = async (key: Hex): Promise<Hex> => {
      const data = encodeFunctionData({ abi: poolManagerAbi, functionName: 'extsload', args: [key] });
      return decodeFunctionResult({ abi: poolManagerAbi, functionName: 'extsload', data: await reader.callAt(row.poolManager, data, hash) }) as Hex;
    };
    const [word, liquidity] = await Promise.all([read(slot), read(toHex(BigInt(slot) + 3n, { size: 32 }))]);
    const decoded = decodeSlot0(word);
    values['pool.sqrtPriceX96'] = String(decoded.sqrtPriceX96);
    values['pool.tick'] = String(decoded.tick);
    values['pool.liquidity'] = String(BigInt(liquidity) & ((1n << 128n) - 1n));
  };
  const amount = (key: string): bigint => BigInt(values[key] as string);
  const royaltyRouter = row.record.contracts[8] as Address | undefined;
  const required = async () => {
    await Promise.all([
      pool(),
      ...OWED.map((fn) => call('receiver', receiver, receiverV2Abi, fn)),
      ...['FIT_SAFE', 'PLATFORM_SAFE', 'buyersChoice', 'sellersChoice', 'graduationSettled', 'creatorPayee'].map((fn) => call('receiver', receiver, receiverV2Abi, fn)),
      call('receiver', receiver, receiverV2Abi, 'booked', ['bookedP'], [row.q]),
      call('receiver', receiver, receiverV2Abi, 'creatorOwed', ['creatorOwed', 'creatorHeld'], [row.q]),
      call('receiver', row.poolManager, poolManagerAbi, 'balanceOf', ['balanceP'], [receiver, BigInt(row.q)]),
      ...['closedAt', 'depthBudget', 'saleFeesPending', 'lastProtocolBlock', 'pairedLiquidity'].map((fn) => call('hook', hook, hookV2Abi, fn)),
      ...['failed', 'graduated'].map((fn) => call('coordinator', coordinator, coordinatorV2Abi, fn)),
      call('coordinator', coordinator, coordinatorV2Abi, 'claimState', ['pot', 'tLeft']),
      call('token', row.contracts.token as Address, boxTokenAbi, 'totalSupply'),
    ]);
    // RC5/RC6: custody cannot establish what the no-buyer remainder is now. Later inbox intake adds to it and
    // reopens the claim after a payment (INBOX af2), so keep this read always; the canonical quote decides.
    const creatorEntitlement = view.claim?.initialT === 0n
      ? (await readFailureQuoteV2(reader, coordinator, hash, 0n, amount('coordinator.pot'))) ?? 0n
      : 0n;
    values['coordinator.creatorEntitlement'] = String(creatorEntitlement);
    const inboxRole = row.record.contracts[8] as Address | undefined;
    // RC6-RR-INBOX: auxiliary, like the inbox's custody (RC6RR-FC-1): a refused or unanswered read is unknown and never
    // fails the money read.
    const inboxP = values['coordinator.failed'] === '1' && inboxRole && BigInt(inboxRole) !== 0n
      ? await reader.callAt(inboxRole, encodeFunctionData({ abi: royaltyRouterV2Abi, functionName: 'pendingPriceCoin' }), hash)
        .then((data) => decodeFunctionResult({ abi: royaltyRouterV2Abi, functionName: 'pendingPriceCoin', data }))
        .catch(() => null)
      : null;
    if (inboxP !== null) values['inbox.pendingP'] = String(inboxP);
    return { creatorEntitlement, inboxP };
  };
  // Each box contributes its independent views to the block's shared bounded queue. Only dependent
  // quotes, discovered custody assets and inbox coins wait for their inputs; no values survive this read.
  const [{ creatorEntitlement, inboxP }, shopFees, modules, pileFees, eat, payInT, m3, m2, custody] = await Promise.all([
    required(),
    view.choices.sellers === 'shop' ? readShopFeeStateV21(reader, receiver, row.record.contracts[3] as Address, hash) : undefined,
    Object.values(view.choices).includes('module') ? readFeeModulesV21(reader, receiver, hash) : undefined,
    Object.values(view.choices).includes('pile') ? readPileFeeStateV21(reader, receiver, hash) : undefined,
    Object.values(view.choices).includes('eat') ? readEatStateV21(reader, receiver, hash) : undefined,
    Object.values(view.choices).some(c => c === 'holders-t' || c === 'items-t')
      ? readPayInTMoneyV21(reader, row, hash) : undefined,
    view.m3 ? readM3MoneyV2(reader, row, view.m3, hash) : undefined,
    view.m2 ? readM2MoneyV2(reader, row, hash) : undefined,
    royaltyRouter && BigInt(royaltyRouter) !== 0n
      ? readRoyaltyStateV21(reader, royaltyRouter, receiver, row.q, row.contracts.token as Address, hash).catch(() => null)
      : null,
  ]);
  if (shopFees) for (const [key, value] of Object.entries(shopFees)) values[`shopFees.${key}`] = String(value);
  if (modules) for (const side of ['buyers', 'sellers'] as const) {
    values[`receiver.${side}Module`] = modules[side].module;
    values[`receiver.${side}ModuleHash`] = modules[side].codeHash;
    values[`receiver.${side}ModulePendingP`] = String(modules[side].pendingP);
  }
  if (pileFees) {
    values['receiver.pilePendingP'] = String(pileFees.pendingP);
    values['receiver.pileMovedP'] = String(pileFees.movedP);
  }
  if (eat) {
    values['receiver.eatPendingP'] = String(eat.pendingP);
    values['receiver.eatenP'] = String(eat.eatenP);
    values['receiver.priceBurnSelector'] = eat.burnSelector;
  }
  if (m3?.itemBalanceP !== null && m3?.itemBalanceP !== undefined) values['itemLedger.balanceP'] = String(m3.itemBalanceP);
  if (m2?.holderBalanceP !== null && m2?.holderBalanceP !== undefined) values['holderLedger.balanceP'] = String(m2.holderBalanceP);
  if (m2?.shop) for (const [key, value] of Object.entries(m2.shop)) values[`shop.${key}`] = String(value);
  // RC6 (F138): the inbox's balances, payee and frozen sellable list, all at this canonical hash. The inbox is auxiliary
  // and holds outside coins (RC6RR-FC-1): a coin whose balance cannot be read is left out and the publication says
  // complete: false; an unreadable list (or an older router without one) publishes no coins; if even the payee cannot
  // be read the box publishes no inbox. None of these fails the money read.
  let royalty: MoneyV2['royalty'];
  if (royaltyRouter && custody) {
    const known = [...new Set([...Object.keys(custody.balances), ...Object.keys(view.royaltyInKind), ...Object.keys(view.royaltyFunded), ...Object.keys(view.inbox?.sales ?? {})])] as Address[];
    const inbox = await readInboxCoinsV21(reader, royaltyRouter, hash, known).catch(() => ({ coins: [], complete: false }));
    royalty = { ...custody, ...inbox, complete: custody.complete !== false && inbox.complete, coins: inbox.coins.map(coin => {
      const key = coin.coin.toLowerCase();
      const id = row.inbox ? inboxOrderIdV21(row.inbox.handler, coin.coin) : undefined;
      return { ...coin, lastRefresh: id ? view.inbox?.refreshes[id] ?? null : null,
        lastSale: view.inbox?.sales[key] ?? null, inKindClaimed: view.royaltyInKind[key] ?? 0n,
        funded: view.royaltyFunded[key] ?? 0n, flushed: key === zeroAddress ? view.inbox?.flushed ?? 0n : 0n,
        unwrapped: key === zeroAddress ? view.inbox?.unwrapped ?? 0n : 0n };
    }) };
  }
  return {
    ...(shopFees ? { shopFees } : {}), ...(modules ? { modules } : {}), ...(pileFees ? { pileFees } : {}), ...(payInT ? { payInT } : {}), ...(eat ? { eat } : {}), ...(m3 ? { m3 } : {}), ...(m2 ? { m2 } : {}), block, hash, values,
    ...(royalty ? { royalty } : {}),
    owed: Object.fromEntries(OWED.map((fn) => [fn, amount(`receiver.${fn}`)])) as MoneyV2['owed'],
    safes: { fit: values['receiver.FIT_SAFE'] as Address, platform: values['receiver.PLATFORM_SAFE'] as Address },
    claim: { pot: amount('coordinator.pot'), tLeft: amount('coordinator.tLeft'), creatorEntitlement, inboxP },
  };
}

/**
 * RC6RR-FC-1: whether a money read failed because the chain refused a call at its canonical hash (an execution
 * revert, which every retry at that hash repeats), not because a node could not answer (CQ11-E retries those).
 */
export function refusedAtHash(error: unknown): boolean {
  for (let i = 0; i < 10 && error && typeof error === 'object'; ++i) {
    const e = error as { code?: unknown; name?: unknown; message?: unknown; details?: unknown; cause?: unknown };
    if (e.code === 3 || e.name === 'ExecutionRevertedError') return true;
    if ([e.message, e.details].some((text) => typeof text === 'string' && /execution reverted/i.test(text))) return true;
    error = e.cause;
  }
  return false;
}

/** No invented fee split: reconciliation and lazy graduation can move ledgers without a Collected event. */
export function compareMoneyV2(state: LiveStateV2, money: MoneyV2): AuditResult {
  const reads: AuditReads = { block: money.block, hash: money.hash, values: money.values };
  const expected: Record<string, string> = {
    'token.totalSupply': String(state.supply),
    'coordinator.failed': state.view.failed ? '1' : '0',
    'coordinator.graduated': state.view.graduated ? '1' : '0',
    'hook.closedAt': String(state.view.closedAt),
  };
  if (state.view.shopFees) {
    expected['shopFees.pendingP'] = String(state.view.shopFees.fundedP - state.view.shopFees.consumedP);
    expected['shopFees.feesT'] = String(state.view.shopFees.boughtT);
  }
  if (state.pool) {
    expected['pool.sqrtPriceX96'] = String(state.pool.sqrtPriceX96);
    expected['pool.tick'] = String(state.pool.tick);
  }
  if (state.view.position?.kind === 'full_range') expected['pool.liquidity'] = String(state.view.position.liquidity);
  if (state.view.failed) expected['pool.liquidity'] = '0';
  const choiceIds = { keep: 1, burn: 2, grow: 3, holders: 4, items: 5, eat: 6, 'holders-t': 7, 'items-t': 8, pile: 9, module: 10, shop: 11 };
  for (const side of ['buyers', 'sellers'] as const) {
    const choice = state.view.choices[side];
    if (choice) expected[`receiver.${side}Choice`] = String(choiceIds[choice]);
  }
  if (state.view.claim) expected['coordinator.tLeft'] = String(state.view.claim.tLeft);
  expected['receiver.tBurnPending'] = String(state.view.buyBack.tBought - state.view.buyBack.tBurned);
  // Detect corrupted cached financial reads at the same block; a later block may have silent P donations.
  if (state.money?.hash === money.hash) for (const [key, value] of Object.entries(state.money.values)) expected[key] ??= value;
  if (money.pileFees) expected['receiver.pileMovedP'] = String(state.view.pileMovedP ?? 0n);
  if (money.eat) expected['receiver.eatenP'] = String(state.view.eatenP ?? 0n);
  const mismatches = Object.entries(expected).filter(([k, v]) => reads.values[k] !== v).map(([k, v]) => `${k}: ${v} ≠ ${reads.values[k]}`);
  const booked = BigInt(reads.values['receiver.bookedP'] as string);
  const balance = BigInt(reads.values['receiver.balanceP'] as string);
  // The sellers pending slot holds a module side's P (10) or ShopT's waiting P (11); both reads name it, count it once.
  const sellersPendingP = money.shopFees ? money.shopFees.pendingP : (money.modules?.sellers.pendingP ?? 0n);
  const ledgers = (money.modules?.buyers.pendingP ?? 0n) + sellersPendingP + (money.pileFees?.pendingP ?? 0n) + (money.payInT?.pendingP ?? 0n) + (money.eat?.pendingP ?? 0n) + OWED.filter((fn) => fn !== 'tBurnPending').reduce((sum, fn) => sum + money.owed[fn], 0n);
  if (booked > balance) mismatches.push('receiver.bookedP exceeds its P claims');
  if (booked < ledgers || booked - ledgers > 28n) mismatches.push('receiver ledgers and two carries do not reconcile to bookedP');
  if (state.view.m2 && money.m2?.holderBalanceP !== null && money.m2?.holderBalanceP !== undefined) {
    const owed = Object.values(state.view.m2.batches).reduce((sum, b) => sum + (b.fundingP ?? 0n) - b.paidP - b.flushedP, 0n);
    if (owed > money.m2.holderBalanceP) mismatches.push('holder batch obligations exceed ledger P claims');
  }
  if (money.m3?.pile && state.view.m3?.pile) {
    const history = state.view.m3.pile;
    const accounted = history.loadedAmount + (state.view.pileMovedP ?? 0n) - history.redeemedAsset - history.returnedAmount;
    const balance = money.m3.pile.balance;
    // Donations have no protocol receipt; their redemption can exceed the recorded inflows.
    // Recorded receipts therefore prove a custody lower bound, not an exact live balance.
    if (balance !== null && accounted > balance) mismatches.push('pile seed and moved fees exceed remaining custody after redemptions');
  }
  const items = state.view.m3?.items;
  if (items) {
    if (items.choiceP !== items.fundedP + items.retainedBurnP + (items.depthP ?? 0n)) mismatches.push('item P allocation does not conserve ledger, burn and depth shares');
    if (money.m3?.itemBalanceP != null && items.fundedP - items.paidP - items.flushedP > money.m3.itemBalanceP) mismatches.push('item P obligations exceed P claims');
  }
  if (money.payInT && state.view.payInT) {
    const v = state.view.payInT, m = money.payInT;
    if (v.holdersFundedT - v.holdersPaidT - v.holderResidueT > m.holderBalanceT) mismatches.push('holder T obligations exceed T claims');
    if (v.itemsFundedT - v.itemsPaidT - v.itemResidueT > m.itemBalanceT) mismatches.push('item T obligations exceed T claims');
    if (v.insideBurnT - v.burnedT !== m.burnPendingT || m.burnPendingT > m.receiverBalanceT) mismatches.push('inside-item T burn debt differs from funded claims');
    for (const [side, d] of Object.entries(v.itemsDepth ?? {})) {
      if (d.choiceP !== d.depthP + d.queuedP || d.queuedP < d.spentP + d.tipsP) mismatches.push(`item Depth P conservation fails on side ${side}`);
      if (!state.view.failed && d.queuedP - d.spentP - d.tipsP !== (side === '1' ? m.buyersItemsP : m.sellersItemsP)) mismatches.push(`item Depth pending P differs on side ${side}`);
    }
  }
  return { block: money.block, hash: money.hash, ok: mismatches.length === 0, mismatches, reads };
}
