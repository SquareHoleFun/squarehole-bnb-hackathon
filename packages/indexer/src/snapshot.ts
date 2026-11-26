/**
 * What viewers get, built from the indexer's window: the snapshot (served whole and carried in frames), the `block`
 * event and the `reorg` event. Pure functions of the window, the finality tags and the target, so the pipeline only
 * decides WHEN to build them.
 */
import type { PoolTarget } from './config';
import type { Activity, BlockHeader, HeadSource, PoolState, Trade } from './model';
import type { FinalityRecord, StoredBlock } from './store/types';
import {
  activityView,
  curveView,
  headView,
  SNAPSHOT_SCHEMA,
  stateView,
  tradeView,
  windowView,
  type BlockEvent,
  type FinalityView,
  type LiveSnapshot,
  type ReorgEvent,
} from './views';
import type { RecentWindow } from './window';

export const SNAPSHOT_TRADES = 25;
export const SNAPSHOT_ACTIVITY = 20;

export interface HeadInfo {
  readonly source: HeadSource;
  readonly seenAtMs: number;
}

export interface ViewContext {
  readonly target: PoolTarget;
  readonly confirmations: number;
  readonly finality: FinalityRecord;
  readonly window: RecentWindow;
  readonly nowMs: number;
}

/** Same curve numbers (an event then omits the confirmed state: null means "identical to state"). */
export function sameCurve(a: PoolState, b: PoolState): boolean {
  return a.sqrtPriceX96 === b.sqrtPriceX96 && a.swapCount === b.swapCount && a.burnedRaw === b.burnedRaw && a.feesWei === b.feesWei;
}

export function storedHeader(block: StoredBlock): BlockHeader {
  return { number: block.number, hash: block.hash, parentHash: block.parentHash, timestamp: block.timestamp };
}

export function finalityView(ctx: ViewContext, head: bigint): FinalityView {
  return {
    confirmedBlock: (head - BigInt(ctx.confirmations) + 1n).toString(),
    safeBlock: ctx.finality.safe?.toString() ?? null,
    finalizedBlock: ctx.finality.finalized?.toString() ?? null,
  };
}

/** The state `confirmations` deep below `head` (the block itself counts as one). */
export function confirmedStateFor(ctx: ViewContext, head: bigint): PoolState | null {
  const confirmedBlock = head - BigInt(ctx.confirmations) + 1n;
  return confirmedBlock < ctx.window.baseState.block ? null : ctx.window.stateAtOrBefore(confirmedBlock);
}

function confirmedView(ctx: ViewContext, head: bigint, state: PoolState): BlockEvent['confirmed'] {
  const confirmed = confirmedStateFor(ctx, head);
  return confirmed && !sameCurve(confirmed, state) ? stateView(confirmed, ctx.target.curve) : null;
}

export function buildSnapshot(ctx: ViewContext, header: BlockHeader, info: HeadInfo): LiveSnapshot {
  const { target, window } = ctx;
  const confirmed = confirmedStateFor(ctx, header.number);
  return {
    schema: SNAPSHOT_SCHEMA,
    chainId: target.chainId,
    poolId: target.poolId,
    label: target.label,
    tokenSymbol: target.tokenSymbol,
    source: 'indexer',
    head: headView(header, info.source, info.seenAtMs),
    confirmations: ctx.confirmations,
    finality: finalityView(ctx, header.number),
    state: stateView(window.stateAtOrBefore(header.number), target.curve),
    confirmed: confirmed ? stateView(confirmed, target.curve) : null,
    window: windowView(header, target),
    curve: curveView(target.curve),
    trades: window.trades().slice(-SNAPSHOT_TRADES).reverse().map(tradeView),
    activity: window.activity().slice(-SNAPSHOT_ACTIVITY).reverse().map(activityView),
    builtAtMs: ctx.nowMs,
  };
}

export function blockEvent(ctx: ViewContext, id: string, header: BlockHeader, info: HeadInfo, applied: { readonly state: PoolState; readonly trades: readonly Trade[]; readonly activity: readonly Activity[] }, rpcCalls: number): BlockEvent {
  return {
    id,
    head: headView(header, info.source, info.seenAtMs),
    finality: finalityView(ctx, header.number),
    state: stateView(applied.state, ctx.target.curve),
    confirmed: confirmedView(ctx, header.number, applied.state),
    window: windowView(header, ctx.target),
    trades: applied.trades.map(tradeView),
    activity: applied.activity.map(activityView),
    timing: { blockTs: header.timestamp.toString(), seenAtMs: info.seenAtMs, committedAtMs: ctx.nowMs, rpcCalls },
  };
}

/** After the window was rolled back to `ancestor`: the ancestor is the head until the new branch follows. */
export function reorgEvent(ctx: ViewContext, id: string, fromBlock: bigint, ancestor: StoredBlock, dropped: { readonly trades: readonly Trade[]; readonly activity: readonly Activity[] }, info: HeadInfo): ReorgEvent {
  const header = storedHeader(ancestor);
  const state = ctx.window.stateAtOrBefore(ancestor.number);
  return {
    id,
    fromBlock: fromBlock.toString(),
    toBlock: ancestor.number.toString(),
    depth: Number(fromBlock - ancestor.number),
    droppedTradeIds: dropped.trades.map((t) => t.id),
    droppedActivityIds: dropped.activity.map((a) => a.id),
    head: headView(header, info.source, info.seenAtMs),
    finality: finalityView(ctx, ancestor.number),
    state: stateView(state, ctx.target.curve),
    confirmed: confirmedView(ctx, ancestor.number, state),
    window: windowView(header, ctx.target),
  };
}
