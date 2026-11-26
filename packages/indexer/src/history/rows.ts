/**
 * One block result as history rows (S10a § 4), the same for both stores: every row a flat object of strings and small
 * numbers, in a fixed key order, so the memory store and Postgres dump identical rows (BC-078's comparison).
 */
import { indexedRowToJson } from '../core/core-row';
import { candlesFromTrades } from '../core/candles';
import type { CoreBlockResult } from '../core/chain-indexer';
import type { CandleInterval } from '../core/core-gateway';
import type { CoreTrade, TradeRoute } from '../core/derive-core';
import { BATCH_KEYS, DEPTH_KINDS } from './types';

export interface BlockRow {
  readonly chainId: number;
  readonly number: string;
  readonly hash: string;
  readonly parentHash: string;
  readonly timestamp: string;
}

export interface BoxRowRecord {
  readonly chainId: number;
  readonly registry: string;
  readonly boxId: string;
  readonly token: string;
  readonly creationBlock: string;
  readonly shown: boolean;
  readonly reason: string;
  readonly row: string;
}

export interface TradeRow {
  readonly chainId: number;
  readonly block: string;
  readonly logIndex: number;
  readonly blockHash: string;
  readonly txHash: string;
  readonly timestamp: string;
  readonly token: string;
  readonly side: string;
  readonly route: string;
  readonly qRaw: string;
  readonly tRaw: string;
  readonly feeQ: string;
  readonly feeT: string;
  readonly taxQ: string;
  readonly trader: string;
  readonly sqrtPriceX96: string;
  readonly tick: number;
}

export interface ActivityRow {
  readonly chainId: number;
  readonly block: string;
  readonly logIndex: number;
  readonly blockHash: string;
  readonly txHash: string;
  readonly timestamp: string;
  readonly token: string;
  readonly kind: string;
  readonly data: string;
}

export interface BatchRow {
  readonly chainId: number;
  readonly block: string;
  readonly logIndex: number;
  readonly txHash: string;
  readonly token: string;
  readonly values: string;
}

export interface DepthRow {
  readonly chainId: number;
  readonly block: string;
  readonly logIndex: number;
  readonly txHash: string;
  readonly token: string;
  readonly kind: string;
  readonly data: string;
}

export interface TransferRow {
  readonly chainId: number;
  readonly block: string;
  readonly logIndex: number;
  /** The item id for a ConsecutiveTransfer expanded per item; 0 otherwise. */
  readonly sub: string;
  readonly txHash: string;
  readonly token: string;
  readonly asset: string;
  readonly from: string;
  readonly to: string;
  readonly amount: string;
  readonly tokenId: string;
}

export interface BlockRows {
  readonly block: BlockRow;
  readonly boxes: readonly BoxRowRecord[];
  readonly trades: readonly TradeRow[];
  readonly activity: readonly ActivityRow[];
  readonly batches: readonly BatchRow[];
  readonly depth: readonly DepthRow[];
  readonly transfers: readonly TransferRow[];
}

const sortedJson = (value: Readonly<Record<string, unknown>>): string => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));

/** A row as one canonical line (keys sorted). */
export const line = (row: object): string => sortedJson(row as Record<string, unknown>);

/** A row seen by the pipeline as its `boxes` record (shown or not, and why). */
export function boxRecordOf(chainId: number, { row, verdict }: CoreBlockResult['rows'][number]): BoxRowRecord {
  return {
    chainId,
    registry: row.registry.toLowerCase(),
    boxId: row.boxId.toString(),
    token: (row.contracts.token as string).toLowerCase(),
    creationBlock: row.creationBlock.toString(),
    shown: verdict.classification === 'shown',
    reason: verdict.reason ?? '',
    row: JSON.stringify(indexedRowToJson(row)),
  };
}

/** The item rows of a block (or of several, in block order): everything but the block and its new boxes. */
export type ItemRows = Pick<BlockRows, 'trades' | 'activity' | 'batches' | 'depth' | 'transfers'>;

/** Only the given tokens' item rows (lower-case token addresses). */
export function itemRowsFor(rows: ItemRows, tokens: ReadonlySet<string>): ItemRows {
  const mine = <T extends { readonly token: string }>(list: readonly T[]): T[] => list.filter((r) => tokens.has(r.token));
  return { trades: mine(rows.trades), activity: mine(rows.activity), batches: mine(rows.batches), depth: mine(rows.depth), transfers: mine(rows.transfers) };
}

