/**
 * The history store in memory (tests, a single process without Postgres): the same rows, keys and rules as Postgres
 * (pg-history.ts), checked by the one contract test.
 */
import type { CoreBlockResult } from '../core/chain-indexer';
import type { ActivityPage, Candle, CandleInterval } from '../core/core-gateway';
import { CANDLE_INTERVALS, CANDLE_LIMIT } from '../core/core-gateway';
import { candlesOfRows, itemRowsFor, line, rowsOfBlock, tradeOfRow, type ActivityRow, type BatchRow, type BlockRow, type BoxRowRecord, type DepthRow, type ItemRows, type TradeRow, type TransferRow } from './rows';
import { PICTURE_HIDDEN_PREFIX, type HistoryDump, type HistoryStore, type PictureHiddenBox } from './types';
import type { HistoryActivityOptions } from './types';
import { missingTraders, withTradersV2 } from './activity-traders';

interface ChainTables {
  blocks: Map<string, BlockRow>;
  boxes: Map<string, BoxRowRecord>;
  trades: Map<string, TradeRow>;
  activity: Map<string, ActivityRow>;
  batches: Map<string, BatchRow>;
  depth: Map<string, DepthRow>;
  transfers: Map<string, TransferRow>;
  /** `${token}|${asset}|${holder}` → amount. */
  balances: Map<string, bigint>;
  /** `${token}|${asset}|${id}` → owner. */
  items: Map<string, string>;
  cursor: { block: bigint; hash: string } | null;
  /** Replay markers (SH-NO-PICTURE-GATE upgrade), by `${registry}:${boxId}`. */
  replays: Map<string, PictureHiddenBox>;
}

const key = (block: string, logIndex: number, sub = ''): string => `${block.padStart(20, '0')}:${String(logIndex).padStart(6, '0')}${sub ? `:${sub.padStart(8, '0')}` : ''}`;
const ZERO = '0x0000000000000000000000000000000000000000';

/** Applies a transfer to balances and owners (sign +1), or undoes it (sign -1). Shared rule with Postgres. */
export function applyTransfer(t: TransferRow, sign: 1 | -1, balances: Map<string, bigint>, items: Map<string, string>): void {
  if (t.asset === 'T') {
    const amount = BigInt(t.amount) * BigInt(sign);
    if (t.from !== ZERO) balances.set(`${t.token}|T|${t.from}`, (balances.get(`${t.token}|T|${t.from}`) ?? 0n) - amount);
    if (t.to !== ZERO) balances.set(`${t.token}|T|${t.to}`, (balances.get(`${t.token}|T|${t.to}`) ?? 0n) + amount);
    for (const k of [`${t.token}|T|${t.from}`, `${t.token}|T|${t.to}`]) if (balances.get(k) === 0n) balances.delete(k);
    return;
  }
  const k = `${t.token}|${t.asset}|${t.tokenId}`;
  const owner = sign === 1 ? t.to : t.from;
  if (owner === ZERO) items.delete(k);
  else items.set(k, owner);
}

export class MemoryHistory implements HistoryStore {
  readonly kind = 'memory' as const;
  private generation = 0n;
  get version(): bigint { return this.generation; }
  private readonly chains = new Map<number, ChainTables>();

  private tables(chainId: number): ChainTables {
    let t = this.chains.get(chainId);
    if (!t) {
      t = { blocks: new Map(), boxes: new Map(), trades: new Map(), activity: new Map(), batches: new Map(), depth: new Map(), transfers: new Map(), balances: new Map(), items: new Map(), cursor: null, replays: new Map() };
      this.chains.set(chainId, t);
    }
    return t;
  }

  async init(): Promise<void> {}

