import { transactionTradersV2 } from './traders-v2';
import { alchemistGrowthV21, type AlchemistGrowthV21 } from './alchemist-v21';
import { projectShopFeesV21, type ShopFeeProjectionV21 } from "./shop-fees-v21";
import { priceEventsV21, payInTViewV21, type PayInTViewV21 } from './pay-in-t-v21';
/** CQ11-E: canonical event history, with current money views supplied by block-pinned reads. */
import { formatUnits } from '@squarehole/domain';
import { getAddress, type Address, type Hex } from 'viem';
import type { LogRef } from '../../events';
import type { MoneyV2 } from './money-v2';
import type { CoreEventV2 } from './events-v2';
import { enumName, type BoxRecordV2, type BoxSpecV2, type SideV2 } from './chain-v2';
import { m3ViewV2, type M3ViewV2 } from './m3-views-v2';
import { hasCollectionVaultV2, vaultInventoryV2, type VaultInventoryV2 } from './vault-inventory-v2';
import { m2ViewV2, type M2ViewV2 } from './m2-views-v2';
import { rewardClaimPaymentsV21 } from './pay-in-t-claims-v21';
import { type ClaimPaymentV2 } from './claims-events-v2';
import { inboxHistoryV21, type InboxHistoryV21 } from './inbox-v21';
import { statisticsAfterTrades, statisticsViewV2, type StatisticsStateV2 } from './statistics-v2';
import { protocolActivityV2, type ProtocolActivityV2 } from './protocol-stats-v2';

const lower = (a: unknown): string => String(a).toLowerCase();
const ZERO = /^0x0{40}$/i;
export type FeeChoiceV2 = 'keep' | 'burn' | 'grow' | 'holders' | 'items' | 'eat' | 'holders-t' | 'items-t' | 'pile' | 'module' | 'shop';
/** The wire remains a recipe; CQ11 permits exactly one destination per side. */
export function feeChoiceV2(side: SideV2): FeeChoiceV2 | null {
  if (side.split !== 1 || side.splitParams !== '0x' || side.b.leg !== 0 || side.b.dest !== 0 || side.b.legParams !== '0x' || side.b.destParams !== '0x') return null;
  const { leg, dest, legParams, destParams } = side.a;
  if (legParams !== '0x') return null;
  if (leg === 2 && dest === 1 && destParams === '0x') return 'burn';
  if (leg === 2 && dest === 6 && /^0x0{63}2$/i.test(destParams)) return 'holders-t';
  if (leg === 2 && dest === 8 && /^0x0{63}[123]$/i.test(destParams)) return 'items-t';
  if (leg === 2 && dest === 7 && /^0x0{63}[248]$/i.test(destParams)) return 'shop';
  if (leg !== 1) return null;
  if (dest === 9 && /^0x0{56}[0-9a-f]{8}$/i.test(destParams)) return 'module';
  if (destParams === '0x') return ({ 1: 'eat', 2: 'keep', 4: 'grow', 7: 'pile' } as const)[dest as 1 | 2 | 4 | 7] ?? null;
  if (dest === 8 && /^0x0{63}[123]$/i.test(destParams)) return 'items';
  // Holders(P) carries the frozen denomination byte (1), ABI encoded.
  return dest === 6 && /^0x0{63}1$/i.test(destParams) ? 'holders' : null;
}