export function rowsOfBlock(result: CoreBlockResult): BlockRows {
  const chainId = result.chainId;
  const b = result.block;
  const block: BlockRow = { chainId, number: b.number.toString(), hash: b.hash.toLowerCase(), parentHash: b.parentHash.toLowerCase(), timestamp: b.timestamp.toString() };
  const boxes: BoxRowRecord[] = result.rows.map((seen) => boxRecordOf(chainId, seen));
  const trades: TradeRow[] = [];
  const activity: ActivityRow[] = [];
  const batches: BatchRow[] = [];
  const depth: DepthRow[] = [];
  const transfers: TransferRow[] = [];
  for (const box of result.boxes) {
    for (const t of box.trades) {
      trades.push({
        chainId,
        block: t.block.toString(),
        logIndex: t.logIndex,
        blockHash: t.blockHash.toLowerCase(),
        txHash: t.txHash.toLowerCase(),
        timestamp: t.timestamp.toString(),
        token: box.token,
        side: t.side,
        route: t.route,
        qRaw: t.qRaw.toString(),
        tRaw: t.tRaw.toString(),
        feeQ: t.feeQ.toString(),
        feeT: t.feeT.toString(),
        taxQ: t.taxQ.toString(),
        trader: t.trader?.toLowerCase() ?? '',
        sqrtPriceX96: t.sqrtPriceX96After.toString(),
        tick: t.tickAfter,
      });
    }
    // Batches: each BatchSplit with its Collected (same transaction); a settlement's split has no Collected.
    const collected = box.activity.filter((a) => a.kind === 'batch' && 'q' in a.data);
    for (const a of box.activity) {
      activity.push({ chainId, block: a.block.toString(), logIndex: a.logIndex, blockHash: a.blockHash.toLowerCase(), txHash: a.txHash.toLowerCase(), timestamp: a.timestamp.toString(), token: box.token, kind: a.kind, data: sortedJson(a.data) });
      if (a.kind === 'batch' && 'qReward' in a.data) {
        const pair = collected.find((c) => c.txHash.toLowerCase() === a.txHash.toLowerCase() && c.logIndex < a.logIndex);
        const merged: Record<string, string> = {};
        for (const key of BATCH_KEYS) merged[key] = String(a.data[key] ?? pair?.data[key] ?? '0');
        batches.push({ chainId, block: a.block.toString(), logIndex: a.logIndex, txHash: a.txHash.toLowerCase(), token: box.token, values: sortedJson(merged) });
      }
      if (DEPTH_KINDS.has(a.kind)) depth.push({ chainId, block: a.block.toString(), logIndex: a.logIndex, txHash: a.txHash.toLowerCase(), token: box.token, kind: a.kind, data: sortedJson(a.data) });
    }
    for (const t of box.transfers) {
      transfers.push({
        chainId,
        block: t.block.toString(),
        logIndex: t.logIndex,
        sub: t.id.split('-')[2] ?? '0',
        txHash: t.txHash.toLowerCase(),
        token: box.token,
        asset: t.asset,
        from: t.from,
        to: t.to,
        amount: t.amount.toString(),
        tokenId: t.tokenId === null ? '' : t.tokenId.toString(),
      });
    }
  }
  return { block, boxes, trades, activity, batches, depth, transfers };
}

/** Candles of one token from its stored trades (the hot path's own function, so both agree). */
export function candlesOfRows(trades: readonly TradeRow[], interval: CandleInterval): ReturnType<typeof candlesFromTrades> {
  return candlesFromTrades(
    trades.map((t) => ({ timestamp: BigInt(t.timestamp), block: BigInt(t.block), logIndex: t.logIndex, sqrtPriceX96After: BigInt(t.sqrtPriceX96), qRaw: BigInt(t.qRaw), route: t.route as TradeRoute })),
    interval,
  );
}

/** A stored trade as the gateway's activity item. */
export function tradeOfRow(t: TradeRow): CoreTrade & { readonly kind: 'trade' } {
  return {
    kind: 'trade',
    id: `${t.block}-${t.logIndex}`,
    block: BigInt(t.block),
    blockHash: t.blockHash as `0x${string}`,
    timestamp: BigInt(t.timestamp),
    txHash: t.txHash as `0x${string}`,
    logIndex: t.logIndex,
    side: t.side as 'buy' | 'sell',
    route: t.route as TradeRoute,
    qRaw: BigInt(t.qRaw),
    tRaw: BigInt(t.tRaw),
    feeQ: BigInt(t.feeQ),
    feeT: BigInt(t.feeT),
    taxQ: BigInt(t.taxQ),
    trader: t.trader === '' ? null : (t.trader as `0x${string}`),
    sqrtPriceX96After: BigInt(t.sqrtPriceX96),
    tickAfter: t.tick,
  };
}
