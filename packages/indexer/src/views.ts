/**
 * The JSON the gateway serves (snapshot and SSE events). Amounts are decimal strings: `…Wei`/`…Raw` fields are exact
 * raw integers, their display twins (`retainedEth`, `sold`, …) are truncated decimals. Block numbers and timestamps are
 * strings as well. Only bounded integers are JSON numbers.
 *
 * Tiers (research § 3.3): a row is `head` in the newest block ("not final"), `confirmed` once `confirmations` deep,
 * `safe` / `finalized` once the chain's tags pass it. The client recomputes the tier from `head.number` and
 * `finality` on every event, so rows age without being resent.
 */
import { toDecimalString, rational } from '@squarehole/chain';
import type { DecimalAmount } from '@squarehole/domain';
import type { Hex } from 'viem';
import type { PoolTarget } from './config';
import { curvePoint, priceDecimal, units18, type CurveShape } from './curve';
import { OPEN_DELAY_BLOCKS, type Activity, type BlockHeader, type HeadSource, type LaunchPhase, type PoolState, type Trade } from './model';

/** Blocks from the completion to the earliest graduation (FitLaunchShape.LATCH_BLOCKS). */
const LATCH_BLOCKS = 32n;
import { LAUNCH_TAX_TABLE_PIPS, PIPS, taxPipsAt } from './shape';

export const SNAPSHOT_SCHEMA = 'sh.live-pool.v1';
export const SLOT_SECONDS = 12n;

export type Tier = 'head' | 'confirmed' | 'safe' | 'finalized';

export interface FinalityView {
  readonly confirmedBlock: string;
  readonly safeBlock: string | null;
  readonly finalizedBlock: string | null;
}

export function tierOf(block: bigint, head: bigint, confirmations: number, safe: bigint | null, finalized: bigint | null): Tier {
  if (finalized !== null && block <= finalized) return 'finalized';
  if (safe !== null && block <= safe) return 'safe';
  if (head - block + 1n >= BigInt(confirmations)) return 'confirmed';
  return 'head';
}

export interface StateView {
  readonly block: string;
  readonly blockHash: Hex;
  readonly timestamp: string;
  readonly phase: 'CURVE_ACTIVE' | 'TARGET_REACHED';
  readonly sqrtPriceX96: string;
  readonly tick: number;
  readonly priceEthPerToken: DecimalAmount;
  readonly retainedWei: string;
  readonly retainedEth: DecimalAmount;
  readonly soldRaw: string;
  readonly sold: DecimalAmount;
  readonly leftRaw: string;
  readonly fillBps: number;
  readonly curveBps: number;
  readonly swapCount: number;
  readonly buyCount: number;
  readonly sellCount: number;
  readonly volumeWei: string;
  readonly feesWei: string;
  readonly feesTokenRaw: string;
  readonly taxWei: string;
  readonly burnedRaw: string;
  readonly burned: DecimalAmount;
  readonly lastTradeBlock: string | null;
  readonly anomalies: number;
  /** From the hook's events: curve, completed (not "sold out": a sell can reopen it) or migrated. The curve figures
   * above (fill, retained, sold) describe the pre-market curve only and mean nothing once it is `migrated`. */
  readonly launchPhase: LaunchPhase;
  readonly completedBlock: string | null;
  /** The earliest graduation block while `completed` (the completion's block + 32), else null. */
  readonly graduatesFromBlock: string | null;
  readonly migratedBlock: string | null;
  /** The first block of outside liquidity (the migration + 32), else null. */
  readonly liquidityOpensAtBlock: string | null;
}

/** The state on the pool's own curve (each deployment keeps its shape: the target's `curve`). */
export function stateView(state: PoolState, shape: CurveShape): StateView {
  const point = curvePoint(state.sqrtPriceX96, shape);
  return {
    block: state.block.toString(),
    blockHash: state.blockHash,
    timestamp: state.timestamp.toString(),
    phase: point.fillBps >= 10_000 ? 'TARGET_REACHED' : 'CURVE_ACTIVE',
    sqrtPriceX96: state.sqrtPriceX96.toString(),
    tick: state.tick,
    priceEthPerToken: priceDecimal(state.sqrtPriceX96),
    retainedWei: point.retainedWei.toString(),
    retainedEth: units18(point.retainedWei),
    soldRaw: point.soldRaw.toString(),
    sold: units18(point.soldRaw),
    leftRaw: point.leftRaw.toString(),
    fillBps: point.fillBps,
    curveBps: point.curveBps,
    swapCount: state.swapCount,
    buyCount: state.buyCount,
    sellCount: state.sellCount,
    volumeWei: state.volumeWei.toString(),
    feesWei: state.feesWei.toString(),
    feesTokenRaw: state.feesTokenRaw.toString(),
    taxWei: state.taxWei.toString(),
    burnedRaw: state.burnedRaw.toString(),
    burned: units18(state.burnedRaw),
    lastTradeBlock: state.lastTradeBlock === null ? null : state.lastTradeBlock.toString(),
    anomalies: state.anomalies,
    launchPhase: state.phase,
    completedBlock: state.completedBlock === null ? null : state.completedBlock.toString(),
    graduatesFromBlock: state.phase === 'completed' && state.completedBlock !== null ? (state.completedBlock + LATCH_BLOCKS).toString() : null,
    migratedBlock: state.migratedBlock === null ? null : state.migratedBlock.toString(),
    liquidityOpensAtBlock: state.migratedBlock === null ? null : (state.migratedBlock + OPEN_DELAY_BLOCKS).toString(),
  };
}