/** Raw P per whole T, with 18 extra decimal places. Never uses a floating point price. */
export function closingPricePerTX18(pot: bigint, tLeft: bigint, tDecimals = 18): bigint {
  return tLeft > 0n ? pot * 10n ** BigInt(tDecimals + 18) / tLeft : 0n;
}
export interface CreatorTOutV2 { readonly from: Address; readonly to: Address; readonly amount: bigint; readonly ref: LogRef }
export type CreatorNamedByV2 = 'creator' | 'creatorFeeRecipient' | 'CreatorPayeeChanged' | 'CreatorClaimed';
export interface CreatorAddressV2 { readonly address: Address; readonly namedBy: CreatorNamedByV2; readonly ref: LogRef | null }
export interface CreatorClaimV2 { readonly payee: Address; readonly token: Address; readonly to: Address; readonly amount: bigint; readonly ref: LogRef }
export interface SafePaymentV2 { readonly kind: 'fit' | 'platform'; readonly safe: Address; readonly token: Address; readonly amount: bigint; readonly ref: LogRef }
export interface ClaimV2 {
  readonly initialPot: bigint; readonly initialT: bigint; readonly pot: bigint; readonly tLeft: bigint;
  readonly tip: bigint; readonly closer: Address; readonly claimedP: bigint; readonly claimedT: bigint;
  readonly creatorClaimed: boolean;
}
export interface BoxViewV2 {
  readonly inbox?: InboxHistoryV21;
  /** Conversion receipt totals: input in P, output in the pile asset; excludes seeds and same-P fees. */
  readonly alchemist?: AlchemistGrowthV21;
  readonly shopFees?: ShopFeeProjectionV21;
  readonly payInT?: PayInTViewV21;
  /** Cumulative successful P burns and permanent locks; absent in older persisted snapshots. */
  readonly pileMovedP?: bigint;
  readonly eatenP?: bigint;
  readonly m3?: M3ViewV2;
  readonly vaultItems?: VaultInventoryV2;
  readonly m2?: M2ViewV2;
  readonly boxId: bigint;
  readonly gate: { readonly open: boolean; readonly effectiveOpenAt: bigint | null; readonly deadline: bigint | null; readonly chunks: Readonly<Record<'Table' | 'Texts', { readonly loaded: number; readonly done: boolean }>> };
  readonly failed: { readonly cause: string; readonly caller: Address; readonly at: bigint } | null;
  readonly graduated: boolean;
  readonly closedAt: bigint;
  readonly choices: { readonly buyers: FeeChoiceV2 | null; readonly sellers: FeeChoiceV2 | null };
  readonly position: { readonly kind: 'curve' | 'full_range'; readonly tickLower: number; readonly tickUpper: number; readonly liquidity: bigint; readonly salt: bigint } | null;
  readonly fees: { readonly buyersP: bigint; readonly sellersP: bigint; readonly qToReserve: bigint; readonly tipsP: bigint };
  readonly safePaid: Readonly<Record<SafePaymentV2['kind'], Readonly<Record<string, bigint>>>>;
  readonly safePayments: readonly SafePaymentV2[];
  readonly royaltyInKind: Readonly<Record<string, bigint>>;
  readonly royaltyFunded: Readonly<Record<string, bigint>>;
  readonly buyBack: { readonly pSpent: bigint; readonly tBought: bigint; readonly tBurned: bigint; readonly tipsP: bigint };
  readonly claim: ClaimV2 | null;
  readonly creatorAddresses: readonly CreatorAddressV2[];
  readonly creatorTOut: readonly CreatorTOutV2[];
  readonly creatorClaims: readonly CreatorClaimV2[];
  readonly releasedToCreator: readonly bigint[];
}
export interface BoxViewContextV2 {
  readonly feeModules?: readonly { readonly module: Address; readonly codeHash: Hex }[];
  readonly spec?: BoxSpecV2;
  readonly boxId: bigint; readonly creator: Address; readonly creatorFeeRecipient: Address | null;
  readonly pile?: Address;
  readonly vault?: Address;
  readonly collection?: Address;
  readonly hook?: Address;
  /** Destination of failed launch-router sweeps; absent context cannot attribute those receipts. */
  readonly coordinator?: Address;
  readonly p: Address; readonly pDecimals: number; readonly receiver: Address;
  readonly choices: BoxViewV2['choices']; readonly notCreator: readonly Address[];
}
export function boxViewContextV2(record: BoxRecordV2, spec: BoxSpecV2, pDecimals: number): BoxViewContextV2 {
  const notCreator = [...record.contracts, record.poolManager].filter((a) => !ZERO.test(a)).map((a) => getAddress(a));
  return { spec, vault: record.contracts[3] as Address, collection: record.contracts[4] as Address, coordinator: record.contracts[0] as Address, hook: record.contracts[2] as Address, pile: spec.boxType === 5 ? record.contracts[3] as Address : undefined, boxId: record.boxId, creator: getAddress(record.creator), creatorFeeRecipient: ZERO.test(spec.creatorFeeRecipient) ? null : getAddress(spec.creatorFeeRecipient), p: record.q, pDecimals, receiver: record.contracts[5] as Address, choices: { buyers: feeChoiceV2(spec.buyers), sellers: feeChoiceV2(spec.sellers) }, notCreator };
}
const add = (into: Readonly<Record<string, bigint>>, key: string, amount: bigint): Record<string, bigint> => ({ ...into, [key]: (into[key] ?? 0n) + amount });

