/**
 * Folds one block's decoded events into the pool state. Pure: the same (previous state, header, events, tx senders)
 * always gives the same result, which is what makes a reorg rollback exact (re-apply from the ancestor's state).
 *
 * Pairing rules (log order inside a transaction, PoolManager.sol:241 and FitPoolHook.afterSwap):
 * Swap → ModifyLiquidity(Δ0, hook) → PoolFeesRealised → (ERC-6909 mints) → … → TaxedBuy / Bootstrapped (after the
 * router's unlock returns). So a PoolFeesRealised belongs to the latest earlier Swap of the same transaction, and a
 * TaxedBuy or Bootstrapped to the latest earlier router Swap of the same transaction.
 */
import type { Address, Hex } from 'viem';
import { curvePoint, type CurveShape } from './curve';
import type { DecodedEvent } from './events';
import { OPEN_DELAY_BLOCKS, scoreOf, type Activity, type BlockHeader, type LaunchPhase, type PoolState, type Trade } from './model';

export interface DeriveContext {
  readonly launchRouter: Address;
  readonly hook: Address;
  readonly genesis: Address;
  readonly collector: Address;
  readonly executor: Address;
  /** The pool's deployed curve (the target's `curve`): trades are priced on it. */
  readonly shape: CurveShape;
}

export interface BlockResult {
  readonly state: PoolState;
  readonly trades: readonly Trade[];
  readonly activity: readonly Activity[];
}

const ZERO: Address = '0x0000000000000000000000000000000000000000';
const ZERO_SALT: Hex = '0x0000000000000000000000000000000000000000000000000000000000000000';
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const abs = (value: bigint): bigint => (value < 0n ? -value : value);
/** Addresses in the data are lowercase (RPC answers are; decoded event args are checksummed). */
const lower = (address: Address | null): Address | null => (address ? (address.toLowerCase() as Address) : null);

/** The state before the pool exists: the curve's start price, nothing sold, nothing burned. */
export function initialPoolState(header: BlockHeader, shape: CurveShape): PoolState {
  return {
    block: header.number,
    blockHash: header.hash,
    timestamp: header.timestamp,
    sqrtPriceX96: shape.sqrtPriceUpperX96,
    tick: shape.tickUpper,
    liquidity: 0n,
    swapCount: 0,
    buyCount: 0,
    sellCount: 0,
    volumeWei: 0n,
    feesWei: 0n,
    feesTokenRaw: 0n,
    taxWei: 0n,
    burnedRaw: 0n,
    lastTradeBlock: null,
    anomalies: 0,
    phase: 'curve',
    completedBlock: null,
    migratedBlock: null,
  };
}

function burnSource(from: Address, ctx: DeriveContext): string {
  if (same(from, ctx.genesis)) return 'bootstrap';
  if (same(from, ctx.collector)) return 'collector';
  if (same(from, ctx.executor)) return 'executor';
  return 'holder';
}

type MutableTrade = { -readonly [K in keyof Trade]: Trade[K] };

