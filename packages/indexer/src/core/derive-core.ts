/**
 * One core v1 box's state from its events (S10a § 3.3), block by block: a pure reducer (state, block, events) →
 * (state, trades, activity, transfers). bigint in logic; immutable states (each block's state is kept for reorgs, so a
 * map is copied only when the block changes it).
 *
 * - **Phase (BC-081)** follows the hook's rule (BoxHook `phase()`) from the header's number and time and two events:
 *   graduated once `Migrated`, graduating (the contract's Closed) once `CurveClosed`, else by the block's timestamp
 *   (open-at-clock-time.md): upcoming before `openAt`, window before `openAt + 384` (`windowEndsAt`), else bonding.
 *   No call.
 * - **Trades (BC-083)**: one per PoolManager `Swap` of the box's pool; side from the token order (a buy pays Q in), Q and T
 *   amounts in their own raw units, √P after, the 1% fee estimated on the input (I: exact totals come from the
 *   receiver's batches). Swaps by the hook (its migration walk and depth conversions) and FIT's executor are routed,
 *   not counted as volume.
 * - **Fees, depth, graduation, vault, draws, stream**: sums and latest values of the events' own fields (BatchSplit,
 *   Collected, PlatformCredited, DepthHeld, GraduationSettled, Migrated, Deepened, the vault's `*After` fields, …).
 *   Three parts of box 0's split appear in no BatchSplit field (BoxReceiver.sol `_split`, `_settleGraduation`), so they
 *   are kept on their own: its 2/15 platform share before graduation (held by the receiver, `platformHeld`; exactly
 *   qFit × 2/11 of each batch, both multiples of the batch's fifteenth), the part of that held share the settlement
 *   sends to depth above the cap (`GraduationSettled.platformToDepth`), and after graduation the 13/15 T that funds the
 *   per-Misfit stream (`StreamFunded` or `StreamNotifyFailed`: either way the T was redeemed to the stream).
 * - **Supply** from T's mints and burns; **items** outside the vault from the collection's transfers (an item's owner is
 *   the vault unless a transfer says otherwise); **T balances** from T's transfers.
 */
import { BOX0_FEE_SHARE_FIT, BOX0_FEE_SHARE_PLATFORM } from '@squarehole/box-spec';
import type { BoxRow } from '@squarehole/chain';
import type { Address, Hex } from 'viem';
import type { BlockHeader } from '../model';
import type { CoreEvent } from './core-events';

export type CorePhase = 'upcoming' | 'window' | 'bonding' | 'graduating' | 'graduated';
export const CORE_PHASES: readonly CorePhase[] = Object.freeze(['upcoming', 'window', 'bonding', 'graduating', 'graduated']);
/** BoxTypes.BoxPhase values (IBoxHook.phase()): Upcoming 1 … Graduated 5, Failed 6 (version 2 only). */
export const CONTRACT_PHASE: Readonly<Record<number, CorePhase | 'failed'>> = Object.freeze({ 1: 'upcoming', 2: 'window', 3: 'bonding', 4: 'graduating', 5: 'graduated', 6: 'failed' });

const ZERO = '0x0000000000000000000000000000000000000000';
const lower = (a: unknown): string => String(a).toLowerCase();
const big = (v: unknown): bigint => (typeof v === 'bigint' ? v : BigInt(v as number | string));
const num = (v: unknown): number => Number(v);

/** A block's number and time (a header, a held block). */
export interface BlockAt {
  readonly number: bigint;
  readonly timestamp: bigint;
}

/**
 * The hook's rule at `block` (the state after its transactions): the close and the migration by block number, the
 * open and the window by the block's timestamp (openAt and windowEndsAt are Unix seconds).
 */
export function phaseAt(block: BlockAt, openAt: bigint, windowEndsAt: bigint, closedAtBlock: bigint | null, migratedAtBlock: bigint | null): CorePhase {
  if (migratedAtBlock !== null && block.number >= migratedAtBlock) return 'graduated';
  if (closedAtBlock !== null && block.number >= closedAtBlock) return 'graduating';
  if (block.timestamp < openAt) return 'upcoming';
  if (block.timestamp < windowEndsAt) return 'window';
  return 'bonding';
}

export interface FeeTotals {
  readonly batches: number;
  /** Collected: what the hook harvested into the receiver per batch (Q before the reserve and the tip), and T. */
  readonly collectedQ: bigint;
  readonly collectedT: bigint;
  readonly toReserveQ: bigint;
  readonly tipQ: bigint;
  /** BatchSplit sums. */
  readonly qReward: bigint;
  readonly qFit: bigint;
  readonly qDepth: bigint;
  readonly qPlatform: bigint;
  readonly tReward: bigint;
  readonly tFit: bigint;
  readonly tDepth: bigint;
  readonly tBurned: bigint;
  /** Harvested sums (the hook's view of the same fees). */
  readonly harvestedQ: bigint;
  readonly harvestedT: bigint;
  /** Box 0 after graduation: the 13/15 T redeemed to the per-Misfit stream (StreamFunded + StreamNotifyFailed). */
  readonly tToStream: bigint;
  /** Box 0: the held platform share's part above the cap, sent to depth at the settlement (GraduationSettled). */
  readonly qDepthSettled: bigint;
  /** Box 0: REV-16 returns of FIT's executor's own swap fees, booked to FIT (ModuleFeesReturned.moduleQ). */
  readonly qFitReturned: bigint;
}

export interface PlatformLedger {
  /** PlatformCredited: kept for the Safe in total, sent to depth above the cap, and the latest epoch with what it kept. */
  readonly credited: bigint;
  /** Box 0 before the settlement: its 2/15 platform share of each batch, held by the receiver (`platformHeld()`). */
  readonly held: bigint;
  readonly toDepth: bigint;
  readonly epoch: bigint | null;
  readonly keptInEpoch: bigint;
  readonly paid: bigint;
}