/** Event deltas carry history; reads carry silent deposits, reconciliation, and current owed amounts. */
export function boxViewV2(events: readonly CoreEventV2[], ctx: BoxViewContextV2, previous?: BoxViewV2, timestamp = 0n): BoxViewV2 {
  let gate = previous?.gate ?? { open: false, effectiveOpenAt: null, deadline: null, chunks: { Table: { loaded: 0, done: false }, Texts: { loaded: 0, done: false } } };
  let failed = previous?.failed ?? null;
  let graduated = previous?.graduated ?? false;
  let closedAt = previous?.closedAt ?? 0n;
  let position = previous?.position ?? null;
  let fees = previous?.fees ?? { buyersP: 0n, sellersP: 0n, qToReserve: 0n, tipsP: 0n };
  let safePaid = previous?.safePaid ?? { fit: {}, platform: {} };
  let safePayments = previous?.safePayments ?? [];
  let royaltyInKind = previous?.royaltyInKind ?? {};
  let royaltyFunded = previous?.royaltyFunded ?? {};
  let pileMovedP = previous?.pileMovedP ?? 0n;
  let eatenP = previous?.eatenP ?? 0n;
  let buyBack = previous?.buyBack ?? { pSpent: 0n, tBought: 0n, tBurned: 0n, tipsP: 0n };
  let claim = previous?.claim ?? null;
  let creatorAddresses = previous?.creatorAddresses ?? [];
  let creatorTOut = previous?.creatorTOut ?? [];
  let creatorClaims = previous?.creatorClaims ?? [];
  let releasedToCreator = previous?.releasedToCreator ?? [];
  const known = new Set(ctx.notCreator.map(lower));
  const watch = (address: unknown, namedBy: CreatorNamedByV2, ref: LogRef | null): void => {
    if (typeof address !== 'string' || ZERO.test(address) || known.has(lower(address)) || creatorAddresses.some((c) => lower(c.address) === lower(address))) return;
    creatorAddresses = [...creatorAddresses, { address: getAddress(address), namedBy, ref }];
  };
  watch(ctx.creator, 'creator', null); watch(ctx.creatorFeeRecipient, 'creatorFeeRecipient', null);
  for (const e of events) {
    if (e.boxId !== ctx.boxId) continue;
    const a = e.args; const key = `${e.source}.${e.name}`;
    if (key === 'coordinator.ChunkLoaded') {
      const part = enumName('ChunkPart', a.part as number);
      if (part === 'Table' || part === 'Texts') gate = { ...gate, chunks: { ...gate.chunks, [part]: { loaded: gate.chunks[part].loaded + 1, done: gate.chunks[part].done || a.partDone === true } } };
    } else if (key === 'coordinator.BoxOpenSet') gate = { ...gate, open: true, effectiveOpenAt: a.effectiveOpenAt as bigint, deadline: a.deadline as bigint };
    else if (key === 'coordinator.BoxFailed') failed = { cause: enumName('FailCause', a.cause as number), caller: getAddress(a.caller as string), at: a.timestamp as bigint };
    else if (key === 'hook.CurveClosed' && closedAt === 0n) closedAt = timestamp;
    else if (key === 'coordinator.Graduated') graduated = true;
    else if (key === 'hook.PoolLaunched') position = { kind: 'curve', tickLower: a.tickLower as number, tickUpper: a.tickUpper as number, liquidity: a.liquidity as bigint, salt: 0n };
    else if (key === 'hook.MigratedV2') {
      graduated = true;
      position = { kind: 'full_range', tickLower: -887220, tickUpper: 887220, liquidity: a.liquidity as bigint, salt: 3n };
    } else if (key === 'hook.Deepened' && position) position = { ...position, liquidity: position.liquidity + (a.liquidity as bigint) };
    else if (key === 'hook.Closed') position = null;
    else if (key === 'receiver.Collected') {
      fees = { buyersP: fees.buyersP + (a.buyersP as bigint), sellersP: fees.sellersP + (a.sellersP as bigint), qToReserve: fees.qToReserve + (a.qToReserve as bigint), tipsP: fees.tipsP + (a.tip as bigint) };
      // PotFixed already includes earlier receipts, including those in its own transaction.
      if (claim && lower(e.address) === lower(ctx.receiver)) claim = { ...claim, pot: claim.pot + (a.buyersP as bigint) };
    } else if (key === 'receiver.FitPaid' || key === 'receiver.PlatformPaid') {
      const kind = e.name === 'FitPaid' ? 'fit' : 'platform';
      const token = ctx.p;
      const amount = a.amount as bigint;
      safePaid = { ...safePaid, [kind]: add(safePaid[kind], lower(token), amount) };
      safePayments = [...safePayments, { kind, token, safe: getAddress(a.safe as string), amount, ref: e.ref }];
    } else if (key === 'royaltyRouter.InKindClaimed') {
      royaltyInKind = add(royaltyInKind, lower(a.token), a.amount as bigint);
    } else if (key === 'receiver.RoyaltyFunded') {
      royaltyFunded = add(royaltyFunded, lower(a.token), a.amount as bigint);
      if (claim && lower(e.address) === lower(ctx.receiver) && lower(a.token) === lower(ctx.p)) claim = { ...claim, pot: claim.pot + (a.amount as bigint) };
    } else if (key === 'receiver.PileFeesMoved') {
      if (!ctx.pile || lower(e.address) !== lower(ctx.receiver) || lower(a.asset) !== lower(ctx.p) || lower(a.pile) !== lower(ctx.pile)) continue;
      if (typeof a.amount !== 'bigint' || a.amount <= 0n || typeof a.total !== 'bigint' || a.total !== pileMovedP + a.amount) throw new Error('invalid cumulative pile fee event');
      pileMovedP = a.total;
    } else if (key === 'receiver.PriceCoinEaten') {
      // Authenticate the fixed receiver and its price coin even for callers supplying decoded events.
      if (lower(e.address) !== lower(ctx.receiver) || lower(a.asset) !== lower(ctx.p)) continue;
      const amount = a.amount as bigint;
      const total = a.total as bigint;
      if (typeof amount !== 'bigint' || amount <= 0n || typeof total !== 'bigint' || total !== eatenP + amount
        || typeof a.burned !== 'boolean') throw new Error('invalid cumulative price-coin eating event');
      eatenP = total;
    } else if (key === 'receiver.BoughtBack') {
      // T burns are counted at Transfer only: BoughtBack includes previously pending T, and retries have no event.
      buyBack = { ...buyBack, pSpent: buyBack.pSpent + (a.pSpent as bigint), tBought: buyBack.tBought + (a.tBought as bigint), tipsP: buyBack.tipsP + (a.tip as bigint) };
    } else if (key === 'receiver.RewardTBurned' && lower(e.address) === lower(ctx.receiver)) {
      buyBack = { ...buyBack, tBurned: buyBack.tBurned - (a.amountT as bigint) };
    } else if (key === 'coordinator.PotFixed') claim = { initialPot: a.pot as bigint, initialT: a.tLeft as bigint, pot: a.pot as bigint, tLeft: a.tLeft as bigint, tip: a.tip as bigint, closer: getAddress(a.closer as string), claimedP: 0n, claimedT: 0n, creatorClaimed: false };
    else if (key === 'launchRouter.Swept' && claim && ctx.coordinator && lower(a.to) === lower(ctx.coordinator)) claim = { ...claim, pot: claim.pot + (a.amount as bigint) };
    else if (key === 'coordinator.Claimed' && claim) claim = { ...claim, pot: claim.pot - (a.p as bigint), tLeft: claim.tLeft - (a.t as bigint), claimedP: claim.claimedP + (a.p as bigint), claimedT: claim.claimedT + (a.t as bigint), creatorClaimed: claim.creatorClaimed || a.t === 0n };
    else if (key === 'receiver.CreatorPayeeChanged') watch(a.payee, 'CreatorPayeeChanged', e.ref);
    else if (key === 'receiver.CreatorClaimed') {
      creatorClaims = [...creatorClaims, { payee: getAddress(a.payee as string), token: getAddress(a.token as string), to: getAddress(a.to as string), amount: a.amount as bigint, ref: e.ref }];
      watch(a.to, 'CreatorClaimed', e.ref);
    } else if (key === 'token.Transfer') {
      if (lower(a.from) === lower(ctx.receiver) && ZERO.test(String(a.to))) buyBack = { ...buyBack, tBurned: buyBack.tBurned + (a.amount as bigint) };
      const from = creatorAddresses.find((c) => lower(c.address) === lower(a.from));
      if (from) creatorTOut = [...creatorTOut, { from: from.address, to: getAddress(a.to as string), amount: a.amount as bigint, ref: e.ref }];
    } else if (key === 'vault.ReleasedToCreator') releasedToCreator = [...releasedToCreator, ...(a.ids as readonly bigint[])];
  }
  const shopFees = ctx.choices.sellers === 'shop' ? projectShopFeesV21(events, ctx.boxId, ctx.receiver, previous?.shopFees) : undefined;
  const prices = ctx.spec ? priceEventsV21(shopFees?.events ?? events, ctx.spec) : events;
  const hasT = Object.values(ctx.choices).some(c => c === 'holders-t' || c === 'items-t');
  const payInT = hasT ? payInTViewV21(events, ctx.boxId, ctx.receiver, ctx.spec, previous?.payInT) : undefined;
  const m2 = ctx.spec && (ctx.spec.boxType === 4 || Object.values(ctx.choices).some(c => c === 'holders' || c === 'holders-t')) ? m2ViewV2(prices, ctx.boxId, ctx.spec, previous?.m2) : undefined;
  const m3 = ctx.spec && (ctx.spec.boxType === 5 || Object.values(ctx.choices).some(c => c === 'items' || c === 'items-t')) ? m3ViewV2(prices, ctx.boxId, ctx.spec, ctx.creator, previous?.m3) : undefined;
  const vaultItems = ctx.spec && hasCollectionVaultV2(ctx.spec, ctx.vault, ctx.collection) ? vaultInventoryV2(events, ctx.boxId, ctx.spec, previous?.vaultItems) : undefined;
  const alchemist = alchemistGrowthV21(events, ctx, previous?.alchemist);
  const inbox = inboxHistoryV21(events, ctx.boxId, timestamp, previous?.inbox);
  return { inbox, ...(alchemist ? { alchemist } : {}), ...(shopFees ? { shopFees: shopFees.state } : {}), ...(payInT ? { payInT } : {}), ...(m3 ? { m3 } : {}), ...(vaultItems ? { vaultItems } : {}), ...(m2 ? { m2 } : {}), boxId: ctx.boxId, gate, failed, graduated, closedAt, choices: ctx.choices, position, fees, safePaid, safePayments, royaltyInKind, royaltyFunded, buyBack, eatenP, pileMovedP, claim, creatorAddresses, creatorTOut, creatorClaims, releasedToCreator };
}