  async writeBlock(result: CoreBlockResult, fill?: ReadonlySet<string>): Promise<void> {
    const t = this.tables(result.chainId);
    const number = result.block.number.toString();
    const existing = t.blocks.get(number.padStart(20, '0'));
    if (existing && existing.hash === result.block.hash.toLowerCase()) {
      if (fill && fill.size > 0) {
        const rows = rowsOfBlock(result);
        for (const b of rows.boxes) if (fill.has(b.token) && !t.boxes.has(`${b.registry}:${b.boxId.padStart(20, '0')}`)) t.boxes.set(`${b.registry}:${b.boxId.padStart(20, '0')}`, b);
        this.insert(t, itemRowsFor(rows, fill));
      }
      this.generation += 1n;
      return;
    }
    if (existing) this.undoIn(result.chainId, result.block.number - 1n);
    const rows = rowsOfBlock(result);
    t.blocks.set(number.padStart(20, '0'), rows.block);
    for (const b of rows.boxes) if (!t.boxes.has(`${b.registry}:${b.boxId.padStart(20, '0')}`)) t.boxes.set(`${b.registry}:${b.boxId.padStart(20, '0')}`, b);
    this.insert(t, rows);
    t.cursor = { block: result.block.number, hash: result.block.hash.toLowerCase() };
    this.generation += 1n;
  }

  async pictureHidden(): Promise<readonly PictureHiddenBox[]> {
    const out = new Map<string, PictureHiddenBox>();
    for (const [chainId, t] of this.chains) {
      for (const b of t.boxes.values()) if (!b.shown && b.reason.startsWith(PICTURE_HIDDEN_PREFIX)) out.set(`${chainId}:${b.registry}:${b.boxId}`, { chainId, registry: b.registry, boxId: b.boxId, token: b.token });
      for (const b of t.replays.values()) out.set(`${chainId}:${b.registry}:${b.boxId}`, b);
    }
    return [...out.values()];
  }

  async startReplay(chainId: number, boxes: readonly PictureHiddenBox[]): Promise<bigint> {
    const t = this.tables(chainId);
    for (const b of boxes) t.replays.set(`${b.registry}:${b.boxId}`, b);
    const tokens = new Set(boxes.map((b) => b.token));
    const keys = new Set(boxes.map((b) => `${b.registry}:${b.boxId.padStart(20, '0')}`));
    for (const k of keys) t.boxes.delete(k);
    for (const map of [t.trades, t.activity, t.batches, t.depth, t.transfers] as Map<string, { token: string }>[]) for (const [k, r] of [...map]) if (tokens.has(r.token)) map.delete(k);
    for (const map of [t.balances, t.items] as Map<string, unknown>[]) for (const k of [...map.keys()]) if (tokens.has(k.split('|')[0] ?? '')) map.delete(k);
    this.generation += 1n;
    return [...t.blocks.values()].reduce((n, b) => (BigInt(b.number) > n ? BigInt(b.number) : n), 0n);
  }

  async finishReplay(chainId: number, boxes: readonly PictureHiddenBox[]): Promise<void> {
    const t = this.tables(chainId);
    for (const b of boxes) t.replays.delete(`${b.registry}:${b.boxId}`);
    this.generation += 1n;
  }

  /** Item rows by key (a row held already is kept), balances and owners by the new transfers, in order. */
  private insert(t: ChainTables, rows: ItemRows): void {
    for (const r of rows.trades) if (!t.trades.has(key(r.block, r.logIndex))) t.trades.set(key(r.block, r.logIndex), r);
    for (const r of rows.activity) if (!t.activity.has(key(r.block, r.logIndex))) t.activity.set(key(r.block, r.logIndex), r);
    for (const r of rows.batches) if (!t.batches.has(key(r.block, r.logIndex))) t.batches.set(key(r.block, r.logIndex), r);
    for (const r of rows.depth) if (!t.depth.has(key(r.block, r.logIndex))) t.depth.set(key(r.block, r.logIndex), r);
    for (const r of rows.transfers) {
      const k = key(r.block, r.logIndex, r.sub);
      if (t.transfers.has(k)) continue;
      t.transfers.set(k, r);
      applyTransfer(r, 1, t.balances, t.items);
    }
  }

  async undoAbove(chainId: number, block: bigint): Promise<void> {
    this.undoIn(chainId, block);
    this.generation += 1n;
  }

  private undoIn(chainId: number, block: bigint): void {
    const t = this.tables(chainId);
    const above = (b: string): boolean => BigInt(b) > block;
    const removed = [...t.transfers.entries()].filter(([, r]) => above(r.block)).sort(([a], [b]) => (a < b ? 1 : -1));
    for (const [k, r] of removed) {
      applyTransfer(r, -1, t.balances, t.items);
      t.transfers.delete(k);
    }
    for (const map of [t.trades, t.activity, t.batches, t.depth] as Map<string, { block: string }>[]) for (const [k, r] of [...map]) if (above(r.block)) map.delete(k);
    for (const [k, r] of [...t.boxes]) if (above(r.creationBlock)) t.boxes.delete(k);
    for (const [k, r] of [...t.blocks]) if (above(r.number)) t.blocks.delete(k);
    const newest = [...t.blocks.values()].sort((a, b) => (BigInt(a.number) < BigInt(b.number) ? 1 : -1))[0];
    t.cursor = newest ? { block: BigInt(newest.number), hash: newest.hash } : null;
  }