export interface TradeView {
  readonly id: string;
  readonly score: number;
  readonly block: string;
  readonly blockHash: Hex;
  readonly timestamp: string;
  readonly txHash: Hex;
  readonly logIndex: number;
  readonly side: Trade['side'];
  readonly route: Trade['route'];
  readonly ethRaw: string;
  readonly eth: DecimalAmount;
  readonly tokenRaw: string;
  readonly tokens: DecimalAmount;
  readonly feeEthRaw: string;
  readonly feeTokenRaw: string;
  readonly taxRaw: string;
  readonly trader: string | null;
  readonly recipient: string | null;
  readonly priceAfterEthPerToken: DecimalAmount;
  readonly tickAfter: number;
  readonly retainedAfterWei: string;
  readonly fillBpsAfter: number;
}

export function tradeView(trade: Trade): TradeView {
  return {
    id: trade.id,
    score: trade.score,
    block: trade.block.toString(),
    blockHash: trade.blockHash,
    timestamp: trade.timestamp.toString(),
    txHash: trade.txHash,
    logIndex: trade.logIndex,
    side: trade.side,
    route: trade.route,
    ethRaw: trade.ethRaw.toString(),
    eth: units18(trade.ethRaw),
    tokenRaw: trade.tokenRaw.toString(),
    tokens: units18(trade.tokenRaw),
    feeEthRaw: trade.feeEthRaw.toString(),
    feeTokenRaw: trade.feeTokenRaw.toString(),
    taxRaw: trade.taxRaw.toString(),
    trader: trade.trader,
    recipient: trade.recipient,
    priceAfterEthPerToken: priceDecimal(trade.sqrtPriceX96After),
    tickAfter: trade.tickAfter,
    retainedAfterWei: trade.retainedAfterWei.toString(),
    fillBpsAfter: trade.fillBpsAfter,
  };
}

export interface ActivityView {
  readonly id: string;
  readonly score: number;
  readonly kind: Activity['kind'];
  readonly detail: string;
  readonly block: string;
  readonly blockHash: Hex;
  readonly timestamp: string;
  readonly txHash: Hex;
  readonly amountRaw: string;
  readonly amount: DecimalAmount;
  readonly ethRaw: string;
}

export function activityView(row: Activity): ActivityView {
  return {
    id: row.id,
    score: row.score,
    kind: row.kind,
    detail: row.detail,
    block: row.block.toString(),
    blockHash: row.blockHash,
    timestamp: row.timestamp.toString(),
    txHash: row.txHash,
    amountRaw: row.amountRaw.toString(),
    amount: units18(row.amountRaw),
    ethRaw: row.ethRaw.toString(),
  };
}

export interface WindowView {
  readonly openBlock: string;
  readonly closeBlock: string;
  /** Relative to the NEXT block (the earliest a transaction sent now can land in). */
  readonly status: 'before_open' | 'router_window' | 'open';
  readonly nextBlock: string;
  /** Blocks until the open block (0 once the next block is in the window or later). */
  readonly blocksToOpen: string;
  /** Window blocks left, the next block included (32 when the next block is the open block; 0 after). */
  readonly blocksToClose: string;
  readonly nextBlockTaxPips: number;
  readonly nextBlockTaxPercent: DecimalAmount;
  readonly startTaxPips: number;
  readonly endTaxPips: number;
  /** Blocks × 12 s from the head's timestamp: an estimate; missed slots push it later. */
  readonly etaOpenUnix: string | null;
  readonly etaCloseUnix: string | null;
}