export interface VaultLedger {
  readonly collectionSize: bigint | null;
  readonly escrow: bigint | null;
  readonly inside: bigint | null;
  readonly hidden: bigint | null;
  readonly tickets: bigint | null;
  readonly withdrawn: bigint;
  readonly returned: bigint;
  readonly gateOpen: boolean;
  readonly gateOpenedAt: bigint | null;
}

export interface DrawLedger {
  readonly placeholdersTaken: bigint;
  readonly placeholdersHandedBack: bigint;
  readonly opened: number;
  readonly drawsRequested: number;
  readonly drawsSettled: number;
  readonly drawsCancelled: number;
  readonly wordRequestedRound: bigint | null;
  readonly wordStored: boolean;
  readonly wordReadyAt: bigint | null;
  readonly terminal: boolean;
  /** Rounds this box's tickets asked for (graduation word and draws), to match RoundPosted. */
  readonly rounds: readonly bigint[];
  /** Own rounds committed to the backup; later drand posts cannot supply their words. */
  readonly backupRounds: readonly bigint[];
  readonly roundsPosted: number;
}

export interface StreamLedger {
  readonly started: boolean;
  readonly startValue: bigint | null;
  readonly funded: bigint;
  readonly credited: bigint;
  readonly claimed: bigint;
  readonly burned: bigint;
  readonly burnRefused: bigint;
  readonly repairs: number;
}

export interface DepthLedger {
  readonly heldQ: bigint;
  readonly heldT: bigint;
  readonly fundedQ: bigint;
  readonly fundedT: bigint;
  readonly giftedQ: bigint;
  readonly settled: boolean;
  readonly pairedLiquidity: bigint;
  readonly adds: number;
  readonly addedQ: bigint;
  readonly addedT: bigint;
  readonly tips: bigint;
  readonly conversions: number;
  readonly convertedQ: bigint;
  readonly convertedT: bigint;
  readonly skips: number;
  readonly lastSkipReason: number | null;
  readonly lastAddBlock: bigint | null;
}

export interface Graduation {
  readonly block: bigint;
  readonly timestamp: bigint;
  readonly caller: Address;
  readonly poolShare: bigint;
  readonly tokenDustBurned: bigint;
  readonly reward: bigint;
  readonly txHash: Hex;
}

export interface Layout {
  readonly askLiquidity: bigint;
  readonly bidLiquidity: bigint;
  readonly sentinelLiquidity: bigint;
  readonly qFromCurve: bigint;
  readonly tFromCurve: bigint;
  readonly tokenPulled: bigint;
  readonly qDust: bigint;
}

export interface RevealRecord {
  readonly traitsPacked: bigint;
  readonly imageHash: Hex;
  readonly avatarHash: Hex;
  readonly modelHash: Hex;
}

export interface CoreBoxState {
  readonly reveals: ReadonlyMap<bigint, RevealRecord>;
  readonly block: bigint;
  readonly blockHash: Hex;
  readonly timestamp: bigint;
  readonly phase: CorePhase;
  readonly closedAtBlock: bigint | null;
  readonly closedSqrtPriceX96: bigint | null;
  readonly migratedAtBlock: bigint | null;
  readonly launched: boolean;
  readonly sqrtPriceX96: bigint | null;
  readonly tick: number | null;
  readonly liquidity: bigint;
  readonly supply: bigint;
  readonly burned: bigint;
  readonly swaps: number;
  readonly buys: number;
  readonly sells: number;
  readonly volumeQ: bigint;
  readonly volumeT: bigint;
  readonly lastTradeBlock: bigint | null;
  readonly taxQ: bigint;
  readonly windowBuys: number;
  readonly bootstrapQ: bigint;
  readonly creatorBuyQ: bigint;
  readonly sweptQ: bigint;
  readonly sweptToDepth: boolean | null;
  readonly fees: FeeTotals;
  readonly platform: PlatformLedger;
  readonly fitPaid: bigint;
  readonly feesFunded: bigint;
  readonly depth: DepthLedger;
  readonly graduation: Graduation | null;
  readonly rewardClaimed: bigint;
  readonly pokeFailures: number;
  readonly layout: Layout | null;
  readonly vault: VaultLedger;
  readonly draws: DrawLedger;
  readonly stream: StreamLedger;
  readonly executorBurned: bigint;
  readonly executorBought: bigint;
  readonly royaltiesFlushed: bigint;
  /** Donate, or a liquidity change by anyone but the hook: never expected (D3), counted. */
  readonly anomalies: number;
  /** T balances (lowercase address → raw). */
  readonly balances: ReadonlyMap<string, bigint>;
  /** Items not held by the vault (id → lowercase owner); every minted item starts with the vault. */
  readonly itemsOut: ReadonlyMap<bigint, string>;
  readonly itemsMinted: bigint;
  /** Placeholder / draw tickets (id → lowercase owner). */
  readonly ticketOwners: ReadonlyMap<bigint, string>;
  /** Open draw tickets (id → lowercase drawer): requested or settled, not opened or cancelled (SH-BOX0-ACTIONS). */
  readonly drawTickets: ReadonlyMap<bigint, string>;
}

export type TradeRoute = 'launch_router' | 'bootstrap' | 'executor' | 'hook' | 'other' | 'converter' | 'swap_module' | 'buy_back';

export interface CoreTrade {
  readonly id: string;
  readonly block: bigint;
  readonly blockHash: Hex;
  readonly timestamp: bigint;
  readonly txHash: Hex;
  readonly logIndex: number;
  readonly side: 'buy' | 'sell';
  readonly route: TradeRoute;
  readonly qRaw: bigint;
  readonly tRaw: bigint;
  /** 1% of the input (I): Q on buys, T on sells. */
  readonly feeQ: bigint;
  readonly feeT: bigint;
  readonly taxQ: bigint;
  readonly trader: Address | null;
  readonly sqrtPriceX96After: bigint;
  readonly tickAfter: number;
}