export function applyBlock(
  previous: PoolState,
  header: BlockHeader,
  events: readonly DecodedEvent[],
  senders: ReadonlyMap<Hex, Address>,
  ctx: DeriveContext,
): BlockResult {
  if (header.number <= previous.block && previous.block !== 0n) {
    throw new RangeError(`block ${header.number} does not follow state block ${previous.block}`);
  }
  const shape = ctx.shape;
  let sqrtPriceX96 = previous.sqrtPriceX96;
  let tick = previous.tick;
  let liquidity = previous.liquidity;
  let swapCount = previous.swapCount;
  let buyCount = previous.buyCount;
  let sellCount = previous.sellCount;
  let volumeWei = previous.volumeWei;
  let feesWei = previous.feesWei;
  let feesTokenRaw = previous.feesTokenRaw;
  let taxWei = previous.taxWei;
  let burnedRaw = previous.burnedRaw;
  let lastTradeBlock = previous.lastTradeBlock;
  let anomalies = previous.anomalies;
  let phase: LaunchPhase = previous.phase;
  let completedBlock = previous.completedBlock;
  let migratedBlock = previous.migratedBlock;
  // The migration's own liquidity logs (M1, M3) come before its `Migrated` event in the same transaction.
  const migrationTxs = new Set(events.filter((e) => e.kind === 'migrated').map((e) => e.ref.txHash));

  const trades: MutableTrade[] = [];
  const activity: Activity[] = [];
  const activityOf = (event: DecodedEvent, kind: Activity['kind'], detail: string, amountRaw: bigint, ethRaw: bigint): Activity => ({
    id: `${event.ref.blockHash}:${event.ref.logIndex}`,
    score: scoreOf(event.ref.blockNumber, event.ref.logIndex),
    kind,
    block: header.number,
    blockHash: header.hash,
    timestamp: header.timestamp,
    txHash: event.ref.txHash,
    logIndex: event.ref.logIndex,
    detail,
    amountRaw,
    ethRaw,
  });
  const lastTradeInTx = (txHash: Hex, predicate: (trade: MutableTrade) => boolean): MutableTrade | undefined => {
    for (let i = trades.length - 1; i >= 0; i -= 1) {
      const trade = trades[i];
      if (trade && trade.txHash === txHash && predicate(trade)) return trade;
    }
    return undefined;
  };

  for (const event of events) {
    if (event.ref.blockHash !== header.hash) throw new Error(`log from block ${event.ref.blockHash}, expected ${header.hash}`);
    switch (event.kind) {
      case 'initialize':
        sqrtPriceX96 = event.sqrtPriceX96;
        tick = event.tick;
        break;
      case 'pool_launched':
        liquidity = event.liquidity;
        break;
      case 'swap': {
        const buy = event.amount0 < 0n;
        sqrtPriceX96 = event.sqrtPriceX96;
        tick = event.tick;
        liquidity = event.liquidity;
        swapCount += 1;
        if (buy) buyCount += 1;
        else sellCount += 1;
        volumeWei += abs(event.amount0);
        lastTradeBlock = header.number;
        const point = curvePoint(event.sqrtPriceX96, shape);
        trades.push({
          id: `${event.ref.blockHash}:${event.ref.logIndex}`,
          score: scoreOf(event.ref.blockNumber, event.ref.logIndex),
          block: header.number,
          blockHash: header.hash,
          timestamp: header.timestamp,
          txHash: event.ref.txHash,
          logIndex: event.ref.logIndex,
          side: buy ? 'buy' : 'sell',
          route: same(event.sender, ctx.launchRouter) ? 'launch_router' : 'other',
          ethRaw: abs(event.amount0),
          tokenRaw: abs(event.amount1),
          feeEthRaw: 0n,
          feeTokenRaw: 0n,
          taxRaw: 0n,
          trader: lower(senders.get(event.ref.txHash) ?? null),
          recipient: null,
          sqrtPriceX96After: event.sqrtPriceX96,
          tickAfter: event.tick,
          retainedAfterWei: point.retainedWei,
          fillBpsAfter: point.fillBps,
        });
        break;
      }
      case 'fees_realised': {
        feesWei += event.ethFee;
        feesTokenRaw += event.tokenFee;
        const trade = lastTradeInTx(event.ref.txHash, (t) => t.logIndex < event.ref.logIndex && t.feeEthRaw === 0n && t.feeTokenRaw === 0n);
        if (trade) {
          trade.feeEthRaw = event.ethFee;
          trade.feeTokenRaw = event.tokenFee;
        }
        break;
      }
      case 'taxed_buy': {
        taxWei += event.tax;
        const trade = lastTradeInTx(event.ref.txHash, (t) => t.route === 'launch_router' && t.side === 'buy' && t.taxRaw === 0n && t.recipient === null);
        if (trade) {
          trade.taxRaw = event.tax;
          trade.recipient = lower(event.recipient);
          // The router's msg.sender: the wallet (or smart wallet) that bought, with no lookup; tx.from would name a
          // relayer or a bundler for a sponsored or smart-wallet buy.
          trade.trader = lower(event.buyer);
        }
        break;
      }
      case 'bootstrapped': {
        const trade = lastTradeInTx(event.ref.txHash, (t) => t.route === 'launch_router' && t.side === 'buy' && t.recipient === null);
        if (trade) {
          trade.route = 'bootstrap';
          trade.recipient = lower(event.recipient);
        }
        break;
      }
      case 'transfer':
        if (same(event.to, ZERO) && event.amount > 0n) {
          burnedRaw += event.amount;
          activity.push(activityOf(event, 'burn', burnSource(event.from, ctx), event.amount, 0n));
        }
        break;
      case 'flushed':
        activity.push(activityOf(event, 'flush', 'collector', event.tokensBurned, event.ethToIntake + event.ethToBudget));
        break;
      case 'swept':
        activity.push(activityOf(event, 'sweep', 'launch_router', 0n, event.amount));
        break;
      case 'window_announced':
        activity.push(activityOf(event, 'window_announced', `${event.openBlock}-${event.closeBlock}`, 0n, 0n));
        break;
      case 'curve_completed':
        // A block ended at or beyond P1 (ADR-0013 § 2.3b); emitted by a later block's first action. Not "sold out".
        if (phase !== 'migrated') {
          phase = 'completed';
          completedBlock = event.completedBlock;
        }
        activity.push(activityOf(event, 'curve_completed', `${event.completedBlock}`, 0n, 0n));
        break;
      case 'curve_reopened':
        // A block ended more than 600 ticks back inside the curve: the 32 blocks start again at the next completion.
        if (phase !== 'migrated') {
          phase = 'curve';
          completedBlock = null;
        }
        activity.push(activityOf(event, 'curve_reopened', `${event.reopenedBlock}`, 0n, 0n));
        break;
      case 'migrated':
        // The migration (M1-M3); its own ModifyLiquidity logs are exempt from the anomaly rule below.
        phase = 'migrated';
        migratedBlock = header.number;
        activity.push(
          activityOf(event, 'migration', `bid:${event.bidLiquidity},sentinel:${event.sentinelLiquidity},ask:${event.askLiquidity}`, event.tokenPulled, event.ethFromCurve),
        );
        break;
      case 'donate':
        anomalies += 1;
        activity.push(activityOf(event, 'anomaly', 'donate', event.amount1, event.amount0));
        break;
      case 'modify_liquidity': {
        // The hook's per-swap fee collection is Δ = 0 from the hook; the seed is the hook's one positive Δ in the
        // genesis (PoolLaunched carries L); the migration's M1 and M3 are the hook's own changes in the transaction
        // that emits `Migrated`; outside positions are allowed from the migration + 32 blocks (the hook refuses them
        // before). Anything else cannot pass the hook and is flagged.
        const hookOwned = same(event.sender, ctx.hook);
        const seed = hookOwned && event.liquidityDelta > 0n && previous.liquidity === 0n && previous.phase === 'curve' && event.salt === ZERO_SALT;
        const migration = hookOwned && migrationTxs.has(event.ref.txHash);
        const outsideOpen = !hookOwned && migratedBlock !== null && header.number >= migratedBlock + OPEN_DELAY_BLOCKS;
        if (event.liquidityDelta !== 0n && !(seed || migration || outsideOpen)) {
          anomalies += 1;
          activity.push(activityOf(event, 'anomaly', 'modify_liquidity', 0n, 0n));
        }
        break;
      }
      case 'fee_notify_failed':
      case 'executor_burn':
      case 'other':
        break;
    }
  }

  const state: PoolState = {
    block: header.number,
    blockHash: header.hash,
    timestamp: header.timestamp,
    sqrtPriceX96,
    tick,
    liquidity,
    swapCount,
    buyCount,
    sellCount,
    volumeWei,
    feesWei,
    feesTokenRaw,
    taxWei,
    burnedRaw,
    lastTradeBlock,
    anomalies,
    phase,
    completedBlock,
    migratedBlock,
  };
  return { state, trades, activity };
}