/** Direct receipts grouped by asset. Cap policy and conversion proceeds belong to the bot journal. */
export function platformBookV2(views: readonly BoxViewV2[]) {
  let paidByToken: Readonly<Record<string, bigint>> = {};
  for (const view of views) for (const [token, amount] of Object.entries(view.safePaid.platform)) paidByToken = add(paidByToken, token, amount);
  return { paidByToken };
}

// Live block projection. Only snapshots and recent detail are retained; complete events go to HistoryWriter.
import type { BlockHeader } from '../../model';
import type { CoreActivity, CoreTrade, CoreTransfer, TradeRoute } from '../derive-core';
import type { BoxRowV2 } from '../core-row';


export interface LiveStateV2 {
  /** Internal lifetime counters; published only by /v2/stats, never by the feed or box view. */
  readonly protocolActivity?: ProtocolActivityV2;
  readonly statistics?: StatisticsStateV2;
  readonly claimPayments?: readonly ClaimPaymentV2[];
  readonly block: bigint;
  readonly hash?: Hex;
  readonly money?: MoneyV2;
  readonly pool: { readonly sqrtPriceX96: bigint; readonly tick: number } | null;
  readonly p: Address;
  readonly pDecimals: number;
  readonly view: BoxViewV2;
  readonly supply: bigint;
  readonly balances: ReadonlyMap<string, bigint>;
  readonly volumeQ: bigint;
  readonly volumeT: bigint;
}
export function liveViewV2(state: LiveStateV2, now: bigint) {
  const eventClaim = state.view.claim;
  const claim = eventClaim && state.money ? { ...eventClaim, ...state.money.claim } : eventClaim;
  const price = claim ? closingPricePerTX18(claim.pot, claim.tLeft) : null;
  // INBOX af2: the no-buyer remainder grows with later inbox intake, so only the canonical quote states it; without a
  // money read it is unavailable (null), never the initial pot and never exhausted by an earlier payment.
  const creatorEntitlement = state.money ? state.money.claim.creatorEntitlement : null;
  // RC6-RR-INBOX: the inbox P a claim first moves in, read at the money hash; unknown (null) without that read.
  const inboxP = state.money ? state.money.claim.inboxP : null;
  return { ...state.view, statistics: statisticsViewV2(state, now), claim, money: state.money ?? null, pool: state.pool, supply: state.supply, volumeQ: state.volumeQ, volumeT: state.volumeT,
    closing: claim ? { token: state.p, pot: claim.pot, initialT: claim.initialT, tLeft: claim.tLeft, creatorEntitlement, inboxP,
      pricePerTX18: price, pricePerTDisplay: formatUnits(price ?? 0n, state.pDecimals + 18) } : null,
    hatch: { eligibleAt: state.view.closedAt > 0n ? state.view.closedAt + 604800n : null, eligible: state.view.closedAt > 0n && now >= state.view.closedAt + 604800n && !state.view.graduated && !state.view.failed },
  };
}