export type CoreActivityKind =
  | 'v2_event'
  | 'created'
  | 'launched'
  | 'window_buy'
  | 'bootstrap'
  | 'creator_buy'
  | 'swept'
  | 'closed'
  | 'graduated'
  | 'reward_claimed'
  | 'poke_failed'
  | 'batch'
  | 'platform_credited'
  | 'platform_paid'
  | 'fit_paid'
  | 'depth_held'
  | 'depth_funded'
  | 'depth_gifted'
  | 'settled'
  | 'deepened'
  | 'deepen_skipped'
  | 'depth_converted'
  | 'migrated'
  | 'withdrawn'
  | 'returned'
  | 'tickets_opened'
  | 'tickets_released'
  | 'gate_opened'
  | 'placeholders_taken'
  | 'placeholders_handed_back'
  | 'word_requested'
  | 'word_stored'
  | 'draw_requested'
  | 'draw_settled'
  | 'opened'
  | 'ticket_cancelled'
  | 'terminal'
  | 'taken_by_number'
  | 'round_posted'
  | 'backup_started'
  | 'backup_fixed'
  | 'stream_started'
  | 'stream_claimed'
  | 'stream_burned'
  | 'stream_funded'
  | 'buyback'
  | 'royalty_flushed'
  | 'anomaly';

export interface CoreActivity {
  readonly id: string;
  readonly kind: CoreActivityKind;
  readonly block: bigint;
  readonly blockHash: Hex;
  readonly timestamp: bigint;
  readonly txHash: Hex;
  readonly logIndex: number;
  /** The event's own fields as decimal strings and lowercase addresses (small, typed by `kind`). */
  readonly data: Readonly<Record<string, string | number | boolean>>;
}

export type TransferAsset = 'T' | 'item' | 'ticket';

export interface CoreTransfer {
  readonly id: string;
  readonly asset: TransferAsset;
  readonly block: bigint;
  readonly blockHash: Hex;
  readonly txHash: Hex;
  readonly logIndex: number;
  readonly from: string;
  readonly to: string;
  /** T: the raw amount; items and tickets: the token id (a ConsecutiveTransfer is expanded per item). */
  readonly amount: bigint;
  readonly tokenId: bigint | null;
}

export interface BlockOutcome {
  readonly state: CoreBoxState;
  readonly trades: readonly CoreTrade[];
  readonly activity: readonly CoreActivity[];
  readonly transfers: readonly CoreTransfer[];
}

const EMPTY_FEES: FeeTotals = Object.freeze({ batches: 0, collectedQ: 0n, collectedT: 0n, toReserveQ: 0n, tipQ: 0n, qReward: 0n, qFit: 0n, qDepth: 0n, qPlatform: 0n, tReward: 0n, tFit: 0n, tDepth: 0n, tBurned: 0n, harvestedQ: 0n, harvestedT: 0n, tToStream: 0n, qDepthSettled: 0n, qFitReturned: 0n });

/** The state before the creation block (nothing happened yet). */
export function initialCoreState(row: BoxRow): CoreBoxState {
  const zero = `0x${'0'.repeat(64)}` as Hex;
  return Object.freeze({
    block: row.creationBlock - 1n,
    blockHash: zero,
    timestamp: 0n,
    phase: 'upcoming',
    closedAtBlock: null,
    closedSqrtPriceX96: null,
    migratedAtBlock: null,
    launched: false,
    sqrtPriceX96: null,
    tick: null,
    liquidity: 0n,
    supply: 0n,
    burned: 0n,
    swaps: 0,
    buys: 0,
    sells: 0,
    volumeQ: 0n,
    volumeT: 0n,
    lastTradeBlock: null,
    taxQ: 0n,
    windowBuys: 0,
    bootstrapQ: 0n,
    creatorBuyQ: 0n,
    sweptQ: 0n,
    sweptToDepth: null,
    fees: EMPTY_FEES,
    platform: { credited: 0n, held: 0n, toDepth: 0n, epoch: null, keptInEpoch: 0n, paid: 0n },
    fitPaid: 0n,
    feesFunded: 0n,
    depth: { heldQ: 0n, heldT: 0n, fundedQ: 0n, fundedT: 0n, giftedQ: 0n, settled: false, pairedLiquidity: 0n, adds: 0, addedQ: 0n, addedT: 0n, tips: 0n, conversions: 0, convertedQ: 0n, convertedT: 0n, skips: 0, lastSkipReason: null, lastAddBlock: null },
    graduation: null,
    rewardClaimed: 0n,
    pokeFailures: 0,
    layout: null,
    vault: { collectionSize: null, escrow: null, inside: null, hidden: null, tickets: null, withdrawn: 0n, returned: 0n, gateOpen: false, gateOpenedAt: null },
    draws: { placeholdersTaken: 0n, placeholdersHandedBack: 0n, opened: 0, drawsRequested: 0, drawsSettled: 0, drawsCancelled: 0, wordRequestedRound: null, wordStored: false, wordReadyAt: null, terminal: false, rounds: [], backupRounds: [], roundsPosted: 0 },
    stream: { started: false, startValue: null, funded: 0n, credited: 0n, claimed: 0n, burned: 0n, burnRefused: 0n, repairs: 0 },
    executorBurned: 0n,
    executorBought: 0n,
    royaltiesFlushed: 0n,
    anomalies: 0,
    balances: new Map(),
    itemsOut: new Map(),
    reveals: new Map(),
    itemsMinted: 0n,
    ticketOwners: new Map(),
    drawTickets: new Map(),
  });
}

/** What a block's events carry about one transaction, for routing its swaps. */
interface TxContext {
  readonly taxedBuys: CoreEvent[];
  readonly bootstrap: boolean;
  readonly creatorBuy: boolean;
}