export function windowView(head: BlockHeader, target: Pick<PoolTarget, 'openBlock' | 'closeBlock'>): WindowView {
  const next = head.number + 1n;
  const status = next < target.openBlock ? 'before_open' : next < target.closeBlock ? 'router_window' : 'open';
  const toOpen = target.openBlock > next ? target.openBlock - next : 0n;
  const toClose = target.closeBlock > next ? target.closeBlock - next : 0n;
  const pips = next >= target.openBlock ? taxPipsAt(next - target.openBlock) : 0;
  const eta = (blocks: bigint): string | null => (blocks > 0n ? (head.timestamp + (blocks + 1n) * SLOT_SECONDS).toString() : null);
  return {
    openBlock: target.openBlock.toString(),
    closeBlock: target.closeBlock.toString(),
    status,
    nextBlock: next.toString(),
    blocksToOpen: toOpen.toString(),
    blocksToClose: toClose.toString(),
    nextBlockTaxPips: pips,
    nextBlockTaxPercent: toDecimalString(rational(BigInt(pips) * 100n, BigInt(PIPS)), 4),
    startTaxPips: LAUNCH_TAX_TABLE_PIPS[0] ?? 0,
    endTaxPips: LAUNCH_TAX_TABLE_PIPS.at(-1) ?? 0,
    etaOpenUnix: status === 'before_open' ? eta(toOpen) : null,
    etaCloseUnix: status !== 'open' ? eta(toClose) : null,
  };
}

export interface CurveView {
  readonly note: string;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly startPriceEthPerToken: DecimalAmount;
  readonly completionPriceEthPerToken: DecimalAmount;
  readonly raiseWei: string;
  readonly targetWei: string;
  readonly tokensDepositedRaw: string;
  readonly liquidity: string;
}

export function curveView(shape: CurveShape): CurveView {
  return {
    note: "From the deployed contract's constants; a shape, not history.",
    tickLower: shape.tickLower,
    tickUpper: shape.tickUpper,
    startPriceEthPerToken: priceDecimal(shape.sqrtPriceUpperX96),
    completionPriceEthPerToken: priceDecimal(shape.sqrtPriceLowerX96),
    raiseWei: shape.raiseWei.toString(),
    targetWei: shape.targetWei.toString(),
    tokensDepositedRaw: shape.tokensDeposited.toString(),
    liquidity: shape.liquidity.toString(),
  };
}

export interface HeadView {
  readonly number: string;
  readonly hash: Hex;
  readonly parentHash: Hex;
  readonly timestamp: string;
  readonly source: HeadSource;
  readonly seenAtMs: number;
}

export function headView(head: BlockHeader, source: HeadSource, seenAtMs: number): HeadView {
  return { number: head.number.toString(), hash: head.hash, parentHash: head.parentHash, timestamp: head.timestamp.toString(), source, seenAtMs };
}

export interface LiveSnapshot {
  readonly schema: typeof SNAPSHOT_SCHEMA;
  readonly chainId: number;
  readonly poolId: Hex;
  readonly label: string;
  readonly tokenSymbol: string;
  readonly source: 'indexer';
  readonly head: HeadView;
  readonly confirmations: number;
  readonly finality: FinalityView;
  readonly state: StateView;
  readonly confirmed: StateView | null;
  readonly window: WindowView;
  readonly curve: CurveView;
  readonly trades: readonly TradeView[];
  readonly activity: readonly ActivityView[];
  readonly builtAtMs: number;
}

export interface BlockEvent {
  readonly id: string;
  readonly head: HeadView;
  readonly finality: FinalityView;
  readonly state: StateView;
  /** Present only when the confirmed block's state differs from the head's (a trade in the newest block). */
  readonly confirmed: StateView | null;
  readonly window: WindowView;
  readonly trades: readonly TradeView[];
  readonly activity: readonly ActivityView[];
  readonly timing: { readonly blockTs: string; readonly seenAtMs: number; readonly committedAtMs: number; readonly rpcCalls: number };
}

export interface ReorgEvent {
  readonly id: string;
  readonly fromBlock: string;
  readonly toBlock: string;
  readonly depth: number;
  readonly droppedTradeIds: readonly string[];
  readonly droppedActivityIds: readonly string[];
  /** The ancestor: the head until the new branch's blocks follow as ordinary `block` events. */
  readonly head: HeadView;
  readonly finality: FinalityView;
  readonly state: StateView;
  /** As in a block event: null when the confirmed state equals `state`. */
  readonly confirmed: StateView | null;
  readonly window: WindowView;
}

/**
 * Everything before this is superseded: the indexer re-wrote history without streaming it (a cold start, a long gap,
 * a rebuild, an audit or verification repair), or a gateway lost frames. The frame carries the new snapshot, which a
 * gateway sends right after as a `snapshot` event; a client replaces its whole view with it.
 */
export interface ResyncEvent {
  readonly id: string;
  readonly reason: string;
  readonly head: HeadView;
}

/** Traders resolved after their block went out (the sender lookup ran past its budget or was retried). */
export interface TradersEvent {
  readonly id: string;
  readonly block: string;
  readonly blockHash: Hex;
  readonly traders: readonly { readonly id: string; readonly trader: string }[];
}

/** The indexer's own status (in its frames and heartbeat); gateways turn it into their `status` event. */
export interface IndexerStatus {
  readonly verified: boolean | null;
  readonly catchingUp: boolean;
  readonly head: string | null;
  readonly atMs: number;
}