export function applyV2Block(previous: LiveStateV2 | undefined, header: BlockHeader, events: readonly CoreEventV2[], row: BoxRowV2) {
  if (previous && previous.block >= header.number) {
    if (previous.block === header.number && previous.hash === header.hash) return { state: previous, trades: [], activity: [], transfers: [] };
    throw new Error('v2 replay must rewind to the canonical parent before replacing a block');
  }
  const seen = new Set<number>();
  events = [...events].sort((a, b) => a.ref.logIndex - b.ref.logIndex).filter(e => {
    if (e.ref.blockNumber !== header.number || e.ref.blockHash.toLowerCase() !== header.hash.toLowerCase()) throw new Error('v2 event block/hash mismatch');
    if (seen.has(e.ref.logIndex)) return false;
    seen.add(e.ref.logIndex); return true;
  });
  const ctx = { ...boxViewContextV2(row.record, row.spec, row.pDecimals), feeModules: row.feeModules };
  const release = row.release;
  const known = [release.factory.address, release.registry.address, release.listingRegistry.address, ...Object.values(release.safes).map(s => s.address)];
  const projected = boxViewV2(events, { ...ctx, notCreator: [...ctx.notCreator, ...known] }, previous?.view, header.timestamp);
  // These are recent details. The history activity rows carry every item since creation.
  const view = { ...projected, creatorTOut: projected.creatorTOut.slice(-500), creatorClaims: projected.creatorClaims.slice(-500), releasedToCreator: projected.releasedToCreator.slice(-500), safePayments: projected.safePayments.slice(-500) };
  let supply = previous?.supply ?? 0n;
  let pool = previous?.pool ?? null;
  let volumeQ = previous?.volumeQ ?? 0n;
  let volumeT = previous?.volumeT ?? 0n;
  let burnedT = previous?.statistics?.burnedT ?? 0n;
  let holderCount = previous?.statistics?.holderCount ?? 0n;
  const balances = new Map(previous?.balances);
  const changeBalance = (address: string, delta: bigint): void => {
    const before = balances.get(address) ?? 0n;
    const after = before + delta;
    if (before > 0n && after <= 0n) holderCount -= 1n;
    if (before <= 0n && after > 0n) holderCount += 1n;
    balances.set(address, after);
  };
  const activity: CoreActivity[] = [];
  const transfers: CoreTransfer[] = [];
  const trades: CoreTrade[] = [];
  const traders = transactionTradersV2(events
    .filter(e => e.boxId === row.boxId && e.source === 'token' && e.name === 'Transfer')
    .map(e => ({ txHash: e.ref.txHash, from: String(e.args.from), to: String(e.args.to), amount: e.args.amount as bigint })),
  [...row.record.contracts, row.record.poolManager]);
  const taxedBuys = events.filter((e) => e.boxId === row.boxId && e.source === 'launchRouter' && e.name === 'TaxedBuy');
  const usedTaxes = new Set<CoreEventV2>();
  const saleFees = new Map<CoreEventV2, bigint>();
  // PoolManager emits Swap before the afterSwap hook emits SaleFee. Pair by transaction and closest swap.
  let priorSwap: CoreEventV2 | undefined;
  for (const e of events) {
    if (e.boxId !== row.boxId) continue;
    if (e.source === 'poolManager' && e.name === 'Swap') priorSwap = e;
    if (e.source === 'hook' && e.name === 'SaleFee' && priorSwap && priorSwap.ref.txHash === e.ref.txHash && (priorSwap.args.amount0 as bigint) > 0n) {
      saleFees.set(priorSwap, (saleFees.get(priorSwap) ?? 0n) + (e.args.fee as bigint));
      priorSwap = undefined;
    }
  }
  for (const e of events) {
    if (e.boxId !== row.boxId) continue;
    const a = e.args;
    const ref = { id: `${header.number}-${e.ref.logIndex}`, block: header.number, blockHash: header.hash, txHash: e.ref.txHash, logIndex: e.ref.logIndex };
    const data: Record<string, string | number | boolean> = { source: e.source, event: e.name, emitter: e.address.toLowerCase() };
    if (e.listingId !== null) data.listingId = e.listingId;
    for (const [name, value] of Object.entries(a)) {
      // The row's own labels win: an argument named source, event or emitter (the receiver's ItemFunded has a `source`)
      // is kept as arg_<name>, never over the label the page reads.
      const key = name === 'source' || name === 'event' || name === 'emitter' ? `arg_${name}` : name;
      if (typeof value === 'bigint') data[key] = value.toString();
      else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') data[key] = value;
      else data[key] = JSON.stringify(value, (_, v: unknown) => typeof v === 'bigint' ? v.toString() : v);
    }
    // Mixed history pages use (block, logIndex): a swap's structured trade owns that cursor.
    // A zero-amount swap has no trade, so retain its raw activity item.
    const isTrade = e.source === 'poolManager' && e.name === 'Swap' && (a.amount0 !== 0n || a.amount1 !== 0n);
    if (!isTrade) activity.push({ ...ref, timestamp: header.timestamp, kind: 'v2_event', data });
    if (e.name === 'Transfer' && (e.source === 'token' || e.source === 'collection' || e.source === 'tickets')) {
      const asset = e.source === 'token' ? 'T' : e.source === 'collection' ? 'item' : 'ticket';
      const amount = BigInt((a.amount ?? a.tokenId ?? a.id) as bigint);
      const from = lower(a.from); const to = lower(a.to);
      transfers.push({ ...ref, asset, from, to, amount: asset === 'T' ? amount : 1n, tokenId: asset === 'T' ? null : amount });
      if (asset === 'T') {
        if (ZERO.test(from)) supply += amount;
        else changeBalance(from, -amount);
        if (ZERO.test(to)) { supply -= amount; burnedT += amount; }
        else changeBalance(to, amount);
      }
    }
    if (e.source === 'collection' && e.name === 'ConsecutiveTransfer') {
      const first = a.fromTokenId as bigint; const last = a.toTokenId as bigint;
      if (last < first || last - first + 1n > BigInt(row.spec.n)) throw new Error('v2 collection mint exceeds the spec');
      for (let id = first; id <= last; id++) transfers.push({ ...ref, id: `${ref.id}-${id}`, asset: 'item', from: lower(a.fromAddress), to: lower(a.toAddress), amount: 1n, tokenId: id });
    }
    if (e.source === 'poolManager' && (e.name === 'Initialize' || e.name === 'Swap')) pool = { sqrtPriceX96: a.sqrtPriceX96 as bigint, tick: a.tick as number };
    if (isTrade) {
      const token = row.contracts.token;
      if (!token) throw new Error('v2 row has no token');
      const qDelta = a.amount0 as bigint;
      const tDelta = a.amount1 as bigint;
      const buy = qDelta < 0n;
      // Older hooks took sale fees in P (SaleFee); the RC6 plain hook (F137) takes 1% of the T put in, so a sale with
      // no SaleFee reports its nominal T fee from Swap.fee and no P surcharge.
      const saleFee = saleFees.get(e);
      const qRaw = qDelta < 0n ? -qDelta : qDelta - (saleFee ?? 0n);
      if (qRaw < 0n) throw new Error('sale fee exceeds P output'); const tRaw = tDelta < 0n ? -tDelta : tDelta;
      const sender = lower(a.sender);
      const route: TradeRoute = sender === lower(row.contracts.hook) ? 'hook' : sender === lower(row.contracts.executor) ? 'executor' : sender === lower(row.contracts.receiver) ? 'buy_back' : sender === lower(row.contracts.launchRouter) ? 'launch_router' : 'other';
      const taxed = route === 'launch_router' ? taxedBuys.find((t) => t.ref.txHash === e.ref.txHash && !usedTaxes.has(t)) : undefined;
      if (taxed) usedTaxes.add(taxed);
      const trader = taxed ? lower(taxed.args.buyer) as Address : traders.get(lower(e.ref.txHash))?.[buy ? 'buy' : 'sell'] ?? null;
      const routed = route === 'hook' || route === 'executor' || route === 'buy_back';
      if (!routed) { volumeQ += qRaw; volumeT += tRaw; }
      // Buys expose the nominal Swap.fee rate on gross P, plain sales on gross T (tick-by-tick LP rounding is not
      // logged); older sales use the actual hook delta. Authoritative collected fees remain separate from this estimate.
      trades.push({ ...ref, timestamp: header.timestamp, side: buy ? 'buy' : 'sell', route, qRaw, tRaw, feeQ: buy ? (qRaw * BigInt(a.fee as number) + 999999n) / 1000000n : saleFee ?? 0n, feeT: buy || saleFee !== undefined ? 0n : (tRaw * BigInt(a.fee as number) + 999999n) / 1000000n, taxQ: (taxed?.args.tax as bigint | undefined) ?? 0n, trader, sqrtPriceX96After: a.sqrtPriceX96 as bigint, tickAfter: a.tick as number });
    }
  }
  const claimPayments = rewardClaimPaymentsV21(previous?.claimPayments ?? [], events, header.number, row);
  const statistics = statisticsAfterTrades({ raiseP: row.spec.raise, burnedT, holderCount,
    tradeCount: previous?.statistics?.tradeCount ?? 0n, volumeByTime: previous?.statistics?.volumeByTime ?? [],
    hourlyCandles: previous?.statistics?.hourlyCandles ?? [] }, trades, header.timestamp);
  // A legacy snapshot cannot acquire a complete lifetime count from a later delta; it requires creation replay.
  const protocolActivity = previous && !previous.protocolActivity ? undefined : protocolActivityV2(previous?.protocolActivity, events, row.boxId);
  return { state: { block: header.number, hash: header.hash, view, pool, p: row.q, pDecimals: row.pDecimals, supply, balances, volumeQ, volumeT, claimPayments, statistics, protocolActivity }, trades, activity, transfers };
}