function txContexts(events: readonly CoreEvent[]): Map<string, TxContext> {
  const out = new Map<string, TxContext>();
  for (const e of events) {
    const key = lower(e.ref.txHash);
    const ctx = out.get(key) ?? { taxedBuys: [], bootstrap: false, creatorBuy: false };
    if (e.source === 'launchRouter' && e.name === 'TaxedBuy') ctx.taxedBuys.push(e);
    out.set(key, { ...ctx, bootstrap: ctx.bootstrap || (e.source === 'launchRouter' && e.name === 'Bootstrapped'), creatorBuy: ctx.creatorBuy || (e.source === 'launchRouter' && e.name === 'CreatorBought') });
  }
  return out;
}

const dataOf = (args: Readonly<Record<string, unknown>>, keys: readonly string[]): Record<string, string | number | boolean> => {
  const out: Record<string, string | number | boolean> = {};
  for (const key of keys) {
    const v = args[key];
    if (typeof v === 'bigint') out[key] = v.toString();
    else if (typeof v === 'number' || typeof v === 'boolean') out[key] = v;
    else if (typeof v === 'string') out[key] = v.startsWith('0x') ? v.toLowerCase() : v;
    else if (Array.isArray(v)) out[key] = v.map((x) => String(x)).join(',');
  }
  return out;
};