  async wipe(chainId: number): Promise<void> {
    this.chains.delete(chainId);
    this.generation += 1n;
  }

  async cursor(chainId: number): Promise<{ block: bigint; hash: string } | null> {
    return this.tables(chainId).cursor;
  }

  async activityPage(chainId: number, token: string, options: HistoryActivityOptions): Promise<ActivityPage['items']> {
    const t = this.tables(chainId);
    const who = token.toLowerCase();
    const [bb, bl] = options.before?.split('-') ?? [];
    const beforeKey = options.before ? key(bb ?? '0', Number(bl ?? '0')) : null;
    const rows: { k: string; item: ActivityPage['items'][number] }[] = [];
    if (options.kind === null || options.kind === 'trade') {
      for (const [k, r] of t.trades) if (r.token === who && (beforeKey === null || k < beforeKey)) rows.push({ k, item: tradeOfRow(r) });
    }
    if (options.kind !== 'trade') {
      for (const [k, r] of t.activity) {
        if (r.token !== who || (options.kind !== null && r.kind !== options.kind) || (beforeKey !== null && k >= beforeKey)) continue;
        rows.push({ k, item: { id: `${r.block}-${r.logIndex}`, kind: r.kind as never, block: BigInt(r.block), blockHash: r.blockHash as `0x${string}`, timestamp: BigInt(r.timestamp), txHash: r.txHash as `0x${string}`, logIndex: r.logIndex, data: JSON.parse(r.data) as Record<string, string> } });
      }
    }
    const page = rows.sort((a, b) => (a.k < b.k ? 1 : -1)).slice(0, options.limit).map((r) => r.item);
    if (!options.v2Contracts) return page;
    const missing = new Set(missingTraders(page).map(item => `${item.block}:${item.txHash.toLowerCase()}`));
    const transfers = [...t.transfers.values()].filter(t => t.token === who && t.asset === 'T' && missing.has(`${t.block}:${t.txHash}`))
      .map(t => ({ txHash: t.txHash, from: t.from, to: t.to, amount: BigInt(t.amount) }));
    return withTradersV2(page, transfers, options.v2Contracts);
  }

  async candles(chainId: number, token: string, interval: CandleInterval, limit = CANDLE_LIMIT): Promise<readonly Candle[]> {
    const who = token.toLowerCase();
    return candlesOfRows([...this.tables(chainId).trades.values()].filter((r) => r.token === who), interval).slice(-limit);
  }

  async dump(chainId: number): Promise<HistoryDump> {
    const t = this.tables(chainId);
    const lines = (rows: Iterable<object>): string[] => [...rows].map(line).sort();
    const tokens = new Set([...t.trades.values()].map((r) => r.token));
    const candles: string[] = [];
    for (const token of [...tokens].sort()) for (const interval of CANDLE_INTERVALS) for (const c of candlesOfRows([...t.trades.values()].filter((r) => r.token === token), interval)) candles.push(line({ chainId, token, interval, ...c }));
    return {
      chainBlocks: lines(t.blocks.values()),
      boxes: lines(t.boxes.values()),
      trades: lines(t.trades.values()),
      activity: lines(t.activity.values()),
      batches: lines(t.batches.values()),
      depthEvents: lines(t.depth.values()),
      transfers: lines(t.transfers.values()),
      balances: [...t.balances.entries()].map(([k, amount]) => {
        const [token, asset, holder] = k.split('|');
        return line({ chainId, token, asset, holder, amount: amount.toString() });
      }).sort(),
      items: [...t.items.entries()].map(([k, owner]) => {
        const [token, asset, id] = k.split('|');
        return line({ chainId, token, asset, id, owner });
      }).sort(),
      candles: candles.sort(),
    };
  }

  async close(): Promise<void> {}
}