/** Folds one block's events for one box into its state. `events` are this box's, ordered by log index. */
export function applyCoreBlock(previous: CoreBoxState, header: BlockHeader, events: readonly CoreEvent[], row: BoxRow): BlockOutcome {
  const box = {
    hook: lower(row.contracts.hook),
    launchRouter: lower(row.contracts.launchRouter),
    executor: lower(row.contracts.executor),
    vault: lower(row.contracts.vault ?? ZERO),
    tickets: lower(row.contracts.tickets ?? ZERO),
  };
  const tIsC0 = row.tIsCurrency0;
  let s: CoreBoxState = previous;
  const trades: CoreTrade[] = [];
  const activity: CoreActivity[] = [];
  const transfers: CoreTransfer[] = [];
  const contexts = txContexts(events);
  // Copy on write: a block that touches no balance, item or ticket shares the previous state's maps.
  const cow: { balances: Map<string, bigint> | null; itemsOut: Map<bigint, string> | null; tickets: Map<bigint, string> | null; draws: Map<bigint, string> | null } = { balances: null, itemsOut: null, tickets: null, draws: null };
  const bal = (): Map<string, bigint> => (cow.balances ??= new Map(s.balances));
  const items = (): Map<bigint, string> => (cow.itemsOut ??= new Map(s.itemsOut));
  const tix = (): Map<bigint, string> => (cow.tickets ??= new Map(s.ticketOwners));
  const drawn = (): Map<bigint, string> => (cow.draws ??= new Map(s.drawTickets));
  const id = (e: CoreEvent): string => `${e.ref.blockNumber}-${e.ref.logIndex}`;
  const act = (e: CoreEvent, kind: CoreActivityKind, keys: readonly string[] = []): void => {
    activity.push({ id: id(e), kind, block: header.number, blockHash: header.hash, timestamp: header.timestamp, txHash: e.ref.txHash, logIndex: e.ref.logIndex, data: dataOf(e.args, keys) });
  };
  const usedTaxed = new Set<string>();

  for (const e of events) {
    const a = e.args;
    switch (`${e.source}.${e.name}`) {
      // ---------------------------------------------------------------- pool
      case 'poolManager.Initialize':
        s = { ...s, sqrtPriceX96: big(a.sqrtPriceX96), tick: num(a.tick), liquidity: 0n };
        break;
      case 'poolManager.ModifyLiquidity': {
        const delta = big(a.liquidityDelta);
        const tick = s.tick;
        if (tick !== null && tick >= num(a.tickLower) && tick < num(a.tickUpper)) s = { ...s, liquidity: s.liquidity + delta };
        if (lower(a.sender) !== box.hook && delta !== 0n) {
          s = { ...s, anomalies: s.anomalies + 1 };
          act(e, 'anomaly', ['sender', 'liquidityDelta']);
        }
        break;
      }
      case 'poolManager.Donate':
        s = { ...s, anomalies: s.anomalies + 1 };
        act(e, 'anomaly', ['sender', 'amount0', 'amount1']);
        break;
      case 'poolManager.Swap': {
        const amount0 = big(a.amount0);
        const amount1 = big(a.amount1);
        const qDelta = tIsC0 ? amount1 : amount0;
        const tDelta = tIsC0 ? amount0 : amount1;
        const sender = lower(a.sender);
        s = { ...s, sqrtPriceX96: big(a.sqrtPriceX96), tick: num(a.tick), liquidity: big(a.liquidity) };
        if (qDelta === 0n && tDelta === 0n) break; // the migration's zero-amount walk to P1
        const buy = qDelta < 0n;
        const qRaw = buy ? -qDelta : qDelta;
        const tRaw = buy ? tDelta : -tDelta;
        const ctx = contexts.get(lower(e.ref.txHash));
        let route: TradeRoute = 'other';
        let trader: Address | null = null;
        let taxQ = 0n;
        if (sender === box.hook) route = 'hook';
        else if (sender === box.executor) route = 'executor';
        else if (sender === box.launchRouter) {
          const taxed = ctx?.taxedBuys.find((t) => !usedTaxed.has(id(t)));
          if (taxed) {
            usedTaxed.add(id(taxed));
            route = 'launch_router';
            trader = taxed.args.buyer as Address;
            taxQ = big(taxed.args.tax);
          } else route = ctx?.bootstrap ? 'bootstrap' : ctx?.creatorBuy ? 'launch_router' : 'launch_router';
        }
        const counted = route !== 'hook' && route !== 'executor';
        trades.push({
          id: id(e),
          block: header.number,
          blockHash: header.hash,
          timestamp: header.timestamp,
          txHash: e.ref.txHash,
          logIndex: e.ref.logIndex,
          side: buy ? 'buy' : 'sell',
          route,
          qRaw,
          tRaw,
          feeQ: buy ? qRaw / 100n : 0n,
          feeT: buy ? 0n : tRaw / 100n,
          taxQ,
          trader,
          sqrtPriceX96After: big(a.sqrtPriceX96),
          tickAfter: num(a.tick),
        });
        if (counted) {
          s = { ...s, swaps: s.swaps + 1, buys: s.buys + (buy ? 1 : 0), sells: s.sells + (buy ? 0 : 1), volumeQ: s.volumeQ + qRaw, volumeT: s.volumeT + tRaw, lastTradeBlock: header.number };
        }
        break;
      }
      // ---------------------------------------------------------------- hook
      case 'hook.PoolLaunched':
        s = { ...s, launched: true };
        act(e, 'launched', ['tickLower', 'tickUpper', 'liquidity', 'sqrtPriceX96', 'tokenDeposited']);
        break;
      case 'hook.CurveClosed':
        s = { ...s, closedAtBlock: big(a.blockNumber), closedSqrtPriceX96: big(a.sqrtPriceX96) };
        act(e, 'closed', ['blockNumber', 'sqrtPriceX96']);
        break;
      case 'hook.Migrated':
        s = {
          ...s,
          migratedAtBlock: header.number,
          layout: { askLiquidity: big(a.askLiquidity), bidLiquidity: big(a.bidLiquidity), sentinelLiquidity: big(a.sentinelLiquidity), qFromCurve: big(a.qFromCurve), tFromCurve: big(a.tFromCurve), tokenPulled: big(a.tokenPulled), qDust: big(a.qDust) },
        };
        act(e, 'migrated', ['qFromCurve', 'tFromCurve', 'askLiquidity', 'bidLiquidity', 'sentinelLiquidity', 'tokenPulled', 'qDust']);
        break;
      case 'hook.Harvested':
        s = { ...s, fees: { ...s.fees, harvestedQ: s.fees.harvestedQ + big(a.qFees), harvestedT: s.fees.harvestedT + big(a.tFees) } };
        break;
      case 'hook.Deepened': {
        const kind = num(a.kind);
        const d = s.depth;
        s = {
          ...s,
          depth: {
            ...d,
            pairedLiquidity: kind === 1 ? d.pairedLiquidity + big(a.liquidity) : d.pairedLiquidity,
            adds: d.adds + (kind === 1 ? 1 : 0),
            addedQ: d.addedQ + big(a.qUsed),
            addedT: d.addedT + big(a.tUsed),
            tips: d.tips + big(a.tip),
            // A call that only converted (kind 2) added no depth: the last ADD is a pair's (kind 1).
            lastAddBlock: kind === 1 ? header.number : d.lastAddBlock,
          },
        };
        act(e, 'deepened', ['kind', 'tickLower', 'tickUpper', 'liquidity', 'qUsed', 'tUsed', 'tip']);
        break;
      }
      case 'hook.DeepenSkipped':
        s = { ...s, depth: { ...s.depth, skips: s.depth.skips + 1, lastSkipReason: num(a.reason) } };
        act(e, 'deepen_skipped', ['reason']);
        break;
      case 'hook.DepthConverted':
        s = { ...s, depth: { ...s.depth, conversions: s.depth.conversions + 1, convertedQ: s.depth.convertedQ + big(a.qIn), convertedT: s.depth.convertedT + big(a.tOut) } };
        act(e, 'depth_converted', ['qIn', 'tOut', 'referenceTick', 'sqrtPriceBeforeX96', 'sqrtPriceAfterX96']);
        break;
      // ---------------------------------------------------------------- launch router
      case 'launchRouter.TaxedBuy':
        s = { ...s, taxQ: s.taxQ + big(a.tax), windowBuys: s.windowBuys + 1 };
        act(e, 'window_buy', ['buyer', 'recipient', 'step', 'qIn', 'tax', 'tokensOut', 'refund']);
        break;
      case 'launchRouter.Bootstrapped':
        s = { ...s, bootstrapQ: s.bootstrapQ + big(a.qIn) };
        act(e, 'bootstrap', ['recipient', 'qIn', 'tokensOut']);
        break;
      case 'launchRouter.CreatorBought':
        s = { ...s, creatorBuyQ: s.creatorBuyQ + big(a.qIn) };
        act(e, 'creator_buy', ['creator', 'qIn', 'tokensOut']);
        break;
      case 'launchRouter.Swept':
        s = { ...s, sweptQ: s.sweptQ + big(a.amount), sweptToDepth: Boolean(a.toDepth) };
        act(e, 'swept', ['to', 'amount', 'toDepth']);
        break;
      // ---------------------------------------------------------------- coordinator
      case 'coordinator.BoxLaunched':
        break;
      case 'coordinator.Graduated':
        s = { ...s, graduation: { block: header.number, timestamp: header.timestamp, caller: a.caller as Address, poolShare: big(a.poolShare), tokenDustBurned: big(a.tokenDustBurned), reward: big(a.reward), txHash: e.ref.txHash } };
        act(e, 'graduated', ['caller', 'blockNumber', 'poolShare', 'tokenDustBurned', 'reward']);
        break;
      case 'coordinator.RewardClaimed':
        s = { ...s, rewardClaimed: s.rewardClaimed + big(a.amount) };
        act(e, 'reward_claimed', ['caller', 'to', 'amount']);
        break;
      case 'coordinator.PokeFailed':
        s = { ...s, pokeFailures: s.pokeFailures + 1 };
        act(e, 'poke_failed', ['target', 'selector']);
        break;
      // ---------------------------------------------------------------- receiver
      case 'receiver.Collected':
        s = { ...s, fees: { ...s.fees, batches: s.fees.batches + 1, collectedQ: s.fees.collectedQ + big(a.q), collectedT: s.fees.collectedT + big(a.t), toReserveQ: s.fees.toReserveQ + big(a.qToReserve), tipQ: s.fees.tipQ + big(a.tip) } };
        act(e, 'batch', ['caller', 'tipTo', 'q', 't', 'qToReserve', 'tip']);
        break;
      case 'receiver.BatchSplit': {
        const f = s.fees;
        s = { ...s, fees: { ...f, qReward: f.qReward + big(a.qReward), qFit: f.qFit + big(a.qFit), qDepth: f.qDepth + big(a.qDepth), qPlatform: f.qPlatform + big(a.qPlatform), tReward: f.tReward + big(a.tReward), tFit: f.tFit + big(a.tFit), tDepth: f.tDepth + big(a.tDepth), tBurned: f.tBurned + big(a.tBurned) } };
        // Box 0 before the settlement: the platform's 2/15 is held (`platformHeld += p`, BatchSplit.qPlatform 0). p and
        // qFit are 2 and 11 times the batch's fifteenth, so p = qFit × 2/11 exactly.
        if (row.isBox0 && !s.depth.settled) s = { ...s, platform: { ...s.platform, held: s.platform.held + (big(a.qFit) * BOX0_FEE_SHARE_PLATFORM) / BOX0_FEE_SHARE_FIT } };
        act(e, 'batch', ['qReward', 'qFit', 'qDepth', 'qPlatform', 'tReward', 'tFit', 'tDepth', 'tBurned']);
        break;
      }
      case 'receiver.PlatformCredited':
        s = { ...s, platform: { ...s.platform, credited: s.platform.credited + big(a.kept), toDepth: s.platform.toDepth + big(a.toDepth), epoch: big(a.epoch), keptInEpoch: big(a.keptInEpoch) } };
        act(e, 'platform_credited', ['epoch', 'kept', 'toDepth', 'keptInEpoch']);
        break;
      case 'receiver.PlatformPaid':
        s = { ...s, platform: { ...s.platform, paid: s.platform.paid + big(a.amount) } };
        act(e, 'platform_paid', ['safe', 'amount']);
        break;
      case 'receiver.FitPaid':
        s = { ...s, fitPaid: s.fitPaid + big(a.amount) };
        act(e, 'fit_paid', ['executor', 'amount']);
        break;
      case 'receiver.DepthHeld':
        s = { ...s, depth: { ...s.depth, heldQ: s.depth.heldQ + big(a.q), heldT: s.depth.heldT + big(a.t) } };
        act(e, 'depth_held', ['q', 't']);
        break;
      case 'receiver.DepthFunded':
        s = { ...s, depth: { ...s.depth, fundedQ: s.depth.fundedQ + big(a.q), fundedT: s.depth.fundedT + big(a.t) } };
        act(e, 'depth_funded', ['q', 't']);
        break;
      case 'receiver.DepthGifted':
        s = { ...s, depth: { ...s.depth, giftedQ: s.depth.giftedQ + big(a.amount) } };
        act(e, 'depth_gifted', ['from', 'amount']);
        break;
      case 'receiver.FeesFunded':
        s = { ...s, feesFunded: s.feesFunded + big(a.amount) };
        break;
      case 'receiver.GraduationSettled':
        // Every held depth part moves to the hook at the settlement (BoxReceiver._settleGraduation): nothing is held
        // after it. The held platform share went through the cap just before (its PlatformCredited, counted above):
        // kept for the Safe, the rest to depth, which no BatchSplit reports.
        s = {
          ...s,
          depth: { ...s.depth, heldQ: 0n, heldT: 0n, settled: true },
          platform: { ...s.platform, held: 0n },
          fees: { ...s.fees, qDepthSettled: s.fees.qDepthSettled + big(a.platformToDepth) },
        };
        act(e, 'settled', ['fitReleased', 'platformKept', 'platformToDepth', 'creatorQ', 'creatorT']);
        break;
      case 'receiver.StreamFunded':
      case 'receiver.StreamNotifyFailed':
        // The 13/15 T after graduation, redeemed to the stream either way (a failed notice leaves it there unannounced).
        s = { ...s, fees: { ...s.fees, tToStream: s.fees.tToStream + big(a.amount) } };
        act(e, 'stream_funded', ['stream', 'amount']);
        break;
      case 'receiver.ModuleFeesReturned':
        // REV-16: box 0's executor notes go back to FIT's budget (`fitOwed`, `toFit`); another box's to its module.
        if (row.isBox0) s = { ...s, fees: { ...s.fees, qFitReturned: s.fees.qFitReturned + big(a.moduleQ) } };
        break;
      case 'receiver.ModuleFeesNoted':
      case 'receiver.ModuleFeesClipped':
        break;
      // ---------------------------------------------------------------- vault
      case 'vault.Withdrawn':
      case 'vault.Returned': {
        const ids = (a.ids as readonly bigint[] | undefined) ?? [];
        const v = s.vault;
        s = {
          ...s,
          vault: {
            ...v,
            escrow: big(a.escrowAfter),
            inside: big(a.insideAfter),
            withdrawn: v.withdrawn + (e.name === 'Withdrawn' ? BigInt(ids.length) : 0n),
            returned: v.returned + (e.name === 'Returned' ? BigInt(ids.length) : 0n),
          },
        };
        act(e, e.name === 'Withdrawn' ? 'withdrawn' : 'returned', ['owner', 'ids', 'principal', 'fee']);
        break;
      }
      case 'vault.TicketsOpened':
        s = { ...s, vault: { ...s.vault, escrow: big(a.escrowAfter), inside: big(a.insideAfter), hidden: big(a.hiddenAfter), tickets: big(a.ticketsAfter) } };
        act(e, 'tickets_opened', ['count', 'principal', 'fee']);
        break;
      case 'vault.TicketsReleased':
        s = { ...s, vault: { ...s.vault, escrow: big(a.escrowAfter), inside: big(a.insideAfter), hidden: big(a.hiddenAfter), tickets: big(a.ticketsAfter) } };
        act(e, 'tickets_released', ['to', 'count', 'principal', 'fee']);
        break;
      case 'vault.TicketDelivered':
        s = { ...s, vault: { ...s.vault, tickets: big(a.ticketsAfter) } };
        break;
      case 'vault.GateOpened':
        s = { ...s, vault: { ...s.vault, gateOpen: true, gateOpenedAt: big(a.timestamp) } };
        act(e, 'gate_opened', ['timestamp']);
        break;
      case 'vault.HandBackFeeWaived':
      case 'vault.VaultObserverFailed':
        break;
      // ---------------------------------------------------------------- collection
      case 'collection.ConsecutiveTransfer': {
        const from = lower(a.fromAddress);
        const to = lower(a.toAddress);
        const first = big(a.fromTokenId);
        const last = big(a.toTokenId);
        if (from === ZERO && to === box.vault) {
          s = { ...s, itemsMinted: s.itemsMinted + (last - first + 1n), vault: { ...s.vault, collectionSize: s.vault.collectionSize ?? last - first + 1n } };
        } else {
          for (let i = first; i <= last; i += 1n) {
            if (to === box.vault) items().delete(i);
            else items().set(i, to);
          }
        }
        // Expanded per item for the history (chain-data-platform § 2.5): bounded by N ≤ 10,000.
        for (let i = first; i <= last; i += 1n) transfers.push({ id: `${id(e)}-${i}`, asset: 'item', block: header.number, blockHash: header.hash, txHash: e.ref.txHash, logIndex: e.ref.logIndex, from, to, amount: 1n, tokenId: i });
        break;
      }
      case 'collection.Transfer': {
        const from = lower(a.from);
        const to = lower(a.to);
        const tokenId = big(a.tokenId);
        if (to === box.vault) items().delete(tokenId);
        else items().set(tokenId, to);
        if (from === ZERO) s = { ...s, itemsMinted: s.itemsMinted + 1n };
        transfers.push({ id: id(e), asset: 'item', block: header.number, blockHash: header.hash, txHash: e.ref.txHash, logIndex: e.ref.logIndex, from, to, amount: 1n, tokenId });
        break;
      }
      case 'collection.Revealed': {
        const reveals = new Map(s.reveals);
        reveals.set(big(a.id), { traitsPacked: big(a.traitsPacked), imageHash: a.imageHash as Hex, avatarHash: a.avatarHash as Hex, modelHash: a.modelHash as Hex });
        s = { ...s, reveals };
        break;
      }
      case 'collection.RevealUnlocked':
      case 'collection.TransferObserverFailed':
        break;
      // ---------------------------------------------------------------- tickets
      case 'tickets.Transfer': {
        const from = lower(a.from);
        const to = lower(a.to);
        const tokenId = big(a.tokenId);
        if (to === ZERO) tix().delete(tokenId);
        else tix().set(tokenId, to);
        transfers.push({ id: id(e), asset: 'ticket', block: header.number, blockHash: header.hash, txHash: e.ref.txHash, logIndex: e.ref.logIndex, from, to, amount: 1n, tokenId });
        break;
      }
      case 'tickets.PlaceholdersTaken':
        s = { ...s, draws: { ...s.draws, placeholdersTaken: s.draws.placeholdersTaken + big(a.count) } };
        act(e, 'placeholders_taken', ['taker', 'firstTokenId', 'count', 'principal', 'fee']);
        break;
      case 'tickets.PlaceholdersHandedBack':
        s = { ...s, draws: { ...s.draws, placeholdersHandedBack: s.draws.placeholdersHandedBack + big(a.count) } };
        act(e, 'placeholders_handed_back', ['holder', 'count', 'principal', 'fee']);
        break;
      case 'tickets.GraduationWordRequested':
        s = { ...s, draws: { ...s.draws, wordRequestedRound: big(a.round), rounds: [...s.draws.rounds, big(a.round)] } };
        act(e, 'word_requested', ['requester', 'round', 'bounty']);
        break;
      case 'tickets.GraduationWordStored':
        s = { ...s, draws: { ...s.draws, wordStored: true, wordReadyAt: big(a.readyAt) } };
        act(e, 'word_stored', ['placeholders', 'readyAt']);
        break;
      case 'tickets.DrawRequested':
        s = { ...s, draws: { ...s.draws, drawsRequested: s.draws.drawsRequested + 1, rounds: [...s.draws.rounds, big(a.round)] } };
        drawn().set(big(a.ticketId), lower(a.drawer));
        act(e, 'draw_requested', ['ticketId', 'drawer', 'principal', 'fee', 'round', 'bounty']);
        break;
      case 'tickets.DrawSettled':
        s = { ...s, draws: { ...s.draws, drawsSettled: s.draws.drawsSettled + 1 } };
        act(e, 'draw_settled', ['ticketId', 'itemId']);
        break;
      case 'tickets.Opened':
        s = { ...s, draws: { ...s.draws, opened: s.draws.opened + 1 } };
        // Kind 2 is a draw ticket; a placeholder (kind 1) shares the id space and closes no draw.
        if (Number(a.kind) === 2) drawn().delete(big(a.tokenOrTicket));
        act(e, 'opened', ['tokenOrTicket', 'kind', 'itemId', 'holder', 'revealed']);
        break;
      case 'tickets.TicketCancelled':
        s = { ...s, draws: { ...s.draws, drawsCancelled: s.draws.drawsCancelled + 1 } };
        drawn().delete(big(a.ticketId));
        act(e, 'ticket_cancelled', ['ticketId', 'drawer', 'principal']);
        break;
      case 'tickets.TerminalModeEntered':
        s = { ...s, draws: { ...s.draws, terminal: true } };
        act(e, 'terminal', ['timestamp']);
        break;
      case 'tickets.TakenByNumber':
        act(e, 'taken_by_number', ['taker', 'itemId', 'principal', 'fee', 'revealed']);
        break;
      // ---------------------------------------------------------------- drand (the box's own rounds only)
      case 'randomness.Requested':
      case 'backedSource.Requested':
        break;
      case 'randomness.RoundPosted':
        if (s.draws.rounds.includes(big(a.round)) && !s.draws.backupRounds.includes(big(a.round))) {
          s = { ...s, draws: { ...s.draws, roundsPosted: s.draws.roundsPosted + 1 } };
          act(e, 'round_posted', ['round', 'poster', 'bounty']);
        }
        break;
      case 'randomness.BountyAdded':
        break;
      case 'backedSource.BackupStarted': {
        const round = big(a.round);
        if (s.draws.rounds.includes(round)) {
          if (!s.draws.backupRounds.includes(round)) s = { ...s, draws: { ...s.draws, backupRounds: [...s.draws.backupRounds, round] } };
          act(e, 'backup_started', ['round', 'targetBlock', 'by']);
        }
        break;
      }
      case 'backedSource.BackupFixed':
        if (s.draws.rounds.includes(big(a.round))) act(e, 'backup_fixed', ['round', 'targetBlock', 'mix', 'by']);
        break;
      // ---------------------------------------------------------------- per-Misfit stream
      case 'itemStream.Started':
        s = { ...s, stream: { ...s.stream, started: true, startValue: big(a.value) } };
        act(e, 'stream_started', ['value']);
        break;
      case 'itemStream.Funded':
        s = { ...s, stream: { ...s.stream, funded: s.stream.funded + big(a.amount) } };
        break;
      case 'itemStream.Credited':
      case 'itemStream.TicketsCredited':
        s = { ...s, stream: { ...s.stream, credited: s.stream.credited + big(a.amount) } };
        break;
      case 'itemStream.Claimed':
        s = { ...s, stream: { ...s.stream, claimed: s.stream.claimed + big(a.amount) } };
        act(e, 'stream_claimed', ['account', 'to', 'amount']);
        break;
      case 'itemStream.Burned':
        s = { ...s, stream: { ...s.stream, burned: s.stream.burned + big(a.amount) } };
        act(e, 'stream_burned', ['amount']);
        break;
      case 'itemStream.BurnRefused':
        s = { ...s, stream: { ...s.stream, burnRefused: s.stream.burnRefused + big(a.amount) } };
        break;
      case 'itemStream.CheckpointRepaired':
        s = { ...s, stream: { ...s.stream, repairs: s.stream.repairs + 1 } };
        break;
      // ---------------------------------------------------------------- FIT's executor, royalties
      case 'executor.ChunkBought':
        s = { ...s, executorBought: s.executorBought + big(a.fitOut) };
        break;
      case 'executor.TokensBurned':
        s = { ...s, executorBurned: s.executorBurned + big(a.bought) + big(a.unsolicited) };
        act(e, 'buyback', ['bought', 'unsolicited']);
        break;
      case 'executor.Executed':
      case 'executor.ModuleFeesReported':
        break;
      case 'royaltyRouter.Flushed':
        s = { ...s, royaltiesFlushed: s.royaltiesFlushed + big(a.ethSent) };
        act(e, 'royalty_flushed', ['receiver', 'ethSent', 'wethUnwrapped']);
        break;
      // ---------------------------------------------------------------- token
      case 'token.Transfer': {
        const from = lower(a.from);
        const to = lower(a.to);
        const amount = big(a.value ?? a.amount);
        const b = bal();
        if (from !== ZERO) b.set(from, (b.get(from) ?? 0n) - amount);
        if (to !== ZERO) b.set(to, (b.get(to) ?? 0n) + amount);
        if (from === ZERO) s = { ...s, supply: s.supply + amount };
        if (to === ZERO) s = { ...s, supply: s.supply - amount, burned: s.burned + amount };
        transfers.push({ id: id(e), asset: 'T', block: header.number, blockHash: header.hash, txHash: e.ref.txHash, logIndex: e.ref.logIndex, from, to, amount, tokenId: null });
        break;
      }
      default:
        break;
    }
  }
  const balances = cow.balances;
  if (balances) {
    for (const [k, v] of balances) if (v === 0n) balances.delete(k);
  }
  const closedAt = s.closedAtBlock;
  const migratedAt = s.migratedAtBlock;
  const state: CoreBoxState = Object.freeze({
    ...s,
    block: header.number,
    blockHash: header.hash,
    timestamp: header.timestamp,
    phase: phaseAt(header, row.openAt, row.windowEndsAt, closedAt, migratedAt),
    balances: balances ?? s.balances,
    itemsOut: cow.itemsOut ?? s.itemsOut,
    ticketOwners: cow.tickets ?? s.ticketOwners,
    drawTickets: cow.draws ?? s.drawTickets,
  });
  return { state, trades, activity, transfers };
}

/** Raw T held by `address` in this box (from its transfers). */
export function balanceOf(state: CoreBoxState, address: string): bigint {
  return state.balances.get(address.toLowerCase()) ?? 0n;
}

/** Items held by `address` (outside the vault). */
export function itemsOf(state: CoreBoxState, address: string): bigint[] {
  const who = address.toLowerCase();
  return [...state.itemsOut.entries()].filter(([, owner]) => owner === who).map(([id]) => id).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
}

/** Tickets (placeholders and draws) held by `address`. */
export function ticketsOf(state: CoreBoxState, address: string): bigint[] {
  const who = address.toLowerCase();
  return [...state.ticketOwners.entries()].filter(([, owner]) => owner === who).map(([id]) => id).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
}

/** Open draw tickets drawn by `address` (requested or settled, not opened or cancelled), in id order. */
export function drawsOf(state: CoreBoxState, address: string): bigint[] {
  const who = address.toLowerCase();
  return [...state.drawTickets.entries()].filter(([, drawer]) => drawer === who).map(([id]) => id).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
}
